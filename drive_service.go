package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"google.golang.org/api/drive/v3"
	"google.golang.org/api/option"
)

// Google Drive関連の操作を提供するインターフェース
type DriveService interface {
	InitializeDrive() error //Google Drive APIの初期化
	AuthorizeDrive() (string, error) //Google Driveの認証フローを開始
	CompleteAuth(code string) error //認証コードを使用してGoogle Drive認証を完了
	LogoutDrive() error //Google Driveからログアウト
	UploadNote(note *Note) error //ノートをGoogle Driveにアップロード
	DeleteNoteDrive(noteID string) error //Google Driveからノートを削除
	SyncNotes() error //Google Driveとの定期的な同期
}

// driveService はDriveServiceの実装です
type driveService struct {
	ctx           context.Context
	appDataDir    string
	notesDir      string
	noteService   *noteService
	driveSync     *DriveSync
	frontendReady chan struct{}
	credentials   []byte
}

// NewDriveService は新しいdriveServiceインスタンスを作成します
func NewDriveService(ctx context.Context, appDataDir string, notesDir string, noteService *noteService, credentials []byte) *driveService {
	return &driveService{
		ctx:           ctx,
		appDataDir:    appDataDir,
		notesDir:      notesDir,
		noteService:   noteService,
		frontendReady: make(chan struct{}),
		credentials:   credentials,
		driveSync:     &DriveSync{
			lastUpdated: make(map[string]time.Time),
			cloudNoteList: &NoteList{
				Version: "1.0",
				Notes:   []NoteMetadata{},
			},
		},
	}
}

// InitializeDrive はGoogle Drive APIの初期化を行います
func (s *driveService) InitializeDrive() error {
	config, err := google.ConfigFromJSON(s.credentials, drive.DriveFileScope)
	if err != nil {
		return fmt.Errorf("unable to parse client secret file to config: %v", err)
	}

	// リダイレクトURIを設定
	config.RedirectURL = "http://localhost:34115/oauth2callback"
	
	s.driveSync.config = config

	// 保存済みのトークンがあれば自動的に接続を試みる
	tokenFile := filepath.Join(s.appDataDir, "token.json")
	if _, err := os.Stat(tokenFile); err == nil {
		wailsRuntime.EventsEmit(s.ctx, "drive:status", "syncing")

		data, err := os.ReadFile(tokenFile)
		if err != nil {
			fmt.Printf("Error reading token file: %v\n", err)
			wailsRuntime.EventsEmit(s.ctx, "drive:status", "offline")
			return err
		}

		var token oauth2.Token
		if err := json.Unmarshal(data, &token); err != nil {
			fmt.Printf("Error parsing token: %v\n", err)
			wailsRuntime.EventsEmit(s.ctx, "drive:status", "offline")
			return err
		}

		if err := s.initializeDriveService(&token); err != nil {
			fmt.Printf("Error initializing Drive service: %v\n", err)
			wailsRuntime.EventsEmit(s.ctx, "drive:status", "offline")
			return err
		}
	}

	return nil
}

