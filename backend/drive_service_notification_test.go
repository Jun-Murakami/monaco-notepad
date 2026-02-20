package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type notificationRecorder struct {
	AppLogger

	mu                   sync.Mutex
	driveStatusCalls     []string
	infoCalls            []string
	errorCalls           []string
	errorWithNotifyCalls []string
	consoleCalls         []string
	syncedAndReloadCalls int
}

func newNotificationRecorder(ctx context.Context, tempDir string) *notificationRecorder {
	base := NewAppLogger(ctx, true, tempDir)
	return &notificationRecorder{AppLogger: base}
}

func (r *notificationRecorder) NotifyDriveStatus(ctx context.Context, status string) {
	r.mu.Lock()
	r.driveStatusCalls = append(r.driveStatusCalls, status)
	r.mu.Unlock()
	r.AppLogger.NotifyDriveStatus(ctx, status)
}

func (r *notificationRecorder) NotifyFrontendSyncedAndReload(ctx context.Context) {
	r.mu.Lock()
	r.syncedAndReloadCalls++
	r.mu.Unlock()
	r.AppLogger.NotifyFrontendSyncedAndReload(ctx)
}

func (r *notificationRecorder) Info(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	r.mu.Lock()
	r.infoCalls = append(r.infoCalls, msg)
	r.mu.Unlock()
	r.AppLogger.Info(format, args...)
}

func (r *notificationRecorder) InfoCode(code string, args map[string]interface{}) {
	msg := code
	switch code {
	case MsgDriveUploading:
		msg = fmt.Sprintf("Drive: uploading \"%v\"", args["noteTitle"])
	case MsgDriveUploaded:
		msg = fmt.Sprintf("Drive: uploaded \"%v\"", args["noteId"])
	case MsgDriveUpdating:
		msg = fmt.Sprintf("Drive: updating \"%v\"", args["noteId"])
	case MsgDriveUpdated:
		msg = fmt.Sprintf("Drive: updated \"%v\"", args["noteId"])
	case MsgDriveDeletingNote:
		msg = fmt.Sprintf("Drive: deleting note %v", args["noteId"])
	case MsgDriveDeletedNote:
		msg = "Drive: deleted note from cloud"
	case MsgSystemIntegrityAutoRepaired:
		msg = fmt.Sprintf("Integrity check: auto-repaired local data (%v change(s))", args["count"])
	}
	r.mu.Lock()
	r.infoCalls = append(r.infoCalls, msg)
	r.mu.Unlock()
	r.AppLogger.InfoCode(code, args)
}

func (r *notificationRecorder) Error(err error, format string, args ...interface{}) error {
	if err != nil {
		msg := fmt.Sprintf(format, args...)
		r.mu.Lock()
		r.errorCalls = append(r.errorCalls, fmt.Sprintf("%s: %v", msg, err))
		r.mu.Unlock()
	}
	return r.AppLogger.Error(err, format, args...)
}

func (r *notificationRecorder) ErrorWithNotify(err error, format string, args ...interface{}) error {
	if err != nil {
		msg := fmt.Sprintf(format, args...)
		r.mu.Lock()
		r.errorWithNotifyCalls = append(r.errorWithNotifyCalls, fmt.Sprintf("%s: %v", msg, err))
		r.mu.Unlock()
	}
	return r.AppLogger.ErrorWithNotify(err, format, args...)
}

func (r *notificationRecorder) Console(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	r.mu.Lock()
	r.consoleCalls = append(r.consoleCalls, msg)
	r.mu.Unlock()
	r.AppLogger.Console(format, args...)
}

func (r *notificationRecorder) AssertDriveStatusSequence(t *testing.T, expected []string) {
	t.Helper()
	r.mu.Lock()
	actual := append([]string(nil), r.driveStatusCalls...)
	r.mu.Unlock()
	assert.Equal(t, expected, actual)
}

func (r *notificationRecorder) AssertInfoContains(t *testing.T, substr string) {
	t.Helper()
	r.mu.Lock()
	actual := append([]string(nil), r.infoCalls...)
	r.mu.Unlock()
	for _, msg := range actual {
		if strings.Contains(msg, substr) {
			return
		}
	}
	assert.Failf(t, "expected info log not found", "substring %q not found in info logs: %v", substr, actual)
}

