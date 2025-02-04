package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"crypto/sha256"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"google.golang.org/api/drive/v3"
	"google.golang.org/api/option"
)

//go:embed credentials.json
var credentialsJSON []byte

// Note構造体はノートの基本情報を保持します
type Note struct {
    ID           string    `json:"id"`           // ノートの一意識別子
    Title        string    `json:"title"`        // ノートのタイトル
    Content      string    `json:"content"`      // ノートの本文内容
    ContentHeader string   `json:"contentHeader"` // アーカイブ時に表示される内容のプレビュー
    Language     string    `json:"language"`     // ノートで使用されているプログラミング言語
    ModifiedTime time.Time `json:"modifiedTime"` // 最終更新日時
    Archived     bool      `json:"archived"`     // アーカイブ状態（true=アーカイブ済み）
}

// NoteMetadata構造体はノートのメタデータのみを保持します
// コンテンツを除いた軽量なノート情報の管理に使用されます
type NoteMetadata struct {
    ID           string    `json:"id"`           // ノートの一意識別子
    Title        string    `json:"title"`        // ノートのタイトル
    ContentHeader string   `json:"contentHeader"` // アーカイブ時に表示される内容のプレビュー
    Language     string    `json:"language"`     // ノートで使用されているプログラミング言語
    ModifiedTime time.Time `json:"modifiedTime"` // 最終更新日時
    Archived     bool      `json:"archived"`     // アーカイブ状態（true=アーカイブ済み）
    ContentHash  string    `json:"contentHash"`  // コンテンツのハッシュ値
}

// NoteList構造体はノートのリストを管理します
type NoteList struct {
    Version   string         `json:"version"`   // ノートリストのバージョン
    Notes     []NoteMetadata `json:"notes"`     // ノートのメタデータリスト
    LastSync  time.Time      `json:"lastSync"`  // 最後の同期日時
}

// Settings構造体はアプリケーションの設定を管理します
type Settings struct {
    FontFamily string `json:"fontFamily"` // エディタで使用するフォントファミリー
    FontSize   int    `json:"fontSize"`   // フォントサイズ（ピクセル）
    IsDarkMode bool   `json:"isDarkMode"` // ダークモードの有効/無効
    WordWrap   string `json:"wordWrap"`   // ワードラップの設定（"on"/"off"/"wordWrapColumn"）
    Minimap    bool   `json:"minimap"`    // ミニマップの表示/非表示
    WindowWidth  int  `json:"windowWidth"`  // ウィンドウの幅（ピクセル）
    WindowHeight int  `json:"windowHeight"` // ウィンドウの高さ（ピクセル）
    WindowX      int  `json:"windowX"`      // ウィンドウのX座標
    WindowY      int  `json:"windowY"`      // ウィンドウのY座標
    IsMaximized  bool `json:"isMaximized"`  // ウィンドウが最大化されているかどうか
}

// Context構造体はアプリケーションのコンテキストを管理します
type Context struct {
	ctx context.Context
	skipBeforeClose bool // アプリケーション終了前の保存処理をスキップするかどうか
}

// NewContext は新しいContextインスタンスを作成します
func NewContext(ctx context.Context) *Context {
	return &Context{
		ctx: ctx,
		skipBeforeClose: false,
	}
}

// SkipBeforeClose はBeforeClose処理のスキップフラグを設定します
func (c *Context) SkipBeforeClose(skip bool) {
	c.skipBeforeClose = skip
}

// ShouldSkipBeforeClose はBeforeClose処理をスキップすべきかどうかを返します
func (c *Context) ShouldSkipBeforeClose() bool {
	return c.skipBeforeClose
}

// DriveSync構造体はGoogle Driveとの同期機能を管理します
type DriveSync struct {
	service      *drive.Service  // Google Driveサービスのインスタンス
	token        *oauth2.Token   // OAuth2認証トークン
	config       *oauth2.Config  // OAuth2設定
	rootFolderID string         // アプリケーションのルートフォルダID
	notesFolderID string        // ノート保存用フォルダID
	mutex        sync.Mutex     // 同期処理用のミューテックス
	isConnected  bool          // Google Driveへの接続状態
	startPageToken string      // 変更履歴の開始トークン
	lastUpdated map[string]time.Time // 最後の更新時刻を記録
	hasCompletedInitialSync bool    // 初回同期が完了したかどうか
}

// App構造体はアプリケーションのメインの構造体です
type App struct {
	ctx *Context       // アプリケーションのコンテキスト
	appDataDir string  // アプリケーションデータディレクトリのパス
	notesDir   string  // ノートファイル保存ディレクトリのパス
	noteList   *NoteList // ノートリストの管理
	driveSync  *DriveSync // Google Drive同期機能の管理
	frontendReady chan struct{} // フロントエンドの準備完了を通知するチャネル
}

// NewApp は新しいAppインスタンスを作成します
func NewApp() *App {
	return &App{
		ctx: NewContext(context.Background()),
		driveSync: &DriveSync{
			mutex: sync.Mutex{},
			lastUpdated: make(map[string]time.Time),
		},
		frontendReady: make(chan struct{}),
	}
}

// startup はアプリケーション起動時に呼び出される初期化関数です
func (a *App) Startup(ctx context.Context) {
	a.ctx.ctx = ctx
	
	// アプリケーションデータディレクトリの設定
	appData, err := os.UserConfigDir()
	if err != nil {
		appData, err = os.UserHomeDir()
		if err != nil {
			appData = "."
		}
	}
	
	a.appDataDir = filepath.Join(appData, "monaco-notepad")
	a.notesDir = filepath.Join(a.appDataDir, "notes")

	fmt.Println("appDataDir", a.appDataDir)
	
	// ディレクトリの作成
	os.MkdirAll(a.notesDir, 0755)

	// ノートリストの読み込みと同期
	if err := a.loadAndSyncNoteList(); err != nil {
		// エラーログ
		fmt.Printf("Error loading note list: %v\n", err)
	}

	// 保存済みのトークンがあれば自動的に接続を試みる
	tokenFile := filepath.Join(a.appDataDir, "token.json")
	if _, err := os.Stat(tokenFile); err == nil {
		wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "syncing")
		if err := a.InitializeGoogleDrive(); err != nil {
			fmt.Printf("Error initializing Google Drive: %v\n", err)
			wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "offline")
			return
		}


		data, err := os.ReadFile(tokenFile)
		if err != nil {
			fmt.Printf("Error reading token file: %v\n", err)
			wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "offline")
			return
		}


		var token oauth2.Token
		if err := json.Unmarshal(data, &token); err != nil {
			fmt.Printf("Error parsing token: %v\n", err)
			wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "offline")
			return
		}


		if err := a.initializeDriveService(&token); err != nil {
			fmt.Printf("Error initializing Drive service: %v\n", err)
			wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "offline")
			return
		}

	}
}

