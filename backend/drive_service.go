package backend

import (
	"context"
	"fmt"
	"strings"
	"sync"
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

	// ---- ユーティリティ ----
	NotifyFrontendReady()                           // フロントエンド準備完了通知
	IsConnected() bool                              // 接続状態確認
	IsTestMode() bool                               // テストモード確認
	GetDriveOperationsQueue() *DriveOperationsQueue // キューシステムを取得
}

// driveService はDriveServiceインターフェースの実装
type driveService struct {
	ctx             context.Context
	auth            *authService
	noteService     *noteService
	appDataDir      string
	notesDir        string
	stopPollingChan chan struct{}
	logger          AppLogger
	driveOps        DriveOperations
	driveSync       DriveSyncService
	pollingService  *DrivePollingService
	operationsQueue *DriveOperationsQueue
	syncMu          sync.Mutex
	syncState       *SyncState
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
		ctx:             ctx,
		auth:            authService,
		noteService:     noteService,
		appDataDir:      appDataDir,
		notesDir:        notesDir,
		stopPollingChan: make(chan struct{}),
		logger:          logger,
		driveOps:        nil,
		driveSync:       nil,
		syncState:       syncState,
	}

	ds.pollingService = NewDrivePollingService(ctx, ds)
	return ds
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
func (s *driveService) onConnected() error {
	if !s.IsConnected() {
		return s.auth.HandleOfflineTransition(fmt.Errorf("not connected to Google Drive"))
	}
	s.logger.Console("Starting Drive connection process...")

	s.logger.Console("Initializing DriveOperations...")
	s.driveOps = NewDriveOperations(s.auth.GetDriveSync().service, s.logger)
	if s.driveOps == nil {
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to create DriveOperations"))
	}

	s.logger.Console("Initializing operations queue...")
	s.operationsQueue = NewDriveOperationsQueue(s.driveOps)
	if s.operationsQueue == nil {
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to create operations queue"))
	}
	s.driveOps = s.operationsQueue

	s.logger.Console("Ensuring Drive folders...")
	if err := s.ensureDriveFolders(); err != nil {
		s.logger.Error(err, "Drive: folder setup failed")
		return s.auth.HandleOfflineTransition(err)
	}

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

	s.logger.Console("Ensuring note list...")
	if err := s.ensureNoteList(); err != nil {
		s.logger.Error(err, "Drive: note list setup failed")
		return s.auth.HandleOfflineTransition(err)
	}

	s.logger.Info("Drive: connected")
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

// フロントエンドの準備完了を待って同期開始 (ポーリング用ゴルーチン起動)
func (s *driveService) waitForFrontendAndStartSync() {
	go s.pollingService.WaitForFrontendAndStartSync()
}

// ポーリングインターバルをリセット
func (s *driveService) resetPollingInterval() {
	s.pollingService.ResetPollingInterval()
}

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
	s.logger.Console("Modifying note list, Notes count: %d", len(s.noteService.noteList.Notes))

	err := s.driveSync.UpdateNoteList(s.ctx, s.noteService.noteList, s.auth.GetDriveSync().NoteListID())
	if err != nil {
		if strings.Contains(err.Error(), "operation cancelled") {
			s.logger.Console("Note list update was cancelled: %v", err)
			return nil
		}
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to update note list"))
	}

	s.pollingService.RefreshChangeToken()
	s.logger.Console("Note list updated")
	s.logger.NotifyDriveStatus(s.ctx, "synced")
	return nil
}

