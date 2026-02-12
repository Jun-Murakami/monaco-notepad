package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Google Drive関連の操作を提供するインターフェース
type DriveService interface {
	// ---- 認証系 ----
	InitializeDrive() error  // 初期化
	AuthorizeDrive() error   // 認証
	LogoutDrive() error      // ログアウト
	CancelLoginDrive() error // 認証キャンセル

	// ---- ノート同期系 ----
	CreateNote(note *Note) error                           // ノート作成
	UpdateNote(note *Note) error                           // ノート更新
	DeleteNoteDrive(noteID string) error                   // ノート削除
	SyncNotes() error                                      // ノートをただちに同期
	UpdateNoteList() error                                 // ノートリスト更新
	SaveNoteAndUpdateList(note *Note, isCreate bool) error // ノート保存+リスト更新をアトミックに実行
	RecordNoteDeletion(noteIDs ...string)                  // ローカル削除を記録（マージ時の誤ダウンロード防止）

	// ---- ユーティリティ ----
	NotifyFrontendReady()                           // フロントエンド準備完了通知
	IsConnected() bool                              // 接続状態確認
	IsTestMode() bool                               // テストモード確認
	GetDriveOperationsQueue() *DriveOperationsQueue // キューシステムを取得
}

// driveService はDriveServiceインターフェースの実装
type driveService struct {
	ctx                    context.Context
	auth                   *authService
	noteService            *noteService
	appDataDir             string
	notesDir               string
	stopPollingChan        chan struct{}
	logger                 AppLogger
	driveOps               DriveOperations
	driveSync              DriveSyncService
	pollingService         *DrivePollingService
	operationsQueue        *DriveOperationsQueue
	syncMu                 sync.Mutex  // SyncNotes/UpdateNoteList の排他制御
	forceNextSync          bool        // Changes API検出時にMD5キャッシュをバイパス
	lastSyncResult         *SyncResult // 直近の同期結果サマリー
	lastNoteListUpload     time.Time   // 直近のnoteListアップロード時刻（デバウンス用）
	deferredUploadTimer    *time.Timer // デバウンス: 遅延アップロード用タイマー
	deletedMu              sync.Mutex  // recentlyDeletedNoteIDs の排他制御
	recentlyDeletedNoteIDs map[string]bool
	clientID               string
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
	clientID string,
) *driveService {
	ds := &driveService{
		ctx:                    ctx,
		auth:                   authService,
		noteService:            noteService,
		appDataDir:             appDataDir,
		notesDir:               notesDir,
		stopPollingChan:        make(chan struct{}),
		logger:                 logger,
		driveOps:               nil,
		driveSync:              nil,
		recentlyDeletedNoteIDs: make(map[string]bool),
		clientID:               clientID,
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
		s.logger.Console("InitializeDrive success")
		return s.onConnected(false)
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
	return s.onConnected(true)

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

	s.driveOps = NewDriveOperations(s.auth.GetDriveSync().service, s.logger)
	if s.driveOps == nil {
		return fmt.Errorf("reconnect: failed to create DriveOperations")
	}

	s.operationsQueue = NewDriveOperationsQueue(s.driveOps)
	if s.operationsQueue == nil {
		return fmt.Errorf("reconnect: failed to create operations queue")
	}
	s.driveOps = s.operationsQueue

	rootID, notesID := s.auth.GetDriveSync().FolderIDs()
	s.driveSync = NewDriveSyncService(s.driveOps, notesID, rootID, s.logger)
	if s.driveSync == nil {
		return fmt.Errorf("reconnect: failed to create DriveSyncService")
	}

	return nil
}

// 接続成功時の処理
func (s *driveService) onConnected(performInitialSync bool) error {
	if !s.IsConnected() {
		return s.auth.HandleOfflineTransition(fmt.Errorf("not connected to Google Drive"))
	}
	s.logger.Console("Starting Drive connection process...")

	// DriveOps生成
	s.logger.Console("Initializing DriveOperations...")
	s.driveOps = NewDriveOperations(s.auth.GetDriveSync().service, s.logger)
	if s.driveOps == nil {
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to create DriveOperations"))
	}

	// キューシステムの初期化
	s.logger.Console("Initializing operations queue...")
	s.operationsQueue = NewDriveOperationsQueue(s.driveOps)
	if s.operationsQueue == nil {
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to create operations queue"))
	}
	s.driveOps = s.operationsQueue // キューシステムで元のdriveOpsをラップ

	// フォルダの確保
	s.logger.Console("Ensuring Drive folders...")
	if err := s.ensureDriveFolders(); err != nil {
		s.logger.Error(err, "Drive: folder setup failed")
		return s.auth.HandleOfflineTransition(err)
	}

	// driveSync生成
	s.logger.Console("Initializing Drive sync service...")
	rootID, notesID := s.auth.GetDriveSync().FolderIDs()
	s.driveSync = NewDriveSyncService(
		s.driveOps,
		notesID,
		rootID,
		s.logger,
	)
	if s.driveSync == nil {
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to create DriveSyncService"))
	}

	// ノートリストの確保
	s.logger.Console("Ensuring note list...")
	if err := s.ensureNoteList(); err != nil {
		s.logger.Error(err, "Drive: note list setup failed")
		return s.auth.HandleOfflineTransition(err)
	}

	// ジャーナルが残っていればクラッシュリカバリ実行
	s.recoverFromJournal()

	// 必要な場合(手動ログインで呼ばれた場合)は初回マージを実行
	if performInitialSync {
		s.logger.Console("Performing initial sync...")
		if err := s.performInitialSync(); err != nil {
			s.logger.Error(err, "Drive: initial sync failed")
			return s.auth.HandleOfflineTransition(err)
		}
	}

	s.logger.Info("Drive: connected")

	// ポーリング開始
	go s.waitForFrontendAndStartSync()
	return nil
}

// Google Driveからログアウト
func (s *driveService) LogoutDrive() error {
	s.logger.Console("Logging out of Google Drive...")
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

func (s *driveService) RecordNoteDeletion(noteIDs ...string) {
	s.deletedMu.Lock()
	defer s.deletedMu.Unlock()
	if s.recentlyDeletedNoteIDs == nil {
		s.recentlyDeletedNoteIDs = make(map[string]bool)
	}
	for _, id := range noteIDs {
		s.recentlyDeletedNoteIDs[id] = true
	}
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
	s.logger.Info("Drive: uploading \"%s\"", note.Title)
	s.logger.NotifyDriveStatus(s.ctx, "syncing")
	err := s.driveSync.CreateNote(s.ctx, note)
	if err != nil {
		if strings.Contains(err.Error(), "operation cancelled") {
			s.logger.Console("Note creation was cancelled: %v", err)
			return nil
		}
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to create note: %v", err))
	}
	s.logger.Info("Drive: uploaded \"%s\"", note.ID)
	s.logger.NotifyDriveStatus(s.ctx, "synced")
	s.resetPollingInterval()
	return nil
}

// ノートを更新する
func (s *driveService) UpdateNote(note *Note) error {
	if !s.IsConnected() {
		return s.auth.HandleOfflineTransition(fmt.Errorf("not connected to Google Drive"))
	}
	s.logger.NotifyDriveStatus(s.ctx, "syncing")
	s.logger.Info("Drive: updating \"%s\"", note.ID)
	err := s.driveSync.UpdateNote(s.ctx, note)
	if err != nil {
		if strings.Contains(err.Error(), "operation cancelled") {
			s.logger.Console("Note update was cancelled: %v", err)
			return nil
		}
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to update note: %v", err))
	}
	s.logger.Info("Drive: updated \"%s\"", note.ID)
	s.logger.NotifyDriveStatus(s.ctx, "synced")
	s.resetPollingInterval()
	return nil
}

// ノートを削除
func (s *driveService) DeleteNoteDrive(noteID string) error {
	if !s.IsConnected() {
		return s.auth.HandleOfflineTransition(fmt.Errorf("drive service is not initialized"))
	}
	s.logger.NotifyDriveStatus(s.ctx, "syncing")
	s.logger.Info("Drive: deleting note %s", noteID)
	err := s.driveSync.DeleteNote(s.ctx, noteID)
	if err != nil {
		if strings.Contains(err.Error(), "operation cancelled") {
			s.logger.Console("Note deletion was cancelled: %v", err)
			return nil
		}
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to delete note from cloud"))
	}
	s.logger.Info("Drive: deleted note from cloud")
	s.logger.NotifyDriveStatus(s.ctx, "synced")
	s.resetPollingInterval()
	return nil
}

func (s *driveService) UpdateNoteList() error {
	s.syncMu.Lock()
	defer s.syncMu.Unlock()

	if s.deferredUploadTimer != nil {
		s.deferredUploadTimer.Stop()
		s.deferredUploadTimer = nil
	}

	if time.Since(s.lastNoteListUpload) < 2*time.Second {
		s.logger.Console("Deferring note list upload (last upload %v ago)", time.Since(s.lastNoteListUpload))
		s.deferredUploadTimer = time.AfterFunc(2*time.Second, func() {
			s.syncMu.Lock()
			defer s.syncMu.Unlock()
			s.deferredUploadTimer = nil
			s.noteService.noteList.LastSync = time.Now()
			if err := s.noteService.saveNoteList(); err != nil {
				s.logger.Error(err, "Drive: failed to save note list for deferred upload")
				return
			}
			if err := s.updateNoteListInternal(); err != nil {
				s.logger.Error(err, "Drive: deferred upload failed")
			}
		})
		return nil
	}
	return s.updateNoteListInternal()
}

// SaveNoteAndUpdateList はノートのアップロードとノートリスト更新を syncMu 配下でアトミックに実行する。
// SaveNote の非同期ゴルーチンから呼ばれ、SyncNotes とのレース条件を防止する。
func (s *driveService) SaveNoteAndUpdateList(note *Note, isCreate bool) error {
	s.syncMu.Lock()
	defer s.syncMu.Unlock()

	if !s.IsConnected() {
		return s.auth.HandleOfflineTransition(fmt.Errorf("not connected to Google Drive"))
	}

	if isCreate {
		s.logger.Info("Drive: uploading \"%s\"", note.Title)
		err := s.driveSync.CreateNote(s.ctx, note)
		if err != nil {
			if strings.Contains(err.Error(), "operation cancelled") {
				return nil
			}
			return s.auth.HandleOfflineTransition(fmt.Errorf("failed to create note: %v", err))
		}
	} else {
		s.logger.Info("Drive: updating \"%s\"", note.ID)
		err := s.driveSync.UpdateNote(s.ctx, note)
		if err != nil {
			if strings.Contains(err.Error(), "operation cancelled") {
				return nil
			}
			return s.auth.HandleOfflineTransition(fmt.Errorf("failed to update note: %v", err))
		}
	}

	s.noteService.noteList.LastSync = time.Now()
	if err := s.noteService.saveNoteList(); err != nil {
		return err
	}
	if err := s.updateNoteListInternal(); err != nil {
		return err
	}

	s.resetPollingInterval()
	return nil
}

func (s *driveService) updateNoteListInternal() error {
	if !s.IsConnected() {
		return s.auth.HandleOfflineTransition(fmt.Errorf("drive service is not initialized"))
	}
	s.logger.NotifyDriveStatus(s.ctx, "syncing")
	s.logger.Console("Modifying note list: %v, Notes count: %d", s.noteService.noteList.LastSync, len(s.noteService.noteList.Notes))

	s.noteService.noteList.LastSyncClientID = s.clientID
	err := s.driveSync.UpdateNoteList(s.ctx, s.noteService.noteList, s.auth.GetDriveSync().NoteListID())
	if err != nil {
		if strings.Contains(err.Error(), "operation cancelled") {
			s.logger.Console("Note list update was cancelled: %v", err)
			return nil
		}
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to update note list"))
	}

	s.auth.GetDriveSync().UpdateCloudNoteList(
		s.noteService.noteList.LastSync,
		s.noteService.noteList.LastSyncClientID,
		s.noteService.noteList.Notes,
		s.noteService.noteList.Folders,
		s.noteService.noteList.TopLevelOrder,
		s.noteService.noteList.ArchivedTopLevelOrder,
		s.noteService.noteList.CollapsedFolderIDs,
	)

	s.lastNoteListUpload = time.Now()
	s.pollingService.RefreshChangeToken()
	s.logger.Console("Note list updated")
	s.logger.NotifyDriveStatus(s.ctx, "synced")
	return nil
}

// ------------------------------------------------------------
// 同期ジャーナル: クラッシュリカバリ用
// ------------------------------------------------------------

func (s *driveService) journalPath() string {
	return filepath.Join(s.appDataDir, "sync_journal.json")
}

func (s *driveService) writeSyncJournal(journal *SyncJournal) error {
	data, err := json.MarshalIndent(journal, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.journalPath(), data, 0644)
}

func (s *driveService) readSyncJournal() (*SyncJournal, error) {
	data, err := os.ReadFile(s.journalPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var journal SyncJournal
	if err := json.Unmarshal(data, &journal); err != nil {
		os.Remove(s.journalPath())
		return nil, nil
	}
	return &journal, nil
}

func (s *driveService) deleteSyncJournal() {
	os.Remove(s.journalPath())
}

func (s *driveService) markJournalActionCompleted(journal *SyncJournal, noteID string) {
	for i := range journal.Actions {
		if journal.Actions[i].NoteID == noteID {
			journal.Actions[i].Completed = true
			break
		}
	}
	s.writeSyncJournal(journal)
}

func (s *driveService) buildSyncJournal(localNotes, cloudNotes []NoteMetadata) *SyncJournal {
	journal := &SyncJournal{
		StartedAt: time.Now(),
		Actions:   []SyncJournalAction{},
	}

	localMap := make(map[string]NoteMetadata)
	cloudMap := make(map[string]NoteMetadata)
	for _, n := range localNotes {
		localMap[n.ID] = n
	}
	for _, n := range cloudNotes {
		cloudMap[n.ID] = n
	}

	for id, localNote := range localMap {
		if cloudNote, exists := cloudMap[id]; exists {
			if localNote.ContentHash != cloudNote.ContentHash {
				journal.Actions = append(journal.Actions, SyncJournalAction{Type: "download", NoteID: id})
			}
		} else {
			// ローカル専用ノートはアップロード対象だが、物理ファイルが存在しない場合はスキップ
			if _, loadErr := s.noteService.LoadNote(id); loadErr != nil {
				s.logger.Console("buildSyncJournal: skipping upload for note %s (file not found)", id)
				continue
			}
			journal.Actions = append(journal.Actions, SyncJournalAction{Type: "upload", NoteID: id})
		}
	}
	for id := range cloudMap {
		if _, exists := localMap[id]; !exists {
			journal.Actions = append(journal.Actions, SyncJournalAction{Type: "download", NoteID: id})
		}
	}

	return journal
}

func (s *driveService) recoverFromJournal() {
	journal, err := s.readSyncJournal()
	if err != nil || journal == nil {
		return
	}

	s.logger.Info("Drive: recovering interrupted sync...")

	recovered := 0
	for _, action := range journal.Actions {
		if action.Completed {
			continue
		}
		switch action.Type {
		case "download":
			note, dlErr := s.driveSync.DownloadNote(s.ctx, action.NoteID)
			if dlErr != nil {
				s.logger.Error(dlErr, "Drive: recovery failed to download note %s", action.NoteID)
				continue
			}
			if saveErr := s.noteService.SaveNoteFromSync(note); saveErr != nil {
				s.logger.Error(saveErr, "Drive: recovery failed to save note %s", action.NoteID)
				continue
			}
			recovered++
		case "upload":
			note, loadErr := s.noteService.LoadNote(action.NoteID)
			if loadErr != nil {
				s.logger.Error(loadErr, "Drive: recovery failed to load note %s", action.NoteID)
				continue
			}
			if createErr := s.driveSync.CreateNote(s.ctx, note); createErr != nil {
				s.logger.Error(createErr, "Drive: recovery failed to upload note %s", action.NoteID)
				continue
			}
			recovered++
		}
	}

	s.deleteSyncJournal()

	if recovered > 0 {
		s.logger.Info("Drive: recovered %d notes from interrupted sync", recovered)
	} else {
		s.logger.Info("Drive: interrupted sync already recovered")
	}
}

// ------------------------------------------------------------
// ノート同期: SyncNotes (今すぐ同期)
// ------------------------------------------------------------
func (s *driveService) SyncNotes() error {
	s.syncMu.Lock()
	defer s.syncMu.Unlock()

	forceSync := s.forceNextSync
	s.forceNextSync = false
	s.lastSyncResult = &SyncResult{}

	// 1. キューが空かどうかを確認（空でなければ一旦同期をスキップする）
	if s.skipSyncIfQueuePending() {
		return nil
	}

	// 2. 接続状態の確認
	if err := s.ensureSyncIsPossible(); err != nil {
		return err
	}

	// 3. 同期開始の通知
	s.logger.NotifyDriveStatus(s.ctx, "syncing")
	s.logger.Info("Drive: syncing...")

	// 5. クラウド上のノートリストを条件付きで取得（変更がなければスキップ）
	noteListID := s.auth.GetDriveSync().NoteListID()
	var cloudNoteList *NoteList
	if forceSync {
		var dlErr error
		cloudNoteList, dlErr = s.driveSync.DownloadNoteList(s.ctx, noteListID)
		if dlErr != nil {
			return s.auth.HandleOfflineTransition(dlErr)
		}
	} else {
		var changed bool
		var dlErr error
		cloudNoteList, changed, dlErr = s.driveSync.DownloadNoteListIfChanged(s.ctx, noteListID)
		if dlErr != nil {
			return s.auth.HandleOfflineTransition(dlErr)
		}
		if !changed {
			s.notifySyncComplete()
			return nil
		}
	}
	if cloudNoteList == nil {
		s.logger.Info("Drive: first sync — uploading all notes")
		if uploadErr := s.uploadAllNotesWithContent(s.ctx); uploadErr != nil {
			return s.auth.HandleOfflineTransition(fmt.Errorf("failed to upload all notes: %w", uploadErr))
		}
		var dlErr error
		cloudNoteList, dlErr = s.driveSync.DownloadNoteList(s.ctx, noteListID)
		if dlErr != nil {
			return s.auth.HandleOfflineTransition(dlErr)
		}
	}

	// 6. 同期対象のログ出力
	s.logSyncStatus(cloudNoteList, s.noteService.noteList)

	// 7. コンテンツベースの差分チェック（タイムスタンプではなくハッシュで判定）
	if !s.isNoteListChanged(cloudNoteList.Notes, s.noteService.noteList.Notes) {
		if s.isStructureChanged(cloudNoteList) {
			s.logger.Info("Drive: syncing folder structure")
			s.mergeNoteListStructure(cloudNoteList)
			if !equalStructure(s.noteService.noteList, cloudNoteList) {
				s.logger.Info("Drive: local has unique structure changes, uploading")
				if err := s.updateNoteListInternal(); err != nil {
					s.logger.Error(err, "Drive: failed to upload note list after structure merge")
				}
			} else {
				s.logger.Console("Drive: structure merged from cloud, no upload needed")
			}
		}
		s.notifySyncComplete()
		return nil
	}

	// 8. ノートの内容が異なる場合はマージ
	if err := s.driveSync.RefreshFileIDCache(s.ctx); err != nil {
		s.logger.Error(err, "Drive: failed to refresh file cache before merge")
	}
	s.logger.Info("Drive: merging local and cloud changes")
	if err := s.mergeNoteListsAndDownload(cloudNoteList); err != nil {
		return s.auth.HandleOfflineTransition(err)
	}
	s.mergeNoteListStructure(cloudNoteList)

	// 9. 同期完了の通知
	s.notifySyncComplete()
	return nil
}

// ------------------------------------------------------------
// 初回同期: performInitialSync (リファクタ後)
// ------------------------------------------------------------
func (s *driveService) performInitialSync() error {
	s.syncMu.Lock()
	defer s.syncMu.Unlock()

	s.logger.Console("Starting initial sync...")
	s.logger.NotifyDriveStatus(s.ctx, "syncing")

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

	s.logger.Console("Preparing to merge notes: %d local, %d from cloud (after merging unknown notes)",
		len(s.noteService.noteList.Notes),
		len(mergedCloudNotes),
	)

	// 2.5. プレビュー: メタデータだけ先にマージしてノートリストを表示
	originalLocalNotes := make([]NoteMetadata, len(s.noteService.noteList.Notes))
	copy(originalLocalNotes, s.noteService.noteList.Notes)
	s.publishPreviewNoteList(cloudNoteList, mergedCloudNotes)

	// 3. ノートのマージ処理 (ローカル vs クラウド)
	journal := s.buildSyncJournal(originalLocalNotes, mergedCloudNotes)
	if len(journal.Actions) > 0 {
		s.writeSyncJournal(journal)
	}

	mergedNotes, downloadedNotes, err := s.mergeNotes(s.ctx, originalLocalNotes, mergedCloudNotes, cloudNoteList.LastSync)
	if err != nil {
		return fmt.Errorf("failed to merge notes: %w", err)
	}

	for i, note := range downloadedNotes {
		if err := s.noteService.SaveNoteFromSync(note); err != nil {
			return fmt.Errorf("failed to save downloaded note: %w", err)
		}
		s.markJournalActionCompleted(journal, note.ID)
		if len(downloadedNotes) > 10 && ((i+1)%10 == 0 || i+1 == len(downloadedNotes)) {
			s.logger.NotifyFrontendSyncedAndReload(s.ctx)
		}
	}
	s.deleteSyncJournal()

	// 5. マージ完了後のノートリストを保存してクラウドを更新
	if err := s.saveAndUpdateNoteList(cloudNoteList, mergedNotes); err != nil {
		return err
	}

	// 6. 完了通知
	s.logger.Console("Initial sync completed")
	s.logger.NotifyFrontendSyncedAndReload(s.ctx)
	s.logger.NotifyDriveStatus(s.ctx, "synced")
	return nil
}

// publishPreviewNoteList はメタデータだけを先にマージしてフロントエンドに通知する。
// ダウンロード未完了のノートはSyncing状態でリストに表示される。
func (s *driveService) publishPreviewNoteList(cloudNoteList *NoteList, cloudNotes []NoteMetadata) {
	seen := make(map[string]bool)
	var preview []NoteMetadata
	for _, n := range s.noteService.noteList.Notes {
		preview = append(preview, n)
		seen[n.ID] = true
	}
	for _, n := range cloudNotes {
		if !seen[n.ID] {
			preview = append(preview, n)
		}
	}
	s.noteService.noteList.Notes = preview
	s.mergeNoteListStructure(cloudNoteList)
	if err := s.noteService.saveNoteList(); err != nil {
		s.logger.Error(err, "Drive: failed to save preview note list")
	}
	s.logger.NotifyFrontendSyncedAndReload(s.ctx)
}

// ------------------------------------------------------------
// SyncNotes および performInitialSync 内で利用する
// プライベートメソッド群 (リファクタで追加)
// ------------------------------------------------------------

// キュー内に処理が残っている場合は同期をスキップ（true = スキップした）
func (s *driveService) skipSyncIfQueuePending() bool {
	if s.operationsQueue != nil && s.operationsQueue.HasItems() {
		s.logger.Info("Drive: waiting for pending operations")
		return true
	}
	return false
}

// 同期開始が可能かどうかを検証
func (s *driveService) ensureSyncIsPossible() error {
	if !s.IsConnected() {
		s.logger.Console("Not connected to Google Drive")
		if !s.IsTestMode() {
			return s.auth.HandleOfflineTransition(fmt.Errorf("not connected to Google Drive"))
		}
		return fmt.Errorf("not connected to Google Drive")
	}
	return nil
}

// 同期が完了したらフロントエンドへ通知
func (s *driveService) notifySyncComplete() {
	if _, err := s.noteService.ValidateIntegrity(); err != nil {
		s.logger.Error(err, "Drive: integrity check failed after sync")
	}
	if s.lastSyncResult != nil && s.lastSyncResult.HasChanges() {
		s.logger.Info(s.lastSyncResult.Summary())
		s.logger.NotifyFrontendSyncedAndReload(s.ctx)
	}
	if s.operationsQueue != nil && s.operationsQueue.HasItems() {
		s.logger.Info("Drive: upload queue active")
		s.logger.NotifyDriveStatus(s.ctx, "syncing")
	} else {
		s.logger.Console("Sync status is up to date")
		s.logger.NotifyDriveStatus(s.ctx, "synced")
	}
}

// 同期の前後のステータスログ
func (s *driveService) logSyncStatus(cloudNoteList, localNoteList *NoteList) {
	s.logger.Info("Drive: cloud state — last sync: %v, notes: %d", cloudNoteList.LastSync, len(cloudNoteList.Notes))
	s.logger.Info("Drive: local state — last sync: %v, notes: %d", localNoteList.LastSync, len(localNoteList.Notes))
}

// conflict copy の重複を自動解決し、必要ならクラウドも削除する
func (s *driveService) resolveConflictCopiesAfterMerge() {
	resolution := s.noteService.autoResolveConflictCopies()
	if len(resolution.deleted) == 0 {
		return
	}

	s.RecordNoteDeletion(resolution.deleted...)

	if s.driveSync == nil || !s.IsConnected() {
		s.logger.Info("Drive: conflict copy deletions recorded locally (%d)", len(resolution.deleted))
		return
	}

	for _, id := range resolution.deleted {
		if err := s.driveSync.DeleteNote(s.ctx, id); err != nil {
			s.logger.Error(err, "Drive: failed to delete conflict copy %s from cloud", id)
			if s.lastSyncResult != nil {
				s.lastSyncResult.Errors++
			}
			continue
		}
		s.logger.Info("Drive: deleted conflict copy from cloud: %s", id)
		if s.lastSyncResult != nil {
			s.lastSyncResult.Deleted++
		}
	}
}

// 「同じタイムスタンプだが内容が違う」場合のマージ実行
func (s *driveService) mergeNoteListsAndDownload(cloudNoteList *NoteList) error {
	journal := s.buildSyncJournal(s.noteService.noteList.Notes, cloudNoteList.Notes)
	if len(journal.Actions) > 0 {
		s.writeSyncJournal(journal)
	}

	mergedNotes, downloadedNotes, err := s.mergeNotes(s.ctx, s.noteService.noteList.Notes, cloudNoteList.Notes, cloudNoteList.LastSync)
	if err != nil {
		return err
	}
	for _, note := range downloadedNotes {
		if err := s.noteService.SaveNoteFromSync(note); err != nil {
			return fmt.Errorf("failed to save downloaded note: %w", err)
		}
		s.markJournalActionCompleted(journal, note.ID)
	}
	s.noteService.noteList.Notes = mergedNotes
	s.mergeNoteListStructure(cloudNoteList)
	s.resolveConflictCopiesAfterMerge()
	if err := s.noteService.saveNoteList(); err != nil {
		return fmt.Errorf("failed to save merged note list: %w", err)
	}

	s.deleteSyncJournal()
	return s.updateNoteListInternal()
}

// ------------------------------------------------------------
// 既存の大・中メソッド (部分的に細分化済)
// ------------------------------------------------------------

func (s *driveService) mergeNotes(
	ctx context.Context,
	localNotes []NoteMetadata,
	cloudNotes []NoteMetadata,
	cloudLastSync time.Time,
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
			localHash := localNote.ContentHash
			cloudHash := cloudNote.ContentHash

			if localHash == "" || cloudHash == "" {
				if note, err := s.noteService.LoadNote(id); err == nil {
					recomputed := computeContentHash(note)
					if localHash == "" {
						localHash = recomputed
					}
					if cloudHash == "" {
						cloudHash = recomputed
					}
				}
			}

			if localHash == cloudHash {
				mergedNotes = append(mergedNotes, localNote)
				delete(cloudNotesMap, id)
				continue
			}

			localMeta := localNotesMap[id]
			cloudMeta := cloudNote

			localTime := localMeta.ModifiedTime
			cloudTime := cloudMeta.ModifiedTime
			if isModifiedTimeAfter(cloudTime, localTime) {
				s.logger.Info("Drive: downloading newer cloud version of %s", id)
				mergedNotes = append(mergedNotes, cloudMeta)
				note, dlErr := s.driveSync.DownloadNote(ctx, id)
				if dlErr != nil {
					s.logger.Error(dlErr, "Drive: failed to download note %s", id)
					if s.lastSyncResult != nil {
						s.lastSyncResult.Errors++
					}
				} else {
					downloadedNotes = append(downloadedNotes, note)
					if s.lastSyncResult != nil {
						s.lastSyncResult.Downloaded++
					}
				}
			} else if isModifiedTimeAfter(localTime, cloudTime) {
				s.logger.Info("Drive: uploading newer local version of %s", id)
				mergedNotes = append(mergedNotes, localMeta)
				note, err := s.noteService.LoadNote(id)
				if err == nil {
					if createErr := s.driveSync.UpdateNote(ctx, note); createErr != nil {
						s.logger.Error(createErr, "Drive: failed to upload note %s", id)
						if s.lastSyncResult != nil {
							s.lastSyncResult.Errors++
						}
					} else if s.lastSyncResult != nil {
						s.lastSyncResult.Uploaded++
					}
				}
			} else {
				if s.isOneSidedChange(localMeta, cloudMeta) {
					s.logger.Info("Drive: metadata updated for %s (content unchanged)", id)
					mergedNotes = append(mergedNotes, cloudMeta)
				} else {
					localNote, loadErr := s.noteService.LoadNote(id)
					if loadErr != nil {
						s.logger.Error(loadErr, "Drive: failed to load note %s for conflict merge", id)
					} else {
						s.logger.Info("Drive: merged conflict in \"%s\"", localNote.Title)
						if s.lastSyncResult != nil {
							s.lastSyncResult.ConflictMerges++
						}
					}
					mergedNotes = append(mergedNotes, cloudMeta)
					cloudNote, dlErr := s.driveSync.DownloadNote(ctx, id)
					if dlErr != nil {
						s.logger.Error(dlErr, "Drive: skipped note %s (data corruption)", id)
						if s.lastSyncResult != nil {
							s.lastSyncResult.Errors++
						}
					} else {
						if localNote != nil {
							cloudNote.Content = MergeConflictContent(
								cloudNote.Content, localNote.Content,
								cloudMeta.ModifiedTime, localMeta.ModifiedTime,
							)
						}
						downloadedNotes = append(downloadedNotes, cloudNote)
						if s.lastSyncResult != nil {
							s.lastSyncResult.Downloaded++
						}
					}
				}
			}
			delete(cloudNotesMap, id)
		} else {
			// ローカルのみ存在するノート: cloudLastSyncより前に変更 → 他端末で削除済み、後に変更 → アップロード
			if !cloudLastSync.IsZero() && !isModifiedTimeAfter(localNote.ModifiedTime, cloudLastSync.Format(time.RFC3339)) {
				s.logger.Info("Drive: removed \"%s\" (deleted on another device)", localNote.Title)
				s.noteService.DeleteNoteFromSync(id)
				if s.lastSyncResult != nil {
					s.lastSyncResult.Deleted++
				}
			} else {
				mergedNotes = append(mergedNotes, localNote)
				note, err := s.noteService.LoadNote(id)
				if err == nil {
					s.logger.Info("Drive: uploading note %s to cloud", id)
					if createErr := s.driveSync.CreateNote(ctx, note); createErr != nil {
						s.logger.Error(createErr, "Drive: failed to upload note %s (skipped)", id)
						if s.lastSyncResult != nil {
							s.lastSyncResult.Errors++
						}
					} else if s.lastSyncResult != nil {
						s.lastSyncResult.Uploaded++
					}
				}
			}
		}
	}

	// クラウドのみ存在するノートはダウンロード
	cloudOnlyCount := len(cloudNotesMap)
	cloudOnlyIndex := 0
	if cloudOnlyCount > 0 {
		s.logger.Info("Drive: downloading %d notes...", cloudOnlyCount)
	}
	s.deletedMu.Lock()
	locallyDeleted := make(map[string]bool, len(s.recentlyDeletedNoteIDs))
	for id, v := range s.recentlyDeletedNoteIDs {
		locallyDeleted[id] = v
	}
	s.deletedMu.Unlock()

	for id, cloudNote := range cloudNotesMap {
		if locallyDeleted[id] {
			s.logger.Console("Skipping cloud-only note: %s (deleted locally)", cloudNote.Title)
			s.deletedMu.Lock()
			delete(s.recentlyDeletedNoteIDs, id)
			s.deletedMu.Unlock()
			continue
		}
		cloudOnlyIndex++
		s.logger.Console("Downloading note %s from cloud (%d/%d)", id, cloudOnlyIndex, cloudOnlyCount)
		note, err := s.driveSync.DownloadNote(ctx, id)
		if err != nil {
			if strings.Contains(err.Error(), "not found") {
				// ファイルがDriveから削除済み — noteListにも含めない
				s.logger.Info("Drive: note %s removed from Drive, cleaning up", id)
			} else {
				// 一時的なエラー（ネットワーク等）— noteListに残して次回リトライ
				s.logger.Error(err, "Drive: download failed for note %s (will retry)", id)
				mergedNotes = append(mergedNotes, cloudNote)
			}
			if s.lastSyncResult != nil {
				s.lastSyncResult.Errors++
			}
			continue
		}
		mergedNotes = append(mergedNotes, cloudNote)
		downloadedNotes = append(downloadedNotes, note)
		if s.lastSyncResult != nil {
			s.lastSyncResult.Downloaded++
		}
		if cloudOnlyCount > 10 && cloudOnlyIndex%10 == 0 {
			s.logger.Info("Drive: downloading notes (%d/%d)", cloudOnlyIndex, cloudOnlyCount)
		}
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
			s.logger.Error(err, "Drive: failed to sync note %s", cloudNote.ID)
			continue
		}
	}

	// ローカルにしかないノートを処理 (C-4: 削除 vs 編集の衝突保護)
	lastSync := cloudNoteList.LastSync
	deletedCount := 0
	for _, localNote := range currentNotes {
		exists := false
		for _, cloudNote := range cloudNoteList.Notes {
			if cloudNote.ID == localNote.ID {
				exists = true
				break
			}
		}
		if !exists {
			if isModifiedTimeAfter(localNote.ModifiedTime, lastSync.Format(time.RFC3339)) {
				s.logger.Info("Drive: kept local \"%s\" (edited after last sync)", localNote.Title)
				note, err := s.noteService.LoadNote(localNote.ID)
				if err == nil {
					if createErr := s.driveSync.CreateNote(s.ctx, note); createErr != nil {
						s.logger.Error(createErr, "Drive: failed to upload preserved note %s", localNote.ID)
					}
				}
				cloudNoteList.Notes = append(cloudNoteList.Notes, localNote)
			} else {
				s.logger.Info("Drive: removed \"%s\" (unchanged since last sync)", localNote.Title)
				s.noteService.DeleteNoteFromSync(localNote.ID)
				deletedCount++
				if s.lastSyncResult != nil {
					s.lastSyncResult.Deleted++
				}
			}
		}
	}
	if deletedCount > 0 {
		s.logger.Info("Drive: removed %d notes deleted on another device", deletedCount)
	}

	s.mergeNoteListStructure(cloudNoteList)

	return nil
}

