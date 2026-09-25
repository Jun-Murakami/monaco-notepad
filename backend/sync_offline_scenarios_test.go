package backend

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// オフライン / 接続解除中のノート操作と、復帰時の競合解決（デスクトップ 2 台の端末間シナリオ）。
// mobile/src/services/sync/__tests__/offlineSignOut.scenarios.test.ts と同じシナリオ。
//
// desk が通信できない・接続を解除している間も、other は操作と同期を続ける。復帰後の同期で次を検証する:
//   - 離れていた間の操作（作成・編集・削除・移動・並び替え）が失われずに相手へ届く
//   - 相手の操作も取り込まれる（削除されたノートが復活しない）
//   - 同じノートの衝突は docs/sync-engine-v3.md §6 どおり（新しい編集が勝つ / 編集は削除に勝つ）で
//     解決され、負けた版は競合バックアップに残る。衝突していないのにバックアップを作らない

type offlinePair struct {
	t     *testing.T
	fd    *fakeDrive
	desk  *desktopDevice // オフライン / 接続解除する端末
	other *desktopDevice // その間も操作・同期を続ける端末
}

// newOfflinePair は other が A, B を作り（表示順 [B, A]）、desk も同期済みの状態を作る。
// ModifiedTime はすべて論理時計で打つ（SaveNote の現在時刻だと、どちらが新しいかが実時間に依存する）。
func newOfflinePair(t *testing.T) *offlinePair {
	t.Helper()
	fd := newFakeDrive(t)
	p := &offlinePair{t: t, fd: fd, other: newDesktopDevice(t, fd, "other"), desk: newDesktopDevice(t, fd, "desktop")}
	p.other.startup()
	p.create(p.other, "A", "a1")
	p.create(p.other, "B", "b1")
	p.other.sync()
	p.desk.startup()
	require.Equal(t, []string{"B", "A"}, p.desk.topLevelNoteIDs())
	return p
}

func (p *offlinePair) create(d *desktopDevice, id, content string) {
	p.t.Helper()
	d.createNote(id, id, content)
	d.stampNote(id, p.fd.Now())
}

func (p *offlinePair) edit(d *desktopDevice, id, content string) {
	p.t.Helper()
	d.editNoteAt(id, content, p.fd.Now())
}

func (p *offlinePair) content(d *desktopDevice, id string) string {
	p.t.Helper()
	n, err := d.readNote(id)
	if err != nil || n == nil {
		return ""
	}
	return n.Content
}

func (p *offlinePair) hasNote(d *desktopDevice, id string) bool {
	return containsString(d.noteIDs(), id)
}

func (p *offlinePair) cloudContent(id string) (string, bool) {
	files, err := p.fd.List("name='" + id + ".json'")
	require.NoError(p.t, err)
	if len(files) == 0 {
		return "", false
	}
	var n Note
	require.NoError(p.t, json.Unmarshal(files[0].Content, &n))
	return n.Content, true
}

func (p *offlinePair) noteFileCount(id string) int {
	files, err := p.fd.List("name='" + id + ".json'")
	require.NoError(p.t, err)
	return len(files)
}

// syncBoth は両端末を同期し、同じ一覧に収束して未送信の変更が残っていないことを確かめる。
func (p *offlinePair) syncBoth() {
	p.t.Helper()
	p.desk.sync()
	p.other.sync()
	p.desk.sync()
	require.Equal(p.t, canonicalNoteList(p.desk.ns.SnapshotNoteList()), canonicalNoteList(p.other.ns.SnapshotNoteList()))
	assert.False(p.t, p.desk.hasPendingWork(), "desk に未送信の変更が残っている")
	assert.False(p.t, p.other.hasPendingWork(), "other に未送信の変更が残っている")
}

func noBackups() [][3]string { return [][3]string{} }

// ---- オフライン中の操作と復帰 ----

func TestOffline_LocalChangesSurviveAndReachPeerAfterReconnect(t *testing.T) {
	p := newOfflinePair(t)
	p.desk.goOffline()
	p.create(p.desk, "C", "c1")
	p.create(p.desk, "D", "d1")
	p.edit(p.desk, "A", "a2 offline")
	p.desk.deleteNote("B")
	historyBefore := len(p.fd.NoteHistory())

	require.Error(t, p.desk.trySync())
	assert.True(t, p.desk.hasPendingWork())
	assert.Equal(t, historyBefore, len(p.fd.NoteHistory()), "オフライン中に Drive へ書き込んだ")
	assert.Equal(t, []string{"D", "C", "A"}, p.desk.topLevelNoteIDs())

	p.desk.goOnline()
	p.syncBoth()
	assert.Equal(t, []string{"D", "C", "A"}, p.other.topLevelNoteIDs())
	assert.Equal(t, "a2 offline", p.content(p.other, "A"))
	assert.False(t, p.hasNote(p.other, "B"))
	assert.Equal(t, 0, p.noteFileCount("B"))
	assert.Equal(t, noBackups(), p.desk.backups())
	// 相手の削除でローカルのノートを消すときは必ず残す（cloud_delete）
	assert.Equal(t, [][3]string{{"cloud_delete", "B", "b1"}}, p.other.backups())
}