// SelectFile はファイル選択ダイアログを表示し、選択されたファイルのパスを返します
func (a *App) SelectFile() (string, error) {
    file, err := wailsRuntime.OpenFileDialog(a.ctx.ctx, wailsRuntime.OpenDialogOptions{
        Title: "Please select a file.",
        Filters: []wailsRuntime.FileFilter{
            {
                DisplayName: "All Files (*.*)",
                Pattern:     "",
            },
        },
    })
    if err != nil {
        return "", err
    }
    return file, nil
}

// OpenFile は指定されたパスのファイルの内容を読み込みます
func (a *App) OpenFile(filePath string) (string, error) {
	content, err := os.ReadFile(filePath)
	if err != nil {
		return "", err
	}
	return string(content), nil
}

// SelectSaveFileUri は保存ダイアログを表示し、選択された保存先のパスを返します
// デフォルトのファイル名と拡張子を指定できます
func (a *App) SelectSaveFileUri(fileName string, extension string) (string, error) {
    defaultFileName := fmt.Sprintf("%s.%s", fileName, extension)
    file, err := wailsRuntime.SaveFileDialog(a.ctx.ctx, wailsRuntime.SaveDialogOptions{
        Title: "Please select export file path.",
        DefaultFilename: defaultFileName,
        Filters: []wailsRuntime.FileFilter{
            {
                DisplayName: "All Files (*.*)",
                Pattern:     "*." + extension,
            },
        },
    })
    if err != nil {
        return "", err
    }
    return file, nil
}

// SaveFile は指定されたパスにコンテンツを保存します
func (a *App) SaveFile(filePath string, content string) error {
	return os.WriteFile(filePath, []byte(content), 0644)
}

// loadAndSyncNoteList はノートリストを読み込み、物理ファイルと同期します
// アプリケーション起動時に呼び出され、ノートリストの整合性を確保します
func (a *App) loadAndSyncNoteList() error {
	noteListPath := filepath.Join(a.appDataDir, "noteList.json")
	
	// ノートリストファイルが存在しない場合は新規作成
	if _, err := os.Stat(noteListPath); os.IsNotExist(err) {
		a.noteList = &NoteList{
			Version:  "1.0",
			Notes:    []NoteMetadata{},
			LastSync: time.Now(),
		}
		return a.saveNoteList()
	}
	
	// 既存のノートリストを読み込む
	data, err := os.ReadFile(noteListPath)
	if err != nil {
		return err
	}
	
	if err := json.Unmarshal(data, &a.noteList); err != nil {
		return err
	}

	// 物理ファイルとの同期
	return a.syncNoteList()
}

// syncNoteList は物理ファイルとノートリストの同期を行います
// 存在しないノートの削除や新規ノートの追加を処理します
func (a *App) syncNoteList() error {
	// 物理ファイルの一覧を取得
	files, err := os.ReadDir(a.notesDir)
	if err != nil {
		return err
	}

	// 物理ファイルのマップを作成
	physicalNotes := make(map[string]bool)
	for _, file := range files {
		if filepath.Ext(file.Name()) != ".json" {
			continue
		}
		noteID := file.Name()[:len(file.Name())-5]
		physicalNotes[noteID] = true

		// リストに存在しないノートを追加
		found := false
		for _, metadata := range a.noteList.Notes {
			if metadata.ID == noteID {
				found = true
				break
			}
		}

		if !found {
			// 物理ファイルからメタデータを読み込む
			note, err := a.LoadNote(noteID)
			if err != nil {
				continue
			}
			a.noteList.Notes = append(a.noteList.Notes, NoteMetadata{
				ID:           note.ID,
				Title:        note.Title,
				ContentHeader: note.ContentHeader,
				Language:     note.Language,
				ModifiedTime: note.ModifiedTime,
				Archived:     note.Archived,
			})
		}
	}

	// リストから存在しないノートを削除
	var validNotes []NoteMetadata
	for _, metadata := range a.noteList.Notes {
		if physicalNotes[metadata.ID] {
			validNotes = append(validNotes, metadata)
		}
	}
	a.noteList.Notes = validNotes
	a.noteList.LastSync = time.Now()

	return a.saveNoteList()
}

// saveNoteList はノートリストをJSONファイルとして保存します
func (a *App) saveNoteList() error {
	data, err := json.MarshalIndent(a.noteList, "", "  ")
	if err != nil {
		return err
	}
	
	noteListPath := filepath.Join(a.appDataDir, "noteList.json")
	return os.WriteFile(noteListPath, data, 0644)
}

// LoadSettings はsettings.jsonから設定を読み込みます
// ファイルが存在しない場合はデフォルト設定を返します
func (a *App) LoadSettings() (*Settings, error) {
	settingsPath := filepath.Join(a.appDataDir, "settings.json")
	
	// ファイルが存在しない場合はデフォルト設定を返す
	if _, err := os.Stat(settingsPath); os.IsNotExist(err) {
		return &Settings{
			FontFamily: "Consolas, Monaco, \"Courier New\", monospace",
			FontSize:   14,
			IsDarkMode: false,
			WordWrap:   "off",
			Minimap:    true,
			WindowWidth:  800,
			WindowHeight: 600,
			WindowX:      0,
			WindowY:      0,
			IsMaximized:  false,
		}, nil
	}
	
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		return nil, err
	}
	
	var settings Settings
	if err := json.Unmarshal(data, &settings); err != nil {
		return nil, err
	}
	
	return &settings, nil
}

// SaveSettings は設定をsettings.jsonに保存します
func (a *App) SaveSettings(settings *Settings) error {
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	
	settingsPath := filepath.Join(a.appDataDir, "settings.json")
	return os.WriteFile(settingsPath, data, 0644)
}

// LoadNote は指定されたIDのノートを読み込みます
// ノートの完全なデータ（メタデータとコンテンツ）を返します
func (a *App) LoadNote(id string) (*Note, error) {
	notePath := filepath.Join(a.notesDir, id + ".json")
	data, err := os.ReadFile(notePath)
	if err != nil {
		return nil, err
	}
	
	var note Note
	if err := json.Unmarshal(data, &note); err != nil {
		return nil, err
	}
	
	return &note, nil
}

