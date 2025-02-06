package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
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
	AuthorizeDrive() (string, error)
	CompleteAuth(code string) error
	LogoutDrive() error

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
	ctx        context.Context
	auth       *driveAuthService // 認証・初期化・切断などを委譲
	noteService *noteService

	// 下記はビジネスロジックで必要な情報
	// （authService.driveSync と重複する部分もありますが、利便性のために保持）
	appDataDir string
	notesDir   string
}

// NewDriveService は新しいdriveServiceインスタンスを作成します
func NewDriveService(
	ctx context.Context,
	appDataDir string,
	notesDir string,
	noteService *noteService,
	credentials []byte,
) DriveService {
	authService := NewDriveAuthService(
		ctx,
		appDataDir,
		notesDir,
		noteService,
		credentials,
		false, // isTestMode = false
		// driveServiceのインスタンスを渡す
	)

	return &driveService{
		ctx:        ctx,
		auth:       authService,
		noteService: noteService,
		appDataDir: appDataDir,
		notesDir:   notesDir,
	}
}

// ------------------------------------------------------------
// 認証まわりのラッパメソッド
// ------------------------------------------------------------

// InitializeDrive はGoogle Drive APIの初期化を行う
func (s *driveService) InitializeDrive() error {
	err := s.auth.InitializeDrive()
	if err != nil {
		return err
	}
	// 認証成功後にフォルダなどの準備が必要ならここで行う
	if s.IsConnected() {
		if err := s.ensureDriveFolders(); err != nil {
			return err
		}

		// startPageToken のロード or 取得
		if err := s.loadStartPageToken(); err != nil {
			fmt.Printf("Error loading or creating start page token: %v\n", err)
			s.sendLogMessage(fmt.Sprintf("Error loading or creating start page token: %v", err))
		}

		// フロントエンドの準備完了後に初回同期やポーリングを開始
		go s.waitForFrontendAndStartSync()
	}
	return nil
}

// AuthorizeDrive はGoogle Driveの認証フローを開始
func (s *driveService) AuthorizeDrive() (string, error) {
	return s.auth.AuthorizeDrive()
}

// CompleteAuth は認証コードを使用してGoogle Drive認証を完了
func (s *driveService) CompleteAuth(code string) error {
	s.sendLogMessage("Connecting to Google Drive...")
	
	err := s.auth.CompleteAuth(code)
	if err != nil {
		s.sendLogMessage("Failed to connect to Google Drive")
		s.auth.handleOfflineTransition(err)
		return err
	}

	s.sendLogMessage("Connected to Google Drive")
	// 認証完了後にフォルダなどの準備が必要ならここで行う

	if s.IsConnected() {
		if err := s.ensureDriveFolders(); err != nil {
			s.sendLogMessage("Failed to ensure drive folders")
			s.auth.handleOfflineTransition(err)
			return err
		}

		if err := s.loadStartPageToken(); err != nil {
			fmt.Printf("Error loading or creating start page token: %v\n", err)
			s.sendLogMessage(fmt.Sprintf("Error loading or creating start page token: %v", err))
			s.auth.handleOfflineTransition(err)
		}
		go s.waitForFrontendAndStartSync()

	}
	return nil
}

// LogoutDrive はGoogle Driveからログアウト
func (s *driveService) LogoutDrive() error {
	s.sendLogMessage("Logging out of Google Drive...")
	

	err := s.auth.LogoutDrive()
	if err != nil {
		s.sendLogMessage("Failed to logout")
		s.auth.handleOfflineTransition(err)
		return err
	}


	s.sendLogMessage("Logged out of Google Drive")
	return nil

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

	fmt.Println("Frontend ready - starting sync...")
	s.sendLogMessage("Frontend ready - starting sync...")

	// 接続状態を通知
	if !s.IsTestMode() {
		wailsRuntime.EventsEmit(s.ctx, "drive:status", "synced")
	}

	// 初回同期フラグをチェック
	syncFlagPath := filepath.Join(s.appDataDir, "initial_sync_completed")
	if _, err := os.Stat(syncFlagPath); os.IsNotExist(err) {
		fmt.Println("First time initialization - performing initial sync...")
		s.sendLogMessage("First time initialization - performing initial sync...")
		if err := s.performInitialSync(); err != nil {
			fmt.Printf("Initial sync failed: %v\n", err)
			s.sendLogMessage(fmt.Sprintf("Initial sync failed: %v", err))
			s.auth.handleOfflineTransition(err)
		} else {

			// 初回同期完了フラグを保存
			if err := os.WriteFile(syncFlagPath, []byte("1"), 0644); err != nil {
				fmt.Printf("Failed to save initial sync flag: %v\n", err)
				s.sendLogMessage(fmt.Sprintf("Failed to save initial sync flag: %v", err))
				s.auth.handleOfflineTransition(err)
			}
			s.auth.driveSync.hasCompletedInitialSync = true
		}
	} else {
		s.auth.driveSync.hasCompletedInitialSync = true
	}

	// 少し待機の後にポーリング開始
	time.Sleep(1 * time.Second)
	s.startSyncPolling()
}

