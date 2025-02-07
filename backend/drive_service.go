package backend

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"google.golang.org/api/drive/v3"
)

// Google Drive関連の操作を提供するインターフェース
// 認証まわりのメソッドも含めていますが、実際の実装は drive_auth_service.go に委譲されます。
// こちら（drive_service.go）には同期やファイルアップロード関連のビジネスロジックを中心に実装。
type DriveService interface {
	// ---- 認証系 ----
	InitializeDrive() error
	AuthorizeDrive() error
	LogoutDrive() error
	CancelLoginDrive() error

	// ---- ノート同期系 ----
	UploadNote(note *Note) error
	DeleteNoteDrive(noteID string) error
	SyncNotes() error
	UploadNoteList() error

	// ---- その他ユーティリティ ----
	NotifyFrontendReady()
	IsConnected() bool
	IsTestMode() bool
}

// driveService はDriveServiceインターフェースの実装。
// 認証に関しては内部の authService を用いて実装し、同期ロジックをここに残す。
type driveService struct {
	ctx              context.Context
	auth             *driveAuthService
	noteService      *noteService
	appDataDir       string
	notesDir         string
	resetPollingChan chan struct{}
	logger           DriveLogger
	driveOps         DriveOperations
}

// NewDriveService は新しいdriveServiceインスタンスを作成します
func NewDriveService(
	ctx context.Context,
	appDataDir string,
	notesDir string,
	noteService *noteService,
	credentials []byte,
) DriveService {
	logger := NewDriveLogger(ctx, false)
	authService := NewDriveAuthService(
		ctx,
		appDataDir,
		notesDir,
		noteService,
		credentials,
		false,
	)

	return &driveService{
		ctx:         ctx,
		auth:        authService,
		noteService: noteService,
		appDataDir:  appDataDir,
		notesDir:    notesDir,
		logger:      logger,
		driveOps:    nil,
	}
}

// ------------------------------------------------------------
// 認証まわりのラッパメソッド
// ------------------------------------------------------------

// InitializeDrive はGoogle Drive APIの初期化を行う
func (s *driveService) InitializeDrive() error {
	// 保存済みトークンでの初期化を試行
	if err := s.auth.InitializeWithSavedToken(); err != nil {
		return s.logger.ErrorWithNotify(err, "Failed to initialize Drive API")
	}

	// 接続成功時の処理
	if s.IsConnected() {
		s.driveOps = NewDriveOperations(s.auth.GetDriveSync().service)
		if err := s.ensureDriveFolders(); err != nil {
			return s.logger.ErrorWithNotify(err, "Failed to ensure drive folders")
		}
		go s.waitForFrontendAndStartSync()
	}
	return nil
}

// AuthorizeDrive はGoogle Driveの手動認証フローを開始
func (s *driveService) AuthorizeDrive() error {
	if err := s.auth.StartManualAuth(); err != nil {
		return s.logger.ErrorWithNotify(err, "Failed to complete authentication")
	}

	// 接続成功時の処理
	if s.IsConnected() {
		s.driveOps = NewDriveOperations(s.auth.GetDriveSync().service)
		if err := s.ensureDriveFolders(); err != nil {
			return s.logger.ErrorWithNotify(err, "Failed to ensure drive folders")
		}
		go s.waitForFrontendAndStartSync()
	}
	return nil
}

// LogoutDrive はGoogle Driveからログアウト
func (s *driveService) LogoutDrive() error {
	s.logger.Info("Logging out of Google Drive...")
	return s.auth.LogoutDrive()
}

// CancelLoginDrive は認証をキャンセル
func (s *driveService) CancelLoginDrive() error {
	return s.auth.CancelLoginDrive()
}

// NotifyFrontendReady はフロントエンド準備完了を通知
func (s *driveService) NotifyFrontendReady() {
	s.auth.NotifyFrontendReady()
}

// IsConnected は接続状態を返す
func (s *driveService) IsConnected() bool {
	return s.auth.driveSync.isConnected
}

// IsTestMode はテストモードかどうかを返す
func (s *driveService) IsTestMode() bool {
	return s.auth != nil && s.auth.IsTestMode()
}

// ------------------------------------------------------------
// 同期系のビジネスロジック
// ------------------------------------------------------------