func TestOffline_BothEditedPeerLater_PeerWinsAndLocalVersionIsBackedUp(t *testing.T) {
	p := newOfflinePair(t)
	p.desk.goOffline()
	p.edit(p.desk, "A", "desk edit")
	p.edit(p.other, "A", "other edit (later)")
	p.other.sync()

	p.desk.goOnline()
	p.syncBoth()
	assert.Equal(t, "other edit (later)", p.content(p.desk, "A"))
	assert.Equal(t, "other edit (later)", p.content(p.other, "A"))
	assert.Equal(t, [][3]string{{"cloud_wins", "A", "desk edit"}}, p.desk.backups())
	assert.Equal(t, noBackups(), p.other.backups())
}

func TestOffline_BothEditedLocalLater_LocalWinsAndPeerVersionIsBackedUp(t *testing.T) {
	p := newOfflinePair(t)
	p.desk.goOffline()
	p.edit(p.other, "A", "other edit")
	p.other.sync()
	p.edit(p.desk, "A", "desk edit (later)")

	p.desk.goOnline()
	p.syncBoth()
	assert.Equal(t, "desk edit (later)", p.content(p.desk, "A"))
	assert.Equal(t, "desk edit (later)", p.content(p.other, "A"))
	assert.Equal(t, [][3]string{{"local_wins", "A", "other edit"}}, p.desk.backups())
	assert.Equal(t, noBackups(), p.other.backups())
}

func TestOffline_EditBeatsPeerDelete(t *testing.T) {
	p := newOfflinePair(t)
	p.desk.goOffline()
	p.edit(p.desk, "A", "kept by edit")
	p.other.deleteNote("A")
	p.other.sync()
	assert.Equal(t, 0, p.noteFileCount("A"))

	p.desk.goOnline()
	p.syncBoth()
	assert.Equal(t, "kept by edit", p.content(p.desk, "A"))
	assert.Equal(t, "kept by edit", p.content(p.other, "A"))
	assert.Contains(t, p.other.topLevelNoteIDs(), "A")
	assert.Equal(t, noBackups(), p.desk.backups())
}

func TestOffline_PeerEditBeatsLocalDelete(t *testing.T) {
	p := newOfflinePair(t)
	p.desk.goOffline()
	p.desk.deleteNote("A")
	p.edit(p.other, "A", "edited elsewhere")
	p.other.sync()

	p.desk.goOnline()
	p.syncBoth()
	assert.Equal(t, "edited elsewhere", p.content(p.desk, "A"))
	assert.Contains(t, p.desk.topLevelNoteIDs(), "A")
	got, _ := p.cloudContent("A")
	assert.Equal(t, "edited elsewhere", got)
	assert.Empty(t, p.desk.deletedNoteIDs(), "削除の意図が残っている")
}

func TestOffline_BothDeleted(t *testing.T) {
	p := newOfflinePair(t)
	p.desk.goOffline()
	p.desk.deleteNote("A")
	p.other.deleteNote("A")
	p.other.sync()

	p.desk.goOnline()
	p.syncBoth()
	assert.False(t, p.hasNote(p.desk, "A"))
	assert.False(t, p.hasNote(p.other, "A"))
	assert.Equal(t, 0, p.noteFileCount("A"))
	assert.Empty(t, p.desk.deletedNoteIDs())
}

func TestOffline_MoveIntoFolderDeletedByPeer_FolderIsRevived(t *testing.T) {
	p := newOfflinePair(t)
	f := p.other.createFolder("F")
	p.other.sync()
	p.desk.sync()

	p.desk.goOffline()
	p.desk.moveNoteToFolder("A", f)
	p.other.archiveFolder(f)
	p.other.deleteArchivedFolder(f)
	p.other.sync()

	p.desk.goOnline()
	p.syncBoth()
	for _, d := range []*desktopDevice{p.desk, p.other} {
		assert.Equal(t, f, d.folderOf("A"), d.name)
		list := d.ns.SnapshotNoteList()
		var folder *Folder
		for i := range list.Folders {
			if list.Folders[i].ID == f {
				folder = &list.Folders[i]
			}
		}
		require.NotNil(t, folder, d.name)
		assert.False(t, folder.Archived, d.name)
		assert.GreaterOrEqual(t, indexOfItem(list.TopLevelOrder, TopLevelItem{Type: "folder", ID: f}), 0, d.name)
	}
}

