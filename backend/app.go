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
// 3. FileNoteService (file_note_service.go)
//    - ローカルのファイルノート操作を担当
//    - ファイルノートの作成、読み込み、保存、削除
//    - ファイルノートリストの管理とメタデータの同期
//
// 4. DriveService (drive_service.go, drive_sync_service.go, drive_operations.go)
//    - Google Driveとの同期機能を提供
//    - 認証管理（OAuth2.0）
//    - ノートのクラウド同期
//    - 非同期操作のキュー管理
//
// 5. SettingsService (settings_service.go)
//    - アプリケーション設定の管理
//    - ウィンドウ状態の保存/復元
//    - ユーザー設定の保存/読み込み
//
// 6. FileService (file_service.go)
//    - ローカルファイルシステムとの操作
//    - ファイルの開く/保存ダイアログ
//    - 外部ファイルの読み込み
//
// ファイル構成：
// - app_logger.go: ログ出力とフロントエンド通知を担当
// - domain.go: データモデルの定義
// - app.go: メインアプリケーションロジック
// - auth_service.go: 認証管理の実装
// - note_service.go: ノート操作の実装
// - drive_service.go: Google Drive連携の中核実装
// - drive_sync_service.go: 同期ロジックの中レベル実装
// - drive_operations.go: Drive操作の低レベル実装
// - drive_operations_queue.go: Drive操作のキュー管理ラッパー
// - settings_service.go: 設定管理の実装
// - file_note_service.go: ファイルノート操作の実装
// - file_service.go: ファイル操作の実装

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
//
//go:embed credentials.json
var credentialsJSON []byte

// バージョン情報（ビルド時に-ldflagsで上書きされます）
var Version = "development"

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

	// AppLoggerの初期化
	a.logger = NewAppLogger(ctx, false, a.appDataDir)

	// FileServiceの初期化
	a.fileService = NewFileService(a.ctx)

	// SettingsServiceの初期化
	a.settingsService = NewSettingsService(a.appDataDir)

	// FileNoteServiceの初期化
	a.fileNoteService = NewFileNoteService(a.appDataDir)

	// NoteServiceの初期化 (NoteList読み込みを含む)
	noteService, err := NewNoteService(a.notesDir)
	if err != nil {
		a.logger.Error(err, "Error initializing note service")
		return
	}
	a.noteService = noteService
}

// フロントエンドにDOMが読み込まれたときに呼び出される関数 ------------------------------------------------------------
func (a *App) DomReady(ctx context.Context) {
	a.logger.Console("DomReady called")

	// AuthServiceの初期化
	authService := NewAuthService(
		ctx,
		a.appDataDir,
		a.notesDir,
		a.noteService,
		credentialsJSON,
		a.logger,
		false,
	)
	a.authService = authService

	// DriveServiceの初期化
	driveService := NewDriveService(
		ctx,
		a.appDataDir,
		a.notesDir,
		a.noteService,
		credentialsJSON,
		a.logger,
		authService,
	)
	a.driveService = driveService

	// Google Driveの初期化はフロントエンド準備完了後に実行
	// （DomReady時点ではReactのuseEffect登録が完了していない可能性があるため）
	go func() {
		<-authService.GetFrontendReadyChan()
		a.logger.Info("Frontend ready - initializing Google Drive...")
		if err := driveService.InitializeDrive(); err != nil {
			a.logger.Error(err, "Error initializing drive service")
			wailsRuntime.EventsEmit(ctx, "drive:status", "offline")
			wailsRuntime.EventsEmit(ctx, "drive:error", "Google Drive is not connected")
		}
	}()

	a.logger.Info("Emitting backend:ready event")
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
	a.logger.Console("DestroyApp called")
	// BeforeCloseイベントをスキップしてアプリケーションを終了
	a.ctx.SkipBeforeClose(true)
	wailsRuntime.Quit(a.ctx.ctx)
}

// フロントエンドの準備完了を通知する ------------------------------------------------------------
func (a *App) NotifyFrontendReady() {
	a.logger.Console("App.NotifyFrontendReady called") // デバッグログ
	if a.driveService != nil {
		a.driveService.NotifyFrontendReady()
	} else {
		a.logger.Console("Warning: driveService is nil") // デバッグログ
	}
}

// フロントエンドからのログ出力 ------------------------------------------------------------
func (a *App) Console(format string, args ...interface{}) {
	a.logger.Console(format, args...)
}