// waitForFrontendAndStartSync はフロントエンドの準備完了を待ってから同期開始
func (s *driveService) waitForFrontendAndStartSync() {
	<-s.auth.GetFrontendReadyChan() // フロントエンドが ready になるまでブロック
	s.logger.Info("Frontend ready - starting sync...")

	// 接続状態を通知
	s.driveOps.notifyDriveStatus(s.ctx, "synced", s.IsTestMode())

	// 初回同期フラグをチェック
	hasCompletedInitialSync, err := s.driveOps.checkInitialSyncFlag(s.appDataDir)
	if err != nil {
		s.logger.Error(err, "Failed to check initial sync flag")
		s.auth.HandleOfflineTransition(err)
		return
	}

  // 初回同期フラグがない場合は初回同期を行う
	if !hasCompletedInitialSync {
		s.logger.Info("First time initialization - performing initial sync...")
		if err := s.performInitialSync(); err != nil {
			s.logger.Error(err, "Initial sync failed")
			s.auth.HandleOfflineTransition(err)
			return
		}

		// 初回同期完了フラグを保存
		if err := s.driveOps.saveInitialSyncFlag(s.appDataDir); err != nil {
			s.logger.Error(err, "Failed to save initial sync flag")
			s.auth.HandleOfflineTransition(err)
			return
		}
		s.auth.driveSync.hasCompletedInitialSync = true
	} else {
		s.auth.driveSync.hasCompletedInitialSync = true
	}

	// 少し待機の後にポーリング開始
	time.Sleep(1 * time.Second)
	s.startSyncPolling()
}

// 初回接続時のマージ処理を実行
func (s *driveService) performInitialSync() error {
	s.logger.Info("Starting initial sync...")

	// クラウドのノートリストを取得
	s.logger.Info("Checking cloud note list...")
	cloudNoteList, err := s.fetchCloudNoteList()
	if err != nil {
		s.logger.Error(err, "Failed to fetch cloud note list")
		s.auth.HandleOfflineTransition(err)
		return err
	}

	// クラウドにノートリストがない場合は全ノートをアップロード
	if cloudNoteList == nil {
		s.logger.Info("Uploading local notes to cloud...")
		return s.uploadAllNotes()
	}

	s.logger.Info(fmt.Sprintf("Found %d notes in cloud", len(cloudNoteList.Notes)))
	s.logger.Info(fmt.Sprintf("Found %d notes locally", len(s.noteService.noteList.Notes)))

	// ノートのマージ処理
	mergedNotes, err := s.driveOps.mergeNotes(
		s.ctx,
		s.noteService.noteList.Notes,
		cloudNoteList.Notes,
		s.downloadNote,
		s.UploadNote,
		s.noteService.LoadNote,
	)
	if err != nil {
		s.logger.Error(err, "Failed to merge notes")
		s.auth.HandleOfflineTransition(err)
		return err
	}

	s.logger.Info("Saving merged note list...")
	s.noteService.noteList.Notes = mergedNotes
	s.noteService.noteList.LastSync = time.Now()
	if err := s.noteService.saveNoteList(); err != nil {
		s.logger.Error(err, "Failed to save merged note list")
		s.auth.HandleOfflineTransition(err)
		return fmt.Errorf("failed to save merged note list: %v", err)
	}

	s.logger.Info("Initial sync completed")

	// フロントエンドに変更を通知
	s.driveOps.notifyFrontendChanges(s.ctx, s.IsTestMode())

	return nil
}

