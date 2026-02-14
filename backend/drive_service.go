package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
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

const (
	cloudWinBackupDirName       = "cloud_conflict_backups"
	maxCloudWinBackupFiles      = 100
	cloudBackupFilePrefixWins   = "cloud_wins_"
	cloudBackupFilePrefixDelete = "cloud_delete_"
)

type cloudWinBackupRecord struct {
	Reason            string        `json:"reason"`
	BackupCreatedAt   string        `json:"backupCreatedAt"`
	NoteID            string        `json:"noteId"`
	LocalModifiedTime string        `json:"localModifiedTime"`
	CloudModifiedTime string        `json:"cloudModifiedTime"`
	LocalNote         *Note         `json:"localNote"`
	CloudNote         *Note         `json:"cloudNote"`
	CloudMetadata     *NoteMetadata `json:"cloudMetadata,omitempty"`
}

type stagedCloudWinOverride struct {
	localNote *Note
	cloudMeta NoteMetadata
	cloudNote *Note
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
		s.logger.ErrorCode(err, MsgDriveErrorFolderSetup, nil)
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
		s.logger.ErrorCode(err, MsgDriveErrorNoteListSetup, nil)
		return s.auth.HandleOfflineTransition(err)
	}

	s.logger.InfoCode(MsgDriveConnected, nil)
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
	s.logger.InfoCode(MsgDriveUploading, map[string]interface{}{"noteTitle": note.Title})
	s.logger.NotifyDriveStatus(s.ctx, "syncing")
	err := s.driveSync.CreateNote(s.ctx, note)
	if err != nil {
		if strings.Contains(err.Error(), "operation cancelled") {
			s.logger.Console("Note creation was cancelled: %v", err)
			return nil
		}
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to create note: %v", err))
	}
	s.logger.InfoCode(MsgDriveUploaded, map[string]interface{}{"noteId": note.ID})
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
	s.logger.InfoCode(MsgDriveUpdating, map[string]interface{}{"noteId": note.ID})
	err := s.driveSync.UpdateNote(s.ctx, note)
	if err != nil {
		if strings.Contains(err.Error(), "operation cancelled") {
			s.logger.Console("Note update was cancelled: %v", err)
			return nil
		}
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to update note: %v", err))
	}
	s.logger.InfoCode(MsgDriveUpdated, map[string]interface{}{"noteId": note.ID})
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
	s.logger.InfoCode(MsgDriveDeletingNote, map[string]interface{}{"noteId": noteID})
	err := s.driveSync.DeleteNote(s.ctx, noteID)
	if err != nil {
		if strings.Contains(err.Error(), "operation cancelled") {
			s.logger.Console("Note deletion was cancelled: %v", err)
			return nil
		}
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to delete note from cloud"))
	}
	s.logger.InfoCode(MsgDriveDeletedNote, nil)
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
		s.logger.InfoCode(MsgDriveUploading, map[string]interface{}{"noteTitle": note.Title})
		err := s.driveSync.CreateNote(s.ctx, note)
		if err != nil {
			if strings.Contains(err.Error(), "operation cancelled") {
				return nil
			}
			return s.auth.HandleOfflineTransition(fmt.Errorf("failed to create note: %v", err))
		}
	} else {
		s.logger.InfoCode(MsgDriveUpdating, map[string]interface{}{"noteId": note.ID})
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
		s.logger.InfoCode(MsgDriveSyncFirstPush, nil)
		return s.pushLocalChanges()
	}

	meta, err := s.driveOps.GetFileMetadata(noteListID)
	if err != nil {
		s.logger.ErrorCode(err, MsgDriveErrorGetNoteListMeta, nil)
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
		s.logger.InfoCode(MsgDriveSyncPushLocalChanges, nil)
		return s.pushLocalChanges()

	case cloudChanged && !localDirty:
		s.logger.InfoCode(MsgDriveSyncPullCloudChanges, nil)
		return s.pullCloudChanges(noteListID)

	default:
		s.logger.InfoCode(MsgDriveSyncConflictDetected, nil)
		return s.resolveConflict(noteListID)
	}
}

