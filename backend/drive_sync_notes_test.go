package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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

type hookDownloadSyncTestDriveOps struct {
	*syncTestDriveOps
	onDownloadFile func(fileID string)
}

func (o *hookDownloadSyncTestDriveOps) DownloadFile(fileID string) ([]byte, error) {
	if o.onDownloadFile != nil {
		o.onDownloadFile(fileID)
	}
	return o.syncTestDriveOps.DownloadFile(fileID)
}

func rebindDriveServiceOps(ds *driveService, ops DriveOperations) {
	if ds.operationsQueue != nil {
		ds.operationsQueue.Cleanup()
	}
	ds.operationsQueue = NewDriveOperationsQueue(ops, nil)
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
		appDataDir:  helper.tempDir,
		logger:      logger,
		driveOps:    ops,
		driveSync:   NewDriveSyncService(ops, "test-folder", "test-root", logger),
		syncState:   NewSyncState(helper.tempDir),
	}
	ds.pollingService = NewDrivePollingService(ctx, ds)
	ds.operationsQueue = NewDriveOperationsQueue(ops, nil)

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

func topLevelNoteIndex(order []TopLevelItem, noteID string) int {
	for i, item := range order {
		if item.Type == "note" && item.ID == noteID {
			return i
		}
	}
	return -1
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

func TestSyncNotes_CaseA_PushLocalChanges_RevisionChangedByNoteListOnlyStillUpdatesCloudNoteList(t *testing.T) {
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
		ds.syncState.MarkDirty()
	}

	err := ds.SyncNotes()
	require.NoError(t, err)

	ops.mu.RLock()
	_, note1Exists := ops.files["test-file-note1.json"]
	ops.mu.RUnlock()
	assert.True(t, note1Exists)

	cloudNoteList := cloudNoteListFromMock(t, ops, noteListID)
	require.Len(t, cloudNoteList.Notes, 1)
	assert.Equal(t, "note1", cloudNoteList.Notes[0].ID)
	assert.False(t, ds.syncState.IsDirty(), "noteList-onlyの更新は同一syncで取り込んでdirtyを解消する")
	assert.Empty(t, ds.syncState.DirtyNoteIDs)
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

func TestSyncNotes_CaseB_PullCloudChanges_LocalChangeDuringPullIsNotDeleted(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	hookOps := &hookDownloadSyncTestDriveOps{syncTestDriveOps: ops}
	rebindDriveServiceOps(ds, hookOps)

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
	noteListID := ds.auth.GetDriveSync().NoteListID()
	putCloudNoteList(t, ops, noteListID, &NoteList{
		Version: CurrentVersion,
		Notes: []NoteMetadata{{
			ID:           cloudNote.ID,
			Title:        cloudNote.Title,
			Language:     cloudNote.Language,
			ModifiedTime: cloudNote.ModifiedTime,
			ContentHash:  "abc123",
		}},
	})

	injected := false
	hookOps.onDownloadFile = func(fileID string) {
		if injected || fileID != "test-file-cloud-note-1.json" {
			return
		}
		injected = true
		note := &Note{ID: "local-new", Title: "local-new", Content: "local", Language: "plaintext"}
		require.NoError(t, ds.noteService.SaveNote(note))
		ds.syncState.MarkNoteDirty(note.ID)
	}

	err := ds.SyncNotes()
	require.NoError(t, err)

	_, loadErr := ds.noteService.LoadNote("local-new")
	require.NoError(t, loadErr, "同期中に作成したローカルノートは削除されてはならない")
	assert.True(t, ds.syncState.IsDirty(), "同期中のローカル変更はdirtyのまま維持されるべき")
	assert.True(t, ds.syncState.DirtyNoteIDs["local-new"])
}

func TestSyncNotes_CaseB_PullCloudChanges_LocalEditDuringPullKeepsEditedContent(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	hookOps := &hookDownloadSyncTestDriveOps{syncTestDriveOps: ops}
	rebindDriveServiceOps(ds, hookOps)

	local := &Note{ID: "note1", Title: "note1", Content: "local-old", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(local))

	ops.fixedModifiedTime = "2025-01-02T00:00:00Z"
	ds.syncState.LastSyncedDriveTs = "2025-01-01T00:00:00Z"

	cloud := &Note{
		ID:           "note1",
		Title:        "note1",
		Content:      "cloud-new",
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

	injected := false
	hookOps.onDownloadFile = func(fileID string) {
		if injected || fileID != "test-file-note1.json" {
			return
		}
		injected = true
		edited := &Note{ID: "note1", Title: "note1", Content: "local-new", Language: "plaintext"}
		require.NoError(t, ds.noteService.SaveNote(edited))
		ds.syncState.MarkNoteDirty(edited.ID)
	}

	err := ds.SyncNotes()
	require.NoError(t, err)

	updated := mustLoadLocalNote(t, ds, "note1")
	assert.Equal(t, "local-new", updated.Content, "同期中に編集した内容はdefer時に上書きされてはならない")
	assert.True(t, ds.syncState.IsDirty())
	assert.True(t, ds.syncState.DirtyNoteIDs["note1"])
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

	backupDir := filepath.Join(ds.appDataDir, cloudWinBackupDirName)
	entries, readErr := os.ReadDir(backupDir)
	require.NoError(t, readErr)
	require.Len(t, entries, 1)

	backupData, readFileErr := os.ReadFile(filepath.Join(backupDir, entries[0].Name()))
	require.NoError(t, readFileErr)

	var backup cloudWinBackupRecord
	require.NoError(t, json.Unmarshal(backupData, &backup))
	assert.Equal(t, "note1", backup.NoteID)
	assert.Equal(t, "cloud-delete-during-pull", backup.Reason)
	require.NotNil(t, backup.LocalNote)
	assert.Equal(t, "local", backup.LocalNote.Content)
	assert.Nil(t, backup.CloudNote)
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

	backupDir := filepath.Join(ds.appDataDir, cloudWinBackupDirName)
	entries, readErr := os.ReadDir(backupDir)
	require.NoError(t, readErr)
	require.Len(t, entries, 1)

	backupData, readFileErr := os.ReadFile(filepath.Join(backupDir, entries[0].Name()))
	require.NoError(t, readFileErr)

	var backup cloudWinBackupRecord
	require.NoError(t, json.Unmarshal(backupData, &backup))
	assert.Equal(t, "note1", backup.NoteID)
	require.NotNil(t, backup.LocalNote)
	assert.Equal(t, "local-edit", backup.LocalNote.Content)
	require.NotNil(t, backup.CloudNote)
	assert.Equal(t, "cloud-edit", backup.CloudNote.Content)
}

func TestSyncNotes_CaseC_CloudWins_BackupDisabled(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	settingsPath := filepath.Join(ds.appDataDir, "settings.json")
	require.NoError(t, os.WriteFile(settingsPath, []byte(`{"enableConflictBackup": false}`), 0644))

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

	backupDir := filepath.Join(ds.appDataDir, cloudWinBackupDirName)
	entries, readErr := os.ReadDir(backupDir)
	if os.IsNotExist(readErr) {
		return
	}
	require.NoError(t, readErr)
	assert.Len(t, entries, 0)
}

func TestBackupLocalNoteBeforeCloudOverride_PrunesTo100Files(t *testing.T) {
	tempDir := t.TempDir()
	ds := &driveService{appDataDir: tempDir}

	for i := 0; i < maxCloudWinBackupFiles+5; i++ {
		id := fmt.Sprintf("note-%03d", i)
		local := &Note{
			ID:           id,
			Title:        id,
			Content:      "local",
			Language:     "plaintext",
			ModifiedTime: "2025-01-01T00:00:00Z",
		}
		cloudMeta := NoteMetadata{
			ID:           id,
			Title:        id,
			Language:     "plaintext",
			ModifiedTime: "2025-01-02T00:00:00Z",
		}
		cloudNote := &Note{
			ID:           id,
			Title:        id,
			Content:      "cloud",
			Language:     "plaintext",
			ModifiedTime: "2025-01-02T00:00:00Z",
		}

		_, err := ds.backupLocalNoteBeforeCloudOverride(local, cloudMeta, cloudNote)
		require.NoError(t, err)
	}

	entries, err := os.ReadDir(filepath.Join(tempDir, cloudWinBackupDirName))
	require.NoError(t, err)

	backupCount := 0
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if strings.HasPrefix(name, "cloud_wins_") && strings.HasSuffix(name, ".json") {
			backupCount++
		}
	}

	assert.Equal(t, maxCloudWinBackupFiles, backupCount)
}

func TestSyncNotes_CaseC_Conflict_LocalChangeDuringResolveIsNotDeleted(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	hookOps := &hookDownloadSyncTestDriveOps{syncTestDriveOps: ops}
	rebindDriveServiceOps(ds, hookOps)

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

	injected := false
	hookOps.onDownloadFile = func(fileID string) {
		if injected || fileID != "test-file-note1.json" {
			return
		}
		injected = true
		note := &Note{ID: "local-new", Title: "local-new", Content: "local", Language: "plaintext"}
		require.NoError(t, ds.noteService.SaveNote(note))
		ds.syncState.MarkNoteDirty(note.ID)
	}

	err := ds.SyncNotes()
	require.NoError(t, err)

	_, loadErr := ds.noteService.LoadNote("local-new")
	require.NoError(t, loadErr, "競合解決中に作成したローカルノートは削除されてはならない")
	assert.True(t, ds.syncState.IsDirty())
	assert.True(t, ds.syncState.DirtyNoteIDs["local-new"])
}

func TestSyncNotes_CaseC_Conflict_LocalEditDuringCloudDownloadKeepsEditedContent(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	hookOps := &hookDownloadSyncTestDriveOps{syncTestDriveOps: ops}
	rebindDriveServiceOps(ds, hookOps)

	// dirty note: cloud側は未変更扱いになり、先にアップロードされる
	dirtyLocal := &Note{ID: "note1", Title: "note1", Content: "local-note1", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(dirtyLocal))
	ds.syncState.MarkNoteDirty(dirtyLocal.ID)
	ds.syncState.LastSyncedNoteHash[dirtyLocal.ID] = "note1-last-hash"

	// non-dirty note: cloud側変更としてダウンロード対象になる
	otherLocal := &Note{ID: "note2", Title: "note2", Content: "local-note2-old", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(otherLocal))

	ops.fixedModifiedTime = "2025-01-02T00:00:00Z"
	ds.syncState.LastSyncedDriveTs = "2025-01-01T00:00:00Z"

	putCloudNote(t, ops, &Note{
		ID:           "note1",
		Title:        "note1",
		Content:      "cloud-note1",
		Language:     "plaintext",
		ModifiedTime: "2025-01-01T00:00:00Z",
	})
	putCloudNote(t, ops, &Note{
		ID:           "note2",
		Title:        "note2",
		Content:      "cloud-note2",
		Language:     "plaintext",
		ModifiedTime: "2025-01-02T00:00:00Z",
	})
	putCloudNoteList(t, ops, ds.auth.GetDriveSync().NoteListID(), &NoteList{
		Version: CurrentVersion,
		Notes: []NoteMetadata{
			{
				ID:           "note1",
				Title:        "note1",
				Language:     "plaintext",
				ModifiedTime: "2025-01-01T00:00:00Z",
				ContentHash:  "note1-last-hash",
			},
			{
				ID:           "note2",
				Title:        "note2",
				Language:     "plaintext",
				ModifiedTime: "2025-01-02T00:00:00Z",
				ContentHash:  "note2-cloud-hash",
			},
		},
	})

	injected := false
	hookOps.onDownloadFile = func(fileID string) {
		if injected || fileID != "test-file-note2.json" {
			return
		}
		injected = true
		edited := &Note{ID: "note2", Title: "note2", Content: "local-note2-new", Language: "plaintext"}
		require.NoError(t, ds.noteService.SaveNote(edited))
		ds.syncState.MarkNoteDirty(edited.ID)
	}

	err := ds.SyncNotes()
	require.NoError(t, err)

	updated := mustLoadLocalNote(t, ds, "note2")
	assert.Equal(t, "local-note2-new", updated.Content, "競合解決中に編集した内容はdefer時に上書きされてはならない")
	assert.True(t, ds.syncState.IsDirty())
	assert.True(t, ds.syncState.DirtyNoteIDs["note2"])
}

func TestSyncNotes_CaseC_Conflict_RevisionChangedByNoteListOnlyStillCompletesMerge(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	hookOps := &hookSyncTestDriveOps{syncTestDriveOps: ops}
	rebindDriveServiceOps(ds, hookOps)

	note1 := &Note{ID: "note1", Title: "note1", Content: "local-edit", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(note1))
	ds.syncState.MarkNoteDirty("note1")
	ds.syncState.LastSyncedNoteHash["note1"] = "original-hash"
	hookOps.fixedModifiedTime = "2025-01-02T00:00:00Z"
	ds.syncState.LastSyncedDriveTs = "2025-01-01T00:00:00Z"

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

	injected := false
	hookOps.onCreateFile = func(name string) {
		if injected || name != "note1.json" {
			return
		}
		injected = true
		ds.syncState.MarkDirty()
	}

	err := ds.SyncNotes()
	require.NoError(t, err)

	ops.mu.RLock()
	_, note1Exists := ops.files["test-file-note1.json"]
	ops.mu.RUnlock()
	assert.True(t, note1Exists)

	cloudNoteList := cloudNoteListFromMock(t, ops, ds.auth.GetDriveSync().NoteListID())
	require.Len(t, cloudNoteList.Notes, 1)
	assert.Equal(t, "note1", cloudNoteList.Notes[0].ID)
	assert.False(t, ds.syncState.IsDirty(), "noteList-onlyの更新は競合解決中でも同一syncで取り込む")
	assert.Empty(t, ds.syncState.DirtyNoteIDs)
}

func TestSyncNotes_CaseC_Conflict_NoteListDirty_CloudUpdateApplied(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	local := &Note{ID: "note1", Title: "note1", Content: "local-old", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(local))

	ds.syncState.MarkDirty()
	ops.fixedModifiedTime = "2025-01-02T00:00:00Z"
	ds.syncState.LastSyncedDriveTs = "2025-01-01T00:00:00Z"

	cloud := &Note{
		ID:           "note1",
		Title:        "note1",
		Content:      "cloud-new",
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
			ContentHash:  computeContentHash(cloud),
		}},
		TopLevelOrder: []TopLevelItem{{Type: "note", ID: cloud.ID}},
	})

	err := ds.SyncNotes()
	require.NoError(t, err)

	updated := mustLoadLocalNote(t, ds, cloud.ID)
	assert.Equal(t, "cloud-new", updated.Content)
	assert.False(t, ds.syncState.IsDirty())
}

