// ------------------------------------------------------------
// バックエンドアーキテクチャの概要
// ------------------------------------------------------------
//
// このアプリケーションは以下のサービスで構成されています：
//
// 1. App (app.go)
//    - アプリケーションのメインエントリーポイント
//    - 各サービスの初期化と連携を管理
//    - フロントエンドとバックエンドの橋渡し役
//
// 2. NoteService (note_service.go)
//    - ローカルのノート操作を担当
//    - ノートの作成、読み込み、保存、削除
//    - ノートリストの管理とメタデータの同期
//
// 3. DriveService (drive_service.go, drive_sync_service.go, drive_operations.go)
//    - Google Driveとの同期機能を提供
//    - 認証管理（OAuth2.0）
//    - ノートのクラウド同期
//    - 非同期操作のキュー管理
//
// 4. SettingsService (settings_service.go)
//    - アプリケーション設定の管理
//    - ウィンドウ状態の保存/復元
//    - ユーザー設定の保存/読み込み
//
// 5. FileService (file_service.go)
//    - ローカルファイルシステムとの操作
//    - ファイルの開く/保存ダイアログ
//    - 外部ファイルの読み込み
//
// ファイル構成：
// - domain.go: データモデルの定義
// - app.go: メインアプリケーションロジック
// - note_service.go: ノート操作の実装
// - drive_service.go: Google Drive連携の中核実装
// - drive_sync_service.go: 同期ロジックの中レベル実装
// - drive_operations.go: Drive操作の低レベル実装
// - drive_operations_queue.go: Drive操作のキュー管理ラッパー
// - settings_service.go: 設定管理の実装
// - file_service.go: ファイル操作の実装

package backend

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// !!!! Important !!!!
// You need to download Google Drive credentials.json file in the backend directory.
// ------------------------------------------------------------
//
//go:embed credentials.json
var credentialsJSON []byte

// 新しいContextインスタンスを作成 ------------------------------------------------------------
func NewContext(ctx context.Context) *Context {
	return &Context{
		ctx:             ctx,
		skipBeforeClose: false,
	}
}

// BeforeClose処理のスキップフラグを設定 ------------------------------------------------------------
func (c *Context) SkipBeforeClose(skip bool) {
	c.skipBeforeClose = skip
}

// BeforeClose処理をスキップすべきかどうかを返す ------------------------------------------------------------
func (c *Context) ShouldSkipBeforeClose() bool {
	return c.skipBeforeClose
}

// 新しいAppインスタンスを作成 ------------------------------------------------------------
func NewApp() *App {
	return &App{
		ctx:           NewContext(context.Background()),
		frontendReady: make(chan struct{}),
	}
}

// ------------------------------------------------------------
// アプリケーション関連の操作
// ------------------------------------------------------------

// アプリケーション起動時に呼び出される初期化関数 ------------------------------------------------------------
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

	fmt.Println("appDataDir: ", a.appDataDir)

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

// フロントエンドにDOMが読み込まれたときに呼び出される関数 ------------------------------------------------------------
func (a *App) DomReady(ctx context.Context) {
	fmt.Println("DomReady called")

	// DriveServiceの初期化
	driveService := NewDriveService(
		ctx,
		a.appDataDir,
		a.notesDir,
		a.noteService,
		credentialsJSON,
	)
	// Google Driveの初期化。保存済みトークンがあればポーリング開始
	if err := driveService.InitializeDrive(); err != nil {
		fmt.Printf("Error initializing drive service: %v\n", err)
	}
	a.driveService = driveService

	// フロントエンドに初期化完了を通知
	wailsRuntime.EventsEmit(ctx, "backend:ready")
}

// アプリケーション終了前に呼び出される処理 ------------------------------------------------------------
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

	return false
}

// アプリケーションを強制終了する ------------------------------------------------------------
func (a *App) DestroyApp() {
	fmt.Println("DestroyApp")
	// BeforeCloseイベントをスキップしてアプリケーションを終了
	a.ctx.SkipBeforeClose(true)
	wailsRuntime.Quit(a.ctx.ctx)
}