func (s *driveService) pushLocalChanges() error {
	dirtyIDs, deletedIDs, deletedFolderIDs, _, snapshotRevision := s.syncState.GetDirtySnapshotWithRevision()
	clearSnapshotRevision := snapshotRevision
	uploadFailures := 0
	deleteFailures := 0
	uploadedHashes := make(map[string]string, len(dirtyIDs))

	for id := range dirtyIDs {
		note, err := s.noteService.LoadNote(id)
		if err != nil {
			s.logger.ErrorCode(err, MsgDriveErrorLoadDirtyNote, map[string]interface{}{"noteId": id})
			uploadFailures++
			continue
		}
		uploadedHashes[id] = computeContentHash(note)
		s.logger.InfoCode(MsgDriveSyncUploadNote, map[string]interface{}{"noteId": id})
		if _, err := s.driveSync.GetNoteID(s.ctx, id); err != nil {
			if err := s.driveSync.CreateNote(s.ctx, note); err != nil {
				s.logger.ErrorCode(err, MsgDriveErrorCreateNote, map[string]interface{}{"noteId": id})
				uploadFailures++
				continue
			}
		} else {
			if err := s.driveSync.UpdateNote(s.ctx, note); err != nil {
				s.logger.ErrorCode(err, MsgDriveErrorUpdateNote, map[string]interface{}{"noteId": id})
				uploadFailures++
				continue
			}
		}
	}

	for id := range deletedIDs {
		s.logger.InfoCode(MsgDriveSyncDeleteNote, map[string]interface{}{"noteId": id})
		if err := s.driveSync.DeleteNote(s.ctx, id); err != nil {
			if isDriveNotFoundError(err) {
				s.logger.InfoCode(MsgDriveNoteAlreadyAbsent, map[string]interface{}{"noteId": id})
				continue
			}
			s.logger.ErrorCode(err, MsgDriveErrorDeleteNote, map[string]interface{}{"noteId": id})
			deleteFailures++
		}
	}

	if uploadFailures > 0 || deleteFailures > 0 {
		s.logger.InfoCode(MsgDrivePartialPushDeferred, map[string]interface{}{"uploadFailures": uploadFailures, "deleteFailures": deleteFailures})
		s.pollingService.RefreshChangeToken()
		return nil
	}

	latestDirtyIDs, latestDeletedIDs, latestDeletedFolderIDs, _, latestRevision := s.syncState.GetDirtySnapshotWithRevision()
	if latestRevision != snapshotRevision {
		currentHashes := make(map[string]string, len(s.noteService.noteList.Notes))
		for _, n := range s.noteService.noteList.Notes {
			currentHashes[n.ID] = n.ContentHash
		}

		if hasPendingPayloadChanges(
			dirtyIDs,
			deletedIDs,
			deletedFolderIDs,
			latestDirtyIDs,
			latestDeletedIDs,
			latestDeletedFolderIDs,
			uploadedHashes,
			currentHashes,
		) {
			s.logger.InfoCode(MsgDriveDeferNoteListUpload, nil)
			s.pollingService.RefreshChangeToken()
			return nil
		}

		clearSnapshotRevision = latestRevision
		s.logger.Console("Drive: only note-list changes arrived during push; continuing note list upload")
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
		s.logger.ErrorCode(err, MsgDriveErrorGetUpdatedMeta, nil)
	}

	driveTs := ""
	if meta != nil {
		driveTs = meta.ModifiedTime
	}
	noteHashes := make(map[string]string, len(s.noteService.noteList.Notes))
	for _, n := range s.noteService.noteList.Notes {
		noteHashes[n.ID] = n.ContentHash
	}
	if !s.syncState.ClearDirtyIfUnchanged(clearSnapshotRevision, driveTs, noteHashes) {
		s.logger.Console("Sync state changed during push; retaining dirty flags for next sync")
	}

	s.pollingService.RefreshChangeToken()
	s.notifySyncComplete()
	s.logger.NotifyFrontendSyncedAndReload(s.ctx)
	return nil
}

