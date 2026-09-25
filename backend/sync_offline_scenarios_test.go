package backend

import (
	"encoding/json"
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