// フロントエンドの準備完了を通知する ------------------------------------------------------------
func (a *App) NotifyFrontendReady() {
	fmt.Println("App.NotifyFrontendReady called") // デバッグログ
	if a.driveService != nil {
		a.driveService.NotifyFrontendReady()
	} else {
		fmt.Println("Warning: driveService is nil") // デバッグログ
	}
}

// ------------------------------------------------------------
// ノート関連の操作 (ローカルノート操作メソッドとGoogle Drive操作メソッドを結合)
// ------------------------------------------------------------

// 全てのノートのリストを返す ------------------------------------------------------------
func (a *App) ListNotes() ([]Note, error) {
	return a.noteService.ListNotes()
}

// 指定されたIDのノートを読み込む ------------------------------------------------------------
func (a *App) LoadNote(id string) (*Note, error) {
	return a.noteService.LoadNote(id)
}

// ノートを保存する（アーカイブも含む） ------------------------------------------------------------
func (a *App) SaveNote(note *Note, action string) error {
	if action != "create" {
		action = "update"
	}

	// まずノートサービスでローカルに保存
	if err := a.noteService.SaveNote(note); err != nil {
		return err
	}

	// ドライブサービスが初期化されており、接続中の場合はアップロード
	if a.driveService != nil && a.driveService.IsConnected() {
		// ノートのコピーを作成して非同期処理に渡す
		noteCopy := *note
		go func() {
			// テストモード時はイベント通知をスキップ
			if !a.driveService.IsTestMode() {
				// 同期開始を通知
				wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "syncing")
			}

			// ノートをアップロード
			if action == "create" {
				if err := a.driveService.CreateNote(&noteCopy); err != nil {
					fmt.Printf("Error uploading note to Drive: %v\n", err)
					if !a.driveService.IsTestMode() {
						wailsRuntime.EventsEmit(a.ctx.ctx, "drive:error", err.Error())
					}
					return
				}
			} else {
				if err := a.driveService.UpdateNote(&noteCopy); err != nil {
					fmt.Printf("Error uploading note to Drive: %v\n", err)
					if !a.driveService.IsTestMode() {
						wailsRuntime.EventsEmit(a.ctx.ctx, "drive:error", err.Error())
					}
					return
				}
			}

			// ノートリストをアップロード
			if err := a.driveService.UpdateNoteList(); err != nil {
				fmt.Printf("Error uploading note list to Drive: %v\n", err)
				if !a.driveService.IsTestMode() {
					wailsRuntime.EventsEmit(a.ctx.ctx, "drive:error", err.Error())
				}
				return
			}

			// 同期完了を通知
			if !a.driveService.IsTestMode() {
				wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "synced")
			}
		}()
	}

	return nil
}

// ノートリストを保存する ------------------------------------------------------------
func (a *App) SaveNoteList() error {
	fmt.Println("SaveNoteList called")
	// LastSyncを更新
	a.noteService.noteList.LastSync = time.Now()

	// まずノートサービスでローカルに保存
	if err := a.noteService.saveNoteList(); err != nil {
		return err
	}

	// ドライブサービスが初期化されており、接続中の場合はアップロード
	if a.driveService != nil && a.driveService.IsConnected() {
		if !a.driveService.IsTestMode() {
			wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "syncing")
		}
		if err := a.driveService.UpdateNoteList(); err != nil {
			fmt.Printf("Error uploading note list to Drive: %v\n", err)
			return err
		}
		if !a.driveService.IsTestMode() {
			wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "synced")
		}
	}
	return nil
}

// 指定されたIDのノートを削除する ------------------------------------------------------------
func (a *App) DeleteNote(id string) error {
	// まずノートサービスで削除
	if err := a.noteService.DeleteNote(id); err != nil {
		return err
	}

	// ドライブサービスが初期化されており、接続中の場合は削除
	if a.driveService != nil && a.driveService.IsConnected() {
		go func() {
			// テストモード時はイベント通知をスキップ
			if !a.driveService.IsTestMode() {
				// 同期開始を通知
				wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "syncing")
			}

			// ノートを削除
			if err := a.driveService.DeleteNoteDrive(id); err != nil {
				fmt.Printf("Error deleting note from Drive: %v\n", err)
			}

			// ノートリストをアップロード
			if err := a.driveService.UpdateNoteList(); err != nil {
				fmt.Printf("Error uploading note list to Drive: %v\n", err)
				if !a.driveService.IsTestMode() {
					wailsRuntime.EventsEmit(a.ctx.ctx, "drive:error", err.Error())
				}
				return
			}

			// テストモード時はイベント通知をスキップ
			if !a.driveService.IsTestMode() {
				// 削除完了後に同期完了を通知
				wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "synced")
			}
		}()
	}
	return nil
}