// AuthorizeDrive はGoogle Driveの認証フローを開始します
func (s *driveService) AuthorizeDrive() (string, error) {
	if s.driveSync.config == nil {
		if err := s.InitializeDrive(); err != nil {
			return "", err
		}
	}

	wailsRuntime.EventsEmit(s.ctx, "drive:status", "syncing")

	// 認証コードを受け取るためのチャネル
	codeChan := make(chan string, 1)
	timeoutChan := make(chan struct{}, 1)

	// 一時的なHTTPサーバーを起動
	server := &http.Server{Addr: ":34115"}
	http.HandleFunc("/oauth2callback", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-timeoutChan:
			// タイムアウト済みの場合はエラーページを表示
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprintf(w, `
				<html>
					<head>
						<title>Authentication Error</title>
						<style>
							body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
							.container { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
							.message-box { text-align: center; width: 400px; padding: 2rem; background-color: grey; border-radius: 8px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); }
							.error { color: #d32f2f; }
						</style>
					</head>
					<body>
						<div class="container">
							<div class="message-box">
								<h3 class="error">Authentication Error</h3>
								<p>Authentication timed out.</p>
								<p>Please try again.</p>
							</div>
						</div>
					</body>
				</html>
			`)
			return
		default:
			code := r.URL.Query().Get("code")
			if code != "" {
				codeChan <- code
				// 認証完了ページを表示
				w.Header().Set("Content-Type", "text/html")
				fmt.Fprintf(w, `
					<html>
						<head>
							<title>Authentication Complete</title>
							<style>
								body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
								.container { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
								.message-box { text-align: center; width: 400px; padding: 2rem; background-color: #00c1d9; border-radius: 8px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); }
								.error { color: #d32f2f; }
							</style>
						</head>
						<body>
							<div class="container">
								<div class="message-box">
									<h3>Authentication Complete!</h3>
									<p>You can close this window and return to the app.</p>
								</div>
							</div>
						</body>
					</html>
				`)
			} else {
				// エラーページを表示
				w.Header().Set("Content-Type", "text/html")
				fmt.Fprintf(w, `
					<html>
						<head>
							<title>Authentication Error</title>
							<style>
								body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
								.container { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
								.message-box { text-align: center; width: 400px; padding: 2rem; background-color: #00c1d9; border-radius: 8px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); }
								.error { color: #d32f2f; }
							</style>
						</head>
						<body>
							<div class="container">
								<div class="message-box">
									<h3 class="error">Authentication Error</h3>
									<p>Authentication timed out.</p>
									<p>Please try again.</p>
								</div>
							</div>
						</body>
					</html>
				`)
			}
		}
	})

	// サーバーを別のゴルーチンで起動
	go func() {
		if err := server.ListenAndServe(); err != http.ErrServerClosed {
			fmt.Printf("HTTP Server error: %v\n", err)
		}
	}()

	// 認証URLを開く
	authURL := s.driveSync.config.AuthCodeURL("state-token", oauth2.AccessTypeOffline)
	wailsRuntime.BrowserOpenURL(s.ctx, authURL)

	// 認証コードを待機
	select {
	case code := <-codeChan:
		// サーバーをシャットダウン
		server.Shutdown(s.ctx)
		// 認証を完了
		if err := s.CompleteAuth(code); err != nil {
			wailsRuntime.EventsEmit(s.ctx, "show-message", "Authentication Error", fmt.Sprintf("Failed to complete authentication: %v", err), false)
			return "", fmt.Errorf("failed to complete authentication: %v", err)
		}
		return "auth_complete", nil
	case <-time.After(1 * time.Minute):
		// タイムアウト
		server.Shutdown(s.ctx)
		s.handleOfflineTransition()
		wailsRuntime.EventsEmit(s.ctx, "drive:status", "offline")
		wailsRuntime.EventsEmit(s.ctx, "show-message", "Authentication Error", "Authentication timed out. Please try again.", false)
		return "", fmt.Errorf("authentication timed out, please try again")
	}
}

// CompleteAuth は認証コードを使用してGoogle Drive認証を完了します
func (s *driveService) CompleteAuth(code string) error {
	fmt.Printf("Completing auth with code: %s\n", code)
	
	token, err := s.driveSync.config.Exchange(s.ctx, code)
	if err != nil {
		return fmt.Errorf("unable to retrieve token from web: %v", err)
	}

	fmt.Printf("Received token: %+v\n", token)

	// Save the token
	tokenFile := filepath.Join(s.appDataDir, "token.json")
	f, err := os.OpenFile(tokenFile, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("unable to cache oauth token: %v", err)
	}
	defer f.Close()
	
	if err := json.NewEncoder(f).Encode(token); err != nil {
		return fmt.Errorf("failed to encode token: %v", err)
	}

	fmt.Printf("Token saved to: %s\n", tokenFile)
	return s.initializeDriveService(token)
}

// Logout はGoogle Driveからログアウトします
func (s *driveService) LogoutDrive() error {
	fmt.Println("Logging out from Google Drive...")

	// 現在のノートの変更を保存
	if err := s.noteService.saveNoteList(); err != nil {
		fmt.Printf("Failed to save note list before logout: %v\n", err)
	}

	// オフライン状態に遷移
	s.handleOfflineTransition()

	return nil
}

// handleOfflineTransition はオフライン状態への遷移を処理します
func (s *driveService) handleOfflineTransition() {
	fmt.Println("Transitioning to offline state...")
	s.driveSync.isConnected = false
	s.driveSync.service = nil
	s.driveSync.token = nil
	s.driveSync.startPageToken = ""

	// 認証関連ファイルを削除
	tokenFile := filepath.Join(s.appDataDir, "token.json")
	if err := os.Remove(tokenFile); err != nil && !os.IsNotExist(err) {
		fmt.Printf("Failed to remove token file: %v\n", err)
	}

	syncFlagFile := filepath.Join(s.appDataDir, "initial_sync_completed")
	if err := os.Remove(syncFlagFile); err != nil && !os.IsNotExist(err) {
		fmt.Printf("Failed to remove sync flag file: %v\n", err)
	}

	pageTokenFile := filepath.Join(s.appDataDir, "pageToken.txt")
	if err := os.Remove(pageTokenFile); err != nil && !os.IsNotExist(err) {
		fmt.Printf("Failed to remove page token file: %v\n", err)
	}

	// フロントエンドに通知
	wailsRuntime.EventsEmit(s.ctx, "drive:status", "offline")
}