// equalStructure は2つのNoteListの構造フィールドだけを比較する。
// LastSync/LastSyncClientID を意図的に無視し、同期ループ（ping-pong）を防止する。
func equalStructure(a, b *NoteList) bool {
	if len(a.Folders) != len(b.Folders) {
		return false
	}
	bFolderSet := make(map[string]bool)
	for _, f := range b.Folders {
		bFolderSet[f.ID] = true
	}
	for _, f := range a.Folders {
		if !bFolderSet[f.ID] {
			return false
		}
	}

	if len(a.TopLevelOrder) != len(b.TopLevelOrder) {
		return false
	}
	for i, item := range a.TopLevelOrder {
		if item.ID != b.TopLevelOrder[i].ID || item.Type != b.TopLevelOrder[i].Type {
			return false
		}
	}

	if len(a.ArchivedTopLevelOrder) != len(b.ArchivedTopLevelOrder) {
		return false
	}
	for i, item := range a.ArchivedTopLevelOrder {
		if item.ID != b.ArchivedTopLevelOrder[i].ID || item.Type != b.ArchivedTopLevelOrder[i].Type {
			return false
		}
	}

	if len(a.CollapsedFolderIDs) != len(b.CollapsedFolderIDs) {
		return false
	}
	aCollapsed := make(map[string]bool)
	for _, id := range a.CollapsedFolderIDs {
		aCollapsed[id] = true
	}
	for _, id := range b.CollapsedFolderIDs {
		if !aCollapsed[id] {
			return false
		}
	}

	return true
}

