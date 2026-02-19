package backend

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/api/drive/v3"
)

type retryCountingOps struct {
	*mockDriveOperations
	mu         sync.Mutex
	callCounts map[string]int
	failUntil  map[string]int
	failErr    error
}

func newRetryCountingOps() *retryCountingOps {
	return &retryCountingOps{
		mockDriveOperations: newMockDriveOperations(),
		callCounts:          make(map[string]int),
		failUntil:           make(map[string]int),
	}
}

func (r *retryCountingOps) increment(method string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.callCounts[method]++
	return r.callCounts[method]
}

func (r *retryCountingOps) shouldFail(method string, count int) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	limit, ok := r.failUntil[method]
	return ok && count <= limit && r.failErr != nil
}

func (r *retryCountingOps) callCount(method string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.callCounts[method]
}

func (r *retryCountingOps) DownloadFile(fileID string) ([]byte, error) {
	count := r.increment("DownloadFile")
	if r.shouldFail("DownloadFile", count) {
		return nil, r.failErr
	}
	return r.mockDriveOperations.DownloadFile(fileID)
}

func (r *retryCountingOps) CreateFile(name string, content []byte, rootFolderID string, mimeType string) (string, error) {
	count := r.increment("CreateFile")
	if r.shouldFail("CreateFile", count) {
		return "", r.failErr
	}
	return r.mockDriveOperations.CreateFile(name, content, rootFolderID, mimeType)
}

func (r *retryCountingOps) UpdateFile(fileID string, content []byte) error {
	count := r.increment("UpdateFile")
	if r.shouldFail("UpdateFile", count) {
		return r.failErr
	}
	return r.mockDriveOperations.UpdateFile(fileID, content)
}

func (r *retryCountingOps) GetFileID(fileName string, noteFolderID string, rootFolderID string) (string, error) {
	count := r.increment("GetFileID")
	if r.shouldFail("GetFileID", count) {
		return "", r.failErr
	}
	return r.mockDriveOperations.GetFileID(fileName, noteFolderID, rootFolderID)
}

type selectiveDownloadErrorOps struct {
	*mockDriveOperations
	downloadErrByFileID map[string]error
}

func (s *selectiveDownloadErrorOps) DownloadFile(fileID string) ([]byte, error) {
	if err, ok := s.downloadErrByFileID[fileID]; ok {
		return nil, err
	}
	return s.mockDriveOperations.DownloadFile(fileID)
}

type metadataDriveOps struct {
	*mockDriveOperations
	metadata      *drive.File
	metadataErr   error
	downloadCalls int
}

func (m *metadataDriveOps) GetFileMetadata(fileID string) (*drive.File, error) {
	if m.metadataErr != nil {
		return nil, m.metadataErr
	}
	if m.metadata != nil {
		return m.metadata, nil
	}
	return m.mockDriveOperations.GetFileMetadata(fileID)
}

func (m *metadataDriveOps) DownloadFile(fileID string) ([]byte, error) {
	m.downloadCalls++
	return m.mockDriveOperations.DownloadFile(fileID)
}

func shortRetryConfig(maxRetries int) *retryConfig {
	return &retryConfig{
		maxRetries: maxRetries,
		baseDelay:  time.Millisecond,
		maxDelay:   5 * time.Millisecond,
		shouldRetry: func(err error) bool {
			return err != nil && strings.Contains(err.Error(), "connection")
		},
	}
}

func newTestDriveServiceWithOps(t *testing.T, ops DriveOperations) (*driveService, *testHelper) {
	t.Helper()
	helper := setupTest(t)
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	auth := &authService{isTestMode: true}
	driveSyncState := &DriveSync{}
	driveSyncState.SetFolderIDs("test-root", "test-folder")
	auth.driveSync = driveSyncState

	return &driveService{
		ctx:         context.Background(),
		auth:        auth,
		noteService: helper.noteService,
		logger:      logger,
		driveOps:    ops,
		driveSync:   NewDriveSyncService(ops, "test-folder", "test-root", logger),
	}, helper
}