// initializeDriveService はDriveサービスを初期化します
func (s *driveService) initializeDriveService(token *oauth2.Token) error {
	// トークンソースを作成（自動更新用）
	tokenSource := s.driveSync.config.TokenSource(s.ctx, token)

	// 自動更新されるクライアントを作成
	client := oauth2.NewClient(s.ctx, tokenSource)
	srv, err := drive.NewService(s.ctx, option.WithHTTPClient(client))
	if err != nil {
		return fmt.Errorf("unable to retrieve Drive client: %v", err)
	}

	s.driveSync.service = srv
	s.driveSync.token = token
	s.driveSync.isConnected = true

	// フロントエンドの準備完了を待ってから同期処理を開始
	go func() {
		// フロントエンドの準備完了を待つ
		<-s.frontendReady

		// 最初のポーリングまで少し待機
		time.Sleep(1 * time.Second)

		// Start sync polling
		s.startSyncPolling()

		// 初期化完了時は同期済み状態として通知
		wailsRuntime.EventsEmit(s.ctx, "drive:status", "synced")
	}()

	// Ensure the app folders exist in Drive
	if err := s.ensureDriveFolders(); err != nil {
		return err
	}

	// 初回同期フラグをチェック
	syncFlagPath := filepath.Join(s.appDataDir, "initial_sync_completed")
	if _, err := os.Stat(syncFlagPath); os.IsNotExist(err) {
		// 初回同期を実行
		fmt.Println("First time initialization - performing initial sync...")
		if err := s.performInitialSync(); err != nil {
			fmt.Printf("Initial sync failed: %v\n", err)
		} else {
			// 初回同期完了フラグを保存
			if err := os.WriteFile(syncFlagPath, []byte("1"), 0644); err != nil {
				fmt.Printf("Failed to save initial sync flag: %v\n", err)
			}
			s.driveSync.hasCompletedInitialSync = true
		}
	} else {
		s.driveSync.hasCompletedInitialSync = true
	}

	// Load saved start page token
	tokenPath := filepath.Join(s.appDataDir, "pageToken.txt")
	if data, err := os.ReadFile(tokenPath); err == nil {
		s.driveSync.startPageToken = string(data)
		fmt.Println("Loaded saved page token:", s.driveSync.startPageToken)
	} else {
		// Get new start page token
		token, err := s.driveSync.service.Changes.GetStartPageToken().Do()
		if err != nil {
			fmt.Printf("Failed to get start page token: %v\n", err)
		} else {
			s.driveSync.startPageToken = token.StartPageToken
			// Save the token
			if err := os.WriteFile(tokenPath, []byte(token.StartPageToken), 0644); err != nil {
				fmt.Printf("Failed to save page token: %v\n", err)
			}
		}
	}

	return nil
}

// startSyncPolling はGoogle Driveとの定期的な同期を開始します
func (s *driveService) startSyncPolling() {
	const (
		initialInterval = 30 * time.Second
		maxInterval     = 5 * time.Minute
		factor         = 1.5
	)

	interval := initialInterval
	lastChangeTime := time.Now()

	for {
		if !s.driveSync.isConnected {
			time.Sleep(initialInterval)
			continue
		}

		// 同期開始を通知
		wailsRuntime.EventsEmit(s.ctx, "drive:status", "syncing")

		// 同期を実行
		if err := s.SyncNotes(); err != nil {
			fmt.Printf("Error syncing with Drive: %v\n", err)
			if strings.Contains(err.Error(), "oauth2") || 
			   strings.Contains(err.Error(), "401") ||
			   strings.Contains(err.Error(), "403") {
				// 認証エラーの場合はオフライン状態に遷移
				s.handleOfflineTransition()
				continue
			}
			wailsRuntime.EventsEmit(s.ctx, "drive:error", err.Error())
		} else {
			// 変更が検出された場合
			if s.noteService.noteList.LastSync.After(lastChangeTime) {
				interval = initialInterval
				lastChangeTime = s.noteService.noteList.LastSync
				fmt.Printf("Changes detected, resetting interval to %v\n", interval)
			} else {
				// 変更がない場合は間隔を増加（最大値まで）
				newInterval := time.Duration(float64(interval) * factor)
				if newInterval > maxInterval {
					newInterval = maxInterval
				}
				if newInterval != interval {
					fmt.Printf("No changes detected, increasing interval from %v to %v\n", interval, newInterval)
					wailsRuntime.EventsEmit(s.ctx, "drive:status", "synced")
					interval = newInterval
				}
			}
		}

		// 同期完了を通知
		wailsRuntime.EventsEmit(s.ctx, "drive:status", "synced")

		time.Sleep(interval)
	}
}

