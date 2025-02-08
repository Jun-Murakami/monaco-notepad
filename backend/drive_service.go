package backend

import (
	"context"
	"fmt"
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
	NotifyFrontendReady() // フロントエンド準備完了通知
	IsConnected() bool    // 接続状態確認
	IsTestMode() bool     // テストモード確認
}

// driveService はDriveServiceインターフェースの実装
type driveService struct {
	ctx              context.Context
	auth             *driveAuthService
	noteService      *noteService
	appDataDir       string
	notesDir         string
	resetPollingChan chan struct{}
	stopPollingChan  chan struct{}
	logger           DriveLogger
	driveOps         DriveOperations
	driveSync        DriveSyncService
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
}

// ------------------------------------------------------------
// 認証まわりの公開ラッパーメソッド (実装はdriveAuthService)
// ------------------------------------------------------------

// Google Drive APIの初期化 (保存済みトークンがあれば自動ログイン) ------------------------------------------------------------
func (s *driveService) InitializeDrive() error {
	// 保存済みトークンでの初期化を試行
	if err := s.auth.InitializeWithSavedToken(); err != nil {
		return s.logger.ErrorWithNotify(err, "Failed to initialize Drive API")
	}
	return s.onConnected(false)
}

// Google Driveに手動ログイン ------------------------------------------------------------
func (s *driveService) AuthorizeDrive() error {
	if err := s.auth.StartManualAuth(); err != nil {
		return s.logger.ErrorWithNotify(err, "Failed to complete authentication")
	}
	return s.onConnected(true)
}

// 接続成功時の処理 ------------------------------------------------------------
func (s *driveService) onConnected(performInitialSync bool) error {
	if !s.IsConnected() {
		return s.logger.ErrorWithNotify(fmt.Errorf("not connected to Google Drive"), "Not connected to Google Drive")
	}
	s.logger.Info("Connected to Google Drive")

	// DriveOps生成
	s.driveOps = NewDriveOperations(s.auth.GetDriveSync().service)

	// フォルダの確保
	if err := s.ensureDriveFolders(); err != nil {
		return s.logger.ErrorWithNotify(err, "Failed to ensure drive folders")
	}

	// driveSync生成
	s.driveSync = NewDriveSyncService(
		s.driveOps,                     // ドライブ操作オブジェクト
		s.auth.driveSync.notesFolderID, // ノート保存用フォルダIDを注入
		s.auth.driveSync.rootFolderID,  // アプリケーションのルートフォルダIDを注入
	)

	// ノートリストの確保
	if err := s.ensureNoteList(); err != nil {
		return s.logger.ErrorWithNotify(err, "Failed to ensure note list")
	}

	// 必要な場合は初回マージを実行
	if performInitialSync {
		if err := s.performInitialSync(); err != nil {
			s.auth.HandleOfflineTransition(err)
			return s.logger.ErrorWithNotify(err, "Failed to perform initial sync")
		}
	}

	// ポーリング開始
	go s.waitForFrontendAndStartSync()
	return nil
}

// Google Driveからログアウト ------------------------------------------------------------
func (s *driveService) LogoutDrive() error {
	s.logger.Info("Logging out of Google Drive...")

	// ポーリングを停止
	if s.stopPollingChan != nil {
		close(s.stopPollingChan)
		s.stopPollingChan = make(chan struct{}) // 新しいチャネルを作成
	}

	return s.auth.LogoutDrive()
}

// 認証をキャンセル ------------------------------------------------------------
func (s *driveService) CancelLoginDrive() error {
	return s.auth.CancelLoginDrive()
}

// フロントエンドへ準備完了を通知 ------------------------------------------------------------
func (s *driveService) NotifyFrontendReady() {
	s.auth.NotifyFrontendReady()
}

// 接続状態を返す ------------------------------------------------------------
func (s *driveService) IsConnected() bool {
	return s.auth.driveSync.isConnected
}

// テストモードかどうかを返す ------------------------------------------------------------
func (s *driveService) IsTestMode() bool {
	return s.auth != nil && s.auth.IsTestMode()
}

// ------------------------------------------------------------
// ノート操作の公開メソッド
// ------------------------------------------------------------

// ノートを作成する ------------------------------------------------------------
func (s *driveService) CreateNote(note *Note) error {
	if !s.IsConnected() {
		return s.auth.HandleOfflineTransition(fmt.Errorf("not connected to Google Drive"))
	}
	if err := s.driveSync.CreateNote(s.ctx, note); err != nil {
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to create note: %v", err))
	}
	s.logger.Info("Note created successfully")
	s.ResetPollingInterval()
	return nil

}