// performInitialSync は初回接続時のマージ処理を実行します
func (s *driveService) performInitialSync() error {
	s.sendLogMessage("Starting initial sync...")


	// クラウドのノートリストを取得
	s.sendLogMessage("Checking cloud note list...")
	noteListFiles, err := s.auth.driveSync.service.Files.List().
		Q(fmt.Sprintf("name='noteList.json' and '%s' in parents and trashed=false", s.auth.driveSync.rootFolderID)).
		Fields("files(id)").Do()
	if err != nil {
		s.sendLogMessage(fmt.Sprintf("Failed to list cloud noteList: %v", err))
		s.auth.handleOfflineTransition(err)
		return fmt.Errorf("failed to list cloud noteList: %v", err)
	}


	var cloudNoteList *NoteList
	if len(noteListFiles.Files) > 0 {
		s.sendLogMessage("Downloading cloud note list...")
		resp, err := s.auth.driveSync.service.Files.Get(noteListFiles.Files[0].Id).Download()
		if err != nil {
			s.sendLogMessage(fmt.Sprintf("Failed to download cloud noteList: %v", err))
			s.auth.handleOfflineTransition(err)
			return fmt.Errorf("failed to download cloud noteList: %v", err)
		}
		defer resp.Body.Close()


		if err := json.NewDecoder(resp.Body).Decode(&cloudNoteList); err != nil {
			s.sendLogMessage(fmt.Sprintf("Failed to decode cloud noteList: %v", err))
			s.auth.handleOfflineTransition(err)
			return fmt.Errorf("failed to decode cloud noteList: %v", err)
		}
		s.sendLogMessage("Cloud note list downloaded")

	}

	if cloudNoteList == nil {
		s.sendLogMessage("Uploading local notes to cloud...")
		return s.uploadAllNotes()
	}


	s.sendLogMessage(fmt.Sprintf("Found %d notes in cloud", len(cloudNoteList.Notes)))
	s.sendLogMessage(fmt.Sprintf("Found %d notes locally", len(s.noteService.noteList.Notes)))

	// ノートのマージ処理
	mergedNotes := make([]NoteMetadata, 0)
	localNotesMap := make(map[string]NoteMetadata)
	cloudNotesMap := make(map[string]NoteMetadata)

	// ローカルノートのマップを作成
	for _, note := range s.noteService.noteList.Notes {
		localNotesMap[note.ID] = note
	}

	// クラウドノートのマップを作成
	for _, note := range cloudNoteList.Notes {
		cloudNotesMap[note.ID] = note
	}

	s.sendLogMessage("Starting note merge process...")

	// マージ処理
	for id, localNote := range localNotesMap {
		if cloudNote, exists := cloudNotesMap[id]; exists {
			// 同じIDのノートが存在する場合
			if localNote.ContentHash != "" && cloudNote.ContentHash != "" &&
				localNote.ContentHash == cloudNote.ContentHash {
				// ハッシュが一致する場合はスキップ
				mergedNotes = append(mergedNotes, localNote)
				delete(cloudNotesMap, id)
				s.sendLogMessage(fmt.Sprintf("Skipping note (identical): %s", localNote.Title))
				continue
			}

			// ハッシュが一致しない場合は更新日時で比較
			if cloudNote.ModifiedTime.After(localNote.ModifiedTime) {
				s.sendLogMessage(fmt.Sprintf("Cloud version is newer: %s", cloudNote.Title))
				mergedNotes = append(mergedNotes, cloudNote)
				if err := s.downloadNote(id); err != nil {
					fmt.Printf("Failed to download note %s: %v\n", id, err)
					s.sendLogMessage(fmt.Sprintf("Failed to download note %s: %v\n", id, err))
					s.auth.handleOfflineTransition(err)
				}

			} else {
				s.sendLogMessage(fmt.Sprintf("Local version is newer: %s", localNote.Title))
				mergedNotes = append(mergedNotes, localNote)
				note, err := s.noteService.LoadNote(id)
				if err == nil {
					if err := s.UploadNote(note); err != nil {
						fmt.Printf("Failed to upload note %s: %v\n", id, err)
						s.sendLogMessage(fmt.Sprintf("Failed to upload note %s: %v\n", id, err))
						s.auth.handleOfflineTransition(err)
					}
				}
			}

			delete(cloudNotesMap, id)
		} else {
			// ローカルにしかないノートはアップロード
			s.sendLogMessage(fmt.Sprintf("Found new local note: %s", localNote.Title))
			mergedNotes = append(mergedNotes, localNote)
			note, err := s.noteService.LoadNote(id)
			if err == nil {
				if err := s.UploadNote(note); err != nil {
					fmt.Printf("Failed to upload note %s: %v\n", id, err)
					s.sendLogMessage(fmt.Sprintf("Failed to upload note %s: %v\n", id, err))
					s.auth.handleOfflineTransition(err)
				}
			}
		}

	}

	// クラウドにしかないノートを追加
	for id, cloudNote := range cloudNotesMap {
		s.sendLogMessage(fmt.Sprintf("Found new cloud note: %s", cloudNote.Title))
		mergedNotes = append(mergedNotes, cloudNote)
		if err := s.downloadNote(id); err != nil {
			fmt.Printf("Failed to download note %s: %v\n", id, err)
			s.sendLogMessage(fmt.Sprintf("Failed to download note %s: %v\n", id, err))
			s.auth.handleOfflineTransition(err)
		}
	}


	s.sendLogMessage("Saving merged note list...")
	s.noteService.noteList.Notes = mergedNotes
	s.noteService.noteList.LastSync = time.Now()
	if err := s.noteService.saveNoteList(); err != nil {
		s.sendLogMessage(fmt.Sprintf("Failed to save merged note list: %v", err))
		s.auth.handleOfflineTransition(err)
		return fmt.Errorf("failed to save merged note list: %v", err)
	}


	s.sendLogMessage("Initial sync completed")


	// フロントエンドに変更を通知
	if !s.IsTestMode() {
		wailsRuntime.EventsEmit(s.ctx, "notes:updated")
		wailsRuntime.EventsEmit(s.ctx, "drive:status", "synced")
		wailsRuntime.EventsEmit(s.ctx, "notes:reload")
	}

	return nil
}

