package backend

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"google.golang.org/api/drive/v3"
	"google.golang.org/api/googleapi"
)

// 同期エンジン v3 が使う Drive 操作（docs/sync-engine-v3.md §3, §5）。
// 状態を持たない薄い層で、fileId もキャッシュしない（毎サイクルの一覧が正）。
//
//	appDataFolder/monaco-notepad/{noteList_v2.json, notes/<id>.json}
//	同名のフォルダ・ファイルが複数ある場合は createdTime 最古（同値は id 昇順）を使う。
//
// モバイル版 mobile/src/services/sync/driveGateway.ts に対応する。

// driveFileAPI は gateway が必要とする低レベル操作（driveOperationsImpl が実装する）。
type driveFileAPI interface {
	ListFiles(query string) ([]*drive.File, error)
	DownloadFile(fileID string) ([]byte, error)
	CreateFileMeta(name string, parentID string, content []byte, mimeType string) (*drive.File, error)
	UpdateFileMeta(fileID string, content []byte) (*drive.File, error)
	CreateFolderMeta(name string, parentID string) (*drive.File, error)
	DeleteFile(fileID string) error
}

type driveLayoutIDs struct {
	RootFolderID  string
	NotesFolderID string
}

type remoteFileRef struct {
	FileID       string
	Md5          string
	ModifiedTime string
	// Version は Drive が更新ごとに進める版番号。noteList の書き込みが他端末と
	// 入れ違ったか（確認時 +1 になっていないか）の検知に使う。
	Version int64
}

type remoteNoteFiles struct {
	ByNoteID map[string]remoteFileRef
	// 同じノートの重複ファイル（最新以外）。後片付けで削除する。
	DuplicateFileIDs []string
}

// gatewayRetry は一時的な失敗（5xx / 429 / 通信断）の再試行設定。
type gatewayRetry struct {
	attempts  int
	baseDelay time.Duration
}

var defaultGatewayRetry = gatewayRetry{attempts: 3, baseDelay: 2 * time.Second}

type driveGateway struct {
	api   driveFileAPI
	retry gatewayRetry
	// rootParent は root フォルダの親。appDataFolder 版は "appDataFolder"、
	// 旧形式（マイドライブ直下、移行を見送ったユーザー）は ""。
	rootParent string

	mu     sync.Mutex
	layout *driveLayoutIDs
}

func newDriveGateway(api driveFileAPI, retry gatewayRetry, useAppDataFolder bool) *driveGateway {
	if retry.attempts < 1 {
		retry.attempts = 1
	}
	g := &driveGateway{api: api, retry: retry}
	if useAppDataFolder {
		g.rootParent = "appDataFolder"
	}
	return g
}

const driveFolderMime = "application/vnd.google-apps.folder"

// ResolveLayout は root / notes フォルダを解決する（無ければ作る）。noteList は作らない（最初の同期で作る）。
func (g *driveGateway) ResolveLayout() (driveLayoutIDs, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.layout != nil {
		return *g.layout, nil
	}
	// root は（従来のデスクトップ版と同じく）名前で探す。検索対象の空間は driveOperations 側で
	// appDataFolder / マイドライブに限定されている。作るときだけ親を指定する。
	rootID, err := g.findOrCreateFolder("monaco-notepad", "", g.rootParent)
	if err != nil {
		return driveLayoutIDs{}, err
	}
	notesID, err := g.findOrCreateFolder("notes", rootID, rootID)
	if err != nil {
		return driveLayoutIDs{}, err
	}
	g.layout = &driveLayoutIDs{RootFolderID: rootID, NotesFolderID: notesID}
	return *g.layout, nil
}

// InvalidateLayout は Drive 側のフォルダ構成が変わった可能性があるとき（全削除後など）に呼ぶ。
func (g *driveGateway) InvalidateLayout() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.layout = nil
}

// findOrCreateFolder は searchParent 配下（"" なら空間全体）から最古の同名フォルダを探し、
// 無ければ createParent 配下に作る。
func (g *driveGateway) findOrCreateFolder(name, searchParent, createParent string) (string, error) {
	query := fmt.Sprintf("name='%s' and mimeType='%s' and trashed=false", escapeDriveQueryValue(name), driveFolderMime)
	if searchParent != "" {
		query = fmt.Sprintf("name='%s' and '%s' in parents and mimeType='%s' and trashed=false",
			escapeDriveQueryValue(name), escapeDriveQueryValue(searchParent), driveFolderMime)
	}
	files, err := g.list(query)
	if err != nil {
		return "", err
	}
	if oldest := oldestFile(files); oldest != nil {
		return oldest.Id, nil
	}
	var created *drive.File
	err = g.withRetry(func() error {
		var e error
		created, e = g.api.CreateFolderMeta(name, createParent)
		return e
	})
	if err != nil {
		return "", err
	}
	return created.Id, nil
}