// ノートを更新する ------------------------------------------------------------
func (s *driveService) UpdateNote(note *Note) error {
	if !s.IsConnected() {
		return s.auth.HandleOfflineTransition(fmt.Errorf("not connected to Google Drive"))
	}
	if err := s.driveSync.UpdateNote(s.ctx, note); err != nil {
		return s.auth.HandleOfflineTransition(fmt.Errorf("failed to update note: %v", err))
	}
	s.logger.Info("Note updated successfully")
	s.ResetPollingInterval()

	return nil
}

// ノートを削除 ------------------------------------------------------------
func (s *driveService) DeleteNoteDrive(noteID string) error {
	if !s.IsConnected() {
		return s.logger.ErrorWithNotify(fmt.Errorf("drive service is not initialized"), "Drive service is not initialized")
	}

	if err := s.driveSync.DeleteNote(s.ctx, noteID); err != nil {
		return s.logger.ErrorWithNotify(err, "Failed to delete note from cloud")
	}

	s.logger.Info("Deleted note from cloud")
	s.ResetPollingInterval()
	return nil
}

// 現在のノートリストをアップロード ------------------------------------------------------------
func (s *driveService) UpdateNoteList() error {
	if !s.IsConnected() {
		return s.logger.ErrorWithNotify(fmt.Errorf("drive service is not initialized"), "Drive service is not initialized")
	}

	s.logger.Console("Uploading note list with LastSync: %v, Notes count: %d", s.noteService.noteList.LastSync, len(s.noteService.noteList.Notes))

	// アップロード前に最新のLastSyncを保持
	lastSync := s.noteService.noteList.LastSync

	if err := s.driveSync.UpdateNoteList(s.ctx, s.noteService.noteList, s.auth.driveSync.noteListID); err != nil {
		return s.logger.ErrorWithNotify(err, "Failed to update note list")
	}

	// アップロード成功後、保持していたLastSyncをcloudNoteListに設定
	if s.auth.driveSync.cloudNoteList != nil {
		s.auth.driveSync.cloudNoteList.LastSync = lastSync
		s.auth.driveSync.cloudNoteList.Notes = s.noteService.noteList.Notes
	}

	s.logger.Info("Note list updated successfully")
	s.ResetPollingInterval()
	return nil
}