// ノート同期: SyncNotes (今すぐ同期)
func (s *driveService) SyncNotes() error {
	s.syncMu.Lock()
	defer s.syncMu.Unlock()

	if !s.IsConnected() {
		return s.auth.HandleOfflineTransition(fmt.Errorf("not connected to Google Drive"))
	}

	s.logger.NotifyDriveStatus(s.ctx, "syncing")

	noteListID := s.auth.GetDriveSync().NoteListID()
	if noteListID == "" {
		s.logger.Info("Drive: no noteList_v2.json on Drive, pushing all local notes")
		return s.pushLocalChanges()
	}

	meta, err := s.driveOps.GetFileMetadata(noteListID)
	if err != nil {
		s.logger.Error(err, "Drive: failed to get noteList metadata")
		return s.auth.HandleOfflineTransition(err)
	}
	cloudModifiedTime := meta.ModifiedTime

	cloudChanged := cloudModifiedTime != s.syncState.LastSyncedDriveTs
	localDirty := s.syncState.IsDirty()

	switch {
	case !cloudChanged && !localDirty:
		s.logger.Console("Sync: no changes detected")
		s.notifySyncComplete()
		return nil

	case !cloudChanged && localDirty:
		s.logger.Info("Drive: CASE A - pushing local changes")
		return s.pushLocalChanges()

	case cloudChanged && !localDirty:
		s.logger.Info("Drive: CASE B - pulling cloud changes")
		return s.pullCloudChanges(noteListID)

	default:
		s.logger.Info("Drive: CASE C - resolving conflict")
		return s.resolveConflict(noteListID)
	}
}

func (s *driveService) pushLocalChanges() error {
	dirtyIDs, deletedIDs, _ := s.syncState.GetDirtySnapshot()

	for id := range dirtyIDs {
		note, err := s.noteService.LoadNote(id)
		if err != nil {
			s.logger.Error(err, "Drive: failed to load dirty note %s (skipping)", id)
			continue
		}
		s.logger.Info("Drive: uploading note %s", id)
		if _, err := s.driveSync.GetNoteID(s.ctx, id); err != nil {
			if err := s.driveSync.CreateNote(s.ctx, note); err != nil {
				s.logger.Error(err, "Drive: failed to create note %s", id)
				continue
			}
		} else {
			if err := s.driveSync.UpdateNote(s.ctx, note); err != nil {
				s.logger.Error(err, "Drive: failed to update note %s", id)
				continue
			}
		}
	}

	for id := range deletedIDs {
		s.logger.Info("Drive: deleting note %s from Drive", id)
		if err := s.driveSync.DeleteNote(s.ctx, id); err != nil {
			s.logger.Error(err, "Drive: failed to delete note %s from Drive (skipping)", id)
		}
	}

	if err := s.noteService.saveNoteList(); err != nil {
		return fmt.Errorf("failed to save note list: %w", err)
	}

	noteListID := s.auth.GetDriveSync().NoteListID()
	if noteListID == "" {
		if err := s.driveSync.CreateNoteList(s.ctx, s.noteService.noteList); err != nil {
			return s.auth.HandleOfflineTransition(fmt.Errorf("failed to create note list: %w", err))
		}
		rootID, notesID := s.auth.GetDriveSync().FolderIDs()
		newNoteListID, err := s.driveOps.GetFileID("noteList_v2.json", notesID, rootID)
		if err != nil {
			return fmt.Errorf("failed to get noteList file ID: %w", err)
		}
		s.auth.GetDriveSync().SetNoteListID(newNoteListID)
		noteListID = newNoteListID
	} else {
		if err := s.driveSync.UpdateNoteList(s.ctx, s.noteService.noteList, noteListID); err != nil {
			return s.auth.HandleOfflineTransition(fmt.Errorf("failed to update note list: %w", err))
		}
	}

	meta, err := s.driveOps.GetFileMetadata(noteListID)
	if err != nil {
		s.logger.Error(err, "Drive: failed to get updated metadata after push")
	}

	driveTs := ""
	if meta != nil {
		driveTs = meta.ModifiedTime
	}
	noteHashes := make(map[string]string, len(s.noteService.noteList.Notes))
	for _, n := range s.noteService.noteList.Notes {
		noteHashes[n.ID] = n.ContentHash
	}
	s.syncState.ClearDirty(driveTs, noteHashes)

	s.pollingService.RefreshChangeToken()
	s.notifySyncComplete()
	s.logger.NotifyFrontendSyncedAndReload(s.ctx)
	return nil
}

