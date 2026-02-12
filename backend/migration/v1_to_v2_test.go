package migration

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMigration_V1ToV2_Basic(t *testing.T) {
	tempDir := t.TempDir()
	v1Path := filepath.Join(tempDir, "noteList.json")
	v2Path := filepath.Join(tempDir, "noteList_v2.json")

	v1 := v1NoteList{
		Version: "1.0",
		Notes: []v1NoteMetadata{
			{ID: "n2", Title: "Note 2", ContentHeader: "h2", Language: "markdown", ModifiedTime: "2026-01-01T00:00:00Z", Archived: false, ContentHash: "hash2", Order: 2},
			{ID: "n0", Title: "Note 0", ContentHeader: "h0", Language: "markdown", ModifiedTime: "2026-01-01T00:00:00Z", Archived: false, ContentHash: "hash0", Order: 0},
			{ID: "n1", Title: "Note 1", ContentHeader: "h1", Language: "markdown", ModifiedTime: "2026-01-01T00:00:00Z", Archived: true, ContentHash: "hash1", Order: 1},
		},
		LastSync:         time.Now(),
		LastSyncClientID: "client-a",
	}
	writeV1NoteList(t, v1Path, v1)

	err := migrateV1ToV2(v1Path, v2Path)
	require.NoError(t, err)

	_, err = os.Stat(v2Path)
	require.NoError(t, err)

	v2Data, err := os.ReadFile(v2Path)
	require.NoError(t, err)

	var v2 v2NoteList
	err = json.Unmarshal(v2Data, &v2)
	require.NoError(t, err)

	assert.Equal(t, "2.0", v2.Version)
	require.Len(t, v2.Notes, 3)
	assert.Equal(t, "n0", v2.Notes[0].ID)
	assert.Equal(t, "n1", v2.Notes[1].ID)
	assert.Equal(t, "n2", v2.Notes[2].ID)

	var raw map[string]any
	err = json.Unmarshal(v2Data, &raw)
	require.NoError(t, err)

	assert.NotContains(t, raw, "lastSync")
	assert.NotContains(t, raw, "lastSyncClientId")

	rawNotes, ok := raw["notes"].([]any)
	require.True(t, ok)
	for _, rawNote := range rawNotes {
		noteMap, castOK := rawNote.(map[string]any)
		require.True(t, castOK)
		assert.NotContains(t, noteMap, "order")
	}
}

func TestMigration_V1ToV2_EmptyNoteList(t *testing.T) {
	tempDir := t.TempDir()
	v1Path := filepath.Join(tempDir, "noteList.json")
	v2Path := filepath.Join(tempDir, "noteList_v2.json")

	v1 := v1NoteList{Version: "1.0", Notes: []v1NoteMetadata{}, LastSync: time.Now()}
	writeV1NoteList(t, v1Path, v1)

	err := migrateV1ToV2(v1Path, v2Path)
	require.NoError(t, err)

	var v2 v2NoteList
	data := readJSONFile(t, v2Path)
	err = json.Unmarshal(data, &v2)
	require.NoError(t, err)

	assert.Equal(t, "2.0", v2.Version)
	require.NotNil(t, v2.Notes)
	assert.Len(t, v2.Notes, 0)
}

func TestMigration_V1ToV2_WithFolders(t *testing.T) {
	tempDir := t.TempDir()
	v1Path := filepath.Join(tempDir, "noteList.json")
	v2Path := filepath.Join(tempDir, "noteList_v2.json")

	v1 := v1NoteList{
		Version: "1.0",
		Notes: []v1NoteMetadata{
			{ID: "n1", Title: "Note 1", ContentHeader: "h", Language: "markdown", ModifiedTime: "2026-01-01T00:00:00Z", Archived: false, ContentHash: "hash1", Order: 0, FolderID: "f1"},
		},
		Folders: []v1Folder{
			{ID: "f1", Name: "Folder 1", Archived: false},
			{ID: "f2", Name: "Archived Folder", Archived: true},
		},
		TopLevelOrder: []v1TopLevelItem{
			{Type: "folder", ID: "f1"},
			{Type: "note", ID: "n1"},
		},
		ArchivedTopLevelOrder: []v1TopLevelItem{{Type: "folder", ID: "f2"}},
		CollapsedFolderIDs:    []string{"f1"},
		LastSync:              time.Now(),
	}
	writeV1NoteList(t, v1Path, v1)

	err := migrateV1ToV2(v1Path, v2Path)
	require.NoError(t, err)

	var v2 v2NoteList
	data := readJSONFile(t, v2Path)
	err = json.Unmarshal(data, &v2)
	require.NoError(t, err)

	require.Len(t, v2.Folders, 2)
	assert.Equal(t, "f1", v2.Folders[0].ID)
	assert.Equal(t, "Folder 1", v2.Folders[0].Name)
	assert.False(t, v2.Folders[0].Archived)
	assert.Equal(t, "f2", v2.Folders[1].ID)
	assert.True(t, v2.Folders[1].Archived)

	require.Len(t, v2.TopLevelOrder, 2)
	assert.Equal(t, "folder", v2.TopLevelOrder[0].Type)
	assert.Equal(t, "f1", v2.TopLevelOrder[0].ID)
	assert.Equal(t, "note", v2.TopLevelOrder[1].Type)
	assert.Equal(t, "n1", v2.TopLevelOrder[1].ID)

	require.Len(t, v2.ArchivedTopLevelOrder, 1)
	assert.Equal(t, "folder", v2.ArchivedTopLevelOrder[0].Type)
	assert.Equal(t, "f2", v2.ArchivedTopLevelOrder[0].ID)

	assert.Equal(t, []string{"f1"}, v2.CollapsedFolderIDs)
}