func TestOffline_ReorderAndPeerCreate_BothApplied(t *testing.T) {
	p := newOfflinePair(t)
	p.desk.goOffline()
	p.desk.updateTopLevelOrder([]TopLevelItem{{Type: "note", ID: "A"}, {Type: "note", ID: "B"}})
	p.create(p.other, "N", "n1")
	p.other.sync()

	p.desk.goOnline()
	p.syncBoth()
	assert.Equal(t, []string{"N", "A", "B"}, p.desk.topLevelNoteIDs())
}

func TestOffline_RestartWhileOffline_PendingChangesAreSentLater(t *testing.T) {
	p := newOfflinePair(t)
	p.desk.goOffline()
	p.create(p.desk, "C", "c1")
	p.edit(p.desk, "A", "a2")
	p.desk.deleteNote("B")
	require.Error(t, p.desk.trySync())

	p.desk.restart()
	p.desk.connectLazy()
	require.Error(t, p.desk.trySync())
	assert.True(t, p.desk.hasPendingWork())

	p.desk.goOnline()
	p.syncBoth()
	assert.Equal(t, []string{"C", "A"}, p.other.topLevelNoteIDs())
	assert.Equal(t, "a2", p.content(p.other, "A"))
	assert.False(t, p.hasNote(p.other, "B"))
}

func TestOffline_ConnectionLostMidSync_ConvergesWithoutDuplicatesOrLoss(t *testing.T) {
	p := newOfflinePair(t)
	p.create(p.desk, "C", "c1")
	p.edit(p.desk, "A", "a2")
	p.fd.BeforeRequest(func(r fakeRequest) bool {
		return r.Device == "desktop" && r.Op == "files.update" && r.FileName == "noteList_v2.json"
	}, func(fakeRequest) { p.desk.goOffline() })
	require.Error(t, p.desk.trySync())
	// 本体は Drive にあるが、noteList にはまだ載っていない
	got, ok := p.cloudContent("C")
	require.True(t, ok)
	assert.Equal(t, "c1", got)
	p.other.sync()

	p.desk.goOnline()
	p.syncBoth()
	assert.Equal(t, []string{"C", "B", "A"}, p.other.topLevelNoteIDs())
	assert.Equal(t, "a2", p.content(p.other, "A"))
	assert.Equal(t, 1, p.noteFileCount("C"))
	assert.Equal(t, 1, p.noteFileCount("A"))
	assert.Equal(t, noBackups(), p.desk.backups())
	assert.Equal(t, noBackups(), p.other.backups())
}

func TestOffline_ArchiveFolderVsPeerEdit_NoteStaysVisible(t *testing.T) {
	p := newOfflinePair(t)
	f := p.other.createFolder("F")
	p.other.moveNoteToFolder("A", f)
	p.other.moveNoteToFolder("B", f)
	p.other.sync()
	p.desk.sync()

	p.desk.goOffline()
	p.desk.archiveFolder(f)
	p.edit(p.other, "A", "edited after archive")
	p.other.sync()

	p.desk.goOnline()
	p.syncBoth()
	assert.Equal(t, "edited after archive", p.content(p.desk, "A"))
	kinds := [][2]string{}
	for _, b := range p.desk.backups() {
		kinds = append(kinds, [2]string{b[0], b[1]})
	}
	assert.Equal(t, [][2]string{{"cloud_wins", "A"}}, kinds)
	for _, d := range []*desktopDevice{p.desk, p.other} {
		list := d.ns.SnapshotNoteList()
		archivedFolder := map[string]bool{}
		for _, fo := range list.Folders {
			archivedFolder[fo.ID] = fo.Archived
		}
		for _, n := range list.Notes {
			if n.FolderID == "" {
				continue
			}
			// アクティブなノートがアーカイブ済みフォルダにあると、どの画面にも表示されない
			assert.Equal(t, n.Archived, archivedFolder[n.FolderID], "%s: %s", d.name, n.ID)
		}
	}
}

// ---- 接続解除（ログアウト）中の操作と再接続 ----

