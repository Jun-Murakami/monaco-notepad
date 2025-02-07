package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"google.golang.org/api/drive/v3"
	"google.golang.org/api/option"
)

// DriveAuthService インターフェースを整理
type DriveAuthService interface {
	// 保存済みトークンがあれば自動的に接続を試みる
	InitializeWithSavedToken() error
	
	// 手動認証フローを開始し、認証完了まで待機
	StartManualAuth() error
	
	LogoutDrive() error
	CancelLoginDrive() error
	NotifyFrontendReady()
	IsConnected() bool
	IsTestMode() bool
	GetDriveSync() *DriveSync
	GetFrontendReadyChan() chan struct{}
	HandleOfflineTransition(err error) error
}

// driveAuthService の実装
type driveAuthService struct {
	ctx           context.Context
	appDataDir    string
	credentials   []byte
	driveSync     *DriveSync
	frontendReady chan struct{}
	isTestMode    bool
	notesDir      string
	noteService   *noteService
	initialized   bool
}

// NewDriveAuthService は認証を担当するサービスを生成します
func NewDriveAuthService(
	ctx context.Context,
	appDataDir string,
	notesDir string,
	noteService *noteService,
	credentials []byte,
	isTestMode bool,
) *driveAuthService {
	return &driveAuthService{
		ctx:           ctx,
		appDataDir:    appDataDir,
		notesDir:      notesDir,
		noteService:   noteService,
		credentials:   credentials,
		isTestMode:    isTestMode,
		frontendReady: make(chan struct{}), // バッファなしチャネル
		driveSync: &DriveSync{
			lastUpdated:    make(map[string]time.Time),
			cloudNoteList:  &NoteList{Version: "1.0", Notes: []NoteMetadata{}},
			isConnected:    false,
			hasCompletedInitialSync: false,
		},
		initialized: false,
	}
}