func (s *driveService) isStructureChanged(cloudNoteList *NoteList) bool {
	if equalStructure(s.noteService.noteList, cloudNoteList) {
		return false
	}

	if len(s.noteService.noteList.Folders) != len(cloudNoteList.Folders) {
		s.logger.Console("Structure changed: Folder count differs (local=%d, cloud=%d)", len(s.noteService.noteList.Folders), len(cloudNoteList.Folders))
	}
	if len(s.noteService.noteList.TopLevelOrder) != len(cloudNoteList.TopLevelOrder) {
		s.logger.Console("Structure changed: TopLevelOrder length differs (local=%d, cloud=%d)", len(s.noteService.noteList.TopLevelOrder), len(cloudNoteList.TopLevelOrder))
	} else {
		for i, item := range s.noteService.noteList.TopLevelOrder {
			if item.ID != cloudNoteList.TopLevelOrder[i].ID || item.Type != cloudNoteList.TopLevelOrder[i].Type {
				s.logger.Console("Structure changed: TopLevelOrder[%d] differs (local=%s/%s, cloud=%s/%s)", i, item.Type, item.ID, cloudNoteList.TopLevelOrder[i].Type, cloudNoteList.TopLevelOrder[i].ID)
				break
			}
		}
	}
	if len(s.noteService.noteList.ArchivedTopLevelOrder) != len(cloudNoteList.ArchivedTopLevelOrder) {
		s.logger.Console("Structure changed: ArchivedTopLevelOrder length differs (local=%d, cloud=%d)", len(s.noteService.noteList.ArchivedTopLevelOrder), len(cloudNoteList.ArchivedTopLevelOrder))
	} else {
		for i, item := range s.noteService.noteList.ArchivedTopLevelOrder {
			if item.ID != cloudNoteList.ArchivedTopLevelOrder[i].ID || item.Type != cloudNoteList.ArchivedTopLevelOrder[i].Type {
				s.logger.Console("Structure changed: ArchivedTopLevelOrder[%d] differs", i)
				break
			}
		}
	}
	if len(s.noteService.noteList.CollapsedFolderIDs) != len(cloudNoteList.CollapsedFolderIDs) {
		s.logger.Console("Structure changed: CollapsedFolderIDs length differs (local=%d, cloud=%d)", len(s.noteService.noteList.CollapsedFolderIDs), len(cloudNoteList.CollapsedFolderIDs))
	}
	return true
}