func (r *notificationRecorder) AssertNoSyncedAfterError(t *testing.T) {
	t.Helper()
	r.mu.Lock()
	statuses := append([]string(nil), r.driveStatusCalls...)
	r.mu.Unlock()

	lastSyncing := -1
	for i, status := range statuses {
		if status == "syncing" {
			lastSyncing = i
		}
	}
	require.NotEqual(t, -1, lastSyncing, "expected at least one syncing status")

	for i := lastSyncing + 1; i < len(statuses); i++ {
		assert.NotEqual(t, "synced", statuses[i], "synced should not appear after final syncing on error path")
	}
}

func (r *notificationRecorder) statusCalls() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.driveStatusCalls...)
}

func (r *notificationRecorder) syncedReloadCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.syncedAndReloadCalls
}

func newNotificationTestDriveService(
	t *testing.T,
	buildOps func() DriveOperations,
) (*driveService, *notificationRecorder, DriveOperations, func()) {
	t.Helper()

	helper := setupTest(t)
	ctx := context.Background()
	recorder := newNotificationRecorder(ctx, helper.tempDir)

	var ops DriveOperations
	if buildOps != nil {
		ops = buildOps()
	} else {
		ops = newMockDriveOperations()
	}

	auth := &authService{
		ctx:        ctx,
		appDataDir: helper.tempDir,
		isTestMode: true,
		logger:     recorder,
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
		logger:      recorder,
		driveOps:    ops,
		driveSync:   NewDriveSyncService(ops, "test-folder", "test-root", recorder),
		syncState:   NewSyncState(helper.tempDir),
	}
	ds.pollingService = NewDrivePollingService(ctx, ds)
	ds.operationsQueue = NewDriveOperationsQueue(ops, nil)

	cleanup := func() {
		ds.operationsQueue.Cleanup()
		helper.cleanup()
	}

	return ds, recorder, ops, cleanup
}

type notificationFailingCreateDriveOps struct {
	*mockDriveOperations
}

func (f *notificationFailingCreateDriveOps) CreateFile(name string, content []byte, rootFolderID string, mimeType string) (string, error) {
	return "", fmt.Errorf("simulated create failure for %s", name)
}

func TestCreateNote_StatusNotification_SyncingToSynced(t *testing.T) {
	ds, recorder, _, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	note := &Note{
		ID:           "a1-create-note",
		Title:        "A1 create",
		Content:      "create content",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}

	err := ds.CreateNote(note)
	require.NoError(t, err)

	recorder.AssertDriveStatusSequence(t, []string{"syncing", "synced"})
	recorder.AssertInfoContains(t, "Drive: uploading ")
	recorder.AssertInfoContains(t, "Drive: uploaded ")
}

