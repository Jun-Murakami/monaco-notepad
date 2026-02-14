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

	// 起動時点より前に発生したクラウド差分を取りこぼさないため、
	// ポーリング開始前に必ず一度フル同期判定を実行する
	if err := p.driveService.SyncNotes(); err != nil {
		p.logger.ErrorCode(err, MsgDriveErrorInitialSync, nil)
	}

	time.Sleep(1 * time.Second)
	p.logger.InfoCode(MsgDrivePollingStarted, nil)
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
		p.logger.ErrorCode(err, MsgDriveErrorRefreshFileCache, nil)
	}

	p.logger.InfoCode(MsgDriveCheckingCloudFiles, nil)
	_, notesID := p.driveService.auth.GetDriveSync().FolderIDs()
	files, err := p.driveService.driveSync.ListFiles(p.ctx, notesID)
	if err != nil {
		p.logger.ErrorCode(err, MsgDriveErrorListNotesFolder, nil)
	}

	p.logger.InfoCode(MsgDriveCheckingDuplicates, nil)
	if err := p.driveService.driveSync.RemoveDuplicateNoteFiles(p.ctx, files); err != nil {
		p.logger.ErrorCode(err, MsgDriveErrorCleanDuplicates, nil)
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
				p.logger.InfoCode(MsgDriveReconnected, nil)
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
				p.logger.ErrorCode(syncErr, MsgDriveErrorSyncFailed, nil)
				interval = initialInterval
			} else if hasChanges {
				if err := p.driveService.SyncNotes(); err != nil {
					p.logger.ErrorCode(err, MsgDriveErrorSyncFailed, nil)
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
		p.logger.ErrorCode(err, MsgDriveErrorGetChangeToken, nil)
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
		p.logger.ErrorCode(err, MsgDriveErrorChangesAPI, nil)
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
