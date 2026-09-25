package backend

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Google Drive関連の操作を提供するインターフェース
type DriveService interface {
	// ---- 認証系 ----
	InitializeDrive() error    // 初期化
	AuthorizeDrive() error     // 認証
	LogoutDrive() error        // ログアウト
	CancelLoginDrive() error   // 認証キャンセル
	DeleteAllDriveData() error // Drive 上の全データを削除してログアウト

	// ---- ノート同期系 ----
	SyncNotes() error // ノートをただちに同期
	RequestSync()     // ローカル変更後の同期要求（連続した保存はまとめてから同期する）

	// ---- ユーティリティ ----
	NotifyFrontendReady()             // フロントエンド準備完了通知
	RespondToMigration(choice string) // マイグレーション選択を受信
	IsConnected() bool                // 接続状態確認
	IsTestMode() bool                 // テストモード確認
}

// driveService はDriveServiceインターフェースの実装。
// 接続・認証・ストレージ移行のライフサイクルを持ち、同期そのものは syncEngine（sync_engine.go）が行う。
type driveService struct {
	ctx                 context.Context
	auth                *authService
	noteService         *noteService
	appDataDir          string
	notesDir            string
	logger              AppLogger
	driveOpsFactory     func(useAppDataFolder bool) DriveOperations
	driveOps            DriveOperations
	engine              *syncEngine
	pollingService      *DrivePollingService
	migrationChoiceChan chan string
	migrationChoiceWait time.Duration
	syncMu              sync.Mutex
	syncState           *SyncState
	baseStore           *syncBaseStore
	gatewayRetry        gatewayRetry

	requestMu    sync.Mutex
	requestTimer *time.Timer
	requestDelay time.Duration
}

// NewDriveService は新しいDriveServiceインスタンスを作成します
func NewDriveService(
	ctx context.Context,
	appDataDir string,
	notesDir string,
	noteService *noteService,
	credentialsJSON []byte,
	logger AppLogger,
	authService *authService,
	syncState *SyncState,
) *driveService {
	_ = credentialsJSON
	ds := &driveService{
		ctx:                 ctx,
		auth:                authService,
		noteService:         noteService,
		appDataDir:          appDataDir,
		notesDir:            notesDir,
		logger:              logger,
		migrationChoiceChan: make(chan string, 1),
		migrationChoiceWait: 5 * time.Minute,
		syncState:           syncState,
		baseStore:           newSyncBaseStore(appDataDir),
		gatewayRetry:        defaultGatewayRetry,
		requestDelay:        2 * time.Second,
	}
	ds.pollingService = NewDrivePollingService(ctx, ds)
	return ds
}

func (s *driveService) newDriveOperations(useAppDataFolder bool) DriveOperations {
	if s.driveOpsFactory != nil {
		return s.driveOpsFactory(useAppDataFolder)
	}
	return NewDriveOperations(s.auth.GetDriveSync().service, s.logger, useAppDataFolder)
}

// Google Drive APIの初期化 (保存済みトークンがあれば自動ログイン)
func (s *driveService) InitializeDrive() error {
	if success, err := s.auth.InitializeWithSavedToken(); err != nil {
		return s.auth.HandleOfflineTransition(err)
	} else if success {
		s.logger.Console("InitializeDrive success")
		return s.onConnected()
	}
	return nil
}

// Google Driveに手動ログイン
func (s *driveService) AuthorizeDrive() error {
	s.logger.NotifyDriveStatus(s.ctx, "logging in")
	s.logger.Console("Waiting for login...")
	if err := s.auth.StartManualAuth(); err != nil {
		return s.auth.HandleOfflineTransition(err)
	}
	s.logger.Console("AuthorizeDrive success")
	return s.onConnected()
}