func TestSyncNotes_CaseC_Conflict_NoteListDirty_CloudNewNoteAdded(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	local := &Note{ID: "local-note", Title: "local-note", Content: "local", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(local))

	ds.syncState.MarkDirty()
	ops.fixedModifiedTime = "2025-01-02T00:00:00Z"
	ds.syncState.LastSyncedDriveTs = "2025-01-01T00:00:00Z"

	cloudNew := &Note{
		ID:           "cloud-note",
		Title:        "cloud-note",
		Content:      "from-cloud",
		Language:     "plaintext",
		ModifiedTime: "2025-01-02T00:00:00Z",
	}
	putCloudNote(t, ops, cloudNew)
	putCloudNoteList(t, ops, ds.auth.GetDriveSync().NoteListID(), &NoteList{
		Version: CurrentVersion,
		Notes: []NoteMetadata{
			{
				ID:           local.ID,
				Title:        local.Title,
				Language:     local.Language,
				ModifiedTime: local.ModifiedTime,
				ContentHash:  computeContentHash(local),
			},
			{
				ID:           cloudNew.ID,
				Title:        cloudNew.Title,
				Language:     cloudNew.Language,
				ModifiedTime: cloudNew.ModifiedTime,
				ContentHash:  computeContentHash(cloudNew),
			},
		},
		TopLevelOrder: []TopLevelItem{
			{Type: "note", ID: local.ID},
			{Type: "note", ID: cloudNew.ID},
		},
	})

	err := ds.SyncNotes()
	require.NoError(t, err)

	downloaded := mustLoadLocalNote(t, ds, cloudNew.ID)
	assert.Equal(t, "from-cloud", downloaded.Content)
	assert.True(t, noteListHasNoteID(ds.noteService.noteList, cloudNew.ID))
	assert.False(t, ds.syncState.IsDirty())
}

