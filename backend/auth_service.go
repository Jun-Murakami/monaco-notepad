package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"google.golang.org/api/drive/v3"
	"google.golang.org/api/option"
)

// 認証サービスのインターフェース
type AuthService interface {
	InitializeWithSavedToken() (bool, error) // 保存済みトークンがあれば自動的に接続を試みる
	StartManualAuth() error                  // 手動認証フローを開始し、認証完了まで待機
	LogoutDrive() error                      // Google Driveからログアウト
	CancelLoginDrive() error                 // ログイン処理を安全にキャンセル
	NotifyFrontendReady()                    // フロントエンドの準備完了を通知
	IsConnected() bool                       // 現在の接続状態を返す
	IsTestMode() bool                        // テストモードかどうかを返す
	GetDriveSync() *DriveSync                // DriveSyncポインタを返す
	GetFrontendReadyChan() chan struct{}     // frontendReady チャネルを返す
	HandleOfflineTransition(err error) error // オフライン状態への遷移を処理
}

// driveAuthService の実装
type authService struct {
	ctx           context.Context
	appDataDir    string
	credentials   []byte
	driveSync     *DriveSync
	frontendReady chan struct{}
	isTestMode    bool
	logger        AppLogger
	notesDir      string
	noteService   *noteService
	initialized   bool
	closeOnce     sync.Once // 追加：sync.Onceを使用してチャネルを一度だけ閉じる
}

// NewAuthService は認証を担当するサービスを生成します
func NewAuthService(
	ctx context.Context,
	appDataDir string,
	notesDir string,
	noteService *noteService,
	credentials []byte,
	logger AppLogger,
	isTestMode bool,
) *authService {
	return &authService{
		ctx:           ctx,
		appDataDir:    appDataDir,
		notesDir:      notesDir,
		noteService:   noteService,
		credentials:   credentials,
		isTestMode:    isTestMode,
		logger:        logger,
		frontendReady: make(chan struct{}), // バッファなしチャネル
		driveSync: &DriveSync{
			cloudNoteList:           &NoteList{Version: "1.0", Notes: []NoteMetadata{}},
			isConnected:             false,
			hasCompletedInitialSync: false,
		},
		initialized: false,
	}
}

// initializeGoogleDrive は Google Drive の初期化と同期開始を行う共通処理
func (a *authService) initializeGoogleDrive(token *oauth2.Token) error {
	// Drive サービスの初期化
	if err := a.initializeDriveService(token); err != nil {
		return fmt.Errorf("failed to initialize drive service: %v", err)
	}

	// トークンの保存
	if err := a.saveToken(token); err != nil {
		return fmt.Errorf("failed to save token: %v", err)
	}

	return nil
}

// InitializeWithSavedToken は保存済みトークンを使用して初期化
func (a *authService) InitializeWithSavedToken() (bool, error) {
	a.logger.Console("Attempting to initialize with saved token...")

	config, err := google.ConfigFromJSON(a.credentials, drive.DriveFileScope)
	if err != nil {
		return false, fmt.Errorf("unable to parse client secret file to config: %v", err)
	}
	a.driveSync.config = config

	// 保存済みトークンの読み込みを試行
	token, err := a.loadToken()
	if err != nil {
		a.logger.Console("No saved token found or failed to load token")
		return false, nil
	}

	// トークンソースを作成（期限切れの場合はリフレッシュトークンで自動更新）
	tokenSource := config.TokenSource(a.ctx, token)
	client := oauth2.NewClient(a.ctx, tokenSource)

	// 接続テストのタイムアウトを設定
	ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
	defer cancel()

	srv, err := drive.NewService(ctx, option.WithHTTPClient(client))
	if err != nil {
		a.logger.Console("Failed to create Drive service: %v", err)
		return false, nil
	}

	// 実際にDriveへの接続をテスト（トークンのリフレッシュもここで自動的に行われる）
	_, err = srv.Files.List().Fields("files(id, name)").PageSize(1).Do()
	if err != nil {
		a.logger.Console("Failed to connect to Drive: %v", err)
		// 認証エラーの場合のみトークンファイルを削除
		errStr := err.Error()
		if strings.Contains(errStr, "invalid_grant") ||
			strings.Contains(errStr, "unauthorized") ||
			strings.Contains(errStr, "revoked") {
			tokenFile := filepath.Join(a.appDataDir, "token.json")
			if removeErr := os.Remove(tokenFile); removeErr != nil && !os.IsNotExist(removeErr) {
				a.logger.Console("Failed to remove invalid token file: %v", removeErr)
			}
			a.logger.Console("Removed invalid token file due to auth error")
		}
		return false, nil
	}

	// リフレッシュされた可能性のあるトークンを保存
	newToken, tokenErr := tokenSource.Token()
	if tokenErr == nil {
		if err := a.saveToken(newToken); err != nil {
			a.logger.Console("Failed to save refreshed token: %v", err)
		} else if newToken.AccessToken != token.AccessToken {
			a.logger.Console("Saved refreshed token")
		}
		token = newToken
	}

	a.logger.Info("Successfully validated saved token")

	// 初期化処理
	return true, a.initializeGoogleDrive(token)
}