func (g *driveGateway) FindNoteList(layout driveLayoutIDs) (*remoteFileRef, error) {
	files, err := g.list(fmt.Sprintf("name='noteList_v2.json' and '%s' in parents and trashed=false",
		escapeDriveQueryValue(layout.RootFolderID)))
	if err != nil {
		return nil, err
	}
	oldest := oldestFile(files)
	if oldest == nil {
		return nil, nil
	}
	ref := toRemoteRef(oldest)
	return &ref, nil
}

func (g *driveGateway) DownloadNoteList(fileID string) (*NoteList, error) {
	var data []byte
	err := g.withRetry(func() error {
		var e error
		data, e = g.api.DownloadFile(fileID)
		return e
	})
	if err != nil {
		return nil, err
	}
	return decodeNoteList(data)
}

func (g *driveGateway) UploadNoteList(layout driveLayoutIDs, fileID string, list *NoteList) (remoteFileRef, error) {
	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return remoteFileRef{}, err
	}
	var file *drive.File
	err = g.withRetry(func() error {
		var e error
		if fileID != "" {
			file, e = g.api.UpdateFileMeta(fileID, data)
		} else {
			file, e = g.api.CreateFileMeta("noteList_v2.json", layout.RootFolderID, data, "application/json")
		}
		return e
	})
	if err != nil {
		return remoteFileRef{}, err
	}
	return toRemoteRef(file), nil
}

// ListNoteFiles は notes フォルダの本体ファイルを全件列挙する（全ページ）。
func (g *driveGateway) ListNoteFiles(layout driveLayoutIDs) (remoteNoteFiles, error) {
	files, err := g.list(fmt.Sprintf("'%s' in parents and trashed=false", escapeDriveQueryValue(layout.NotesFolderID)))
	if err != nil {
		return remoteNoteFiles{}, err
	}
	groups := map[string][]*drive.File{}
	for _, f := range files {
		if !strings.HasSuffix(f.Name, ".json") {
			continue
		}
		id := strings.TrimSuffix(f.Name, ".json")
		groups[id] = append(groups[id], f)
	}
	result := remoteNoteFiles{ByNoteID: make(map[string]remoteFileRef, len(groups))}
	for id, group := range groups {
		// 最新（modifiedTime 降順、同値は id 降順）を採用
		sort.SliceStable(group, func(i, j int) bool {
			if group[i].ModifiedTime != group[j].ModifiedTime {
				return group[i].ModifiedTime > group[j].ModifiedTime
			}
			return group[i].Id > group[j].Id
		})
		result.ByNoteID[id] = toRemoteRef(group[0])
		for _, dup := range group[1:] {
			result.DuplicateFileIDs = append(result.DuplicateFileIDs, dup.Id)
		}
	}
	sort.Strings(result.DuplicateFileIDs)
	return result, nil
}

// DownloadNote は本体をダウンロードする。壊れている / ID が要求と違う場合は (nil, nil)。
func (g *driveGateway) DownloadNote(fileID, expectedNoteID string) (*Note, error) {
	var data []byte
	err := g.withRetry(func() error {
		var e error
		data, e = g.api.DownloadFile(fileID)
		return e
	})
	if err != nil {
		return nil, err
	}
	var note Note
	if err := json.Unmarshal(data, &note); err != nil {
		return nil, nil
	}
	// 同期データ由来の ID はパストラバーサルに悪用されうるため取り込み境界で検証する
	if !isSafeNoteID(note.ID) || note.ID != expectedNoteID {
		return nil, nil
	}
	note.FolderID = "" // 所属は noteList が正（P7）
	note.Syncing = false
	return &note, nil
}

// UploadNote は本体を作成 / 更新する。
func (g *driveGateway) UploadNote(layout driveLayoutIDs, note *Note, fileID string) (remoteFileRef, error) {
	data, err := json.MarshalIndent(note, "", "  ")
	if err != nil {
		return remoteFileRef{}, err
	}
	var file *drive.File
	err = g.withRetry(func() error {
		var e error
		if fileID != "" {
			file, e = g.api.UpdateFileMeta(fileID, data)
		} else {
			file, e = g.api.CreateFileMeta(note.ID+".json", layout.NotesFolderID, data, "application/json")
		}
		return e
	})
	if err != nil {
		return remoteFileRef{}, err
	}
	return toRemoteRef(file), nil
}