func TestWithRetry_SuccessOnFirstAttempt(t *testing.T) {
	service := NewDriveSyncService(newMockDriveOperations(), "test-folder", "test-root", NewAppLogger(context.Background(), true, t.TempDir())).(*driveSyncServiceImpl)

	attempts := 0
	err := service.withRetry(func() error {
		attempts++
		return nil
	}, shortRetryConfig(3))

	assert.NoError(t, err)
	assert.Equal(t, 1, attempts)
}

func TestWithRetry_SuccessAfterRetries(t *testing.T) {
	service := NewDriveSyncService(newMockDriveOperations(), "test-folder", "test-root", NewAppLogger(context.Background(), true, t.TempDir())).(*driveSyncServiceImpl)

	attempts := 0
	err := service.withRetry(func() error {
		attempts++
		if attempts <= 2 {
			return errors.New("connection error")
		}
		return nil
	}, shortRetryConfig(5))

	assert.NoError(t, err)
	assert.Equal(t, 3, attempts)
}

func TestWithRetry_ExhaustsAllRetries(t *testing.T) {
	service := NewDriveSyncService(newMockDriveOperations(), "test-folder", "test-root", NewAppLogger(context.Background(), true, t.TempDir())).(*driveSyncServiceImpl)

	attempts := 0
	err := service.withRetry(func() error {
		attempts++
		return errors.New("connection reset by peer")
	}, shortRetryConfig(3))

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "connection")
	assert.Equal(t, 3, attempts)
}

func TestWithRetry_NonRetryableError_StopsImmediately(t *testing.T) {
	service := NewDriveSyncService(newMockDriveOperations(), "test-folder", "test-root", NewAppLogger(context.Background(), true, t.TempDir())).(*driveSyncServiceImpl)

	attempts := 0
	err := service.withRetry(func() error {
		attempts++
		return errors.New("permission denied")
	}, shortRetryConfig(5))

	assert.Error(t, err)
	assert.Contains(t, err.Error(), "permission denied")
	assert.Equal(t, 1, attempts)
}

func TestDownloadNote_RetryThenParseJSON(t *testing.T) {
	ops := newRetryCountingOps()
	ops.failUntil["DownloadFile"] = 1
	ops.failErr = errors.New("connection interrupted")
	originalDownloadRetryConfig := downloadRetryConfig
	downloadRetryConfig = &retryConfig{
		maxRetries: 3,
		baseDelay:  time.Millisecond,
		maxDelay:   5 * time.Millisecond,
		shouldRetry: func(err error) bool {
			return originalDownloadRetryConfig.shouldRetry(err)
		},
	}
	defer func() { downloadRetryConfig = originalDownloadRetryConfig }()

	logger := NewAppLogger(context.Background(), true, t.TempDir())
	service := NewDriveSyncService(ops, "test-folder", "test-root", logger).(*driveSyncServiceImpl)

	note := &Note{ID: "retry-note", Title: "Retry", Content: "hello", Language: "plaintext"}
	noteData, err := json.Marshal(note)
	require.NoError(t, err)
	fileID, err := ops.CreateFile("retry-note.json", noteData, "test-folder", "application/json")
	require.NoError(t, err)
	service.setCachedFileID("retry-note", fileID)

	downloaded, err := service.DownloadNote(context.Background(), "retry-note")
	require.NoError(t, err)
	assert.Equal(t, "retry-note", downloaded.ID)
	assert.Equal(t, "Retry", downloaded.Title)
	assert.Equal(t, "hello", downloaded.Content)
	assert.Equal(t, 2, ops.callCount("DownloadFile"))
}

