package backend

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// 旧バージョンが孤立ノートを自動で入れていたフォルダ名。v3 では作らないことを検証するのに使う
const legacyRecoveryFolderName = "不明ノート"

// ============================================================
// mobilePeer: 「プロトコル通りに正しく振る舞うモバイル版」を fakeDrive 上で模擬する。
//
//   - ファイルはモバイル (TS) と同じ形式で書く: ノート本体は folderId を含む compact JSON、
//     noteList は version "v2" / collapsedFolderIds キー / 空配列も省略しない。
//   - noteList の更新は毎回「最新をダウンロード → 自分の変更だけ適用 → アップロード」、
//     本体 → noteList の順でアップロードする理想的な書き手。
//
// デスクトップ側のバグを「相手が正しくても壊れる」形で再現するための基準実装。
// ============================================================

type peerNote struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Content      string `json:"content"`
	Language     string `json:"language"`
	Archived     bool   `json:"archived"`
	ModifiedTime string `json:"modifiedTime"`
}

type tsNoteMeta struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	ContentHeader string `json:"contentHeader"`
	Language      string `json:"language"`
	ModifiedTime  string `json:"modifiedTime"`
	Archived      bool   `json:"archived"`
	FolderID      string `json:"folderId"`
	ContentHash   string `json:"contentHash"`
}

type tsFolder struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Archived bool   `json:"archived"`
}

type tsNoteList struct {
	Version               string         `json:"version"`
	Notes                 []tsNoteMeta   `json:"notes"`
	Folders               []tsFolder     `json:"folders"`
	TopLevelOrder         []TopLevelItem `json:"topLevelOrder"`
	ArchivedTopLevelOrder []TopLevelItem `json:"archivedTopLevelOrder"`
	CollapsedFolderIds    []string       `json:"collapsedFolderIds"`
}

type mobilePeer struct {
	t  *testing.T
	fd *fakeDrive
}

func newMobilePeer(t *testing.T, fd *fakeDrive) *mobilePeer {
	return &mobilePeer{t: t, fd: fd}
}

func peerContentHash(n peerNote) string {
	h := sha256.New()
	fmt.Fprintf(h, "%s\n%s\n%s\n%s\n%v", n.ID, n.Title, n.Content, n.Language, n.Archived)
	return fmt.Sprintf("%x", h.Sum(nil))
}

func peerContentHeader(content string) string {
	var lines []string
	for _, l := range strings.Split(content, "\n") {
		if strings.TrimSpace(l) != "" {
			lines = append(lines, l)
			if len(lines) >= 3 {
				break
			}
		}
	}
	return strings.Join(lines, "\n")
}

func (p *mobilePeer) rootFolder() fakeFile {
	p.t.Helper()
	files, err := p.fd.List(fmt.Sprintf("name='monaco-notepad' and 'appDataFolder' in parents and mimeType='%s' and trashed=false", fakeFolderMime))
	require.NoError(p.t, err)
	require.NotEmpty(p.t, files, "mobilePeer: root folder not found")
	return files[0]
}

func (p *mobilePeer) notesFolder() fakeFile {
	p.t.Helper()
	root := p.rootFolder()
	files, err := p.fd.List(fmt.Sprintf("name='notes' and '%s' in parents and mimeType='%s' and trashed=false", root.ID, fakeFolderMime))
	require.NoError(p.t, err)
	require.NotEmpty(p.t, files, "mobilePeer: notes folder not found")
	return files[0]
}

// ensureLayout は Drive 上にレイアウトが無ければモバイル形式で作る。
func (p *mobilePeer) ensureLayout() {
	p.t.Helper()
	roots, _ := p.fd.List(fmt.Sprintf("name='monaco-notepad' and 'appDataFolder' in parents and mimeType='%s' and trashed=false", fakeFolderMime))
	var rootID string
	if len(roots) == 0 {
		rootID = p.fd.CreateFile("monaco-notepad", []string{"appDataFolder"}, nil, fakeFolderMime).ID
	} else {
		rootID = roots[0].ID
	}
	notes, _ := p.fd.List(fmt.Sprintf("name='notes' and '%s' in parents and trashed=false", rootID))
	if len(notes) == 0 {
		p.fd.CreateFile("notes", []string{rootID}, nil, fakeFolderMime)
	}
	if _, ok := p.noteListFile(); !ok {
		empty, _ := json.Marshal(tsNoteList{Version: "v2", Notes: []tsNoteMeta{}, Folders: []tsFolder{},
			TopLevelOrder: []TopLevelItem{}, ArchivedTopLevelOrder: []TopLevelItem{}, CollapsedFolderIds: []string{}})
		p.fd.CreateFile("noteList_v2.json", []string{rootID}, empty, "application/json")
	}
}