// uploadNoteListToDrive はノートリストをGoogle Driveにアップロードします
// 既存のファイルが存在する場合は更新、存在しない場合は新規作成します
func (a *App) uploadNoteListToDrive() error {
	a.driveSync.mutex.Lock()
	defer a.driveSync.mutex.Unlock()

	noteListContent, err := json.MarshalIndent(a.noteList, "", "  ")
	if err != nil {
		return err
	}

	// Check if noteList.json already exists
	files, err := a.driveSync.service.Files.List().
		Q(fmt.Sprintf("name='noteList.json' and '%s' in parents and trashed=false", a.driveSync.rootFolderID)).
		Fields("files(id)").Do()
	if err != nil {
		return err
	}

	if len(files.Files) > 0 {
		// Update existing file
		file := files.Files[0]
		_, err = a.driveSync.service.Files.Update(file.Id, &drive.File{}).
			Media(bytes.NewReader(noteListContent)).
			Do()
		return err
	}

	// Create new file
	f := &drive.File{
		Name:     "noteList.json",
		Parents:  []string{a.driveSync.rootFolderID},
		MimeType: "application/json",
	}

	_, err = a.driveSync.service.Files.Create(f).
		Media(bytes.NewReader(noteListContent)).
		Do()
	return err
}

// SaveNote はノートを保存し、必要に応じてGoogle Driveと同期します
// ノートの保存と同期は非同期で行われ、エラーはイベントとして通知されます
func (a *App) SaveNote(note *Note) error {
	// ノートの保存
	if err := a.originalSaveNote(note); err != nil {
		return err
	}

	fmt.Println("SaveNote", note.ID)

	// ドライブに接続されている場合、ノートとノートリストを非同期でアップロード
	if a.driveSync.isConnected {
		// ノートのコピーを作成して非同期処理に渡す
		noteCopy := *note
		go func() {
			// 同期開始を通知
			wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "syncing")

			if err := a.uploadNoteToDrive(&noteCopy); err != nil {
				fmt.Printf("Error uploading note to Drive: %v\n", err)
				wailsRuntime.EventsEmit(a.ctx.ctx, "drive:error", err.Error())
				return
			}

			if err := a.uploadNoteListToDrive(); err != nil {
				fmt.Printf("Error uploading noteList to Drive: %v\n", err)
				wailsRuntime.EventsEmit(a.ctx.ctx, "drive:error", err.Error())
				return
			}

			// アップロード完了後に同期完了を通知
			wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "synced")
		}()
	}

	return nil
}

// ListNotes は全てのノートのリストを返します
// アーカイブされたノートはコンテンツを除いたメタデータのみを返します
func (a *App) ListNotes() ([]Note, error) {
	var notes []Note
	
	for _, metadata := range a.noteList.Notes {
		if metadata.Archived {
			// アーカイブされたノートはコンテンツを読み込まない
			notes = append(notes, Note{
				ID:           metadata.ID,
				Title:        metadata.Title,
				Content:      "",  // コンテンツは空
				ContentHeader: metadata.ContentHeader,
				Language:     metadata.Language,
				ModifiedTime: metadata.ModifiedTime,
				Archived:     true,
			})
		} else {
			// アクティブなノートはコンテンツを読み込む
			note, err := a.LoadNote(metadata.ID)
			if err != nil {
				continue
			}
			notes = append(notes, *note)
		}
	}
	
	return notes, nil
}

// DeleteNote は指定されたIDのノートを削除します
// ファイルシステムとノートリストの両方から削除されます
func (a *App) DeleteNote(id string) error {
	notePath := filepath.Join(a.notesDir, id + ".json")
	if err := os.Remove(notePath); err != nil && !os.IsNotExist(err) {
		return err
	}

	// ノートリストから削除
	var updatedNotes []NoteMetadata
	for _, metadata := range a.noteList.Notes {
		if metadata.ID != id {
			updatedNotes = append(updatedNotes, metadata)
		}
	}
	a.noteList.Notes = updatedNotes

	return a.saveNoteList()
}

// LoadArchivedNote はアーカイブされたノートの完全なデータを読み込みます
func (a *App) LoadArchivedNote(id string) (*Note, error) {
	return a.LoadNote(id)
}

// BeforeClose はアプリケーション終了前に呼び出される処理です
// 現在の状態を保存し、必要な終了処理を実行します
func (a *App) BeforeClose(ctx context.Context) (prevent bool) {
	if a.ctx.ShouldSkipBeforeClose() {
		return false
	}

	// Save current page token
	if a.driveSync.isConnected && a.driveSync.startPageToken != "" {
		tokenPath := filepath.Join(a.appDataDir, "pageToken.txt")
		if err := os.WriteFile(tokenPath, []byte(a.driveSync.startPageToken), 0644); err != nil {
			fmt.Printf("Failed to save page token: %v\n", err)
		}
	}

	// イベントを発行して、フロントエンドに保存を要求
	wailsRuntime.EventsEmit(ctx, "app:beforeclose")

	// ウィンドウの状態を保存
	settings, err := a.LoadSettings()
	if err != nil {
		return false
	}

	width, height := wailsRuntime.WindowGetSize(a.ctx.ctx)
	settings.WindowWidth = width
	settings.WindowHeight = height

	x, y := wailsRuntime.WindowGetPosition(a.ctx.ctx)
	settings.WindowX = x
	settings.WindowY = y

	maximized := wailsRuntime.WindowIsMaximised(a.ctx.ctx)
	settings.IsMaximized = maximized

	if err := a.SaveSettings(settings); err != nil {
		return false
	}

	return true
}

// DestroyApp はアプリケーションを強制終了します
// BeforeClose処理をスキップしてアプリケーションを終了します
func (a *App) DestroyApp() {
	fmt.Println("DestroyApp")
	// BeforeCloseイベントをスキップしてアプリケーションを終了
	a.ctx.SkipBeforeClose(true)
	wailsRuntime.Quit(a.ctx.ctx)
}

// InitializeGoogleDrive はGoogle Drive APIの初期化を行います
// 認証情報を読み込み、OAuth2設定を初期化します
func (a *App) InitializeGoogleDrive() error {
	config, err := google.ConfigFromJSON(credentialsJSON, drive.DriveFileScope)
	if err != nil {
		return fmt.Errorf("unable to parse client secret file to config: %v", err)
	}

	// リダイレクトURIを設定
	config.RedirectURL = "http://localhost:34115/oauth2callback"
	
	a.driveSync.config = config
	return nil
}

