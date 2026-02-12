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
	p.logger.Console("Waiting for frontend ready signal...")
	<-p.driveService.auth.GetFrontendReadyChan()
	p.logger.Console("Frontend ready signal received - starting sync...")

	if !p.driveService.IsTestMode() {
		p.logger.NotifyDriveStatus(p.ctx, "synced")
	}

	time.Sleep(1 * time.Second)
	p.logger.Info("Drive: polling started")
	p.StartPolling()
}

func (p *DrivePollingService) StartPolling() {
	const (
		initialInterval    = 5 * time.Second
		maxInterval        = 1 * time.Minute
		factor             = 1.5
		reconnectBaseDelay = 10 * time.Second
		reconnectMaxDelay  = 3 * time.Minute
	)

	interval := initialInterval
	reconnectDelay := reconnectBaseDelay
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	if err := p.driveService.driveSync.RefreshFileIDCache(p.ctx); err != nil {
		p.logger.Error(err, "Drive: failed to refresh file cache")
	}

	p.logger.Info("Drive: checking cloud files...")
	_, notesID := p.driveService.auth.GetDriveSync().FolderIDs()
	files, err := p.driveService.driveSync.ListFiles(p.ctx, notesID)
	if err != nil {
		p.logger.Error(err, "Drive: failed to list files in notes folder")
	}

	p.logger.Info("Drive: checking for duplicates...")
	if err := p.driveService.driveSync.RemoveDuplicateNoteFiles(p.ctx, files); err != nil {
		p.logger.Error(err, "Drive: failed to clean duplicate files")
	}

	if err := p.driveService.performInitialSync(); err != nil {
		p.logger.Error(err, "Drive: initial sync failed")
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
				p.logger.Console("Connection lost, attempting reconnect (next retry in %s)...", reconnectDelay)
				if err := p.driveService.reconnect(); err != nil {
					p.logger.Console("Reconnect failed: %v", err)
					reconnectDelay = time.Duration(float64(reconnectDelay) * factor)
					if reconnectDelay > reconnectMaxDelay {
						reconnectDelay = reconnectMaxDelay
					}
					ticker.Reset(reconnectDelay)
					continue
				}
				p.logger.Info("Drive: reconnected")
				p.logger.NotifyDriveStatus(p.ctx, "synced")
				reconnectDelay = reconnectBaseDelay
				interval = initialInterval
				p.changePageToken = ""
				ticker.Reset(interval)
				continue
			}

			reconnectDelay = reconnectBaseDelay

			if p.driveService.operationsQueue != nil && p.driveService.operationsQueue.HasItems() {
				interval = initialInterval
				ticker.Reset(interval)
				continue
			}

			hasChanges, syncErr := p.checkForChanges()
			if syncErr != nil {
				p.logger.Error(syncErr, "Drive: sync failed")
				interval = initialInterval
			} else if hasChanges {
				p.driveService.forceNextSync = true
				if err := p.driveService.SyncNotes(); err != nil {
					p.logger.Error(err, "Drive: sync failed")
					interval = initialInterval
				} else if p.driveService.lastSyncResult != nil && p.driveService.lastSyncResult.HasChanges() {
					if !p.driveService.IsTestMode() {
						p.logger.NotifyDriveStatus(p.ctx, "synced")
					}
					interval = initialInterval
				} else {
					interval = time.Duration(float64(interval) * factor)
					if interval > maxInterval {
						interval = maxInterval
					}
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
		p.logger.Error(err, "Drive: failed to get change token, falling back to full sync")
		return
	}
	p.changePageToken = token
	p.logger.Console("Changes API initialized with token: %s", token)
}

func (p *DrivePollingService) RefreshChangeToken() {
	if p.driveService.driveOps == nil {
		return
	}
	token, err := p.driveService.driveOps.GetStartPageToken()
	if err != nil {
		return
	}
	p.changePageToken = token
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
		p.logger.Error(err, "Drive: changes API failed, falling back to full sync")
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
		if p.isSelfNoteListChange(result.Changes, rootID, notesID) {
			p.logger.Console("Skipping self-detected change (client id)")
			p.initChangeToken()
			return false, nil
		}
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

func (p *DrivePollingService) isSelfNoteListChange(changes []*drive.Change, rootID, notesID string) bool {
	noteListID := p.driveService.auth.GetDriveSync().NoteListID()
	if noteListID == "" {
		return false
	}

	hasNoteListChange := false
	for _, change := range changes {
		if change.File == nil {
			continue
		}
		if change.File.Id == noteListID {
			hasNoteListChange = true
			continue
		}
		for _, parentID := range change.File.Parents {
			if parentID == rootID || parentID == notesID {
				return false
			}
		}
		if strings.HasSuffix(change.File.Name, ".json") {
			return false
		}
	}

	if !hasNoteListChange {
		return false
	}

	noteList, err := p.driveService.driveSync.DownloadNoteList(p.ctx, noteListID)
	if err != nil {
		p.logger.Error(err, "Drive: failed to download note list for change check")
		return false
	}
	if noteList.LastSyncClientID == "" {
		return false
	}
	return noteList.LastSyncClientID == p.driveService.clientID
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