func TestUpdateNote_AllRetriesFail_FallsBackToCreate(t *testing.T) {
	ops := newRetryCountingOps()
	ops.failUntil["UpdateFile"] = 10
	ops.failErr = errors.New("file not found")

	logger := NewAppLogger(context.Background(), true, t.TempDir())
	service := NewDriveSyncService(ops, "test-folder", "test-root", logger).(*driveSyncServiceImpl)
	service.setCachedFileID("fallback-note", "missing-file-id")

	err := service.UpdateNote(context.Background(), &Note{ID: "fallback-note", Title: "Fallback", Content: "created", Language: "plaintext"})
	require.NoError(t, err)
	assert.Equal(t, 1, ops.callCount("UpdateFile"))
	assert.Equal(t, 1, ops.callCount("CreateFile"))

	ops.mockDriveOperations.mu.RLock()
	_, exists := ops.files["test-file-fallback-note.json"]
	ops.mockDriveOperations.mu.RUnlock()
	assert.True(t, exists)
}

func TestCreateNote_DuplicatePrevention_UpdatesExisting(t *testing.T) {
	ops := newRetryCountingOps()
	logger := NewAppLogger(context.Background(), true, t.TempDir())

	noteData, _ := json.Marshal(&Note{ID: "dup-note", Title: "Original", Content: "old", Language: "plaintext"})
	_, err := ops.CreateFile("dup-note.json", noteData, "test-folder", "application/json")
	require.NoError(t, err)

	ops.mu.Lock()
	ops.callCounts["CreateFile"] = 0
	ops.mu.Unlock()

	service := NewDriveSyncService(ops, "test-folder", "test-root", logger).(*driveSyncServiceImpl)
	err = service.CreateNote(context.Background(), &Note{ID: "dup-note", Title: "Updated", Content: "new", Language: "plaintext"})
	assert.NoError(t, err)
	assert.Equal(t, 0, ops.callCount("CreateFile"), "既存ファイルがある場合CreateFileは呼ばれないべき")
	assert.Equal(t, 1, ops.callCount("UpdateFile"), "既存ファイルがUpdateされるべき")

	ops.mockDriveOperations.mu.RLock()
	updatedData := ops.files["test-file-dup-note.json"]
	ops.mockDriveOperations.mu.RUnlock()
	var updated Note
	require.NoError(t, json.Unmarshal(updatedData, &updated))
	assert.Equal(t, "new", updated.Content)
}

func TestCreateNote_NoExisting_CreatesNew(t *testing.T) {
	ops := newRetryCountingOps()
	logger := NewAppLogger(context.Background(), true, t.TempDir())
	service := NewDriveSyncService(ops, "test-folder", "test-root", logger).(*driveSyncServiceImpl)

	err := service.CreateNote(context.Background(), &Note{ID: "new-note", Title: "New", Content: "content", Language: "plaintext"})
	assert.NoError(t, err)
	assert.Equal(t, 1, ops.callCount("CreateFile"), "新規ファイルはCreateFileで作成されるべき")
	assert.Equal(t, 0, ops.callCount("UpdateFile"), "新規ファイルでUpdateFileは呼ばれないべき")

	ops.mockDriveOperations.mu.RLock()
	_, exists := ops.files["test-file-new-note.json"]
	ops.mockDriveOperations.mu.RUnlock()
	assert.True(t, exists)
}

