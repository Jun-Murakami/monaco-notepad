package backend

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func seedNoteListForDebounceTests(t *testing.T, ds *driveService, rawOps DriveOperations) {
	t.Helper()

	mockOps, ok := rawOps.(*mockDriveOperations)
	if !ok {
		t.Fatalf("expected *mockDriveOperations, got %T", rawOps)
	}

	noteListID := ds.auth.GetDriveSync().NoteListID()
	noteListData, err := json.Marshal(ds.noteService.noteList)
	if err != nil {
		t.Fatalf("failed to marshal note list: %v", err)
	}

	mockOps.mu.Lock()
	mockOps.files[noteListID] = noteListData
	mockOps.mu.Unlock()
}

func statusCount(recorder *notificationRecorder, target string) int {
	count := 0
	for _, s := range recorder.statusCalls() {
		if s == target {
			count++
		}
	}
	return count
}

func TestUpdateNoteList_WithinTwoSeconds_Deferred(t *testing.T) {
	ds, recorder, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()
	seedNoteListForDebounceTests(t, ds, rawOps)

	ds.lastNoteListUpload = time.Now().Add(-1 * time.Second)

	err := ds.UpdateNoteList()
	assert.NoError(t, err)
	assert.NotNil(t, ds.deferredUploadTimer)
	assert.Equal(t, 0, statusCount(recorder, "syncing"))

	ds.syncMu.Lock()
	if ds.deferredUploadTimer != nil {
		ds.deferredUploadTimer.Stop()
		ds.deferredUploadTimer = nil
	}
	ds.syncMu.Unlock()
}

func TestUpdateNoteList_AfterTwoSeconds_Immediate(t *testing.T) {
	ds, recorder, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()
	seedNoteListForDebounceTests(t, ds, rawOps)

	ds.lastNoteListUpload = time.Now().Add(-3 * time.Second)

	err := ds.UpdateNoteList()
	assert.NoError(t, err)
	assert.GreaterOrEqual(t, statusCount(recorder, "syncing"), 1)
	assert.GreaterOrEqual(t, statusCount(recorder, "synced"), 1)
}

func TestUpdateNoteList_DeferredThenCalledAgain_TimerReset(t *testing.T) {
	ds, recorder, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()
	seedNoteListForDebounceTests(t, ds, rawOps)

	ds.lastNoteListUpload = time.Now().Add(-500 * time.Millisecond)

	err := ds.UpdateNoteList()
	assert.NoError(t, err)
	assert.NotNil(t, ds.deferredUploadTimer)

	err = ds.UpdateNoteList()
	assert.NoError(t, err)
	timer2 := ds.deferredUploadTimer
	assert.NotNil(t, timer2)

	time.Sleep(3 * time.Second)

	assert.Equal(t, 1, statusCount(recorder, "syncing"))
	assert.Equal(t, 1, statusCount(recorder, "synced"))
}

func TestUpdateNoteList_DeferredTimer_EventuallyFires(t *testing.T) {
	ds, recorder, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()
	seedNoteListForDebounceTests(t, ds, rawOps)

	ds.lastNoteListUpload = time.Now()

	err := ds.UpdateNoteList()
	assert.NoError(t, err)
	assert.NotNil(t, ds.deferredUploadTimer)

	time.Sleep(3500 * time.Millisecond)

	assert.GreaterOrEqual(t, statusCount(recorder, "syncing"), 1)
	assert.GreaterOrEqual(t, statusCount(recorder, "synced"), 1)
}

func TestUpdateNoteList_DeferredTimer_ErrorLogged(t *testing.T) {
	ds, recorder, _, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	noteListPath := filepath.Join(filepath.Dir(ds.noteService.notesDir), "noteList.json")
	_ = os.RemoveAll(noteListPath)
	err := os.Mkdir(noteListPath, 0755)
	assert.NoError(t, err)

	ds.lastNoteListUpload = time.Now()
	err = ds.UpdateNoteList()
	assert.NoError(t, err)

	time.Sleep(2500 * time.Millisecond)

	recorder.mu.Lock()
	errorLogs := append([]string(nil), recorder.errorCalls...)
	recorder.mu.Unlock()

	found := false
	for _, msg := range errorLogs {
		if strings.Contains(msg, "Failed to save note list for deferred upload") {
			found = true
			break
		}
	}
	assert.True(t, found, "deferred save failure should be logged")
}