// ensureDriveFolders はGoogle Drive上に必要なフォルダ構造を作成します
func (s *driveService) ensureDriveFolders() error {
	s.driveSync.mutex.Lock()
	defer s.driveSync.mutex.Unlock()

	// Check for root folder
	fmt.Println("Checking for root folder...")
	rootFolder, err := s.driveSync.service.Files.List().
		Q("name='monaco-notepad' and mimeType='application/vnd.google-apps.folder' and trashed=false").
		Fields("files(id)").Do()
	if err != nil {
		return fmt.Errorf("failed to check root folder: %v", err)
	}

	if len(rootFolder.Files) == 0 {
		// Create root folder
		folderMetadata := &drive.File{
			Name:     "monaco-notepad",
			MimeType: "application/vnd.google-apps.folder",
		}
		folder, err := s.driveSync.service.Files.Create(folderMetadata).Fields("id").Do()
		if err != nil {
			return fmt.Errorf("failed to create root folder: %v", err)
		}
		s.driveSync.rootFolderID = folder.Id
	} else {
		s.driveSync.rootFolderID = rootFolder.Files[0].Id
	}

	// Check for notes folder
	notesFolder, err := s.driveSync.service.Files.List().
		Q(fmt.Sprintf("name='notes' and '%s' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false", s.driveSync.rootFolderID)).
		Fields("files(id)").Do()
	if err != nil {
		return fmt.Errorf("failed to check notes folder: %v", err)
	}

	if len(notesFolder.Files) == 0 {
		// Create notes folder
		folderMetadata := &drive.File{
			Name:     "notes",
			Parents:  []string{s.driveSync.rootFolderID},
			MimeType: "application/vnd.google-apps.folder",
		}
		folder, err := s.driveSync.service.Files.Create(folderMetadata).Fields("id").Do()
		if err != nil {
			return fmt.Errorf("failed to create notes folder: %v", err)
		}
		s.driveSync.notesFolderID = folder.Id
	} else {
		s.driveSync.notesFolderID = notesFolder.Files[0].Id
	}

	return nil
}

// performInitialSync は初回接続時のマージ処理を実行します
func (s *driveService) performInitialSync() error {
	fmt.Println("Starting initial sync...")

	// クラウドのノートリストを取得
	noteListFiles, err := s.driveSync.service.Files.List().
		Q(fmt.Sprintf("name='noteList.json' and '%s' in parents and trashed=false", s.driveSync.rootFolderID)).
		Fields("files(id)").Do()
	if err != nil {
		return fmt.Errorf("failed to list cloud noteList: %v", err)
	}

	var cloudNoteList *NoteList
	if len(noteListFiles.Files) > 0 {
		resp, err := s.driveSync.service.Files.Get(noteListFiles.Files[0].Id).Download()
		if err != nil {
			return fmt.Errorf("failed to download cloud noteList: %v", err)
		}
		defer resp.Body.Close()

		if err := json.NewDecoder(resp.Body).Decode(&cloudNoteList); err != nil {
			return fmt.Errorf("failed to decode cloud noteList: %v", err)
		}
	}

	if cloudNoteList == nil {
		// クラウドにノートリストがない場合は、ローカルのノートをすべてアップロード
		return s.uploadAllNotes()
	}

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

	// マージ処理
	for id, localNote := range localNotesMap {
		if cloudNote, exists := cloudNotesMap[id]; exists {
			// 同じIDのノートが存在する場合、新しい方を採用
			if cloudNote.ModifiedTime.After(localNote.ModifiedTime) {
				mergedNotes = append(mergedNotes, cloudNote)
				// クラウドのノートをダウンロード
				if err := s.downloadNote(id); err != nil {
					fmt.Printf("Failed to download note %s: %v\n", id, err)
				}
			} else {
				mergedNotes = append(mergedNotes, localNote)
				// ローカルのノートをアップロード
				note, err := s.noteService.LoadNote(id)
				if err == nil {
					if err := s.UploadNote(note); err != nil {
						fmt.Printf("Failed to upload note %s: %v\n", id, err)
					}
				}
			}
			delete(cloudNotesMap, id)
		} else {
			// ローカルにしかないノートはアップロード
			mergedNotes = append(mergedNotes, localNote)
			note, err := s.noteService.LoadNote(id)
			if err == nil {
				if err := s.UploadNote(note); err != nil {
					fmt.Printf("Failed to upload note %s: %v\n", id, err)
				}
			}
		}
	}

	// クラウドにしかないノートを追加
	for id, cloudNote := range cloudNotesMap {
		mergedNotes = append(mergedNotes, cloudNote)
		// ノートをダウンロード
		if err := s.downloadNote(id); err != nil {
			fmt.Printf("Failed to download note %s: %v\n", id, err)
		}
	}

	// マージしたノートリストを保存
	s.noteService.noteList.Notes = mergedNotes
	s.noteService.noteList.LastSync = time.Now()
	if err := s.noteService.saveNoteList(); err != nil {
		return fmt.Errorf("failed to save merged note list: %v", err)
	}

	// フロントエンドに変更を通知
	wailsRuntime.EventsEmit(s.ctx, "notes:updated")
	wailsRuntime.EventsEmit(s.ctx, "drive:status", "synced")
	wailsRuntime.EventsEmit(s.ctx, "notes:reload")

	return nil
}