func TestLogout_LocalChangesAreSentAfterLoginWithoutBackups(t *testing.T) {
	p := newOfflinePair(t)
	p.desk.logout()
	p.edit(p.desk, "A", "a2 while logged out")
	p.create(p.desk, "C", "c1")

	p.desk.login(p.fd)
	p.syncBoth()
	assert.Equal(t, []string{"C", "B", "A"}, p.other.topLevelNoteIDs())
	assert.Equal(t, "a2 while logged out", p.content(p.other, "A"))
	assert.Equal(t, noBackups(), p.desk.backups())
	assert.Equal(t, noBackups(), p.other.backups())
}

func TestLogout_PeerEditOnlyIsTakenWithoutBackup(t *testing.T) {
	p := newOfflinePair(t)
	p.desk.logout()
	p.edit(p.other, "A", "a2 by other")
	p.other.sync()

	p.desk.login(p.fd)
	p.syncBoth()
	assert.Equal(t, "a2 by other", p.content(p.desk, "A"))
	assert.Equal(t, noBackups(), p.desk.backups())
}

func TestLogout_NoteDeletedByPeerIsNotResurrected(t *testing.T) {
	p := newOfflinePair(t)
	p.desk.logout()
	p.other.deleteNote("A")
	p.other.sync()

	p.desk.login(p.fd)
	p.syncBoth()
	assert.False(t, p.hasNote(p.desk, "A"))
	assert.Equal(t, 0, p.noteFileCount("A"))
	assert.Equal(t, [][3]string{{"cloud_delete", "A", "a1"}}, p.desk.backups())
}

func TestLogout_UnsyncedDeleteIsSentAfterLogin(t *testing.T) {
	p := newOfflinePair(t)
	p.desk.goOffline()
	p.desk.deleteNote("A")
	require.Error(t, p.desk.trySync())
	p.desk.logout()
	p.desk.goOnline()

	p.desk.login(p.fd)
	p.syncBoth()
	assert.Equal(t, 0, p.noteFileCount("A"))
	assert.False(t, p.hasNote(p.other, "A"))
	assert.False(t, p.hasNote(p.desk, "A"))
}

func TestLogout_PeerEditBeatsDeleteWhileLoggedOut(t *testing.T) {
	p := newOfflinePair(t)
	p.desk.logout()
	p.desk.deleteNote("A")
	p.edit(p.other, "A", "edited elsewhere")
	p.other.sync()

	p.desk.login(p.fd)
	p.syncBoth()
	assert.Equal(t, "edited elsewhere", p.content(p.desk, "A"))
	got, _ := p.cloudContent("A")
	assert.Equal(t, "edited elsewhere", got)
}

func TestLogout_FolderMoveAndReorderSurviveLogin(t *testing.T) {
	p := newOfflinePair(t)
	p.desk.logout()
	f := p.desk.createFolder("F")
	p.desk.moveNoteToFolder("A", f)
	p.desk.updateTopLevelOrder([]TopLevelItem{{Type: "note", ID: "B"}, {Type: "folder", ID: f}})

	p.desk.login(p.fd)
	p.syncBoth()
	for _, d := range []*desktopDevice{p.desk, p.other} {
		assert.Equal(t, f, d.folderOf("A"), d.name)
		assert.Equal(t, []TopLevelItem{{Type: "note", ID: "B"}, {Type: "folder", ID: f}}, d.ns.SnapshotNoteList().TopLevelOrder, d.name)
	}
}

func TestLogout_LoginToAnotherAccountDoesNotCarrySyncRecord(t *testing.T) {
	p := newOfflinePair(t)
	p.desk.logout()
	fd2 := newFakeDriveWithPrefix(t, "acct2")
	peer2 := newMobilePeer(t, fd2)
	peer2.ensureLayout()
	peer2.saveNote(peerNote{ID: "X", Title: "X", Content: "x1", Language: "markdown", ModifiedTime: fd2.Now()}, "")
	historyBefore := len(p.fd.NoteHistory())

	p.desk.login(fd2)
	p.desk.sync()
	ids := p.desk.noteIDs()
	assert.ElementsMatch(t, []string{"A", "B", "X"}, ids)
	for _, id := range []string{"A", "B"} {
		files, err := fd2.List("name='" + id + ".json'")
		require.NoError(t, err)
		assert.Len(t, files, 1, "ローカルの %s が新しいアカウントへアップロードされていない", id)
	}
	assert.Equal(t, noBackups(), p.desk.backups())
	assert.Equal(t, historyBefore, len(p.fd.NoteHistory()), "元のアカウントの Drive に書き込んだ")
}

