package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/api/drive/v3"
)

type syncTestDriveOps struct {
	*mockDriveOperations
	fixedModifiedTime string
}

func (o *syncTestDriveOps) GetFileMetadata(fileID string) (*drive.File, error) {
	f, err := o.mockDriveOperations.GetFileMetadata(fileID)
	if err != nil {
		return nil, err
	}
	if o.fixedModifiedTime != "" {
		f.ModifiedTime = o.fixedModifiedTime
	}
	return f, nil
}

type flakySyncTestDriveOps struct {
	*syncTestDriveOps
	failCreateFor map[string]bool
}

func (o *flakySyncTestDriveOps) CreateFile(name string, content []byte, rootFolderID string, mimeType string) (string, error) {
	if o.failCreateFor != nil && o.failCreateFor[name] {
		return "", fmt.Errorf("simulated create failure for %s", name)
	}
	return o.syncTestDriveOps.CreateFile(name, content, rootFolderID, mimeType)
}

type hookSyncTestDriveOps struct {
	*syncTestDriveOps
	onCreateFile func(name string)
}

func (o *hookSyncTestDriveOps) CreateFile(name string, content []byte, rootFolderID string, mimeType string) (string, error) {
	if o.onCreateFile != nil {
		o.onCreateFile(name)
	}
	return o.syncTestDriveOps.CreateFile(name, content, rootFolderID, mimeType)
}

func rebindDriveServiceOps(ds *driveService, ops DriveOperations) {
	if ds.operationsQueue != nil {
		ds.operationsQueue.Cleanup()
	}
	ds.operationsQueue = NewDriveOperationsQueue(ops)
	ds.driveOps = ds.operationsQueue
	rootID, notesID := ds.auth.GetDriveSync().FolderIDs()
	ds.driveSync = NewDriveSyncService(ds.driveOps, notesID, rootID, ds.logger)
}

func newSyncTestDriveService(t *testing.T) (*driveService, *syncTestDriveOps, func()) {
	t.Helper()

	helper := setupTest(t)
	ctx := context.Background()
	logger := NewAppLogger(ctx, true, helper.tempDir)

	mockOps := newMockDriveOperations()
	ops := &syncTestDriveOps{mockDriveOperations: mockOps}

	auth := &authService{
		ctx:        ctx,
		appDataDir: helper.tempDir,
		isTestMode: true,
		logger:     logger,
	}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	driveSync.SetNoteListID("test-notelist-id")
	driveSync.SetConnected(true)
	auth.driveSync = driveSync

	ds := &driveService{
		ctx:         ctx,
		auth:        auth,
		noteService: helper.noteService,
		logger:      logger,
		driveOps:    ops,
		driveSync:   NewDriveSyncService(ops, "test-folder", "test-root", logger),
		syncState:   NewSyncState(helper.tempDir),
	}
	ds.pollingService = NewDrivePollingService(ctx, ds)
	ds.operationsQueue = NewDriveOperationsQueue(ops)

	cleanup := func() {
		ds.operationsQueue.Cleanup()
		helper.cleanup()
	}

	return ds, ops, cleanup
}

func putCloudNoteList(t *testing.T, ops *syncTestDriveOps, noteListID string, noteList *NoteList) {
	t.Helper()
	data, err := json.Marshal(noteList)
	require.NoError(t, err)
	ops.mu.Lock()
	ops.files[noteListID] = data
	ops.mu.Unlock()
}

func putCloudNote(t *testing.T, ops *syncTestDriveOps, note *Note) {
	t.Helper()
	data, err := json.Marshal(note)
	require.NoError(t, err)
	fileID := fmt.Sprintf("test-file-%s.json", note.ID)
	ops.mu.Lock()
	ops.files[fileID] = data
	ops.mu.Unlock()
}

func cloudNoteListFromMock(t *testing.T, ops *syncTestDriveOps, noteListID string) *NoteList {
	t.Helper()
	ops.mu.RLock()
	data, ok := ops.files[noteListID]
	ops.mu.RUnlock()
	require.True(t, ok)

	var noteList NoteList
	require.NoError(t, json.Unmarshal(data, &noteList))
	return &noteList
}