// uploadAllNotes は全てのローカルノートをGoogle Driveにアップロードします
func (s *driveService) uploadAllNotes() error {
	fmt.Println("Starting uploadAllNotes...")
	
	// Check Drive service state
	if s.driveSync == nil || s.driveSync.service == nil || !s.driveSync.isConnected {
		return fmt.Errorf("drive service is not initialized")
	}

	fmt.Printf("Found %d notes to upload\n", len(s.noteService.noteList.Notes))

	// Delete existing notes folder if exists
	s.driveSync.mutex.Lock()
	if s.driveSync.notesFolderID != "" {
		fmt.Printf("Deleting existing notes folder: %s\n", s.driveSync.notesFolderID)
		err := s.driveSync.service.Files.Delete(s.driveSync.notesFolderID).Do()
		if err != nil {
			s.driveSync.mutex.Unlock()
			return fmt.Errorf("failed to delete notes folder: %v", err)
		}
		s.driveSync.notesFolderID = ""
	}
	s.driveSync.mutex.Unlock()

	// Recreate folders
	if err := s.ensureDriveFolders(); err != nil {
		return fmt.Errorf("failed to recreate folders: %v", err)
	}

	// Upload all notes
	uploadCount := 0
	errorCount := 0
	for _, metadata := range s.noteService.noteList.Notes {
		note, err := s.noteService.LoadNote(metadata.ID)
		if err != nil {
			fmt.Printf("Failed to load note %s: %v\n", metadata.ID, err)
			errorCount++
			continue
		}
		
		if err := s.UploadNote(note); err != nil {
			fmt.Printf("Failed to upload note %s: %v\n", metadata.ID, err)
			errorCount++
			continue
		}
		uploadCount++
		fmt.Printf("Progress: %d/%d notes uploaded\n", uploadCount, len(s.noteService.noteList.Notes))
	}

	fmt.Printf("Upload complete: %d succeeded, %d failed\n", uploadCount, errorCount)

	// Update LastSync before uploading noteList
	s.noteService.noteList.LastSync = time.Now()
	
	if err := s.uploadNoteList(); err != nil {
		return fmt.Errorf("failed to upload note list: %v", err)
	}

	wailsRuntime.EventsEmit(s.ctx, "drive:status", "synced")

	return nil
}

// downloadNote はGoogle Driveからノートをダウンロードします
func (s *driveService) downloadNote(noteID string) error {
	files, err := s.driveSync.service.Files.List().
		Q(fmt.Sprintf("name='%s.json' and '%s' in parents and trashed=false", noteID, s.driveSync.notesFolderID)).
		Fields("files(id)").Do()
	if err != nil {
		return err
	}

	if len(files.Files) == 0 {
		return fmt.Errorf("note file not found in Drive")
	}

	resp, err := s.driveSync.service.Files.Get(files.Files[0].Id).Download()
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	noteFile := filepath.Join(s.notesDir, noteID+".json")
	out, err := os.Create(noteFile)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, resp.Body)
	return err
}

// UploadNote はノートをGoogle Driveにアップロードします
func (s *driveService) UploadNote(note *Note) error {
	noteContent, err := json.MarshalIndent(note, "", "  ")
	if err != nil {
		return err
	}

	// アップロード時刻を記録
	s.driveSync.lastUpdated[note.ID] = time.Now()

	// Check if note already exists in Drive
	files, err := s.driveSync.service.Files.List().
		Q(fmt.Sprintf("name='%s.json' and '%s' in parents and trashed=false", note.ID, s.driveSync.notesFolderID)).
		Fields("files(id)").Do()
	if err != nil {
		return err
	}

	if len(files.Files) > 0 {
		// Update existing file
		file := files.Files[0]
		_, err = s.driveSync.service.Files.Update(file.Id, &drive.File{}).
			Media(bytes.NewReader(noteContent)).
			Do()
		return err
	}

	// Create new file
	f := &drive.File{
		Name:     note.ID + ".json",
		Parents:  []string{s.driveSync.notesFolderID},
		MimeType: "application/json",
	}

	_, err = s.driveSync.service.Files.Create(f).
		Media(bytes.NewReader(noteContent)).
		Do()
	return err
}

