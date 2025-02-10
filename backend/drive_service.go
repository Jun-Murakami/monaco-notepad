package backend

import (
	"context"
	"fmt"
	"strings"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Google Drive関連の操作を提供するインターフェース
type DriveService interface {
	// ---- 認証系 ----
	InitializeDrive() error  // 初期化
	AuthorizeDrive() error   // 認証
	LogoutDrive() error      // ログアウト
	CancelLoginDrive() error // 認証キャンセル

	// ---- ノート同期系 ----
	CreateNote(note *Note) error         // ノート作成
	UpdateNote(note *Note) error         // ノート更新
	DeleteNoteDrive(noteID string) error // ノート削除
	SyncNotes() error                    // ノートをただちに同期
	UpdateNoteList() error               // ノートリスト更新

	// ---- ユーティリティ ----
	NotifyFrontendReady()                           // フロントエンド準備完了通知
	IsConnected() bool                              // 接続状態確認
	IsTestMode() bool                               // テストモード確認
	GetDriveOperationsQueue() *DriveOperationsQueue // キューシステムを取得
}

// driveService はDriveServiceインターフェースの実装
type driveService struct {
	ctx             context.Context
	auth            *driveAuthService
	noteService     *noteService
	appDataDir      string
	notesDir        string
	stopPollingChan chan struct{}
	logger          DriveLogger
	driveOps        DriveOperations
	driveSync       DriveSyncService
	pollingService  *DrivePollingService
	operationsQueue *DriveOperationsQueue
}

// NewDriveService は新しいDriveServiceインスタンスを作成します
func NewDriveService(
	ctx context.Context,
	appDataDir string,
	notesDir string,
	noteService *noteService,
	credentialsJSON []byte,
) *driveService {
	logger := NewDriveLogger(ctx, false, appDataDir)
	isTestMode := false
	authService := NewDriveAuthService(
		ctx,
		appDataDir,
		notesDir,
		noteService,
		credentialsJSON,
		isTestMode,
	)

	ds := &driveService{
		ctx:             ctx,
		auth:            authService,
		noteService:     noteService,
		appDataDir:      appDataDir,
		notesDir:        notesDir,
		stopPollingChan: make(chan struct{}),
		logger:          logger,
		driveOps:        nil,
		driveSync:       nil,
	}

	ds.pollingService = NewDrivePollingService(ctx, ds)
	return ds
}

// ------------------------------------------------------------
// 認証まわりの公開ラッパーメソッド (実装はdriveAuthService)
// ------------------------------------------------------------

// Google Drive APIの初期化 (保存済みトークンがあれば自動ログイン)
func (s *driveService) InitializeDrive() error {
	// 保存済みトークンでの初期化を試行
	if success, err := s.auth.InitializeWithSavedToken(); err != nil {
		return s.auth.HandleOfflineTransition(err)
	} else if success {
		s.logger.Info("InitializeDrive success")
		return s.onConnected(false)
	}
	return nil
}

// Google Driveに手動ログイン
func (s *driveService) AuthorizeDrive() error {
	s.logger.NotifyDriveStatus(s.ctx, "logging in")
	s.logger.Info("Waiting for login...")
	if err := s.auth.StartManualAuth(); err != nil {
		return s.auth.HandleOfflineTransition(err)
	}
	s.logger.Info("AuthorizeDrive success")
	return s.onConnected(true)

}

// 接続成功時の処理
func (s *driveService) onConnected(performInitialSync bool) error {
	if !s.IsConnected() {
		return s.auth.HandleOfflineTransition(fmt.Errorf("not connected to Google Drive"))
	}
	s.logger.Info("Connected to Google Drive")

	// DriveOps生成
	s.driveOps = NewDriveOperations(s.auth.GetDriveSync().service)

	// キューシステムの初期化
	s.operationsQueue = NewDriveOperationsQueue(s.driveOps)
	s.driveOps = s.operationsQueue // キューシステムで元のdriveOpsをラップ

	// フォルダの確保
	if err := s.ensureDriveFolders(); err != nil {
		return s.auth.HandleOfflineTransition(err)
	}

	// driveSync生成
	s.driveSync = NewDriveSyncService(
		s.driveOps,                     // ドライブ操作オブジェクト
		s.auth.driveSync.notesFolderID, // ノート保存用フォルダID
		s.auth.driveSync.rootFolderID,  // アプリケーションのルートフォルダID
	)

	// ノートリストの確保
	if err := s.ensureNoteList(); err != nil {
		return s.auth.HandleOfflineTransition(err)
	}

	// 必要な場合(手動ログインで呼ばれた場合)は初回マージを実行
	if performInitialSync {
		if err := s.performInitialSync(); err != nil {
			return s.auth.HandleOfflineTransition(err)
		}
	}

	// ポーリング開始
	go s.waitForFrontendAndStartSync()
	return nil
}

// Google Driveからログアウト
func (s *driveService) LogoutDrive() error {
	s.logger.Info("Logging out of Google Drive...")
	s.pollingService.StopPolling()
	if s.operationsQueue != nil {
		s.operationsQueue.Cleanup()
	}
	return s.auth.LogoutDrive()
}

// 認証をキャンセル
func (s *driveService) CancelLoginDrive() error {
	return s.auth.CancelLoginDrive()
}

// フロントエンドへ準備完了を通知
func (s *driveService) NotifyFrontendReady() {
	s.auth.NotifyFrontendReady()
}

// 接続状態を返す
func (s *driveService) IsConnected() bool {
	return s.auth.driveSync.isConnected
}

// テストモードかどうかを返す
func (s *driveService) IsTestMode() bool {
	return s.auth != nil && s.auth.IsTestMode()
}

// ------------------------------------------------------------
// ポーリングのラッパー
// ------------------------------------------------------------

// フロントエンドの準備完了を待って同期開始 (ポーリング用ゴルーチン起動)
func (s *driveService) waitForFrontendAndStartSync() {
	go s.pollingService.WaitForFrontendAndStartSync()
}

// ポーリングインターバルをリセット
func (s *driveService) resetPollingInterval() {
	s.pollingService.ResetPollingInterval()
}

// ------------------------------------------------------------
// ノート操作の公開メソッド
// ------------------------------------------------------------

// ノートを作成する
func (s *driveService) CreateNote(note *Note) error {
	if !s.IsConnected() {
		return s.auth.HandleOfflineTransition(fmt.Errorf("not connected to Google Drive"))
	}
	err := s.driveSync.CreateNote(s.ctx, note)
	if err != nil {
		if strings.Contains(err.Error(), "operation cancelled") {
			s.logger.Console("Note creation was cancelled: %v", err)
			return nil
		}
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to create note: %v", err))
	}
	s.logger.Info("Note created successfully")
	s.resetPollingInterval()
	return nil
}

// ノートを更新する
func (s *driveService) UpdateNote(note *Note) error {
	if !s.IsConnected() {
		return s.auth.HandleOfflineTransition(fmt.Errorf("not connected to Google Drive"))
	}
	err := s.driveSync.UpdateNote(s.ctx, note)
	if err != nil {
		if strings.Contains(err.Error(), "operation cancelled") {
			s.logger.Console("Note update was cancelled: %v", err)
			return nil
		}
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to update note: %v", err))
	}
	s.logger.Info("Note updated successfully")
	s.resetPollingInterval()
	return nil
}

// ノートを削除
func (s *driveService) DeleteNoteDrive(noteID string) error {
	if !s.IsConnected() {
		return s.auth.HandleOfflineTransition(fmt.Errorf("drive service is not initialized"))
	}

	err := s.driveSync.DeleteNote(s.ctx, noteID)
	if err != nil {
		if strings.Contains(err.Error(), "operation cancelled") {
			s.logger.Console("Note deletion was cancelled: %v", err)
			return nil
		}
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to delete note from cloud"))
	}

	s.logger.Info("Deleted note from cloud")
	s.resetPollingInterval()
	return nil
}

// 現在のノートリストをアップロード
func (s *driveService) UpdateNoteList() error {
	if !s.IsConnected() {
		return s.auth.HandleOfflineTransition(fmt.Errorf("drive service is not initialized"))
	}

	s.logger.Console("Modifying note list: %v, Notes count: %d", s.noteService.noteList.LastSync, len(s.noteService.noteList.Notes))

	// アップロード前に最新のLastSyncを保持
	lastSync := s.noteService.noteList.LastSync

	err := s.driveSync.UpdateNoteList(s.ctx, s.noteService.noteList, s.auth.driveSync.noteListID)
	if err != nil {
		// キャンセルされたオペレーションの場合はエラーとして扱わない
		if strings.Contains(err.Error(), "operation cancelled") {
			s.logger.Console("Note list update was cancelled: %v", err)
			return nil
		}
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to update note list"))
	}

	// アップロード成功後、保持していたLastSyncをcloudNoteListに設定
	if s.auth.driveSync.cloudNoteList != nil {
		s.auth.driveSync.cloudNoteList.LastSync = lastSync
		s.auth.driveSync.cloudNoteList.Notes = s.noteService.noteList.Notes
	}

	s.logger.Info("Note list updated successfully")
	s.resetPollingInterval()
	return nil
}

// ------------------------------------------------------------
// ノート同期: SyncNotes (今すぐ同期)
// ------------------------------------------------------------
func (s *driveService) SyncNotes() error {
	// 1. キューが空かどうかを確認（空でなければ一旦同期をスキップする）
	if err := s.skipSyncIfQueuePending(); err != nil {
		return err
	}

	// 2. 接続状態の確認
	if err := s.ensureSyncIsPossible(); err != nil {
		return err
	}

	// 3. 同期開始の通知
	s.notifySyncStart()

	// 4. クラウド上のノートリストを確実に取得
	cloudNoteList, err := s.ensureCloudNoteList(s.ctx)
	if err != nil {
		return s.auth.HandleOfflineTransition(err)
	}

	// 5. 同期対象のログ出力
	s.logSyncStatus(cloudNoteList, s.noteService.noteList)

	// 6. タイムスタンプが同じ場合は内容の差分チェック
	if cloudNoteList.LastSync.Equal(s.noteService.noteList.LastSync) {
		if s.isNoteListChanged(cloudNoteList.Notes, s.noteService.noteList.Notes) {
			// 同じタイムスタンプだが内容が違う場合はマージ
			s.logger.Info("Note lists have same timestamp but different content, merging notes...")
			if err := s.mergeNoteListsAndDownload(cloudNoteList); err != nil {
				return s.auth.HandleOfflineTransition(err)
			}
			s.notifySyncComplete()
			return nil
		}
		// 同じタイムスタンプかつ内容も同じなら「最新」
		s.logger.Info("Sync status is up to date (same timestamp, no diff)")
		s.notifySyncComplete()
		return nil
	}

	// 7. タイムスタンプが異なる場合はどちらが最新か比較
	if cloudNoteList.LastSync.After(s.noteService.noteList.LastSync) {
		// ---- クラウドが新しい場合、クラウド→ローカル方向に同期 ----
		if err := s.handleCloudSync(cloudNoteList); err != nil {
			return err
		}
		// ローカルノートリストも更新
		s.noteService.noteList.LastSync = cloudNoteList.LastSync
		s.noteService.noteList.Notes = cloudNoteList.Notes
		// ノートリストファイルも合わせる
		if err := s.handleNoteListSync(cloudNoteList); err != nil {
			return err
		}
	} else {
		// ---- ローカルの方が新しい場合、ローカル→クラウド方向に同期 ----
		if err := s.handleLocalSync(s.noteService.noteList, cloudNoteList); err != nil {
			return err
		}
		if err := s.handleNoteListSync(cloudNoteList); err != nil {
			return err
		}
	}

	// 8. 同期完了の通知
	s.notifySyncComplete()
	return nil
}

// ------------------------------------------------------------
// 初回同期: performInitialSync (リファクタ後)
// ------------------------------------------------------------
func (s *driveService) performInitialSync() error {
	s.logger.Info("Starting initial sync...")

	// 1. クラウドのノートリストを確実に取得（存在しなければアップロード後再取得）
	cloudNoteList, err := s.ensureCloudNoteList(s.ctx)
	if err != nil {
		return fmt.Errorf("failed to download note list: %w", err)
	}

	// 2. マージ用に「クラウド側に存在するが noteList.json に記載がないノート」も含めて取得
	mergedCloudNotes, err := s.prepareCloudNotesForMerge(s.ctx, cloudNoteList)
	if err != nil {
		return err
	}

	s.logger.Info(fmt.Sprintf(
		"Preparing to merge notes: %d local, %d from cloud (after merging unknown notes)",
		len(s.noteService.noteList.Notes),
		len(mergedCloudNotes),
	))

	// 3. ノートのマージ処理 (ローカル vs クラウド)
	mergedNotes, downloadedNotes, err := s.mergeNotes(s.ctx, s.noteService.noteList.Notes, mergedCloudNotes)
	if err != nil {
		return fmt.Errorf("failed to merge notes: %w", err)
	}

	// 4. マージ後にダウンロードしたノートをローカルに保存
	for _, note := range downloadedNotes {
		if err := s.noteService.SaveNote(note); err != nil {
			return fmt.Errorf("failed to save downloaded note: %w", err)
		}
	}

	// 5. マージ完了後のノートリストを保存してクラウドを更新
	if err := s.saveAndUpdateNoteList(cloudNoteList, mergedNotes); err != nil {
		return err
	}

	// 6. 完了通知
	s.logger.Info("Initial sync completed")
	s.logger.NotifyFrontendSyncedAndReload(s.ctx)
	s.logger.NotifyDriveStatus(s.ctx, "synced")
	return nil
}

// ------------------------------------------------------------
// SyncNotes および performInitialSync 内で利用する
// プライベートメソッド群 (リファクタで追加)
// ------------------------------------------------------------

// キュー内に処理が残っている場合は同期をスキップ
func (s *driveService) skipSyncIfQueuePending() error {
	if s.operationsQueue != nil && s.operationsQueue.HasItems() {
		s.logger.Info("Skipping sync because queue has items pending")
		return nil
	}
	return nil
}

// 同期開始が可能かどうかを検証
func (s *driveService) ensureSyncIsPossible() error {
	if !s.IsConnected() {
		s.logger.Info("Not connected to Google Drive")
		if !s.IsTestMode() {
			return s.auth.HandleOfflineTransition(fmt.Errorf("not connected to Google Drive"))
		}
		return fmt.Errorf("not connected to Google Drive")
	}
	return nil
}

// 同期開始の通知
func (s *driveService) notifySyncStart() {
	s.logger.Info("Starting sync with Drive...")
	if !s.IsTestMode() {
		wailsRuntime.EventsEmit(s.ctx, "drive:status", "syncing")
	}
}

// 同期が完了したらフロントエンドへ通知
func (s *driveService) notifySyncComplete() {
	s.logger.NotifyFrontendSyncedAndReload(s.ctx)
	s.logger.Info("Sync status is up to date")
	wailsRuntime.EventsEmit(s.ctx, "drive:status", "synced")
}

// 同期の前後のステータスログ
func (s *driveService) logSyncStatus(cloudNoteList, localNoteList *NoteList) {
	s.logger.Info("Cloud noteList LastSync: %v, Cloud notes: %d", cloudNoteList.LastSync, len(cloudNoteList.Notes))
	s.logger.Info("Local noteList LastSync: %v, Local notes: %d", localNoteList.LastSync, len(localNoteList.Notes))
}

// 「同じタイムスタンプだが内容が違う」場合のマージ実行
func (s *driveService) mergeNoteListsAndDownload(cloudNoteList *NoteList) error {
	_, downloadedNotes, err := s.mergeNotes(s.ctx, s.noteService.noteList.Notes, cloudNoteList.Notes)
	if err != nil {
		return err
	}
	for _, note := range downloadedNotes {
		if err := s.noteService.SaveNote(note); err != nil {
			return fmt.Errorf("failed to save downloaded note: %w", err)
		}
	}
	return nil
}

// ------------------------------------------------------------
// 既存の大・中メソッド (部分的に細分化済)
// ------------------------------------------------------------

// ノートのフルマージ処理 (localNotes vs cloudNotes)
func (s *driveService) mergeNotes(
	ctx context.Context,
	localNotes []NoteMetadata,
	cloudNotes []NoteMetadata,
) ([]NoteMetadata, []*Note, error) {
	// 重複するidを排除
	localNotes = s.driveSync.DeduplicateNotes(localNotes)
	cloudNotes = s.driveSync.DeduplicateNotes(cloudNotes)

	mergedNotes := make([]NoteMetadata, 0)
	localNotesMap := make(map[string]NoteMetadata)
	cloudNotesMap := make(map[string]NoteMetadata)

	// ローカルノートのマップを作成
	for _, note := range localNotes {
		localNotesMap[note.ID] = note
	}
	// クラウドノートのマップを作成
	for _, note := range cloudNotes {
		cloudNotesMap[note.ID] = note
	}

	var downloadedNotes []*Note

	// 双方存在するノートのマージ
	for id, localNote := range localNotesMap {
		if cloudNote, exists := cloudNotesMap[id]; exists {
			// ハッシュが一致すればそのまま
			if localNote.ContentHash != "" && cloudNote.ContentHash != "" &&
				localNote.ContentHash == cloudNote.ContentHash {
				mergedNotes = append(mergedNotes, localNote)
				delete(cloudNotesMap, id)
				continue
			}
			// ハッシュが異なる場合は更新日時を比較
			if cloudNote.ModifiedTime.After(localNote.ModifiedTime) {
				mergedNotes = append(mergedNotes, cloudNote)
				s.logger.Info("Downloading note %s from cloud", id)
				note, err := s.driveSync.DownloadNote(ctx, id)
				if err != nil {
					return nil, nil, fmt.Errorf("failed to download note %s: %w", id, err)
				}
				downloadedNotes = append(downloadedNotes, note)
			} else {
				mergedNotes = append(mergedNotes, localNote)
				note, err := s.noteService.LoadNote(id)
				if err == nil {
					s.logger.Info("Uploading note %s to cloud", id)
					if upErr := s.driveSync.UpdateNote(ctx, note); upErr != nil {
						return nil, nil, fmt.Errorf("failed to upload note %s: %w", id, upErr)
					}
				}
			}
			delete(cloudNotesMap, id)
		} else {
			// ローカルのみ存在するノートはアップロード
			mergedNotes = append(mergedNotes, localNote)
			note, err := s.noteService.LoadNote(id)
			if err == nil {
				s.logger.Info("Uploading note %s to cloud", id)
				if createErr := s.driveSync.CreateNote(ctx, note); createErr != nil {
					return nil, nil, fmt.Errorf("failed to upload note %s: %w", id, createErr)
				}
			}
		}
	}

	// クラウドのみ存在するノートはダウンロード
	for id, cloudNote := range cloudNotesMap {
		mergedNotes = append(mergedNotes, cloudNote)
		s.logger.Info("Downloading note %s from cloud", id)
		note, err := s.driveSync.DownloadNote(ctx, id)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to download note %s: %w", id, err)
		}
		downloadedNotes = append(downloadedNotes, note)
	}

	return mergedNotes, downloadedNotes, nil
}