func TestRetryConfig_ShouldRetry_Conditions(t *testing.T) {
	tests := []struct {
		name   string
		config *retryConfig
		err    error
		want   bool
	}{
		{name: "default not found", config: defaultRetryConfig, err: errors.New("not found"), want: true},
		{name: "default connection", config: defaultRetryConfig, err: errors.New("connection reset"), want: true},
		{name: "default deadline", config: defaultRetryConfig, err: errors.New("deadline exceeded"), want: true},
		{name: "default permission denied", config: defaultRetryConfig, err: errors.New("permission denied"), want: false},
		{name: "default nil", config: defaultRetryConfig, err: nil, want: false},

		{name: "download connection", config: downloadRetryConfig, err: errors.New("connection timeout"), want: true},
		{name: "download deadline", config: downloadRetryConfig, err: errors.New("deadline exceeded"), want: true},
		{name: "download internal", config: downloadRetryConfig, err: errors.New("internal error"), want: true},
		{name: "download idle", config: downloadRetryConfig, err: errors.New("idle HTTP channel"), want: true},
		{name: "download not found", config: downloadRetryConfig, err: errors.New("not found"), want: false},
		{name: "download nil", config: downloadRetryConfig, err: nil, want: false},

		{name: "upload connection", config: uploadRetryConfig, err: errors.New("connection closed"), want: true},
		{name: "upload deadline", config: uploadRetryConfig, err: errors.New("deadline exceeded"), want: true},
		{name: "upload idle", config: uploadRetryConfig, err: errors.New("idle HTTP channel"), want: true},
		{name: "upload not found", config: uploadRetryConfig, err: errors.New("not found"), want: false},
		{name: "upload nil", config: uploadRetryConfig, err: nil, want: false},

		{name: "getFileID not found", config: getFileIDRetryConfig, err: errors.New("file not found"), want: true},
		{name: "getFileID connection", config: getFileIDRetryConfig, err: errors.New("connection error"), want: false},
		{name: "getFileID nil", config: getFileIDRetryConfig, err: nil, want: false},

		{name: "list connection", config: listOperationRetryConfig, err: errors.New("connection error"), want: true},
		{name: "list internal", config: listOperationRetryConfig, err: errors.New("internal error"), want: true},
		{name: "list idle", config: listOperationRetryConfig, err: errors.New("idle HTTP channel"), want: true},
		{name: "list not found", config: listOperationRetryConfig, err: errors.New("not found"), want: false},
		{name: "list nil", config: listOperationRetryConfig, err: nil, want: false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, tc.config.shouldRetry(tc.err))
		})
	}
}

func TestDownloadNoteList_CorruptedJSON_FallbackToCached(t *testing.T) {
	ops := newMockDriveOperations()
	service := NewDriveSyncService(ops, "test-folder", "test-root", NewAppLogger(context.Background(), true, t.TempDir())).(*driveSyncServiceImpl)

	validList := &NoteList{Version: "1.0", Notes: []NoteMetadata{{ID: "n1", Title: "Note 1"}}}
	validData, err := json.Marshal(validList)
	require.NoError(t, err)
	noteListID, err := ops.CreateFile("noteList.json", validData, "test-root", "application/json")
	require.NoError(t, err)

	first, err := service.DownloadNoteList(context.Background(), noteListID)
	require.NoError(t, err)
	require.NotNil(t, first)

	ops.mu.Lock()
	ops.files[noteListID] = []byte("{broken-json")
	ops.mu.Unlock()

	second, err := service.DownloadNoteList(context.Background(), noteListID)
	require.NoError(t, err)
	require.NotNil(t, second)
	assert.Equal(t, first.Notes, second.Notes)
}

func TestDownloadNoteList_CorruptedJSON_NoCached_Error(t *testing.T) {
	ops := newMockDriveOperations()
	service := NewDriveSyncService(ops, "test-folder", "test-root", NewAppLogger(context.Background(), true, t.TempDir())).(*driveSyncServiceImpl)

	noteListID, err := ops.CreateFile("noteList.json", []byte("{broken-json"), "test-root", "application/json")
	require.NoError(t, err)

	noteList, err := service.DownloadNoteList(context.Background(), noteListID)
	assert.Nil(t, noteList)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "failed to decode note list")
}

func TestDownloadNoteListIfChanged_MD5Match_SkipsDownload(t *testing.T) {
	ops := &metadataDriveOps{
		mockDriveOperations: newMockDriveOperations(),
		metadata: &drive.File{
			Id:          "note-list-id",
			Md5Checksum: "abc123",
		},
	}

	service := NewDriveSyncService(ops, "test-folder", "test-root", NewAppLogger(context.Background(), true, t.TempDir())).(*driveSyncServiceImpl)
	service.lastNoteListMd5 = "abc123"

	noteList, changed, err := service.DownloadNoteListIfChanged(context.Background(), "note-list-id")
	require.NoError(t, err)
	assert.Nil(t, noteList)
	assert.False(t, changed)
	assert.Equal(t, 0, ops.downloadCalls)
}