// StartManualAuth は手動認証フローを開始
func (a *authService) StartManualAuth() error {
	if a.driveSync.config == nil {
		config, err := google.ConfigFromJSON(a.credentials, drive.DriveFileScope)
		if err != nil {
			return fmt.Errorf("unable to parse client secret file to config: %v", err)
		}
		a.driveSync.config = config
	}

	// 認証サーバーの起動
	codeChan, err := a.startAuthServer()
	if err != nil {
		return fmt.Errorf("failed to start auth server: %v", err)
	}

	// 認証URLを開く
	authURL := a.driveSync.config.AuthCodeURL("state-token", oauth2.AccessTypeOffline)
	wailsRuntime.BrowserOpenURL(a.ctx, authURL)

	// 認証コードの待機
	select {
	case code := <-codeChan:
		// 認証コードを使用してトークンを取得
		token, err := a.driveSync.config.Exchange(a.ctx, code)
		if err != nil {
			return fmt.Errorf("failed to exchange token: %v", err)
		}

		// 初期化処理
		return a.initializeGoogleDrive(token)

	case <-time.After(3 * time.Minute):
		return fmt.Errorf("authentication timed out")
	}
}

// saveToken はトークンをファイルに保存
func (a *authService) saveToken(token *oauth2.Token) error {
	tokenFile := filepath.Join(a.appDataDir, "token.json")
	f, err := os.OpenFile(tokenFile, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	return json.NewEncoder(f).Encode(token)
}

// loadToken は保存済みトークンを読み込む
func (a *authService) loadToken() (*oauth2.Token, error) {
	tokenFile := filepath.Join(a.appDataDir, "token.json")
	f, err := os.Open(tokenFile)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	token := &oauth2.Token{}
	err = json.NewDecoder(f).Decode(token)
	if err != nil {
		return nil, err
	}

	// デバッグ用のログ追加
	a.logger.Console(fmt.Sprintf("Loaded token - Expiry: %v, Valid: %v",
		token.Expiry,
		token.Valid()))

	return token, nil
}

// LogoutDrive はGoogle Driveからログアウトします
func (a *authService) LogoutDrive() error {
	// サーバーが実行中の場合は安全に停止
	if a.driveSync.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := a.driveSync.server.Shutdown(ctx); err != nil {
			// 既に閉じられているコネクションのエラーは無視
			if !strings.Contains(err.Error(), "use of closed network connection") {
				a.logger.Console("Error shutting down auth server: %v", err)
			}
		}
		a.driveSync.server = nil
	}

	// リスナーが残っている場合のみクローズ
	if a.driveSync.listener != nil {
		if err := a.driveSync.listener.Close(); err != nil {
			// 既に閉じられているコネクションのエラーは無視
			if !strings.Contains(err.Error(), "use of closed network connection") {
				a.logger.Console("Error closing listener: %v", err)
				return fmt.Errorf("failed to close listener: %v", err)
			}
		}
		a.driveSync.listener = nil
	}

	// ローカルの noteList を保存（ログアウト前に念のため）
	if err := a.noteService.saveNoteList(); err != nil {
		a.logger.Console("Failed to save note list before logout: %v", err)
	}

	// オフライン状態に遷移
	a.HandleOfflineTransition(nil)

	// フロントエンドに通知
	if !a.isTestMode {
		wailsRuntime.EventsEmit(a.ctx, "drive:status", "offline")
	}

	// 少し待機してポートが完全に解放されるのを待つ
	time.Sleep(1 * time.Second)

	a.logger.Info("Logged out from Google Drive")
	return nil
}