// 同期をただちに実行 ------------------------------------------------------------
func (s *driveService) SyncNotes() error {
	s.logger.Info("Starting sync with Drive...")

	// 接続状態の確認
	if !s.IsConnected() {
		s.logger.Info("Not connected to Google Drive")
		return s.auth.HandleOfflineTransition(fmt.Errorf("not connected to Google Drive"))
	}

	// クラウドのノートリスト取得
	cloudNoteList, err := s.driveSync.DownloadNoteList(s.ctx, s.auth.driveSync.noteListID)
	if err != nil {
		return s.auth.HandleOfflineTransition(err)
	}

	// クラウドにノートリストがない場合は全ノートをアップロード
	if cloudNoteList == nil {
		s.logger.Info("Cloud note list is nil, uploading all notes...")
		return s.driveSync.UploadAllNotes(s.ctx, s.noteService.noteList.Notes)
	}

	// クラウドに存在しないファイルをリストから除外して返す
	availableNotesList, err := s.driveSync.ListAvailableNotes(cloudNoteList)
	if err != nil {
		return fmt.Errorf("failed to list available notes: %v", err)
	}

	// 同期状態のログ出力
	s.logger.Info("Cloud noteList LastSync: %v, Cloud available notes: %d", cloudNoteList.LastSync, len(availableNotesList.Notes))
	s.logger.Info("Cloud notes: %d, Cloud available notes: %d, Local notes: %d", len(cloudNoteList.Notes), len(availableNotesList.Notes), len(s.noteService.noteList.Notes))

	// 変更の検出と同期処理
	if s.isCloudNoteListNewer(cloudNoteList) {
		// まず現在のローカルの状態を保持
		currentNotes := make([]NoteMetadata, len(s.noteService.noteList.Notes))
		copy(currentNotes, s.noteService.noteList.Notes)

		// クラウドのノートと同期
		for _, cloudNote := range availableNotesList.Notes {
			if err := s.syncNoteCloudToLocal(s.ctx, cloudNote.ID, cloudNote); err != nil {
				s.logger.Error(err, "Failed to sync note %s", cloudNote.ID)
				continue
			}
		}

		// ローカルにしかないノートを削除
		for _, localNote := range currentNotes {
			exists := false
			for _, cloudNote := range availableNotesList.Notes {
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

		// ローカルのノートリストを更新
		s.noteService.noteList.Notes = availableNotesList.Notes
		s.noteService.noteList.LastSync = availableNotesList.LastSync
		if err := s.noteService.saveNoteList(); err != nil {
			return err
		}

		// ノートリストをアップロードして同期を完了
		if cloudNoteList != nil {
			if err := s.UpdateNoteList(); err != nil {
				return err
			}
		} else {
			// クラウドにノートリストがない場合は作成
			if err := s.driveSync.CreateNoteList(s.ctx, s.noteService.noteList); err != nil {
				return err
			}
			noteListID, err := s.driveOps.GetFileID("noteList.json", s.auth.driveSync.notesFolderID, "")
			if err != nil {
				return err
			}
			s.auth.driveSync.noteListID = noteListID
		}

		// フロントエンドに変更を通知
		s.logger.NotifyFrontendSyncedAndReload(s.ctx)
	} else {
		s.logger.Info("Sync status is up to date")
	}

	return nil
}

// ------------------------------------------------------------
// 同期用の内部ルーチン
// ------------------------------------------------------------

// フロントエンドの準備完了を待って同期開始 ------------------------------------------------------------
func (s *driveService) waitForFrontendAndStartSync() {
	<-s.auth.GetFrontendReadyChan() // フロントエンドが ready になるまでブロック
	s.logger.Info("Frontend ready - starting sync...")

	// 接続状態を通知
	if !s.IsTestMode() {
		s.logger.NotifyDriveStatus(s.ctx, "synced")
	}

	// 少し待機の後にポーリング開始
	time.Sleep(1 * time.Second)
	s.startSyncPolling()
}

// Google Driveとのポーリング監視を開始 ------------------------------------------------------------
func (s *driveService) startSyncPolling() {
	const (
		initialInterval = 20 * time.Second
		maxInterval     = 3 * time.Minute
		factor          = 1.5
	)

	interval := initialInterval
	s.resetPollingChan = make(chan struct{}, 1)

	// クラウドにある重複ファイルの削除
	if err := s.driveSync.RemoveDuplicateNoteFiles(s.ctx); err != nil {
		s.logger.Error(err, "Failed to clean duplicate note files")
	}

	// まず１回同期を行う
	if err := s.SyncNotes(); err != nil {
		s.logger.Error(err, "Error syncing with Drive")
	}

	for {
		select {
		case <-s.stopPollingChan:
			s.logger.Info("Stopping sync polling...")
			return
		default:
			if !s.IsConnected() {
				time.Sleep(initialInterval)
				continue
			}

			// 同期開始を通知
			if !s.IsTestMode() {
				wailsRuntime.EventsEmit(s.ctx, "drive:status", "syncing")
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
				// 変更がない場合は間隔を増加（最大値まで）
				newInterval := time.Duration(float64(interval) * factor)
				if newInterval > maxInterval {
					newInterval = maxInterval
				}
				if newInterval != interval {
					s.logger.Console("No changes detected, increasing interval from %v to %v", interval, newInterval)
					interval = newInterval
				}
				continue
			case <-s.resetPollingChan:
				// ユーザーの操作によるリセット
				interval = initialInterval
				s.logger.Console("Polling interval reset to: %v", interval)
				continue
			case <-s.stopPollingChan:
				s.logger.Info("Stopping sync polling...")
				return
			}
		}
	}
}

// 初回接続時のマージ処理 ------------------------------------------------------------
func (s *driveService) performInitialSync() error {
	s.logger.Info("Starting initial sync...")

	// クラウドのノートリストを取得
	s.logger.Info("Checking cloud note list...")
	cloudNoteList, err := s.driveSync.DownloadNoteList(s.ctx, s.auth.driveSync.noteListID)
	if err != nil {
		return fmt.Errorf("failed to download note list: %v", err)
	}

	// クラウドにノートリストがない場合は全ノートをアップロード
	if cloudNoteList == nil {
		s.logger.Info("Uploading local notes to cloud...")
		if err := s.driveSync.UploadAllNotes(
			s.ctx,
			s.noteService.noteList.Notes,
		); err != nil {
			return fmt.Errorf("failed to upload all notes: %v", err)
		}
	}

	// クラウドに存在しないファイルをリストから除外して返す
	availableNotes, err := s.driveSync.ListAvailableNotes(cloudNoteList)
	if err != nil {
		return fmt.Errorf("failed to list available notes: %v", err)
	}

	s.logger.Info(fmt.Sprintf("Found %d notes in cloud", len(availableNotes.Notes)))
	s.logger.Info(fmt.Sprintf("Found %d notes locally", len(s.noteService.noteList.Notes)))

	// クラウドのnotesフォルダにある不明なノートをリストアップ
	unknownNotes, err := s.driveSync.ListUnknownNotes(
		s.ctx,
		availableNotes,
	)

	if err != nil {
		return fmt.Errorf("failed to list unknown notes: %v", err)
	}

	//不明なノートリストとクラウドのノートリストを結合
	var mergedCloudNotes []NoteMetadata
	if unknownNotes != nil {
		mergedCloudNotes = append(unknownNotes.Notes, cloudNoteList.Notes...)
	} else {
		mergedCloudNotes = cloudNoteList.Notes
	}

	// ノートのマージ処理
	mergedNotes, downloadedNotes, err := s.mergeNotes(
		s.ctx,
		s.noteService.noteList.Notes,
		mergedCloudNotes,
	)
	if err != nil {
		return fmt.Errorf("failed to merge notes: %v", err)
	}

	// マージ後にダウンロードしたノートをローカルに保存
	for _, note := range downloadedNotes {
		if err := s.noteService.SaveNote(note); err != nil {
			return fmt.Errorf("failed to save downloaded note: %v", err)
		}
	}

	// ノートリストの更新
	s.logger.Info("Saving merged note list...")
	s.noteService.noteList.Notes = mergedNotes
	s.noteService.noteList.LastSync = time.Now()
	if err := s.noteService.saveNoteList(); err != nil {
		s.logger.Error(err, "Failed to save merged note list")
		s.auth.HandleOfflineTransition(err)
		return fmt.Errorf("failed to save merged note list: %v", err)
	}

	// ノートリストをアップロードして同期を完了
	if cloudNoteList != nil {
		if err := s.UpdateNoteList(); err != nil {
			return err
		}
	} else {
		// クラウドにノートリストがない場合は作成
		if err := s.driveSync.CreateNoteList(s.ctx, s.noteService.noteList); err != nil {
			return err
		}
		noteListID, err := s.driveOps.GetFileID("noteList.json", s.auth.driveSync.notesFolderID, "")
		if err != nil {
			return err
		}
		s.auth.driveSync.noteListID = noteListID
	}

	s.logger.Info("Initial sync completed")

	// フロントエンドに変更を通知
	s.logger.NotifyFrontendSyncedAndReload(s.ctx)

	return nil
}

// ノートのマージ処理 ------------------------------------------------------------
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

	// マージ処理
	var downloadedNotes []*Note
	for id, localNote := range localNotesMap {
		// クラウドに同じIDのノートが存在する場合
		if cloudNote, exists := cloudNotesMap[id]; exists {
			// ハッシュが一致する場合はスキップ
			if localNote.ContentHash != "" && cloudNote.ContentHash != "" &&
				localNote.ContentHash == cloudNote.ContentHash {
				mergedNotes = append(mergedNotes, localNote)
				delete(cloudNotesMap, id)
				continue
			}

			// ハッシュが一致しない場合は更新日時で比較
			if cloudNote.ModifiedTime.After(localNote.ModifiedTime) {
				mergedNotes = append(mergedNotes, cloudNote)
				note, err := s.driveSync.DownloadNote(ctx, id)
				if err != nil {
					return nil, nil, fmt.Errorf("failed to download note %s: %w", id, err)
				}
				downloadedNotes = append(downloadedNotes, note)
			} else {
				// ローカルのノートが新しい場合はアップロードして上書き
				mergedNotes = append(mergedNotes, localNote)
				note, err := s.noteService.LoadNote(id)
				if err == nil {
					if err := s.driveSync.UpdateNote(ctx, note); err != nil {
						return nil, nil, fmt.Errorf("failed to upload note %s: %w", id, err)
					}
				}
			}
			delete(cloudNotesMap, id)
		} else {
			// ローカルにしかないノートはアップロード
			mergedNotes = append(mergedNotes, localNote)
			note, err := s.noteService.LoadNote(id)
			if err == nil {
				if err := s.driveSync.CreateNote(ctx, note); err != nil {
					return nil, nil, fmt.Errorf("failed to upload note %s: %w", id, err)
				}
			}
		}
	}
	// クラウドにしかないノートを追加
	for id, cloudNote := range cloudNotesMap {
		mergedNotes = append(mergedNotes, cloudNote)
		note, err := s.driveSync.DownloadNote(ctx, id)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to download note %s: %w", id, err)
		}
		downloadedNotes = append(downloadedNotes, note)
	}
	return mergedNotes, downloadedNotes, nil
}