// AuthorizeGoogleDrive はGoogle Driveの認証フローを開始します
// ブラウザで認証ページを開き、認証コードを受け取ります
func (a *App) AuthorizeGoogleDrive() (string, error) {
	if a.driveSync.config == nil {
		if err := a.InitializeGoogleDrive(); err != nil {
			return "", err
		}
	}

	// 認証コードを受け取るためのチャネル
	codeChan := make(chan string, 1)

	// 一時的なHTTPサーバーを起動
	server := &http.Server{Addr: ":34115"}
	http.HandleFunc("/oauth2callback", func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		if code != "" {
			codeChan <- code
			// 認証完了ページを表示
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprintf(w, `
				<html>
					<head><title>Authentication Complete</title></head>
					<body>
            <div style="display: flex; justify-content: center; align-items: center; height: 100vh;">
            <div style="text-align: center; width: 300px; padding: 2rem; background-color: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);">
              <h3>Authentication Complete</h3>
              <p>You can close this window</p>
              <script>window.close()</script>
            </div>
            </div>
					</body>
				</html>

			`)
		}
	})

	// サーバーを別のゴルーチンで起動
	go func() {
		if err := server.ListenAndServe(); err != http.ErrServerClosed {
			fmt.Printf("HTTP Server error: %v\n", err)
		}
	}()

	// 認証URLを開く
	authURL := a.driveSync.config.AuthCodeURL("state-token", oauth2.AccessTypeOffline)
	wailsRuntime.BrowserOpenURL(a.ctx.ctx, authURL)

	// 認証コードを待機
	select {
	case code := <-codeChan:
		// サーバーをシャットダウン
		server.Shutdown(a.ctx.ctx)
		// 認証を完了
		if err := a.CompleteGoogleAuth(code); err != nil {
			return "", fmt.Errorf("failed to complete authentication: %v", err)
		}
		return "auth_complete", nil
	case <-time.After(5 * time.Minute):
		// タイムアウト
		server.Shutdown(a.ctx.ctx)
		return "", fmt.Errorf("authentication timed out")
	}
}

// CompleteGoogleAuth は認証コードを使用してGoogle Drive認証を完了します
// トークンを取得し、保存して、Drive APIの初期化を行います
func (a *App) CompleteGoogleAuth(code string) error {
	fmt.Printf("Completing auth with code: %s\n", code)
	
	token, err := a.driveSync.config.Exchange(a.ctx.ctx, code)
	if err != nil {
		return fmt.Errorf("unable to retrieve token from web: %v", err)
	}

	fmt.Printf("Received token: %+v\n", token)

	// Save the token
	tokenFile := filepath.Join(a.appDataDir, "token.json")
	f, err := os.OpenFile(tokenFile, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("unable to cache oauth token: %v", err)
	}
	defer f.Close()
	
	if err := json.NewEncoder(f).Encode(token); err != nil {
		return fmt.Errorf("failed to encode token: %v", err)
	}

	fmt.Printf("Token saved to: %s\n", tokenFile)
	return a.initializeDriveService(token)
}

// initializeDriveService はDriveサービスを初期化します
// トークンを使用してサービスを作成し、必要なフォルダを準備します
func (a *App) initializeDriveService(token *oauth2.Token) error {
	// トークンソースを作成（自動更新用）
	tokenSource := a.driveSync.config.TokenSource(a.ctx.ctx, token)

	// 自動更新されるクライアントを作成
	client := oauth2.NewClient(a.ctx.ctx, tokenSource)
	srv, err := drive.NewService(a.ctx.ctx, option.WithHTTPClient(client))
	if err != nil {
		return fmt.Errorf("unable to retrieve Drive client: %v", err)
	}

	a.driveSync.service = srv
	a.driveSync.token = token
	a.driveSync.isConnected = true

	// フロントエンドの準備完了を待ってから同期処理を開始
	go func() {
		// フロントエンドの準備完了を待つ
		<-a.frontendReady

		// 最初のポーリングまで少し待機
		time.Sleep(1 * time.Second)

		// Start sync polling
		a.startSyncPolling()

		// 初期化完了時は同期済み状態として通知
		wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "synced")
	}()

	// Ensure the app folders exist in Drive
	if err := a.ensureDriveFolders(); err != nil {
		return err
	}

	// 初回同期フラグをチェック
	syncFlagPath := filepath.Join(a.appDataDir, "initial_sync_completed")
	if _, err := os.Stat(syncFlagPath); os.IsNotExist(err) {
		// 初回同期を実行
		fmt.Println("First time initialization - performing initial sync...")
		if err := a.performInitialSync(); err != nil {
			fmt.Printf("Initial sync failed: %v\n", err)
		} else {
			// 初回同期完了フラグを保存
			if err := os.WriteFile(syncFlagPath, []byte("1"), 0644); err != nil {
				fmt.Printf("Failed to save initial sync flag: %v\n", err)
			}
			a.driveSync.hasCompletedInitialSync = true
		}
	} else {
		a.driveSync.hasCompletedInitialSync = true
	}

	// Load saved start page token
	tokenPath := filepath.Join(a.appDataDir, "pageToken.txt")
	if data, err := os.ReadFile(tokenPath); err == nil {
		a.driveSync.startPageToken = string(data)
		fmt.Println("Loaded saved page token:", a.driveSync.startPageToken)
	} else {
		// Get new start page token
		token, err := a.driveSync.service.Changes.GetStartPageToken().Do()
		if err != nil {
			fmt.Printf("Failed to get start page token: %v\n", err)
		} else {
			a.driveSync.startPageToken = token.StartPageToken
			// Save the token
			if err := os.WriteFile(tokenPath, []byte(token.StartPageToken), 0644); err != nil {
				fmt.Printf("Failed to save page token: %v\n", err)
			}
		}
	}

	return nil
}