func mustLoadLocalNote(t *testing.T, ds *driveService, noteID string) *Note {
	t.Helper()
	note, err := ds.noteService.LoadNote(noteID)
	require.NoError(t, err)
	return note
}

func noteListHasNoteID(noteList *NoteList, noteID string) bool {
	for _, n := range noteList.Notes {
		if n.ID == noteID {
			return true
		}
	}
	return false
}

func TestSyncNotes_CaseA_NothingToDo(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	const ts = "2025-01-01T00:00:00Z"
	ops.fixedModifiedTime = ts
	ds.syncState.LastSyncedDriveTs = ts

	noteListID := ds.auth.GetDriveSync().NoteListID()
	putCloudNoteList(t, ops, noteListID, &NoteList{Version: CurrentVersion, Notes: []NoteMetadata{}})

	ops.mu.RLock()
	before := make(map[string][]byte, len(ops.files))
	for k, v := range ops.files {
		copied := make([]byte, len(v))
		copy(copied, v)
		before[k] = copied
	}
	ops.mu.RUnlock()

	err := ds.SyncNotes()
	require.NoError(t, err)

	assert.False(t, ds.syncState.IsDirty())

	ops.mu.RLock()
	after := make(map[string][]byte, len(ops.files))
	for k, v := range ops.files {
		copied := make([]byte, len(v))
		copy(copied, v)
		after[k] = copied
	}
	ops.mu.RUnlock()
	assert.Equal(t, before, after)
}

func TestSyncNotes_CaseA_PushLocalChanges(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	note := &Note{ID: "note1", Title: "note1", Content: "local content", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(note))
	ds.syncState.MarkNoteDirty(note.ID)

	const ts = "2025-01-01T00:00:00Z"
	ops.fixedModifiedTime = ts
	ds.syncState.LastSyncedDriveTs = ts

	noteListID := ds.auth.GetDriveSync().NoteListID()
	putCloudNoteList(t, ops, noteListID, &NoteList{Version: CurrentVersion, Notes: []NoteMetadata{}})

	err := ds.SyncNotes()
	require.NoError(t, err)

	ops.mu.RLock()
	_, noteExists := ops.files["test-file-note1.json"]
	ops.mu.RUnlock()
	assert.True(t, noteExists)

	cloudNoteList := cloudNoteListFromMock(t, ops, noteListID)
	require.Len(t, cloudNoteList.Notes, 1)
	assert.Equal(t, "note1", cloudNoteList.Notes[0].ID)
	assert.False(t, ds.syncState.IsDirty())
	assert.Empty(t, ds.syncState.DirtyNoteIDs)
}

func TestSyncNotes_CaseA_PushLocalChanges_FailedUploadKeepsDirtyAndSkipsNoteListUpdate(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	flakyOps := &flakySyncTestDriveOps{
		syncTestDriveOps: ops,
		failCreateFor: map[string]bool{
			"note1.json": true,
		},
	}
	rebindDriveServiceOps(ds, flakyOps)

	note := &Note{ID: "note1", Title: "note1", Content: "local content", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(note))
	ds.syncState.MarkNoteDirty(note.ID)

	const ts = "2025-01-01T00:00:00Z"
	flakyOps.fixedModifiedTime = ts
	ds.syncState.LastSyncedDriveTs = ts

	noteListID := ds.auth.GetDriveSync().NoteListID()
	putCloudNoteList(t, ops, noteListID, &NoteList{Version: CurrentVersion, Notes: []NoteMetadata{}})

	err := ds.SyncNotes()
	require.NoError(t, err)

	ops.mu.RLock()
	_, noteExists := ops.files["test-file-note1.json"]
	ops.mu.RUnlock()
	assert.False(t, noteExists)

	cloudNoteList := cloudNoteListFromMock(t, ops, noteListID)
	assert.Empty(t, cloudNoteList.Notes, "アップロード失敗時はcloud noteListを更新しない")

	assert.True(t, ds.syncState.IsDirty(), "アップロード失敗時はdirtyを保持する")
	assert.True(t, ds.syncState.DirtyNoteIDs["note1"])
}