// クラウドからローカルへの同期
func (s *driveService) handleCloudSync(cloudNoteList *NoteList) error {
	// 現在のローカル状態をコピー
	currentNotes := make([]NoteMetadata, len(s.noteService.noteList.Notes))
	copy(currentNotes, s.noteService.noteList.Notes)

	// クラウドの各ノートをローカルへ同期
	for _, cloudNote := range cloudNoteList.Notes {
		if err := s.syncNoteCloudToLocal(s.ctx, cloudNote.ID, cloudNote); err != nil {
			s.logger.Error(err, "Failed to sync note %s", cloudNote.ID)
			continue
		}
	}

	// ローカルにしかないノートを削除
	for _, localNote := range currentNotes {
		exists := false
		for _, cloudNote := range cloudNoteList.Notes {
			if cloudNote.ID == localNote.ID {
				exists = true
				break
			}
		}
		if !exists {
			s.logger.Info("Deleting local-only note: %s", localNote.Title)
			s.noteService.DeleteNote(localNote.ID)
		}
	}
	return nil
}

// 単一のクラウドのノートをローカルと同期する
func (s *driveService) syncNoteCloudToLocal(ctx context.Context, noteID string, cloudNote NoteMetadata) error {
	// ローカルのノートを読み込む
	localNote, err := s.noteService.LoadNote(noteID)
	if err != nil {
		// ローカルに存在しなければダウンロード
		s.logger.Info("Downloading note %s from cloud", noteID)
		if note, dlErr := s.driveSync.DownloadNote(ctx, noteID); dlErr != nil {
			return dlErr
		} else {
			s.noteService.SaveNote(note)
			return nil
		}
	}
	// クラウドの方が新しい場合は上書きダウンロード
	if cloudNote.ModifiedTime.After(localNote.ModifiedTime) {
		s.logger.Info("Downloading note %s from cloud (cloud is newer)", noteID)
		if note, dlErr := s.driveSync.DownloadNote(ctx, noteID); dlErr != nil {
			return dlErr
		} else {
			note.ModifiedTime = cloudNote.ModifiedTime
			s.noteService.SaveNote(note)
			return nil
		}
	}
	return nil
}