func TestUpdateNote_StatusNotification_SyncingToSynced(t *testing.T) {
	ds, recorder, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	mockOps, ok := rawOps.(*mockDriveOperations)
	require.True(t, ok)

	note := &Note{
		ID:           "a2-update-note",
		Title:        "A2 update",
		Content:      "before update",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	noteData, err := json.Marshal(note)
	require.NoError(t, err)
	fileID, err := mockOps.CreateFile(note.ID+".json", noteData, "test-folder", "application/json")
	require.NoError(t, err)

	syncImpl, ok := ds.driveSync.(*driveSyncServiceImpl)
	require.True(t, ok)
	syncImpl.setCachedFileID(note.ID, fileID)

	note.Content = "after update"
	err = ds.UpdateNote(note)
	require.NoError(t, err)

	recorder.AssertDriveStatusSequence(t, []string{"syncing", "synced"})
	recorder.AssertInfoContains(t, "Drive: updating ")
	recorder.AssertInfoContains(t, "Drive: updated ")
}

func TestDeleteNoteDrive_StatusNotification_SyncingToSynced(t *testing.T) {
	ds, recorder, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	mockOps, ok := rawOps.(*mockDriveOperations)
	require.True(t, ok)

	note := &Note{
		ID:           "a3-delete-note",
		Title:        "A3 delete",
		Content:      "delete content",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	noteData, err := json.Marshal(note)
	require.NoError(t, err)
	fileID, err := mockOps.CreateFile(note.ID+".json", noteData, "test-folder", "application/json")
	require.NoError(t, err)

	syncImpl, ok := ds.driveSync.(*driveSyncServiceImpl)
	require.True(t, ok)
	syncImpl.setCachedFileID(note.ID, fileID)

	err = ds.DeleteNoteDrive(note.ID)
	require.NoError(t, err)

	recorder.AssertDriveStatusSequence(t, []string{"syncing", "synced"})
	recorder.AssertInfoContains(t, "Drive: deleting note ")
	recorder.AssertInfoContains(t, "Drive: deleted note from cloud")
}

func TestCreateNote_Error_NoSyncedNotification(t *testing.T) {
	ds, recorder, _, cleanup := newNotificationTestDriveService(t, func() DriveOperations {
		return &notificationFailingCreateDriveOps{mockDriveOperations: newMockDriveOperations()}
	})
	defer cleanup()

	note := &Note{
		ID:           "a4-error-note",
		Title:        "A4 error",
		Content:      "should fail",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}

	err := ds.CreateNote(note)
	require.Error(t, err)

	statuses := recorder.statusCalls()
	assert.Contains(t, statuses, "syncing")
	assert.NotContains(t, statuses, "synced")
	recorder.AssertNoSyncedAfterError(t)
}

func TestSyncNotes_WithChanges_NotificationSequence(t *testing.T) {
	ds, recorder, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	mockOps, ok := rawOps.(*mockDriveOperations)
	require.True(t, ok)

	localNote := &Note{
		ID:           "a6-local-note",
		Title:        "A6 local",
		Content:      "local content",
		Language:     "plaintext",
		ModifiedTime: time.Now().Add(-1 * time.Hour).Format(time.RFC3339),
	}
	require.NoError(t, ds.noteService.SaveNote(localNote))

	cloudNote := &Note{
		ID:           "a6-cloud-note",
		Title:        "A6 cloud",
		Content:      "cloud content",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	cloudNoteData, err := json.Marshal(cloudNote)
	require.NoError(t, err)
	_, err = mockOps.CreateFile(cloudNote.ID+".json", cloudNoteData, "test-folder", "application/json")
	require.NoError(t, err)

	cloudNoteList := &NoteList{
		Version: "2.0",
		Notes: []NoteMetadata{
			{
				ID:           cloudNote.ID,
				Title:        cloudNote.Title,
				Language:     cloudNote.Language,
				ModifiedTime: cloudNote.ModifiedTime,
				ContentHash:  computeContentHash(cloudNote),
			},
		},
	}
	noteListData, err := json.Marshal(cloudNoteList)
	require.NoError(t, err)

	noteListID := ds.auth.GetDriveSync().NoteListID()
	mockOps.mu.Lock()
	mockOps.files[noteListID] = noteListData
	mockOps.mu.Unlock()

	err = ds.SyncNotes()
	require.NoError(t, err)

	statuses := recorder.statusCalls()
	require.NotEmpty(t, statuses)
	assert.Equal(t, "syncing", statuses[0])
	assert.Equal(t, "synced", statuses[len(statuses)-1])
	assert.GreaterOrEqual(t, recorder.syncedReloadCount(), 1)
}

func TestCreateNote_Cancelled_NoSyncedNotification(t *testing.T) {
	ds, recorder, _, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	baseSync := ds.driveSync
	ds.driveSync = &driveSyncOverride{
		DriveSyncService: baseSync,
		createNoteFn: func(ctx context.Context, note *Note) error {
			return fmt.Errorf("operation cancelled")
		},
	}

	note := &Note{
		ID:           "a5-cancelled-note",
		Title:        "A5 cancelled",
		Content:      "cancelled content",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}

	err := ds.CreateNote(note)
	require.NoError(t, err)

	statuses := recorder.statusCalls()
	assert.Contains(t, statuses, "syncing")
	assert.NotContains(t, statuses, "synced")
}

func TestSyncNotes_QueueNotEmpty_KeepsSyncingStatus(t *testing.T) {
	ds, recorder, _, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	ds.operationsQueue.mutex.Lock()
	ds.operationsQueue.items["queued-item"] = []*QueueItem{{OperationType: UpdateOperation, FileID: "x"}}
	ds.operationsQueue.mutex.Unlock()

	ds.notifySyncComplete()

	statuses := recorder.statusCalls()
	require.NotEmpty(t, statuses)
	assert.Equal(t, "syncing", statuses[len(statuses)-1])
}

func TestUpdateNoteListInternal_StatusNotification(t *testing.T) {
	ds, recorder, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	seedCloudNoteListFile(t, ds, rawOps)

	err := ds.updateNoteListInternal()
	require.NoError(t, err)

	recorder.AssertDriveStatusSequence(t, []string{"syncing", "synced"})
}

func TestPerformInitialSync_ProgressiveNotification(t *testing.T) {
	ds, recorder, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	mockOps, ok := rawOps.(*mockDriveOperations)
	require.True(t, ok)

	seedCloudNoteListFile(t, ds, rawOps)

	now := time.Now().Format(time.RFC3339)
	cloudNotes := make([]NoteMetadata, 0, 15)
	for i := 0; i < 15; i++ {
		note := &Note{
			ID:           fmt.Sprintf("a10-cloud-%02d", i),
			Title:        fmt.Sprintf("A10 cloud %02d", i),
			Content:      fmt.Sprintf("cloud content %02d", i),
			Language:     "plaintext",
			ModifiedTime: now,
		}
		noteData, err := json.Marshal(note)
		require.NoError(t, err)
		_, err = mockOps.CreateFile(note.ID+".json", noteData, "test-folder", "application/json")
		require.NoError(t, err)

		cloudNotes = append(cloudNotes, NoteMetadata{
			ID:           note.ID,
			Title:        note.Title,
			Language:     note.Language,
			ModifiedTime: note.ModifiedTime,
			ContentHash:  computeContentHash(note),
		})
	}

	cloudNoteList := &NoteList{
		Version: "2.0",
		Notes:   cloudNotes,
	}
	noteListData, err := json.Marshal(cloudNoteList)
	require.NoError(t, err)

	noteListID := ds.auth.GetDriveSync().NoteListID()
	mockOps.mu.Lock()
	mockOps.files[noteListID] = noteListData
	mockOps.mu.Unlock()

	err = ds.SyncNotes()
	require.NoError(t, err)

	statuses := recorder.statusCalls()
	require.NotEmpty(t, statuses)
	assert.Equal(t, "syncing", statuses[0])
}

func TestReconnect_Success_EmitsSynced(t *testing.T) {
	ds, recorder, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	seedCloudNoteListFile(t, ds, rawOps)
	ds.auth.isTestMode = false
	ds.auth.frontendReady = make(chan struct{})

	polling := NewDrivePollingService(context.Background(), ds)
	go polling.WaitForFrontendAndStartSync()
	close(ds.auth.frontendReady)

	deadline := time.Now().Add(3 * time.Second)
	foundSynced := false
	for time.Now().Before(deadline) {
		for _, s := range recorder.statusCalls() {
			if s == "synced" {
				foundSynced = true
				break
			}
		}
		if foundSynced {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	polling.StopPolling()
	assert.True(t, foundSynced)
}

func TestSyncNotes_DriveError_ErrorWithNotifyEmitted(t *testing.T) {
	ds, recorder, _, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	baseSync := ds.driveSync
	ds.driveSync = &driveSyncNotificationOverride{
		DriveSyncService: baseSync,
		downloadNoteListIfChangedFn: func(ctx context.Context, noteListID string) (*NoteList, bool, error) {
			return nil, false, fmt.Errorf("connection timeout")
		},
	}

	err := ds.SyncNotes()
	require.Error(t, err)

	statuses := recorder.statusCalls()
	assert.Contains(t, statuses, "syncing")
	assert.Contains(t, statuses, "offline")
	assert.NotContains(t, statuses, "synced")
}

type driveSyncNotificationOverride struct {
	DriveSyncService

	downloadNoteListIfChangedFn func(ctx context.Context, noteListID string) (*NoteList, bool, error)
}

func (o *driveSyncNotificationOverride) DownloadNoteListIfChanged(ctx context.Context, noteListID string) (*NoteList, bool, error) {
	if o.downloadNoteListIfChangedFn != nil {
		return o.downloadNoteListIfChangedFn(ctx, noteListID)
	}
	return o.DriveSyncService.DownloadNoteListIfChanged(ctx, noteListID)
}