// reconnect はポーリング中の接続断から復旧する
// onConnected と異なりポーリングの再起動は行わない（既にポーリングループ内から呼ばれるため）
func (s *driveService) reconnect() error {
	if s.IsConnected() {
		return nil
	}

	success, err := s.auth.InitializeWithSavedToken()
	if err != nil {
		return fmt.Errorf("reconnect: auth failed: %w", err)
	}
	if !success {
		return fmt.Errorf("reconnect: no valid token available")
	}
	if !s.IsConnected() {
		return fmt.Errorf("reconnect: still not connected after auth")
	}

	useAppData := s.isMigrated()
	s.driveOps = s.newDriveOperations(useAppData)
	if s.driveOps == nil {
		return fmt.Errorf("reconnect: failed to create DriveOperations")
	}

	// appDataFolder モードの場合、スコープが有効か確認する
	// 旧バージョンのトークンには drive.appdata スコープがない可能性がある
	if useAppData {
		if _, err := s.driveOps.ListFiles("trashed=false"); err != nil {
			s.logger.Console("reconnect: appDataFolder access failed (token may lack scope): %v", err)
			return fmt.Errorf("reconnect: appDataFolder not accessible, re-authentication required: %w", err)
		}
	}
	return s.buildEngine(useAppData)
}

// 接続成功時の処理
func (s *driveService) onConnected() error {
	if !s.IsConnected() {
		return s.auth.HandleOfflineTransition(fmt.Errorf("not connected to Google Drive"))
	}
	s.logger.Console("Starting Drive connection process...")

	s.logger.Console("Initializing DriveOperations...")
	legacyOps := s.newDriveOperations(false)

	// マイグレーション判定
	migrationState := s.loadMigrationState()
	useAppData := migrationState.Migrated

	if !useAppData {
		appDataOps := s.newDriveOperations(true)
		appDataExists := s.checkAppDataFolderExists(appDataOps)
		legacyExists := s.checkOldDriveFoldersExist(legacyOps)

		if appDataExists && legacyExists {
			if s.checkMigrationCompleteMarker(appDataOps) {
				// 完了マーカーあり → 別デバイスで正常に移行完了済み
				s.logger.Console("Migration complete marker found, accepting appDataFolder from another device")
			} else {
				// 完了マーカーなし → 中断されたマイグレーション → クリーンアップして再マイグレーション
				s.logger.Console("No migration complete marker, cleaning up incomplete appDataFolder for fresh migration")
				s.cleanupAppDataFolder(appDataOps)
				appDataExists = false
			}
		}

		if appDataExists {
			s.logger.Console("Detected appDataFolder data, auto-migrating local state")
			s.saveMigrationState(&driveStorageMigration{
				Migrated:   true,
				MigratedAt: time.Now().UTC().Format(time.RFC3339),
			})
			useAppData = true
		} else if legacyExists {
			// 旧フォルダあり → マイグレーションダイアログ表示
			s.logger.Console("Legacy Drive folders detected, requesting migration choice...")
			if !s.IsTestMode() {
				wailsRuntime.EventsEmit(s.ctx, "drive:migration-needed")
			}

			// フロントエンドからの選択を待つ
			choice := "skip"
			select {
			case choice = <-s.migrationChoiceChan:
			case <-time.After(s.migrationChoiceWait):
				s.logger.Console("Migration choice timeout, falling back to legacy mode")
			}
			s.logger.Console("Migration choice: %s", choice)

			switch choice {
			case "migrate_delete", "migrate_keep":
				s.cleanupLegacyOrphansBeforeMigration(legacyOps)
				deleteOld := choice == "migrate_delete"
				if !s.checkAppDataFolderCanCreate(appDataOps) {
					s.logger.Console("Re-authentication needed for appDataFolder access")
					if !s.IsTestMode() {
						wailsRuntime.EventsEmit(s.ctx, "drive:migration-reauth")
					}
					if err := s.auth.ReauthorizeForMigration(); err != nil {
						s.logger.Console("Re-authentication failed: %v, falling back to legacy mode", err)
						break
					}
				}
				if err := s.executeMigration(deleteOld); err != nil {
					s.logger.Console("Migration failed: %v, falling back to legacy mode", err)
				} else {
					useAppData = true
				}
			case "skip":
				s.logger.Console("Migration skipped, using legacy mode")
			}
		} else {
			// 旧フォルダもappDataFolderもない → 新規インストール
			if s.checkAppDataFolderCanCreate(appDataOps) {
				s.logger.Console("Fresh install, using appDataFolder")
				s.saveMigrationState(&driveStorageMigration{
					Migrated:   true,
					MigratedAt: time.Now().UTC().Format(time.RFC3339),
				})
				useAppData = true
			} else {
				s.logger.Console("Fresh install but appDataFolder not accessible, using legacy mode")
			}
		}
	}

	s.driveOps = s.newDriveOperations(useAppData)
	if s.driveOps == nil {
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to create DriveOperations"))
	}
	if err := s.buildEngine(useAppData); err != nil {
		return s.auth.HandleOfflineTransition(err)
	}
	if _, err := s.engine.gateway.ResolveLayout(); err != nil {
		s.logger.ErrorCode(err, MsgDriveErrorFolderSetup, nil)
		return s.auth.HandleOfflineTransition(err)
	}

	s.logger.InfoCode(MsgDriveConnected, nil)
	go s.pollingService.WaitForFrontendAndStartSync()
	return nil
}