// DeleteNote はGoogle Drive上のノートを削除します
func (s *driveService) DeleteNoteDrive(noteID string) error {
	files, err := s.driveSync.service.Files.List().
		Q(fmt.Sprintf("name='%s.json' and '%s' in parents and trashed=false", noteID, s.driveSync.notesFolderID)).
		Fields("files(id)").Do()
	if err != nil {
		return err
	}

	if len(files.Files) > 0 {
		return s.driveSync.service.Files.Delete(files.Files[0].Id).Do()
	}
	return nil
}

// uploadNoteList はノートリストをGoogle Driveにアップロードします
func (s *driveService) uploadNoteList() error {
	s.driveSync.mutex.Lock()
	defer s.driveSync.mutex.Unlock()

	noteListContent, err := json.MarshalIndent(s.noteService.noteList, "", "  ")
	if err != nil {
		wailsRuntime.EventsEmit(s.ctx, "drive:status", "synced")
		return err
	}

	// Check if noteList.json already exists
	files, err := s.driveSync.service.Files.List().
		Q(fmt.Sprintf("name='noteList.json' and '%s' in parents and trashed=false", s.driveSync.rootFolderID)).
		Fields("files(id)").Do()
	if err != nil {
		wailsRuntime.EventsEmit(s.ctx, "drive:status", "synced")
		return err
	}

	if len(files.Files) > 0 {
		// Update existing file
		file := files.Files[0]
		_, err = s.driveSync.service.Files.Update(file.Id, &drive.File{}).
			Media(bytes.NewReader(noteListContent)).
			Do()
		wailsRuntime.EventsEmit(s.ctx, "drive:status", "synced")
		return err
	}

	// Create new file
	f := &drive.File{
		Name:     "noteList.json",
		Parents:  []string{s.driveSync.rootFolderID},
		MimeType: "application/json",
	}

	_, err = s.driveSync.service.Files.Create(f).
		Media(bytes.NewReader(noteListContent)).
		Do()
	wailsRuntime.EventsEmit(s.ctx, "drive:status", "synced")
	return err
}

// SyncNotes はローカルのノートとGoogle Drive上のノートを同期します
func (s *driveService) SyncNotes() error {
	fmt.Println("Starting sync with Drive...")

	// まずnoteList.jsonの最新状態を取得
	files, err := s.driveSync.service.Files.List().
		Q(fmt.Sprintf("name='noteList.json' and '%s' in parents and trashed=false", s.driveSync.rootFolderID)).
		Fields("files(id)").Do()
	if err != nil {
		return fmt.Errorf("failed to list noteList.json: %v", err)
	}

	if len(files.Files) > 0 {
		if err := s.handleNoteListChange(files.Files[0]); err != nil {
			fmt.Printf("Error updating noteList: %v\n", err)
		}
	}

	// Get changes since last sync
	changes, err := s.getChanges()
	if err != nil {
		return fmt.Errorf("failed to get changes: %v", err)
	}

	if len(changes) == 0 {
		fmt.Println("No changes detected")
		return nil
	}

	fmt.Printf("Found %d changes\n", len(changes))

	// Process changes
	for _, change := range changes {
		if change.File == nil {
			continue
		}

		// ノートファイルの変更を検出
		if strings.HasSuffix(change.File.Name, ".json") && change.File.Name != "noteList.json" {
			if err := s.handleNoteChange(change.File); err != nil {
				fmt.Printf("Error handling note change: %v\n", err)
			}
		}
	}

	// 変更が検出された場合、LastSyncを更新
	s.noteService.noteList.LastSync = time.Now()
	if err := s.noteService.saveNoteList(); err != nil {
		fmt.Printf("Error saving note list: %v\n", err)
	}

	// Update start page token
	token, err := s.driveSync.service.Changes.GetStartPageToken().Do()
	if err != nil {
		return fmt.Errorf("failed to get new start page token: %v", err)
	}
	s.driveSync.startPageToken = token.StartPageToken

	return nil
}

