package backend

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSyncState_MarkNoteDirty(t *testing.T) {
	state := NewSyncState(t.TempDir())

	state.MarkNoteDirty("note1")

	assert.True(t, state.IsDirty())
	assert.True(t, state.DirtyNoteIDs["note1"])
}

func TestSyncState_MarkNoteDeleted(t *testing.T) {
	state := NewSyncState(t.TempDir())

	state.MarkNoteDirty("note1")
	state.MarkNoteDeleted("note1")

	assert.True(t, state.IsDirty())
	assert.True(t, state.DeletedNoteIDs["note1"])
	assert.False(t, state.DirtyNoteIDs["note1"])
}

func TestSyncState_MarkDirty(t *testing.T) {
	state := NewSyncState(t.TempDir())

	state.MarkDirty()

	assert.True(t, state.IsDirty())
	assert.Empty(t, state.DirtyNoteIDs)
}

func TestSyncState_MarkFolderDeleted(t *testing.T) {
	state := NewSyncState(t.TempDir())

	state.MarkFolderDeleted("folder1")

	assert.True(t, state.IsDirty())
	assert.True(t, state.DeletedFolderIDs["folder1"])
}

func TestSyncState_PersistAndLoad(t *testing.T) {
	dir := t.TempDir()

	state := NewSyncState(dir)
	state.MarkNoteDirty("note1")
	state.MarkNoteDeleted("note2")
	state.MarkFolderDeleted("folder1")
	require.NoError(t, state.Save())

	loaded := NewSyncState(dir)
	require.NoError(t, loaded.Load())

	assert.True(t, loaded.IsDirty())
	assert.True(t, loaded.DirtyNoteIDs["note1"])
	assert.True(t, loaded.DeletedNoteIDs["note2"])
	assert.True(t, loaded.DeletedFolderIDs["folder1"])
}

func TestSyncState_CrashRecovery(t *testing.T) {
	dir := t.TempDir()

	state := NewSyncState(dir)
	state.MarkDirty()
	require.NoError(t, state.Save())

	recovered := NewSyncState(dir)
	require.NoError(t, recovered.Load())
	assert.True(t, recovered.IsDirty())
}

func TestSyncState_LoadMissingFile(t *testing.T) {
	state := NewSyncState(t.TempDir())

	require.NoError(t, state.Load())

	assert.False(t, state.IsDirty())
	assert.Empty(t, state.DirtyNoteIDs)
	assert.Empty(t, state.DeletedNoteIDs)
	assert.Empty(t, state.DeletedFolderIDs)
	assert.Empty(t, state.LastSyncedNoteHash)
}

func TestSyncState_LoadCorruptFile(t *testing.T) {
	dir := t.TempDir()
	filePath := filepath.Join(dir, "sync_state.json")
	require.NoError(t, os.WriteFile(filePath, []byte("{not-json"), 0644))

	state := NewSyncState(dir)
	require.NoError(t, state.Load())

	assert.True(t, state.IsDirty())
	assert.Empty(t, state.DirtyNoteIDs)
	assert.Empty(t, state.DeletedNoteIDs)
	assert.Empty(t, state.DeletedFolderIDs)
	assert.Empty(t, state.LastSyncedNoteHash)
}

func TestSyncState_AtomicWrite(t *testing.T) {
	dir := t.TempDir()
	state := NewSyncState(dir)
	state.MarkDirty()

	require.NoError(t, state.Save())

	filePath := filepath.Join(dir, "sync_state.json")
	_, err := os.Stat(filePath)
	require.NoError(t, err)

	_, err = os.Stat(filePath + ".tmp")
	assert.True(t, os.IsNotExist(err))
}

func TestSyncState_MultipleMarkNoteDirty(t *testing.T) {
	state := NewSyncState(t.TempDir())

	state.MarkNoteDirty("note1")
	state.MarkNoteDirty("note2")
	state.MarkNoteDirty("note3")

	assert.True(t, state.IsDirty())
	assert.True(t, state.DirtyNoteIDs["note1"])
	assert.True(t, state.DirtyNoteIDs["note2"])
	assert.True(t, state.DirtyNoteIDs["note3"])
	assert.Len(t, state.DirtyNoteIDs, 3)
}

// ---- FullReuploadPending / HasPendingUploads -----------------------------------
// DeleteAllDriveData + 再ログインで「ノート本体が Drive に上がらず noteList だけ作られる」
// 問題への対策として入れた MarkForFullReupload / ClearFullReupload / HasPendingUploads の挙動を検証する。

// ---- UpdateSyncedNoteHash (resume optimization) ----
// 大量アップロード途中の再起動時に、既に上がっているノートを個別にスキップできるよう
// per-note で LastSyncedNoteHash を永続化する仕組みをテストする。

func TestSyncState_CompleteSync_ClearsHintsWhenNoEditDuringSync(t *testing.T) {
	state := NewSyncState(t.TempDir())
	state.MarkNoteDirty("n1")
	state.MarkFolderDeleted("f1")
	_, _, _, _, rev := state.GetDirtySnapshotWithRevision()

	assert.True(t, state.CompleteSync(rev, nil, true))
	assert.False(t, state.IsDirty())
	assert.Empty(t, state.DirtyNoteIDs)
	assert.Empty(t, state.DeletedFolderIDs)
}

func TestSyncState_CompleteSync_KeepsHintsWhenEditedDuringSync(t *testing.T) {
	state := NewSyncState(t.TempDir())
	state.MarkNoteDirty("n1")
	_, _, _, _, rev := state.GetDirtySnapshotWithRevision()
	state.MarkNoteDirty("n2") // 同期中の編集

	assert.False(t, state.CompleteSync(rev, nil, true))
	assert.True(t, state.IsDirty())
	assert.Equal(t, map[string]bool{"n1": true, "n2": true}, state.DirtyNoteIDs)
}

func TestSyncState_CompleteSync_FailureRequestsRetry(t *testing.T) {
	state := NewSyncState(t.TempDir())
	_, _, _, _, rev := state.GetDirtySnapshotWithRevision()

	assert.False(t, state.CompleteSync(rev, nil, false))
	assert.True(t, state.IsDirty(), "失敗したサイクルの後はすぐ再同期させる")
}

func TestSyncState_CompleteSync_ResolvesDeletionsIndividually(t *testing.T) {
	state := NewSyncState(t.TempDir())
	state.MarkNoteDeleted("done")
	state.MarkNoteDeleted("pending")
	_, _, _, _, rev := state.GetDirtySnapshotWithRevision()

	state.CompleteSync(rev, []string{"done"}, false)

	assert.Equal(t, map[string]bool{"pending": true}, state.DeletedNoteIDs)
	assert.True(t, state.IsDirty(), "未処理の削除意図が残っている間は同期が必要")
}

func TestSyncState_LegacyNoteHashes_ReadForMigrationThenCleared(t *testing.T) {
	dir := t.TempDir()
	data := `{"dirty":false,"lastSyncedDriveTs":"2026-01-01T00:00:00Z","dirtyNoteIDs":{},"deletedNoteIDs":{},"deletedFolderIDs":{},"lastSyncedNoteHash":{"a":"hash-a"}}`
	require.NoError(t, os.WriteFile(filepath.Join(dir, "sync_state.json"), []byte(data), 0644))
	state := NewSyncState(dir)
	require.NoError(t, state.Load())

	assert.Equal(t, map[string]string{"a": "hash-a"}, state.LegacyNoteHashes())

	_, _, _, _, rev := state.GetDirtySnapshotWithRevision()
	state.CompleteSync(rev, nil, true)
	assert.Empty(t, state.LegacyNoteHashes())
}