// buildEngine は現在の driveOps で同期エンジンを組み立てる。
func (s *driveService) buildEngine(useAppData bool) error {
	api, ok := s.driveOps.(driveFileAPI)
	if !ok {
		return fmt.Errorf("drive operations do not support sync engine (%T)", s.driveOps)
	}
	gateway := newDriveGateway(api, s.gatewayRetry, useAppData)
	s.engine = newSyncEngine(s.ctx, gateway, s.noteService, s.syncState, s.baseStore, s.logger, syncEngineOptions{
		backupEnabled: func() bool { return isConflictBackupEnabled(s.appDataDir) },
		backup: func(kind string, local *Note, cloud *Note) error {
			return backupConflictLocalNote(s.appDataDir, kind, local, cloud)
		},
		recoveredTitle: func(title string) string {
			return recoveredNoteTitle(title, uiLocaleOf(s.appDataDir))
		},
	})
	return nil
}

// LogoutDrive は Google Drive との接続を解除する。接続とトークンだけを捨て、未送信の変更（sync_state）と
// 同期 base（sync_base）は残す。同じアカウントに接続し直したときは「オフラインだった間の変更」として
// 双方向に同期される（base が無いと、相手の削除を取り込めず復活させたり、ローカルの移動や並び替えを
// 失ったりする）。別のアカウントに接続した場合は Drive のフォルダ ID が違うので、同期エンジンが base を
// 使わない（syncEngine.effectiveBase）。
func (s *driveService) LogoutDrive() error {
	s.logger.Console("Logging out of Google Drive...")
	s.pollingService.StopPolling()
	s.stopRequestTimer()
	return s.auth.LogoutDrive()
}

// DeleteAllDriveData は Drive 上の monaco-notepad フォルダを削除してログアウトする。
// appDataFolder 空間とレガシー Drive 空間の両方から同名フォルダを削除し、
// 完了後に LogoutDrive 相当の処理で token.json も削除する。
// ローカルのノートは残し、次回ログイン時に全件アップロードされる（base を破棄するので、
// 空のクラウドでローカルが消されることはない）。
func (s *driveService) DeleteAllDriveData() error {
	s.logger.Console("Deleting all Drive data and logging out...")

	// 削除中に同期が走らないよう先に止める
	s.pollingService.StopPolling()
	s.stopRequestTimer()

	if !s.IsConnected() {
		return fmt.Errorf("not connected to Google Drive")
	}

	for _, useAppData := range []bool{true, false} {
		ops := s.newDriveOperations(useAppData)
		if ops == nil {
			continue
		}
		folders, err := ops.ListFiles(
			"name='monaco-notepad' and mimeType='application/vnd.google-apps.folder' and trashed=false")
		if err != nil {
			s.logger.Console("DeleteAllDriveData: list failed (useAppData=%v): %v", useAppData, err)
			continue
		}
		for _, folder := range folders {
			if err := ops.DeleteFile(folder.Id); err != nil {
				s.logger.Console("DeleteAllDriveData: delete folder failed %s: %v", folder.Id, err)
			}
		}
	}

	// マイグレーション状態ファイルもリセット（次回ログインを新規扱いに戻す）
	stateFile := filepath.Join(s.appDataDir, migrationStateFileName)
	if err := os.Remove(stateFile); err != nil && !os.IsNotExist(err) {
		s.logger.Console("DeleteAllDriveData: failed to remove migration state: %v", err)
	}

	if err := s.resetSyncBase(); err != nil {
		s.logger.Console("DeleteAllDriveData: failed to reset sync base: %v", err)
	}
	if s.syncState != nil && s.noteService != nil {
		for _, meta := range s.noteService.SnapshotNoteList().Notes {
			s.syncState.MarkNoteDirty(meta.ID)
		}
	}

	return s.auth.LogoutDrive()
}