func TestSyncNotes_CaseA_PushLocalChanges_RevisionChangedSkipsCloudNoteListUpdate(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	hookOps := &hookSyncTestDriveOps{syncTestDriveOps: ops}
	rebindDriveServiceOps(ds, hookOps)

	note1 := &Note{ID: "note1", Title: "note1", Content: "local content", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(note1))
	ds.syncState.MarkNoteDirty(note1.ID)

	const ts = "2025-01-01T00:00:00Z"
	hookOps.fixedModifiedTime = ts
	ds.syncState.LastSyncedDriveTs = ts

	noteListID := ds.auth.GetDriveSync().NoteListID()
	putCloudNoteList(t, ops, noteListID, &NoteList{Version: CurrentVersion, Notes: []NoteMetadata{}})

	injected := false
	hookOps.onCreateFile = func(name string) {
		if injected || name != "note1.json" {
			return
		}
		injected = true
		note2 := &Note{ID: "note2", Title: "note2", Content: "new during sync", Language: "plaintext"}
		require.NoError(t, ds.noteService.SaveNote(note2))
		ds.syncState.MarkNoteDirty(note2.ID)
	}

	err := ds.SyncNotes()
	require.NoError(t, err)

	ops.mu.RLock()
	_, note1Exists := ops.files["test-file-note1.json"]
	_, note2Exists := ops.files["test-file-note2.json"]
	ops.mu.RUnlock()
	assert.True(t, note1Exists)
	assert.False(t, note2Exists)

	cloudNoteList := cloudNoteListFromMock(t, ops, noteListID)
	assert.Empty(t, cloudNoteList.Notes, "revision変化時はcloud noteList更新を次回同期へ延期する")

	assert.True(t, ds.syncState.IsDirty())
	assert.True(t, ds.syncState.DirtyNoteIDs["note1"])
	assert.True(t, ds.syncState.DirtyNoteIDs["note2"])
}

func TestSyncNotes_CaseA_PushDeletedNotes(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	const noteID = "note2"
	const ts = "2025-01-01T00:00:00Z"
	ops.fixedModifiedTime = ts
	ds.syncState.LastSyncedDriveTs = ts
	ds.syncState.MarkNoteDeleted(noteID)

	cloudNote := &Note{
		ID:           noteID,
		Title:        "cloud note",
		Content:      "cloud content",
		Language:     "plaintext",
		ModifiedTime: ts,
	}
	putCloudNote(t, ops, cloudNote)
	putCloudNoteList(t, ops, ds.auth.GetDriveSync().NoteListID(), &NoteList{
		Version: CurrentVersion,
		Notes: []NoteMetadata{{
			ID:           noteID,
			Title:        cloudNote.Title,
			Language:     cloudNote.Language,
			ModifiedTime: cloudNote.ModifiedTime,
			ContentHash:  computeContentHash(cloudNote),
		}},
	})

	syncImpl := ds.driveSync.(*driveSyncServiceImpl)
	syncImpl.setCachedFileID(noteID, "test-file-note2.json")

	err := ds.SyncNotes()
	require.NoError(t, err)

	ops.mu.RLock()
	_, exists := ops.files["test-file-note2.json"]
	ops.mu.RUnlock()
	assert.False(t, exists)

	cloudNoteList := cloudNoteListFromMock(t, ops, ds.auth.GetDriveSync().NoteListID())
	assert.False(t, noteListHasNoteID(cloudNoteList, noteID))
	assert.False(t, ds.syncState.IsDirty())
}