// ---- 復帰時の競合（シミュレーションで見つかったレース） ----

func TestRace_NoteRecreatedAfterDeleteIsNotOverwrittenByDeletedVersion(t *testing.T) {
	p := newOfflinePair(t)
	third := newDesktopDevice(t, p.fd, "third")
	third.startup()

	p.desk.goOffline()
	p.edit(p.desk, "A", "offline edit (older)")
	p.edit(p.other, "A", "other edit (newer)")
	p.other.sync()
	third.sync()
	p.other.deleteNote("A")
	p.other.sync()

	// 編集は削除に勝つ: オフラインだった端末がノートを作り直す（時刻は削除された版より古い）
	p.desk.goOnline()
	p.desk.sync()
	third.sync()
	p.other.sync()
	p.desk.sync()

	for _, d := range []*desktopDevice{p.desk, p.other, third} {
		assert.Equal(t, "offline edit (older)", p.content(d, "A"), d.name)
	}
	got, _ := p.cloudContent("A")
	assert.Equal(t, "offline edit (older)", got)
	// 削除された版はそれを持っていた端末に残る（他端末でのリモート削除と同じ扱い）
	assert.Equal(t, [][3]string{{"cloud_wins", "A", "other edit (newer)"}}, third.backups())
}

func TestRace_StaleOverwriteKeepsOverwrittenVersionInBackup(t *testing.T) {
	p := newOfflinePair(t)
	p.edit(p.desk, "A", "desk edit (older)")
	p.fd.BeforeRequest(func(r fakeRequest) bool {
		return r.Device == "desktop" && r.Op == "files.update" && r.FileName == "A.json"
	}, func(fakeRequest) {
		p.edit(p.other, "A", "other edit (newer)")
		p.other.sync()
	})
	p.desk.sync()
	// desk の古い判断による書き込みで、other の新しい版が上書きされた
	got, _ := p.cloudContent("A")
	require.Equal(t, "desk edit (older)", got)

	p.syncBoth()
	assert.Equal(t, "other edit (newer)", p.content(p.desk, "A"))
	assert.Equal(t, "other edit (newer)", p.content(p.other, "A"))
	assert.Equal(t, [][3]string{{"local_wins", "A", "desk edit (older)"}}, p.other.backups())
}

func TestRace_OverwrittenUnseenByNewerVersionKeepsOwnVersionInBackup(t *testing.T) {
	p := newOfflinePair(t)
	p.edit(p.other, "A", "other edit (older)")
	p.edit(p.desk, "A", "desk edit (newer)")
	// desk は「Drive は前回から変わっていない」と判断して送る。その送信の直前に other が自分の編集を送る
	p.fd.BeforeRequest(func(r fakeRequest) bool {
		return r.Device == "desktop" && r.Op == "files.update" && r.FileName == "A.json"
	}, func(fakeRequest) {
		p.other.sync()
	})
	p.desk.sync()
	got, _ := p.cloudContent("A")
	require.Equal(t, "desk edit (newer)", got)

	p.syncBoth()
	assert.Equal(t, "desk edit (newer)", p.content(p.other, "A"))
	// desk は other の版を見ていないので、other から見ると競合。新しい方が勝ち、自分の版は残る
	assert.Equal(t, [][3]string{{"cloud_wins", "A", "other edit (older)"}}, p.other.backups())
}

func TestRace_TwoHopBlindOverwriteKeepsLostVersionInBackup(t *testing.T) {
	p := newOfflinePair(t)
	third := newDesktopDevice(t, p.fd, "third")
	third.startup()

	// other は「Drive は前回から変わっていない」と判断して送る。その送信の直前に desk が編集を送る
	p.edit(p.other, "A", "other edit (blind)")
	p.fd.BeforeRequest(func(r fakeRequest) bool {
		return r.Device == "other" && r.Op == "files.update" && r.FileName == "A.json"
	}, func(fakeRequest) {
		p.edit(p.desk, "A", "desk edit")
		p.desk.sync()
	})
	p.other.sync()
	got, _ := p.cloudContent("A")
	require.Equal(t, "other edit (blind)", got)
	// desk が同期する前に、third が other の版を見た上で（より新しく）書く
	third.sync()
	p.edit(third, "A", "third edit (newest)")
	third.sync()

	p.desk.sync()
	p.other.sync()
	third.sync()
	for _, d := range []*desktopDevice{p.desk, p.other, third} {
		assert.Equal(t, "third edit (newest)", p.content(d, "A"), d.name)
	}
	assert.Equal(t, [][3]string{{"cloud_wins", "A", "desk edit"}}, p.desk.backups())
	assert.Equal(t, noBackups(), p.other.backups())
	assert.Equal(t, noBackups(), third.backups())
}