// Google Driveとのポーリング監視を開始
func (s *driveService) startSyncPolling() {
	const (
		initialInterval = 30 * time.Second
		maxInterval     = 5 * time.Minute
		factor          = 1.5
	)

	interval := initialInterval
	lastChangeTime := time.Now()
	s.resetPollingChan = make(chan struct{}, 1)

  // まず１回同期を行う
  if err := s.SyncNotes(); err != nil {
    s.logger.Error(err, "Error syncing with Drive")
  }

	for {
		if !s.IsConnected() {
			time.Sleep(initialInterval)
			continue
		}

		// 同期開始を通知
		if !s.IsTestMode() {
			wailsRuntime.EventsEmit(s.ctx, "drive:status", "syncing")
		}

		// 重複ファイルの削除
		if err := s.cleanDuplicateNoteFiles(); err != nil {
			s.logger.Error(err, "Failed to clean duplicate note files")
		}

		// 変更が検出された場合
		if s.noteService.noteList.LastSync.After(lastChangeTime) {
			interval = initialInterval
			lastChangeTime = s.noteService.noteList.LastSync
			s.logger.Info("Changes detected, resetting interval to %v", interval)
		} else {
			// 変更がない場合は間隔を増加（最大値まで）
			newInterval := time.Duration(float64(interval) * factor)
			if newInterval > maxInterval {
				newInterval = maxInterval
			}
			if newInterval != interval {
				s.logger.Info("No changes detected, increasing interval from %v to %v", interval, newInterval)
				interval = newInterval
			}
		}

		if !s.IsTestMode() {
			wailsRuntime.EventsEmit(s.ctx, "drive:status", "synced")
		}

		// タイマーとリセット通知の待ち受け
		select {
		case <-time.After(interval):
			// 通常のインターバル経過後の同期
      if err := s.SyncNotes(); err != nil {
        s.logger.Error(err, "Error syncing with Drive")
      }
			continue
		case <-s.resetPollingChan:
			// ユーザーの操作によるリセット
			interval = maxInterval
			lastChangeTime = time.Now()
			s.logger.Info("Polling interval reset to maximum: %v", interval)
			continue
		}
    
	}
}

// Google Driveとの同期を実行
func (s *driveService) SyncNotes() error {
	s.logger.Info("Starting sync with Drive...")

	// テストモードの処理
	if s.IsTestMode() {
		return s.handleTestModeSync()
	}

	// 接続状態の確認
	if !s.IsConnected() {
		s.logger.Info("Not connected to Google Drive")
		return s.auth.HandleOfflineTransition(fmt.Errorf("not connected to Google Drive"))
	}

	// クラウドのノートリスト取得
	cloudNoteList, err := s.fetchCloudNoteList()
	if err != nil {
		return s.auth.HandleOfflineTransition(err)
	}

	// クラウドにノートリストがない場合は全ノートをアップロード
	if cloudNoteList == nil {
		s.logger.Info("Cloud note list is nil, uploading all notes...")
		return s.uploadAllNotes()
	}

	// 同期状態のログ出力
	s.logSyncStatus(cloudNoteList)

	// 変更の検出と同期処理
	if s.checkNeedSync(cloudNoteList) {
		s.logger.Info("Cloud has updates - updating local state")
		
		// まず現在のローカルの状態を保持
		currentNotes := make([]NoteMetadata, len(s.noteService.noteList.Notes))
		copy(currentNotes, s.noteService.noteList.Notes)
		
		// クラウドのノートと同期
		for _, cloudNote := range cloudNoteList.Notes {
			if err := s.syncNoteWithCloud(cloudNote.ID, cloudNote); err != nil {
				s.logger.Error(err, "Failed to sync note %s", cloudNote.ID)
				continue
			}
		}
		
		// ローカルにしかないノートを保持
		for _, localNote := range currentNotes {
			exists := false
			for _, cloudNote := range cloudNoteList.Notes {
				if cloudNote.ID == localNote.ID {
					exists = true
					break
				}
			}
			if !exists {
				s.logger.Info("Keeping local-only note: %s", localNote.Title)
				s.noteService.noteList.Notes = append(s.noteService.noteList.Notes, localNote)
			}
		}

		// ノートリストの更新
		s.noteService.noteList.LastSync = time.Now()
		if err := s.noteService.saveNoteList(); err != nil {
			return err
		}
		
		// アップロードして同期を完了
		if err := s.UploadNoteList(); err != nil {
			return err
		}
		
		// フロントエンドに変更を通知
		s.notifyFrontendChanges("synced")
	} else {
		s.logger.Info("Local is up to date")
	}

	return nil
}

// クラウドの変更をローカルに同期
func (s *driveService) syncCloudToLocal(cloudNoteList *NoteList) error {
	// 入力チェック
	if cloudNoteList == nil {
		return s.logger.ErrorWithNotify(
			fmt.Errorf("cloud note list is nil"), 
			"Cloud note list is nil")
	}

	// 同期の必要性をチェック
	if !s.checkNeedSync(cloudNoteList) {
		s.logger.Info("Local is up to date")
		return nil
	}

	s.logger.Info("Cloud has updates - updating local state")

	// ノートリストの更新
	s.noteService.noteList.Notes = make([]NoteMetadata, len(cloudNoteList.Notes))
	copy(s.noteService.noteList.Notes, cloudNoteList.Notes)
	s.noteService.noteList.LastSync = cloudNoteList.LastSync

	// ノートの内容を更新
	if s.IsTestMode() {
		if err := s.updateTestModeNotes(cloudNoteList.Notes); err != nil {
			return err
		}
	} else {
		if err := s.updateLocalNotes(cloudNoteList.Notes); err != nil {
			return err
		}
	}

	// ノートリストを保存
	if err := s.noteService.saveNoteList(); err != nil {
		return s.auth.HandleOfflineTransition(err)
	}

	// フロントエンドに変更を通知
	s.notifyFrontendChanges("synced")

	return nil
}

