package backend

import (
	"context"
	"fmt"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"google.golang.org/api/drive/v3"
)

// DrivePollingService は Drive 同期のポーリングを管理する。
//
// ★ 並行性ルール:
//   StartPolling は専用の goroutine から呼ばれる長時間ループ。
//   StopPolling と RefreshChangeToken はメインスレッドや別の sync goroutine から
//   並行に呼ばれる。stopPollingChan の close+再代入と changePageToken の
//   読み書きが race するため、mu sync.Mutex で保護する。
type DrivePollingService struct {
	ctx              context.Context
	driveService     *driveService
	resetPollingChan chan struct{}
	logger           AppLogger

	mu              sync.Mutex // 以下のフィールドを保護
	stopPollingChan chan struct{}
	changePageToken string
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

// currentStopChannel は StartPolling が select で監視する stop channel を返す。
// StopPolling が close+再代入した瞬間に StartPolling 側の select-read と race
// しないよう、必ずこの helper 経由で取得し local 変数に保持して使う。
func (p *DrivePollingService) currentStopChannel() chan struct{} {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.stopPollingChan
}

// getChangePageToken は Changes API のページトークンを返す。RefreshChangeToken
// など別 goroutine からの書き換えと race しないよう lock 経由で読む。
func (p *DrivePollingService) getChangePageToken() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.changePageToken
}

func (p *DrivePollingService) setChangePageToken(token string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.changePageToken = token
}

func (p *DrivePollingService) WaitForFrontendAndStartSync() {
	defer func() {
		if r := recover(); r != nil {
			p.logger.Console(fmt.Sprintf("PANIC in WaitForFrontendAndStartSync: %v\n%s", r, string(debug.Stack())))
		}
	}()
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

	// stopPollingChan は StopPolling が close+再代入する。select 文で
	// p.stopPollingChan を直接参照するとフィールド書換と race するため、
	// 開始時に local に capture したものを使う。次回 StartPolling 時には
	// StopPolling が新しい channel を作っているのでそちらが拾われる。
	stopChan := p.currentStopChannel()

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

	if _, err := p.driveService.recoverOrphanCloudNotes(files, p.driveService.driveOps); err != nil {
		p.logger.Console("Failed to recover orphan cloud notes: %v", err)
	}

	p.initChangeToken()

	for {
		select {
		case <-p.ctx.Done():
			return
		case <-stopChan:
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
				p.setChangePageToken("")
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
	p.setChangePageToken(token)
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
	p.setChangePageToken(token)
}

func (p *DrivePollingService) checkForChanges() (bool, error) {
	currentToken := p.getChangePageToken()
	if currentToken == "" {
		p.logger.Console("No change token available, performing full sync")
		if err := p.driveService.SyncNotes(); err != nil {
			return false, err
		}
		p.initChangeToken()
		return false, nil
	}

	result, err := p.driveService.driveOps.ListChanges(currentToken)
	if err != nil {
		p.logger.ErrorCode(err, MsgDriveErrorChangesAPI, nil)
		p.setChangePageToken("")
		return true, nil
	}

	if result.NewStartToken != "" {
		p.setChangePageToken(result.NewStartToken)
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

// StopPolling は実行中の StartPolling ループを終了させる。多重呼び出し可能。
// 停止後に再度 StartPolling を呼べるよう、close した直後に新しい channel に
// 差し替える (旧 channel は capture 済みの StartPolling goroutine が close を
// 受信して exit するために使う)。
func (p *DrivePollingService) StopPolling() {
	p.mu.Lock()
	defer p.mu.Unlock()
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