func TestSyncNotes_CaseC_Conflict_LocalTopLevelOrderWins(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	note1 := &Note{ID: "note1", Title: "note1", Content: "local-1", Language: "plaintext"}
	note2 := &Note{ID: "note2", Title: "note2", Content: "local-2", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(note1))
	require.NoError(t, ds.noteService.SaveNote(note2))

	localOrder := []TopLevelItem{
		{Type: "note", ID: note1.ID},
		{Type: "note", ID: note2.ID},
	}
	require.NoError(t, ds.noteService.UpdateTopLevelOrder(localOrder))
	ds.syncState.MarkDirty()

	ops.fixedModifiedTime = "2025-01-02T00:00:00Z"
	ds.syncState.LastSyncedDriveTs = "2025-01-01T00:00:00Z"

	cloudNotes := append([]NoteMetadata(nil), ds.noteService.noteList.Notes...)
	putCloudNoteList(t, ops, ds.auth.GetDriveSync().NoteListID(), &NoteList{
		Version: CurrentVersion,
		Notes:   cloudNotes,
		TopLevelOrder: []TopLevelItem{
			{Type: "note", ID: note2.ID},
			{Type: "note", ID: note1.ID},
		},
	})

	err := ds.SyncNotes()
	require.NoError(t, err)

	assert.Equal(t, localOrder, ds.noteService.noteList.TopLevelOrder)
	assert.False(t, ds.syncState.IsDirty())

	cloudAfter := cloudNoteListFromMock(t, ops, ds.auth.GetDriveSync().NoteListID())
	assert.Equal(t, localOrder, cloudAfter.TopLevelOrder)
}