// アーカイブされたノートの完全なデータを読み込む ------------------------------------------------------------
func (a *App) LoadArchivedNote(id string) (*Note, error) {
	return a.noteService.LoadArchivedNote(id)
}

// ノートの順序を更新する ------------------------------------------------------------
func (a *App) UpdateNoteOrder(noteID string, newIndex int) error {
	fmt.Println("UpdateNoteOrder called")
	// まずノートサービスで順序を更新
	if err := a.noteService.UpdateNoteOrder(noteID, newIndex); err != nil {
		return err
	}

	// ドライブサービスが初期化されており、接続中の場合はアップロード
	if a.driveService != nil && a.driveService.IsConnected() {
		go func() {
			// ノートリストをアップロード
			if err := a.driveService.UpdateNoteList(); err != nil {
				fmt.Printf("Error uploading note list to Drive: %v\n", err)
				if !a.driveService.IsTestMode() {
					wailsRuntime.EventsEmit(a.ctx.ctx, "drive:error", err.Error())
				}
				return
			}

			// テストモード時はイベント通知をスキップ
			if !a.driveService.IsTestMode() {
				wailsRuntime.EventsEmit(a.ctx.ctx, "drive:status", "synced")
			}
		}()
	}
	return nil
}

// ------------------------------------------------------------
// Google Drive関連の操作
// ------------------------------------------------------------

// Google Drive APIの初期化 ------------------------------------------------------------
func (a *App) InitializeDrive() error {
	if a.driveService == nil {
		return fmt.Errorf("DriveService not initialized yet")
	}
	return a.driveService.InitializeDrive()
}

// Google Driveの認証フローを開始 ------------------------------------------------------------
func (a *App) AuthorizeDrive() (string, error) {
	if a.driveService == nil {
		return "", fmt.Errorf("DriveService not initialized yet")
	}
	err := a.driveService.AuthorizeDrive()
	if err != nil {
		return "", err
	}
	return "", nil
}

// 認証をキャンセル ------------------------------------------------------------
func (a *App) CancelLoginDrive() error {
	if a.driveService != nil {
		return a.driveService.CancelLoginDrive()
	}
	return fmt.Errorf("drive service is not initialized")
}

// Google Driveからログアウト ------------------------------------------------------------
func (a *App) LogoutDrive() error {
	return a.driveService.LogoutDrive()
}

// 手動でただちに同期を開始 ------------------------------------------------------------
func (a *App) SyncNow() error {
	if a.driveService != nil && a.driveService.IsConnected() {
		return a.driveService.SyncNotes()
	}
	return fmt.Errorf("drive service is not initialized or not connected")
}

// Google Driveとの接続状態をチェック ------------------------------------------------------------
func (a *App) CheckDriveConnection() bool {
	if a.driveService == nil {
		return false
	}
	return a.driveService.IsConnected()
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
		"path":    filePath,
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

// ウィンドウを前面に表示する
func (a *App) BringToFront() {
	wailsRuntime.WindowUnminimise(a.ctx.ctx)
	wailsRuntime.Show(a.ctx.ctx)
}

// アプリケーションのバージョンを返す
func (a *App) GetAppVersion() (string, error) {
	// wails.jsonを読み込む
	data, err := os.ReadFile("wails.json")
	if err != nil {
		return "", fmt.Errorf("failed to read wails.json: %v", err)
	}

	var config WailsConfig
	if err := json.Unmarshal(data, &config); err != nil {
		return "", fmt.Errorf("failed to parse wails.json: %v", err)
	}

	return config.Info.ProductVersion, nil
}