// startSyncPolling はGoogle Driveとの定期的な同期を開始します
func (s *driveService) startSyncPolling() {
	const (
		initialInterval = 30 * time.Second
		maxInterval     = 5 * time.Minute
		factor          = 1.5
	)

	interval := initialInterval
	lastChangeTime := time.Now()

	for {
		if !s.IsConnected() {
			time.Sleep(initialInterval)
			continue
		}

		// 同期開始を通知
		if !s.IsTestMode() {
			wailsRuntime.EventsEmit(s.ctx, "drive:status", "syncing")
		}

		if err := s.SyncNotes(); err != nil {
			fmt.Printf("Error syncing with Drive: %v\n", err)
			// すべてのエラーでオフライン処理を行う
			s.auth.handleOfflineTransition(err)
			continue
		}

		// 変更が検出された場合
		if s.noteService.noteList.LastSync.After(lastChangeTime) {
			interval = initialInterval
			lastChangeTime = s.noteService.noteList.LastSync
			fmt.Printf("Changes detected, resetting interval to %v\n", interval)
			s.sendLogMessage("Syncing: Changes detected")
		} else {
			// 変更がない場合は間隔を増加（最大値まで）
			newInterval := time.Duration(float64(interval) * factor)
			if newInterval > maxInterval {
				newInterval = maxInterval
			}
			if newInterval != interval {
				fmt.Printf("Syncing: No changes detected, increasing interval from %v to %v\n", interval, newInterval)
				s.sendLogMessage("Syncing: No changes detected")
				interval = newInterval
			}


		}

		if !s.IsTestMode() {
			wailsRuntime.EventsEmit(s.ctx, "drive:status", "synced")
		}

		time.Sleep(interval)
	}
}