// 全てのローカルノートをGoogle Driveにアップロード
func (s *driveService) uploadAllNotes() error {
	s.logger.Info("Starting uploadAllNotes...")

	if !s.IsConnected() {
		return s.logger.ErrorWithNotify(fmt.Errorf("drive service is not initialized"), "Drive service is not initialized")
	}

	if s.auth.driveSync.service == nil {
		return s.logger.ErrorWithNotify(fmt.Errorf("drive service not connected"), "Drive service not connected")
	}

	s.logger.Info("Found %d notes to upload", len(s.noteService.noteList.Notes))

	// ノートをアップロード
	notes := make([]Note, 0, len(s.noteService.noteList.Notes))
	for _, metadata := range s.noteService.noteList.Notes {
		note, err := s.noteService.LoadNote(metadata.ID)
		if err != nil {
			s.logger.Error(err, "Failed to load note %s", metadata.ID)
			continue
		}
		notes = append(notes, *note)
	}

	return s.driveOps.uploadAllNotes(
		s.ctx,
		notes,
		s.auth.driveSync.notesFolderID,
		s.UploadNote,
		s.UploadNoteList,
		s.IsTestMode(),
	)
}

// ------------------------------------------------------------
// ノート操作
// ------------------------------------------------------------

// Google Driveからノートをダウンロード
func (s *driveService) downloadNote(noteID string) error {
	if !s.IsConnected() {
		return s.logger.ErrorWithNotify(fmt.Errorf("drive service is not initialized"), "Drive service is not initialized")
	}

	return s.driveOps.downloadNote(
		s.ctx,
		noteID,
		s.auth.driveSync.notesFolderID,
		s.noteService.SaveNote,
		s.removeFromNoteList,
		s.auth.driveSync.lastUpdated,
	)
}

// ノートリストから指定されたIDのノートを除外
func (s *driveService) removeFromNoteList(noteID string) {
	s.noteService.noteList.Notes = s.driveOps.removeFromNoteList(s.noteService.noteList.Notes, noteID)
}

// ノートをGoogle Driveにアップロード
// アップロード前に、既に同じIDのノートファイルが存在している場合は重複チェックを行い、
// 古い方を削除して最新のファイルに対して更新処理を行う。
func (s *driveService) UploadNote(note *Note) error {
	if !s.IsConnected() {
		return s.logger.ErrorWithNotify(
			fmt.Errorf("drive service is not initialized"), 
			"Drive service is not initialized")
	}

	s.logger.Info("Uploading note \"%s\"...", note.Title)

	err := s.driveOps.uploadNote(
		s.ctx,
		note,
		s.auth.driveSync.notesFolderID,
		s.auth.driveSync.lastUpdated,
		s.IsTestMode(),
		s.handleTestModeUpload,
	)
	if err != nil {
		return s.logger.ErrorWithNotify(err, "Failed to upload note")
	}

	s.logger.Info("Note \"%s\" uploaded successfully", note.Title)
	s.ResetPollingInterval()
	return nil
}


// Google Drive上のノートを削除
func (s *driveService) DeleteNoteDrive(noteID string) error {
	s.logger.Info("Deleting note from cloud...")

	if !s.IsConnected() {
		return s.logger.ErrorWithNotify(fmt.Errorf("drive service is not initialized"), "Drive service is not initialized")
	}

	err := s.driveOps.deleteNoteDrive(
		s.ctx,
		noteID,
		s.auth.driveSync.notesFolderID,
		s.IsTestMode(),
		s.handleTestModeDelete,
	)
	if err != nil {
		return s.logger.ErrorWithNotify(err, "Failed to delete note from cloud")
	}

	s.logger.Info("Deleted note from cloud")
	s.ResetPollingInterval() // ポーリングをリセット
	return nil
}