func TestSyncNotes_CaseC_Conflict_LocalFolderMoveWins(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	note := &Note{ID: "note1", Title: "note1", Content: "local", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(note))

	folder, err := ds.noteService.CreateFolder("LocalFolder")
	require.NoError(t, err)
	require.NoError(t, ds.noteService.MoveNoteToFolder(note.ID, folder.ID))
	ds.syncState.MarkDirty()

	ops.fixedModifiedTime = "2025-01-02T00:00:00Z"
	ds.syncState.LastSyncedDriveTs = "2025-01-01T00:00:00Z"

	putCloudNote(t, ops, note)
	putCloudNoteList(t, ops, ds.auth.GetDriveSync().NoteListID(), &NoteList{
		Version: CurrentVersion,
		Notes: []NoteMetadata{
			{
				ID:           note.ID,
				Title:        note.Title,
				Language:     note.Language,
				ModifiedTime: note.ModifiedTime,
				ContentHash:  computeContentHash(note),
				FolderID:     "",
			},
		},
		TopLevelOrder: []TopLevelItem{{Type: "note", ID: note.ID}},
	})

	err = ds.SyncNotes()
	require.NoError(t, err)

	require.Len(t, ds.noteService.noteList.Folders, 1)
	assert.Equal(t, folder.ID, ds.noteService.noteList.Folders[0].ID)
	assert.Equal(t, []TopLevelItem{{Type: "folder", ID: folder.ID}}, ds.noteService.noteList.TopLevelOrder)

	var movedMeta *NoteMetadata
	for i := range ds.noteService.noteList.Notes {
		if ds.noteService.noteList.Notes[i].ID == note.ID {
			movedMeta = &ds.noteService.noteList.Notes[i]
			break
		}
	}
	require.NotNil(t, movedMeta)
	assert.Equal(t, folder.ID, movedMeta.FolderID)
	assert.False(t, ds.syncState.IsDirty())

	cloudAfter := cloudNoteListFromMock(t, ops, ds.auth.GetDriveSync().NoteListID())
	require.Len(t, cloudAfter.Folders, 1)
	assert.Equal(t, folder.ID, cloudAfter.Folders[0].ID)
	require.Len(t, cloudAfter.Notes, 1)
	assert.Equal(t, folder.ID, cloudAfter.Notes[0].FolderID)
	assert.Equal(t, []TopLevelItem{{Type: "folder", ID: folder.ID}}, cloudAfter.TopLevelOrder)
}