// uploadAllNotes は全てのローカルノートをGoogle Driveにアップロードします
func (s *driveService) uploadAllNotes() error {
	fmt.Println("Starting uploadAllNotes...")
	s.sendLogMessage("Starting uploadAllNotes...")

	if !s.IsConnected() {
		s.sendLogMessage("Drive service is not initialized")
		s.auth.handleOfflineTransition(fmt.Errorf("drive service is not initialized"))
		return fmt.Errorf("drive service is not initialized")
	}

	fmt.Printf("Found %d notes to upload\n", len(s.noteService.noteList.Notes))
	s.sendLogMessage(fmt.Sprintf("Found %d notes to upload", len(s.noteService.noteList.Notes)))

	// 既存の notes フォルダを削除（再アップロード用）
	s.auth.driveSync.mutex.Lock()
	if s.auth.driveSync.notesFolderID != "" {
		fmt.Printf("Deleting existing notes folder: %s\n", s.auth.driveSync.notesFolderID)
		s.sendLogMessage(fmt.Sprintf("Deleting existing notes folder: %s", s.auth.driveSync.notesFolderID))
		err := s.auth.driveSync.service.Files.Delete(s.auth.driveSync.notesFolderID).Do()
		if err != nil {
			s.auth.driveSync.mutex.Unlock()
			s.sendLogMessage(fmt.Sprintf("Failed to delete notes folder: %v", err))
			s.auth.handleOfflineTransition(err)
			return fmt.Errorf("failed to delete notes folder: %v", err)
		}

		s.auth.driveSync.notesFolderID = ""
	}
	s.auth.driveSync.mutex.Unlock()

	// 再作成
	if err := s.ensureDriveFolders(); err != nil {
		s.sendLogMessage(fmt.Sprintf("Failed to recreate folders: %v", err))
		s.auth.handleOfflineTransition(err)
		return fmt.Errorf("failed to recreate folders: %v", err)
	}


	// すべてのノートをアップロード
	uploadCount := 0
	errorCount := 0
	for _, metadata := range s.noteService.noteList.Notes {
		note, err := s.noteService.LoadNote(metadata.ID)
		if err != nil {
			s.sendLogMessage(fmt.Sprintf("Failed to load note %s: %v", metadata.ID, err))
			fmt.Printf("Failed to load note %s: %v\n", metadata.ID, err)
			errorCount++
			continue
		}

		if err := s.UploadNote(note); err != nil {
			s.sendLogMessage(fmt.Sprintf("Failed to upload note %s: %v", metadata.ID, err))
			fmt.Printf("Failed to upload note %s: %v\n", metadata.ID, err)
			errorCount++
			continue
		}

		uploadCount++
		fmt.Printf("Progress: %d/%d notes uploaded\n", uploadCount, len(s.noteService.noteList.Notes))
		s.sendLogMessage(fmt.Sprintf("Progress: %d/%d notes uploaded", uploadCount, len(s.noteService.noteList.Notes)))
	}

	fmt.Printf("Upload complete: %d succeeded, %d failed\n", uploadCount, errorCount)
	s.sendLogMessage(fmt.Sprintf("Upload complete: %d succeeded, %d failed", uploadCount, errorCount))

	// LastSync を更新してから noteList をアップロード
	s.noteService.noteList.LastSync = time.Now()
	if err := s.UploadNoteList(); err != nil {
		s.sendLogMessage(fmt.Sprintf("Failed to upload note list: %v", err))
		s.auth.handleOfflineTransition(err)
		return fmt.Errorf("failed to upload note list: %v", err)
	}

	if !s.IsTestMode() {
		wailsRuntime.EventsEmit(s.ctx, "drive:status", "synced")
	}

	return nil
}

// downloadNote はGoogle Driveからノートをダウンロードします
func (s *driveService) downloadNote(noteID string) error {
	// ノートファイルを検索
	files, err := s.auth.driveSync.service.Files.List().
		Q(fmt.Sprintf("name='%s.json' and '%s' in parents and trashed=false", noteID, s.auth.driveSync.notesFolderID)).
		Fields("files(id)").Do()
	if err != nil {
		s.sendLogMessage(fmt.Sprintf("Failed to list note file: %v", err))
		s.auth.handleOfflineTransition(err)
		return fmt.Errorf("failed to list note file: %v", err)
	}

	if len(files.Files) == 0 {
		s.sendLogMessage(fmt.Sprintf("Note file not found: %s", noteID))
		s.auth.handleOfflineTransition(fmt.Errorf("note file not found: %s", noteID))
		return fmt.Errorf("note file not found: %s", noteID)
	}

	// ノートファイルをダウンロード
	resp, err := s.auth.driveSync.service.Files.Get(files.Files[0].Id).Download()
	if err != nil {
		s.sendLogMessage(fmt.Sprintf("Failed to download note: %v", err))
		s.auth.handleOfflineTransition(err)
		return fmt.Errorf("failed to download note: %v", err)
	}
	defer resp.Body.Close()

	var note Note
	if err := json.NewDecoder(resp.Body).Decode(&note); err != nil {
		s.sendLogMessage(fmt.Sprintf("Failed to decode note: %v", err))
		s.auth.handleOfflineTransition(err)
		return fmt.Errorf("failed to decode note: %v", err)
	}

	// ノートを保存
	if err := s.noteService.SaveNote(&note); err != nil {
		s.sendLogMessage(fmt.Sprintf("Failed to save note: %v", err))
		s.auth.handleOfflineTransition(err)
		return fmt.Errorf("failed to save note: %v", err)
	}


	// 最終更新時刻を記録
	s.auth.driveSync.lastUpdated[noteID] = time.Now()

	return nil
}

