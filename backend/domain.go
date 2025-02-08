package backend

import (
	"context"
	"net"
	"net/http"
	"sync"
	"time"

	"golang.org/x/oauth2"
	"google.golang.org/api/drive/v3"
)

// アプリケーションのメインの構造体
type App struct {
	ctx             *Context         // アプリケーションのコンテキスト
	appDataDir      string           // アプリケーションデータディレクトリのパス
	notesDir        string           // ノートファイル保存ディレクトリのパス
	noteService     *noteService     // ノート操作サービス
	driveService    DriveService     // Google Drive操作サービス (インターフェースで受けるよう変更)
	settingsService *settingsService // 設定操作サービス
	fileService     *fileService     // ファイル操作サービス
	frontendReady   chan struct{}    // フロントエンドの準備完了を通知するチャネル
}

// アプリケーションのコンテキストを管理
type Context struct {
	ctx             context.Context
	skipBeforeClose bool // アプリケーション終了前の保存処理をスキップするかどうか
}

// ノートの基本情報
type Note struct {
	ID            string    `json:"id"`            // ノートの一意識別子
	Title         string    `json:"title"`         // ノートのタイトル
	Content       string    `json:"content"`       // ノートの本文内容
	ContentHeader string    `json:"contentHeader"` // アーカイブ時に表示される内容のプレビュー
	Language      string    `json:"language"`      // ノートで使用されているプログラミング言語
	ModifiedTime  time.Time `json:"modifiedTime"`  // 最終更新日時
	Archived      bool      `json:"archived"`      // アーカイブ状態（true=アーカイブ済み）
	Order         int       `json:"order"`         // ノートの表示順序
}

// ノートのメタデータのみを保持
type NoteMetadata struct {
	ID            string    `json:"id"`
	Title         string    `json:"title"`
	ContentHeader string    `json:"contentHeader"`
	Language      string    `json:"language"`
	ModifiedTime  time.Time `json:"modifiedTime"`
	Archived      bool      `json:"archived"`
	ContentHash   string    `json:"contentHash"`
	Order         int       `json:"order"`
}

// ノートのリストを管理
type NoteList struct {
	Version  string         `json:"version"`
	Notes    []NoteMetadata `json:"notes"`
	LastSync time.Time      `json:"lastSync"`
}

// アプリケーションの設定を管理
type Settings struct {
	FontFamily   string `json:"fontFamily"`
	FontSize     int    `json:"fontSize"`
	IsDarkMode   bool   `json:"isDarkMode"`
	WordWrap     string `json:"wordWrap"`
	Minimap      bool   `json:"minimap"`
	WindowWidth  int    `json:"windowWidth"`
	WindowHeight int    `json:"windowHeight"`
	WindowX      int    `json:"windowX"`
	WindowY      int    `json:"windowY"`
	IsMaximized  bool   `json:"isMaximized"`
}

// Google Driveとの同期機能を管理
type DriveSync struct {
	service                 *drive.Service // Google Driveサービスのインスタンス
	token                   *oauth2.Token  // OAuth2認証トークン
	server                  *http.Server   // 認証サーバー
	listener                net.Listener   // 認証サーバーのリスナー
	config                  *oauth2.Config // OAuth2設定
	rootFolderID            string         // アプリケーションのルートフォルダID
	notesFolderID           string         // ノート保存用フォルダID
	noteListID              string         // ノートリストのファイルID
	mutex                   sync.Mutex     // 同期処理用のミューテックス
	isConnected             bool           // Google Driveへの接続状態
	hasCompletedInitialSync bool           // 初回同期が完了したかどうか
	cloudNoteList           *NoteList      // クラウド上のノートリスト
}