// initializeGoogleDrive は Google Drive の初期化と同期開始を行う共通処理
func (a *driveAuthService) initializeGoogleDrive(token *oauth2.Token) error {
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
func (a *driveAuthService) InitializeWithSavedToken() error {
	config, err := google.ConfigFromJSON(a.credentials, drive.DriveFileScope)
	if err != nil {
		return fmt.Errorf("unable to parse client secret file to config: %v", err)
	}
	a.driveSync.config = config

	// 保存済みトークンの読み込みを試行
	token, err := a.loadToken()
	if err != nil {
		// トークンがない場合はエラーを返すが、これは正常系
		return nil
	}

	// 初期化処理
	return a.initializeGoogleDrive(token)
}

// StartManualAuth は手動認証フローを開始
func (a *driveAuthService) StartManualAuth() error {
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
func (a *driveAuthService) saveToken(token *oauth2.Token) error {
	tokenFile := filepath.Join(a.appDataDir, "token.json")
	f, err := os.OpenFile(tokenFile, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	return json.NewEncoder(f).Encode(token)
}

// loadToken は保存済みトークンを読み込む
func (a *driveAuthService) loadToken() (*oauth2.Token, error) {
	tokenFile := filepath.Join(a.appDataDir, "token.json")
	f, err := os.Open(tokenFile)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	
	token := &oauth2.Token{}
	if err := json.NewDecoder(f).Decode(token); err != nil {
		return nil, err
	}
	return token, nil
}

// LogoutDrive はGoogle Driveからログアウトします
func (a *driveAuthService) LogoutDrive() error {
	a.sendLogMessage("Logging out from Google Drive...")

	// サーバーが実行中の場合は安全に停止
	if a.driveSync.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := a.driveSync.server.Shutdown(ctx); err != nil {
			a.sendLogMessage(fmt.Sprintf("Error shutting down auth server: %v", err))
		}
		a.driveSync.server = nil
	}

	// ローカルの noteList を保存（ログアウト前に念のため）
	if err := a.noteService.saveNoteList(); err != nil {
		a.sendLogMessage(fmt.Sprintf("Failed to save note list before logout: %v", err))
		fmt.Printf("Failed to save note list before logout: %v\n", err)
	}

	// オフライン状態に遷移
	a.HandleOfflineTransition(nil)

	// フロントエンドに通知
	if !a.isTestMode {
		wailsRuntime.EventsEmit(a.ctx, "drive:status", "offline")
	}

	return nil
}

// HandleOfflineTransition はオフライン状態への遷移を処理します（公開メソッドに変更）
func (a *driveAuthService) HandleOfflineTransition(err error) error {
	// エラーメッセージをログに記録
	errMsg := fmt.Sprintf("Drive error: %v", err)
	a.sendLogMessage(errMsg)
	
	// トークンファイルのパス
	tokenFile := filepath.Join(a.appDataDir, "token.json")
	
	// トークンファイルを削除
	if err := os.Remove(tokenFile); err != nil && !os.IsNotExist(err) {
		a.sendLogMessage(fmt.Sprintf("Failed to remove token file: %v", err))
	}

	// 認証状態をリセット
	a.driveSync.service = nil
	a.driveSync.isConnected = false
	
	// フロントエンドに通知
	if !a.isTestMode {
		wailsRuntime.EventsEmit(a.ctx, "drive:error", errMsg)
		wailsRuntime.EventsEmit(a.ctx, "drive:status", "offline")
	}

	return fmt.Errorf("offline transition: %v", err)
}

// initializeDriveService はDriveサービスを初期化します
func (a *driveAuthService) initializeDriveService(token *oauth2.Token) error {
	// トークンソースを作成（自動更新用）
	tokenSource := a.driveSync.config.TokenSource(a.ctx, token)

	// 自動更新されるクライアントを作成
	client := oauth2.NewClient(a.ctx, tokenSource)
	srv, err := drive.NewService(a.ctx, option.WithHTTPClient(client))
	if err != nil {
		return fmt.Errorf("unable to retrieve Drive client: %v", err)
	}

	a.sendLogMessage("Drive service initialized")

	// driveSync の各フィールドを初期化する前に nil チェックを行う
	if a.driveSync == nil {
		return fmt.Errorf("driveSync is not initialized")
	}

	a.driveSync.service = srv
	a.driveSync.token = token
	a.driveSync.isConnected = true

	// 初期化完了後にステータスを同期中に設定
	if !a.isTestMode {
		wailsRuntime.EventsEmit(a.ctx, "drive:status", "syncing")
	}

	return nil
}

// NotifyFrontendReady はフロントエンドの準備完了を通知します
func (a *driveAuthService) NotifyFrontendReady() {
	fmt.Println("AuthService.NotifyFrontendReady called")
	select {
	case <-a.frontendReady: // すでにチャネルが閉じていれば何もしない
		return
	default:
		close(a.frontendReady)
		fmt.Println("AuthService frontend ready channel closed")
	}
}

// ----------- 以下、ラッパとして必要であればインターフェース満たすために空実装か委譲かを置ける -----------

// IsConnected は現在の接続状態を返します
func (a *driveAuthService) IsConnected() bool {
	return a.driveSync != nil && a.driveSync.isConnected
}

// IsTestMode はテストモードかどうかを返します
func (a *driveAuthService) IsTestMode() bool {
	return a.isTestMode
}

// GetDriveSync は内部のDriveSyncポインタを返します（drive_service.go から同期処理で使うため）
func (a *driveAuthService) GetDriveSync() *DriveSync {
	return a.driveSync
}

// GetFrontendReadyChan は frontendReady チャネルを返します（drive_service 側で待ち受けるため）
func (a *driveAuthService) GetFrontendReadyChan() chan struct{} {
	return a.frontendReady
}

// driveAuthService構造体にsendLogMessageメソッドを追加
func (a *driveAuthService) sendLogMessage(message string) {
	if !a.isTestMode {
		wailsRuntime.EventsEmit(a.ctx, "logMessage", message)
	}
}

// CancelLoginDrive はログイン処理を安全にキャンセルします
func (a *driveAuthService) CancelLoginDrive() error {
	a.sendLogMessage("Canceling login process...")

	// サーバーが実行中の場合は安全に停止
	if a.driveSync.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := a.driveSync.server.Shutdown(ctx); err != nil {
			a.sendLogMessage(fmt.Sprintf("Error shutting down auth server: %v", err))
		}
		a.driveSync.server = nil
	}

	// リスナーを明示的に閉じる
	if a.driveSync.listener != nil {
		if err := a.driveSync.listener.Close(); err != nil {
			a.sendLogMessage(fmt.Sprintf("Error closing listener: %v", err))
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
func (a *driveAuthService) startAuthServer() (<-chan string, error) {
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
						background-color: #00c1d9; 
						border-radius: 8px; 
						box-shadow: 0 2px 4px rgba(0,0,0,0.1);
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

	// 一時的なHTTPサーバーを起動（カスタムServeMuxを使用）
	server := &http.Server{
		Addr:    ":34115",
		Handler: mux,  // カスタムServeMuxを使用
	}

	// 認証コードを受け取るためのチャネル
	codeChan := make(chan string, 1)
	timeoutChan := make(chan struct{}, 1)

	// ハンドラーをカスタムServeMuxに登録
	mux.HandleFunc("/oauth2callback", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-timeoutChan:
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprintf(w, htmlTemplate,
				"Authentication Error",           // title
				"error",                         // message-box class
				"text-error",                    // text class
				"Authentication Error",          // heading
				"Authentication timed out. Please try again.") // message
			return
		default:
			code := r.URL.Query().Get("code")
			if code != "" {
				codeChan <- code
				w.Header().Set("Content-Type", "text/html")
				fmt.Fprintf(w, htmlTemplate,
					"Authentication Complete",    // title
					"",                          // message-box class
					"text-success",              // text class
					"Authentication Complete!",   // heading
					"You can close this window and return to the app.") // message
			} else {
				w.Header().Set("Content-Type", "text/html")
				fmt.Fprintf(w, htmlTemplate,
					"Authentication Error",       // title
					"error",                     // message-box class
					"text-error",                // text class
					"Authentication Error",      // heading
					"Authentication failed. Please try again.") // message
			}
		}
	})

	// ポートが使用可能か確認
	var err error
	a.driveSync.listener, err = net.Listen("tcp", ":34115")
	if err != nil {
		return nil, fmt.Errorf("Port34115 is already in use: %v", err)
	}

	// サーバーを別のゴルーチンで起動
	serverErrChan := make(chan error, 1)
	go func() {
		if err := server.Serve(a.driveSync.listener); err != http.ErrServerClosed {
			serverErrChan <- err
		}
	}()

	// サーバー起動エラーをチェック
	select {
	case err := <-serverErrChan:
		return nil, fmt.Errorf("HTTP Server error: %v", err)
	case <-time.After(100 * time.Millisecond):
		// サーバーが正常に起動
	}

	return codeChan, nil
}
