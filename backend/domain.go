package backend

import (
	"context"
	"sync"
	"time"

	"golang.org/x/oauth2"
	"google.golang.org/api/drive/v3"
)

// アプリケーションのメインの構造体
type App struct {
	ctx           *Context       // アプリケーションのコンテキスト
	appDataDir    string        // アプリケーションデータディレクトリのパス
	notesDir      string        // ノートファイル保存ディレクトリのパス
	noteService   *noteService  // ノート操作サービス
	driveService  *driveService // Google Drive操作サービス
	settingsService *settingsService // 設定操作サービス
	fileService   *fileService  // ファイル操作サービス
	frontendReady chan struct{} // フロントエンドの準備完了を通知するチャネル
} 

// アプリケーションのコンテキストを管理
type Context struct {
	ctx             context.Context
	skipBeforeClose bool // アプリケーション終了前の保存処理をスキップするかどうか
}

// ノートの基本情報
type Note struct {
	ID            string    `json:"id"`           // ノートの一意識別子
	Title         string    `json:"title"`        // ノートのタイトル
	Content       string    `json:"content"`      // ノートの本文内容
	ContentHeader string    `json:"contentHeader"` // アーカイブ時に表示される内容のプレビュー
	Language      string    `json:"language"`     // ノートで使用されているプログラミング言語
	ModifiedTime  time.Time `json:"modifiedTime"` // 最終更新日時
	Archived      bool      `json:"archived"`     // アーカイブ状態（true=アーカイブ済み）
}

// ノートのメタデータのみを保持
// コンテンツを除いた軽量なノート情報の管理に使用
type NoteMetadata struct {
	ID            string    `json:"id"`           // ノートの一意識別子
	Title         string    `json:"title"`        // ノートのタイトル
	ContentHeader string    `json:"contentHeader"` // アーカイブ時に表示される内容のプレビュー
	Language      string    `json:"language"`     // ノートで使用されているプログラミング言語
	ModifiedTime  time.Time `json:"modifiedTime"` // 最終更新日時
	Archived      bool      `json:"archived"`     // アーカイブ状態（true=アーカイブ済み）
	ContentHash   string    `json:"contentHash"`  // コンテンツのハッシュ値
	Order         int       `json:"order"`        // ノートの表示順序
}

// ノートのリストを管理
type NoteList struct {
	Version   string         `json:"version"`   // ノートリストのバージョン
	Notes     []NoteMetadata `json:"notes"`     // ノートのメタデータリスト
	LastSync  time.Time      `json:"lastSync"`  // 最後の同期日時
}

// アプリケーションの設定を管理
type Settings struct {
	FontFamily    string `json:"fontFamily"` // エディタで使用するフォントファミリー
	FontSize      int    `json:"fontSize"`   // フォントサイズ（ピクセル）
	IsDarkMode    bool   `json:"isDarkMode"` // ダークモードの有効/無効
	WordWrap      string `json:"wordWrap"`   // ワードラップの設定（"on"/"off"/"wordWrapColumn"）
	Minimap       bool   `json:"minimap"`    // ミニマップの表示/非表示
	WindowWidth   int    `json:"windowWidth"`  // ウィンドウの幅（ピクセル）
	WindowHeight  int    `json:"windowHeight"` // ウィンドウの高さ（ピクセル）
	WindowX       int    `json:"windowX"`      // ウィンドウのX座標
	WindowY       int    `json:"windowY"`      // ウィンドウのY座標
	IsMaximized   bool   `json:"isMaximized"`  // ウィンドウが最大化されているかどうか
}

// Google Driveとの同期機能を管理
type DriveSync struct {
	service                 *drive.Service  // Google Driveサービスのインスタンス
	token                   *oauth2.Token   // OAuth2認証トークン
	config                  *oauth2.Config  // OAuth2設定
	rootFolderID           string          // アプリケーションのルートフォルダID
	notesFolderID          string          // ノート保存用フォルダID
	mutex                  sync.Mutex      // 同期処理用のミューテックス
	isConnected            bool           // Google Driveへの接続状態
	startPageToken         string         // 変更履歴の開始トークン
	lastUpdated            map[string]time.Time // 最後の更新時刻を記録
	hasCompletedInitialSync bool          // 初回同期が完了したかどうか
	cloudNoteList          *NoteList      // クラウド上のノートリスト
}

