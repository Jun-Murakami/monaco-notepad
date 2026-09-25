package backend

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 同期エンジン v3 の振る舞いテスト（本番の driveOperationsImpl を fakeDrive 上で動かす）。
// 検証するのは「最終的に端末とクラウドがどういう状態になるか」であり、呼び出し回数ではない。

func backupFiles(t *testing.T, d *desktopDevice) []string {
	t.Helper()
	entries, err := listCloudConflictBackups(filepath.Join(d.dir, cloudWinBackupDirName))
	require.NoError(t, err)
	var kinds []string
	for _, e := range entries {
		kinds = append(kinds, e.Kind)
	}
	return kinds
}

func sortedIDs(ids []string) []string {
	out := append([]string(nil), ids...)
	sort.Strings(out)
	return out
}

func TestSyncEngine_FirstSync_EmptyDriveUploadsLocalNotesInOrder(t *testing.T) {
	fd := newFakeDrive(t)
	desk := newDesktopDevice(t, fd, "desktop")
	desk.createNote("X", "x", "x1")
	desk.createNote("Y", "y", "y1")

	desk.startup()

	peer := newMobilePeer(t, fd)
	assert.Equal(t, []string{"Y", "X"}, peer.cloudTopLevelNoteIDs())
	x, ok := peer.readCloudNote("X")
	require.True(t, ok)
	assert.Equal(t, "x1", x.Content)
}

func TestSyncEngine_SecondSyncIsNoOp(t *testing.T) {
	s := newScenario(t)
	s.seedShared()

	report, err := s.desk.ds.engine.Sync()
	require.NoError(t, err)

	assert.Equal(t, syncReport{Attempts: 1}, report)
	assert.False(t, s.desk.hasPendingWork())
}

func TestSyncEngine_ConflictPeerNewerWins_LocalIsBackedUp(t *testing.T) {
	s := newScenario(t)
	s.seedShared()
	s.desk.editNoteAt("A", "older on desktop", "2026-01-01T00:00:30Z")
	newer := s.note("A", "newer on mobile")
	newer.ModifiedTime = "2030-01-01T00:00:00Z"
	s.peer.saveNote(newer, "")

	s.desk.sync()

	a, err := s.desk.readNote("A")
	require.NoError(t, err)
	assert.Equal(t, "newer on mobile", a.Content)
	assert.Equal(t, []string{"cloud_wins"}, backupFiles(t, s.desk))
}

func TestSyncEngine_ConflictDesktopNewerWins(t *testing.T) {
	s := newScenario(t)
	s.seedShared()
	s.peer.saveNote(s.note("A", "older on mobile"), "")
	s.desk.editNoteAt("A", "newer on desktop", "2030-01-01T00:00:00Z")

	s.desk.sync()

	cloudA, ok := s.peer.readCloudNote("A")
	require.True(t, ok)
	assert.Equal(t, "newer on desktop", cloudA.Content)
	meta, ok := s.peer.cloudMeta("A")
	require.True(t, ok)
	assert.Equal(t, peerContentHash(cloudA), meta.ContentHash, "noteList のメタは Drive 上の本体と一致する")
}

func TestSyncEngine_BackupDisabled_NoBackupFiles(t *testing.T) {
	s := newScenario(t)
	s.seedShared()
	require.NoError(t, os.WriteFile(filepath.Join(s.desk.dir, "settings.json"), []byte(`{"enableConflictBackup":false}`), 0644))
	s.desk.editNoteAt("A", "older on desktop", "2026-01-01T00:00:30Z")
	newer := s.note("A", "newer on mobile")
	newer.ModifiedTime = "2030-01-01T00:00:00Z"
	s.peer.saveNote(newer, "")

	s.desk.sync()

	assert.Empty(t, backupFiles(t, s.desk))
}

func TestSyncEngine_PeerDeletesNoteDesktopEdited_EditWins(t *testing.T) {
	s := newScenario(t)
	s.seedShared()
	s.desk.editNote("B", "edited while deleted elsewhere")
	s.peer.deleteNote("B")

	s.desk.sync()

	b, ok := s.peer.readCloudNote("B")
	require.True(t, ok)
	assert.Equal(t, "edited while deleted elsewhere", b.Content)
	assert.Contains(t, s.peer.cloudNoteIDs(), "B")
}

func TestSyncEngine_PeerDeletesUntouchedNote_BackedUpAndRemoved(t *testing.T) {
	s := newScenario(t)
	s.seedShared()
	s.peer.deleteNote("B")

	s.desk.sync()

	assert.Equal(t, []string{"A"}, s.desk.noteIDs())
	assert.Equal(t, []string{"cloud_delete"}, backupFiles(t, s.desk))
}