// 現在のノートリスト(noteList.json)をアップロード
func (s *driveService) UploadNoteList() error {
	s.logger.Info("Uploading note list...")

	if !s.IsConnected() {
		return s.logger.ErrorWithNotify(fmt.Errorf("drive service is not initialized"), "Drive service is not initialized")
	}

	s.logger.Console("Uploading note list with LastSync: %v", s.noteService.noteList.LastSync)
	s.logger.Console("Notes count: %d", len(s.noteService.noteList.Notes))

	err := s.driveOps.uploadNoteList(
		s.ctx,
		s.noteService.noteList,
		s.auth.driveSync.rootFolderID,
		s.IsTestMode(),
		s.handleTestModeNoteListUpload,
	)
	if err != nil {
		return s.logger.ErrorWithNotify(err, "Failed to upload note list")
	}

	s.ResetPollingInterval() // ポーリングをリセット
	return nil
}

// ノートリストの内容が異なるかどうかをチェック
func (s *driveService) hasNoteListChanged(cloudList, localList []NoteMetadata) bool {
	if len(cloudList) != len(localList) {
		s.logger.Info("Note list length differs")
		return true
	}

	// ノートの順序とIDを比較
	for i := range cloudList {
		if cloudList[i].ID != localList[i].ID || 
			cloudList[i].Order != localList[i].Order {
			s.logger.Info("Note order differs at index %d (cloud: %s[%d], local: %s[%d])",
				i, cloudList[i].ID, cloudList[i].Order,
				localList[i].ID, localList[i].Order)
			return true
		}
	}
	return false
}

// ------------------------------------------------------------
// 内部ヘルパー
// ------------------------------------------------------------

// ポーリングインターバルをリセット
func (s *driveService) ResetPollingInterval() {
	if s.resetPollingChan == nil {
		return
	}
	select {
	case s.resetPollingChan <- struct{}{}:
	default:
	}
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

	return nil
}

// notesフォルダ内の重複する {id}.jsonファイルを検出し、最新のファイルだけを残し古い方を削除
func (s *driveService) cleanDuplicateNoteFiles() error {
	// notesフォルダ内のファイル一覧を取得

	files, err := s.driveOps.ListFiles(
		fmt.Sprintf("'%s' in parents and trashed=false", s.auth.driveSync.notesFolderID))
	if err != nil {
		return s.logger.ErrorWithNotify(err, "Failed to list files in notes folder")
	}

	duplicateMap := make(map[string][]*drive.File)
	for _, file := range files {
		// 対象は「.json」で終わるファイルのみとする
		if !strings.HasSuffix(file.Name, ".json") {
			continue
		}
		// 拡張子を除いた部分をIDとみなす
		noteID := strings.TrimSuffix(file.Name, ".json")
		duplicateMap[noteID] = append(duplicateMap[noteID], file)
	}

	// 各noteIDごとに複数ファイルが存在すれば最新1つ以外を削除
	for _, files := range duplicateMap {
		if len(files) > 1 {
			// 作成日時で降順にソート（最新が先頭）
			sort.Slice(files, func(i, j int) bool {
				t1, err1 := time.Parse(time.RFC3339, files[i].CreatedTime)
				t2, err2 := time.Parse(time.RFC3339, files[j].CreatedTime)
				if err1 != nil || err2 != nil {
					return false
				}
				return t1.After(t2)
			})

			// 最新以外のファイルを削除
			for _, file := range files[1:] {
				if err := s.driveOps.DeleteFile(file.Id); err != nil {
					s.logger.Error(err, "Failed to delete duplicate file: %s", file.Name)
				} else {
					s.logger.Info("Deleted duplicate file: %s", file.Name)
				}
			}
		}
	}

	return nil
}

// ------------------------------------------------------------
// 同期関連のヘルパー
// ------------------------------------------------------------

// 同期状態のログを出力
func (s *driveService) logSyncStatus(cloudNoteList *NoteList) {
	s.logger.Info("Cloud note list LastSync: %v", cloudNoteList.LastSync)
	s.logger.Info("Local note list LastSync: %v", s.noteService.noteList.LastSync)
	s.logger.Info("Cloud notes count: %d", len(cloudNoteList.Notes))
	s.logger.Info("Local notes count: %d", len(s.noteService.noteList.Notes))
}

