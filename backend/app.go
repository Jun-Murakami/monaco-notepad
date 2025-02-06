package backend

import (
	"context"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// !!!! Important !!!!
// You need to download Google Drive credentials.json file in the backend directory.
// ------------------------------------------------------------
//go:embed credentials.json
var credentialsJSON []byte 

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

// NewApp は新しいAppインスタンスを作成します
func NewApp() *App {
	return &App{
		ctx: NewContext(context.Background()),
		frontendReady: make(chan struct{}),
	}
}

// ------------------------------------------------------------
// アプリケーション関連の操作
// ------------------------------------------------------------

// アプリケーション起動時に呼び出される初期化関数
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

	// FileServiceの初期化
	a.fileService = NewFileService(a.ctx)

	// SettingsServiceの初期化
	a.settingsService = NewSettingsService(a.appDataDir)

	// NoteServiceの初期化
	noteService, err := NewNoteService(a.notesDir)
	if err != nil {
		fmt.Printf("Error initializing note service: %v\n", err)
		return
	}
	a.noteService = noteService
}

func (a *App) DomReady(ctx context.Context) {
	fmt.Println("DomReady called")
	
	// DriveServiceの初期化
	driveService := NewDriveService(ctx, a.appDataDir, a.notesDir, a.noteService, credentialsJSON)
	if err := driveService.InitializeDrive(); err != nil {
		fmt.Printf("Error initializing drive service: %v\n", err)
	}
	a.driveService = driveService

	// フロントエンドに初期化完了を通知
	wailsRuntime.EventsEmit(ctx, "backend:ready")
}

// アプリケーション終了前に呼び出される処理
func (a *App) BeforeClose(ctx context.Context) (prevent bool) {
	if a.ctx.ShouldSkipBeforeClose() {

		return false
	}

	// イベントを発行して、フロントエンドに保存を要求
	wailsRuntime.EventsEmit(ctx, "app:beforeclose")

	// ウィンドウの状態を保存
	if err := a.settingsService.SaveWindowState(a.ctx); err != nil {
		return false
	}

	return true
}

// アプリケーションを強制終了する
func (a *App) DestroyApp() {
	fmt.Println("DestroyApp")
	// BeforeCloseイベントをスキップしてアプリケーションを終了
	a.ctx.SkipBeforeClose(true)
	wailsRuntime.Quit(a.ctx.ctx)
}

// フロントエンドの準備完了を通知する
func (a *App) NotifyFrontendReady() {
	fmt.Println("App.NotifyFrontendReady called") // デバッグログ追加
	if a.driveService != nil {
		a.driveService.NotifyFrontendReady()
	} else {
		fmt.Println("Warning: driveService is nil") // デバッグログ追加
	}
}


// ------------------------------------------------------------
// ノート関連の操作
// ------------------------------------------------------------

// 全てのノートのリストを返す
func (a *App) ListNotes() ([]Note, error) {
	return a.noteService.ListNotes()
}

// 指定されたIDのノートを読み込む
func (a *App) LoadNote(id string) (*Note, error) {
	return a.noteService.LoadNote(id)
}

// ノートを保存する（アーカイブも含む）
func (a *App) SaveNote(note *Note) error {
	// まずノートサービスで保存
	if err := a.noteService.SaveNote(note); err != nil {
		return err
	}

	// ドライブサービスが初期化されており、接続中の場合はアップロード
	if a.driveService != nil && a.driveService.driveSync.isConnected {
		// ノートのコピーを作成して非同期処理に渡す
		noteCopy := *note
		go func() {
			// テストモード時はイベント通知をスキップ
			if !a.driveService.isTestMode {
				// 同期開始を通知
				wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "syncing")
			}

			// ノートをアップロード
			if err := a.driveService.UploadNote(&noteCopy); err != nil {
				fmt.Printf("Error uploading note to Drive: %v\n", err)
				if !a.driveService.isTestMode {
					wailsRuntime.EventsEmit(a.ctx.ctx, "drive:error", err.Error())
				}
				return
			}

			// ノートリストをアップロード
			if err := a.driveService.uploadNoteList(); err != nil {
				fmt.Printf("Error uploading note list to Drive: %v\n", err)
				if !a.driveService.isTestMode {
					wailsRuntime.EventsEmit(a.ctx.ctx, "drive:error", err.Error())
				}
				return
			}

			// テストモード時はイベント通知をスキップ
			if !a.driveService.isTestMode {
				// アップロード完了後に同期完了を通知
				wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "synced")
			}
		}()
	}

	return nil
}

// ノートリストを保存する
func (a *App) SaveNoteList() error {
	// LastSyncを更新
	a.noteService.noteList.LastSync = time.Now()
	
	//まずノートサービスで保存
	if err := a.noteService.saveNoteList(); err != nil {
		return err
	}

	//ドライブサービスが初期化されており、接続中の場合はアップロード
	if a.driveService != nil && a.driveService.driveSync.isConnected {
		if !a.driveService.isTestMode {
			wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "syncing")
		}
		if err := a.driveService.uploadNoteList(); err != nil {
			fmt.Printf("Error uploading note list to Drive: %v\n", err)
			return err
		}
	}

	return nil
}

