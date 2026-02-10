package backend

import (
	"context"
	"fmt"
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
	authService     AuthService      // Google Drive認証サービス
	noteService     *noteService     // ノート操作サービス
	driveService    DriveService     // Google Drive操作サービス (インターフェースで受けるよう変更)
	settingsService *settingsService // 設定操作サービス
	fileService     *fileService     // ファイル操作サービス
	fileNoteService *fileNoteService // ファイルノート操作サービス
	frontendReady   chan struct{}    // フロントエンドの準備完了を通知するチャネル
	logger          AppLogger        // アプリケーションのロガー
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
	Order         int    `json:"order"`              // ノートの表示順序
	FolderID      string `json:"folderId,omitempty"` // 所属フォルダID（空文字=未分類）
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
	Order         int    `json:"order"`
	FolderID      string `json:"folderId,omitempty"`
}

// ノートのリストを管理
type NoteList struct {
	Version               string         `json:"version"`
	Notes                 []NoteMetadata `json:"notes"`
	Folders               []Folder       `json:"folders,omitempty"`
	TopLevelOrder         []TopLevelItem `json:"topLevelOrder,omitempty"`
	ArchivedTopLevelOrder []TopLevelItem `json:"archivedTopLevelOrder,omitempty"`
	LastSync              time.Time      `json:"lastSync"`
}

// アプリケーションの設定を管理
type Settings struct {
	FontFamily            string `json:"fontFamily"`
	FontSize              int    `json:"fontSize"`
	IsDarkMode            bool   `json:"isDarkMode"`
	EditorTheme           string `json:"editorTheme"`
	WordWrap              string `json:"wordWrap"`
	Minimap               bool   `json:"minimap"`
	WindowWidth           int    `json:"windowWidth"`
	WindowHeight          int    `json:"windowHeight"`
	WindowX               int    `json:"windowX"`
	WindowY               int    `json:"windowY"`
	IsMaximized           bool   `json:"isMaximized"`
	IsDebug               bool   `json:"isDebug"`
	MarkdownPreviewOnLeft bool   `json:"markdownPreviewOnLeft"`
}

type SyncResult struct {
	Uploaded       int
	Downloaded     int
	Deleted        int
	ConflictMerges int
	Errors         int
}

func (r *SyncResult) HasChanges() bool {
	return r.Uploaded > 0 || r.Downloaded > 0 || r.Deleted > 0 || r.ConflictMerges > 0 || r.Errors > 0
}

func (r *SyncResult) Summary() string {
	if !r.HasChanges() {
		return ""
	}
	s := "Sync complete:"
	if r.Uploaded > 0 {
		s += fmt.Sprintf(" ↑%d", r.Uploaded)
	}
	if r.Downloaded > 0 {
		s += fmt.Sprintf(" ↓%d", r.Downloaded)
	}
	if r.Deleted > 0 {
		s += fmt.Sprintf(" 🗑%d", r.Deleted)
	}
	if r.ConflictMerges > 0 {
		s += fmt.Sprintf(" ⚡%d conflicts merged", r.ConflictMerges)
	}
	if r.Errors > 0 {
		s += fmt.Sprintf(" ⚠%d errors", r.Errors)
	}
	return s
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
	mutex                   sync.RWMutex   // 同期処理用のミューテックス
	isConnected             bool           // Google Driveへの接続状態
	hasCompletedInitialSync bool           // 初回同期が完了したかどうか
	cloudNoteList           *NoteList      // クラウド上のノートリスト
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

func (ds *DriveSync) UpdateCloudNoteList(lastSync time.Time, notes []NoteMetadata, folders []Folder, topLevelOrder []TopLevelItem, archivedTopLevelOrder []TopLevelItem) {
	ds.mutex.Lock()
	defer ds.mutex.Unlock()
	if ds.cloudNoteList == nil {
		return
	}
	ds.cloudNoteList.LastSync = lastSync
	notesCopy := make([]NoteMetadata, len(notes))
	copy(notesCopy, notes)
	ds.cloudNoteList.Notes = notesCopy
	if folders != nil {
		foldersCopy := make([]Folder, len(folders))
		copy(foldersCopy, folders)
		ds.cloudNoteList.Folders = foldersCopy
	}
	if topLevelOrder != nil {
		orderCopy := make([]TopLevelItem, len(topLevelOrder))
		copy(orderCopy, topLevelOrder)
		ds.cloudNoteList.TopLevelOrder = orderCopy
	}
	if archivedTopLevelOrder != nil {
		archivedCopy := make([]TopLevelItem, len(archivedTopLevelOrder))
		copy(archivedCopy, archivedTopLevelOrder)
		ds.cloudNoteList.ArchivedTopLevelOrder = archivedCopy
	}
}

func isModifiedTimeAfter(a, b string) bool {
	ta, errA := time.Parse(time.RFC3339, a)
	tb, errB := time.Parse(time.RFC3339, b)
	if errA != nil || errB != nil {
		return a > b
	}
	return ta.After(tb)
}

// SyncJournalAction は同期ジャーナル内の個別アクション
type SyncJournalAction struct {
	Type      string `json:"type"`      // "download", "upload", "delete"
	NoteID    string `json:"noteId"`    // 対象ノートID
	Completed bool   `json:"completed"` // 完了フラグ
}

// SyncJournal は同期処理の中断からの復旧に使用するジャーナル
type SyncJournal struct {
	StartedAt time.Time           `json:"startedAt"` // 同期開始時刻
	Actions   []SyncJournalAction `json:"actions"`   // アクションリスト
}

type WailsConfig struct {
	Name           string `json:"name"`
	OutputFilename string `json:"outputfilename"`
	Info           struct {
		ProductVersion string `json:"productVersion"`
	} `json:"info"`
}
