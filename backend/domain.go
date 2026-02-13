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
	ctx              *Context         // アプリケーションのコンテキスト
	appDataDir       string           // アプリケーションデータディレクトリのパス
	notesDir         string           // ノートファイル保存ディレクトリのパス
	authService      AuthService      // Google Drive認証サービス
	noteService      *noteService     // ノート操作サービス
	driveService     DriveService     // Google Drive操作サービス (インターフェースで受けるよう変更)
	settingsService  *settingsService // 設定操作サービス
	fileService      *fileService     // ファイル操作サービス
	fileNoteService  *fileNoteService // ファイルノート操作サービス
	syncState        *SyncState       // 同期状態管理（dirtyフラグ方式）
	migrationMessage string           // マイグレーション結果メッセージ（フロントエンド準備後に通知）
	frontendReady    chan struct{}    // フロントエンドの準備完了を通知するチャネル
	logger           AppLogger        // アプリケーションのロガー
}

// アプリケーションのコンテキストを管理
type Context struct {
	ctx             context.Context
	skipBeforeClose bool // アプリケーション終了前の保存処理をスキップするかどうか
}

// トップレベルの表示順序を管理するアイテム
type TopLevelItem struct {
	Type string `json:"type"` // "note" or "folder"
	ID   string `json:"id"`
}

// フォルダの基本情報
type Folder struct {
	ID       string `json:"id"`                 // フォルダの一意識別子
	Name     string `json:"name"`               // フォルダ名
	Archived bool   `json:"archived,omitempty"` // アーカイブ状態（true=アーカイブ済み）
}

// ノートの基本情報
type Note struct {
	ID            string `json:"id"`                 // ノートの一意識別子
	Title         string `json:"title"`              // ノートのタイトル
	Content       string `json:"content"`            // ノートの本文内容
	ContentHeader string `json:"contentHeader"`      // アーカイブ時に表示される内容のプレビュー
	Language      string `json:"language"`           // ノートで使用されているプログラミング言語
	ModifiedTime  string `json:"modifiedTime"`       // 最終更新日時
	Archived      bool   `json:"archived"`           // アーカイブ状態（true=アーカイブ済み）
	FolderID      string `json:"folderId,omitempty"` // 所属フォルダID（空文字=未分類）
	Syncing       bool   `json:"syncing,omitempty"`  // 同期中フラグ（ダウンロード未完了）
}

// ノートのメタデータのみを保持
type NoteMetadata struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	ContentHeader string `json:"contentHeader"`
	Language      string `json:"language"`
	ModifiedTime  string `json:"modifiedTime"`
	Archived      bool   `json:"archived"`
	ContentHash   string `json:"contentHash"`
	FolderID      string `json:"folderId,omitempty"`
}

// ノートのリストを管理
type NoteList struct {
	Version               string         `json:"version"`
	Notes                 []NoteMetadata `json:"notes"`
	Folders               []Folder       `json:"folders,omitempty"`
	TopLevelOrder         []TopLevelItem `json:"topLevelOrder,omitempty"`
	ArchivedTopLevelOrder []TopLevelItem `json:"archivedTopLevelOrder,omitempty"`
	CollapsedFolderIDs    []string       `json:"collapsedFolderIDs,omitempty"`
}

// アプリケーションの設定を管理
type Settings struct {
	FontFamily              string  `json:"fontFamily"`
	FontSize                int     `json:"fontSize"`
	IsDarkMode              bool    `json:"isDarkMode"`
	EditorTheme             string  `json:"editorTheme"`
	WordWrap                string  `json:"wordWrap"`
	Minimap                 bool    `json:"minimap"`
	WindowWidth             int     `json:"windowWidth"`
	WindowHeight            int     `json:"windowHeight"`
	WindowX                 int     `json:"windowX"`
	WindowY                 int     `json:"windowY"`
	IsMaximized             bool    `json:"isMaximized"`
	IsDebug                 bool    `json:"isDebug"`
	EnableConflictBackup    bool    `json:"enableConflictBackup"`
	MarkdownPreviewOnLeft   bool    `json:"markdownPreviewOnLeft"`
	SidebarWidth            float64 `json:"sidebarWidth,omitempty"`            // サイドバーの幅
	SplitPaneSize           float64 `json:"splitPaneSize,omitempty"`           // スプリットモード時の左ペインの割合(0-1)
	MarkdownPreviewPaneSize float64 `json:"markdownPreviewPaneSize,omitempty"` // マークダウンプレビューのペインサイズ割合(0-1)
	MarkdownPreviewVisible  bool    `json:"markdownPreviewVisible,omitempty"`  // マークダウンプレビューが表示状態か
	IsSplit                 bool    `json:"isSplit,omitempty"`                 // スプリットモードが有効か
}

