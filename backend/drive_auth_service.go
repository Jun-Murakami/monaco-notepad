package backend

import (
	"context"
	"encoding/json"
	"fmt"
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
			fmt.Printf("Error reading token file: %v\n", err)
			if !a.isTestMode {
				wailsRuntime.EventsEmit(a.ctx, "drive:status", "offline")
			}
			return err
		}

		var token oauth2.Token
		if err := json.Unmarshal(data, &token); err != nil {
			fmt.Printf("Error parsing token: %v\n", err)
			if !a.isTestMode {
				wailsRuntime.EventsEmit(a.ctx, "drive:status", "offline")
			}
			return err
		}

		// ここで実際に DriveClient を初期化
		if err := a.initializeDriveService(&token); err != nil {
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
							.message-box { text-align: center; width: 400px; padding: 2rem; background-color: grey; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
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
								.message-box { text-align: center; width: 400px; padding: 2rem; background-color: #00c1d9; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
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
								.message-box { text-align: center; width: 400px; padding: 2rem; background-color: #00c1d9; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
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
	authURL := a.driveSync.config.AuthCodeURL("state-token", oauth2.AccessTypeOffline)
	wailsRuntime.BrowserOpenURL(a.ctx, authURL)

	// 認証コードを待機
	select {
	case code := <-codeChan:
		// サーバーをシャットダウン
		server.Shutdown(a.ctx)
		// 認証を完了
		if err := a.CompleteAuth(code); err != nil {
			wailsRuntime.EventsEmit(a.ctx, "show-message", "Authentication Error",
				fmt.Sprintf("Failed to complete authentication: %v", err), false)
			return "", fmt.Errorf("failed to complete authentication: %v", err)
		}
		return "auth_complete", nil
	case <-time.After(3 * time.Minute):
		// タイムアウト
		server.Shutdown(a.ctx)
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
	fmt.Printf("Completing auth with code: %s\n", code)

	token, err := a.driveSync.config.Exchange(a.ctx, code)
	if err != nil {
		return fmt.Errorf("unable to retrieve token from web: %v", err)
	}

	fmt.Printf("Received token: %+v\n", token)

	// トークンを保存
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

// LogoutDrive はGoogle Driveからログアウトします
func (a *driveAuthService) LogoutDrive() error {
	fmt.Println("Logging out from Google Drive...")

	// ローカルの noteList を保存（ログアウト前に念のため）
	if err := a.noteService.saveNoteList(); err != nil {
		fmt.Printf("Failed to save note list before logout: %v\n", err)
	}

	// オフライン状態に遷移
	a.handleOfflineTransition(nil)

	// Intentionally left empty for future use
	return nil
}

// handleOfflineTransition はオフライン状態への遷移を処理します
func (a *driveAuthService) handleOfflineTransition(err error) {
	// エラーメッセージをログに記録
	errMsg := fmt.Sprintf("Drive error: %v", err)
	fmt.Printf("Drive error: %v\n", errMsg)
	
	// トークンファイルのパス
	tokenFile := filepath.Join(a.appDataDir, "token.json")
	
	// トークンファイルを削除
	if err := os.Remove(tokenFile); err != nil && !os.IsNotExist(err) {
		fmt.Printf("Failed to remove token file: %v\n", err)
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

	a.driveSync.service = srv
	a.driveSync.token = token
	a.driveSync.isConnected = true

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
