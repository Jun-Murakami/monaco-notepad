package backend

import (
	"context"
	"strings"
	"time"

	"google.golang.org/api/drive/v3"
)

type DrivePollingService struct {
	ctx              context.Context
	driveService     *driveService
	resetPollingChan chan struct{}
	stopPollingChan  chan struct{}
	logger           AppLogger
	changePageToken  string
}

func NewDrivePollingService(ctx context.Context, ds *driveService) *DrivePollingService {
	return &DrivePollingService{
		ctx:              ctx,
		driveService:     ds,
		resetPollingChan: make(chan struct{}, 1),
		stopPollingChan:  make(chan struct{}),
		logger:           ds.logger,
	}
}

func (p *DrivePollingService) WaitForFrontendAndStartSync() {
	p.logger.Info("Waiting for frontend ready signal...")
	<-p.driveService.auth.GetFrontendReadyChan()
	p.logger.Info("Frontend ready signal received - starting sync...")

	if !p.driveService.IsTestMode() {
		p.logger.NotifyDriveStatus(p.ctx, "synced")
	}

	time.Sleep(1 * time.Second)
	p.logger.Info("Starting polling service...")
	p.StartPolling()
}

func (p *DrivePollingService) StartPolling() {
	const (
		initialInterval = 20 * time.Second
		maxInterval     = 3 * time.Minute
		factor          = 1.5
	)

	interval := initialInterval
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	if err := p.driveService.driveSync.RefreshFileIDCache(p.ctx); err != nil {
		p.logger.Error(err, "Failed to refresh file ID cache")
	}

	p.logger.Console("Listing files in notes folder")
	_, notesID := p.driveService.auth.GetDriveSync().FolderIDs()
	files, err := p.driveService.driveSync.ListFiles(p.ctx, notesID)
	if err != nil {
		p.logger.Error(err, "Failed to list files in notes folder")
	}

	p.logger.Console("Checking for duplicate note files")
	if err := p.driveService.driveSync.RemoveDuplicateNoteFiles(p.ctx, files); err != nil {
		p.logger.Error(err, "Failed to clean duplicate note files")
	}

	p.logger.Console("Downloading cloud noteList")
	noteListID := p.driveService.auth.GetDriveSync().NoteListID()
	cloudNoteList, err := p.driveService.driveSync.DownloadNoteList(p.ctx, noteListID)
	if err != nil {
		p.logger.Error(err, "Failed to download cloud noteList")
	}

	p.logger.Console("Listing unknown notes")
	unknownNotes, err := p.driveService.driveSync.ListUnknownNotes(p.ctx, cloudNoteList, files, false)
	if err != nil {
		p.logger.Error(err, "Failed to list unknown notes")
	}
	for _, note := range unknownNotes.Notes {
		p.logger.Info("Deleting unknown note: %s because it doesn't exist in cloud noteList", note.ID)
		if err := p.driveService.driveSync.DeleteNote(p.ctx, note.ID); err != nil {
			p.logger.Error(err, "Failed to delete unknown note")
		}
	}

	if err := p.driveService.SyncNotes(); err != nil {
		p.logger.Error(err, "Error syncing with Drive")
	}

	p.initChangeToken()

	for {
		select {
		case <-p.ctx.Done():
			return
		case <-p.stopPollingChan:
			return
		case <-p.resetPollingChan:
			interval = initialInterval
			ticker.Reset(interval)
			p.logger.Console("Polling interval reset to %s", interval)
		case <-ticker.C:
			if !p.driveService.IsConnected() {
				continue
			}

			if p.driveService.operationsQueue != nil && p.driveService.operationsQueue.HasItems() {
				interval = initialInterval
				ticker.Reset(interval)
				continue
			}

			hasChanges, syncErr := p.checkForChanges()
			if syncErr != nil {
				p.logger.ErrorWithNotify(syncErr, "Failed to sync with Drive")
				interval = initialInterval
			} else if hasChanges {
				if err := p.driveService.SyncNotes(); err != nil {
					p.logger.ErrorWithNotify(err, "Failed to sync with Drive")
					interval = initialInterval
				} else {
					if !p.driveService.IsTestMode() {
						p.logger.NotifyDriveStatus(p.ctx, "synced")
					}
					interval = initialInterval
				}
			} else {
				if !p.driveService.IsTestMode() {
					p.logger.NotifyDriveStatus(p.ctx, "synced")
				}
				interval = time.Duration(float64(interval) * factor)
				if interval > maxInterval {
					interval = maxInterval
				}
				p.logger.Console("No changes detected, interval increased to %s", interval)
			}
			ticker.Reset(interval)
		}
	}
}

func (p *DrivePollingService) initChangeToken() {
	if p.driveService.driveOps == nil {
		return
	}
	token, err := p.driveService.driveOps.GetStartPageToken()
	if err != nil {
		p.logger.Error(err, "Failed to get initial change page token, falling back to full sync")
		return
	}
	p.changePageToken = token
	p.logger.Info("Changes API initialized with token: %s", token)
}

func (p *DrivePollingService) checkForChanges() (bool, error) {
	if p.changePageToken == "" {
		p.logger.Console("No change token available, performing full sync")
		if err := p.driveService.SyncNotes(); err != nil {
			return false, err
		}
		p.initChangeToken()
		return false, nil
	}

	result, err := p.driveService.driveOps.ListChanges(p.changePageToken)
	if err != nil {
		p.logger.Error(err, "Changes API failed, falling back to full sync")
		p.changePageToken = ""
		return true, nil
	}

	if result.NewStartToken != "" {
		p.changePageToken = result.NewStartToken
	}

	if len(result.Changes) == 0 {
		return false, nil
	}

	rootID, notesID := p.driveService.auth.GetDriveSync().FolderIDs()
	if hasRelevantChanges(result.Changes, rootID, notesID) {
		return true, nil
	}

	p.logger.Console("Changes detected but none relevant to our folders (%d changes)", len(result.Changes))
	return false, nil
}

func hasRelevantChanges(changes []*drive.Change, rootID, notesID string) bool {
	for _, change := range changes {
		if change.File == nil {
			continue
		}
		for _, parentID := range change.File.Parents {
			if parentID == rootID || parentID == notesID {
				return true
			}
		}
		if strings.HasSuffix(change.File.Name, ".json") {
			return true
		}
	}
	return false
}

func (p *DrivePollingService) StopPolling() {
	if p.stopPollingChan != nil {
		close(p.stopPollingChan)
		p.stopPollingChan = make(chan struct{})
	}
}

func (p *DrivePollingService) ResetPollingInterval() {
	select {
	case p.resetPollingChan <- struct{}{}:
	default:
	}
}