// 単一のノートをクラウドと同期する ------------------------------------------------------------
func (s *driveService) syncNoteCloudToLocal(
	ctx context.Context,
	noteID string,
	cloudNote NoteMetadata,
) error {
	localNote, err := s.noteService.LoadNote(noteID)
	if err != nil {
		// ローカルにないノートはダウンロード
		if note, err := s.driveSync.DownloadNote(ctx, noteID); err != nil {
			return err
		} else {
			s.noteService.SaveNote(note)
			return nil
		}
	}
	// クラウドの方が新しい場合は更新
	if cloudNote.ModifiedTime.After(localNote.ModifiedTime) {
		fmt.Println("cloudNote.ModifiedTime: ", cloudNote.ModifiedTime)
		fmt.Println("localNote.ModifiedTime: ", localNote.ModifiedTime)
		if note, err := s.driveSync.DownloadNote(ctx, noteID); err != nil {
			return err
		} else {
			note.ModifiedTime = cloudNote.ModifiedTime
			s.noteService.SaveNote(note)
			return nil
		}
	}
	return nil
}

// ------------------------------------------------------------
// 内部ヘルパー
// ------------------------------------------------------------

// ノートリストの同期が必要かどうかを判断 ------------------------------------------------------------
func (s *driveService) isCloudNoteListNewer(cloudNoteList *NoteList) bool {
	// クラウドの方が新しい場合のみ同期
	if cloudNoteList.LastSync.After(s.noteService.noteList.LastSync) {
		s.logger.Info("Cloud note list is newer")
		return true
	}
	// 同じタイムスタンプの場合のみ、内容の比較を行う
	if s.isNoteListChanged(cloudNoteList.Notes, s.noteService.noteList.Notes) {
		s.logger.Console("Note lists have same timestamp but different content"+
			"\ncloud: %v"+
			"\nlocal: %v",
			cloudNoteList.Notes,
			s.noteService.noteList.Notes,
		)
		return true
	}
	return false
}