func (s *driveService) pullCloudChanges(noteListID string) error {
	_, _, _, _, snapshotRevision := s.syncState.GetDirtySnapshotWithRevision()

	cloudNoteList, err := s.driveSync.DownloadNoteList(s.ctx, noteListID)
	if err != nil {
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to download note list: %w", err))
	}
	if cloudNoteList == nil {
		s.logger.Console("Cloud noteList is empty, nothing to download")
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
	backupEnabled := s.isCloudConflictBackupEnabled()

	downloadCount := 0
	missingCloudNoteIDs := make(map[string]bool)
	stagedDownloads := make(map[string]*Note)
	for _, cloudNote := range cloudNoteList.Notes {
		localNote, exists := localMap[cloudNote.ID]
		if !exists || localNote.ContentHash != cloudNote.ContentHash {
			s.logger.InfoCode(MsgDriveSyncDownloadNote, map[string]interface{}{"noteId": cloudNote.ID})
			note, dlErr := s.driveSync.DownloadNote(s.ctx, cloudNote.ID)
			if dlErr != nil {
				if isDriveNotFoundError(dlErr) {
					s.logger.InfoCode(MsgDriveNoteMissingRemoveList, map[string]interface{}{"noteId": cloudNote.ID})
					missingCloudNoteIDs[cloudNote.ID] = true
					continue
				}
				s.logger.ErrorCode(dlErr, MsgDriveErrorDownloadNote, map[string]interface{}{"noteId": cloudNote.ID})
				continue
			}
			stagedDownloads[cloudNote.ID] = note
			downloadCount++
			if downloadCount > 0 && downloadCount%10 == 0 {
				s.logger.NotifyFrontendSyncedAndReload(s.ctx)
			}
		}
	}

	removedMissing := filterNoteListByMissingNotes(cloudNoteList, missingCloudNoteIDs)
	if removedMissing > 0 {
		if err := s.driveSync.UpdateNoteList(s.ctx, cloudNoteList, noteListID); err != nil {
			s.logger.ErrorCode(err, MsgDriveErrorRepairCloudList, nil)
		}
	}

	cloudMap = make(map[string]NoteMetadata, len(cloudNoteList.Notes))
	for _, n := range cloudNoteList.Notes {
		cloudMap[n.ID] = n
	}

	_, _, _, _, latestRevision := s.syncState.GetDirtySnapshotWithRevision()
	if latestRevision != snapshotRevision {
		s.logger.InfoCode(MsgDriveDeferCloudApply, nil)
		s.pollingService.RefreshChangeToken()
		return nil
	}

	if len(stagedDownloads) > 0 {
		downloadIDs := make([]string, 0, len(stagedDownloads))
		for id := range stagedDownloads {
			downloadIDs = append(downloadIDs, id)
		}
		sort.Strings(downloadIDs)
		for _, id := range downloadIDs {
			if err := s.noteService.SaveNoteFromSync(stagedDownloads[id]); err != nil {
				s.logger.ErrorCode(err, MsgDriveErrorSaveDownloadedNote, map[string]interface{}{"noteId": id})
				continue
			}
		}
	}

	for _, localNote := range s.noteService.noteList.Notes {
		if _, exists := cloudMap[localNote.ID]; !exists {
			s.logger.InfoCode(MsgDriveSyncRemoveLocalDeleted, map[string]interface{}{"noteId": localNote.ID})
			if backupEnabled {
				backupPath, backupErr := s.backupLocalNoteBeforeCloudDelete(localNote.ID, "cloud-delete-during-pull")
				if backupErr != nil {
					s.logger.Console("Drive: failed to backup local note %s before cloud deletion: %v", localNote.ID, backupErr)
				} else {
					s.logger.Console("Drive: backed up local note %s before cloud deletion: %s", localNote.ID, backupPath)
				}
			}
			if err := s.noteService.DeleteNoteFromSync(localNote.ID); err != nil {
				s.logger.ErrorCode(err, MsgDriveErrorRemoveLocalNote, map[string]interface{}{"noteId": localNote.ID})
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
	if !s.syncState.ClearDirtyIfUnchanged(snapshotRevision, driveTs, noteHashes) {
		s.logger.Console("Sync state changed during pull; retaining dirty flags for next sync")
	}

	s.notifySyncComplete()
	s.logger.NotifyFrontendSyncedAndReload(s.ctx)
	return nil
}

func (s *driveService) resolveConflict(noteListID string) error {
	dirtyIDs, deletedIDs, deletedFolderIDs, lastSyncedHashes, snapshotRevision := s.syncState.GetDirtySnapshotWithRevision()
	clearSnapshotRevision := snapshotRevision
	processedDirtyHashes := make(map[string]string, len(dirtyIDs))
	backupEnabled := s.isCloudConflictBackupEnabled()

	cloudNoteList, err := s.driveSync.DownloadNoteList(s.ctx, noteListID)
	if err != nil {
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to download note list: %w", err))
	}
	if cloudNoteList == nil {
		return s.pushLocalChanges()
	}

	cloudMap := make(map[string]NoteMetadata, len(cloudNoteList.Notes))
	for _, n := range cloudNoteList.Notes {
		cloudMap[n.ID] = n
	}
	missingCloudNoteIDs := make(map[string]bool)
	uploadFailures := 0
	deleteFailures := 0
	dirtySynced := make(map[string]bool, len(dirtyIDs))
	stagedDownloads := make(map[string]*Note)
	stagedCloudWinOverrides := make(map[string]stagedCloudWinOverride)

	// ローカルで削除済みのフォルダ配下ノートは削除対象として扱う
	if len(deletedFolderIDs) > 0 {
		for _, cloudNote := range cloudNoteList.Notes {
			if deletedFolderIDs[cloudNote.FolderID] {
				deletedIDs[cloudNote.ID] = true
			}
		}
	}

	for id := range dirtyIDs {
		cloudNote, existsInCloud := cloudMap[id]
		lastHash := lastSyncedHashes[id]

		if !existsInCloud || cloudNote.ContentHash == lastHash {
			note, err := s.noteService.LoadNote(id)
			if err != nil {
				s.logger.ErrorCode(err, MsgDriveErrorLoadDirtyNote, map[string]interface{}{"noteId": id})
				uploadFailures++
				continue
			}
			s.logger.InfoCode(MsgDriveSyncUploadNote, map[string]interface{}{"noteId": id})
			if _, getErr := s.driveSync.GetNoteID(s.ctx, id); getErr != nil {
				if err := s.driveSync.CreateNote(s.ctx, note); err != nil {
					s.logger.ErrorCode(err, MsgDriveErrorCreateNote, map[string]interface{}{"noteId": id})
					uploadFailures++
					continue
				}
			} else {
				if err := s.driveSync.UpdateNote(s.ctx, note); err != nil {
					s.logger.ErrorCode(err, MsgDriveErrorUpdateNote, map[string]interface{}{"noteId": id})
					uploadFailures++
					continue
				}
			}
			processedDirtyHashes[id] = computeContentHash(note)
			dirtySynced[id] = true
		} else {
			localNote, err := s.noteService.LoadNote(id)
			if err != nil {
				s.logger.ErrorCode(err, MsgDriveErrorLoadLocalForConflict, map[string]interface{}{"noteId": id})
				uploadFailures++
				continue
			}
			if isModifiedTimeAfter(localNote.ModifiedTime, cloudNote.ModifiedTime) {
				s.logger.InfoCode(MsgDriveConflictKeepLocal, map[string]interface{}{"noteId": id})
				if err := s.driveSync.UpdateNote(s.ctx, localNote); err != nil {
					s.logger.ErrorCode(err, MsgDriveErrorUploadNote, map[string]interface{}{"noteId": id})
					uploadFailures++
				} else {
					processedDirtyHashes[id] = computeContentHash(localNote)
				}
			} else {
				s.logger.InfoCode(MsgDriveConflictKeepCloud, map[string]interface{}{"noteId": id})
				downloaded, dlErr := s.driveSync.DownloadNote(s.ctx, id)
				if dlErr != nil {
					if isDriveNotFoundError(dlErr) {
						s.logger.InfoCode(MsgDriveNoteMissingUploadLocal, map[string]interface{}{"noteId": id})
						if err := s.driveSync.CreateNote(s.ctx, localNote); err != nil {
							s.logger.ErrorCode(err, MsgDriveErrorRecreateMissingNote, map[string]interface{}{"noteId": id})
							missingCloudNoteIDs[id] = true
							uploadFailures++
							continue
						}
						processedDirtyHashes[id] = computeContentHash(localNote)
						dirtySynced[id] = true
						continue
					}
					s.logger.ErrorCode(dlErr, MsgDriveErrorDownloadNote, map[string]interface{}{"noteId": id})
					uploadFailures++
					continue
				}

				if backupEnabled {
					stagedCloudWinOverrides[id] = stagedCloudWinOverride{
						localNote: localNote,
						cloudMeta: cloudNote,
						cloudNote: downloaded,
					}
				}
				stagedDownloads[id] = downloaded
				processedDirtyHashes[id] = computeContentHash(downloaded)
				dirtySynced[id] = true
			}
		}
	}

	for id := range deletedIDs {
		if _, exists := cloudMap[id]; exists {
			s.logger.InfoCode(MsgDriveSyncDeleteNote, map[string]interface{}{"noteId": id})
			if err := s.driveSync.DeleteNote(s.ctx, id); err != nil {
				if isDriveNotFoundError(err) {
					s.logger.InfoCode(MsgDriveNoteAlreadyAbsent, map[string]interface{}{"noteId": id})
					continue
				}
				s.logger.ErrorCode(err, MsgDriveErrorDeleteNote, map[string]interface{}{"noteId": id})
				deleteFailures++
			}
		}
	}

	localMap := make(map[string]NoteMetadata, len(s.noteService.noteList.Notes))
	for _, n := range s.noteService.noteList.Notes {
		localMap[n.ID] = n
	}
	localFoldersSnapshot := append([]Folder(nil), s.noteService.noteList.Folders...)
	localTopLevelSnapshot := append([]TopLevelItem(nil), s.noteService.noteList.TopLevelOrder...)
	localArchivedTopLevelSnapshot := append([]TopLevelItem(nil), s.noteService.noteList.ArchivedTopLevelOrder...)
	localCollapsedFolderSnapshot := append([]string(nil), s.noteService.noteList.CollapsedFolderIDs...)
	for _, cloudNote := range cloudNoteList.Notes {
		if dirtyIDs[cloudNote.ID] || deletedIDs[cloudNote.ID] {
			continue
		}
		localNote, exists := localMap[cloudNote.ID]
		if !exists || localNote.ContentHash != cloudNote.ContentHash {
			s.logger.InfoCode(MsgDriveSyncDownloadRemoteNote, map[string]interface{}{"noteId": cloudNote.ID})
			downloaded, dlErr := s.driveSync.DownloadNote(s.ctx, cloudNote.ID)
			if dlErr != nil {
				if isDriveNotFoundError(dlErr) {
					s.logger.InfoCode(MsgDriveNoteMissingRemoveList, map[string]interface{}{"noteId": cloudNote.ID})
					missingCloudNoteIDs[cloudNote.ID] = true
					continue
				}
				s.logger.ErrorCode(dlErr, MsgDriveErrorDownloadNote, map[string]interface{}{"noteId": cloudNote.ID})
				continue
			}
			stagedDownloads[cloudNote.ID] = downloaded
		}
	}

	filterNoteListByMissingNotes(cloudNoteList, missingCloudNoteIDs)
	cloudMap = make(map[string]NoteMetadata, len(cloudNoteList.Notes))
	for _, n := range cloudNoteList.Notes {
		cloudMap[n.ID] = n
	}

	latestDirtyIDs, latestDeletedIDs, latestDeletedFolderIDs, _, latestRevision := s.syncState.GetDirtySnapshotWithRevision()
	if latestRevision != snapshotRevision {
		currentHashes := make(map[string]string, len(s.noteService.noteList.Notes))
		for _, n := range s.noteService.noteList.Notes {
			currentHashes[n.ID] = n.ContentHash
		}

		if hasPendingPayloadChanges(
			dirtyIDs,
			deletedIDs,
			deletedFolderIDs,
			latestDirtyIDs,
			latestDeletedIDs,
			latestDeletedFolderIDs,
			processedDirtyHashes,
			currentHashes,
		) {
			s.logger.InfoCode(MsgDriveDeferConflictMerge, nil)
			s.pollingService.RefreshChangeToken()
			return nil
		}

		clearSnapshotRevision = latestRevision
		s.logger.Console("Drive: only note-list changes arrived during conflict resolution; continuing merge")
	}

	if len(stagedDownloads) > 0 {
		downloadIDs := make([]string, 0, len(stagedDownloads))
		for id := range stagedDownloads {
			downloadIDs = append(downloadIDs, id)
		}
		sort.Strings(downloadIDs)
		for _, id := range downloadIDs {
			if backupEnabled {
				if override, ok := stagedCloudWinOverrides[id]; ok {
					backupPath, backupErr := s.backupLocalNoteBeforeCloudOverride(
						override.localNote,
						override.cloudMeta,
						override.cloudNote,
					)
					if backupErr != nil {
						s.logger.Console("Drive: failed to backup local note %s before cloud overwrite: %v", id, backupErr)
					} else {
						s.logger.Console("Drive: backed up local note %s before cloud overwrite: %s", id, backupPath)
					}
				}
			}

			if err := s.noteService.SaveNoteFromSync(stagedDownloads[id]); err != nil {
				s.logger.ErrorCode(err, MsgDriveErrorSaveDownloadedNote, map[string]interface{}{"noteId": id})
				uploadFailures++
				continue
			}
		}
	}

	for _, localNote := range s.noteService.noteList.Notes {
		if _, inCloud := cloudMap[localNote.ID]; !inCloud && !dirtyIDs[localNote.ID] && !deletedIDs[localNote.ID] {
			s.logger.InfoCode(MsgDriveSyncRemoveLocalDeleted, map[string]interface{}{"noteId": localNote.ID})
			if backupEnabled {
				backupPath, backupErr := s.backupLocalNoteBeforeCloudDelete(localNote.ID, "cloud-delete-during-conflict-merge")
				if backupErr != nil {
					s.logger.Console("Drive: failed to backup local note %s before cloud deletion: %v", localNote.ID, backupErr)
				} else {
					s.logger.Console("Drive: backed up local note %s before cloud deletion: %s", localNote.ID, backupPath)
				}
			}
			if err := s.noteService.DeleteNoteFromSync(localNote.ID); err != nil {
				s.logger.ErrorCode(err, MsgDriveErrorRemoveLocalNote, map[string]interface{}{"noteId": localNote.ID})
			}
		}
	}

	filteredFolders := make([]Folder, 0, len(cloudNoteList.Folders))
	for _, folder := range cloudNoteList.Folders {
		if deletedFolderIDs[folder.ID] {
			continue
		}
		filteredFolders = append(filteredFolders, folder)
	}
	s.noteService.noteList.Folders = filteredFolders

	filteredTopLevelOrder := make([]TopLevelItem, 0, len(cloudNoteList.TopLevelOrder))
	for _, item := range cloudNoteList.TopLevelOrder {
		if item.Type == "folder" && deletedFolderIDs[item.ID] {
			continue
		}
		if item.Type == "note" && deletedIDs[item.ID] {
			continue
		}
		filteredTopLevelOrder = append(filteredTopLevelOrder, item)
	}
	s.noteService.noteList.TopLevelOrder = filteredTopLevelOrder

	filteredArchivedTopLevelOrder := make([]TopLevelItem, 0, len(cloudNoteList.ArchivedTopLevelOrder))
	for _, item := range cloudNoteList.ArchivedTopLevelOrder {
		if item.Type == "folder" && deletedFolderIDs[item.ID] {
			continue
		}
		if item.Type == "note" && deletedIDs[item.ID] {
			continue
		}
		filteredArchivedTopLevelOrder = append(filteredArchivedTopLevelOrder, item)
	}
	s.noteService.noteList.ArchivedTopLevelOrder = filteredArchivedTopLevelOrder
	s.noteService.noteList.CollapsedFolderIDs = cloudNoteList.CollapsedFolderIDs

	mergedNotes := make([]NoteMetadata, 0, len(cloudNoteList.Notes))
	cloudNoteSet := make(map[string]bool, len(cloudNoteList.Notes))
	for _, cn := range cloudNoteList.Notes {
		cloudNoteSet[cn.ID] = true
		if deletedIDs[cn.ID] {
			continue
		}
		if dirtyIDs[cn.ID] {
			if !dirtySynced[cn.ID] {
				if localMeta, ok := localMap[cn.ID]; ok {
					mergedNotes = append(mergedNotes, localMeta)
				} else {
					mergedNotes = append(mergedNotes, cn)
				}
				continue
			}
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
			if !dirtySynced[id] {
				if localMeta, ok := localMap[id]; ok {
					mergedNotes = append(mergedNotes, localMeta)
					if localMeta.FolderID == "" {
						placeTopLevelItemUsingLocalSnapshot(
							localTopLevelSnapshot,
							localArchivedTopLevelSnapshot,
							&s.noteService.noteList.TopLevelOrder,
							&s.noteService.noteList.ArchivedTopLevelOrder,
							localMeta,
						)
					}
				}
				continue
			}
			if note, err := s.noteService.LoadNote(id); err == nil {
				localMeta := s.noteService.buildNoteMetadata(note)
				mergedNotes = append(mergedNotes, localMeta)
				if localMeta.FolderID == "" {
					placeTopLevelItemUsingLocalSnapshot(
						localTopLevelSnapshot,
						localArchivedTopLevelSnapshot,
						&s.noteService.noteList.TopLevelOrder,
						&s.noteService.noteList.ArchivedTopLevelOrder,
						localMeta,
					)
				}
			}
		}
	}
	s.noteService.noteList.Notes = mergedNotes
	s.noteService.noteList.Notes = applyLocalStructureForUnchangedNotes(s.noteService.noteList.Notes, localMap)
	s.noteService.noteList.Folders = mergeFoldersPreferLocal(localFoldersSnapshot, filteredFolders, deletedFolderIDs)
	s.noteService.noteList.TopLevelOrder = mergeTopLevelOrderPreferLocal(
		localTopLevelSnapshot,
		s.noteService.noteList.TopLevelOrder,
		s.noteService.noteList.Notes,
		s.noteService.noteList.Folders,
		false,
	)
	s.noteService.noteList.ArchivedTopLevelOrder = mergeTopLevelOrderPreferLocal(
		localArchivedTopLevelSnapshot,
		s.noteService.noteList.ArchivedTopLevelOrder,
		s.noteService.noteList.Notes,
		s.noteService.noteList.Folders,
		true,
	)
	s.noteService.noteList.CollapsedFolderIDs = mergeCollapsedFolderIDsPreferLocal(
		localCollapsedFolderSnapshot,
		cloudNoteList.CollapsedFolderIDs,
		s.noteService.noteList.Folders,
	)

	if uploadFailures > 0 || deleteFailures > 0 {
		s.logger.InfoCode(MsgDrivePartialConflictDeferred, map[string]interface{}{"uploadFailures": uploadFailures, "deleteFailures": deleteFailures})
		if err := s.noteService.saveNoteList(); err != nil {
			return fmt.Errorf("failed to save merged note list: %w", err)
		}
		s.pollingService.RefreshChangeToken()
		s.logger.NotifyFrontendSyncedAndReload(s.ctx)
		return nil
	}

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
	if !s.syncState.ClearDirtyIfUnchanged(clearSnapshotRevision, driveTs, noteHashes) {
		s.logger.Console("Sync state changed during conflict resolution; retaining dirty flags for next sync")
	}

	s.pollingService.RefreshChangeToken()
	s.notifySyncComplete()
	s.logger.NotifyFrontendSyncedAndReload(s.ctx)
	return nil
}

func isDriveNotFoundError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "not found")
}

func (s *driveService) isCloudConflictBackupEnabled() bool {
	settingsPath := filepath.Join(s.appDataDir, "settings.json")
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		return true
	}
	var payload struct {
		EnableConflictBackup *bool `json:"enableConflictBackup"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return true
	}
	if payload.EnableConflictBackup == nil {
		return true
	}
	return *payload.EnableConflictBackup
}

func (s *driveService) backupLocalNoteBeforeCloudOverride(localNote *Note, cloudMeta NoteMetadata, cloudNote *Note) (string, error) {
	if localNote == nil {
		return "", fmt.Errorf("local note is nil")
	}
	if cloudNote == nil {
		return "", fmt.Errorf("cloud note is nil")
	}

	record := cloudWinBackupRecord{
		Reason:            "cloud-wins-conflict",
		BackupCreatedAt:   time.Now().UTC().Format(time.RFC3339Nano),
		NoteID:            localNote.ID,
		LocalModifiedTime: localNote.ModifiedTime,
		CloudModifiedTime: cloudMeta.ModifiedTime,
		LocalNote:         localNote,
		CloudNote:         cloudNote,
		CloudMetadata:     &cloudMeta,
	}
	return s.writeCloudConflictBackup(record, cloudBackupFilePrefixWins)
}

func (s *driveService) backupLocalNoteBeforeCloudDelete(noteID string, reason string) (string, error) {
	localNote, err := s.noteService.LoadNote(noteID)
	if err != nil {
		return "", fmt.Errorf("failed to load local note %s: %w", noteID, err)
	}
	record := cloudWinBackupRecord{
		Reason:            reason,
		BackupCreatedAt:   time.Now().UTC().Format(time.RFC3339Nano),
		NoteID:            localNote.ID,
		LocalModifiedTime: localNote.ModifiedTime,
		LocalNote:         localNote,
	}
	return s.writeCloudConflictBackup(record, cloudBackupFilePrefixDelete)
}

func (s *driveService) writeCloudConflictBackup(record cloudWinBackupRecord, filePrefix string) (string, error) {
	if record.NoteID == "" {
		return "", fmt.Errorf("note id is empty")
	}
	if strings.TrimSpace(s.appDataDir) == "" {
		return "", fmt.Errorf("app data dir is empty")
	}

	backupDir := filepath.Join(s.appDataDir, cloudWinBackupDirName)
	if err := os.MkdirAll(backupDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create backup directory: %w", err)
	}

	data, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return "", fmt.Errorf("failed to marshal backup record: %w", err)
	}

	fileName := fmt.Sprintf("%s%s_%s.json", filePrefix, time.Now().UTC().Format("20060102T150405.000000000Z"), record.NoteID)
	backupPath := filepath.Join(backupDir, fileName)
	tmpPath := backupPath + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return "", fmt.Errorf("failed to write backup temp file: %w", err)
	}
	if err := os.Rename(tmpPath, backupPath); err != nil {
		_ = os.Remove(tmpPath)
		return "", fmt.Errorf("failed to finalize backup file: %w", err)
	}

	if err := pruneCloudConflictBackups(backupDir, maxCloudWinBackupFiles); err != nil {
		return backupPath, fmt.Errorf("failed to prune backup files: %w", err)
	}

	return backupPath, nil
}

type backupFileInfo struct {
	path    string
	name    string
	modTime time.Time
}

func pruneCloudConflictBackups(backupDir string, maxFiles int) error {
	if maxFiles <= 0 {
		return nil
	}

	entries, err := os.ReadDir(backupDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	files := make([]backupFileInfo, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !isCloudConflictBackupFile(name) {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			continue
		}
		files = append(files, backupFileInfo{
			path:    filepath.Join(backupDir, name),
			name:    name,
			modTime: info.ModTime(),
		})
	}

	if len(files) <= maxFiles {
		return nil
	}

	sort.Slice(files, func(i, j int) bool {
		if files[i].modTime.Equal(files[j].modTime) {
			return files[i].name < files[j].name
		}
		return files[i].modTime.Before(files[j].modTime)
	})

	removeCount := len(files) - maxFiles
	for i := 0; i < removeCount; i++ {
		if err := os.Remove(files[i].path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func isCloudConflictBackupFile(name string) bool {
	if !strings.HasSuffix(name, ".json") {
		return false
	}
	return strings.HasPrefix(name, cloudBackupFilePrefixWins) || strings.HasPrefix(name, cloudBackupFilePrefixDelete)
}

func isSameBoolSet(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for key := range a {
		if !b[key] {
			return false
		}
	}
	return true
}

func placeTopLevelItemUsingLocalSnapshot(
	localTopLevelSnapshot []TopLevelItem,
	localArchivedTopLevelSnapshot []TopLevelItem,
	currentTopLevelOrder *[]TopLevelItem,
	currentArchivedTopLevelOrder *[]TopLevelItem,
	localMeta NoteMetadata,
) {
	if localMeta.FolderID != "" {
		return
	}

	targetItem := TopLevelItem{Type: "note", ID: localMeta.ID}
	targetOrder := currentTopLevelOrder
	snapshot := localTopLevelSnapshot
	if localMeta.Archived {
		targetOrder = currentArchivedTopLevelOrder
		snapshot = localArchivedTopLevelSnapshot
	}

	insertTopLevelItemPreservingLocalPlacement(snapshot, targetOrder, targetItem)
}

func insertTopLevelItemPreservingLocalPlacement(
	localSnapshot []TopLevelItem,
	currentOrder *[]TopLevelItem,
	item TopLevelItem,
) {
	if currentOrder == nil {
		return
	}
	if topLevelItemIndex(*currentOrder, item) != -1 {
		return
	}

	localIndex := topLevelItemIndex(localSnapshot, item)
	if localIndex == -1 {
		*currentOrder = append(*currentOrder, item)
		return
	}

	for i := localIndex - 1; i >= 0; i-- {
		anchorIndex := topLevelItemIndex(*currentOrder, localSnapshot[i])
		if anchorIndex != -1 {
			*currentOrder = insertTopLevelItemAt(*currentOrder, anchorIndex+1, item)
			return
		}
	}

	for i := localIndex + 1; i < len(localSnapshot); i++ {
		anchorIndex := topLevelItemIndex(*currentOrder, localSnapshot[i])
		if anchorIndex != -1 {
			*currentOrder = insertTopLevelItemAt(*currentOrder, anchorIndex, item)
			return
		}
	}

	if localIndex == 0 {
		*currentOrder = insertTopLevelItemAt(*currentOrder, 0, item)
		return
	}

	*currentOrder = append(*currentOrder, item)
}

func insertTopLevelItemAt(order []TopLevelItem, index int, item TopLevelItem) []TopLevelItem {
	if index < 0 {
		index = 0
	}
	if index > len(order) {
		index = len(order)
	}
	order = append(order, TopLevelItem{})
	copy(order[index+1:], order[index:])
	order[index] = item
	return order
}

func topLevelItemIndex(order []TopLevelItem, target TopLevelItem) int {
	for i, item := range order {
		if item.Type == target.Type && item.ID == target.ID {
			return i
		}
	}
	return -1
}

func applyLocalStructureForUnchangedNotes(mergedNotes []NoteMetadata, localMap map[string]NoteMetadata) []NoteMetadata {
	result := make([]NoteMetadata, len(mergedNotes))
	copy(result, mergedNotes)

	for i := range result {
		localMeta, ok := localMap[result[i].ID]
		if !ok {
			continue
		}
		if localMeta.ContentHash != result[i].ContentHash {
			continue
		}

		result[i].FolderID = localMeta.FolderID
		result[i].Archived = localMeta.Archived
	}

	return result
}

func mergeFoldersPreferLocal(localFolders []Folder, cloudFolders []Folder, deletedFolderIDs map[string]bool) []Folder {
	mergedByID := make(map[string]Folder, len(localFolders)+len(cloudFolders))

	for _, folder := range cloudFolders {
		if deletedFolderIDs[folder.ID] {
			continue
		}
		mergedByID[folder.ID] = folder
	}
	for _, folder := range localFolders {
		if deletedFolderIDs[folder.ID] {
			continue
		}
		mergedByID[folder.ID] = folder
	}

	result := make([]Folder, 0, len(mergedByID))
	added := make(map[string]bool, len(mergedByID))
	for _, folder := range localFolders {
		merged, ok := mergedByID[folder.ID]
		if !ok || added[folder.ID] {
			continue
		}
		result = append(result, merged)
		added[folder.ID] = true
	}
	for _, folder := range cloudFolders {
		merged, ok := mergedByID[folder.ID]
		if !ok || added[folder.ID] {
			continue
		}
		result = append(result, merged)
		added[folder.ID] = true
	}

	return result
}

func mergeTopLevelOrderPreferLocal(
	localOrder []TopLevelItem,
	cloudOrder []TopLevelItem,
	notes []NoteMetadata,
	folders []Folder,
	archived bool,
) []TopLevelItem {
	noteMap := make(map[string]NoteMetadata, len(notes))
	for _, note := range notes {
		noteMap[note.ID] = note
	}
	folderMap := make(map[string]Folder, len(folders))
	for _, folder := range folders {
		folderMap[folder.ID] = folder
	}

	isValid := func(item TopLevelItem) bool {
		switch item.Type {
		case "note":
			note, ok := noteMap[item.ID]
			if !ok {
				return false
			}
			return note.FolderID == "" && note.Archived == archived
		case "folder":
			folder, ok := folderMap[item.ID]
			if !ok {
				return false
			}
			return folder.Archived == archived
		default:
			return false
		}
	}

	result := make([]TopLevelItem, 0, len(localOrder)+len(cloudOrder))
	seen := make(map[string]bool, len(localOrder)+len(cloudOrder))
	appendIfValid := func(item TopLevelItem) {
		key := item.Type + ":" + item.ID
		if seen[key] || !isValid(item) {
			return
		}
		result = append(result, item)
		seen[key] = true
	}

	for _, item := range localOrder {
		appendIfValid(item)
	}
	for _, item := range cloudOrder {
		appendIfValid(item)
	}
	for _, note := range notes {
		if note.FolderID != "" || note.Archived != archived {
			continue
		}
		appendIfValid(TopLevelItem{Type: "note", ID: note.ID})
	}
	for _, folder := range folders {
		if folder.Archived != archived {
			continue
		}
		appendIfValid(TopLevelItem{Type: "folder", ID: folder.ID})
	}

	return result
}

func mergeCollapsedFolderIDsPreferLocal(localCollapsed []string, cloudCollapsed []string, folders []Folder) []string {
	validFolderIDs := make(map[string]bool, len(folders))
	for _, folder := range folders {
		validFolderIDs[folder.ID] = true
	}

	result := make([]string, 0, len(localCollapsed)+len(cloudCollapsed))
	seen := make(map[string]bool, len(localCollapsed)+len(cloudCollapsed))
	appendIfValid := func(folderID string) {
		if !validFolderIDs[folderID] || seen[folderID] {
			return
		}
		result = append(result, folderID)
		seen[folderID] = true
	}

	for _, folderID := range localCollapsed {
		appendIfValid(folderID)
	}
	for _, folderID := range cloudCollapsed {
		appendIfValid(folderID)
	}

	return result
}

func hasPendingPayloadChanges(
	snapshotDirtyIDs map[string]bool,
	snapshotDeletedIDs map[string]bool,
	snapshotDeletedFolderIDs map[string]bool,
	latestDirtyIDs map[string]bool,
	latestDeletedIDs map[string]bool,
	latestDeletedFolderIDs map[string]bool,
	uploadedHashes map[string]string,
	currentHashes map[string]string,
) bool {
	if !isSameBoolSet(snapshotDirtyIDs, latestDirtyIDs) {
		return true
	}
	if !isSameBoolSet(snapshotDeletedIDs, latestDeletedIDs) {
		return true
	}
	if !isSameBoolSet(snapshotDeletedFolderIDs, latestDeletedFolderIDs) {
		return true
	}

	for id := range snapshotDirtyIDs {
		uploadedHash, ok := uploadedHashes[id]
		if !ok {
			return true
		}
		currentHash, ok := currentHashes[id]
		if !ok {
			return true
		}
		if currentHash != uploadedHash {
			return true
		}
	}
	return false
}

func filterNoteListByMissingNotes(noteList *NoteList, missingNoteIDs map[string]bool) int {
	if noteList == nil || len(missingNoteIDs) == 0 {
		return 0
	}

	removed := 0
	filteredNotes := make([]NoteMetadata, 0, len(noteList.Notes))
	for _, note := range noteList.Notes {
		if missingNoteIDs[note.ID] {
			removed++
			continue
		}
		filteredNotes = append(filteredNotes, note)
	}
	noteList.Notes = filteredNotes

	filteredTopLevel := make([]TopLevelItem, 0, len(noteList.TopLevelOrder))
	for _, item := range noteList.TopLevelOrder {
		if item.Type == "note" && missingNoteIDs[item.ID] {
			continue
		}
		filteredTopLevel = append(filteredTopLevel, item)
	}
	noteList.TopLevelOrder = filteredTopLevel

	filteredArchivedTopLevel := make([]TopLevelItem, 0, len(noteList.ArchivedTopLevelOrder))
	for _, item := range noteList.ArchivedTopLevelOrder {
		if item.Type == "note" && missingNoteIDs[item.ID] {
			continue
		}
		filteredArchivedTopLevel = append(filteredArchivedTopLevel, item)
	}
	noteList.ArchivedTopLevelOrder = filteredArchivedTopLevel

	return removed
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
		s.logger.ErrorCode(err, MsgDriveErrorIntegrityCheck, nil)
	}
	if s.operationsQueue != nil && s.operationsQueue.HasItems() {
		s.logger.Console("Drive: upload queue active")
		s.logger.NotifyDriveStatus(s.ctx, "syncing")
	} else {
		s.logger.Console("Sync status is up to date")
		s.logger.NotifyDriveStatus(s.ctx, "synced")
	}
}

// 同期の前後のステータスログ
func (s *driveService) logSyncStatus(cloudNoteList, localNoteList *NoteList) {
	s.logger.Console("Drive: cloud state - notes: %d", len(cloudNoteList.Notes))
	s.logger.Console("Drive: local state - notes: %d", len(localNoteList.Notes))
}

// Google Drive上に必要なフォルダ構造を作成
func (s *driveService) ensureDriveFolders() error {
	var rootID, notesID string

	rootFolders, err := s.driveOps.ListFiles(
		"name='monaco-notepad' and mimeType='application/vnd.google-apps.folder' and trashed=false")
	if err != nil {
		return s.logger.ErrorWithNotifyCode(err, MsgDriveErrorCheckRootFolder, nil)
	}

	if len(rootFolders) == 0 {
		rootID, err = s.driveOps.CreateFolder("monaco-notepad", "")
		if err != nil {
			return s.logger.ErrorWithNotifyCode(err, MsgDriveErrorCreateRootFolder, nil)
		}
	} else {
		rootID = rootFolders[0].Id
	}

	notesFolders, err := s.driveOps.ListFiles(
		fmt.Sprintf("name='notes' and '%s' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false",
			rootID))
	if err != nil {
		return s.logger.ErrorWithNotifyCode(err, MsgDriveErrorCheckNotesFolder, nil)
	}

	if len(notesFolders) == 0 {
		notesID, err = s.driveOps.CreateFolder("notes", rootID)
		if err != nil {
			return s.logger.ErrorWithNotifyCode(err, MsgDriveErrorCreateNotesFolder, nil)
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
		return s.logger.ErrorWithNotifyCode(err, MsgDriveErrorCheckNoteListFile, nil)
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