// performInitialSync は初回接続時のマージ処理を実行します
func (a *App) performInitialSync() error {
	fmt.Println("Starting initial sync...")

	// クラウドのノートリストを取得
	noteListFiles, err := a.driveSync.service.Files.List().
		Q(fmt.Sprintf("name='noteList.json' and '%s' in parents and trashed=false", a.driveSync.rootFolderID)).
		Fields("files(id)").Do()
	if err != nil {
		return fmt.Errorf("failed to list cloud noteList: %v", err)
	}

	var cloudNoteList *NoteList
	if len(noteListFiles.Files) > 0 {
		resp, err := a.driveSync.service.Files.Get(noteListFiles.Files[0].Id).Download()
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
		return a.uploadAllNotesToDrive()
	}

	// ノートのマージ処理
	mergedNotes := make([]NoteMetadata, 0)
	localNotesMap := make(map[string]NoteMetadata)
	cloudNotesMap := make(map[string]NoteMetadata)

	// ローカルノートのマップを作成
	for _, note := range a.noteList.Notes {
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
				if err := a.downloadNoteFromDrive(id); err != nil {
					fmt.Printf("Failed to download note %s: %v\n", id, err)
				}
			} else {
				mergedNotes = append(mergedNotes, localNote)
				// ローカルのノートをアップロード
				note, err := a.LoadNote(id)
				if err == nil {
					if err := a.uploadNoteToDrive(note); err != nil {
						fmt.Printf("Failed to upload note %s: %v\n", id, err)
					}
				}
			}
			delete(cloudNotesMap, id)
		} else {
			// ローカルにしかないノートはアップロード
			mergedNotes = append(mergedNotes, localNote)
			note, err := a.LoadNote(id)
			if err == nil {
				if err := a.uploadNoteToDrive(note); err != nil {
					fmt.Printf("Failed to upload note %s: %v\n", id, err)
				}
			}
		}
	}

	// クラウドにしかないノートを追加
	for id, cloudNote := range cloudNotesMap {
		mergedNotes = append(mergedNotes, cloudNote)
		// ノートをダウンロード
		if err := a.downloadNoteFromDrive(id); err != nil {
			fmt.Printf("Failed to download note %s: %v\n", id, err)
		}
	}

	// マージしたノートリストを保存
	a.noteList.Notes = mergedNotes
	a.noteList.LastSync = time.Now()
	if err := a.saveNoteList(); err != nil {
		return fmt.Errorf("failed to save merged note list: %v", err)
	}

	fmt.Printf("Initial sync completed: %d notes merged\n", len(mergedNotes))

	// フロントエンドに変更を通知
	wailsRuntime.EventsEmit(a.ctx.ctx, "notes:updated")
	wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "synced")

	// フロントエンドにノートリストの再読み込みをトリガー
	wailsRuntime.EventsEmit(a.ctx.ctx, "notes:reload")

	return nil
}

// ensureDriveFolders はGoogle Drive上に必要なフォルダ構造を作成します
// アプリケーションのルートフォルダとノート保存用フォルダを確保します
func (a *App) ensureDriveFolders() error {
	a.driveSync.mutex.Lock()

	// Check for root folder
	fmt.Println("Checking for root folder...")
	rootFolder, err := a.driveSync.service.Files.List().
		Q("name='monaco-notepad' and mimeType='application/vnd.google-apps.folder' and trashed=false").
		Fields("files(id)").Do()
	if err != nil {
		fmt.Printf("Error checking root folder: %v\n", err)
		fmt.Println("[Lock] ensureDriveFolders: releasing lock (error)")
		a.driveSync.mutex.Unlock()
		return err
	}

	fmt.Printf("Found %d root folders\n", len(rootFolder.Files))
	if len(rootFolder.Files) == 0 {
		// Create root folder
		fmt.Println("Creating root folder...")
		folderMetadata := &drive.File{
			Name:     "monaco-notepad",
			MimeType: "application/vnd.google-apps.folder",
		}
		folder, err := a.driveSync.service.Files.Create(folderMetadata).Fields("id").Do()
		if err != nil {
			fmt.Printf("Error creating root folder: %v\n", err)
			fmt.Println("[Lock] ensureDriveFolders: releasing lock (error)")
			a.driveSync.mutex.Unlock()
			return err
		}
		fmt.Printf("Created root folder with ID: %s\n", folder.Id)
		a.driveSync.rootFolderID = folder.Id
	} else {
		fmt.Printf("Using existing root folder with ID: %s\n", rootFolder.Files[0].Id)
		a.driveSync.rootFolderID = rootFolder.Files[0].Id
	}

	// Check for notes folder
	fmt.Println("Checking for notes folder...")
	notesFolder, err := a.driveSync.service.Files.List().
		Q(fmt.Sprintf("name='notes' and '%s' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false", a.driveSync.rootFolderID)).
		Fields("files(id)").Do()
	if err != nil {
		fmt.Printf("Error checking notes folder: %v\n", err)
		fmt.Println("[Lock] ensureDriveFolders: releasing lock (error)")
		a.driveSync.mutex.Unlock()
		return err
	}

	fmt.Printf("Found %d notes folders\n", len(notesFolder.Files))
	if len(notesFolder.Files) == 0 {
		// Create notes folder
		fmt.Println("Creating notes folder...")
		folderMetadata := &drive.File{
			Name:     "notes",
			Parents:  []string{a.driveSync.rootFolderID},
			MimeType: "application/vnd.google-apps.folder",
		}
		folder, err := a.driveSync.service.Files.Create(folderMetadata).Fields("id").Do()
		if err != nil {
			fmt.Printf("Error creating notes folder: %v\n", err)
			fmt.Println("[Lock] ensureDriveFolders: releasing lock (error)")
			a.driveSync.mutex.Unlock()
			return err
		}
		fmt.Printf("Created notes folder with ID: %s\n", folder.Id)
		a.driveSync.notesFolderID = folder.Id
	} else {
		fmt.Printf("Using existing notes folder with ID: %s\n", notesFolder.Files[0].Id)
		a.driveSync.notesFolderID = notesFolder.Files[0].Id
	}

	fmt.Println("ensureDriveFolders completed successfully")
	fmt.Println("[Lock] ensureDriveFolders: releasing lock (success)")
	a.driveSync.mutex.Unlock()
	return nil
}

// startSyncPolling はGoogle Driveとの定期的な同期を開始します
func (a *App) startSyncPolling() {
	const (
		initialInterval = 30 * time.Second
		maxInterval     = 5 * time.Minute
		factor         = 1.5
	)

	interval := initialInterval
	lastChangeTime := time.Now()

	for {
		if !a.driveSync.isConnected {
			time.Sleep(initialInterval)
			continue
		}

		// 同期開始を通知
		wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "syncing")

		// 同期を実行
		if err := a.syncWithDrive(); err != nil {
			fmt.Printf("Error syncing with Drive: %v\n", err)
			if strings.Contains(err.Error(), "oauth2") || 
			   strings.Contains(err.Error(), "401") ||
			   strings.Contains(err.Error(), "403") {
				// 認証エラーの場合はオフライン状態に遷移
				a.handleOfflineTransition()
				continue
			}
			wailsRuntime.EventsEmit(a.ctx.ctx, "drive:error", err.Error())
		} else {
			// 変更が検出された場合
			if a.noteList.LastSync.After(lastChangeTime) {
				interval = initialInterval
				lastChangeTime = a.noteList.LastSync
				fmt.Printf("Changes detected, resetting interval to %v\n", interval)
			} else {
				// 変更がない場合は間隔を増加（最大値まで）
				newInterval := time.Duration(float64(interval) * factor)
				if newInterval > maxInterval {
					newInterval = maxInterval
				}
				if newInterval != interval {
					fmt.Printf("No changes detected, increasing interval from %v to %v\n", interval, newInterval)
					wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "synced")
					interval = newInterval
				}
			}
		}

		// 同期完了を通知
		wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "synced")

		time.Sleep(interval)
	}
}