// ------------------------------------------------------------
// ノート関連の操作 (ノート操作メソッドとGoogle Drive操作メソッドを結合)
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
			a.logger.NotifyDriveStatus(a.ctx.ctx, "syncing")

			// ノートをアップロード
			if action == "create" {
				if err := a.driveService.CreateNote(&noteCopy); err != nil {
					a.authService.HandleOfflineTransition(fmt.Errorf("error creating note to Drive: %v", err))
					return
				}
			} else {
				if err := a.driveService.UpdateNote(&noteCopy); err != nil {
					a.authService.HandleOfflineTransition(fmt.Errorf("error updating note to Drive: %v", err))
					return
				}
			}

			// ノートリストをアップロード
			if err := a.driveService.UpdateNoteList(); err != nil {
				a.authService.HandleOfflineTransition(fmt.Errorf("error uploading note list to Drive: %v", err))
				return
			}

			// 同期完了を通知
			a.logger.NotifyDriveStatus(a.ctx.ctx, "synced")
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
		a.logger.NotifyDriveStatus(a.ctx.ctx, "syncing")
		if err := a.driveService.UpdateNoteList(); err != nil {
			return a.authService.HandleOfflineTransition(fmt.Errorf("error uploading note list to Drive: %v", err))
		}
		a.logger.NotifyDriveStatus(a.ctx.ctx, "synced")
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
			a.logger.NotifyDriveStatus(a.ctx.ctx, "syncing")

			// ノートを削除
			if err := a.driveService.DeleteNoteDrive(id); err != nil {
				a.authService.HandleOfflineTransition(fmt.Errorf("error deleting note from Drive: %v", err))
				return
			}

			// ノートリストをアップロード
			if err := a.driveService.UpdateNoteList(); err != nil {
				a.authService.HandleOfflineTransition(fmt.Errorf("error uploading note list to Drive: %v", err))
				return
			}

			a.logger.NotifyDriveStatus(a.ctx.ctx, "synced")
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
		return fmt.Errorf("error updating note order: %v", err)
	}

	// ドライブサービスが初期化されており、接続中の場合はアップロード
	if a.driveService != nil && a.driveService.IsConnected() {
		go func() {
			// ノートリストをアップロード
			if err := a.driveService.UpdateNoteList(); err != nil {
				a.authService.HandleOfflineTransition(fmt.Errorf("error uploading note list to Drive: %v", err))
				return
			}

			a.logger.NotifyDriveStatus(a.ctx.ctx, "synced")
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
		return a.authService.HandleOfflineTransition(fmt.Errorf("driveService not initialized yet"))
	}
	return a.driveService.InitializeDrive()
}

// Google Driveに手動ログイン
func (a *App) AuthorizeDrive() error {
	if a.driveService == nil {
		return fmt.Errorf("drive service is not initialized")
	}

	a.logger.NotifyDriveStatus(a.ctx.ctx, "logging in")
	a.logger.Info("Waiting for login...")
	if err := a.driveService.AuthorizeDrive(); err != nil {
		return a.authService.HandleOfflineTransition(err)
	}
	a.logger.Info("AuthorizeDrive success")
	return nil
}

// 認証をキャンセル ------------------------------------------------------------
func (a *App) CancelLoginDrive() error {
	if a.driveService != nil {
		return a.driveService.CancelLoginDrive()
	}
	return a.authService.HandleOfflineTransition(fmt.Errorf("drive service is not initialized"))
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
	return a.authService.HandleOfflineTransition(fmt.Errorf("drive service is not initialized or not connected"))
}

// Google Driveとの接続状態をチェック ------------------------------------------------------------
func (a *App) CheckDriveConnection() bool {
	if a.driveService == nil {
		return false
	}
	return a.driveService.IsConnected()
}

// ------------------------------------------------------------
// ファイルノート関連の操作
// ------------------------------------------------------------

// ファイルノートを読み込む
func (a *App) LoadFileNotes() ([]FileNote, error) {
	return a.fileNoteService.LoadFileNotes()
}

// ファイルノートを保存する
func (a *App) SaveFileNotes(list []FileNote) (string, error) {
	return a.fileNoteService.SaveFileNotes(list)
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

// 指定されたパスのファイルの変更時間を取得
func (a *App) GetModifiedTime(filePath string) (time.Time, error) {
	return a.fileService.GetModifiedTime(filePath)
}

// ファイルが変更されているかチェック
func (a *App) CheckFileModified(filePath string, lastModifiedTime string) (bool, error) {
	return a.fileService.CheckFileModified(filePath, lastModifiedTime)
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
	// フロントエンドの準備状態をチェック
	if a.ctx == nil || a.ctx.ctx == nil {
		return fmt.Errorf("application context is not ready")
	}

	// ファイルの内容を読み込む
	content, err := a.fileService.OpenFile(filePath)
	if err != nil {
		return a.logger.Error(err, "error opening file from external")
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
	settings, err := a.settingsService.LoadSettings()
	if err != nil {
		return nil, a.logger.Error(err, "failed to load settings")
	}

	// デバッグモードを設定
	a.logger.SetDebugMode(settings.IsDebug)
	return settings, nil
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
	return Version, nil
}

// OpenURL は指定されたURLをデフォルトブラウザで開きます
func (a *App) OpenURL(url string) error {
	wailsRuntime.BrowserOpenURL(a.ctx.ctx, url)
	return nil
}

// CheckFileExists は指定されたパスのファイルが存在するかチェックします
func (a *App) CheckFileExists(path string) bool {
	return a.fileService.CheckFileExists(path)
}