// ローカルからクラウドへの同期
func (s *driveService) handleLocalSync(localNoteList *NoteList, cloudNoteList *NoteList) error {
	// ローカルの各ノートをクラウドと同期
	for _, localNote := range localNoteList.Notes {
		if cloudNote, exists := s.findNoteInList(localNote.ID, cloudNoteList.Notes); exists {
			if localNote.ContentHash != "" && cloudNote.ContentHash != "" &&
				localNote.ContentHash == cloudNote.ContentHash {
				s.logger.Console("Skipping note %s as it has not changed", localNote.ID)
				continue
			}
		}
		localNoteFile, err := s.noteService.LoadNote(localNote.ID)
		if err != nil {
			return err
		}
		if err := s.syncNoteLocalToCloud(localNoteFile); err != nil {
			return err
		}
	}

	// クラウドのノートリストにないノートをリストアップして削除
	unknownNotes, err := s.driveSync.ListUnknownNotes(s.ctx, cloudNoteList, false)
	if err != nil {
		return err
	}
	for _, note := range unknownNotes.Notes {
		s.logger.Info("Deleting unknown note: %s", note.ID)
		if err := s.driveSync.DeleteNote(s.ctx, note.ID); err != nil {
			return err
		}
	}
	return nil
}

// 単一のローカルのノートをクラウドと同期する
func (s *driveService) syncNoteLocalToCloud(localNote *Note) error {
	cloudNoteID, err := s.driveSync.GetNoteID(s.ctx, localNote.ID)
	if cloudNoteID == "" || err != nil {
		s.logger.Info("Creating note %s in cloud", localNote.ID)
		if err := s.driveSync.CreateNote(s.ctx, localNote); err != nil {
			return err
		}
	} else {
		s.logger.Info("Updating note %s in cloud", localNote.ID)
		if err := s.driveSync.UpdateNote(s.ctx, localNote); err != nil {
			return err
		}
	}
	return nil
}