// getChanges はGoogle Driveの変更履歴を取得します
func (s *driveService) getChanges() ([]*drive.Change, error) {
	if s.driveSync.startPageToken == "" {
		token, err := s.driveSync.service.Changes.GetStartPageToken().Do()
		if err != nil {
			return nil, fmt.Errorf("failed to get start page token: %v", err)
		}
		s.driveSync.startPageToken = token.StartPageToken
		return nil, nil
	}

	var allChanges []*drive.Change
	pageToken := s.driveSync.startPageToken

	for {
		changes, err := s.driveSync.service.Changes.List(pageToken).
			Spaces("drive").
			Fields("nextPageToken, newStartPageToken, changes(file(id, name, parents, modifiedTime))").
			RestrictToMyDrive(true).
			Do()
		if err != nil {
			return nil, fmt.Errorf("failed to list changes: %v", err)
		}

		for _, change := range changes.Changes {
			if change.File != nil && s.isRelevantFile(change.File) {
				allChanges = append(allChanges, change)
			}
		}

		if changes.NewStartPageToken != "" {
			break
		}
		pageToken = changes.NextPageToken
	}

	return allChanges, nil
}

// isRelevantFile は変更されたファイルが監視対象かどうかを判定します
func (s *driveService) isRelevantFile(file *drive.File) bool {
	if file.Parents == nil {
		return false
	}
	for _, parent := range file.Parents {
		if parent == s.driveSync.rootFolderID || parent == s.driveSync.notesFolderID {
			return true
		}
	}
	return false
}

// handleNoteListChange はノートリストの変更を処理します
func (s *driveService) handleNoteListChange(file *drive.File) error {
	resp, err := s.driveSync.service.Files.Get(file.Id).Download()
	if err != nil {
		return fmt.Errorf("failed to download noteList: %v", err)
	}
	defer resp.Body.Close()

	var cloudNoteList NoteList
	if err := json.NewDecoder(resp.Body).Decode(&cloudNoteList); err != nil {
		return fmt.Errorf("failed to decode noteList: %v", err)
	}

	// クラウドのノートリストを更新
	s.driveSync.cloudNoteList = &cloudNoteList

	// クラウドの方が新しい場合のみ更新
	if cloudNoteList.LastSync.After(s.noteService.noteList.LastSync) {
		fmt.Printf("Updating local noteList from cloud (Cloud: %v, Local: %v)\n",
			cloudNoteList.LastSync, s.noteService.noteList.LastSync)
		return s.syncCloudToLocal(&cloudNoteList)
	}

	return nil
}

// handleNoteChange はノートファイルの変更を処理します
func (s *driveService) handleNoteChange(file *drive.File) error {
	noteID := strings.TrimSuffix(file.Name, ".json")
	
	// ローカルのメタデータを取得
	var localMetadata *NoteMetadata
	for _, meta := range s.noteService.noteList.Notes {
		if meta.ID == noteID {
			localMetadata = &meta
			break
		}
	}

	// クラウドのメタデータを取得
	var cloudMetadata *NoteMetadata
	if s.driveSync.cloudNoteList != nil {
		for _, meta := range s.driveSync.cloudNoteList.Notes {
			if meta.ID == noteID {
				cloudMetadata = &meta
				break
			}
		}
	}

	// クラウドのメタデータが見つからない場合はファイルをダウンロード
	if cloudMetadata == nil {
		fmt.Printf("Downloading note %s from cloud (metadata not found)\n", noteID)
		resp, err := s.driveSync.service.Files.Get(file.Id).Download()
		if err != nil {
			return fmt.Errorf("failed to download note from cloud: %v", err)
		}
		defer resp.Body.Close()

		cloudData, err := io.ReadAll(resp.Body)
		if err != nil {
			return fmt.Errorf("failed to read cloud note data: %v", err)
		}

		var cloudNote Note
		if err := json.Unmarshal(cloudData, &cloudNote); err != nil {
			return fmt.Errorf("failed to parse cloud note: %v", err)
		}

		// ハッシュ値を計算
		h := sha256.New()
		h.Write(cloudData)
		cloudHash := fmt.Sprintf("%x", h.Sum(nil))

		cloudMetadata = &NoteMetadata{
			ID:            cloudNote.ID,
			Title:         cloudNote.Title,
			ContentHeader: cloudNote.ContentHeader,
			Language:      cloudNote.Language,
			ModifiedTime:  cloudNote.ModifiedTime,
			Archived:      cloudNote.Archived,
			ContentHash:   cloudHash,
		}
	}

	// ハッシュ値が異なる場合のみ更新
	if localMetadata == nil || localMetadata.ContentHash != cloudMetadata.ContentHash {
		fmt.Printf("Updating note %s (hash mismatch)\n", noteID)
		
		// ノートファイルをダウンロード
		if err := s.downloadNote(noteID); err != nil {
			return fmt.Errorf("failed to download note: %v", err)
		}

		if localMetadata == nil {
			// 新規ノートの場合
			s.noteService.noteList.Notes = append(s.noteService.noteList.Notes, *cloudMetadata)
		} else {
			// 既存ノートの更新
			for i, meta := range s.noteService.noteList.Notes {
				if meta.ID == noteID {
					// 順序は保持
					cloudMetadata.Order = meta.Order
					s.noteService.noteList.Notes[i] = *cloudMetadata
					break
				}
			}
		}

		// LastSyncを更新
		s.noteService.noteList.LastSync = time.Now()

		if err := s.noteService.saveNoteList(); err != nil {
			return fmt.Errorf("failed to save note list: %v", err)
		}
	} else {
		fmt.Printf("Skipping note %s (hash match)\n", noteID)
	}

	return nil
}