// DeleteFile はファイルを削除する。既に無ければ成功扱い。
func (g *driveGateway) DeleteFile(fileID string) error {
	err := g.withRetry(func() error { return g.api.DeleteFile(fileID) })
	if err != nil && isGoogleAPIStatus(err, http.StatusNotFound) {
		return nil
	}
	return err
}

func (g *driveGateway) list(query string) ([]*drive.File, error) {
	var files []*drive.File
	err := g.withRetry(func() error {
		var e error
		files, e = g.api.ListFiles(query)
		return e
	})
	return files, err
}

func (g *driveGateway) withRetry(op func() error) error {
	delay := g.retry.baseDelay
	var err error
	for attempt := 1; attempt <= g.retry.attempts; attempt++ {
		err = op()
		if err == nil || !isTransientDriveError(err) || attempt == g.retry.attempts {
			return err
		}
		time.Sleep(delay)
		delay *= 2
	}
	return err
}

// isTransientDriveError は再試行する価値のある失敗か（5xx / 429 / 通信断）。
func isTransientDriveError(err error) bool {
	var apiErr *googleapi.Error
	if errors.As(err, &apiErr) {
		return apiErr.Code == http.StatusTooManyRequests || apiErr.Code >= 500
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "connection") || strings.Contains(msg, "timeout") ||
		strings.Contains(msg, "deadline exceeded") || strings.Contains(msg, "eof")
}

func isGoogleAPIStatus(err error, code int) bool {
	var apiErr *googleapi.Error
	return errors.As(err, &apiErr) && apiErr.Code == code
}

// isAuthDriveError は認証の問題（再ログインが必要な可能性）か。
func isAuthDriveError(err error) bool {
	return isGoogleAPIStatus(err, http.StatusUnauthorized) || isGoogleAPIStatus(err, http.StatusForbidden)
}

func oldestFile(files []*drive.File) *drive.File {
	var oldest *drive.File
	for _, f := range files {
		if oldest == nil || f.CreatedTime < oldest.CreatedTime ||
			(f.CreatedTime == oldest.CreatedTime && f.Id < oldest.Id) {
			oldest = f
		}
	}
	return oldest
}

func toRemoteRef(f *drive.File) remoteFileRef {
	return remoteFileRef{FileID: f.Id, Md5: f.Md5Checksum, ModifiedTime: f.ModifiedTime, Version: f.Version}
}

// decodeNoteList は Drive 上の noteList を読み込み、正規化する。
// モバイル版が書いた形式（collapsedFolderIds / version "v2"）も読める
// （encoding/json はフィールド名を大文字小文字を区別せずに対応付ける）。
func decodeNoteList(data []byte) (*NoteList, error) {
	var list NoteList
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, fmt.Errorf("failed to decode note list: %w", err)
	}
	notes := make([]NoteMetadata, 0, len(list.Notes))
	seen := map[string]bool{}
	for _, n := range list.Notes {
		// 改竄された noteList の不正な ID（パストラバーサル）は取り込み時に除外する
		if !isSafeNoteID(n.ID) || seen[n.ID] {
			continue
		}
		seen[n.ID] = true
		notes = append(notes, n)
	}
	list.Notes = notes
	validItems := func(items []TopLevelItem) []TopLevelItem {
		out := []TopLevelItem{}
		for _, item := range items {
			if (item.Type == "note" || item.Type == "folder") && item.ID != "" {
				out = append(out, item)
			}
		}
		return out
	}
	list.TopLevelOrder = validItems(list.TopLevelOrder)
	list.ArchivedTopLevelOrder = validItems(list.ArchivedTopLevelOrder)
	if list.Folders == nil {
		list.Folders = []Folder{}
	}
	if list.CollapsedFolderIDs == nil {
		list.CollapsedFolderIDs = []string{}
	}
	return &list, nil
}

// sameNoteList は noteList の内容比較（version は無視）。
func sameNoteList(a, b *NoteList) bool {
	if a == nil || b == nil {
		return a == b
	}
	norm := func(l *NoteList) string {
		cp := *l
		cp.Version = ""
		if cp.Notes == nil {
			cp.Notes = []NoteMetadata{}
		}
		if cp.Folders == nil {
			cp.Folders = []Folder{}
		}
		if cp.TopLevelOrder == nil {
			cp.TopLevelOrder = []TopLevelItem{}
		}
		if cp.ArchivedTopLevelOrder == nil {
			cp.ArchivedTopLevelOrder = []TopLevelItem{}
		}
		if cp.CollapsedFolderIDs == nil {
			cp.CollapsedFolderIDs = []string{}
		}
		data, _ := json.Marshal(cp)
		return string(data)
	}
	return norm(a) == norm(b)
}