// UploadNote はノートをGoogle Driveにアップロード
func (s *driveService) UploadNote(note *Note) error {
	s.sendLogMessage(fmt.Sprintf("Uploading note \"%s\"...", note.Title))


	if s.IsTestMode() {
		// テストモードの場合は簡略化
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

	noteContent, err := json.MarshalIndent(note, "", "  ")
	if err != nil {
		return s.handleOfflineTransition(err)
	}


	s.auth.driveSync.lastUpdated[note.ID] = time.Now()

	// すでに存在しているかチェック
	files, err := s.auth.driveSync.service.Files.List().
		Q(fmt.Sprintf("name='%s.json' and '%s' in parents and trashed=false", note.ID, s.auth.driveSync.notesFolderID)).
		Fields("files(id)").Do()
	if err != nil {
		return s.handleOfflineTransition(err)
	}


	if len(files.Files) > 0 {
		// Update
		file := files.Files[0]
		_, err = s.auth.driveSync.service.Files.Update(file.Id, &drive.File{}).
			Media(bytes.NewReader(noteContent)).
			Do()
		if err == nil {
			s.sendLogMessage(fmt.Sprintf("Uploaded note \"%s\"", note.Title))
		}
		return err

	}

	// Create
	f := &drive.File{
		Name:     note.ID + ".json",
		Parents:  []string{s.auth.driveSync.notesFolderID},
		MimeType: "application/json",
	}
	_, err = s.auth.driveSync.service.Files.Create(f).
		Media(bytes.NewReader(noteContent)).
		Do()
	if err == nil {
		s.sendLogMessage(fmt.Sprintf("Uploaded note \"%s\"", note.Title))
	}
	return err

}

// DeleteNoteDrive はGoogle Drive上のノートを削除
func (s *driveService) DeleteNoteDrive(noteID string) error {
	s.sendLogMessage("Deleting note from cloud...")
	

	if s.IsTestMode() {
		var updatedNotes []NoteMetadata
		for _, metadata := range s.auth.driveSync.cloudNoteList.Notes {
			if metadata.ID != noteID {
				updatedNotes = append(updatedNotes, metadata)
			}
		}
		s.auth.driveSync.cloudNoteList.Notes = updatedNotes
		return nil
	}

	files, err := s.auth.driveSync.service.Files.List().
		Q(fmt.Sprintf("name='%s.json' and '%s' in parents and trashed=false", noteID, s.auth.driveSync.notesFolderID)).
		Fields("files(id)").Do()
	if err != nil {
		return s.handleOfflineTransition(err)
	}


	if len(files.Files) > 0 {
		return s.auth.driveSync.service.Files.Delete(files.Files[0].Id).Do()
	}
	s.sendLogMessage("Deleted note from cloud")
	return nil
}


// UploadNoteList は現在のノートリスト(noteList.json)をアップロード
func (s *driveService) UploadNoteList() error {
	s.sendLogMessage("Uploading note list...")
	fmt.Printf("Uploading note list with LastSync: %v\n", s.noteService.noteList.LastSync)
	s.sendLogMessage(fmt.Sprintf("Uploading note list with LastSync: %v", s.noteService.noteList.LastSync))
	fmt.Printf("Notes count: %d\n", len(s.noteService.noteList.Notes))
	s.sendLogMessage(fmt.Sprintf("Notes count: %d", len(s.noteService.noteList.Notes)))


	s.auth.driveSync.mutex.Lock()
	defer s.auth.driveSync.mutex.Unlock()

	if s.IsTestMode() {
		s.auth.driveSync.cloudNoteList = &NoteList{
			Version:  s.noteService.noteList.Version,
			Notes:    make([]NoteMetadata, len(s.noteService.noteList.Notes)),
			LastSync: time.Now(),
		}
		copy(s.auth.driveSync.cloudNoteList.Notes, s.noteService.noteList.Notes)
		s.sendLogMessage("Note list uploaded (test mode)")
		return nil
	}

	noteListContent, err := json.MarshalIndent(s.noteService.noteList, "", "  ")
	if err != nil {
		return err
	}

	// すでに存在しているかチェック
	files, err := s.auth.driveSync.service.Files.List().
		Q(fmt.Sprintf("name='noteList.json' and '%s' in parents and trashed=false", s.auth.driveSync.rootFolderID)).
		Fields("files(id)").Do()
	if err != nil {
		return s.handleOfflineTransition(err)
	}

	if len(files.Files) > 0 {
		file := files.Files[0]
		fmt.Printf("Updating existing note list file: %s\n", file.Id)
		s.sendLogMessage(fmt.Sprintf("Updating existing note list file: %s", file.Id))
		_, err = s.auth.driveSync.service.Files.Update(file.Id, &drive.File{}).
			Media(bytes.NewReader(noteListContent)).
			Do()

		if err == nil {
			s.sendLogMessage("Note list uploaded")
			if !s.IsTestMode() {
				wailsRuntime.EventsEmit(s.ctx, "drive:status", "synced")
			}
		}
		return err
	}

	// 新規作成
	f := &drive.File{
		Name:     "noteList.json",
		Parents:  []string{s.auth.driveSync.rootFolderID},
		MimeType: "application/json",
	}
	_, err = s.auth.driveSync.service.Files.Create(f).
		Media(bytes.NewReader(noteListContent)).
		Do()
	if err == nil {
		s.sendLogMessage("Note list uploaded")
		if !s.IsTestMode() {
			wailsRuntime.EventsEmit(s.ctx, "drive:status", "synced")
		}
	}
	return err
}

// SyncNotes はGoogle Driveとの同期を実行します
func (s *driveService) SyncNotes() error {
	fmt.Println("Starting sync with Drive...")
	s.sendLogMessage("Starting sync with Drive...")

	// テストモードの場合は特別な処理
	if s.IsTestMode() {
		if s.auth.driveSync.cloudNoteList == nil {
			return fmt.Errorf("cloud note list is nil")
		}
		s.auth.driveSync.isConnected = true // テストモードでは常に接続状態とする
		return s.syncCloudToLocal(s.auth.driveSync.cloudNoteList)
	}

	if !s.IsConnected() {
		s.sendLogMessage("Not connected to Google Drive")
		s.auth.handleOfflineTransition(fmt.Errorf("not connected to Google Drive"))
		return fmt.Errorf("not connected to Google Drive")
	}

	// クラウドのノートリストを取得
	noteListFiles, err := s.auth.driveSync.service.Files.List().
		Q(fmt.Sprintf("name='noteList.json' and '%s' in parents and trashed=false", s.auth.driveSync.rootFolderID)).
		Fields("files(id)").Do()
	if err != nil {
		return s.handleOfflineTransition(err)
	}

	var cloudNoteList *NoteList
	if len(noteListFiles.Files) > 0 {
		resp, err := s.auth.driveSync.service.Files.Get(noteListFiles.Files[0].Id).Download()
		if err != nil {
			s.auth.driveSync.isConnected = false
			s.sendLogMessage(fmt.Sprintf("Failed to download cloud noteList: %v", err))
			return fmt.Errorf("failed to download cloud noteList: %v", err)
		}
		defer resp.Body.Close()

		if err := json.NewDecoder(resp.Body).Decode(&cloudNoteList); err != nil {
			s.sendLogMessage(fmt.Sprintf("Failed to decode cloud noteList: %v", err))
			return fmt.Errorf("failed to decode cloud noteList: %v", err)
		}
	}

	if cloudNoteList == nil {
		fmt.Println("Cloud note list is nil, uploading all notes...")
		s.sendLogMessage("Cloud note list is nil, uploading all notes...")
		return s.uploadAllNotes()
	}

	fmt.Printf("Cloud note list LastSync: %v\n", cloudNoteList.LastSync)
	fmt.Printf("Local note list LastSync: %v\n", s.noteService.noteList.LastSync)
	fmt.Printf("Cloud notes count: %d\n", len(cloudNoteList.Notes))
	fmt.Printf("Local notes count: %d\n", len(s.noteService.noteList.Notes))

	hasChanges := false

	// ノートリストの内容が異なるかどうかをチェック
	if cloudNoteList.LastSync.After(s.noteService.noteList.LastSync) ||
		s.hasNoteListChanged(cloudNoteList.Notes, s.noteService.noteList.Notes) {
		fmt.Println("Cloud has updates - updating local state")
		s.sendLogMessage("Cloud has updates - updating local state")
		s.noteService.noteList.Notes = cloudNoteList.Notes
		hasChanges = true
	} else {
		fmt.Printf("Local is up to date\n")
		s.sendLogMessage("Local is up to date")
	}

	// 個別のノートの同期処理
	for _, cloudNote := range cloudNoteList.Notes {
		localNote, err := s.noteService.LoadNote(cloudNote.ID)
		if err != nil {
			// ローカルにないノートはダウンロード
			if !s.IsTestMode() {
				if err := s.downloadNote(cloudNote.ID); err != nil {
					fmt.Printf("Error downloading note %s: %v\n", cloudNote.ID, err)
					s.sendLogMessage(fmt.Sprintf("Error downloading note %s: %v", cloudNote.ID, err))
					continue
				}
			} else {
				// テストモードの場合は、クラウドの内容で新しいノートを作成
				newNote := &Note{
					ID:           cloudNote.ID,
					Title:        cloudNote.Title,
					Content:      "Cloud content",
					Language:     "plaintext",
					ModifiedTime: cloudNote.ModifiedTime,
				}
				if err := s.noteService.SaveNote(newNote); err != nil {
					fmt.Printf("Error creating note %s: %v\n", cloudNote.ID, err)
					s.sendLogMessage(fmt.Sprintf("Error creating note %s: %v", cloudNote.ID, err))
					continue
				}
			}
			hasChanges = true
		} else if cloudNote.ModifiedTime.After(localNote.ModifiedTime) {
			// クラウドの方が新しい場合は更新
			if !s.IsTestMode() {
				if err := s.downloadNote(cloudNote.ID); err != nil {
					fmt.Printf("Error downloading note %s: %v\n", cloudNote.ID, err)
					s.sendLogMessage(fmt.Sprintf("Error downloading note %s: %v", cloudNote.ID, err))
					continue
				}
			} else {
				// テストモードの場合は、クラウドの内容で更新
				localNote.Title = cloudNote.Title
				localNote.Content = "Cloud content"
				localNote.ModifiedTime = cloudNote.ModifiedTime
				if err := s.noteService.SaveNote(localNote); err != nil {
					fmt.Printf("Error updating note %s: %v\n", cloudNote.ID, err)
					s.sendLogMessage(fmt.Sprintf("Error updating note %s: %v", cloudNote.ID, err))
					continue
				}
				// 更新後、対応するノートリストのメタデータも更新する
				for i, meta := range s.noteService.noteList.Notes {
					if meta.ID == cloudNote.ID {
						s.noteService.noteList.Notes[i].Title = cloudNote.Title
						break
					}
				}
			}
			hasChanges = true
		}
	}

	// ローカルのノートリストを更新
	if hasChanges {
		s.noteService.noteList.LastSync = time.Now()
		if err := s.noteService.saveNoteList(); err != nil {
			s.sendLogMessage(fmt.Sprintf("Failed to save local note list: %v", err))
			s.auth.handleOfflineTransition(err)
			return fmt.Errorf("failed to save local note list: %v", err)
		}

		// 変更があった場合のみフロントエンドに通知
		if !s.IsTestMode() {
			fmt.Println("Notifying frontend of changes")
			wailsRuntime.EventsEmit(s.ctx, "notes:reload")
		}

		s.sendLogMessage("Synced changes from cloud")
	}


	return nil
}

// syncCloudToLocal はクラウドの変更をローカルに同期します
func (s *driveService) syncCloudToLocal(cloudNoteList *NoteList) error {
	if cloudNoteList == nil {
		s.sendLogMessage("Cloud note list is nil")
		return fmt.Errorf("cloud note list is nil")
	}

	// ノートリストの内容が異なるかどうかをチェック
	if cloudNoteList.LastSync.After(s.noteService.noteList.LastSync) ||
		s.hasNoteListChanged(cloudNoteList.Notes, s.noteService.noteList.Notes) {
		fmt.Println("Cloud has updates - updating local state")
		s.sendLogMessage("Cloud has updates - updating local state")

		// クラウドのノートリストをローカルにコピー
		s.noteService.noteList.Notes = make([]NoteMetadata, len(cloudNoteList.Notes))
		copy(s.noteService.noteList.Notes, cloudNoteList.Notes)
		s.noteService.noteList.LastSync = cloudNoteList.LastSync

		// テストモードでない場合は、各ノートの内容も更新
		if !s.IsTestMode() {
			for _, cloudNote := range cloudNoteList.Notes {
				localNote, err := s.noteService.LoadNote(cloudNote.ID)
				if err != nil || localNote.ModifiedTime.Before(cloudNote.ModifiedTime) {
					if err := s.downloadNote(cloudNote.ID); err != nil {
						fmt.Printf("Error downloading note %s: %v\n", cloudNote.ID, err)
						s.sendLogMessage(fmt.Sprintf("Error downloading note %s: %v", cloudNote.ID, err))
					}

				}
			}
		} else {
			// テストモード時は、ノートの内容を模擬的に更新
			for _, cloudNote := range cloudNoteList.Notes {
				note := &Note{
					ID:           cloudNote.ID,
					Title:        cloudNote.Title,
					Content:      "Cloud content",
					Language:     cloudNote.Language,
					ModifiedTime: cloudNote.ModifiedTime,
				}
				if err := s.noteService.SaveNote(note); err != nil {
					fmt.Printf("Error saving note %s: %v\n", cloudNote.ID, err)
					s.sendLogMessage(fmt.Sprintf("Error saving note %s: %v", cloudNote.ID, err))
				}

			}
		}

		// ノートリストを保存
		if err := s.noteService.saveNoteList(); err != nil {
			s.sendLogMessage(fmt.Sprintf("Failed to save note list: %v", err))
			s.auth.handleOfflineTransition(err)
			return fmt.Errorf("failed to save note list: %v", err)
		}


		// フロントエンドに変更を通知
		if !s.IsTestMode() {
			wailsRuntime.EventsEmit(s.ctx, "notes:reload")
		}
	} else {
		fmt.Printf("Local is up to date\n")
		s.sendLogMessage("Local is up to date")
	}


	return nil
}

// hasNoteListChanged はノートリストの内容が異なるかどうかをチェック
func (s *driveService) hasNoteListChanged(cloudList, localList []NoteMetadata) bool {
	if len(cloudList) != len(localList) {
		fmt.Println("Note list length differs")
		s.sendLogMessage("Note list length differs")
		return true
	}

	
	// ノートの順序とIDを比較
	for i := range cloudList {
		if cloudList[i].ID != localList[i].ID || 
		   cloudList[i].Order != localList[i].Order {
			fmt.Printf("Note order differs at index %d (cloud: %s[%d], local: %s[%d])\n",
				i, cloudList[i].ID, cloudList[i].Order,
				localList[i].ID, localList[i].Order)
			s.sendLogMessage(fmt.Sprintf("Note order differs at index %d (cloud: %s[%d], local: %s[%d])",
				i, cloudList[i].ID, cloudList[i].Order,
				localList[i].ID, localList[i].Order))
			return true
		}

	}
	return false
}

// ------------------------------------------------------------
// 内部ヘルパー
// ------------------------------------------------------------

// sendLogMessage はログメッセージをフロントエンドに通知する
func (s *driveService) sendLogMessage(message string) {
	if !s.IsTestMode() {
		wailsRuntime.EventsEmit(s.ctx, "logMessage", message)
	}
}

// ensureDriveFolders はGoogle Drive上に必要なフォルダ構造を作成します
func (s *driveService) ensureDriveFolders() error {
	s.auth.driveSync.mutex.Lock()
	defer s.auth.driveSync.mutex.Unlock()

	// ルートフォルダ
	rootFolder, err := s.auth.driveSync.service.Files.List().
		Q("name='monaco-notepad' and mimeType='application/vnd.google-apps.folder' and trashed=false").
		Fields("files(id)").Do()
	if err != nil {
		return fmt.Errorf("failed to check root folder: %v", err)
	}

	if len(rootFolder.Files) == 0 {
		folderMetadata := &drive.File{
			Name:     "monaco-notepad",
			MimeType: "application/vnd.google-apps.folder",
		}
		folder, err := s.auth.driveSync.service.Files.Create(folderMetadata).Fields("id").Do()
		if err != nil {
			return fmt.Errorf("failed to create root folder: %v", err)
		}
		s.auth.driveSync.rootFolderID = folder.Id
	} else {
		s.auth.driveSync.rootFolderID = rootFolder.Files[0].Id
	}

	// notes フォルダ
	notesFolder, err := s.auth.driveSync.service.Files.List().
		Q(fmt.Sprintf("name='notes' and '%s' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false", s.auth.driveSync.rootFolderID)).
		Fields("files(id)").Do()
	if err != nil {
		return fmt.Errorf("failed to check notes folder: %v", err)
	}

	if len(notesFolder.Files) == 0 {
		folderMetadata := &drive.File{
			Name:     "notes",
			Parents:  []string{s.auth.driveSync.rootFolderID},
			MimeType: "application/vnd.google-apps.folder",
		}
		folder, err := s.auth.driveSync.service.Files.Create(folderMetadata).Fields("id").Do()
		if err != nil {
			return fmt.Errorf("failed to create notes folder: %v", err)
		}
		s.auth.driveSync.notesFolderID = folder.Id
	} else {
		s.auth.driveSync.notesFolderID = notesFolder.Files[0].Id
	}

	return nil
}

// loadStartPageToken は保存されている startPageToken を読み込み、なければ新規取得
func (s *driveService) loadStartPageToken() error {
	tokenPath := filepath.Join(s.appDataDir, "pageToken.txt")
	if data, err := os.ReadFile(tokenPath); err == nil {
		s.auth.driveSync.startPageToken = string(data)
		fmt.Println("Loaded saved page token:", s.auth.driveSync.startPageToken)
	} else {
		// 新規取得
		token, err := s.auth.driveSync.service.Changes.GetStartPageToken().Do()
		if err != nil {
			s.sendLogMessage(fmt.Sprintf("Failed to get start page token: %v", err))
			// ログアウト処理を行う
			s.auth.handleOfflineTransition(err)
			return fmt.Errorf("failed to get start page token: %v", err)
		}
		s.auth.driveSync.startPageToken = token.StartPageToken
		if err := os.WriteFile(tokenPath, []byte(token.StartPageToken), 0644); err != nil {
			fmt.Printf("Failed to save page token: %v\n", err)
		}
	}
	return nil
}

// handleOfflineTransition はオフライン状態への遷移を処理します
func (s *driveService) handleOfflineTransition(err error) error {
	// エラーメッセージをログに記録
	errMsg := fmt.Sprintf("Drive error: %v", err)
	s.sendLogMessage(errMsg)
	
	// トークンファイルのパス
	tokenFile := filepath.Join(s.appDataDir, "token.json")
	
	// トークンファイルを削除
	if err := os.Remove(tokenFile); err != nil && !os.IsNotExist(err) {
		s.sendLogMessage(fmt.Sprintf("Failed to remove token file: %v", err))
	}
	
	// 認証状態をリセット
	s.auth.driveSync.service = nil
	s.auth.driveSync.isConnected = false
	
	// フロントエンドに通知
	if !s.IsTestMode() {
		wailsRuntime.EventsEmit(s.ctx, "drive:error", "Sync failed. Please login again." + errMsg)
		wailsRuntime.EventsEmit(s.ctx, "drive:status", "offline")
	}
	

	return fmt.Errorf("sync error: %v", err)
}