// HandleOfflineTransition はオフライン状態への遷移を処理します（公開メソッドに変更）
func (a *authService) HandleOfflineTransition(err error) error {
	if err == nil {
		a.handleFullOfflineTransition(nil)
		return nil
	}

	errStr := err.Error()

	// ノートファイルが見つからないエラーは一時的なエラーとして扱う
	if strings.Contains(errStr, "note file") && strings.Contains(errStr, "not found") {
		a.logger.Console("Note file not found")
		return fmt.Errorf("note file not found")
	}

	// 認証エラー: リフレッシュトークン無効・取り消し等 → トークン削除＋完全オフライン
	if strings.Contains(errStr, "invalid_grant") ||
		strings.Contains(errStr, "unauthorized") ||
		strings.Contains(errStr, "revoked") ||
		strings.Contains(errStr, "401") {
		a.handleFullOfflineTransition(err)
		return fmt.Errorf("auth error, offline transition: %v", err)
	}

	// ネットワーク・一時的エラー → トークン保持のまま一時オフライン
	a.handleTemporaryOffline(err)
	return fmt.Errorf("temporary offline: %v", err)
}

// handleTemporaryOffline はトークンを保持したまま一時的にオフラインにする
func (a *authService) handleTemporaryOffline(err error) {
	if err != nil {
		a.logger.Error(err, fmt.Sprintf("Temporary offline: %v", err))
	}
	a.driveSync.SetConnected(false)
	a.logger.NotifyDriveStatus(a.ctx, "offline")
}

// handleFullOfflineTransition は完全なオフライン遷移を実行
func (a *authService) handleFullOfflineTransition(err error) {
	// エラーメッセージをログに記録
	errMsg := fmt.Sprintf("Drive error: %v", err)

	// トークンファイルを削除
	tokenFile := filepath.Join(a.appDataDir, "token.json")
	if err := os.Remove(tokenFile); err != nil && !os.IsNotExist(err) {
		a.logger.Console("Failed to remove token file: %v", err)
	}

	// 初回同期完了フラグファイルを削除
	syncFlagPath := filepath.Join(a.appDataDir, "initial_sync_completed")
	if err := os.Remove(syncFlagPath); err != nil && !os.IsNotExist(err) {
		a.logger.Console("Failed to remove sync flag file: %v", err)
	}

	// 認証状態をリセット
	a.driveSync.hasCompletedInitialSync = false
	a.driveSync.service = nil
	a.driveSync.SetConnected(false)

	// フロントエンドに通知
	if err != nil || errMsg != "" {
		a.logger.Error(err, errMsg)
	}
	a.logger.NotifyDriveStatus(a.ctx, "offline")
}

// initializeDriveService はDriveサービスを初期化します
func (a *authService) initializeDriveService(token *oauth2.Token) error {
	// トークンソースを作成（自動更新用）
	tokenSource := a.driveSync.config.TokenSource(a.ctx, token)

	// 自動更新されるクライアントを作成
	client := oauth2.NewClient(a.ctx, tokenSource)
	srv, err := drive.NewService(a.ctx, option.WithHTTPClient(client))
	if err != nil {
		return a.logger.Error(err, "unable to retrieve Drive client")
	}

	a.logger.Info("Drive service initialized")

	// driveSync の各フィールドを初期化する前に nil チェックを行う
	if a.driveSync == nil {
		return a.logger.Error(nil, "driveSync is not initialized")
	}

	a.driveSync.service = srv
	a.driveSync.token = token
	a.driveSync.SetConnected(true)

	// 初期化完了後にステータスを同期中に設定
	a.logger.NotifyDriveStatus(a.ctx, "syncing")

	return nil
}

// NotifyFrontendReady はフロントエンドの準備完了を通知します
func (a *authService) NotifyFrontendReady() {
	a.logger.Console("AuthService.NotifyFrontendReady called")
	a.closeOnce.Do(func() {
		a.logger.Console("Closing frontend ready channel")
		close(a.frontendReady)
		a.logger.Console("Frontend ready channel closed")
	})
}