func (s *driveService) mergeNoteListStructure(cloudNoteList *NoteList) {
	if !s.isStructureChanged(cloudNoteList) {
		return
	}

	cloudNewer := isModifiedTimeAfter(
		cloudNoteList.LastSync.Format(time.RFC3339),
		s.noteService.noteList.LastSync.Format(time.RFC3339),
	)

	cloudFolderIDs := make(map[string]bool)
	for _, f := range cloudNoteList.Folders {
		cloudFolderIDs[f.ID] = true
	}

	mergedFolders := make([]Folder, len(cloudNoteList.Folders))
	copy(mergedFolders, cloudNoteList.Folders)
	for _, localFolder := range s.noteService.noteList.Folders {
		if !cloudFolderIDs[localFolder.ID] {
			mergedFolders = append(mergedFolders, localFolder)
		}
	}
	s.noteService.noteList.Folders = mergedFolders

	if cloudNewer {
		s.noteService.noteList.TopLevelOrder = s.mergeTopLevelOrder(
			cloudNoteList.TopLevelOrder, s.noteService.noteList.TopLevelOrder)
		s.noteService.noteList.ArchivedTopLevelOrder = s.mergeTopLevelOrder(
			cloudNoteList.ArchivedTopLevelOrder, s.noteService.noteList.ArchivedTopLevelOrder)
	} else {
		s.noteService.noteList.TopLevelOrder = s.mergeTopLevelOrder(
			s.noteService.noteList.TopLevelOrder, cloudNoteList.TopLevelOrder)
		s.noteService.noteList.ArchivedTopLevelOrder = s.mergeTopLevelOrder(
			s.noteService.noteList.ArchivedTopLevelOrder, cloudNoteList.ArchivedTopLevelOrder)
	}

	s.noteService.noteList.CollapsedFolderIDs = cloudNoteList.CollapsedFolderIDs

	if err := s.noteService.saveNoteList(); err != nil {
		s.logger.Error(err, "Drive: failed to save note list after structure merge")
	}
}

