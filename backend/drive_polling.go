package backend

import (
	"context"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"google.golang.org/api/drive/v3"
)

// DrivePollingService は Drive 同期のポーリングを管理する。
//
// 変更検知は Changes API。トークンは「消費したぶんだけ」進め、自分の書き込み後に
// 現在時刻へ飛ばすことはしない（その間に来た他端末の変更を取りこぼすため。docs/sync-engine-v3.md P9）。
// 自分の書き込みも変更として届くが、次の同期は md5 比較だけで終わる。
//
// ★ 並行性ルール:
//
//	StartPolling は専用の goroutine から呼ばれる長時間ループ。
//	StopPolling はメインスレッドや別の goroutine から並行に呼ばれる。
//	stopPollingChan の close+再代入と changePageToken の読み書きが race するため、
//	mu sync.Mutex で保護する。
type DrivePollingService struct {
	ctx              context.Context
	driveService     *driveService
	resetPollingChan chan struct{}
	logger           AppLogger

	mu              sync.Mutex // 以下のフィールドを保護
	stopPollingChan chan struct{}
	changePageToken string
	// consecutiveReconnectFailures は reconnect 連続失敗回数。
	// reauthFailureThreshold 回連続で失敗したら drive:reauth-required を発火し、
	// ユーザーに「Drive との接続が切れたまま復旧しません」と知らせる。
	// 接続成功でリセットする。
	consecutiveReconnectFailures int
	lastSyncAt                   time.Time
}

// reauthFailureThreshold は連続 reconnect 失敗がこの回数以上になったら
// 再ログイン誘導ダイアログを発火する閾値。一時的な Wi-Fi 断 / スリープ復帰直後を
// やり過ごしつつ、本物の "永続的なオフライン" を検知できる値。
const reauthFailureThreshold = 3

// safetySyncInterval は Changes API の取りこぼしに備え、変化が無くてもフル判定する間隔。
const safetySyncInterval = 5 * time.Minute

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
func (p *DrivePollingService) currentStopChannel() chan struct{} {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.stopPollingChan
}

// recordReconnectFailure は reconnect 失敗回数を 1 加算した値を返す。
func (p *DrivePollingService) recordReconnectFailure() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.consecutiveReconnectFailures++
	return p.consecutiveReconnectFailures
}

// resetReconnectFailures は接続復帰時に呼ばれ、連続失敗カウンタをリセットする。
func (p *DrivePollingService) resetReconnectFailures() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.consecutiveReconnectFailures = 0
}

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

func (p *DrivePollingService) markSynced() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.lastSyncAt = time.Now()
}

func (p *DrivePollingService) safetySyncDue() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return time.Since(p.lastSyncAt) >= safetySyncInterval
}

func (p *DrivePollingService) WaitForFrontendAndStartSync() {
	defer func() {
		if r := recover(); r != nil {
			p.logger.Console("PANIC in WaitForFrontendAndStartSync: %v\n%s", r, string(debug.Stack()))
		}
	}()
	p.logger.Console("Waiting for frontend ready signal...")
	<-p.driveService.auth.GetFrontendReadyChan()
	p.logger.Console("Frontend ready signal received - starting sync...")

	// 変更検知の基準点は初回同期の「前」に取る（初回同期中に来た変更を取りこぼさない）
	p.initChangeToken()
	p.runSync()

	p.logger.InfoCode(MsgDrivePollingStarted, nil)
	p.StartPolling()
}

func (p *DrivePollingService) runSync() error {
	p.markSynced()
	return p.driveService.SyncNotes()
}

func (p *DrivePollingService) StartPolling() {
	const (
		initialInterval    = 5 * time.Second
		maxInterval        = 1 * time.Minute
		factor             = 1.5
		reconnectBaseDelay = 10 * time.Second
		reconnectMaxDelay  = 3 * time.Minute
	)

	// stopPollingChan は StopPolling が close+再代入する。開始時に local に capture したものを使う。
	stopChan := p.currentStopChannel()

	interval := initialInterval
	reconnectDelay := reconnectBaseDelay
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	if p.getChangePageToken() == "" {
		p.initChangeToken()
	}

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
					// 連続失敗が閾値を超えたら再ログインダイアログを発火する。
					if p.recordReconnectFailure() >= reauthFailureThreshold {
						p.driveService.auth.notifyReauthRequired("polling_failed", err.Error())
					}
					reconnectDelay = time.Duration(float64(reconnectDelay) * factor)
					if reconnectDelay > reconnectMaxDelay {
						reconnectDelay = reconnectMaxDelay
					}
					ticker.Reset(reconnectDelay)
					continue
				}
				p.logger.InfoCode(MsgDriveReconnected, nil)
				p.logger.NotifyDriveStatus(p.ctx, "synced")
				p.resetReconnectFailures()
				reconnectDelay = reconnectBaseDelay
				interval = initialInterval
				p.setChangePageToken("")
				ticker.Reset(interval)
				continue
			}

			reconnectDelay = reconnectBaseDelay

			if p.pollOnce() {
				interval = initialInterval
			} else {
				interval = time.Duration(float64(interval) * factor)
				if interval > maxInterval {
					interval = maxInterval
				}
			}
			ticker.Reset(interval)
		}
	}
}

// pollOnce はポーリング 1 サイクル。同期を実行した（または失敗した）なら true を返す。
func (p *DrivePollingService) pollOnce() bool {
	hasChanges, err := p.checkForChanges()
	if err != nil {
		p.logger.ErrorCode(err, MsgDriveErrorSyncFailed, nil)
		return true
	}
	// 未送信のローカル変更 / 未完了の初回同期 / 前回失敗の再試行があれば、クラウドに変化が無くても同期する
	pending := p.driveService.hasPendingSyncWork()
	if !hasChanges && !pending && !p.safetySyncDue() {
		if !p.driveService.IsTestMode() {
			p.logger.NotifyDriveStatus(p.ctx, "synced")
		}
		return false
	}
	if err := p.runSync(); err != nil {
		p.logger.ErrorCode(err, MsgDriveErrorSyncFailed, nil)
	}
	return true
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

// checkForChanges は前回からの変更があるかを返す。トークンは消費したぶんだけ進める。
func (p *DrivePollingService) checkForChanges() (bool, error) {
	currentToken := p.getChangePageToken()
	if currentToken == "" {
		// 基準点が無い: 先に取ってから同期する（取得前の変更は同期で拾う）
		p.logger.Console("No change token available, performing full sync")
		p.initChangeToken()
		return true, nil
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
	if hasRelevantChanges(result.Changes) {
		return true, nil
	}
	p.logger.Console("Changes detected but none relevant to our files (%d changes)", len(result.Changes))
	return false, nil
}

// hasRelevantChanges は変更のうち同期対象（noteList / ノート本体 / フォルダ）に関わるものがあるか。
// 削除（File が無い変更）も対象に含める。
func hasRelevantChanges(changes []*drive.Change) bool {
	for _, change := range changes {
		if change == nil {
			continue
		}
		if change.Removed || change.File == nil {
			return true
		}
		name := change.File.Name
		if strings.HasSuffix(name, ".json") || name == "monaco-notepad" || name == "notes" {
			return true
		}
	}
	return false
}

// StopPolling は実行中の StartPolling ループを終了させる。多重呼び出し可能。
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