func (p *mobilePeer) noteListFile() (fakeFile, bool) {
	root := p.rootFolder()
	files, _ := p.fd.List(fmt.Sprintf("name='noteList_v2.json' and '%s' in parents and trashed=false", root.ID))
	if len(files) == 0 {
		return fakeFile{}, false
	}
	return files[0], true
}

// readList はクラウドの noteList を（デスクトップ形式で書かれていても）読む。
func (p *mobilePeer) readList() tsNoteList {
	p.t.Helper()
	f, ok := p.noteListFile()
	require.True(p.t, ok, "mobilePeer: noteList not found")
	var raw struct {
		Version               string         `json:"version"`
		Notes                 []tsNoteMeta   `json:"notes"`
		Folders               []tsFolder     `json:"folders"`
		TopLevelOrder         []TopLevelItem `json:"topLevelOrder"`
		ArchivedTopLevelOrder []TopLevelItem `json:"archivedTopLevelOrder"`
		CollapsedFolderIds    []string       `json:"collapsedFolderIds"`
		CollapsedFolderIDs    []string       `json:"collapsedFolderIDs"`
	}
	require.NoError(p.t, json.Unmarshal(f.Content, &raw))
	list := tsNoteList{
		Version:               raw.Version,
		Notes:                 raw.Notes,
		Folders:               raw.Folders,
		TopLevelOrder:         raw.TopLevelOrder,
		ArchivedTopLevelOrder: raw.ArchivedTopLevelOrder,
		CollapsedFolderIds:    raw.CollapsedFolderIds,
	}
	if len(list.CollapsedFolderIds) == 0 {
		list.CollapsedFolderIds = raw.CollapsedFolderIDs
	}
	return list
}

func (p *mobilePeer) updateList(mutate func(*tsNoteList)) {
	p.t.Helper()
	list := p.readList()
	mutate(&list)
	for _, s := range []*[]TopLevelItem{&list.TopLevelOrder, &list.ArchivedTopLevelOrder} {
		if *s == nil {
			*s = []TopLevelItem{}
		}
	}
	if list.Folders == nil {
		list.Folders = []tsFolder{}
	}
	if list.CollapsedFolderIds == nil {
		list.CollapsedFolderIds = []string{}
	}
	list.Version = "v2"
	data, err := json.Marshal(list)
	require.NoError(p.t, err)
	f, _ := p.noteListFile()
	_, err = p.fd.UpdateFile(f.ID, data)
	require.NoError(p.t, err)
}

func (p *mobilePeer) noteFile(noteID string) (fakeFile, bool) {
	files, _ := p.fd.List(fmt.Sprintf("name='%s.json' and '%s' in parents and trashed=false", noteID, p.notesFolder().ID))
	if len(files) == 0 {
		return fakeFile{}, false
	}
	return files[0], true
}

func (p *mobilePeer) readCloudNote(noteID string) (peerNote, bool) {
	f, ok := p.noteFile(noteID)
	if !ok {
		return peerNote{}, false
	}
	var n peerNote
	require.NoError(p.t, json.Unmarshal(f.Content, &n))
	return n, true
}

// uploadNoteFile は本体ファイルだけを書く（noteList はまだ = アップロード途中）。
func (p *mobilePeer) uploadNoteFile(n peerNote, folderID string) {
	p.t.Helper()
	body, err := json.Marshal(map[string]any{
		"id":            n.ID,
		"title":         n.Title,
		"content":       n.Content,
		"contentHeader": peerContentHeader(n.Content),
		"language":      n.Language,
		"modifiedTime":  n.ModifiedTime,
		"archived":      n.Archived,
		"folderId":      folderID,
	})
	require.NoError(p.t, err)
	if f, ok := p.noteFile(n.ID); ok {
		_, err := p.fd.UpdateFile(f.ID, body)
		require.NoError(p.t, err)
		return
	}
	p.fd.CreateFile(n.ID+".json", []string{p.notesFolder().ID}, body, "application/json")
}

// publishNoteMeta は noteList にメタを反映する。新規なら先頭に置く（モバイルの新規作成と同じ）。
func (p *mobilePeer) publishNoteMeta(n peerNote, folderID string) {
	p.updateList(func(list *tsNoteList) {
		meta := tsNoteMeta{
			ID:            n.ID,
			Title:         n.Title,
			ContentHeader: peerContentHeader(n.Content),
			Language:      n.Language,
			ModifiedTime:  n.ModifiedTime,
			Archived:      n.Archived,
			FolderID:      folderID,
			ContentHash:   peerContentHash(n),
		}
		for i, existing := range list.Notes {
			if existing.ID == n.ID {
				meta.FolderID = existing.FolderID
				list.Notes[i] = meta
				return
			}
		}
		list.Notes = append([]tsNoteMeta{meta}, list.Notes...)
		if folderID == "" && !n.Archived {
			list.TopLevelOrder = append([]TopLevelItem{{Type: "note", ID: n.ID}}, list.TopLevelOrder...)
		}
	})
}