func TestSyncEngine_DesktopDeletesNotePeerEdited_RestoredAndIntentCleared(t *testing.T) {
	s := newScenario(t)
	s.seedShared()
	s.desk.deleteNote("B")
	s.peer.saveNote(s.note("B", "b2 edited on mobile"), "")

	s.desk.sync()

	b, err := s.desk.readNote("B")
	require.NoError(t, err)
	assert.Equal(t, "b2 edited on mobile", b.Content)
	assert.Empty(t, s.desk.state.DeletedNoteIDs)
}

func TestSyncEngine_DesktopDeletion_RemovedFromCloud(t *testing.T) {
	s := newScenario(t)
	s.seedShared()
	s.desk.deleteNote("B")

	s.desk.sync()

	_, ok := s.peer.readCloudNote("B")
	assert.False(t, ok)
	assert.Equal(t, []string{"A"}, s.peer.cloudNoteIDs())
	assert.False(t, s.desk.hasPendingWork())
}

func TestSyncEngine_UploadFailure_NoGhostEntryThenRetried(t *testing.T) {
	s := newScenario(t)
	s.seedShared()
	s.desk.createNote("M", "m", "m1")
	s.fd.FailWhen(func(r fakeRequest) bool {
		return isDesktop(r) && r.Op == "files.create" && r.FileName == "M.json"
	}, 503, 1)

	s.desk.sync()
	assert.NotContains(t, s.peer.cloudNoteIDs(), "M", "本体の無い記載をクラウドに作らない")
	assert.True(t, s.desk.hasPendingWork())

	s.desk.sync()
	assert.Contains(t, s.peer.cloudNoteIDs(), "M")
	assert.Equal(t, "M", s.peer.cloudTopLevelNoteIDs()[0])
}

func TestSyncEngine_NewNoteThenImmediateEdit_ReachesOtherDevice(t *testing.T) {
	// 旧実装で「新規ノート直後の編集がもう片方の端末に永久に届かない」ことがあった経路
	s := newScenario(t)
	s.seedShared()
	s.desk.createNote("M", "m", "first")
	// 本体アップロードの直後（noteList 確定前）にユーザーがもう一度編集する
	s.fd.AfterRequest(func(r fakeRequest) bool {
		return isDesktop(r) && r.Op == "files.create" && r.FileName == "M.json"
	}, func(fakeRequest) {
		s.desk.editNote("M", "second")
	})

	s.desk.sync()
	s.desk.sync()

	m, ok := s.peer.readCloudNote("M")
	require.True(t, ok)
	assert.Equal(t, "second", m.Content)
	meta, _ := s.peer.cloudMeta("M")
	assert.Equal(t, peerContentHash(m), meta.ContentHash)
}

func TestSyncEngine_DriveWipedByDeleteAllDriveData_LocalNotesSurviveAndReupload(t *testing.T) {
	fd := newFakeDrive(t)
	peer := newMobilePeer(t, fd)
	peer.ensureLayout()
	peer.saveNote(peerNote{ID: "A", Title: "A", Content: "a1", Language: "markdown", ModifiedTime: fd.Now()}, "")
	laptop := newDesktopDevice(t, fd, "desktop")
	laptop.startup()
	office := newDesktopDevice(t, fd, "office")
	office.startup()

	// office で「Drive 上の全データを削除」
	require.NoError(t, office.ds.DeleteAllDriveData())
	laptop.sync()

	assert.Equal(t, []string{"A"}, laptop.noteIDs(), "別端末で Drive を全削除してもローカルは消さない")
	a, ok := newMobilePeer(t, fd).readCloudNote("A")
	require.True(t, ok)
	assert.Equal(t, "a1", a.Content, "ローカルから上げ直される")
}