func TestSyncNotes_CaseC_Conflict_LocalNewNoteUploadFailureKeepsMetadata(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	flakyOps := &flakySyncTestDriveOps{
		syncTestDriveOps: ops,
		failCreateFor: map[string]bool{
			"local-new.json": true,
		},
	}
	rebindDriveServiceOps(ds, flakyOps)

	localNew := &Note{ID: "local-new", Title: "local-new", Content: "local", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(localNew))
	ds.syncState.MarkNoteDirty(localNew.ID)

	flakyOps.fixedModifiedTime = "2025-01-02T00:00:00Z"
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
			ContentHash:  computeContentHash(cloudNote),
		}},
		TopLevelOrder: []TopLevelItem{{Type: "note", ID: cloudNote.ID}},
	})

	err := ds.SyncNotes()
	require.NoError(t, err)

	_, loadErr := ds.noteService.LoadNote(localNew.ID)
	require.NoError(t, loadErr)

	assert.True(t, noteListHasNoteID(ds.noteService.noteList, localNew.ID), "アップロード失敗時もローカル新規ノートのメタデータは保持する")
	assert.True(t, ds.syncState.IsDirty())
	assert.True(t, ds.syncState.DirtyNoteIDs[localNew.ID])
	assert.Equal(t, 0, topLevelNoteIndex(ds.noteService.noteList.TopLevelOrder, localNew.ID), "アップロード失敗時もローカル新規ノートの表示順は先頭を維持する")
	assert.Equal(t, 1, topLevelNoteIndex(ds.noteService.noteList.TopLevelOrder, cloudNote.ID))
}