func TestSyncNotes_CaseB_PullNewNote(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	ops.fixedModifiedTime = "2025-01-02T00:00:00Z"
	ds.syncState.LastSyncedDriveTs = "2025-01-01T00:00:00Z"

	cloudNote := &Note{
		ID:           "cloud-note-1",
		Title:        "cloud",
		Content:      "from cloud",
		Language:     "plaintext",
		ModifiedTime: "2025-01-02T00:00:00Z",
	}
	putCloudNote(t, ops, cloudNote)
	putCloudNoteList(t, ops, ds.auth.GetDriveSync().NoteListID(), &NoteList{
		Version: CurrentVersion,
		Notes: []NoteMetadata{{
			ID:           cloudNote.ID,
			Title:        cloudNote.Title,
			Language:     cloudNote.Language,
			ModifiedTime: cloudNote.ModifiedTime,
			ContentHash:  "abc123",
		}},
	})

	err := ds.SyncNotes()
	require.NoError(t, err)

	loaded := mustLoadLocalNote(t, ds, "cloud-note-1")
	assert.Equal(t, "from cloud", loaded.Content)
	require.Len(t, ds.noteService.noteList.Notes, 1)
	assert.Equal(t, "cloud-note-1", ds.noteService.noteList.Notes[0].ID)
	assert.False(t, ds.syncState.IsDirty())
}

func TestSyncNotes_CaseB_PullMissingCloudNote_RepairsCloudNoteList(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	ops.fixedModifiedTime = "2025-01-02T00:00:00Z"
	ds.syncState.LastSyncedDriveTs = "2025-01-01T00:00:00Z"

	noteListID := ds.auth.GetDriveSync().NoteListID()
	putCloudNoteList(t, ops, noteListID, &NoteList{
		Version: CurrentVersion,
		Notes: []NoteMetadata{{
			ID:           "dangling-note",
			Title:        "dangling",
			Language:     "plaintext",
			ModifiedTime: "2025-01-02T00:00:00Z",
			ContentHash:  "dangling-hash",
		}},
		TopLevelOrder: []TopLevelItem{{Type: "note", ID: "dangling-note"}},
	})

	err := ds.SyncNotes()
	require.NoError(t, err)

	cloudAfter := cloudNoteListFromMock(t, ops, noteListID)
	assert.Empty(t, cloudAfter.Notes)
	assert.Empty(t, cloudAfter.TopLevelOrder)
	assert.Empty(t, ds.noteService.noteList.Notes)
	assert.False(t, ds.syncState.IsDirty())
}

func TestSyncNotes_CaseB_PullUpdatedNote(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	local := &Note{ID: "note1", Title: "note1", Content: "old", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(local))

	ops.fixedModifiedTime = "2025-01-02T00:00:00Z"
	ds.syncState.LastSyncedDriveTs = "2025-01-01T00:00:00Z"

	cloud := &Note{
		ID:           "note1",
		Title:        "note1",
		Content:      "new",
		Language:     "plaintext",
		ModifiedTime: "2025-01-02T00:00:00Z",
	}
	putCloudNote(t, ops, cloud)
	putCloudNoteList(t, ops, ds.auth.GetDriveSync().NoteListID(), &NoteList{
		Version: CurrentVersion,
		Notes: []NoteMetadata{{
			ID:           cloud.ID,
			Title:        cloud.Title,
			Language:     cloud.Language,
			ModifiedTime: cloud.ModifiedTime,
			ContentHash:  "different-hash",
		}},
	})

	err := ds.SyncNotes()
	require.NoError(t, err)

	updated := mustLoadLocalNote(t, ds, "note1")
	assert.Equal(t, "new", updated.Content)
	assert.False(t, ds.syncState.IsDirty())
}

func TestSyncNotes_CaseB_PullDeletedNote(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	require.NoError(t, ds.noteService.SaveNote(&Note{ID: "note1", Title: "note1", Content: "local", Language: "plaintext"}))
	ops.fixedModifiedTime = "2025-01-02T00:00:00Z"
	ds.syncState.LastSyncedDriveTs = "2025-01-01T00:00:00Z"

	putCloudNoteList(t, ops, ds.auth.GetDriveSync().NoteListID(), &NoteList{Version: CurrentVersion, Notes: []NoteMetadata{}})

	err := ds.SyncNotes()
	require.NoError(t, err)

	_, loadErr := ds.noteService.LoadNote("note1")
	assert.Error(t, loadErr)
	assert.Empty(t, ds.noteService.noteList.Notes)
}