func (p *mobilePeer) saveNote(n peerNote, folderID string) {
	p.uploadNoteFile(n, folderID)
	p.publishNoteMeta(n, folderID)
}

func (p *mobilePeer) deleteNote(noteID string) {
	if f, ok := p.noteFile(noteID); ok {
		require.NoError(p.t, p.fd.DeleteFile(f.ID))
	}
	p.updateList(func(list *tsNoteList) {
		var notes []tsNoteMeta
		for _, n := range list.Notes {
			if n.ID != noteID {
				notes = append(notes, n)
			}
		}
		list.Notes = notes
		list.TopLevelOrder = removeTopLevelNote(list.TopLevelOrder, noteID)
		list.ArchivedTopLevelOrder = removeTopLevelNote(list.ArchivedTopLevelOrder, noteID)
	})
}

func (p *mobilePeer) createFolder(id, name string) {
	p.updateList(func(list *tsNoteList) {
		list.Folders = append(list.Folders, tsFolder{ID: id, Name: name})
		list.TopLevelOrder = append([]TopLevelItem{{Type: "folder", ID: id}}, list.TopLevelOrder...)
	})
}

func removeTopLevelNote(order []TopLevelItem, noteID string) []TopLevelItem {
	out := []TopLevelItem{}
	for _, item := range order {
		if !(item.Type == "note" && item.ID == noteID) {
			out = append(out, item)
		}
	}
	return out
}

func (p *mobilePeer) cloudNoteIDs() []string {
	var ids []string
	for _, n := range p.readList().Notes {
		ids = append(ids, n.ID)
	}
	return ids
}

func (p *mobilePeer) cloudTopLevelNoteIDs() []string {
	var ids []string
	for _, item := range p.readList().TopLevelOrder {
		if item.Type == "note" {
			ids = append(ids, item.ID)
		}
	}
	return ids
}

func (p *mobilePeer) cloudMeta(noteID string) (tsNoteMeta, bool) {
	for _, n := range p.readList().Notes {
		if n.ID == noteID {
			return n, true
		}
	}
	return tsNoteMeta{}, false
}

// ============================================================
// desktopDevice: シナリオテスト用のデスクトップ端末ファサード。
//
// App.SaveNote / App.DeleteNote と同じ手順（noteService への保存 → SyncState の dirty）で
// 操作し、同期は明示的に呼ぶ（本番の triggerSyncIfConnected は非同期で非決定的なため）。
// シナリオテストはこのファサードだけを使い、同期エンジンの内部 API に依存しない。
// ============================================================

type desktopDevice struct {
	t        *testing.T
	fd       *fakeDrive
	name     string
	dir      string
	notesDir string
	logger   AppLogger
	ns       *noteService
	state    *SyncState
	ds       *driveService
}

func newDesktopDevice(t *testing.T, fd *fakeDrive, name string) *desktopDevice {
	t.Helper()
	dir := t.TempDir()
	notesDir := filepath.Join(dir, "notes")
	require.NoError(t, os.MkdirAll(notesDir, 0755))
	d := &desktopDevice{t: t, fd: fd, name: name, dir: dir, notesDir: notesDir}
	d.logger = NewAppLogger(context.Background(), true, dir)
	d.boot()
	return d
}

// boot はディスク上の状態からサービス群を組み立てる（起動 / 再起動）。
func (d *desktopDevice) boot() {
	d.t.Helper()
	ctx := context.Background()
	ns, err := NewNoteService(d.notesDir, d.logger)
	require.NoError(d.t, err)
	d.ns = ns
	d.state = NewSyncState(d.dir)
	require.NoError(d.t, d.state.Load())

	auth := NewAuthService(ctx, d.dir, d.notesDir, ns, nil, d.logger, true)
	driveSync := &DriveSync{}
	driveSync.service = d.fd.service(d.t, d.name)
	driveSync.SetConnected(true)
	auth.driveSync = driveSync

	ds := NewDriveService(ctx, d.dir, d.notesDir, ns, nil, d.logger, auth, d.state)
	// 接続中の Drive サービスをその都度使う（ログインし直すと別アカウントの Drive になりうる）
	ds.driveOpsFactory = func(useAppDataFolder bool) DriveOperations {
		return NewDriveOperations(auth.GetDriveSync().service, d.logger, true)
	}
	require.NoError(d.t, ds.saveMigrationState(&driveStorageMigration{Migrated: true, MigratedAt: time.Now().UTC().Format(time.RFC3339)}))
	d.ds = ds
}