func TestSyncNotes_CaseC_Conflict_LocalNewNoteKeepsTopLevelPositionAfterUpload(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	localNew := &Note{ID: "local-new", Title: "local-new", Content: "local", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(localNew))
	ds.syncState.MarkNoteDirty(localNew.ID)

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
			ContentHash:  computeContentHash(cloudNote),
		}},
		TopLevelOrder: []TopLevelItem{{Type: "note", ID: cloudNote.ID}},
	})

	err := ds.SyncNotes()
	require.NoError(t, err)

	assert.True(t, noteListHasNoteID(ds.noteService.noteList, localNew.ID))
	assert.False(t, ds.syncState.IsDirty())
	assert.Equal(t, 0, topLevelNoteIndex(ds.noteService.noteList.TopLevelOrder, localNew.ID), "競合解決後もローカル新規ノートは先頭を維持する")
	assert.Equal(t, 1, topLevelNoteIndex(ds.noteService.noteList.TopLevelOrder, cloudNote.ID))
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

func TestSyncNotes_CaseC_CloudDeletionBacksUpLocalNote(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	require.NoError(t, ds.noteService.SaveNote(&Note{ID: "local-delete", Title: "local-delete", Content: "local-delete-content", Language: "plaintext"}))
	require.NoError(t, ds.noteService.SaveNote(&Note{ID: "note1", Title: "note1", Content: "local-edit", Language: "plaintext"}))
	ds.syncState.MarkNoteDirty("note1")
	ds.syncState.LastSyncedNoteHash["note1"] = "original-hash"
	ops.fixedModifiedTime = "2025-01-02T00:00:00Z"
	ds.syncState.LastSyncedDriveTs = "2025-01-01T00:00:00Z"

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

	_, loadErr := ds.noteService.LoadNote("local-delete")
	assert.Error(t, loadErr)
	assert.False(t, noteListHasNoteID(ds.noteService.noteList, "local-delete"))

	backupDir := filepath.Join(ds.appDataDir, cloudWinBackupDirName)
	entries, readErr := os.ReadDir(backupDir)
	require.NoError(t, readErr)
	require.NotEmpty(t, entries)

	found := false
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(backupDir, entry.Name()))
		require.NoError(t, err)
		var backup cloudWinBackupRecord
		require.NoError(t, json.Unmarshal(data, &backup))
		if backup.NoteID == "local-delete" {
			found = true
			assert.Equal(t, "cloud-delete-during-conflict-merge", backup.Reason)
			require.NotNil(t, backup.LocalNote)
			assert.Equal(t, "local-delete-content", backup.LocalNote.Content)
			assert.Nil(t, backup.CloudNote)
			break
		}
	}
	assert.True(t, found, "deleted local note should be backed up during conflict merge")
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

func TestSyncNotes_DriveSyncNil_ReturnsErrorInsteadOfPanic(t *testing.T) {
	ds, _, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	ds.driveSync = nil

	assert.True(t, ds.IsConnected())

	err := ds.SyncNotes()
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not yet initialized")
}
