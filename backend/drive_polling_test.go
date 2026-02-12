package backend

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"google.golang.org/api/drive/v3"
)

type fakeDriveSyncService struct {
	noteList *NoteList
	err      error
}

func (f *fakeDriveSyncService) CreateNote(ctx context.Context, note *Note) error {
	return nil
}
func (f *fakeDriveSyncService) UpdateNote(ctx context.Context, note *Note) error {
	return nil
}
func (f *fakeDriveSyncService) UploadAllNotes(ctx context.Context, notes []NoteMetadata) error {
	return nil
}
func (f *fakeDriveSyncService) DownloadNote(ctx context.Context, noteID string) (*Note, error) {
	return nil, nil
}
func (f *fakeDriveSyncService) DeleteNote(ctx context.Context, noteID string) error {
	return nil
}
func (f *fakeDriveSyncService) ListFiles(ctx context.Context, folderID string) ([]*drive.File, error) {
	return nil, nil
}
func (f *fakeDriveSyncService) GetNoteID(ctx context.Context, noteID string) (string, error) {
	return "", nil
}
func (f *fakeDriveSyncService) RemoveDuplicateNoteFiles(ctx context.Context, files []*drive.File) error {
	return nil
}
func (f *fakeDriveSyncService) RemoveNoteFromList(notes []NoteMetadata, noteID string) []NoteMetadata {
	return notes
}
func (f *fakeDriveSyncService) CreateNoteList(ctx context.Context, noteList *NoteList) error {
	return nil
}
func (f *fakeDriveSyncService) UpdateNoteList(ctx context.Context, noteList *NoteList, noteListID string) error {
	return nil
}
func (f *fakeDriveSyncService) DownloadNoteList(ctx context.Context, noteListID string) (*NoteList, error) {
	return f.noteList, f.err
}
func (f *fakeDriveSyncService) DownloadNoteListIfChanged(ctx context.Context, noteListID string) (*NoteList, bool, error) {
	return f.noteList, true, f.err
}
func (f *fakeDriveSyncService) DeduplicateNotes(notes []NoteMetadata) []NoteMetadata {
	return notes
}
func (f *fakeDriveSyncService) RefreshFileIDCache(ctx context.Context) error {
	return nil
}
func (f *fakeDriveSyncService) SetConnected(connected bool) {
}
func (f *fakeDriveSyncService) SetInitialSyncCompleted(completed bool) {
}
func (f *fakeDriveSyncService) SetCloudNoteList(noteList *NoteList) {
}
func (f *fakeDriveSyncService) IsConnected() bool {
	return true
}
func (f *fakeDriveSyncService) HasCompletedInitialSync() bool {
	return true
}

func TestHasRelevantChanges(t *testing.T) {
	rootID := "root-folder"
	notesID := "notes-folder"

	t.Run("json file change is relevant", func(t *testing.T) {
		changes := []*drive.Change{{
			File: &drive.File{
				Id:      "noteList-id",
				Name:    "noteList_v2.json",
				Parents: []string{rootID},
			},
		}}
		assert.True(t, hasRelevantChanges(changes, rootID, notesID))
	})

	t.Run("note file change is relevant", func(t *testing.T) {
		changes := []*drive.Change{{
			File: &drive.File{
				Id:      "note-1",
				Name:    "note-1.json",
				Parents: []string{notesID},
			},
		}}
		assert.True(t, hasRelevantChanges(changes, rootID, notesID))
	})

	t.Run("unrelated change is not relevant", func(t *testing.T) {
		changes := []*drive.Change{{
			File: &drive.File{
				Id:      "other-file",
				Name:    "photo.png",
				Parents: []string{"unrelated-folder"},
			},
		}}
		assert.False(t, hasRelevantChanges(changes, rootID, notesID))
	})
}

type pollingListChangesDriveOps struct {
	*mockDriveOperations
	listChangesErr error
	changes        []*drive.Change
	newStartToken  string
	listCalls      int
}

func (p *pollingListChangesDriveOps) ListChanges(pageToken string) (*ChangesResult, error) {
	p.listCalls++
	if p.listChangesErr != nil {
		return nil, p.listChangesErr
	}
	return &ChangesResult{
		Changes:       p.changes,
		NewStartToken: p.newStartToken,
	}, nil
}

