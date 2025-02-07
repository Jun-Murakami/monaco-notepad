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

// driveAuthService は DriveService のうち、認証・初期接続・切断に関する処理を担当します
type driveAuthService struct {
	ctx           context.Context
	appDataDir    string
	credentials   []byte
	driveSync     *DriveSync
	frontendReady chan struct{}
	isTestMode    bool
	notesDir      string
	noteService   *noteService

	initialized bool // 初期化フラグ
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

// InitializeDrive はGoogle Drive APIの初期化を行います
// （インターフェースから呼び出される想定）
func (a *driveAuthService) InitializeDrive() error {
	config, err := google.ConfigFromJSON(a.credentials, drive.DriveFileScope)
	if err != nil {
		a.sendLogMessage(fmt.Sprintf("unable to parse client secret file to config: %v", err))
		return fmt.Errorf("unable to parse client secret file to config: %v", err)
	}
	// リダイレクトURIを設定
	config.RedirectURL = "http://localhost:34115/oauth2callback"
	a.driveSync.config = config

	// 保存済みのトークンがあれば自動的に接続を試みる
	tokenFile := filepath.Join(a.appDataDir, "token.json")
	if _, err := os.Stat(tokenFile); err == nil {
		if !a.isTestMode {
			wailsRuntime.EventsEmit(a.ctx, "drive:status", "syncing")
		}

		data, err := os.ReadFile(tokenFile)
		if err != nil {
			a.sendLogMessage(fmt.Sprintf("Error reading token file: %v", err))
			fmt.Printf("Error reading token file: %v\n", err)
			if !a.isTestMode {
				wailsRuntime.EventsEmit(a.ctx, "drive:status", "offline")
			}
			return err
		}

		var token oauth2.Token
		if err := json.Unmarshal(data, &token); err != nil {
			a.sendLogMessage(fmt.Sprintf("Error parsing token: %v", err))
			fmt.Printf("Error parsing token: %v\n", err)
			if !a.isTestMode {
				wailsRuntime.EventsEmit(a.ctx, "drive:status", "offline")
			}
			return err
		}

		// ここで実際に DriveClient を初期化
		if err := a.initializeDriveService(&token); err != nil {
			a.sendLogMessage(fmt.Sprintf("Error initializing Drive service: %v", err))
			fmt.Printf("Error initializing Drive service: %v\n", err)
			if !a.isTestMode {
				wailsRuntime.EventsEmit(a.ctx, "drive:status", "offline")
			}
			return err
		}
	}

	return nil
}

// AuthorizeDrive はGoogle Driveの認証フローを開始します
func (a *driveAuthService) AuthorizeDrive() (string, error) {
	if a.driveSync.config == nil {
		if err := a.InitializeDrive(); err != nil {
			return "", err
		}
	}

	if !a.isTestMode {
		wailsRuntime.EventsEmit(a.ctx, "drive:status", "syncing")
	}

	wailsRuntime.EventsEmit(a.ctx, "drive:status", "logging in")

	// 既存のサーバーが残っていないことを確認
	if a.driveSync.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		a.driveSync.server.Shutdown(ctx)
	}

	// 認証コードを受け取るためのチャネル
	codeChan := make(chan string, 1)
	timeoutChan := make(chan struct{}, 1)

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
		return "", fmt.Errorf("Port34115 is already in use: %v", err)
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
		return "", fmt.Errorf("HTTP Server error: %v", err)
	case <-time.After(100 * time.Millisecond):
		// サーバーが正常に起動
	}

	// 認証URLを開く
	authURL := a.driveSync.config.AuthCodeURL("state-token", oauth2.AccessTypeOffline)
	wailsRuntime.BrowserOpenURL(a.ctx, authURL)

	// 認証コードを待機
	select {
	case code := <-codeChan:
		// サーバーをシャットダウン
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			fmt.Printf("Error shutting down server: %v\n", err)
		}
		
		// 認証を完了
		if err := a.CompleteAuth(code); err != nil {
			wailsRuntime.EventsEmit(a.ctx, "show-message", "Authentication Error",
				fmt.Sprintf("Failed to complete authentication: %v", err), false)
			a.sendLogMessage(fmt.Sprintf("Failed to complete authentication: %v", err))
			return "", fmt.Errorf("failed to complete authentication: %v", err)
		}
		return "auth_complete", nil
		
	case <-time.After(3 * time.Minute):
		// タイムアウト
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			fmt.Printf("Error shutting down server: %v\n", err)
		}
		
		close(timeoutChan)
		a.handleOfflineTransition(nil)
		if !a.isTestMode {
			wailsRuntime.EventsEmit(a.ctx, "drive:status", "offline")
		}
		wailsRuntime.EventsEmit(a.ctx, "show-message", "Authentication Error",
			"Authentication timed out. Please try again.", false)
		return "", fmt.Errorf("authentication timed out, please try again")
	}
}

// CompleteAuth は認証コードを使用してGoogle Drive認証を完了します
func (a *driveAuthService) CompleteAuth(code string) error {
	a.sendLogMessage("Finalizing authentication...")
	
	token, err := a.driveSync.config.Exchange(a.ctx, code)
	if err != nil {
		a.sendLogMessage("Authentication failed")
		return fmt.Errorf("unable to retrieve token from web: %v", err)
	}

	fmt.Printf("Received token: %+v\n", token)

	// トークンを保存
	tokenFile := filepath.Join(a.appDataDir, "token.json")
	f, err := os.OpenFile(tokenFile, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		a.sendLogMessage(fmt.Sprintf("unable to cache oauth token: %v", err))
		return fmt.Errorf("unable to cache oauth token: %v", err)
	}
	defer f.Close()

	if err := json.NewEncoder(f).Encode(token); err != nil {
		return fmt.Errorf("failed to encode token: %v", err)
	}

	fmt.Printf("Token saved to: %s\n", tokenFile)
	a.sendLogMessage("Authentication successful")
	return a.initializeDriveService(token)
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
	a.handleOfflineTransition(nil)

	// フロントエンドに通知
	if !a.isTestMode {
		wailsRuntime.EventsEmit(a.ctx, "drive:status", "offline")
	}

	return nil
}

// handleOfflineTransition はオフライン状態への遷移を処理します
func (a *driveAuthService) handleOfflineTransition(err error) {
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
		wailsRuntime.EventsEmit(a.ctx, "drive:status", "offline")
	}
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
	a.handleOfflineTransition(nil)

	// フロントエンドに通知
	if !a.isTestMode {
		wailsRuntime.EventsEmit(a.ctx, "drive:status", "offline")
	}

	return nil
}