// クラウドのノートリストを取得し、存在しなければローカルノートをアップロード後再取得
func (s *driveService) ensureCloudNoteList(ctx context.Context) (*NoteList, error) {
	cloudNoteList, err := s.driveSync.DownloadNoteList(ctx, s.auth.driveSync.noteListID)
	if err != nil {
		return nil, err
	}
	if cloudNoteList == nil {
		s.logger.Info("Cloud note list not found, uploading all local notes...")
		if err := s.driveSync.UploadAllNotes(ctx, s.noteService.noteList.Notes); err != nil {
			return nil, fmt.Errorf("failed to upload all notes: %w", err)
		}
		cloudNoteList, err = s.driveSync.DownloadNoteList(ctx, s.auth.driveSync.noteListID)
		if err != nil {
			return nil, err
		}
	}
	return cloudNoteList, nil
}

// 初回同期時にクラウドの不明なノートを取り込み、マージ用のクラウドノートリストを準備
func (s *driveService) prepareCloudNotesForMerge(ctx context.Context, cloudNoteList *NoteList) ([]NoteMetadata, error) {
	availableNotes, err := s.driveSync.ListAvailableNotes(cloudNoteList)
	if err != nil {
		return nil, fmt.Errorf("failed to list available notes: %w", err)
	}
	unknownNotes, err := s.driveSync.ListUnknownNotes(ctx, availableNotes, true)
	if err != nil {
		return nil, fmt.Errorf("failed to list unknown notes: %w", err)
	}
	if unknownNotes != nil {
		return append(unknownNotes.Notes, cloudNoteList.Notes...), nil
	}
	return cloudNoteList.Notes, nil
}