// uploadAllNotesWithContent はローカルの全ノートをContentを含めてアップロードする
func (s *driveService) uploadAllNotesWithContent(ctx context.Context) error {
	for _, meta := range s.noteService.noteList.Notes {
		note, err := s.noteService.LoadNote(meta.ID)
		if err != nil {
			s.logger.Error(err, "Drive: skipped note %s (file missing)", meta.ID)
			continue
		}
		if createErr := s.driveSync.CreateNote(ctx, note); createErr != nil {
			s.logger.Error(createErr, "Drive: failed to upload note %s", meta.ID)
			continue
		}
	}
	return nil
}

// isOneSidedChange はローカルの実ファイルのハッシュがクラウド側と一致するかを確認する。
// 一致する場合、ローカルファイルは既にクラウドと同じ内容であり、メタデータだけが古い状態。
// この場合はコンフリクトコピーを作成せず、メタデータの更新のみで済む。
func (s *driveService) isOneSidedChange(localMeta, cloudMeta NoteMetadata) bool {
	localNote, err := s.noteService.LoadNote(localMeta.ID)
	if err != nil {
		return false
	}
	actualLocalHash := computeContentHash(localNote)

	if actualLocalHash == cloudMeta.ContentHash {
		return true
	}

	return false
}

func findNoteMetadata(notes []NoteMetadata, id string) *NoteMetadata {
	for _, n := range notes {
		if n.ID == id {
			return &n
		}
	}
	return nil
}

