package backend

import (
	"context"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// DrivePollingService はGoogle Driveとの同期ポーリングを管理するサービス
type DrivePollingService struct {
	ctx              context.Context
	driveService     *driveService
	resetPollingChan chan struct{}
	stopPollingChan  chan struct{}
	logger           DriveLogger
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
	p.resetPollingChan = make(chan struct{}, 1)

	// クラウドの重複ファイル削除
	if err := p.driveService.driveSync.RemoveDuplicateNoteFiles(p.ctx); err != nil {
		p.logger.Error(err, "Failed to clean duplicate note files")
	}

	// 初回同期
	if err := p.driveService.SyncNotes(); err != nil {
		p.logger.Error(err, "Error syncing with Drive")
	}

	for {
		select {
		case <-p.stopPollingChan:
			p.logger.Info("Stopping sync polling...")
			return
		default:
			if !p.driveService.IsConnected() {
				time.Sleep(initialInterval)
				continue
			}

			select {
			case <-time.After(interval):
				if err := p.driveService.SyncNotes(); err != nil {
					p.logger.Error(err, "Error syncing with Drive")
				}
				newInterval := time.Duration(float64(interval) * factor)
				if newInterval > maxInterval {
					newInterval = maxInterval
				}
				if newInterval != interval {
					p.logger.Console("No changes detected, increasing interval from %v to %v", interval, newInterval)
					interval = newInterval
				}
			case <-p.resetPollingChan:
				interval = initialInterval
				p.logger.Console("Polling interval reset to: %v", interval)
			case <-p.stopPollingChan:
				p.logger.Info("Stopping sync polling...")
				return
			}

			if !p.driveService.IsTestMode() {
				wailsRuntime.EventsEmit(p.ctx, "drive:status", "synced")
			}
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
	if p.resetPollingChan == nil {
		return
	}
	select {
	case p.resetPollingChan <- struct{}{}:
	default:
	}
}