func (s *driveService) resetSyncBase() error {
	if s.engine != nil {
		return s.engine.ResetBase()
	}
	return s.baseStore.Clear()
}

// 認証をキャンセル
func (s *driveService) CancelLoginDrive() error {
	return s.auth.CancelLoginDrive()
}

// フロントエンドへ準備完了を通知
func (s *driveService) NotifyFrontendReady() {
	s.logger.Console("DriveService.NotifyFrontendReady called")
	s.auth.NotifyFrontendReady()
}

// 接続状態を返す
func (s *driveService) IsConnected() bool {
	return s.auth.GetDriveSync().Connected()
}

// テストモードかどうかを返す
func (s *driveService) IsTestMode() bool {
	return s.auth != nil && s.auth.IsTestMode()
}

// RespondToMigration はフロントエンドからのマイグレーション選択を受け取る
func (s *driveService) RespondToMigration(choice string) {
	select {
	case s.migrationChoiceChan <- choice:
	default:
		s.logger.Console("Warning: migration choice channel full, ignoring: %s", choice)
	}
}

// SyncNotes は同期を 1 サイクル実行する（ポーリング・今すぐ同期・保存後の同期要求から呼ばれる）。
func (s *driveService) SyncNotes() error {
	s.syncMu.Lock()
	defer s.syncMu.Unlock()

	if !s.IsConnected() {
		return s.auth.HandleOfflineTransition(fmt.Errorf("not connected to Google Drive"))
	}
	if s.engine == nil {
		return fmt.Errorf("drive sync engine not yet initialized")
	}

	s.logger.NotifyDriveStatus(s.ctx, "syncing")
	report, err := s.engine.Sync()
	if err != nil {
		s.logger.ErrorCode(err, MsgDriveErrorSyncFailed, nil)
		return s.auth.HandleOfflineTransition(err)
	}
	s.logger.Console("Sync done: uploaded=%d downloaded=%d deletedLocal=%d deletedRemote=%d failures=%d listUploaded=%v attempts=%d",
		report.Uploaded, report.Downloaded, report.DeletedLocal, report.DeletedRemote, report.Failures, report.ListUploaded, report.Attempts)
	s.notifySyncComplete()
	return nil
}

// RequestSync はローカル変更の後に呼ぶ。連続した保存は requestDelay 待ってまとめてから同期する。
func (s *driveService) RequestSync() {
	if !s.IsConnected() {
		return
	}
	s.requestMu.Lock()
	defer s.requestMu.Unlock()
	if s.requestTimer != nil {
		s.requestTimer.Stop()
	}
	s.requestTimer = time.AfterFunc(s.requestDelay, func() {
		if err := s.SyncNotes(); err != nil {
			s.logger.Console("RequestSync: sync failed: %v", err)
		}
	})
}

func (s *driveService) stopRequestTimer() {
	s.requestMu.Lock()
	defer s.requestMu.Unlock()
	if s.requestTimer != nil {
		s.requestTimer.Stop()
		s.requestTimer = nil
	}
}

// hasPendingSyncWork はポーリングのゲート用（未送信の変更がある / 一度も同期していない）。
func (s *driveService) hasPendingSyncWork() bool {
	if s.engine == nil {
		return false
	}
	return s.engine.HasPendingWork()
}

// 同期が完了したらフロントエンドへ通知
func (s *driveService) notifySyncComplete() {
	if _, err := s.noteService.ValidateIntegrity(); err != nil {
		s.logger.ErrorCode(err, MsgDriveErrorIntegrityCheck, nil)
	}
	s.logger.NotifyDriveStatus(s.ctx, "synced")
}