func (s *driveService) mergeTopLevelOrder(cloudOrder, localOrder []TopLevelItem) []TopLevelItem {
	cloudItemSet := make(map[string]bool)
	for _, item := range cloudOrder {
		cloudItemSet[item.Type+":"+item.ID] = true
	}
	merged := make([]TopLevelItem, len(cloudOrder))
	copy(merged, cloudOrder)
	for _, localItem := range localOrder {
		key := localItem.Type + ":" + localItem.ID
		if !cloudItemSet[key] {
			merged = append(merged, localItem)
		}
	}
	return merged
}

// 単一のクラウドのノートをローカルと同期する
func (s *driveService) syncNoteCloudToLocal(ctx context.Context, noteID string, cloudNote NoteMetadata) error {
	// ローカルのノートを読み込む
	localNote, err := s.noteService.LoadNote(noteID)
	if err != nil {
		// ローカルに存在しなければダウンロード
		s.logger.Info("Drive: downloading new note %s from cloud", noteID)
		if note, dlErr := s.driveSync.DownloadNote(ctx, noteID); dlErr != nil {
			return dlErr
		} else {
			s.noteService.SaveNoteFromSync(note)
			return nil
		}
	}
	// クラウドの方が新しい場合は上書きダウンロード
	if isModifiedTimeAfter(cloudNote.ModifiedTime, localNote.ModifiedTime) {
		s.logger.Info("Drive: downloading newer version of %s", noteID)
		if note, dlErr := s.driveSync.DownloadNote(ctx, noteID); dlErr != nil {
			return dlErr
		} else {
			note.ModifiedTime = cloudNote.ModifiedTime
			s.noteService.SaveNoteFromSync(note)
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
			s.logger.Error(err, "Drive: failed to load note %s (skipped)", localNote.ID)
			continue
		}
		if err := s.syncNoteLocalToCloud(localNoteFile); err != nil {
			s.logger.Error(err, "Drive: failed to sync note %s (skipped)", localNote.ID)
			continue
		}
	}

	// ファイル一覧取得
	_, notesID := s.auth.GetDriveSync().FolderIDs()
	files, err := s.driveSync.ListFiles(s.ctx, notesID)
	if err != nil {
		return err
	}

	// クラウドのノートリストにないノートをログのみ出力（削除しない: C-3）
	unknownNotes, err := s.driveSync.ListUnknownNotes(s.ctx, cloudNoteList, files, false)
	if err != nil {
		return err
	}
	for _, note := range unknownNotes.Notes {
		s.logger.Console("Found unknown cloud note: %s (not in noteList, skipping delete)", note.ID)
	}
	return nil
}