func TestOffline_MissedIntermediateEditsDoNotCreateBackups(t *testing.T) {
	p := newOfflinePair(t)
	p.desk.goOffline()
	for _, c := range []string{"a2", "a3", "a4"} {
		p.edit(p.other, "A", c)
		p.other.sync()
	}

	p.desk.goOnline()
	p.syncBoth()
	assert.Equal(t, "a4", p.content(p.desk, "A"))
	assert.Equal(t, noBackups(), p.desk.backups())
}

// 既知の制限: 勝敗は ModifiedTime（端末の時計）で決めるので、時計が大きく進んでいる端末があると
// その後の他端末の編集が巻き戻ることがある。ただし黙っては消えず、バックアップに残る。
func TestClockSkew_DeviceAheadMayRevertLaterEditButKeepsItInBackup(t *testing.T) {
	p := newOfflinePair(t)
	// other の時計は 1 年進んでいる
	p.other.editNoteAt("A", "edited on a clock that runs ahead", "2027-01-01T00:00:00Z")
	p.other.sync()
	p.desk.sync()
	// desk は other の版を見た上で編集する（desk の時計ではこちらの方が古い時刻になる）
	p.edit(p.desk, "A", "edited later on desktop")
	p.desk.sync()

	p.syncBoth()
	assert.Equal(t, "edited on a clock that runs ahead", p.content(p.desk, "A"))
	assert.Equal(t, [][3]string{{"local_wins", "A", "edited later on desktop"}}, p.other.backups())
}

// ---- ノート一覧の記録（ContentHash）と本体の食い違い ----

// uploadCount はノート本体が Drive に書き込まれた回数。
func (p *offlinePair) uploadCount(id string) int {
	n := 0
	for _, h := range p.fd.NoteHistory() {
		if h.Name == id+".json" && h.Kind == "upload" {
			n++
		}
	}
	return n
}

// setStaleListHash はノート一覧に記録された ContentHash だけを本体と食い違わせる
// （旧バージョンや保存途中の中断で起きうる状態）。
func (p *offlinePair) setStaleListHash(d *desktopDevice, id string) {
	p.t.Helper()
	d.ns.WithLock(func() {
		for i, m := range d.ns.noteList.Notes {
			if m.ID == id {
				d.ns.noteList.Notes[i].ContentHash = "stale-hash-from-an-older-version"
			}
		}
		require.NoError(p.t, d.ns.saveNoteList())
	})
}

func TestListHash_StaleHashDoesNotCauseEndlessReupload(t *testing.T) {
	p := newOfflinePair(t)
	p.setStaleListHash(p.desk, "A")
	before := p.uploadCount("A")

	for i := 0; i < 5; i++ {
		p.desk.sync()
		p.other.sync()
	}

	assert.Equal(t, before, p.uploadCount("A"), "中身が変わっていないノートを送り続けた")
	note, err := p.desk.readNote("A")
	require.NoError(t, err)
	for _, m := range p.desk.ns.SnapshotNoteList().Notes {
		if m.ID == "A" {
			assert.Equal(t, computeContentHash(note), m.ContentHash, "ノート一覧の記録が本体に合わせて直っていない")
		}
	}
}

func TestListHash_FileChangedBehindTheListIsKeptAsRecoveredNote(t *testing.T) {
	p := newOfflinePair(t)
	p.setUILanguage(p.desk, "en")
	// desk の本体だけが（一覧の記録を更新しないまま）別の内容になっている
	p.changeFileBehindList(p.desk, "A", "local file content the list does not know about")
	// 相手が A を編集する
	p.edit(p.other, "A", "other edit")
	p.other.sync()

	p.desk.sync()
	// どちらが正しいか分からないので勝敗は決めない: A は相手の版になり、desk の本体の内容は復帰ノートとして残る
	assert.Equal(t, "other edit", p.content(p.desk, "A"))
	assert.Equal(t, map[string]string{"A (Recovered)": "local file content the list does not know about"}, p.recoveredNotes(p.desk))
	assert.Equal(t, noBackups(), p.desk.backups())
}

// ---- 出どころ不明のローカルの内容（復帰ノート） ----