// restart はアプリ再起動（メモリ上のキャッシュ等を捨ててディスクから読み直す）。
func (d *desktopDevice) restart() {
	d.boot()
}

// connect は onConnected 相当（移行判定は済んでいる前提。ポーリング goroutine は起動しない）。
// テストでは Drive 呼び出しを待たずに失敗させ、エンジン側の「次サイクルで再試行」を検証する。
func (d *desktopDevice) connect() {
	d.t.Helper()
	ds := d.ds
	ds.gatewayRetry = gatewayRetry{attempts: 1}
	ds.driveOps = ds.newDriveOperations(true)
	require.NoError(d.t, ds.buildEngine(true))
	_, err := ds.engine.gateway.ResolveLayout()
	require.NoError(d.t, err)
}

// connectLazy はフォルダ構成の解決を最初の同期まで遅らせる接続（複数端末の同時初回接続を再現する）。
func (d *desktopDevice) connectLazy() {
	d.t.Helper()
	ds := d.ds
	ds.gatewayRetry = gatewayRetry{attempts: 1}
	ds.driveOps = ds.newDriveOperations(true)
	require.NoError(d.t, ds.buildEngine(true))
}

// startup は WaitForFrontendAndStartSync 相当（変更検知の基準点を取ってから初回同期）。
func (d *desktopDevice) startup() {
	d.t.Helper()
	d.connect()
	d.ds.pollingService.initChangeToken()
	d.sync()
}

// sync は「今すぐ同期」。失敗したらテストを止める。
func (d *desktopDevice) sync() {
	d.t.Helper()
	require.NoError(d.t, d.trySync())
}

// trySync は同期を実行してエラーを返す。失敗で一時オフラインになった場合は
// ポーリングの再接続成功を模擬して接続状態に戻す。
func (d *desktopDevice) trySync() error {
	d.ds.pollingService.markSynced()
	err := d.ds.SyncNotes()
	if err != nil {
		d.ds.auth.GetDriveSync().SetConnected(true)
	}
	return err
}

// pollOnce はポーリング 1 サイクル（変化の検知 / 未送信の変更 / 定期チェックで同期）。
func (d *desktopDevice) pollOnce() {
	d.t.Helper()
	d.ds.pollingService.pollOnce()
	d.ds.auth.GetDriveSync().SetConnected(true)
}

// goOffline / goOnline は通信を切る / 戻す（アプリは動き続け、ローカル操作はできる）。
func (d *desktopDevice) goOffline() { d.fd.SetOffline(d.name, true) }
func (d *desktopDevice) goOnline()  { d.fd.SetOffline(d.name, false) }

// logout は「Google Drive との接続を解除」（本番の LogoutDrive をそのまま呼ぶ）。
func (d *desktopDevice) logout() {
	d.t.Helper()
	require.NoError(d.t, d.ds.LogoutDrive())
}

// login はログインし直す（AuthorizeDrive → onConnected 相当）。fd を変えると別アカウントの Drive に接続する。
func (d *desktopDevice) login(fd *fakeDrive) {
	d.t.Helper()
	d.fd = fd
	driveSync := d.ds.auth.GetDriveSync()
	driveSync.service = fd.service(d.t, d.name)
	driveSync.SetConnected(true)
	d.connect()
}

// backups は競合バックアップ（kind, noteId, content）を古い順に返す。
func (d *desktopDevice) backups() [][3]string {
	d.t.Helper()
	entries, err := listCloudConflictBackups(filepath.Join(d.dir, cloudWinBackupDirName))
	require.NoError(d.t, err)
	out := [][3]string{}
	for i := len(entries) - 1; i >= 0; i-- {
		e := entries[i]
		out = append(out, [3]string{e.Kind, e.Note.ID, e.Note.Content})
	}
	return out
}

// deletedNoteIDs は未処理の削除の意図。
func (d *desktopDevice) deletedNoteIDs() []string {
	_, deleted, _, _, _ := d.state.GetDirtySnapshotWithRevision()
	ids := []string{}
	for id := range deleted {
		ids = append(ids, id)
	}
	return ids
}

// createFolder は App.CreateFolder 相当。
func (d *desktopDevice) createFolder(name string) string {
	d.t.Helper()
	f, err := d.ns.CreateFolder(name)
	require.NoError(d.t, err)
	d.state.MarkDirty()
	return f.ID
}