func (s *driveService) pullCloudChanges(noteListID string) error {
	cloudNoteList, err := s.driveSync.DownloadNoteList(s.ctx, noteListID)
	if err != nil {
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to download note list: %w", err))
	}
	if cloudNoteList == nil {
		s.logger.Info("Drive: cloud noteList is nil, nothing to pull")
		s.notifySyncComplete()
		return nil
	}

	localMap := make(map[string]NoteMetadata, len(s.noteService.noteList.Notes))
	for _, n := range s.noteService.noteList.Notes {
		localMap[n.ID] = n
	}
	cloudMap := make(map[string]NoteMetadata, len(cloudNoteList.Notes))
	for _, n := range cloudNoteList.Notes {
		cloudMap[n.ID] = n
	}

	downloadCount := 0
	for _, cloudNote := range cloudNoteList.Notes {
		localNote, exists := localMap[cloudNote.ID]
		if !exists || localNote.ContentHash != cloudNote.ContentHash {
			s.logger.Info("Drive: downloading note %s", cloudNote.ID)
			note, dlErr := s.driveSync.DownloadNote(s.ctx, cloudNote.ID)
			if dlErr != nil {
				s.logger.Error(dlErr, "Drive: failed to download note %s", cloudNote.ID)
				continue
			}
			if err := s.noteService.SaveNoteFromSync(note); err != nil {
				s.logger.Error(err, "Drive: failed to save downloaded note %s", cloudNote.ID)
				continue
			}
			downloadCount++
			if downloadCount > 0 && downloadCount%10 == 0 {
				s.logger.NotifyFrontendSyncedAndReload(s.ctx)
			}
		}
	}

	for _, localNote := range s.noteService.noteList.Notes {
		if _, exists := cloudMap[localNote.ID]; !exists {
			s.logger.Info("Drive: removing local note %s (deleted on cloud)", localNote.ID)
			if err := s.noteService.DeleteNoteFromSync(localNote.ID); err != nil {
				s.logger.Error(err, "Drive: failed to remove local note %s", localNote.ID)
			}
		}
	}

	s.noteService.noteList.Version = cloudNoteList.Version
	s.noteService.noteList.Notes = cloudNoteList.Notes
	s.noteService.noteList.Folders = cloudNoteList.Folders
	s.noteService.noteList.TopLevelOrder = cloudNoteList.TopLevelOrder
	s.noteService.noteList.ArchivedTopLevelOrder = cloudNoteList.ArchivedTopLevelOrder
	s.noteService.noteList.CollapsedFolderIDs = cloudNoteList.CollapsedFolderIDs

	if err := s.noteService.saveNoteList(); err != nil {
		return fmt.Errorf("failed to save note list after pull: %w", err)
	}

	meta, err := s.driveOps.GetFileMetadata(noteListID)
	driveTs := ""
	if err == nil && meta != nil {
		driveTs = meta.ModifiedTime
	}
	noteHashes := make(map[string]string, len(cloudNoteList.Notes))
	for _, n := range cloudNoteList.Notes {
		noteHashes[n.ID] = n.ContentHash
	}
	s.syncState.ClearDirty(driveTs, noteHashes)

	s.notifySyncComplete()
	s.logger.NotifyFrontendSyncedAndReload(s.ctx)
	return nil
}