// changeFileBehindList はノート一覧の記録を変えずに本体だけを書き換える（過去のバージョンの不具合で起きた状態）。
func (p *offlinePair) changeFileBehindList(d *desktopDevice, id, content string) {
	p.t.Helper()
	note, err := d.readNote(id)
	require.NoError(p.t, err)
	changed := *note
	changed.Content = content
	d.ns.WithLock(func() {
		require.NoError(p.t, d.ns.saveNoteFromSyncLocked(&changed))
	})
}

// recoveredNotes は復帰ノートのタイトル → 内容（元のノートの ID でもタイトルでもないノート）。
func (p *offlinePair) recoveredNotes(d *desktopDevice) map[string]string {
	p.t.Helper()
	got := map[string]string{}
	for _, m := range d.ns.SnapshotNoteList().Notes {
		if m.ID == m.Title {
			continue // このテストのノートは ID とタイトルが同じ
		}
		got[m.Title] = p.content(d, m.ID)
	}
	return got
}

// recoveredNoteID は復帰ノートの ID（無ければ空）。
func (p *offlinePair) recoveredNoteID(d *desktopDevice) string {
	for _, m := range d.ns.SnapshotNoteList().Notes {
		if m.ID != m.Title {
			return m.ID
		}
	}
	return ""
}

// setUILanguage は設定の UI 言語を変える（復帰ノートのタイトルに使う。未設定だとシステムの言語になる）。
func (p *offlinePair) setUILanguage(d *desktopDevice, uiLanguage string) {
	p.t.Helper()
	require.NoError(p.t, os.WriteFile(filepath.Join(d.dir, "settings.json"), []byte(`{"uiLanguage":"`+uiLanguage+`"}`), 0644))
}

// relaunch はアプリを再起動して Drive に接続し直す（UI の言語を指定する）。
func (p *offlinePair) relaunch(d *desktopDevice, uiLanguage string) {
	p.t.Helper()
	p.setUILanguage(d, uiLanguage)
	d.restart()
	d.connect()
}

// listHashMatchesFile はノート一覧の記録が本体と一致しているか。
func listHashMatchesFile(t *testing.T, d *desktopDevice, id string) bool {
	t.Helper()
	note, err := d.readNote(id)
	require.NoError(t, err)
	for _, m := range d.ns.SnapshotNoteList().Notes {
		if m.ID == id {
			return m.ContentHash == computeContentHash(note)
		}
	}
	return false
}

func TestRecover_UnrecordedLocalContentIsKeptAsRecoveredNoteAfterRelaunch(t *testing.T) {
	p := newOfflinePair(t)
	p.changeFileBehindList(p.desk, "A", "only on this desk")
	// 同期の判定だけでは気づかない（記録も base も同じ）。起動後の最初の同期で全ノートを本体と照合して見つける
	p.relaunch(p.desk, "ja")

	p.syncBoth()
	recovered := p.recoveredNoteID(p.desk)
	require.NotEmpty(t, recovered)
	for _, d := range []*desktopDevice{p.desk, p.other} {
		assert.Equal(t, "a1", p.content(d, "A"), d.name)
		assert.Equal(t, map[string]string{"A(復帰済み)": "only on this desk"}, p.recoveredNotes(d), d.name)
		assert.Equal(t, []string{"B", "A", recovered}, d.topLevelNoteIDs(), "復帰ノートは元のノートのすぐ下に入る")
		assert.Equal(t, noBackups(), d.backups(), d.name)
	}
	got, ok := p.cloudContent(recovered)
	require.True(t, ok)
	assert.Equal(t, "only on this desk", got)
	assert.True(t, listHashMatchesFile(t, p.desk, "A"))

	// 一度分けたら繰り返さない
	p.relaunch(p.desk, "ja")
	p.syncBoth()
	assert.Len(t, p.recoveredNotes(p.desk), 1)
}

func TestRecover_RecoveredNoteStaysInTheSameFolder(t *testing.T) {
	p := newOfflinePair(t)
	folder := p.other.createFolder("F")
	p.other.moveNoteToFolder("A", folder)
	p.other.moveNoteToFolder("B", folder)
	p.other.sync()
	p.desk.sync()
	inFolder := func(d *desktopDevice) []string {
		var ids []string
		for _, m := range d.ns.SnapshotNoteList().Notes {
			if m.FolderID == folder {
				ids = append(ids, m.ID)
			}
		}
		return ids
	}
	before := inFolder(p.desk)
	require.ElementsMatch(t, []string{"A", "B"}, before)
	p.changeFileBehindList(p.desk, "B", "only on this desk")
	p.relaunch(p.desk, "en")

	p.syncBoth()
	recovered := p.recoveredNoteID(p.desk)
	require.NotEmpty(t, recovered)
	want := []string{}
	for _, id := range before {
		want = append(want, id)
		if id == "B" {
			want = append(want, recovered)
		}
	}
	for _, d := range []*desktopDevice{p.desk, p.other} {
		assert.Equal(t, map[string]string{"B (Recovered)": "only on this desk"}, p.recoveredNotes(d), d.name)
		assert.Equal(t, want, inFolder(d), "復帰ノートは同じフォルダの、元のノートのすぐ下に入る")
	}
}