// ノートリストの内容が異なるかどうかをチェック
func (s *driveService) isNoteListChanged(cloudList, localList []NoteMetadata) bool {
	if len(cloudList) != len(localList) {
		s.logger.Info("Note list length differs")
		return true
	}

	cloudMap := make(map[string]NoteMetadata)
	localMap := make(map[string]NoteMetadata)

	for _, note := range cloudList {
		cloudMap[note.ID] = note
	}
	for _, note := range localList {
		localMap[note.ID] = note
	}

	for id, cloudNote := range cloudMap {
		localNote, exists := localMap[id]
		if !exists {
			s.logger.Info("Note %s exists in cloud but not in local", id)
			return true
		}
		if cloudNote.ContentHash != localNote.ContentHash {
			s.logger.Info("Note %s has different content hash", id)
			return true
		}
		if cloudNote.Order != localNote.Order {
			s.logger.Info("Note %s has different order", id)
			return true
		}
	}
	return false
}

// Google Drive上に必要なフォルダ構造を作成
func (s *driveService) ensureDriveFolders() error {
	s.auth.driveSync.mutex.Lock()
	defer s.auth.driveSync.mutex.Unlock()

	// ルートフォルダ
	rootFolders, err := s.driveOps.ListFiles(
		"name='monaco-notepad' and mimeType='application/vnd.google-apps.folder' and trashed=false")
	if err != nil {
		return s.logger.ErrorWithNotify(err, "Failed to check root folder")
	}

	if len(rootFolders) == 0 {
		rootFolderId, err := s.driveOps.CreateFolder("monaco-notepad", "")
		if err != nil {
			return s.logger.ErrorWithNotify(err, "Failed to create root folder")
		}
		s.auth.driveSync.rootFolderID = rootFolderId
	} else {
		s.auth.driveSync.rootFolderID = rootFolders[0].Id
	}

	// notes フォルダ
	notesFolders, err := s.driveOps.ListFiles(
		fmt.Sprintf("name='notes' and '%s' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false",
			s.auth.driveSync.rootFolderID))
	if err != nil {
		return s.logger.ErrorWithNotify(err, "Failed to check notes folder")
	}

	if len(notesFolders) == 0 {
		notesFolderId, err := s.driveOps.CreateFolder("notes", s.auth.driveSync.rootFolderID)
		if err != nil {
			return s.logger.ErrorWithNotify(err, "Failed to create notes folder")
		}
		s.auth.driveSync.notesFolderID = notesFolderId
	} else {
		s.auth.driveSync.notesFolderID = notesFolders[0].Id
	}

	fmt.Println("rootFolderID: ", s.auth.driveSync.rootFolderID)
	fmt.Println("notesFolderID: ", s.auth.driveSync.notesFolderID)

	return nil
}