func TestSyncNotes_CaseB_StructureOverwrite(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	ds.noteService.noteList.Folders = []Folder{{ID: "f1", Name: "LocalFolder"}}
	ds.noteService.noteList.TopLevelOrder = []TopLevelItem{{Type: "folder", ID: "f1"}}
	require.NoError(t, ds.noteService.saveNoteList())

	ops.fixedModifiedTime = "2025-01-02T00:00:00Z"
	ds.syncState.LastSyncedDriveTs = "2025-01-01T00:00:00Z"

	cloudNoteList := &NoteList{
		Version:       CurrentVersion,
		Notes:         []NoteMetadata{},
		Folders:       []Folder{{ID: "f2", Name: "CloudFolder"}},
		TopLevelOrder: []TopLevelItem{{Type: "folder", ID: "f2"}},
	}
	putCloudNoteList(t, ops, ds.auth.GetDriveSync().NoteListID(), cloudNoteList)

	err := ds.SyncNotes()
	require.NoError(t, err)

	assert.Equal(t, cloudNoteList.Folders, ds.noteService.noteList.Folders)
	assert.Equal(t, cloudNoteList.TopLevelOrder, ds.noteService.noteList.TopLevelOrder)
	assert.False(t, ds.syncState.IsDirty())
}

func TestSyncNotes_CaseC_LocalWins(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	require.NoError(t, ds.noteService.SaveNote(&Note{ID: "note1", Title: "note1", Content: "local-edit", Language: "plaintext"}))
	ds.syncState.MarkNoteDirty("note1")
	ds.syncState.LastSyncedNoteHash["note1"] = "original-hash"
	ops.fixedModifiedTime = "2025-01-02T00:00:00Z"
	ds.syncState.LastSyncedDriveTs = "2025-01-01T00:00:00Z"

	cloudOriginal := &Note{ID: "note1", Title: "note1", Content: "original", Language: "plaintext", ModifiedTime: "2025-01-01T00:00:00Z"}
	putCloudNote(t, ops, cloudOriginal)
	putCloudNoteList(t, ops, ds.auth.GetDriveSync().NoteListID(), &NoteList{
		Version: CurrentVersion,
		Notes: []NoteMetadata{{
			ID:           "note1",
			Title:        "note1",
			Language:     "plaintext",
			ModifiedTime: "2025-01-01T00:00:00Z",
			ContentHash:  "original-hash",
		}},
	})

	err := ds.SyncNotes()
	require.NoError(t, err)

	ops.mu.RLock()
	cloudData := ops.files["test-file-note1.json"]
	ops.mu.RUnlock()
	var uploaded Note
	require.NoError(t, json.Unmarshal(cloudData, &uploaded))
	assert.Equal(t, "local-edit", uploaded.Content)
	assert.False(t, ds.syncState.IsDirty())
}

func TestSyncNotes_CaseC_CloudWins(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	local := &Note{ID: "note1", Title: "note1", Content: "local-edit", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(local))
	require.NoError(t, ds.noteService.SaveNoteFromSync(&Note{
		ID:           "note1",
		Title:        "note1",
		Content:      "local-edit",
		Language:     "plaintext",
		ModifiedTime: "2025-01-01T00:00:00Z",
	}))
	ds.syncState.MarkNoteDirty("note1")
	ds.syncState.LastSyncedNoteHash["note1"] = "original-hash"
	ops.fixedModifiedTime = "2025-01-02T00:00:00Z"
	ds.syncState.LastSyncedDriveTs = "2025-01-01T00:00:00Z"

	cloud := &Note{ID: "note1", Title: "note1", Content: "cloud-edit", Language: "plaintext", ModifiedTime: "2025-01-02T00:00:00Z"}
	putCloudNote(t, ops, cloud)
	putCloudNoteList(t, ops, ds.auth.GetDriveSync().NoteListID(), &NoteList{
		Version: CurrentVersion,
		Notes: []NoteMetadata{{
			ID:           "note1",
			Title:        "note1",
			Language:     "plaintext",
			ModifiedTime: "2025-01-02T00:00:00Z",
			ContentHash:  "different-hash",
		}},
	})

	err := ds.SyncNotes()
	require.NoError(t, err)

	updated := mustLoadLocalNote(t, ds, "note1")
	assert.Equal(t, "cloud-edit", updated.Content)
	assert.False(t, ds.syncState.IsDirty())
}