func TestRecover_TooManyAtOnceAreLeftAsIs(t *testing.T) {
	p := newOfflinePair(t)
	var ids []string
	for i := 0; i <= maxRecoveredNotesPerSync; i++ {
		id := fmt.Sprintf("N%02d", i)
		p.create(p.other, id, "synced "+id)
		ids = append(ids, id)
	}
	p.other.sync()
	p.desk.sync()
	for _, id := range ids {
		p.changeFileBehindList(p.desk, id, "local "+id)
	}
	uploadsBefore := len(p.fd.NoteHistory())
	p.relaunch(p.desk, "ja")

	p.desk.sync()
	// 一度に大量に食い違うのは仕組み側の問題の疑いがあるので、分けずにそのままにする（何も失わない・何も送らない）
	assert.Empty(t, p.recoveredNotes(p.desk))
	for _, id := range ids {
		assert.Equal(t, "local "+id, p.content(p.desk, id))
		got, _ := p.cloudContent(id)
		assert.Equal(t, "synced "+id, got)
		assert.False(t, listHashMatchesFile(t, p.desk, id), "記録を本体に合わせると次からローカルの編集として送ってしまう")
	}
	assert.Equal(t, uploadsBefore, len(p.fd.NoteHistory()))
}

func TestRecover_DownloadFailureIsRetriedOnNextSync(t *testing.T) {
	p := newOfflinePair(t)
	p.changeFileBehindList(p.desk, "A", "only on this desk")
	p.relaunch(p.desk, "ja")
	p.fd.FailWhen(func(r fakeRequest) bool {
		return r.Device == "desktop" && r.Op == "files.download" && r.FileName == "A.json"
	}, 500, 1)

	p.desk.sync()
	assert.Empty(t, p.recoveredNotes(p.desk))
	assert.Equal(t, "only on this desk", p.content(p.desk, "A"))

	p.syncBoth()
	assert.Equal(t, "a1", p.content(p.desk, "A"))
	assert.Equal(t, map[string]string{"A(復帰済み)": "only on this desk"}, p.recoveredNotes(p.desk))
}

func TestRecover_EditDuringSyncKeepsCloudVersionInBackup(t *testing.T) {
	p := newOfflinePair(t)
	p.changeFileBehindList(p.desk, "A", "only on this desk")
	p.relaunch(p.desk, "ja")
	// 同期中（リモートの版を取りに行っている間）にユーザーが A を編集する
	p.fd.BeforeRequest(func(r fakeRequest) bool {
		return r.Device == "desktop" && r.Op == "files.download" && r.FileName == "A.json"
	}, func(fakeRequest) {
		p.edit(p.desk, "A", "edited during sync")
	})

	p.desk.sync()
	p.syncBoth()
	// ユーザーが手元の版から編集を続けたので分けない。上書きされるクラウドの版はバックアップに残す
	assert.Empty(t, p.recoveredNotes(p.desk))
	assert.Equal(t, "edited during sync", p.content(p.desk, "A"))
	assert.Equal(t, "edited during sync", p.content(p.other, "A"))
	assert.Equal(t, [][3]string{{"local_wins", "A", "a1"}}, p.desk.backups())
}

func TestRecover_RemoteDeletionRestoresLocalContentInsteadOfSplitting(t *testing.T) {
	p := newOfflinePair(t)
	p.other.deleteNote("A")
	p.other.sync()
	p.changeFileBehindList(p.desk, "A", "only on this desk")
	p.relaunch(p.desk, "ja")

	p.syncBoth()
	// 相手は削除したが、手元には相手の知らない内容がある: 編集は削除に勝つ（分けずに元の ID で復元）
	assert.Empty(t, p.recoveredNotes(p.desk))
	assert.Equal(t, "only on this desk", p.content(p.desk, "A"))
	assert.Equal(t, "only on this desk", p.content(p.other, "A"))
}