// ノートリストの内容が異なるかどうかをチェック ------------------------------------------------------------
func (s *driveService) isNoteListChanged(cloudList, localList []NoteMetadata) bool {
	if len(cloudList) != len(localList) {
		s.logger.Info("Note list length differs")
		return true
	}

	// IDとハッシュ値のマップを作成して比較
	cloudMap := make(map[string]NoteMetadata)
	localMap := make(map[string]NoteMetadata)

	for _, note := range cloudList {
		cloudMap[note.ID] = note
	}
	for _, note := range localList {
		localMap[note.ID] = note
	}

	// 各ノートの内容を比較
	for id, cloudNote := range cloudMap {
		// ローカルにないノートは変更ありと判定
		localNote, exists := localMap[id]
		if !exists {
			s.logger.Info("Note %s exists in cloud but not in local", id)
			return true
		}
		// ハッシュ値が異なる場合のみ変更ありと判定
		if cloudNote.ContentHash != localNote.ContentHash {
			s.logger.Info("Note %s has different content hash", id)
			return true
		}
		// 順序が異なる場合は変更ありと判定
		if cloudNote.Order != localNote.Order {
			s.logger.Info("Note %s has different order", id)
			return true
		}
	}
	return false
}

// Google Drive上に必要なフォルダ構造を作成 ------------------------------------------------------------

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

// ノートリストの初期化 ------------------------------------------------------------
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

// ポーリングインターバルをリセット ------------------------------------------------------------
func (s *driveService) ResetPollingInterval() {
	if s.resetPollingChan == nil {
		return
	}
	select {
	case s.resetPollingChan <- struct{}{}:
	default:
	}
}

// ------------------------------------------------------------
// テストモード関連
// ------------------------------------------------------------

// driveService型にauthServiceを設定するメソッドを追加
func (ds *driveService) SetAuthService(auth *driveAuthService) {
	ds.auth = auth
}