// moveNoteToFolder は App.MoveNoteToFolder 相当。
func (d *desktopDevice) moveNoteToFolder(noteID, folderID string) {
	d.t.Helper()
	require.NoError(d.t, d.ns.MoveNoteToFolder(noteID, folderID))
	d.state.MarkDirty()
	d.state.MarkNoteDirty(noteID)
}

// updateTopLevelOrder は App.UpdateTopLevelOrder 相当（ドラッグでの並び替え）。
func (d *desktopDevice) updateTopLevelOrder(order []TopLevelItem) {
	d.t.Helper()
	require.NoError(d.t, d.ns.UpdateTopLevelOrder(order))
	d.state.MarkDirty()
}

// archiveFolder は App.ArchiveFolder 相当。本番は端末の時計で ModifiedTime を入れるが、
// テストでは「新しい編集が勝つ」を検証できるよう論理時計で打ち直す。
func (d *desktopDevice) archiveFolder(folderID string) {
	d.t.Helper()
	require.NoError(d.t, d.ns.ArchiveFolder(folderID))
	d.state.MarkDirty()
	for _, m := range d.ns.SnapshotNoteList().Notes {
		if m.FolderID == folderID {
			d.stampNote(m.ID, d.fd.Now())
		}
	}
}

// deleteArchivedFolder は App.DeleteArchivedFolder 相当。
func (d *desktopDevice) deleteArchivedFolder(folderID string) {
	d.t.Helper()
	var noteIDs []string
	for _, n := range d.ns.SnapshotNoteList().Notes {
		if n.FolderID == folderID {
			noteIDs = append(noteIDs, n.ID)
		}
	}
	require.NoError(d.t, d.ns.DeleteArchivedFolder(folderID))
	for _, id := range noteIDs {
		d.state.MarkNoteDeleted(id)
	}
	d.state.MarkFolderDeleted(folderID)
}

// hasPendingWork はポーリングのゲート（同期が必要な状態か）。
func (d *desktopDevice) hasPendingWork() bool {
	return d.ds.hasPendingSyncWork()
}

// deleteNote は App.DeleteNote 相当。
func (d *desktopDevice) deleteNote(id string) {
	d.t.Helper()
	require.NoError(d.t, d.ns.DeleteNote(id))
	d.state.MarkNoteDeleted(id)
}

// editNoteAt は編集時刻を指定して保存する（LWW の勝敗を決めるテスト用。SaveNote は現在時刻を入れるので書き換える）。
func (d *desktopDevice) editNoteAt(id, content, modifiedTime string) {
	d.t.Helper()
	d.editNote(id, content)
	d.stampNote(id, modifiedTime)
}

// createNote は App.SaveNote(note, "create") 相当。
func (d *desktopDevice) createNote(id, title, content string) {
	d.t.Helper()
	note := &Note{ID: id, Title: title, Content: content, Language: "markdown"}
	require.NoError(d.t, d.ns.SaveNote(note))
	d.state.MarkNoteDirty(id)
}

// editNote は App.SaveNote(note, "update") 相当（フロントは ListNotes 由来の folderId を持って保存する）。
func (d *desktopDevice) editNote(id, content string) {
	d.t.Helper()
	note, err := d.ns.LoadNote(id)
	require.NoError(d.t, err)
	updated := *note
	updated.Content = content
	updated.FolderID = d.folderOf(id)
	require.NoError(d.t, d.ns.SaveNote(&updated))
	d.state.MarkNoteDirty(id)
}

func (d *desktopDevice) readNote(id string) (*Note, error) {
	return d.ns.LoadNote(id)
}

func (d *desktopDevice) noteIDs() []string {
	snap := d.ns.SnapshotNoteList()
	var ids []string
	for _, n := range snap.Notes {
		ids = append(ids, n.ID)
	}
	return ids
}

func (d *desktopDevice) topLevelNoteIDs() []string {
	var ids []string
	for _, item := range d.ns.SnapshotNoteList().TopLevelOrder {
		if item.Type == "note" {
			ids = append(ids, item.ID)
		}
	}
	return ids
}

func (d *desktopDevice) folderOf(noteID string) string {
	for _, n := range d.ns.SnapshotNoteList().Notes {
		if n.ID == noteID {
			return n.FolderID
		}
	}
	return ""
}

func (d *desktopDevice) folderNamed(name string) (string, bool) {
	for _, f := range d.ns.SnapshotNoteList().Folders {
		if f.Name == name {
			return f.ID, true
		}
	}
	return "", false
}