// ノートリスト整合性チェックの問題
type IntegrityIssue struct {
	ID                string               `json:"id"`
	Kind              string               `json:"kind"`
	Severity          string               `json:"severity"`
	NeedsUserDecision bool                 `json:"needsUserDecision"`
	NoteIDs           []string             `json:"noteIds,omitempty"`
	FolderIDs         []string             `json:"folderIds,omitempty"`
	Summary           string               `json:"summary"`
	AutoFix           *IntegrityFixOption  `json:"autoFix,omitempty"`
	FixOptions        []IntegrityFixOption `json:"fixOptions,omitempty"`
}

// 整合性修復の選択肢
type IntegrityFixOption struct {
	ID          string            `json:"id"`
	Label       string            `json:"label"`
	Description string            `json:"description"`
	Params      map[string]string `json:"params,omitempty"`
}

// ユーザーが選択した修復
type IntegrityFixSelection struct {
	IssueID string `json:"issueId"`
	FixID   string `json:"fixId"`
}

// 修復結果のサマリー
type IntegrityRepairSummary struct {
	Applied  int      `json:"applied"`
	Skipped  int      `json:"skipped"`
	Errors   int      `json:"errors"`
	Messages []string `json:"messages,omitempty"`
}

// Google Driveとの同期機能を管理
type DriveSync struct {
	service       *drive.Service // Google Driveサービスのインスタンス
	token         *oauth2.Token  // OAuth2認証トークン
	server        *http.Server   // 認証サーバー
	listener      net.Listener   // 認証サーバーのリスナー
	config        *oauth2.Config // OAuth2設定
	rootFolderID  string         // アプリケーションのルートフォルダID
	notesFolderID string         // ノート保存用フォルダID
	noteListID    string         // ノートリストのファイルID
	mutex         sync.RWMutex   // 同期処理用のミューテックス
	isConnected   bool           // Google Driveへの接続状態
}

func (ds *DriveSync) FolderIDs() (rootFolderID, notesFolderID string) {
	ds.mutex.RLock()
	defer ds.mutex.RUnlock()
	return ds.rootFolderID, ds.notesFolderID
}

func (ds *DriveSync) SetFolderIDs(rootFolderID, notesFolderID string) {
	ds.mutex.Lock()
	defer ds.mutex.Unlock()
	ds.rootFolderID = rootFolderID
	ds.notesFolderID = notesFolderID
}

func (ds *DriveSync) NoteListID() string {
	ds.mutex.RLock()
	defer ds.mutex.RUnlock()
	return ds.noteListID
}

func (ds *DriveSync) SetNoteListID(id string) {
	ds.mutex.Lock()
	defer ds.mutex.Unlock()
	ds.noteListID = id
}

func (ds *DriveSync) Connected() bool {
	ds.mutex.RLock()
	defer ds.mutex.RUnlock()
	return ds.isConnected
}

func (ds *DriveSync) SetConnected(connected bool) {
	ds.mutex.Lock()
	defer ds.mutex.Unlock()
	ds.isConnected = connected
}

func isModifiedTimeAfter(a, b string) bool {
	ta, errA := time.Parse(time.RFC3339, a)
	tb, errB := time.Parse(time.RFC3339, b)
	if errA != nil || errB != nil {
		return a > b
	}
	return ta.After(tb)
}

type WailsConfig struct {
	Name           string `json:"name"`
	OutputFilename string `json:"outputfilename"`
	Info           struct {
		ProductVersion string `json:"productVersion"`
	} `json:"info"`
}