// 指定されたIDのノートを削除する 
func (a *App) DeleteNote(id string) error {
	// まずノートサービスで削除
	if err := a.noteService.DeleteNote(id); err != nil {
		return err
	}

	// ドライブサービスが初期化されており、接続中の場合は削除
	if a.driveService != nil && a.driveService.driveSync.isConnected {
		go func() {
			// テストモード時はイベント通知をスキップ
			if !a.driveService.isTestMode {
				// 同期開始を通知
				wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "syncing")
			}

			// ノートを削除
			if err := a.driveService.DeleteNoteDrive(id); err != nil {
				fmt.Printf("Error deleting note from Drive: %v\n", err)
			}

			// ノートリストをアップロード
			if err := a.driveService.uploadNoteList(); err != nil {
				fmt.Printf("Error uploading note list to Drive: %v\n", err)
				if !a.driveService.isTestMode {
					wailsRuntime.EventsEmit(a.ctx.ctx, "drive:error", err.Error())
				}
				return
			}

			// テストモード時はイベント通知をスキップ
			if !a.driveService.isTestMode {
				// 削除完了後に同期完了を通知
				wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "synced")
			}
		}()
	}

	return nil
}

// アーカイブされたノートの完全なデータを読み込む
func (a *App) LoadArchivedNote(id string) (*Note, error) {
	return a.noteService.LoadArchivedNote(id)
}

// ノートの順序を更新する
func (a *App) UpdateNoteOrder(noteID string, newIndex int) error {
	// まずノートサービスで順序を更新
	if err := a.noteService.UpdateNoteOrder(noteID, newIndex); err != nil {
		return err
	}

	// ドライブサービスが初期化されており、接続中の場合はアップロード
	if a.driveService != nil && a.driveService.driveSync.isConnected {
		go func() {
			// テストモード時はイベント通知をスキップ
			if !a.driveService.isTestMode {
				wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "syncing")
			}

			// ノートリストをアップロード
			if err := a.driveService.uploadNoteList(); err != nil {
				fmt.Printf("Error uploading note list to Drive: %v\n", err)
				if !a.driveService.isTestMode {
					wailsRuntime.EventsEmit(a.ctx.ctx, "drive:error", err.Error())
				}
				return
			}

			// テストモード時はイベント通知をスキップ
			if !a.driveService.isTestMode {
				wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "synced")
			}
		}()
	}

	return nil
}

// ------------------------------------------------------------
// Google Drive関連の操作
// ------------------------------------------------------------


// Google Drive APIの初期化
func (a *App) InitializeDrive() error {
	return a.driveService.InitializeDrive()
}

// Google Driveの認証フローを開始
func (a *App) AuthorizeDrive() (string, error) {
	return a.driveService.AuthorizeDrive()
}

// 認証コードを使用してGoogle Drive認証を完了
func (a *App) CompleteAuth(code string) error {
	return a.driveService.CompleteAuth(code)
}

// Google Driveからログアウト
func (a *App) LogoutDrive() error {
	return a.driveService.LogoutDrive()
}

// ノートをGoogle Driveにアップロード
func (a *App) UploadNote(note *Note) error {
	return a.driveService.UploadNote(note)
}

// Google Driveからノートを削除
func (a *App) DeleteNoteDrive(noteID string) error {
	return a.driveService.DeleteNoteDrive(noteID)
}

// Google Driveとの定期的な同期
func (a *App) SyncNotes() error {
	return a.driveService.SyncNotes()
}


// ------------------------------------------------------------
// ファイル操作関連の操作
// ------------------------------------------------------------

// ファイル選択ダイアログを表示し、選択されたファイルのパスを返す
func (a *App) SelectFile() (string, error) {
	return a.fileService.SelectFile()
}

// 指定されたパスのファイルの内容を読み込む
func (a *App) OpenFile(filePath string) (string, error) {
	return a.fileService.OpenFile(filePath)
}

// 保存ダイアログを表示し、選択された保存先のパスを返す
// デフォルトのファイル名と拡張子を指定できる
func (a *App) SelectSaveFileUri(fileName string, extension string) (string, error) {
	return a.fileService.SelectSaveFileUri(fileName, extension)
}

// 指定されたパスにコンテンツを保存する
func (a *App) SaveFile(filePath string, content string) error {
	return a.fileService.SaveFile(filePath, content)
}

// OpenFileFromExternal は外部からファイルを開く際の処理を行います
func (a *App) OpenFileFromExternal(filePath string) error {
	// ファイルの内容を読み込む
	content, err := a.fileService.OpenFile(filePath)
	if err != nil {
		return err
	}

	// フロントエンドにファイルオープンイベントを送信
	wailsRuntime.EventsEmit(a.ctx.ctx, "file:open-external", map[string]string{
		"path": filePath,
		"content": content,
	})
	
	return nil
}

// ------------------------------------------------------------
// 設定関連の操作
// ------------------------------------------------------------

// 設定を読み込む
func (a *App) LoadSettings() (*Settings, error) {
	return a.settingsService.LoadSettings()
}

// 設定を保存する
func (a *App) SaveSettings(settings *Settings) error {
	return a.settingsService.SaveSettings(settings)
}

// ウィンドウの状態を保存する
func (a *App) SaveWindowState(ctx *Context) error {
	return a.settingsService.SaveWindowState(ctx)
}

// BringToFront brings the application window to front
func (a *App) BringToFront() {
	wailsRuntime.WindowUnminimise(a.ctx.ctx)
	wailsRuntime.Show(a.ctx.ctx)
}
