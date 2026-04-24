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

func TestSyncState_ClearDirty(t *testing.T) {
	state := NewSyncState(t.TempDir())

	state.MarkNoteDirty("note1")
	state.MarkNoteDeleted("note2")
	state.MarkFolderDeleted("folder1")
	state.ClearDirty("2026-01-01T00:00:00Z", map[string]string{"note1": "hash1"})

	assert.False(t, state.IsDirty())
	assert.Empty(t, state.DirtyNoteIDs)
	assert.Empty(t, state.DeletedNoteIDs)
	assert.Empty(t, state.DeletedFolderIDs)
	assert.Equal(t, "2026-01-01T00:00:00Z", state.LastSyncedDriveTs)
	assert.Equal(t, "hash1", state.LastSyncedNoteHash["note1"])
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

func TestSyncState_ClearDirtyIfUnchanged_SkipsWhenRevisionChanged(t *testing.T) {
	state := NewSyncState(t.TempDir())
	state.MarkNoteDirty("note1")

	_, _, _, _, revision := state.GetDirtySnapshotWithRevision()

	// スナップショット取得後に新しい変更が入るケース
	state.MarkNoteDirty("note2")

	cleared := state.ClearDirtyIfUnchanged(revision, "2026-01-01T00:00:00Z", map[string]string{
		"note1": "hash1",
		"note2": "hash2",
	})

	assert.False(t, cleared)
	assert.True(t, state.IsDirty())
	assert.True(t, state.DirtyNoteIDs["note1"])
	assert.True(t, state.DirtyNoteIDs["note2"])
}

func TestSyncState_ClearDirtyIfUnchanged_ClearsWhenRevisionSame(t *testing.T) {
	state := NewSyncState(t.TempDir())
	state.MarkNoteDirty("note1")

	_, _, _, _, revision := state.GetDirtySnapshotWithRevision()

	cleared := state.ClearDirtyIfUnchanged(revision, "2026-01-01T00:00:00Z", map[string]string{
		"note1": "hash1",
	})

	assert.True(t, cleared)
	assert.False(t, state.IsDirty())
	assert.Empty(t, state.DirtyNoteIDs)
	assert.Equal(t, "hash1", state.LastSyncedNoteHash["note1"])
}

func TestSyncState_UpdateSyncedState_UpdatesTsAndHashesButKeepsDirty(t *testing.T) {
	state := NewSyncState(t.TempDir())
	state.MarkNoteDirty("note1")
	state.MarkNoteDirty("note2")
	state.MarkDirty()

	_, _, _, _, revision := state.GetDirtySnapshotWithRevision()

	state.MarkNoteDirty("note3")

	cleared := state.ClearDirtyIfUnchanged(revision, "2026-01-01T00:00:00Z", map[string]string{
		"note1": "hash1",
		"note2": "hash2",
	})
	assert.False(t, cleared)

	state.UpdateSyncedState("2026-01-01T00:00:00Z", map[string]string{
		"note1": "hash1",
		"note2": "hash2",
	})

	assert.True(t, state.IsDirty())
	assert.True(t, state.DirtyNoteIDs["note1"])
	assert.True(t, state.DirtyNoteIDs["note3"])
	assert.Equal(t, "2026-01-01T00:00:00Z", state.LastSyncedDriveTs)
	assert.Equal(t, "hash1", state.LastSyncedNoteHash["note1"])
	assert.Equal(t, "hash2", state.LastSyncedNoteHash["note2"])
}

func TestSyncState_UpdateSyncedState_PersistsToDisk(t *testing.T) {
	dir := t.TempDir()
	state := NewSyncState(dir)
	state.MarkNoteDirty("note1")

	state.UpdateSyncedState("2026-02-19T10:00:00Z", map[string]string{
		"note1": "abc",
	})

	state2 := NewSyncState(dir)
	assert.NoError(t, state2.Load())
	assert.Equal(t, "2026-02-19T10:00:00Z", state2.LastSyncedDriveTs)
	assert.Equal(t, "abc", state2.LastSyncedNoteHash["note1"])
}

// ---- FullReuploadPending / HasPendingUploads -----------------------------------
// DeleteAllDriveData + 再ログインで「ノート本体が Drive に上がらず noteList だけ作られる」
// 問題への対策として入れた MarkForFullReupload / ClearFullReupload / HasPendingUploads の挙動を検証する。

func TestSyncState_MarkForFullReupload_SetsFlagAndPopulatesDirtyIDs(t *testing.T) {
	state := NewSyncState(t.TempDir())
	state.UpdateSyncedState("2025-01-01T00:00:00Z", map[string]string{
		"note1": "oldhash1",
		"note2": "oldhash2",
	})

	state.MarkForFullReupload([]string{"note1", "note2", "note3"})

	assert.True(t, state.IsDirty())
	assert.True(t, state.IsFullReuploadPending())
	assert.True(t, state.DirtyNoteIDs["note1"])
	assert.True(t, state.DirtyNoteIDs["note2"])
	assert.True(t, state.DirtyNoteIDs["note3"])
	assert.Len(t, state.DirtyNoteIDs, 3)
	assert.Empty(t, state.LastSyncedDriveTs, "再アップロード前提のため前回同期状態はクリアされる")
	assert.Empty(t, state.LastSyncedNoteHash)
}

func TestSyncState_ClearFullReupload_LeavesDirtyIntact(t *testing.T) {
	state := NewSyncState(t.TempDir())
	state.MarkForFullReupload([]string{"note1", "note2"})

	state.ClearFullReupload()

	assert.False(t, state.IsFullReuploadPending())
	assert.True(t, state.IsDirty(), "dirty フラグ自体は pushLocalChanges 成功まで別途クリア")
	assert.True(t, state.DirtyNoteIDs["note1"])
	assert.True(t, state.DirtyNoteIDs["note2"])
}

func TestSyncState_HasPendingUploads(t *testing.T) {
	t.Run("false when clean", func(t *testing.T) {
		state := NewSyncState(t.TempDir())
		assert.False(t, state.HasPendingUploads())
	})

	t.Run("true when dirty with dirtyIDs (offline-first)", func(t *testing.T) {
		state := NewSyncState(t.TempDir())
		state.MarkNoteDirty("note1")
		assert.True(t, state.HasPendingUploads())
	})

	t.Run("true when FullReuploadPending even if dirtyIDs empty", func(t *testing.T) {
		state := NewSyncState(t.TempDir())
		state.MarkForFullReupload(nil)
		assert.True(t, state.HasPendingUploads())
	})

	t.Run("false when dirty but DirtyNoteIDs empty (e.g. folder-only changes)", func(t *testing.T) {
		state := NewSyncState(t.TempDir())
		state.MarkDirty()
		assert.False(t, state.HasPendingUploads(),
			"dirtyIDs 空なら noteList 先行作成しても個別ノート取りこぼしは起きない")
	})
}

func TestSyncState_FullReuploadPending_PersistsAcrossRestart(t *testing.T) {
	dir := t.TempDir()

	state := NewSyncState(dir)
	state.MarkForFullReupload([]string{"note1", "note2"})

	// 再起動相当: 新しい SyncState を同じディレクトリから load
	reloaded := NewSyncState(dir)
	require.NoError(t, reloaded.Load())

	assert.True(t, reloaded.IsFullReuploadPending(),
		"アプリを途中で終了しても再起動後に再アップロードを継続できる必要がある")
	assert.True(t, reloaded.IsDirty())
	assert.True(t, reloaded.DirtyNoteIDs["note1"])
	assert.True(t, reloaded.DirtyNoteIDs["note2"])
}

func TestSyncState_ClearDirtyIfUnchanged_DoesNotClearFullReuploadPending(t *testing.T) {
	// pushLocalChanges は ClearDirtyIfUnchanged の後に ClearFullReupload を別途呼ぶ設計。
	// ClearDirtyIfUnchanged は FullReuploadPending に触らないことを保証する。
	state := NewSyncState(t.TempDir())
	state.MarkForFullReupload([]string{"note1"})
	_, _, _, _, revision := state.GetDirtySnapshotWithRevision()

	cleared := state.ClearDirtyIfUnchanged(revision, "2026-01-01T00:00:00Z", map[string]string{
		"note1": "hash1",
	})

	assert.True(t, cleared)
	assert.False(t, state.IsDirty())
	assert.True(t, state.IsFullReuploadPending(),
		"pushLocalChanges 側で明示的に ClearFullReupload するまで立ったまま")
}

// ---- UpdateSyncedNoteHash (resume optimization) ----
// 大量アップロード途中の再起動時に、既に上がっているノートを個別にスキップできるよう
// per-note で LastSyncedNoteHash を永続化する仕組みをテストする。

func TestSyncState_UpdateSyncedNoteHash_PersistsSingleEntry(t *testing.T) {
	dir := t.TempDir()
	state := NewSyncState(dir)
	state.MarkNoteDirty("note1")

	state.UpdateSyncedNoteHash("note1", "hash-of-note1")

	assert.Equal(t, "hash-of-note1", state.LastSyncedNoteHash["note1"])

	reloaded := NewSyncState(dir)
	require.NoError(t, reloaded.Load())
	assert.Equal(t, "hash-of-note1", reloaded.LastSyncedNoteHash["note1"],
		"再起動後も永続化された hash が復元される（resume の根幹）")
}

func TestSyncState_UpdateSyncedNoteHash_DoesNotIncrementRevision(t *testing.T) {
	// 進行中の ClearDirtyIfUnchanged(snapshotRevision,...) を破壊してはならない。
	state := NewSyncState(t.TempDir())
	state.MarkNoteDirty("note1")
	_, _, _, _, revisionBefore := state.GetDirtySnapshotWithRevision()

	state.UpdateSyncedNoteHash("note1", "hash1")
	state.UpdateSyncedNoteHash("note2", "hash2")
	state.UpdateSyncedNoteHash("note3", "hash3")

	_, _, _, _, revisionAfter := state.GetDirtySnapshotWithRevision()
	assert.Equal(t, revisionBefore, revisionAfter,
		"UpdateSyncedNoteHash は内部の同期記録なので revision に影響しない")

	// そしてその revision で ClearDirtyIfUnchanged が成功する
	cleared := state.ClearDirtyIfUnchanged(revisionBefore, "2026-01-01T00:00:00Z", map[string]string{
		"note1": "hash1",
	})
	assert.True(t, cleared)
}

func TestSyncState_UpdateSyncedNoteHash_DoesNotAffectDirtyOrDeletedFlags(t *testing.T) {
	state := NewSyncState(t.TempDir())
	state.MarkNoteDirty("note1")
	state.MarkNoteDeleted("note2")
	state.MarkDirty()

	state.UpdateSyncedNoteHash("note1", "h1")

	assert.True(t, state.IsDirty())
	assert.True(t, state.DirtyNoteIDs["note1"], "dirty フラグ自体は残る")
	assert.True(t, state.DeletedNoteIDs["note2"])
}