// ノートリストの同期が必要かどうかを判断
func (s *driveService) checkNeedSync(cloudNoteList *NoteList) bool {
	// クラウドの方が新しい場合のみ同期
	if cloudNoteList.LastSync.After(s.noteService.noteList.LastSync) {
		s.logger.Info("Cloud note list is newer")
		return true
	}
	
	// ローカルの方が新しい場合は、ローカルの内容をアップロード
	if s.noteService.noteList.LastSync.After(cloudNoteList.LastSync) {
		s.logger.Info("Local note list is newer, uploading to cloud")
		if err := s.UploadNoteList(); err != nil {
			s.logger.Error(err, "Failed to upload newer local note list")
		}
		return false
	}
	
	// 同じタイムスタンプの場合のみ、内容の比較を行う
	if s.hasNoteListChanged(cloudNoteList.Notes, s.noteService.noteList.Notes) {
		s.logger.Info("Note lists have same timestamp but different content")
		return true
	}
	
	return false
}

// ローカルのノートを更新
func (s *driveService) updateLocalNotes(cloudNotes []NoteMetadata) error {
	for _, cloudNote := range cloudNotes {
		localNote, err := s.noteService.LoadNote(cloudNote.ID)
		if err != nil || localNote.ModifiedTime.Before(cloudNote.ModifiedTime) {
			if err := s.downloadNote(cloudNote.ID); err != nil {
				s.logger.Error(err, "Error downloading note %s", cloudNote.ID)
			}
		}
	}
	return nil
}

// ------------------------------------------------------------
// テストモード関連
// ------------------------------------------------------------

// テストモード時のノート削除処理
func (s *driveService) handleTestModeDelete(noteID string) error {
	var updatedNotes []NoteMetadata
	for _, metadata := range s.auth.driveSync.cloudNoteList.Notes {

		if metadata.ID != noteID {
			updatedNotes = append(updatedNotes, metadata)
		}
	}
	s.auth.driveSync.cloudNoteList.Notes = updatedNotes
	return nil
}

// テストモード時のノートアップロード処理
func (s *driveService) handleTestModeUpload(note *Note) error {
	s.auth.driveSync.lastUpdated[note.ID] = time.Now()
	found := false
	for i, metadata := range s.auth.driveSync.cloudNoteList.Notes {
		if metadata.ID == note.ID {
			s.auth.driveSync.cloudNoteList.Notes[i] = NoteMetadata{
				ID:            note.ID,
				Title:         note.Title,
				ContentHeader: note.ContentHeader,
				Language:      note.Language,
				ModifiedTime:  note.ModifiedTime,
				Archived:      note.Archived,
			}
			found = true
			break
		}
	}
	if !found {
		s.auth.driveSync.cloudNoteList.Notes = append(
			s.auth.driveSync.cloudNoteList.Notes,
			NoteMetadata{
				ID:            note.ID,
				Title:         note.Title,
				ContentHeader: note.ContentHeader,
				Language:      note.Language,
				ModifiedTime:  note.ModifiedTime,
				Archived:      note.Archived,
			},
		)
	}
	return nil
}

// テストモード時のノートリストアップロード処理
func (s *driveService) handleTestModeNoteListUpload() error {
	s.auth.driveSync.cloudNoteList = &NoteList{
		Version:  s.noteService.noteList.Version,
		Notes:    make([]NoteMetadata, len(s.noteService.noteList.Notes)),
		LastSync: time.Now(),
	}
	copy(s.auth.driveSync.cloudNoteList.Notes, s.noteService.noteList.Notes)
	s.logger.Info("Note list uploaded (test mode)")
	return nil
}

// テストモード時の同期処理
func (s *driveService) handleTestModeSync() error {
	if s.auth.driveSync.cloudNoteList == nil {
		return fmt.Errorf("cloud note list is nil")
	}
	s.auth.driveSync.isConnected = true
	return s.syncCloudToLocal(s.auth.driveSync.cloudNoteList)
}

// テストモード時のノート更新
func (s *driveService) updateTestModeNotes(cloudNotes []NoteMetadata) error {
	for _, cloudNote := range cloudNotes {
		note := &Note{
			ID:           cloudNote.ID,
			Title:        cloudNote.Title,
			Content:      "Cloud content",
			Language:     cloudNote.Language,
			ModifiedTime: cloudNote.ModifiedTime,
		}
		if err := s.noteService.SaveNote(note); err != nil {
			s.logger.Error(err, "Error saving note %s", cloudNote.ID)
		}
	}
	return nil
}