// syncCloudToLocal はクラウドの変更をローカルに同期します
func (s *driveService) syncCloudToLocal(cloudNoteList *NoteList) error {
	fmt.Println("Syncing cloud changes to local...")
	fmt.Printf("Found %d notes in cloud list\n", len(cloudNoteList.Notes))

	// Get all local notes metadata
	localNotesMap := make(map[string]time.Time)
	for _, note := range s.noteService.noteList.Notes {
		notePath := filepath.Join(s.notesDir, note.ID+".json")
		if info, err := os.Stat(notePath); err == nil {
			localNotesMap[note.ID] = info.ModTime()
		}
	}
	fmt.Printf("Found %d notes locally\n", len(localNotesMap))

	// Download new or modified cloud notes
	downloadCount := 0
	for _, cloudNote := range cloudNoteList.Notes {
		localModTime, exists := localNotesMap[cloudNote.ID]
		if !exists || cloudNote.ModifiedTime.After(localModTime) {
			if err := s.downloadNote(cloudNote.ID); err != nil {
				fmt.Printf("Failed to download note %s: %v\n", cloudNote.ID, err)
				continue
			}
			downloadCount++
			delete(localNotesMap, cloudNote.ID)
		}
	}
	fmt.Printf("Downloaded %d notes from cloud\n", downloadCount)

	// Delete local notes that don't exist in cloud
	deleteCount := 0
	for noteID := range localNotesMap {
		notePath := filepath.Join(s.notesDir, noteID+".json")
		if err := os.Remove(notePath); err != nil && !os.IsNotExist(err) {
			fmt.Printf("Failed to delete local note %s: %v\n", noteID, err)
		} else {
			deleteCount++
		}
	}
	fmt.Printf("Deleted %d notes locally\n", deleteCount)

	// マージしたノートリストを作成
	mergedNotes := make([]NoteMetadata, 0)
	notesMap := make(map[string]NoteMetadata)

	// ローカルのノートをマップに追加（順序情報を保持）
	for _, note := range s.noteService.noteList.Notes {
		notesMap[note.ID] = note
	}

	// クラウドのノートで更新または追加（順序情報を保持）
	for _, cloudNote := range cloudNoteList.Notes {
		if localNote, exists := notesMap[cloudNote.ID]; exists {
			// 既存のノートの場合、ローカルの順序を保持
			cloudNote.Order = localNote.Order
		} else {
			// 新規ノートの場合、最大の順序値+1を設定
			maxOrder := -1
			for _, note := range notesMap {
				if note.Order > maxOrder {
					maxOrder = note.Order
				}
			}
			cloudNote.Order = maxOrder + 1
		}
		notesMap[cloudNote.ID] = cloudNote
	}

	// マップからスライスに変換
	for _, note := range notesMap {
		mergedNotes = append(mergedNotes, note)
	}

	// 順序でソート
	sort.Slice(mergedNotes, func(i, j int) bool {
		return mergedNotes[i].Order < mergedNotes[j].Order
	})

	// ソートされたノートリストを設定
	s.noteService.noteList.Notes = mergedNotes
	s.noteService.noteList.LastSync = time.Now()

	if err := s.noteService.saveNoteList(); err != nil {
		fmt.Printf("Failed to save note list: %v\n", err)
		return err
	}
	fmt.Println("Successfully updated local note list")

	// フロントエンドに変更を通知
	wailsRuntime.EventsEmit(s.ctx, "notes:updated")
	wailsRuntime.EventsEmit(s.ctx, "notes:reload")

	return nil
}

// NotifyFrontendReady はフロントエンドの準備完了を通知します
func (s *driveService) NotifyFrontendReady() {
	select {
	case <-s.frontendReady:
		// チャネルが既に閉じられている場合は何もしない
		return
	default:
		close(s.frontendReady)
	}
} 