// ノートリストの初期化
func (s *driveService) ensureNoteList() error {
	noteListFile, err := s.driveOps.ListFiles(
		fmt.Sprintf("name='noteList.json' and '%s' in parents and trashed=false", s.auth.driveSync.rootFolderID))
	if err != nil {
		return s.logger.ErrorWithNotify(err, "Failed to check noteList file")
	}

	if len(noteListFile) > 0 {
		s.auth.driveSync.noteListID = noteListFile[0].Id
	} else {
		if err := s.driveSync.CreateNoteList(s.ctx, s.noteService.noteList); err != nil {
			return err
		}
		noteListID, err := s.driveOps.GetFileID("noteList.json", s.auth.driveSync.notesFolderID, s.auth.driveSync.rootFolderID)
		if err != nil {
			return err
		}
		s.auth.driveSync.noteListID = noteListID
	}
	return nil
}

// ノートリストの同期を行う共通処理
func (s *driveService) handleNoteListSync(cloudNoteList *NoteList) error {
	if cloudNoteList != nil {
		if err := s.UpdateNoteList(); err != nil {
			return err
		}
	} else {
		if err := s.driveSync.CreateNoteList(s.ctx, s.noteService.noteList); err != nil {
			return err
		}
		noteListID, err := s.driveOps.GetFileID("noteList.json", s.auth.driveSync.notesFolderID, s.auth.driveSync.rootFolderID)
		if err != nil {
			return err
		}
		s.auth.driveSync.noteListID = noteListID
	}
	return nil
}