// 単一のローカルのノートをクラウドと同期する
func (s *driveService) syncNoteLocalToCloud(localNote *Note) error {
	cloudNoteID, err := s.driveSync.GetNoteID(s.ctx, localNote.ID)
	if cloudNoteID == "" || err != nil {
		s.logger.Info("Drive: uploading note %s to cloud", localNote.ID)
		if err := s.driveSync.CreateNote(s.ctx, localNote); err != nil {
			return err
		}
	} else {
		s.logger.Info("Drive: updating note %s in cloud", localNote.ID)
		if err := s.driveSync.UpdateNote(s.ctx, localNote); err != nil {
			return err
		}
	}
	return nil
}

// クラウドのノートリストを取得し、存在しなければローカルノートをアップロード後再取得
func (s *driveService) ensureCloudNoteList(ctx context.Context) (*NoteList, error) {
	noteListID := s.auth.GetDriveSync().NoteListID()
	cloudNoteList, err := s.driveSync.DownloadNoteList(ctx, noteListID)
	if err != nil {
		return nil, err
	}
	if cloudNoteList == nil {
		s.logger.Info("Drive: first sync — uploading all notes")
		if uploadErr := s.uploadAllNotesWithContent(ctx); uploadErr != nil {
			return nil, fmt.Errorf("failed to upload all notes: %w", uploadErr)
		}
		cloudNoteList, err = s.driveSync.DownloadNoteList(ctx, noteListID)
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
	// ファイル一覧取得
	_, notesID := s.auth.GetDriveSync().FolderIDs()
	files, err := s.driveSync.ListFiles(ctx, notesID)
	if err != nil {
		return nil, fmt.Errorf("failed to list files in notes folder: %w", err)
	}
	unknownNotes, err := s.driveSync.ListUnknownNotes(ctx, availableNotes, files, true)
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
		s.logger.Console("Note list length differs")
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
			s.logger.Console("Note %s exists in cloud but not in local", id)
			return true
		}
		if cloudNote.ContentHash != localNote.ContentHash {
			s.logger.Console("Note %s has different content hash", id)
			return true
		}
	}
	return false
}