func (s *driveService) resolveConflict(noteListID string) error {
	cloudNoteList, err := s.driveSync.DownloadNoteList(s.ctx, noteListID)
	if err != nil {
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to download note list: %w", err))
	}
	if cloudNoteList == nil {
		return s.pushLocalChanges()
	}

	dirtyIDs, deletedIDs, lastSyncedHashes := s.syncState.GetDirtySnapshot()

	cloudMap := make(map[string]NoteMetadata, len(cloudNoteList.Notes))
	for _, n := range cloudNoteList.Notes {
		cloudMap[n.ID] = n
	}

	for id := range dirtyIDs {
		cloudNote, existsInCloud := cloudMap[id]
		lastHash := lastSyncedHashes[id]

		if !existsInCloud || cloudNote.ContentHash == lastHash {
			note, err := s.noteService.LoadNote(id)
			if err != nil {
				s.logger.Error(err, "Drive: failed to load dirty note %s", id)
				continue
			}
			s.logger.Info("Drive: conflict resolved - uploading local note %s (cloud unchanged)", id)
			if _, getErr := s.driveSync.GetNoteID(s.ctx, id); getErr != nil {
				if err := s.driveSync.CreateNote(s.ctx, note); err != nil {
					s.logger.Error(err, "Drive: failed to create note %s", id)
				}
			} else {
				if err := s.driveSync.UpdateNote(s.ctx, note); err != nil {
					s.logger.Error(err, "Drive: failed to update note %s", id)
				}
			}
		} else {
			localNote, err := s.noteService.LoadNote(id)
			if err != nil {
				s.logger.Error(err, "Drive: failed to load local note %s for conflict resolution", id)
				continue
			}
			if isModifiedTimeAfter(localNote.ModifiedTime, cloudNote.ModifiedTime) {
				s.logger.Info("Drive: conflict resolved - local note %s is newer, uploading", id)
				if err := s.driveSync.UpdateNote(s.ctx, localNote); err != nil {
					s.logger.Error(err, "Drive: failed to upload note %s", id)
				}
			} else {
				s.logger.Info("Drive: conflict resolved - cloud note %s is newer, downloading", id)
				downloaded, dlErr := s.driveSync.DownloadNote(s.ctx, id)
				if dlErr != nil {
					s.logger.Error(dlErr, "Drive: failed to download note %s", id)
					continue
				}
				if err := s.noteService.SaveNoteFromSync(downloaded); err != nil {
					s.logger.Error(err, "Drive: failed to save downloaded note %s", id)
				}
			}
		}
	}

	for id := range deletedIDs {
		if _, exists := cloudMap[id]; exists {
			s.logger.Info("Drive: deleting note %s from Drive (local deletion)", id)
			if err := s.driveSync.DeleteNote(s.ctx, id); err != nil {
				s.logger.Error(err, "Drive: failed to delete note %s", id)
			}
		}
	}

	localMap := make(map[string]NoteMetadata, len(s.noteService.noteList.Notes))
	for _, n := range s.noteService.noteList.Notes {
		localMap[n.ID] = n
	}
	for _, cloudNote := range cloudNoteList.Notes {
		if dirtyIDs[cloudNote.ID] || deletedIDs[cloudNote.ID] {
			continue
		}
		localNote, exists := localMap[cloudNote.ID]
		if !exists || localNote.ContentHash != cloudNote.ContentHash {
			s.logger.Info("Drive: downloading non-dirty note %s from cloud", cloudNote.ID)
			downloaded, dlErr := s.driveSync.DownloadNote(s.ctx, cloudNote.ID)
			if dlErr != nil {
				s.logger.Error(dlErr, "Drive: failed to download note %s", cloudNote.ID)
				continue
			}
			if err := s.noteService.SaveNoteFromSync(downloaded); err != nil {
				s.logger.Error(err, "Drive: failed to save note %s", cloudNote.ID)
			}
		}
	}

	for _, localNote := range s.noteService.noteList.Notes {
		if _, inCloud := cloudMap[localNote.ID]; !inCloud && !dirtyIDs[localNote.ID] && !deletedIDs[localNote.ID] {
			s.logger.Info("Drive: removing local note %s (not in cloud, not dirty)", localNote.ID)
			if err := s.noteService.DeleteNoteFromSync(localNote.ID); err != nil {
				s.logger.Error(err, "Drive: failed to remove local note %s", localNote.ID)
			}
		}
	}

	s.noteService.noteList.Folders = cloudNoteList.Folders
	s.noteService.noteList.TopLevelOrder = cloudNoteList.TopLevelOrder
	s.noteService.noteList.ArchivedTopLevelOrder = cloudNoteList.ArchivedTopLevelOrder
	s.noteService.noteList.CollapsedFolderIDs = cloudNoteList.CollapsedFolderIDs

	mergedNotes := make([]NoteMetadata, 0, len(cloudNoteList.Notes))
	cloudNoteSet := make(map[string]bool, len(cloudNoteList.Notes))
	for _, cn := range cloudNoteList.Notes {
		cloudNoteSet[cn.ID] = true
		if deletedIDs[cn.ID] {
			continue
		}
		if dirtyIDs[cn.ID] {
			if note, err := s.noteService.LoadNote(cn.ID); err == nil {
				mergedNotes = append(mergedNotes, s.noteService.buildNoteMetadata(note))
			} else {
				mergedNotes = append(mergedNotes, cn)
			}
		} else {
			mergedNotes = append(mergedNotes, cn)
		}
	}

	for id := range dirtyIDs {
		if !cloudNoteSet[id] && !deletedIDs[id] {
			if note, err := s.noteService.LoadNote(id); err == nil {
				mergedNotes = append(mergedNotes, s.noteService.buildNoteMetadata(note))
				found := false
				for _, item := range s.noteService.noteList.TopLevelOrder {
					if item.ID == id && item.Type == "note" {
						found = true
						break
					}
				}
				if !found {
					s.noteService.noteList.TopLevelOrder = append(s.noteService.noteList.TopLevelOrder, TopLevelItem{Type: "note", ID: id})
				}
			}
		}
	}
	s.noteService.noteList.Notes = mergedNotes

	if err := s.noteService.saveNoteList(); err != nil {
		return fmt.Errorf("failed to save merged note list: %w", err)
	}
	noteListID2 := s.auth.GetDriveSync().NoteListID()
	if err := s.driveSync.UpdateNoteList(s.ctx, s.noteService.noteList, noteListID2); err != nil {
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to upload note list: %w", err))
	}

	meta2, _ := s.driveOps.GetFileMetadata(noteListID2)
	driveTs := ""
	if meta2 != nil {
		driveTs = meta2.ModifiedTime
	}
	noteHashes := make(map[string]string, len(s.noteService.noteList.Notes))
	for _, n := range s.noteService.noteList.Notes {
		noteHashes[n.ID] = n.ContentHash
	}
	s.syncState.ClearDirty(driveTs, noteHashes)

	s.pollingService.RefreshChangeToken()
	s.notifySyncComplete()
	s.logger.NotifyFrontendSyncedAndReload(s.ctx)
	return nil
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
	s.logger.Info("Drive: cloud state - notes: %d", len(cloudNoteList.Notes))
	s.logger.Info("Drive: local state - notes: %d", len(localNoteList.Notes))
}

// Google Drive上に必要なフォルダ構造を作成
func (s *driveService) ensureDriveFolders() error {
	var rootID, notesID string

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
		fmt.Sprintf("name='noteList_v2.json' and '%s' in parents and trashed=false", rootID))
	if err != nil {
		return s.logger.ErrorWithNotify(err, "Drive: failed to check note list file")
	}

	if len(noteListFile) > 0 {
		s.auth.GetDriveSync().SetNoteListID(noteListFile[0].Id)
	} else {
		if err := s.driveSync.CreateNoteList(s.ctx, s.noteService.noteList); err != nil {
			return err
		}
		noteListID, err := s.driveOps.GetFileID("noteList_v2.json", notesID, rootID)
		if err != nil {
			return err
		}
		s.auth.GetDriveSync().SetNoteListID(noteListID)
	}
	return nil
}

// キューシステムを取得
func (s *driveService) GetDriveOperationsQueue() *DriveOperationsQueue {
	return s.operationsQueue
}

// driveService型にauthServiceを設定するメソッドを追加 (テスト用)
func (ds *driveService) SetAuthService(auth *authService) {
	ds.auth = auth
}