// ----------- 以下、ラッパとして必要であればインターフェース満たすために空実装か委譲かを置ける -----------

// IsConnected は現在の接続状態を返します
func (a *authService) IsConnected() bool {
	return a.driveSync != nil && a.driveSync.Connected()
}

// IsTestMode はテストモードかどうかを返します
func (a *authService) IsTestMode() bool {
	return a.isTestMode
}

// GetDriveSync は内部のDriveSyncポインタを返します（drive_service.go から同期処理で使うため）
func (a *authService) GetDriveSync() *DriveSync {
	return a.driveSync
}

// GetFrontendReadyChan は frontendReady チャネルを返します（drive_service 側で待ち受けるため）
func (a *authService) GetFrontendReadyChan() chan struct{} {
	return a.frontendReady
}

// CancelLoginDrive はログイン処理を安全にキャンセルします
func (a *authService) CancelLoginDrive() error {
	a.logger.Console("Canceling login process...")

	// サーバーが実行中の場合は安全に停止
	if a.driveSync.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := a.driveSync.server.Shutdown(ctx); err != nil {
			// 既に閉じられているコネクションのエラーは無視
			if !strings.Contains(err.Error(), "use of closed network connection") {
				a.logger.Error(err, fmt.Sprintf("Error shutting down auth server: %v", err))
			}
		}
		a.driveSync.server = nil
	}

	// リスナーを明示的に閉じる
	if a.driveSync.listener != nil {
		if err := a.driveSync.listener.Close(); err != nil {
			// 既に閉じられているコネクションのエラーは無視
			if !strings.Contains(err.Error(), "use of closed network connection") {
				a.logger.Console("Error closing listener: %v", err)
				return a.logger.Error(err, fmt.Sprintf("Error closing listener: %v", err))
			}
		}
		a.driveSync.listener = nil
	}

	// オフライン状態に遷移
	a.HandleOfflineTransition(nil)

	// フロントエンドに通知
	if !a.isTestMode {
		wailsRuntime.EventsEmit(a.ctx, "drive:status", "offline")
	}

	return nil
}