func TestSyncNotes_CaseC_LocalNewerWins(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	require.NoError(t, ds.noteService.SaveNote(&Note{ID: "note1", Title: "note1", Content: "local-edit", Language: "plaintext"}))
	require.NoError(t, ds.noteService.SaveNoteFromSync(&Note{
		ID:           "note1",
		Title:        "note1",
		Content:      "local-edit",
		Language:     "plaintext",
		ModifiedTime: "2025-01-02T00:00:00Z",
	}))
	ds.syncState.MarkNoteDirty("note1")
	ds.syncState.LastSyncedNoteHash["note1"] = "original-hash"
	ops.fixedModifiedTime = "2025-01-02T00:00:00Z"
	ds.syncState.LastSyncedDriveTs = "2025-01-01T00:00:00Z"

	cloud := &Note{ID: "note1", Title: "note1", Content: "cloud-edit", Language: "plaintext", ModifiedTime: "2025-01-01T00:00:00Z"}
	putCloudNote(t, ops, cloud)
	putCloudNoteList(t, ops, ds.auth.GetDriveSync().NoteListID(), &NoteList{
		Version: CurrentVersion,
		Notes: []NoteMetadata{{
			ID:           "note1",
			Title:        "note1",
			Language:     "plaintext",
			ModifiedTime: "2025-01-01T00:00:00Z",
			ContentHash:  "different-hash",
		}},
	})

	err := ds.SyncNotes()
	require.NoError(t, err)

	ops.mu.RLock()
	cloudData := ops.files["test-file-note1.json"]
	ops.mu.RUnlock()
	var uploaded Note
	require.NoError(t, json.Unmarshal(cloudData, &uploaded))
	assert.Equal(t, "local-edit", uploaded.Content)
	assert.False(t, ds.syncState.IsDirty())
}

func TestSyncNotes_CaseC_DeleteAndEdit(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	ds.syncState.MarkNoteDeleted("note1")
	ops.fixedModifiedTime = "2025-01-02T00:00:00Z"
	ds.syncState.LastSyncedDriveTs = "2025-01-01T00:00:00Z"

	cloud := &Note{ID: "note1", Title: "note1", Content: "cloud-edit", Language: "plaintext", ModifiedTime: "2025-01-02T00:00:00Z"}
	putCloudNote(t, ops, cloud)
	putCloudNoteList(t, ops, ds.auth.GetDriveSync().NoteListID(), &NoteList{
		Version: CurrentVersion,
		Notes: []NoteMetadata{{
			ID:           "note1",
			Title:        "note1",
			Language:     "plaintext",
			ModifiedTime: "2025-01-02T00:00:00Z",
			ContentHash:  computeContentHash(cloud),
		}},
	})

	syncImpl := ds.driveSync.(*driveSyncServiceImpl)
	syncImpl.setCachedFileID("note1", "test-file-note1.json")

	err := ds.SyncNotes()
	require.NoError(t, err)

	ops.mu.RLock()
	_, exists := ops.files["test-file-note1.json"]
	ops.mu.RUnlock()
	assert.False(t, exists)

	assert.Empty(t, ds.noteService.noteList.Notes)
	assert.False(t, ds.syncState.IsDirty())
}