func TestPolling_Disconnected_ReconnectSuccess(t *testing.T) {
	ds, recorder, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	seedCloudNoteListFile(t, ds, rawOps)
	ds.auth.isTestMode = false
	ds.auth.GetDriveSync().SetConnected(false)
	ds.auth.frontendReady = make(chan struct{})

	polling := NewDrivePollingService(context.Background(), ds)
	go func() {
		polling.WaitForFrontendAndStartSync()
	}()

	time.Sleep(50 * time.Millisecond)
	ds.auth.GetDriveSync().SetConnected(true)
	close(ds.auth.frontendReady)

	deadline := time.Now().Add(3 * time.Second)
	foundSynced := false
	for time.Now().Before(deadline) {
		statuses := recorder.statusCalls()
		for _, s := range statuses {
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

	assert.True(t, foundSynced, "再接続成功後にsynced通知が行われるべき")
	polling.StopPolling()
}

func TestPolling_Disconnected_ReconnectFail_Backoff(t *testing.T) {
	base := 10 * time.Second
	factor := 1.5
	maxDelay := 180 * time.Second

	delay := base
	got := make([]time.Duration, 0, 20)
	for i := 0; i < 20; i++ {
		got = append(got, delay)
		delay = time.Duration(float64(delay) * factor)
		if delay > maxDelay {
			delay = maxDelay
		}
	}

	assert.Equal(t, 10*time.Second, got[0])
	assert.Equal(t, 15*time.Second, got[1])
	assert.Equal(t, 22500*time.Millisecond, got[2])
	assert.Equal(t, 33750*time.Millisecond, got[3])
	assert.Equal(t, 180*time.Second, got[len(got)-1], "最終的に上限180秒で頭打ちになるべき")
}

func TestPolling_NoChangeToken_FullSync(t *testing.T) {
	ds, _, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	seedCloudNoteListFile(t, ds, rawOps)

	polling := NewDrivePollingService(context.Background(), ds)
	polling.changePageToken = ""

	hasChanges, err := polling.checkForChanges()
	assert.NoError(t, err)
	assert.False(t, hasChanges, "change tokenなしはfull sync実行後に変更なしとして扱う")
	assert.NotEmpty(t, polling.changePageToken, "full sync後にchange tokenが初期化されるべき")
}

func TestPolling_ChangesAPIError_ClearsToken(t *testing.T) {
	ops := &pollingListChangesDriveOps{
		mockDriveOperations: newMockDriveOperations(),
		listChangesErr:      fmt.Errorf("simulated changes api error"),
	}
	ds, _, _, cleanup := newNotificationTestDriveService(t, func() DriveOperations { return ops })
	defer cleanup()

	polling := NewDrivePollingService(context.Background(), ds)
	polling.changePageToken = "valid-token"

	hasChanges, err := polling.checkForChanges()
	assert.NoError(t, err)
	assert.True(t, hasChanges, "Changes APIエラー時はfull syncフォールバックのため変更あり扱い")
	assert.Empty(t, polling.changePageToken, "Changes APIエラー時はtokenがクリアされるべき")
}

func TestPolling_QueueHasItems_SkipsAndResetsInterval(t *testing.T) {
	ds, _, _, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	ds.operationsQueue.mutex.Lock()
	ds.operationsQueue.items["dummy-key"] = []*QueueItem{{OperationType: UpdateOperation, FileID: "dummy"}}
	ds.operationsQueue.mutex.Unlock()

	polling := NewDrivePollingService(context.Background(), ds)
	interval := 30 * time.Second

	if ds.operationsQueue != nil && ds.operationsQueue.HasItems() {
		interval = 5 * time.Second
		polling.ResetPollingInterval()
	}

	assert.Equal(t, 5*time.Second, interval)
	select {
	case <-polling.resetPollingChan:
	default:
		t.Fatal("キューに未処理項目がある場合、ポーリング間隔リセットシグナルが送信されるべき")
	}
}

func TestPolling_ChangesDetected_SyncSuccess_IntervalReset(t *testing.T) {
	ops := &pollingListChangesDriveOps{
		mockDriveOperations: newMockDriveOperations(),
		changes: []*drive.Change{{
			File: &drive.File{Id: "note-1", Name: "note-1.json", Parents: []string{"notes-folder"}},
		}},
		newStartToken: "next-token",
	}
	ds, _, _, cleanup := newNotificationTestDriveService(t, func() DriveOperations { return ops })
	defer cleanup()
	ds.auth.GetDriveSync().SetFolderIDs("root-folder", "notes-folder")

	polling := NewDrivePollingService(context.Background(), ds)
	polling.changePageToken = "current-token"

	hasChanges, err := polling.checkForChanges()
	assert.NoError(t, err)
	assert.True(t, hasChanges)

	interval := 30 * time.Second
	if hasChanges {
		interval = 5 * time.Second
	}
	assert.Equal(t, 5*time.Second, interval, "変更検知+同期成功時はintervalがinitialへ戻るべき")
}

func TestPolling_StopPolling_Safe(t *testing.T) {
	ds, _, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	seedCloudNoteListFile(t, ds, rawOps)
	polling := NewDrivePollingService(context.Background(), ds)

	assert.NotPanics(t, func() {
		go polling.StartPolling()
		time.Sleep(100 * time.Millisecond)
		polling.StopPolling()
		time.Sleep(100 * time.Millisecond)

		go polling.StartPolling()
		time.Sleep(100 * time.Millisecond)
		polling.StopPolling()
	}, "StopPollingは安全に呼べて再開もできるべき")
}

func TestPolling_NoChanges_IntervalIncreases(t *testing.T) {
	const (
		initialInterval = 5 * time.Second
		maxInterval     = 1 * time.Minute
		factor          = 1.5
	)

	interval := initialInterval
	increases := make([]time.Duration, 0, 10)
	for i := 0; i < 10; i++ {
		interval = time.Duration(float64(interval) * factor)
		if interval > maxInterval {
			interval = maxInterval
		}
		increases = append(increases, interval)
	}

	assert.Greater(t, increases[0], initialInterval)
	for _, d := range increases {
		assert.LessOrEqual(t, d, maxInterval)
	}
	assert.Equal(t, maxInterval, increases[len(increases)-1])
}

func TestPolling_ResetPollingInterval_NonBlocking(t *testing.T) {
	ds, _, _, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	polling := NewDrivePollingService(context.Background(), ds)
	polling.resetPollingChan <- struct{}{}

	assert.NotPanics(t, func() {
		done := make(chan struct{})
		go func() {
			polling.ResetPollingInterval()
			polling.ResetPollingInterval()
			close(done)
		}()

		select {
		case <-done:
		case <-time.After(1 * time.Second):
			t.Fatal("ResetPollingInterval blocked with full channel")
		}
	})
}