func TestMigration_Snapshot_Created(t *testing.T) {
	tempDir := t.TempDir()
	v1Path := filepath.Join(tempDir, "noteList.json")
	v2Path := filepath.Join(tempDir, "noteList_v2.json")

	v1 := v1NoteList{
		Version:  "1.0",
		Notes:    []v1NoteMetadata{{ID: "n1", Title: "t", ContentHeader: "h", Language: "markdown", ModifiedTime: "2026-01-01T00:00:00Z", ContentHash: "hash", Order: 0}},
		LastSync: time.Now(),
	}
	writeV1NoteList(t, v1Path, v1)

	err := migrateV1ToV2(v1Path, v2Path)
	require.NoError(t, err)

	snapshotPathPattern := filepath.Join(tempDir, snapshotDir, "noteList_v1_*.json")
	matches, err := filepath.Glob(snapshotPathPattern)
	require.NoError(t, err)
	assert.NotEmpty(t, matches)
}

func TestMigration_RunIfNeeded_AlreadyMigrated(t *testing.T) {
	tempDir := t.TempDir()
	notesDir := filepath.Join(tempDir, "notes")
	require.NoError(t, os.MkdirAll(notesDir, 0o755))

	v1Path := filepath.Join(tempDir, "noteList.json")
	v2Path := filepath.Join(tempDir, "noteList_v2.json")

	v1 := v1NoteList{
		Version:  "1.0",
		Notes:    []v1NoteMetadata{{ID: "n1", Title: "old", ContentHeader: "h", Language: "markdown", ModifiedTime: "2026-01-01T00:00:00Z", ContentHash: "old-hash", Order: 0}},
		LastSync: time.Now(),
	}
	writeV1NoteList(t, v1Path, v1)

	originalV2 := `{"version":"2.0","notes":[{"id":"keep","title":"keep","contentHeader":"h","language":"markdown","modifiedTime":"2026-01-01T00:00:00Z","archived":false,"contentHash":"keep-hash"}]}`
	require.NoError(t, os.WriteFile(v2Path, []byte(originalV2), 0o644))

	err := RunIfNeeded(tempDir, notesDir)
	require.NoError(t, err)

	after := readJSONFile(t, v2Path)
	assert.JSONEq(t, originalV2, string(after))
}

func TestMigration_RunIfNeeded_FreshInstall(t *testing.T) {
	tempDir := t.TempDir()
	notesDir := filepath.Join(tempDir, "notes")
	require.NoError(t, os.MkdirAll(notesDir, 0o755))

	err := RunIfNeeded(tempDir, notesDir)
	require.NoError(t, err)

	_, err = os.Stat(filepath.Join(tempDir, "noteList_v2.json"))
	assert.True(t, os.IsNotExist(err))

	_, err = os.Stat(filepath.Join(tempDir, snapshotDir))
	assert.True(t, os.IsNotExist(err))
}

func TestMigration_RunIfNeeded_V1Exists(t *testing.T) {
	tempDir := t.TempDir()
	notesDir := filepath.Join(tempDir, "notes")
	require.NoError(t, os.MkdirAll(notesDir, 0o755))

	v1Path := filepath.Join(tempDir, "noteList.json")
	v1 := v1NoteList{
		Version: "1.0",
		Notes: []v1NoteMetadata{
			{ID: "n2", Title: "b", ContentHeader: "h", Language: "markdown", ModifiedTime: "2026-01-01T00:00:00Z", ContentHash: "h2", Order: 2},
			{ID: "n1", Title: "a", ContentHeader: "h", Language: "markdown", ModifiedTime: "2026-01-01T00:00:00Z", ContentHash: "h1", Order: 1},
		},
		LastSync: time.Now(),
	}
	writeV1NoteList(t, v1Path, v1)

	err := RunIfNeeded(tempDir, notesDir)
	require.NoError(t, err)

	v2Path := filepath.Join(tempDir, "noteList_v2.json")
	_, err = os.Stat(v2Path)
	require.NoError(t, err)

	snapshotPathPattern := filepath.Join(tempDir, snapshotDir, "noteList_v1_*.json")
	matches, err := filepath.Glob(snapshotPathPattern)
	require.NoError(t, err)
	assert.NotEmpty(t, matches)
}

func writeV1NoteList(t *testing.T, path string, v1 v1NoteList) {
	t.Helper()
	data, err := json.MarshalIndent(v1, "", "  ")
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(path, data, 0o644))
}

func readJSONFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	return data
}