func TestDownloadNoteListIfChanged_MetadataError_FullDownload(t *testing.T) {
	ops := &metadataDriveOps{
		mockDriveOperations: newMockDriveOperations(),
		metadataErr:         errors.New("metadata unavailable"),
	}
	service := NewDriveSyncService(ops, "test-folder", "test-root", NewAppLogger(context.Background(), true, t.TempDir())).(*driveSyncServiceImpl)

	validList := &NoteList{Version: "1.0", Notes: []NoteMetadata{{ID: "n1", Title: "Note 1"}}}
	validData, err := json.Marshal(validList)
	require.NoError(t, err)
	noteListID, err := ops.CreateFile("noteList.json", validData, "test-root", "application/json")
	require.NoError(t, err)

	noteList, changed, err := service.DownloadNoteListIfChanged(context.Background(), noteListID)
	require.NoError(t, err)
	require.NotNil(t, noteList)
	assert.True(t, changed)
	assert.Equal(t, 1, ops.downloadCalls)
}

func TestDeduplicateNotes_DuplicateIDs_KeepsLatest(t *testing.T) {
	service := NewDriveSyncService(newMockDriveOperations(), "test-folder", "test-root", NewAppLogger(context.Background(), true, t.TempDir())).(*driveSyncServiceImpl)

	older := time.Now().Add(-time.Hour).Format(time.RFC3339)
	newer := time.Now().Format(time.RFC3339)
	notes := []NoteMetadata{
		{ID: "dup-note", Title: "Old", ModifiedTime: older},
		{ID: "dup-note", Title: "New", ModifiedTime: newer},
	}

	result := service.DeduplicateNotes(notes)
	require.Len(t, result, 1)
	assert.Equal(t, "dup-note", result[0].ID)
	assert.Equal(t, "New", result[0].Title)
	assert.True(t, isModifiedTimeAfter(result[0].ModifiedTime, older))
}

func TestWithRetry_ExponentialBackoff_DelayIncreases(t *testing.T) {
	service := NewDriveSyncService(newMockDriveOperations(), "test-folder", "test-root", NewAppLogger(context.Background(), true, t.TempDir())).(*driveSyncServiceImpl)

	callTimes := make([]time.Time, 0, 4)
	err := service.withRetry(func() error {
		callTimes = append(callTimes, time.Now())
		return errors.New("connection failure")
	}, &retryConfig{
		maxRetries: 4,
		baseDelay:  10 * time.Millisecond,
		maxDelay:   25 * time.Millisecond,
		shouldRetry: func(err error) bool {
			return err != nil && strings.Contains(err.Error(), "connection")
		},
	})

	assert.Error(t, err)
	require.Len(t, callTimes, 4)

	d1 := callTimes[1].Sub(callTimes[0])
	d2 := callTimes[2].Sub(callTimes[1])
	d3 := callTimes[3].Sub(callTimes[2])

	assert.GreaterOrEqual(t, d1, 8*time.Millisecond)
	assert.GreaterOrEqual(t, d2, 18*time.Millisecond)
	assert.GreaterOrEqual(t, d3, 22*time.Millisecond)
	assert.Greater(t, d2, d1)
	assert.GreaterOrEqual(t, d3, d2)
}

func TestDeduplicateNotes_EmptyList(t *testing.T) {
	service := NewDriveSyncService(newMockDriveOperations(), "test-folder", "test-root", NewAppLogger(context.Background(), true, t.TempDir())).(*driveSyncServiceImpl)

	result := service.DeduplicateNotes([]NoteMetadata{})
	assert.NotNil(t, result)
	assert.Empty(t, result)
}