// syncWithDrive はローカルのノートとGoogle Drive上のノートを同期します
func (a *App) syncWithDrive() error {
	fmt.Println("Starting sync with Drive...")

	// Get changes since last sync
	changes, err := a.getChanges()
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

		// ノートリストの変更を検出
		if change.File.Name == "noteList.json" {
			if err := a.handleNoteListChange(change.File); err != nil {
				fmt.Printf("Error handling noteList change: %v\n", err)
			}
			continue
		}

		// ノートファイルの変更を検出
		if strings.HasSuffix(change.File.Name, ".json") {
			if err := a.handleNoteChange(change.File); err != nil {
				fmt.Printf("Error handling note change: %v\n", err)
			}
		}
	}

	// 変更が検出された場合、LastSyncを更新
	a.noteList.LastSync = time.Now()
	if err := a.saveNoteList(); err != nil {
		fmt.Printf("Error saving note list: %v\n", err)
	}

	// Update start page token
	token, err := a.driveSync.service.Changes.GetStartPageToken().Do()
	if err != nil {
		return fmt.Errorf("failed to get new start page token: %v", err)
	}
	a.driveSync.startPageToken = token.StartPageToken

	return nil
}

// getChanges はGoogle Driveの変更履歴を取得します
func (a *App) getChanges() ([]*drive.Change, error) {
	if a.driveSync.startPageToken == "" {
		token, err := a.driveSync.service.Changes.GetStartPageToken().Do()
		if err != nil {
			return nil, fmt.Errorf("failed to get start page token: %v", err)
		}
		a.driveSync.startPageToken = token.StartPageToken
		return nil, nil
	}

	var allChanges []*drive.Change
	pageToken := a.driveSync.startPageToken

	for {
		changes, err := a.driveSync.service.Changes.List(pageToken).
			Spaces("drive").
			Fields("nextPageToken, newStartPageToken, changes(file(id, name, parents, modifiedTime))").
			RestrictToMyDrive(true).
			Do()
		if err != nil {
			return nil, fmt.Errorf("failed to list changes: %v", err)
		}

		for _, change := range changes.Changes {
			if change.File != nil && a.isRelevantFile(change.File) {
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
func (a *App) isRelevantFile(file *drive.File) bool {
	if file.Parents == nil {
		return false
	}
	for _, parent := range file.Parents {
		if parent == a.driveSync.rootFolderID || parent == a.driveSync.notesFolderID {
			return true
		}
	}
	return false
}

// handleNoteListChange はノートリストの変更を処理します
func (a *App) handleNoteListChange(file *drive.File) error {
	resp, err := a.driveSync.service.Files.Get(file.Id).Download()
	if err != nil {
		return fmt.Errorf("failed to download noteList: %v", err)
	}
	defer resp.Body.Close()

	var cloudNoteList NoteList
	if err := json.NewDecoder(resp.Body).Decode(&cloudNoteList); err != nil {
		return fmt.Errorf("failed to decode noteList: %v", err)
	}

	// クラウドの方が新しい場合のみ更新
	if cloudNoteList.LastSync.After(a.noteList.LastSync) {
		fmt.Printf("Updating local noteList from cloud (Cloud: %v, Local: %v)\n",
			cloudNoteList.LastSync, a.noteList.LastSync)
		return a.syncCloudToLocal(&cloudNoteList)
	}

	return nil
}

// handleNoteChange はノートファイルの変更を処理します
func (a *App) handleNoteChange(file *drive.File) error {
	noteID := strings.TrimSuffix(file.Name, ".json")
	
	// ローカルのメタデータを取得
	var localMetadata *NoteMetadata
	for _, meta := range a.noteList.Notes {
		if meta.ID == noteID {
			localMetadata = &meta
			break
		}
	}

	// クラウドのノートを取得
	resp, err := a.driveSync.service.Files.Get(file.Id).Download()
	if err != nil {
		return fmt.Errorf("failed to download note from cloud: %v", err)
	}
	defer resp.Body.Close()

	cloudData, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read cloud note data: %v", err)
	}

	// クラウドのノートをパースしてメタデータを取得
	var cloudNote Note
	if err := json.Unmarshal(cloudData, &cloudNote); err != nil {
		return fmt.Errorf("failed to parse cloud note: %v", err)
	}

	// ハッシュ値を計算（新規ノートまたはメタデータが存在しない場合のみ）
	h := sha256.New()
	h.Write(cloudData)
	cloudHash := fmt.Sprintf("%x", h.Sum(nil))

	// ハッシュ値が異なる場合のみ更新
	if localMetadata == nil || localMetadata.ContentHash != cloudHash {
		fmt.Printf("Updating note %s (hash mismatch)\n", noteID)
		
		// ノートファイルを保存
		notePath := filepath.Join(a.notesDir, noteID + ".json")
		if err := os.WriteFile(notePath, cloudData, 0644); err != nil {
			return fmt.Errorf("failed to save note file: %v", err)
		}

		if localMetadata == nil {
			// 新規ノートの場合
			a.noteList.Notes = append(a.noteList.Notes, NoteMetadata{
				ID:           cloudNote.ID,
				Title:        cloudNote.Title,
				ContentHeader: cloudNote.ContentHeader,
				Language:     cloudNote.Language,
				ModifiedTime: cloudNote.ModifiedTime,
				Archived:     cloudNote.Archived,
				ContentHash:  cloudHash,
			})
		} else {
			// 既存ノートの更新
			for i, meta := range a.noteList.Notes {
				if meta.ID == noteID {
					a.noteList.Notes[i].Title = cloudNote.Title
					a.noteList.Notes[i].ContentHeader = cloudNote.ContentHeader
					a.noteList.Notes[i].Language = cloudNote.Language
					a.noteList.Notes[i].ModifiedTime = cloudNote.ModifiedTime
					a.noteList.Notes[i].Archived = cloudNote.Archived
					a.noteList.Notes[i].ContentHash = cloudHash
					break
				}
			}
		}

		// LastSyncを更新
		a.noteList.LastSync = time.Now()

		if err := a.saveNoteList(); err != nil {
			return fmt.Errorf("failed to save note list: %v", err)
		}
	} else {
		fmt.Printf("Skipping note %s (hash match)\n", noteID)
	}

	return nil
}

// syncLocalToCloud はローカルの変更をクラウドに同期します
// 新規作成、更新、削除されたノートを処理します
func (a *App) syncLocalToCloud() error {
	fmt.Println("Syncing local changes to cloud...")
	
	// Get all cloud notes metadata
	cloudFiles, err := a.driveSync.service.Files.List().
		Q(fmt.Sprintf("'%s' in parents and mimeType='application/json' and trashed=false", a.driveSync.notesFolderID)).
		Fields("files(id, name, modifiedTime)").Do()
	if err != nil {
		return fmt.Errorf("failed to list cloud notes: %v", err)
	}

	fmt.Printf("Found %d notes in cloud\n", len(cloudFiles.Files))

	// Create map of cloud files
	cloudNotesMap := make(map[string]time.Time)
	for _, file := range cloudFiles.Files {
		noteID := strings.TrimSuffix(file.Name, ".json")
		modTime, _ := time.Parse(time.RFC3339, file.ModifiedTime)
		cloudNotesMap[noteID] = modTime
	}

	// Upload new or modified local notes
	uploadCount := 0
	for _, localNote := range a.noteList.Notes {
		cloudModTime, exists := cloudNotesMap[localNote.ID]
		if !exists || localNote.ModifiedTime.After(cloudModTime) {
			note, err := a.LoadNote(localNote.ID)
			if err != nil {
				fmt.Printf("Failed to load local note %s: %v\n", localNote.ID, err)
				continue
			}
			if err := a.uploadNoteToDrive(note); err != nil {
				fmt.Printf("Failed to upload note %s: %v\n", localNote.ID, err)
				continue
			}
			uploadCount++
			delete(cloudNotesMap, localNote.ID)
		}
	}
	fmt.Printf("Uploaded %d notes to cloud\n", uploadCount)

	// Delete cloud notes that don't exist locally
	deleteCount := 0
	for noteID := range cloudNotesMap {
		if err := a.deleteNoteFromDrive(noteID); err != nil {
			fmt.Printf("Failed to delete cloud note %s: %v\n", noteID, err)
		} else {
			deleteCount++
		}
	}
	fmt.Printf("Deleted %d notes from cloud\n", deleteCount)

	// Update LastSync before uploading noteList
	a.noteList.LastSync = time.Now()

	// Upload updated noteList
	if err := a.uploadNoteListToDrive(); err != nil {
		fmt.Printf("Failed to upload note list: %v\n", err)
		return err
	}
	fmt.Println("Successfully uploaded note list to cloud")
	return nil
}

// syncCloudToLocal はクラウドの変更をローカルに同期します
// 新規作成、更新、削除されたノートを処理します
func (a *App) syncCloudToLocal(cloudNoteList *NoteList) error {
	fmt.Println("Syncing cloud changes to local...")
	fmt.Printf("Found %d notes in cloud list\n", len(cloudNoteList.Notes))

	// Get all local notes metadata
	localNotesMap := make(map[string]time.Time)
	for _, note := range a.noteList.Notes {
		notePath := filepath.Join(a.notesDir, note.ID+".json")
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
			if err := a.downloadNoteFromDrive(cloudNote.ID); err != nil {
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
		notePath := filepath.Join(a.notesDir, noteID+".json")
		if err := os.Remove(notePath); err != nil && !os.IsNotExist(err) {
			fmt.Printf("Failed to delete local note %s: %v\n", noteID, err)
		} else {
			deleteCount++
		}
	}
	fmt.Printf("Deleted %d notes locally\n", deleteCount)

	// Update local noteList
	a.noteList = cloudNoteList
	if err := a.saveNoteList(); err != nil {
		fmt.Printf("Failed to save note list: %v\n", err)
		return err
	}
	fmt.Println("Successfully updated local note list")

	// フロントエンドに変更を通知
	wailsRuntime.EventsEmit(a.ctx.ctx, "notes:updated")

	// フロントエンドにノートリストの再読み込みをトリガー
	wailsRuntime.EventsEmit(a.ctx.ctx, "notes:reload")

	return nil
}

// deleteNoteFromDrive はGoogle Drive上のノートを削除します
func (a *App) deleteNoteFromDrive(noteID string) error {
	files, err := a.driveSync.service.Files.List().
		Q(fmt.Sprintf("name='%s.json' and '%s' in parents and trashed=false", noteID, a.driveSync.notesFolderID)).
		Fields("files(id)").Do()
	if err != nil {
		return err
	}

	if len(files.Files) > 0 {
		return a.driveSync.service.Files.Delete(files.Files[0].Id).Do()
	}
	return nil
}

// uploadAllNotesToDrive は全てのローカルノートをGoogle Driveにアップロードします
// 既存のノートフォルダを削除し、新しく作成し直します
func (a *App) uploadAllNotesToDrive() error {
	fmt.Println("Starting uploadAllNotesToDrive...")
	
	// Check Drive service state
	if a.driveSync == nil {
		return fmt.Errorf("driveSync is nil")
	}
	if a.driveSync.service == nil {
		return fmt.Errorf("drive service is not initialized")
	}
	if !a.driveSync.isConnected {
		return fmt.Errorf("not connected to drive")
	}

	fmt.Printf("Found %d notes to upload\n", len(a.noteList.Notes))

	// Delete existing notes folder if exists
	a.driveSync.mutex.Lock()
	if a.driveSync.notesFolderID != "" {
		fmt.Printf("Deleting existing notes folder: %s\n", a.driveSync.notesFolderID)
		err := a.driveSync.service.Files.Delete(a.driveSync.notesFolderID).Do()
		if err != nil {
			a.driveSync.mutex.Unlock()
			fmt.Printf("Failed to delete existing notes folder: %v\n", err)
			return fmt.Errorf("failed to delete notes folder: %v", err)
		}
		fmt.Println("Successfully deleted existing notes folder")
		a.driveSync.notesFolderID = ""
	}
	a.driveSync.mutex.Unlock()

	// Recreate folders
	if err := a.ensureDriveFolders(); err != nil {
		return fmt.Errorf("failed to recreate folders: %v", err)
	}

	// Upload all notes
	uploadCount := 0
	errorCount := 0
	for _, metadata := range a.noteList.Notes {
		note, err := a.LoadNote(metadata.ID)
		if err != nil {
			fmt.Printf("Failed to load note %s: %v\n", metadata.ID, err)
			errorCount++
			continue
		}
		
		if err := a.uploadNoteToDrive(note); err != nil {
			fmt.Printf("Failed to upload note %s: %v\n", metadata.ID, err)
			errorCount++
			continue
		}
		uploadCount++
		fmt.Printf("Progress: %d/%d notes uploaded\n", uploadCount, len(a.noteList.Notes))
	}

	fmt.Printf("Upload complete: %d succeeded, %d failed\n", uploadCount, errorCount)

	// Update LastSync before uploading noteList
	a.noteList.LastSync = time.Now()
	
	if err := a.uploadNoteListToDrive(); err != nil {
		fmt.Printf("Failed to upload note list: %v\n", err)
		return err
	}
	fmt.Println("Successfully uploaded note list to cloud")
	return nil
}

// downloadNoteFromDrive はGoogle Driveからノートをダウンロードします
func (a *App) downloadNoteFromDrive(noteID string) error {
	files, err := a.driveSync.service.Files.List().
		Q(fmt.Sprintf("name='%s.json' and '%s' in parents and trashed=false", noteID, a.driveSync.notesFolderID)).
		Fields("files(id)").Do()
	if err != nil {
		return err
	}

	if len(files.Files) == 0 {
		return fmt.Errorf("note file not found in Drive")
	}

	resp, err := a.driveSync.service.Files.Get(files.Files[0].Id).Download()
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	noteFile := filepath.Join(a.notesDir, noteID+".json")
	out, err := os.Create(noteFile)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, resp.Body)
	return err
}

// originalSaveNote はノートの基本的な保存処理を行います
func (a *App) originalSaveNote(note *Note) error {
	data, err := json.MarshalIndent(note, "", "  ")
	if err != nil {
		return err
	}
	
	// コンテンツのハッシュ値を計算（保存時に1回だけ）
	h := sha256.New()
	h.Write(data)
	contentHash := fmt.Sprintf("%x", h.Sum(nil))
	
	notePath := filepath.Join(a.notesDir, note.ID + ".json")
	if err := os.WriteFile(notePath, data, 0644); err != nil {
		return err
	}

	// Update note list
	found := false
	for i, metadata := range a.noteList.Notes {
		if metadata.ID == note.ID {
			// 既存のメタデータを更新
			a.noteList.Notes[i] = NoteMetadata{
				ID:           note.ID,
				Title:        note.Title,
				ContentHeader: note.ContentHeader,
				Language:     note.Language,
				ModifiedTime: note.ModifiedTime,
				Archived:     note.Archived,
				ContentHash:  contentHash,
			}
			found = true
			break
		}
	}

	if !found {
		// 新規ノートの場合
		a.noteList.Notes = append(a.noteList.Notes, NoteMetadata{
			ID:           note.ID,
			Title:        note.Title,
			ContentHeader: note.ContentHeader,
			Language:     note.Language,
			ModifiedTime: note.ModifiedTime,
			Archived:     note.Archived,
			ContentHash:  contentHash,
		})
	}

	return a.saveNoteList()
}

// uploadNoteToDrive はノートをGoogle Driveにアップロードします
// 既存のファイルが存在する場合は更新、存在しない場合は新規作成します
func (a *App) uploadNoteToDrive(note *Note) error {
	noteContent, err := json.MarshalIndent(note, "", "  ")
	if err != nil {
		return err
	}

	// アップロード時刻を記録
	a.driveSync.lastUpdated[note.ID] = time.Now()

	// Check if note already exists in Drive
	files, err := a.driveSync.service.Files.List().
		Q(fmt.Sprintf("name='%s.json' and '%s' in parents and trashed=false", note.ID, a.driveSync.notesFolderID)).
		Fields("files(id)").Do()
	if err != nil {
		return err
	}

	if len(files.Files) > 0 {
		// Update existing file
		file := files.Files[0]
		_, err = a.driveSync.service.Files.Update(file.Id, &drive.File{}).
			Media(bytes.NewReader(noteContent)).
			Do()
		return err
	}

	// Create new file
	f := &drive.File{
		Name:     note.ID + ".json",
		Parents:  []string{a.driveSync.notesFolderID},
		MimeType: "application/json",
	}

	_, err = a.driveSync.service.Files.Create(f).
		Media(bytes.NewReader(noteContent)).
		Do()
	return err
}

// handleOfflineTransition はオフライン状態への遷移を処理します
func (a *App) handleOfflineTransition() {
    fmt.Println("Transitioning to offline state...")
    a.driveSync.isConnected = false
    a.driveSync.service = nil
    a.driveSync.token = nil
    a.driveSync.startPageToken = ""

    // 認証関連ファイルを削除
    tokenFile := filepath.Join(a.appDataDir, "token.json")
    if err := os.Remove(tokenFile); err != nil && !os.IsNotExist(err) {
        fmt.Printf("Failed to remove token file: %v\n", err)
    }

    syncFlagFile := filepath.Join(a.appDataDir, "initial_sync_completed")
    if err := os.Remove(syncFlagFile); err != nil && !os.IsNotExist(err) {
        fmt.Printf("Failed to remove sync flag file: %v\n", err)
    }

    pageTokenFile := filepath.Join(a.appDataDir, "pageToken.txt")
    if err := os.Remove(pageTokenFile); err != nil && !os.IsNotExist(err) {
        fmt.Printf("Failed to remove page token file: %v\n", err)
    }

    // フロントエンドに通知
    wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "offline")
}

// LogoutGoogleDrive はGoogle Driveからログアウトし、関連するファイルをクリーンアップします
func (a *App) LogoutGoogleDrive() error {
    fmt.Println("Logging out from Google Drive...")

    // 現在のノートの変更を保存
    if err := a.saveNoteList(); err != nil {
        fmt.Printf("Failed to save note list before logout: %v\n", err)
    }

    // オフライン状態に遷移
    // - 認証関連ファイルの削除
    // - 接続状態のリセット
    // - フロントエンドへの通知
    a.handleOfflineTransition()

    // ポーリングを停止（isConnectedがfalseになることで、次のポーリング時に停止）
    fmt.Println("Sync polling will stop on next iteration")

    return nil
}

// NotifyFrontendReady はフロントエンドの準備完了を通知します
func (a *App) NotifyFrontendReady() {
	select {
	case <-a.frontendReady:
		// チャネルが既に閉じられている場合は何もしない
		return
	default:
		close(a.frontendReady)
	}
}