func TestSyncNotes_CaseC_DeleteArchivedFolder_KeepLocalDeletion(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	deletedFolderID := "f-archived-local-deleted"
	cloudKeepFolderID := "f-archived-cloud-keep"
	ds.noteService.noteList.Folders = []Folder{
		{ID: deletedFolderID, Name: "LocalDeleted", Archived: true},
	}
	ds.noteService.noteList.ArchivedTopLevelOrder = []TopLevelItem{
		{Type: "folder", ID: deletedFolderID},
	}
	require.NoError(t, ds.noteService.saveNoteList())

	// ローカルでアーカイブフォルダを削除
	require.NoError(t, ds.noteService.DeleteArchivedFolder(deletedFolderID))
	ds.syncState.MarkFolderDeleted(deletedFolderID)

	ops.fixedModifiedTime = "2025-01-02T00:00:00Z"
	ds.syncState.LastSyncedDriveTs = "2025-01-01T00:00:00Z"

	cloudNoteList := &NoteList{
		Version: CurrentVersion,
		Notes:   []NoteMetadata{},
		Folders: []Folder{
			{ID: deletedFolderID, Name: "CloudStillHasIt", Archived: true},
			{ID: cloudKeepFolderID, Name: "CloudKeep", Archived: true},
		},
		ArchivedTopLevelOrder: []TopLevelItem{
			{Type: "folder", ID: deletedFolderID},
			{Type: "folder", ID: cloudKeepFolderID},
		},
	}
	putCloudNoteList(t, ops, ds.auth.GetDriveSync().NoteListID(), cloudNoteList)

	err := ds.SyncNotes()
	require.NoError(t, err)

	foundDeletedFolder := false
	foundKeepFolder := false
	for _, f := range ds.noteService.noteList.Folders {
		if f.ID == deletedFolderID {
			foundDeletedFolder = true
		}
		if f.ID == cloudKeepFolderID {
			foundKeepFolder = true
		}
	}
	assert.False(t, foundDeletedFolder)
	assert.True(t, foundKeepFolder)

	archivedOrderHasDeleted := false
	for _, item := range ds.noteService.noteList.ArchivedTopLevelOrder {
		if item.Type == "folder" && item.ID == deletedFolderID {
			archivedOrderHasDeleted = true
			break
		}
	}
	assert.False(t, archivedOrderHasDeleted)

	cloudAfter := cloudNoteListFromMock(t, ops, ds.auth.GetDriveSync().NoteListID())
	cloudHasDeleted := false
	for _, f := range cloudAfter.Folders {
		if f.ID == deletedFolderID {
			cloudHasDeleted = true
			break
		}
	}
	assert.False(t, cloudHasDeleted)
	assert.False(t, ds.syncState.IsDirty())
}

func TestSyncNotes_InitialSync_NoCloud(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	n1 := &Note{ID: "note1", Title: "note1", Content: "local1", Language: "plaintext"}
	n2 := &Note{ID: "note2", Title: "note2", Content: "local2", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(n1))
	require.NoError(t, ds.noteService.SaveNote(n2))

	ds.syncState.LastSyncedDriveTs = ""
	ds.auth.GetDriveSync().SetNoteListID("")
	ds.syncState.MarkNoteDirty("note1")
	ds.syncState.MarkNoteDirty("note2")

	err := ds.SyncNotes()
	require.NoError(t, err)

	ops.mu.RLock()
	_, note1Exists := ops.files["test-file-note1.json"]
	_, note2Exists := ops.files["test-file-note2.json"]
	_, noteListExists := ops.files["test-file-noteList_v2.json"]
	ops.mu.RUnlock()
	assert.True(t, note1Exists)
	assert.True(t, note2Exists)
	assert.True(t, noteListExists)
	assert.False(t, ds.syncState.IsDirty())
}

func TestSyncNotes_InitialSync_WithCloud(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	ds.syncState.LastSyncedDriveTs = ""
	ops.fixedModifiedTime = "2025-01-02T00:00:00Z"

	cloud := &Note{ID: "note1", Title: "note1", Content: "cloud", Language: "plaintext", ModifiedTime: "2025-01-02T00:00:00Z"}
	putCloudNote(t, ops, cloud)
	putCloudNoteList(t, ops, ds.auth.GetDriveSync().NoteListID(), &NoteList{
		Version: CurrentVersion,
		Notes: []NoteMetadata{{
			ID:           "note1",
			Title:        "note1",
			Language:     "plaintext",
			ModifiedTime: cloud.ModifiedTime,
			ContentHash:  computeContentHash(cloud),
		}},
	})

	err := ds.SyncNotes()
	require.NoError(t, err)

	loaded := mustLoadLocalNote(t, ds, "note1")
	assert.Equal(t, "cloud", loaded.Content)
	assert.False(t, ds.syncState.IsDirty())
}