// startAuthServer は認証サーバーを起動し、認証コードを待機
func (a *authService) startAuthServer() (<-chan string, error) {
	// リダイレクトURIを設定
	a.driveSync.config.RedirectURL = "http://localhost:34115/oauth2callback"

	// カスタムServeMuxを作成して、ハンドラーの重複を防ぐ
	mux := http.NewServeMux()

	// 共通のHTMLテンプレートを定義
	const htmlTemplate = `
		<html>
			<head>
				<title>%s</title>
				<style>
					body { 
						font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
						margin: 0;
						background-color: #f5f5f5;
					}
					.container { 
						display: flex; 
						flex-direction: column;
						justify-content: center; 
						align-items: center; 
						height: 100vh;
						margin: 0;
					}
					.app-icon {
						width: 80px;
						height: 80px;
						margin-bottom: 2rem;
					}
					.message-box { 
						text-align: center; 
						width: 400px; 
						padding: 2rem; 
						margin-bottom: 100px;
						background-color: #00c1d9; 
						border-radius: 8px; 
						box-shadow: 0 2px 6px rgba(0,0,0,0.3);
					}
					.message-box.error {
						background-color: grey;
					}
					.text-error { 
						color: #d32f2f; 
					}
					.text-success {
						color: #ffffff;
					}
				</style>
			</head>
			<body>
				<div class="container">
					<svg class="app-icon" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/xlink" viewBox="0 0 123.03 161.61">
						<defs>
							<linearGradient id="b" x1="61.52" y1="153.24" x2="61.52" y2="24.34" gradientUnits="userSpaceOnUse">
								<stop offset=".04" stop-color="#fff"/>
								<stop offset=".15" stop-color="#898787"/>
								<stop offset=".28" stop-color="#040000"/>
							</linearGradient>
							<linearGradient id="c" x1="7.72" y1="-17.7" x2="111.12" y2="161.38" gradientUnits="userSpaceOnUse">
								<stop offset="0" stop-color="#bcd3d6"/>
								<stop offset=".08" stop-color="#a7cfd4"/>
								<stop offset=".32" stop-color="#6ac4d0"/>
								<stop offset=".53" stop-color="#3dbccd"/>
								<stop offset=".69" stop-color="#22b7cb"/>
								<stop offset=".78" stop-color="#18b6cb"/>
							</linearGradient>
						</defs>
						<rect x="2.58" y="31.58" width="117.87" height="127.52" rx="17.87" ry="17.87" style="fill: #b65e20; stroke: #af5c21; stroke-miterlimit: 10; stroke-width: 5px;"/>
						<rect x="2.58" y="24.34" width="117.87" height="128.9" rx="18.36" ry="18.36" style="fill: url(#b); stroke: #231815; stroke-miterlimit: 10; stroke-width: .25px;"/>
						<rect x="1" y="11.71" width="121.03" height="127.52" rx="20.58" ry="20.58" style="fill: url(#c); stroke: #003b43; stroke-miterlimit: 10; stroke-width: 2px;"/>
						<rect x="18.7" width="17.23" height="23.41" rx="7.48" ry="7.48" style="fill: #004d57;"/>
						<rect x="52.9" width="17.23" height="23.41" rx="7.48" ry="7.48" style="fill: #004d57;"/>
						<rect x="87.11" width="17.23" height="23.41" rx="7.48" ry="7.48" style="fill: #004d57;"/>
						<g>
							<path d="M19.49,67.17l33.49-19.23v11.99l-23.86,12.74,23.86,12.78v11.95l-33.49-19.23v-10.99Z" style="fill: #004d57;"/>
							<path d="M103.54,78.16l-33.49,19.23v-11.95l23.88-12.8-23.88-12.72v-11.99l33.49,19.32v10.9Z" style="fill: #004d57;"/>
						</g>
					</svg>
					<div class="message-box %s">
						<h3 class="%s">%s</h3>
						<p>%s</p>
					</div>
				</div>
			</body>
		</html>
	`

	// 認証コードを受け取るためのチャネル
	codeChan := make(chan string, 1)
	timeoutChan := make(chan struct{}, 1)

	// サーバーをdriveSync構造体に保存
	server := &http.Server{
		Addr:    ":34115",
		Handler: mux,
	}
	a.driveSync.server = server

	// ハンドラーをカスタムServeMuxに登録
	mux.HandleFunc("/oauth2callback", func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		if code != "" {
			select {
			case <-timeoutChan:
				w.Header().Set("Content-Type", "text/html")
				fmt.Fprintf(w, htmlTemplate,
					"Monaco Notepad",       // title
					"error",                // message-box class
					"text-error",           // text class
					"Authentication Error", // heading
					"Authentication timed out. Please try again.") // message
			default:
				// コードをチャネルに送信
				codeChan <- code

				// レスポンスを送信
				w.Header().Set("Content-Type", "text/html")
				fmt.Fprintf(w, htmlTemplate,
					"Monaco Notepad",             // title
					"",                           // message-box class
					"text-success",               // text class
					"Connected to Google Drive!", // heading
					"You can close this window and return to the app.") // message

				// サーバーを安全に停止
				go func() {
					time.Sleep(1 * time.Second) // レスポンスが確実に送信されるのを待つ
					if err := server.Shutdown(context.Background()); err != nil {
						if !strings.Contains(err.Error(), "use of closed network connection") {
							a.logger.Console("Error shutting down auth server: %v", err)
						}
					}
					// シャットダウン後にリスナーをnilに設定
					a.driveSync.listener = nil
					a.driveSync.server = nil
				}()
			}
		} else {
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprintf(w, htmlTemplate,
				"Monaco Notepad",                  // title
				"error",                           // message-box class
				"text-error",                      // text class
				"Login Error",                     // heading
				"Login failed. Please try again.") // message
		}
	})

	// ポートが使用可能か確認
	var err error
	a.driveSync.listener, err = net.Listen("tcp", ":34115")
	if err != nil {
		return nil, fmt.Errorf("Port34115 is already in use: %v", err)
	}

	// サーバーを別のゴルーチンで起動
	go func() {
		if err := server.Serve(a.driveSync.listener); err != http.ErrServerClosed {
			a.logger.Console("Server error: %v", err)
		}
	}()

	return codeChan, nil
}
