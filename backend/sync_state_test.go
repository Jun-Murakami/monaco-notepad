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