// ノートリストの保存と更新を行う共通処理
func (s *driveService) saveAndUpdateNoteList(cloudNoteList *NoteList, mergedNotes []NoteMetadata) error {
	s.noteService.noteList.Notes = mergedNotes
	s.noteService.noteList.LastSync = time.Now()
	if err := s.noteService.saveNoteList(); err != nil {
		s.logger.Error(err, "Failed to save merged note list")
		s.auth.HandleOfflineTransition(err)
		return fmt.Errorf("failed to save merged note list: %w", err)
	}
	return s.handleNoteListSync(cloudNoteList)
}

// ノートリストから指定されたIDのノートを探す
func (s *driveService) findNoteInList(noteID string, notes []NoteMetadata) (NoteMetadata, bool) {
	for _, note := range notes {
		if note.ID == noteID {
			return note, true
		}
	}
	return NoteMetadata{}, false
}

// キューシステムを取得
func (s *driveService) GetDriveOperationsQueue() *DriveOperationsQueue {
	return s.operationsQueue
}

// ------------------------------------------------------------
// テストモード関連
// ------------------------------------------------------------

// driveService型にauthServiceを設定するメソッドを追加 (テスト用)
func (ds *driveService) SetAuthService(auth *driveAuthService) {
	ds.auth = auth
}
