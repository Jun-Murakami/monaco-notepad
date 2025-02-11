package backend

import (
	"context"
	"time"
)

// DrivePollingService はGoogle Driveとの同期ポーリングを管理するサービス
type DrivePollingService struct {
	ctx              context.Context
	driveService     *driveService
	resetPollingChan chan struct{}
	stopPollingChan  chan struct{}
	logger           AppLogger
}

// NewDrivePollingService は新しいDrivePollingServiceインスタンスを作成
func NewDrivePollingService(ctx context.Context, ds *driveService) *DrivePollingService {
	return &DrivePollingService{
		ctx:             ctx,
		driveService:    ds,
		stopPollingChan: make(chan struct{}),
		logger:          ds.logger,
	}
}

// WaitForFrontendAndStartSync はフロントエンドの準備完了を待って同期を開始
func (p *DrivePollingService) WaitForFrontendAndStartSync() {
	<-p.driveService.auth.GetFrontendReadyChan()
	p.logger.Info("Frontend ready - starting sync...")

	if !p.driveService.IsTestMode() {
		p.logger.NotifyDriveStatus(p.ctx, "synced")
	}

	time.Sleep(1 * time.Second)
	p.StartPolling()
}

// StartPolling はGoogle Driveとのポーリング監視を開始
func (p *DrivePollingService) StartPolling() {
	const (
		initialInterval = 20 * time.Second
		maxInterval     = 3 * time.Minute
		factor          = 1.5
	)

	interval := initialInterval
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	// クラウドの重複ファイル削除
	if err := p.driveService.driveSync.RemoveDuplicateNoteFiles(p.ctx); err != nil {
		p.logger.Error(err, "Failed to clean duplicate note files")
	}

	// クラウドのノートリストを取得
	cloudNoteList, err := p.driveService.driveSync.DownloadNoteList(p.ctx, p.driveService.auth.driveSync.noteListID)
	if err != nil {
		p.logger.Error(err, "Failed to download cloud noteList")
	}

	// クラウドのノートリストにないノートをリストアップしてクリンナップ (ダウンロードはしない)
	unknownNotes, err := p.driveService.driveSync.ListUnknownNotes(p.ctx, cloudNoteList, false)
	if err != nil {
		p.logger.Error(err, "Failed to list unknown notes")
	}
	for _, note := range unknownNotes.Notes {
		p.logger.Info("Deleting unknown note: %s because it doesn't exist in cloud noteList", note.ID)
		if err := p.driveService.driveSync.DeleteNote(p.ctx, note.ID); err != nil {
			p.logger.Error(err, "Failed to delete unknown note")
		}
	}

	// 初回同期
	if err := p.driveService.SyncNotes(); err != nil {
		p.logger.Error(err, "Error syncing with Drive")
	}

	for {
		select {
		case <-p.ctx.Done():
			return
		case <-p.stopPollingChan:
			return
		case <-ticker.C:
			if !p.driveService.IsConnected() {
				continue
			}

			// キューにアイテムがある場合は同期をスキップ
			if p.driveService.operationsQueue != nil && p.driveService.operationsQueue.HasItems() {
				interval = initialInterval
				ticker.Reset(interval)
				continue
			}

			err := p.driveService.SyncNotes()
			if err != nil {
				p.logger.ErrorWithNotify(err, "Failed to sync with Drive")
				interval = initialInterval
			} else {
				if !p.driveService.IsTestMode() {
					p.logger.NotifyDriveStatus(p.ctx, "synced")
				}
				interval = time.Duration(float64(interval) * factor)
				if interval > maxInterval {
					interval = maxInterval
				}
				p.logger.Console("Sync decreasing interval to %s", interval)
			}
			ticker.Reset(interval)
		}
	}
}

// StopPolling はポーリングを停止
func (p *DrivePollingService) StopPolling() {
	if p.stopPollingChan != nil {
		close(p.stopPollingChan)
		p.stopPollingChan = make(chan struct{})
	}
}

// ResetPollingInterval はポーリング間隔をリセット
func (p *DrivePollingService) ResetPollingInterval() {
	p.logger.Console("Resetting polling interval")
	if p.resetPollingChan == nil {
		return
	}
	select {
	case p.resetPollingChan <- struct{}{}:
	default:
	}
}