func TestSyncEngine_MigrationFromV2_NoUploadsWhenInSync(t *testing.T) {
	s := newScenario(t)
	a := s.note("A", "a1")
	s.peer.saveNote(a, "")
	// v2 で同期済みの状態: ローカルに同じ本文があり、LastSyncedNoteHash を記録済み
	require.NoError(t, s.desk.ns.SaveNote(&Note{ID: "A", Title: a.Title, Content: a.Content, Language: a.Language}))
	s.desk.ns.WithLock(func() {
		note, _ := s.desk.ns.loadNoteLocked("A")
		cp := *note
		cp.ModifiedTime = a.ModifiedTime
		require.NoError(t, s.desk.ns.saveNoteFromSyncLocked(&cp))
	})
	hash := peerContentHash(a)
	legacy, _ := json.Marshal(map[string]any{
		"dirty": false, "lastSyncedDriveTs": "2026-01-01T00:00:00Z",
		"dirtyNoteIDs": map[string]bool{}, "deletedNoteIDs": map[string]bool{}, "deletedFolderIDs": map[string]bool{},
		"lastSyncedNoteHash": map[string]string{"A": hash},
	})
	require.NoError(t, os.WriteFile(filepath.Join(s.desk.dir, "sync_state.json"), legacy, 0644))
	s.desk.restart()
	s.desk.connect()

	report, err := s.desk.ds.engine.Sync()
	require.NoError(t, err)

	assert.Equal(t, 0, report.Uploaded)
	got, err := s.desk.readNote("A")
	require.NoError(t, err)
	assert.Equal(t, "a1", got.Content)
	assert.False(t, s.desk.hasPendingWork())
}

func TestSyncEngine_DuplicateNoteFiles_NewestWinsOlderDeleted(t *testing.T) {
	s := newScenario(t)
	s.seedShared()
	dup, _ := json.Marshal(map[string]any{"id": "A", "title": "Title A", "content": "a-dup-newer", "language": "markdown", "modifiedTime": s.fd.Now()})
	s.fd.CreateFile("A.json", []string{s.peer.notesFolder().ID}, dup, "application/json")

	s.desk.sync()

	a, err := s.desk.readNote("A")
	require.NoError(t, err)
	assert.Equal(t, "a-dup-newer", a.Content)
	files, _ := s.fd.List("name='A.json' and trashed=false")
	assert.Len(t, files, 1)
}

func TestSyncEngine_GhostEntryWithoutFile_IsDropped(t *testing.T) {
	s := newScenario(t)
	s.seedShared()
	s.peer.publishNoteMeta(s.note("G", "ghost"), "")
	s.desk.editNote("A", "a2")

	s.desk.sync()

	assert.NotContains(t, s.desk.noteIDs(), "G")
	assert.NotContains(t, s.peer.cloudNoteIDs(), "G")
}

func TestSyncEngine_TwoDesktopsAndMobile_Converge(t *testing.T) {
	s := newScenario(t)
	s.seedShared()
	office := newDesktopDevice(t, s.fd, "office")
	office.startup()

	s.desk.editNote("A", "a2 laptop")
	s.desk.createNote("L1", "laptop", "laptop new")
	office.editNote("B", "b2 office")
	office.createNote("O1", "office", "office new")
	s.peer.saveNote(s.note("P1", "phone new"), "")

	for i := 0; i < 2; i++ {
		s.desk.sync()
		office.sync()
	}

	want := []string{"A", "B", "L1", "O1", "P1"}
	assert.Equal(t, want, sortedIDs(s.desk.noteIDs()))
	assert.Equal(t, want, sortedIDs(office.noteIDs()))
	assert.Equal(t, want, sortedIDs(s.peer.cloudNoteIDs()))
	assert.Equal(t, s.desk.topLevelNoteIDs(), office.topLevelNoteIDs())
	assert.Equal(t, s.desk.topLevelNoteIDs(), s.peer.cloudTopLevelNoteIDs())
	for _, d := range []*desktopDevice{s.desk, office} {
		a, _ := d.readNote("A")
		b, _ := d.readNote("B")
		assert.Equal(t, "a2 laptop", a.Content)
		assert.Equal(t, "b2 office", b.Content)
	}
}

func TestSyncEngine_NoteListWriteRace_RetriesAndKeepsBoth(t *testing.T) {
	s := newScenario(t)
	s.seedShared()
	s.desk.createNote("M", "m", "m1")
	// 書き込み直前の再確認（noteList の検索）と実際の書き込みの間にピアが書く
	s.fd.BeforeRequest(func(r fakeRequest) bool {
		return isDesktop(r) && r.Op == "files.update" && r.FileName == "noteList_v2.json"
	}, func(fakeRequest) {
		s.peer.saveNote(s.note("P", "from mobile"), "")
	})

	report, err := s.desk.ds.engine.Sync()
	require.NoError(t, err)

	assert.GreaterOrEqual(t, report.Attempts, 2)
	assert.Subset(t, s.peer.cloudNoteIDs(), []string{"A", "B", "M", "P"})
	assert.Subset(t, s.desk.noteIDs(), []string{"A", "B", "M", "P"})
}

var _ = time.Now