// Google Drive上に必要なフォルダ構造を作成
func (s *driveService) ensureDriveFolders() error {
	var rootID, notesID string

	// ルートフォルダ
	rootFolders, err := s.driveOps.ListFiles(
		"name='monaco-notepad' and mimeType='application/vnd.google-apps.folder' and trashed=false")
	if err != nil {
		return s.logger.ErrorWithNotify(err, "Drive: failed to check root folder")
	}

	if len(rootFolders) == 0 {
		rootID, err = s.driveOps.CreateFolder("monaco-notepad", "")
		if err != nil {
			return s.logger.ErrorWithNotify(err, "Drive: failed to create root folder")
		}
	} else {
		rootID = rootFolders[0].Id
	}

	// notes フォルダ
	notesFolders, err := s.driveOps.ListFiles(
		fmt.Sprintf("name='notes' and '%s' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false",
			rootID))
	if err != nil {
		return s.logger.ErrorWithNotify(err, "Drive: failed to check notes folder")
	}

	if len(notesFolders) == 0 {
		notesID, err = s.driveOps.CreateFolder("notes", rootID)
		if err != nil {
			return s.logger.ErrorWithNotify(err, "Drive: failed to create notes folder")
		}
	} else {
		notesID = notesFolders[0].Id
	}

	s.auth.GetDriveSync().SetFolderIDs(rootID, notesID)
	return nil
}

// ノートリストの初期化
func (s *driveService) ensureNoteList() error {
	rootID, notesID := s.auth.GetDriveSync().FolderIDs()
	noteListFile, err := s.driveOps.ListFiles(
		fmt.Sprintf("name='noteList.json' and '%s' in parents and trashed=false", rootID))
	if err != nil {
		return s.logger.ErrorWithNotify(err, "Drive: failed to check note list file")
	}

	if len(noteListFile) > 0 {
		s.auth.GetDriveSync().SetNoteListID(noteListFile[0].Id)
	} else {
		if err := s.driveSync.CreateNoteList(s.ctx, s.noteService.noteList); err != nil {
			return err
		}
		noteListID, err := s.driveOps.GetFileID("noteList.json", notesID, rootID)
		if err != nil {
			return err
		}
		s.auth.GetDriveSync().SetNoteListID(noteListID)
	}
	return nil
}

// ノートリストの同期を行う共通処理
func (s *driveService) handleNoteListSync(cloudNoteList *NoteList) error {
	if cloudNoteList != nil {
		if err := s.updateNoteListInternal(); err != nil {
			return err
		}
	} else {
		if err := s.driveSync.CreateNoteList(s.ctx, s.noteService.noteList); err != nil {
			return err
		}
		rootID, notesID := s.auth.GetDriveSync().FolderIDs()
		noteListID, err := s.driveOps.GetFileID("noteList.json", notesID, rootID)
		if err != nil {
			return err
		}
		s.auth.GetDriveSync().SetNoteListID(noteListID)
	}
	return nil
}

// ノートリストの保存と更新を行う共通処理
func (s *driveService) saveAndUpdateNoteList(cloudNoteList *NoteList, mergedNotes []NoteMetadata) error {
	s.noteService.noteList.Notes = mergedNotes
	s.noteService.noteList.LastSync = time.Now()
	s.resolveConflictCopiesAfterMerge()
	if err := s.noteService.saveNoteList(); err != nil {
		s.logger.Error(err, "Drive: failed to save merged note list")
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
func (ds *driveService) SetAuthService(auth *authService) {
	ds.auth = auth
}
