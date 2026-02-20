/*
DriveServiceのテストスイート

このテストファイルは、Google Driveとの同期機能を提供するDriveServiceの
機能を検証するためのテストケースを含む

テストケース:
1. TestNewDriveService
   - DriveServiceの初期化が正しく行われることを確認
   - 必要なフィールドが適切に設定されることを検証

2. TestSaveAndSyncNote
   - ノートの保存機能が正しく動作することを確認
   - ノートファイルの作成とnoteListへの追加を検証

3. TestOfflineToOnlineSync
   - オフライン状態で作成されたノートが
   - オンライン復帰時に正しく同期されることを確認

4. TestConflictResolution
   - ローカルとクラウドでの競合が発生した場合の
   - 競合解決ロジックが正しく動作することを検証
   - より新しい更新時刻を持つバージョンが優先されることを確認

5. TestErrorHandling
   - 認証エラーなどの異常系での動作を確認
   - エラー発生時に適切にオフライン状態に遷移することを検証

6. TestPeriodicSync
   - 定期的な同期処理が正しく動作することを確認
   - クラウドの変更が正しくローカルに反映されることを検証

7. TestNoteOrderSync
   - 複数のノートを作成
   - クラウドで異なる順序に

8. TestNoteOrderConflict
   - ノートの順序変更の競合解決をテストします
*/

package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"google.golang.org/api/drive/v3"
)

// テストヘルパー構造体
type testHelper struct {
	tempDir      string
	notesDir     string
	noteService  *noteService
	driveService DriveService
}

// mockDriveService はDriveServiceのモック実装
type mockDriveService struct {
	ctx             context.Context
	appDataDir      string
	notesDir        string
	noteService     *noteService
	driveSync       DriveSyncService
	driveOps        DriveOperations
	logger          AppLogger
	isTestMode      bool
	operationsQueue *DriveOperationsQueue
}

func (m *mockDriveService) InitializeDrive() error {
	return nil
}

func (m *mockDriveService) AuthorizeDrive() error {
	return nil
}

func (m *mockDriveService) LogoutDrive() error {
	return nil
}

func (m *mockDriveService) CancelLoginDrive() error {
	return nil
}

func (m *mockDriveService) CreateNote(note *Note) error {
	if !m.isTestMode {
		return nil
	}

	// ノートのJSONデータを作成
	noteData, err := json.Marshal(note)
	if err != nil {
		return fmt.Errorf("failed to marshal note: %v", err)
	}

	// DriveOperationsを使用してファイルを作成
	_, err = m.driveOps.CreateFile(
		note.ID+".json",
		noteData,
		"test-folder",
		"application/json",
	)
	if err != nil {
		return fmt.Errorf("failed to create file: %v", err)
	}

	return nil
}

func (m *mockDriveService) UpdateNote(note *Note) error {
	if !m.isTestMode {
		return nil
	}
	return m.driveSync.UpdateNote(m.ctx, note)
}

func (m *mockDriveService) DeleteNoteDrive(noteID string) error {
	if !m.isTestMode {
		return nil
	}
	return m.driveSync.DeleteNote(m.ctx, noteID)
}

func (m *mockDriveService) SyncNotes() error {
	if !m.isTestMode {
		return nil
	}

	// クラウドのノートリストを取得
	syncImpl, ok := m.driveSync.(*driveSyncServiceImpl)
	if !ok {
		return fmt.Errorf("invalid drive sync implementation")
	}

	// 接続状態を確認
	if !syncImpl.IsConnected() {
		return fmt.Errorf("not connected to Google Drive")
	}

	cloudNoteList, err := m.driveSync.DownloadNoteList(m.ctx, "")
	if err != nil {
		return err
	}

	// クラウドのノートをローカルに反映
	if cloudNoteList != nil && len(cloudNoteList.Notes) > 0 {
		// ローカルのノートリストを更新
		m.noteService.noteList = &NoteList{
			Version: cloudNoteList.Version,
			Notes:   make([]NoteMetadata, len(cloudNoteList.Notes)),
		}
		copy(m.noteService.noteList.Notes, cloudNoteList.Notes)

		// 各ノートを同期
		for _, noteMeta := range cloudNoteList.Notes {
			cloudNote, err := m.driveSync.DownloadNote(m.ctx, noteMeta.ID)
			if err != nil {
				return err
			}

			// ローカルのノートを更新
			err = m.noteService.SaveNote(cloudNote)
			if err != nil {
				return err
			}
		}
	}

	return nil
}

func (m *mockDriveService) UpdateNoteList() error {
	if !m.isTestMode {
		return nil
	}
	return nil
}

func (m *mockDriveService) SaveNoteAndUpdateList(note *Note, isCreate bool) error {
	if isCreate {
		return m.CreateNote(note)
	}
	return m.UpdateNote(note)
}

func (m *mockDriveService) NotifyFrontendReady() {
	// テストでは何もしない
}

func (m *mockDriveService) RespondToMigration(choice string) {}

func (m *mockDriveService) IsConnected() bool {
	return true
}

func (m *mockDriveService) IsTestMode() bool {
	return m.isTestMode
}

func (m *mockDriveService) GetDriveOperationsQueue() *DriveOperationsQueue {
	return m.operationsQueue
}

type mockDriveOperations struct {
	service *drive.Service
	mu      sync.RWMutex
	files   map[string][]byte
}

func newMockDriveOperations() *mockDriveOperations {
	return &mockDriveOperations{
		service: &drive.Service{
			BasePath:  "https://www.googleapis.com/drive/v3/",
			UserAgent: "mock-user-agent",
		},
		files: make(map[string][]byte),
	}
}

func (m *mockDriveOperations) GetService() *drive.Service {
	return m.service
}

func (m *mockDriveOperations) CreateFile(name string, content []byte, rootFolderID string, mimeType string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	fileID := fmt.Sprintf("test-file-%s", name)
	m.files[fileID] = content
	return fileID, nil
}

func (m *mockDriveOperations) UpdateFile(fileID string, content []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.files[fileID]; !exists {
		return fmt.Errorf("file not found: %s", fileID)
	}
	m.files[fileID] = content
	return nil
}

func (m *mockDriveOperations) DeleteFile(fileID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.files[fileID]; !exists {
		return fmt.Errorf("file not found: %s", fileID)
	}
	delete(m.files, fileID)
	return nil
}

func (m *mockDriveOperations) GetFileMetadata(fileID string) (*drive.File, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if _, exists := m.files[fileID]; !exists {
		return nil, fmt.Errorf("file not found: %s", fileID)
	}
	return &drive.File{
		Id:           fileID,
		Name:         fmt.Sprintf("test-file-%s", fileID),
		ModifiedTime: time.Now().Format(time.RFC3339),
		Md5Checksum:  "mock-md5",
	}, nil
}

func (m *mockDriveOperations) GetFile(fileID string) (*drive.File, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if _, exists := m.files[fileID]; !exists {
		return nil, fmt.Errorf("file not found: %s", fileID)
	}
	return &drive.File{
		Id:   fileID,
		Name: fmt.Sprintf("test-file-%s", fileID),
	}, nil
}

func (m *mockDriveOperations) DownloadFile(fileID string) ([]byte, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if content, exists := m.files[fileID]; exists {
		return content, nil
	}
	return nil, fmt.Errorf("file not found: %s", fileID)
}

func (m *mockDriveOperations) ListFiles(query string) ([]*drive.File, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	files := make([]*drive.File, 0, len(m.files))
	for fileID := range m.files {
		files = append(files, &drive.File{
			Id:   fileID,
			Name: fmt.Sprintf("test-file-%s", fileID),
		})
	}
	return files, nil
}

func (m *mockDriveOperations) CreateFolder(name string, parentID string) (string, error) {
	return "test-folder-id", nil
}

func (m *mockDriveOperations) GetFileID(fileName string, noteFolderID string, rootFolderID string) (string, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	fileID := fmt.Sprintf("test-file-%s", fileName)
	if _, exists := m.files[fileID]; exists {
		return fileID, nil
	}
	return "", fmt.Errorf("file not found: %s", fileName)
}

func (m *mockDriveOperations) FindLatestFile(files []*drive.File) *drive.File {
	if len(files) == 0 {
		return nil
	}
	return files[0]
}

func (m *mockDriveOperations) CleanupDuplicates(files []*drive.File, keepLatest bool) error {
	return nil
}

func (m *mockDriveOperations) GetStartPageToken() (string, error) {
	return "mock-start-token-1", nil
}

func (m *mockDriveOperations) ListChanges(pageToken string) (*ChangesResult, error) {
	return &ChangesResult{
		Changes:       nil,
		NewStartToken: pageToken,
	}, nil
}

// テストのセットアップ
func setupTest(t *testing.T) *testHelper {
	// テスト用の一時ディレクトリを作成
	tempDir, err := os.MkdirTemp("", "drive_service_test")
	if err != nil {
		t.Fatalf("一時ディレクトリの作成に失敗: %v", err)
	}

	// ノート保存用のディレクトリを作成
	notesDir := filepath.Join(tempDir, "notes")
	if err := os.MkdirAll(notesDir, 0755); err != nil {
		t.Fatalf("ノートディレクトリの作成に失敗: %v", err)
	}

	ctx := context.Background()

	// driveOpsの初期化
	driveOps := newMockDriveOperations()

	logger := NewAppLogger(ctx, true, tempDir)

	// noteServiceの初期化
	noteService, err := NewNoteService(notesDir, logger)
	if err != nil {
		t.Fatalf("Failed to create note service: %v", err)
	}

	// driveServiceの初期化（テストモード）
	ds := &mockDriveService{
		ctx:         ctx,
		appDataDir:  tempDir,
		notesDir:    notesDir,
		noteService: noteService,
		logger:      NewAppLogger(ctx, true, tempDir),
		isTestMode:  true,
		driveOps:    driveOps,
	}

	// driveSyncServiceを初期化
	syncService := NewDriveSyncService(
		driveOps,
		"test-folder",
		"test-root",
		logger,
	)

	ds.driveSync = syncService

	// キューシステムの初期化
	ds.operationsQueue = NewDriveOperationsQueue(driveOps, nil)

	return &testHelper{
		tempDir:      tempDir,
		notesDir:     notesDir,
		noteService:  noteService,
		driveService: ds,
	}
}

// テストのクリーンアップ
func (h *testHelper) cleanup() {
	os.RemoveAll(h.tempDir)
}

// TestNewDriveService はDriveServiceの初期化をテストします
func TestNewDriveService(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	assert.NotNil(t, helper.driveService)
	assert.NotNil(t, helper.noteService)
	assert.Equal(t, helper.notesDir, helper.noteService.notesDir)
}

// TestSaveAndSyncNote はノートの保存と同期をテストします
func TestSaveAndSyncNote(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	// テスト用のノートを作成
	note := &Note{
		ID:       "test-note-1",
		Title:    "Test Note",
		Content:  "This is a test note",
		Language: "plaintext",
	}

	// ノートを保存
	err := helper.noteService.SaveNote(note)
	assert.NoError(t, err)

	// ノートファイルが作成されたことを確認
	notePath := filepath.Join(helper.notesDir, note.ID+".json")
	_, err = os.Stat(notePath)
	assert.NoError(t, err)

	// noteListに追加されたことを確認
	assert.Equal(t, 1, len(helper.noteService.noteList.Notes))
	assert.Equal(t, note.ID, helper.noteService.noteList.Notes[0].ID)
	assert.Equal(t, note.Title, helper.noteService.noteList.Notes[0].Title)
}

// TestOfflineToOnlineSync はオフライン→オンライン同期をテストします
func TestOfflineToOnlineSync(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	// オフライン状態でノートを作成
	offlineNote := &Note{
		ID:           "offline-note",
		Title:        "オフラインノート",
		Content:      "オフライン状態で作成されたノート",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}

	// オフライン状態でノートを保存
	err := helper.noteService.SaveNote(offlineNote)
	assert.NoError(t, err)

	// オンライン状態に遷移
	ds, ok := helper.driveService.(*mockDriveService)
	assert.True(t, ok)

	syncImpl, ok := ds.driveSync.(*driveSyncServiceImpl)
	assert.True(t, ok)

	// オンライン状態に設定
	syncImpl.isConnected = true

	// 同期を実行
	err = ds.driveSync.CreateNote(context.Background(), offlineNote)
	assert.NoError(t, err)

	// ノートが同期されたことを確認
	assert.True(t, syncImpl.isConnected)
}

// TestErrorHandling はエラー処理をテストします
func TestErrorHandling(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	// 認証エラーをシミュレート
	ds, ok := helper.driveService.(*mockDriveService)
	assert.True(t, ok)

	syncImpl, ok := ds.driveSync.(*driveSyncServiceImpl)
	assert.True(t, ok)

	// オフライン状態に設定
	syncImpl.SetConnected(false)

	// 同期を試行
	err := helper.driveService.SyncNotes()
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not connected")

	// オフライン状態が維持されることを確認
	assert.False(t, syncImpl.IsConnected())
}

// TestNoteOrderSync はノートの順序変更をテストします
func TestNoteOrderSync(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	// 複数のテストノートを作成
	notes := []*Note{
		{
			ID:       "note-1",
			Title:    "First Note",
			Content:  "Content 1",
			Language: "plaintext",
		},
		{
			ID:       "note-2",
			Title:    "Second Note",
			Content:  "Content 2",
			Language: "plaintext",
		},
		{
			ID:       "note-3",
			Title:    "Third Note",
			Content:  "Content 3",
			Language: "plaintext",
		},
	}

	// ノートを保存
	for _, note := range notes {
		err := helper.noteService.SaveNote(note)
		assert.NoError(t, err)
	}

	// ノートの順序を変更
	err := helper.noteService.UpdateNoteOrder("note-2", 0)
	assert.NoError(t, err)

	// 順序が正しく変更されたことを確認
	assert.Equal(t, "note-2", helper.noteService.noteList.Notes[0].ID)
}

func TestFileIDCache_RefreshBuildsCache(t *testing.T) {
	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, t.TempDir())
	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	noteData := []byte(`{"id":"note-a","title":"A"}`)
	mockOps.CreateFile("note-a.json", noteData, "test-folder", "application/json")
	mockOps.CreateFile("note-b.json", noteData, "test-folder", "application/json")

	err := syncService.RefreshFileIDCache(context.Background())
	assert.NoError(t, err)

	impl := syncService.(*driveSyncServiceImpl)
	impl.cacheMu.RLock()
	defer impl.cacheMu.RUnlock()
	assert.True(t, len(impl.fileIDCache) >= 2, "cache should have at least 2 entries")
}

func TestFileIDCache_HitAvoidsDriveCall(t *testing.T) {
	countingOps := &countingDriveOps{mockDriveOperations: newMockDriveOperations()}
	logger := NewAppLogger(context.Background(), true, t.TempDir())
	syncService := NewDriveSyncService(countingOps, "test-folder", "test-root", logger)

	impl := syncService.(*driveSyncServiceImpl)
	impl.setCachedFileID("cached-note", "drive-file-xyz")

	fileID, err := syncService.GetNoteID(context.Background(), "cached-note")
	assert.NoError(t, err)
	assert.Equal(t, "drive-file-xyz", fileID)
	assert.Equal(t, 0, countingOps.getFileIDCount, "GetFileID should not be called on cache hit")
}

func TestFileIDCache_MissFallsBackToDriveCall(t *testing.T) {
	countingOps := &countingDriveOps{mockDriveOperations: newMockDriveOperations()}

	noteData, _ := json.Marshal(&Note{ID: "uncached-note", Title: "Test"})
	_, _ = countingOps.CreateFile("uncached-note.json", noteData, "test-folder", "application/json")

	logger := NewAppLogger(context.Background(), true, t.TempDir())
	syncService := NewDriveSyncService(countingOps, "test-folder", "test-root", logger)

	fileID, err := syncService.GetNoteID(context.Background(), "uncached-note")
	assert.NoError(t, err)
	assert.NotEmpty(t, fileID)
	assert.Equal(t, 1, countingOps.getFileIDCount, "GetFileID should be called once on cache miss")

	impl := syncService.(*driveSyncServiceImpl)
	cached, ok := impl.getCachedFileID("uncached-note")
	assert.True(t, ok, "miss result should be cached")
	assert.Equal(t, fileID, cached)
}

func TestFileIDCache_CreateNotePopulatesCache(t *testing.T) {
	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, t.TempDir())
	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	note := &Note{ID: "new-note", Title: "New", Content: "content"}
	err := syncService.CreateNote(context.Background(), note)
	assert.NoError(t, err)

	impl := syncService.(*driveSyncServiceImpl)
	cached, ok := impl.getCachedFileID("new-note")
	assert.True(t, ok)
	assert.NotEmpty(t, cached)
}

func TestFileIDCache_DeleteNoteRemovesFromCache(t *testing.T) {
	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, t.TempDir())
	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	note := &Note{ID: "del-note", Title: "Del", Content: "content"}
	err := syncService.CreateNote(context.Background(), note)
	assert.NoError(t, err)

	impl := syncService.(*driveSyncServiceImpl)
	_, ok := impl.getCachedFileID("del-note")
	assert.True(t, ok, "should be cached after create")

	err = syncService.DeleteNote(context.Background(), "del-note")
	assert.NoError(t, err)

	_, ok = impl.getCachedFileID("del-note")
	assert.False(t, ok, "should be removed from cache after delete")
}

type countingDriveOps struct {
	*mockDriveOperations
	getFileIDCount int
}

func (c *countingDriveOps) GetFileID(fileName string, noteFolderID string, rootFolderID string) (string, error) {
	c.getFileIDCount++
	return c.mockDriveOperations.GetFileID(fileName, noteFolderID, rootFolderID)
}

type changesTrackingOps struct {
	*mockDriveOperations
	getStartPageTokenCount int
	listChangesCount       int
	changesToReturn        []*drive.Change
	nextToken              string
}

func (c *changesTrackingOps) GetStartPageToken() (string, error) {
	c.getStartPageTokenCount++
	return "test-page-token-1", nil
}

func (c *changesTrackingOps) ListChanges(pageToken string) (*ChangesResult, error) {
	c.listChangesCount++
	token := c.nextToken
	if token == "" {
		token = "test-page-token-2"
	}
	return &ChangesResult{
		Changes:       c.changesToReturn,
		NewStartToken: token,
	}, nil
}

func TestChangesAPI_GetStartPageToken(t *testing.T) {
	ops := &changesTrackingOps{mockDriveOperations: newMockDriveOperations()}

	token, err := ops.GetStartPageToken()
	assert.NoError(t, err)
	assert.Equal(t, "test-page-token-1", token)
	assert.Equal(t, 1, ops.getStartPageTokenCount)
}

func TestChangesAPI_ListChangesNoChanges(t *testing.T) {
	ops := &changesTrackingOps{
		mockDriveOperations: newMockDriveOperations(),
		changesToReturn:     nil,
		nextToken:           "token-after",
	}

	result, err := ops.ListChanges("token-before")
	assert.NoError(t, err)
	assert.Empty(t, result.Changes)
	assert.Equal(t, "token-after", result.NewStartToken)
}

func TestChangesAPI_ListChangesWithRelevantChanges(t *testing.T) {
	ops := &changesTrackingOps{
		mockDriveOperations: newMockDriveOperations(),
		changesToReturn: []*drive.Change{
			{
				FileId: "file-abc",
				File: &drive.File{
					Id:      "file-abc",
					Name:    "noteList.json",
					Parents: []string{"root-folder-id"},
				},
			},
			{
				FileId: "file-xyz",
				File: &drive.File{
					Id:      "file-xyz",
					Name:    "note-123.json",
					Parents: []string{"notes-folder-id"},
				},
			},
		},
		nextToken: "token-updated",
	}

	result, err := ops.ListChanges("token-initial")
	assert.NoError(t, err)
	assert.Len(t, result.Changes, 2)
	assert.Equal(t, "token-updated", result.NewStartToken)
	assert.Equal(t, "noteList.json", result.Changes[0].File.Name)
	assert.Equal(t, "note-123.json", result.Changes[1].File.Name)
}

func TestChangesAPI_QueueDelegation(t *testing.T) {
	ops := &changesTrackingOps{
		mockDriveOperations: newMockDriveOperations(),
		nextToken:           "delegated-token",
	}
	queue := NewDriveOperationsQueue(ops, nil)
	defer queue.Cleanup()

	token, err := queue.GetStartPageToken()
	assert.NoError(t, err)
	assert.Equal(t, "test-page-token-1", token)
	assert.Equal(t, 1, ops.getStartPageTokenCount)

	result, err := queue.ListChanges("some-token")
	assert.NoError(t, err)
	assert.Equal(t, "delegated-token", result.NewStartToken)
	assert.Equal(t, 1, ops.listChangesCount)
}

func TestHasRelevantChanges_NoChanges(t *testing.T) {
	assert.False(t, hasRelevantChanges(nil, "root-id", "notes-id"))
	assert.False(t, hasRelevantChanges([]*drive.Change{}, "root-id", "notes-id"))
}

func TestHasRelevantChanges_FileInRootFolder(t *testing.T) {
	changes := []*drive.Change{
		{
			FileId: "file-1",
			File: &drive.File{
				Id:      "file-1",
				Name:    "noteList.json",
				Parents: []string{"root-id"},
			},
		},
	}
	assert.True(t, hasRelevantChanges(changes, "root-id", "notes-id"))
}

func TestHasRelevantChanges_FileInNotesFolder(t *testing.T) {
	changes := []*drive.Change{
		{
			FileId: "file-2",
			File: &drive.File{
				Id:      "file-2",
				Name:    "abc123.json",
				Parents: []string{"notes-id"},
			},
		},
	}
	assert.True(t, hasRelevantChanges(changes, "root-id", "notes-id"))
}

func TestHasRelevantChanges_UnrelatedFolder(t *testing.T) {
	changes := []*drive.Change{
		{
			FileId: "file-3",
			File: &drive.File{
				Id:      "file-3",
				Name:    "photo.jpg",
				Parents: []string{"some-other-folder"},
			},
		},
	}
	assert.False(t, hasRelevantChanges(changes, "root-id", "notes-id"))
}

func TestHasRelevantChanges_JSONFileOutsideOurFolders(t *testing.T) {
	changes := []*drive.Change{
		{
			FileId: "file-4",
			File: &drive.File{
				Id:      "file-4",
				Name:    "config.json",
				Parents: []string{"unrelated-folder"},
			},
		},
	}
	assert.True(t, hasRelevantChanges(changes, "root-id", "notes-id"),
		".json files are treated as potentially relevant even outside our folders")
}

func TestHasRelevantChanges_NilFile(t *testing.T) {
	changes := []*drive.Change{
		{FileId: "file-5", File: nil},
	}
	assert.False(t, hasRelevantChanges(changes, "root-id", "notes-id"))
}

func TestHasRelevantChanges_MixedChanges(t *testing.T) {
	changes := []*drive.Change{
		{FileId: "file-a", File: nil},
		{
			FileId: "file-b",
			File: &drive.File{
				Id:      "file-b",
				Name:    "vacation.png",
				Parents: []string{"photos-folder"},
			},
		},
		{
			FileId: "file-c",
			File: &drive.File{
				Id:      "file-c",
				Name:    "note-xyz.json",
				Parents: []string{"notes-id"},
			},
		},
	}
	assert.True(t, hasRelevantChanges(changes, "root-id", "notes-id"),
		"should detect relevant change even when mixed with irrelevant ones")
}

func TestFindLatestFile_SortsByModifiedTime(t *testing.T) {
	logger := NewAppLogger(context.Background(), true, t.TempDir())
	ops := &driveOperationsImpl{service: nil, logger: logger}

	oldCreated := time.Now().Add(-3 * time.Hour)
	newCreated := time.Now().Add(-1 * time.Hour)
	oldModified := time.Now().Add(-2 * time.Hour)
	newModified := time.Now()

	files := []*drive.File{
		{
			Id:           "file-old-created-new-modified",
			Name:         "note.json",
			CreatedTime:  oldCreated.Format(time.RFC3339),
			ModifiedTime: newModified.Format(time.RFC3339),
		},
		{
			Id:           "file-new-created-old-modified",
			Name:         "note.json",
			CreatedTime:  newCreated.Format(time.RFC3339),
			ModifiedTime: oldModified.Format(time.RFC3339),
		},
	}

	latest := ops.FindLatestFile(files)
	assert.Equal(t, "file-old-created-new-modified", latest.Id,
		"modifiedTimeが最新のファイルが返されるべき（createdTimeではなく）")
}

func TestFindLatestFile_ReturnsNilForEmptySlice(t *testing.T) {
	logger := NewAppLogger(context.Background(), true, t.TempDir())
	ops := &driveOperationsImpl{service: nil, logger: logger}

	assert.Nil(t, ops.FindLatestFile(nil))
	assert.Nil(t, ops.FindLatestFile([]*drive.File{}))
}

func TestFindLatestFile_SingleFile(t *testing.T) {
	logger := NewAppLogger(context.Background(), true, t.TempDir())
	ops := &driveOperationsImpl{service: nil, logger: logger}

	f := &drive.File{Id: "only", ModifiedTime: time.Now().Format(time.RFC3339)}
	assert.Equal(t, "only", ops.FindLatestFile([]*drive.File{f}).Id)
}

func TestFindLatestFile_ThreeFiles_CorrectOrder(t *testing.T) {
	logger := NewAppLogger(context.Background(), true, t.TempDir())
	ops := &driveOperationsImpl{service: nil, logger: logger}

	files := []*drive.File{
		{Id: "oldest", ModifiedTime: time.Now().Add(-3 * time.Hour).Format(time.RFC3339)},
		{Id: "newest", ModifiedTime: time.Now().Format(time.RFC3339)},
		{Id: "middle", ModifiedTime: time.Now().Add(-1 * time.Hour).Format(time.RFC3339)},
	}

	latest := ops.FindLatestFile(files)
	assert.Equal(t, "newest", latest.Id)
	assert.Equal(t, "newest", files[0].Id, "FindLatestFile後のスライスはmodifiedTime降順にソートされるべき")
	assert.Equal(t, "oldest", files[2].Id)
}

func TestSaveNoteAndUpdateList_CreateSuccess_ListUpdated(t *testing.T) {
	ds, recorder, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	mockOps, ok := rawOps.(*mockDriveOperations)
	if !assert.True(t, ok) {
		return
	}

	note := &Note{
		ID:           "d1-create-note",
		Title:        "D1 create",
		Content:      "create content",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	assert.NoError(t, ds.noteService.SaveNote(note))

	noteListID := ds.auth.GetDriveSync().NoteListID()
	cloudNoteList, err := json.Marshal(&NoteList{Version: "1.0", Notes: []NoteMetadata{}})
	assert.NoError(t, err)
	mockOps.mu.Lock()
	mockOps.files[noteListID] = cloudNoteList
	mockOps.mu.Unlock()

	err = ds.SaveNoteAndUpdateList(note, true)
	assert.NoError(t, err)

	mockOps.mu.RLock()
	noteData, exists := mockOps.files["test-file-"+note.ID+".json"]
	mockOps.mu.RUnlock()
	assert.True(t, exists, "作成ノートがDriveに存在するべき")

	var savedNote Note
	err = json.Unmarshal(noteData, &savedNote)
	assert.NoError(t, err)
	assert.Equal(t, note.ID, savedNote.ID)

	statuses := recorder.statusCalls()
	assert.Contains(t, statuses, "syncing")
	assert.Contains(t, statuses, "synced")
}

func TestSaveNoteAndUpdateList_UpdateSuccess_ListUpdated(t *testing.T) {
	ds, recorder, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	mockOps, ok := rawOps.(*mockDriveOperations)
	if !assert.True(t, ok) {
		return
	}

	note := &Note{
		ID:           "d2-update-note",
		Title:        "D2 update",
		Content:      "before update",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	assert.NoError(t, ds.noteService.SaveNote(note))

	noteData, err := json.Marshal(note)
	assert.NoError(t, err)
	fileID, err := mockOps.CreateFile(note.ID+".json", noteData, "test-folder", "application/json")
	assert.NoError(t, err)

	syncImpl, ok := ds.driveSync.(*driveSyncServiceImpl)
	if !assert.True(t, ok) {
		return
	}
	syncImpl.setCachedFileID(note.ID, fileID)

	noteListID := ds.auth.GetDriveSync().NoteListID()
	cloudNoteList, err := json.Marshal(&NoteList{Version: "1.0", Notes: []NoteMetadata{}})
	assert.NoError(t, err)
	mockOps.mu.Lock()
	mockOps.files[noteListID] = cloudNoteList
	mockOps.mu.Unlock()

	note.Content = "after update"
	err = ds.SaveNoteAndUpdateList(note, false)
	assert.NoError(t, err)

	mockOps.mu.RLock()
	updatedData, exists := mockOps.files[fileID]
	mockOps.mu.RUnlock()
	assert.True(t, exists, "更新対象ノートがDriveに存在するべき")

	var updated Note
	err = json.Unmarshal(updatedData, &updated)
	assert.NoError(t, err)
	assert.Equal(t, "after update", updated.Content)

	statuses := recorder.statusCalls()
	assert.Contains(t, statuses, "syncing")
	assert.Contains(t, statuses, "synced")
}

func TestSaveNoteAndUpdateList_CreateFails_ListNotUpdated(t *testing.T) {
	ds, recorder, _, cleanup := newNotificationTestDriveService(t, func() DriveOperations {
		return &failingCreateDriveOps{
			mockDriveOperations: newMockDriveOperations(),
			failFileNames:       map[string]bool{"d3-fail-note.json": true},
		}
	})
	defer cleanup()

	note := &Note{
		ID:           "d3-fail-note",
		Title:        "D3 fail",
		Content:      "should fail",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	assert.NoError(t, ds.noteService.SaveNote(note))

	err := ds.SaveNoteAndUpdateList(note, true)
	assert.Error(t, err)

	statuses := recorder.statusCalls()
	assert.NotContains(t, statuses, "syncing")
	assert.NotContains(t, statuses, "synced")
}

func TestSaveNoteAndUpdateList_SaveNoteListFails(t *testing.T) {
	ds, recorder, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	mockOps, ok := rawOps.(*mockDriveOperations)
	if !assert.True(t, ok) {
		return
	}

	note := &Note{
		ID:           "d4-save-list-fail",
		Title:        "D4 fail",
		Content:      "create succeeds but save list fails",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}

	brokenNotesDir := filepath.Join(t.TempDir(), "missing-parent", "notes")
	ds.noteService.notesDir = brokenNotesDir

	err := ds.SaveNoteAndUpdateList(note, true)
	assert.Error(t, err)

	mockOps.mu.RLock()
	_, exists := mockOps.files["test-file-"+note.ID+".json"]
	mockOps.mu.RUnlock()
	assert.True(t, exists, "saveNoteList失敗でもCreate自体は成功しているべき")

	statuses := recorder.statusCalls()
	assert.NotContains(t, statuses, "syncing")
	assert.NotContains(t, statuses, "synced")
}

func TestSaveNoteAndUpdateList_MutualExclusionWithSyncNotes(t *testing.T) {
	ds, _, rawOps, cleanup := newNotificationTestDriveService(t, func() DriveOperations {
		return newBlockingDriveOps()
	})
	defer cleanup()

	ops, ok := rawOps.(*blockingDriveOps)
	if !assert.True(t, ok) {
		return
	}

	note := &Note{
		ID:           "d7-mutex-note",
		Title:        "D7 mutex",
		Content:      "mutex test",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	assert.NoError(t, ds.noteService.SaveNote(note))

	noteListID := ds.auth.GetDriveSync().NoteListID()
	cloudNoteList, err := json.Marshal(&NoteList{Version: "1.0", Notes: []NoteMetadata{}})
	assert.NoError(t, err)
	ops.mu.Lock()
	ops.files[noteListID] = cloudNoteList
	ops.mu.Unlock()

	saveDone := make(chan struct{})
	syncDone := make(chan struct{})

	var saveErr error
	var syncErr error
	var saveFinishedAt time.Time
	var syncFinishedAt time.Time

	go func() {
		saveErr = ds.SaveNoteAndUpdateList(note, true)
		saveFinishedAt = time.Now()
		close(saveDone)
	}()

	select {
	case <-ops.startedCh:
	case <-time.After(5 * time.Second):
		t.Fatal("SaveNoteAndUpdateList did not reach CreateFile")
	}

	go func() {
		syncErr = ds.SyncNotes()
		syncFinishedAt = time.Now()
		close(syncDone)
	}()

	select {
	case <-syncDone:
		t.Fatal("SyncNotes should block while SaveNoteAndUpdateList holds syncMu")
	case <-time.After(200 * time.Millisecond):
	}

	close(ops.blockCh)

	select {
	case <-saveDone:
	case <-time.After(5 * time.Second):
		t.Fatal("SaveNoteAndUpdateList did not complete")
	}

	select {
	case <-syncDone:
	case <-time.After(5 * time.Second):
		t.Fatal("SyncNotes did not complete after SaveNoteAndUpdateList")
	}

	assert.NoError(t, saveErr)
	assert.NoError(t, syncErr)
	assert.True(t, syncFinishedAt.After(saveFinishedAt), "SyncNotesはSaveNoteAndUpdateList完了後に終了するべき")
}

func TestSaveNoteAndUpdateList_Cancelled_ReturnsNil(t *testing.T) {
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
		ID:           "d5-cancelled-note",
		Title:        "D5 cancelled",
		Content:      "cancelled create",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}

	err := ds.SaveNoteAndUpdateList(note, true)
	assert.NoError(t, err)

	statuses := recorder.statusCalls()
	assert.NotContains(t, statuses, "syncing")
	assert.NotContains(t, statuses, "synced")
}

func TestSaveNoteAndUpdateList_NotConnected_Error(t *testing.T) {
	ds, _, _, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	ds.auth.GetDriveSync().SetConnected(false)

	note := &Note{
		ID:           "d6-not-connected-note",
		Title:        "D6 offline",
		Content:      "offline save",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}

	err := ds.SaveNoteAndUpdateList(note, true)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not connected")
}

func TestRecoverOrphanCloudNotes_DownloadsAndRestores(t *testing.T) {
	ds, _, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	mockOps := rawOps.(*mockDriveOperations)

	existingNote := &Note{ID: "existing-note", Title: "Existing", Content: "already here", Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339)}
	assert.NoError(t, ds.noteService.SaveNote(existingNote))

	orphan1 := &Note{ID: "cloud-orphan-1", Title: "Cloud Orphan 1", Content: "content1", Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339)}
	orphan2 := &Note{ID: "cloud-orphan-2", Title: "Cloud Orphan 2", Content: "content2", Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339)}
	data1, _ := json.Marshal(orphan1)
	data2, _ := json.Marshal(orphan2)

	mockOps.mu.Lock()
	mockOps.files["drive-orphan-1"] = data1
	mockOps.files["drive-orphan-2"] = data2
	mockOps.mu.Unlock()

	driveFiles := []*drive.File{
		{Id: "drive-existing", Name: "existing-note.json", ModifiedTime: time.Now().Format(time.RFC3339)},
		{Id: "drive-orphan-1", Name: "cloud-orphan-1.json", ModifiedTime: time.Now().Format(time.RFC3339)},
		{Id: "drive-orphan-2", Name: "cloud-orphan-2.json", ModifiedTime: time.Now().Format(time.RFC3339)},
	}

	count, err := ds.recoverOrphanCloudNotes(driveFiles, ds.driveOps)
	assert.NoError(t, err)
	assert.Equal(t, 2, count)

	assert.Len(t, ds.noteService.noteList.Notes, 3)

	var cloudFolderID string
	for _, f := range ds.noteService.noteList.Folders {
		if f.Name == RecoveryFolderName {
			cloudFolderID = f.ID
			break
		}
	}
	assert.NotEmpty(t, cloudFolderID)

	orphanCount := 0
	for _, m := range ds.noteService.noteList.Notes {
		if m.FolderID == cloudFolderID {
			orphanCount++
		}
	}
	assert.Equal(t, 2, orphanCount)
}

func TestRecoverOrphanCloudNotes_SkipsCorrupted(t *testing.T) {
	ds, _, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	mockOps := rawOps.(*mockDriveOperations)
	mockOps.mu.Lock()
	mockOps.files["drive-corrupt"] = []byte("{invalid json")
	mockOps.mu.Unlock()

	driveFiles := []*drive.File{
		{Id: "drive-corrupt", Name: "corrupted.json", ModifiedTime: time.Now().Format(time.RFC3339)},
	}

	count, err := ds.recoverOrphanCloudNotes(driveFiles, ds.driveOps)
	assert.NoError(t, err)
	assert.Equal(t, 0, count)
	assert.Empty(t, ds.noteService.noteList.Notes)
}

func TestRecoverOrphanCloudNotes_NoOrphans(t *testing.T) {
	ds, _, _, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	existingNote := &Note{ID: "only-note", Title: "Only", Content: "here", Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339)}
	assert.NoError(t, ds.noteService.SaveNote(existingNote))

	driveFiles := []*drive.File{
		{Id: "drive-only", Name: "only-note.json", ModifiedTime: time.Now().Format(time.RFC3339)},
	}

	count, err := ds.recoverOrphanCloudNotes(driveFiles, ds.driveOps)
	assert.NoError(t, err)
	assert.Equal(t, 0, count)
}

func TestRecoverOrphanCloudNotes_DeletesDuplicateConflictCopy(t *testing.T) {
	ds, _, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	mockOps := rawOps.(*mockDriveOperations)

	existingNote := &Note{ID: "original", Title: "My Note", Content: "same content", Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339)}
	assert.NoError(t, ds.noteService.SaveNote(existingNote))

	conflictNote := &Note{ID: "conflict-1", Title: "My Note - conflict copy", Content: "same content", Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339)}
	data, _ := json.Marshal(conflictNote)

	mockOps.mu.Lock()
	mockOps.files["drive-conflict-1"] = data
	mockOps.mu.Unlock()

	driveFiles := []*drive.File{
		{Id: "drive-original", Name: "original.json", ModifiedTime: time.Now().Format(time.RFC3339)},
		{Id: "drive-conflict-1", Name: "conflict-1.json", ModifiedTime: time.Now().Format(time.RFC3339)},
	}

	count, err := ds.recoverOrphanCloudNotes(driveFiles, ds.driveOps)
	assert.NoError(t, err)
	assert.Equal(t, 0, count)

	assert.Len(t, ds.noteService.noteList.Notes, 1)

	mockOps.mu.RLock()
	_, exists := mockOps.files["drive-conflict-1"]
	mockOps.mu.RUnlock()
	assert.False(t, exists, "duplicate conflict copy should be deleted from Drive")
}

func TestRecoverOrphanCloudNotes_RecoversUniqueConflictCopy(t *testing.T) {
	ds, _, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	mockOps := rawOps.(*mockDriveOperations)

	existingNote := &Note{ID: "original", Title: "My Note", Content: "original content", Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339)}
	assert.NoError(t, ds.noteService.SaveNote(existingNote))

	conflictNote := &Note{ID: "conflict-unique", Title: "My Note - conflict copy", Content: "different content", Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339)}
	data, _ := json.Marshal(conflictNote)

	mockOps.mu.Lock()
	mockOps.files["drive-conflict-unique"] = data
	mockOps.mu.Unlock()

	driveFiles := []*drive.File{
		{Id: "drive-original", Name: "original.json", ModifiedTime: time.Now().Format(time.RFC3339)},
		{Id: "drive-conflict-unique", Name: "conflict-unique.json", ModifiedTime: time.Now().Format(time.RFC3339)},
	}

	count, err := ds.recoverOrphanCloudNotes(driveFiles, ds.driveOps)
	assert.NoError(t, err)
	assert.Equal(t, 1, count)

	assert.Len(t, ds.noteService.noteList.Notes, 2)

	var recoveryFolderID string
	for _, f := range ds.noteService.noteList.Folders {
		if f.Name == RecoveryFolderName {
			recoveryFolderID = f.ID
			break
		}
	}
	assert.NotEmpty(t, recoveryFolderID)

	found := false
	for _, m := range ds.noteService.noteList.Notes {
		if m.ID == "conflict-unique" && m.FolderID == recoveryFolderID {
			found = true
			break
		}
	}
	assert.True(t, found, "unique conflict copy should be recovered to recovery folder")
}

func TestRecoverOrphanCloudNotes_MixedConflictAndRegularOrphans(t *testing.T) {
	ds, _, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	mockOps := rawOps.(*mockDriveOperations)

	existingNote := &Note{ID: "original", Title: "My Note", Content: "same content", Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339)}
	assert.NoError(t, ds.noteService.SaveNote(existingNote))

	duplicateConflict := &Note{ID: "dup-conflict", Title: "My Note - conflict copy", Content: "same content", Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339)}
	uniqueConflict := &Note{ID: "unique-conflict", Title: "My Note - conflict copy 2", Content: "unique content", Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339)}
	regularOrphan := &Note{ID: "regular-orphan", Title: "Regular Orphan", Content: "orphan content", Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339)}

	dataDup, _ := json.Marshal(duplicateConflict)
	dataUnique, _ := json.Marshal(uniqueConflict)
	dataRegular, _ := json.Marshal(regularOrphan)

	mockOps.mu.Lock()
	mockOps.files["drive-dup"] = dataDup
	mockOps.files["drive-unique"] = dataUnique
	mockOps.files["drive-regular"] = dataRegular
	mockOps.mu.Unlock()

	driveFiles := []*drive.File{
		{Id: "drive-original", Name: "original.json", ModifiedTime: time.Now().Format(time.RFC3339)},
		{Id: "drive-dup", Name: "dup-conflict.json", ModifiedTime: time.Now().Format(time.RFC3339)},
		{Id: "drive-unique", Name: "unique-conflict.json", ModifiedTime: time.Now().Format(time.RFC3339)},
		{Id: "drive-regular", Name: "regular-orphan.json", ModifiedTime: time.Now().Format(time.RFC3339)},
	}

	count, err := ds.recoverOrphanCloudNotes(driveFiles, ds.driveOps)
	assert.NoError(t, err)
	assert.Equal(t, 2, count)

	assert.Len(t, ds.noteService.noteList.Notes, 3)

	mockOps.mu.RLock()
	_, dupExists := mockOps.files["drive-dup"]
	mockOps.mu.RUnlock()
	assert.False(t, dupExists, "duplicate conflict copy should be deleted from Drive")

	ids := make(map[string]bool)
	for _, m := range ds.noteService.noteList.Notes {
		ids[m.ID] = true
	}
	assert.True(t, ids["original"])
	assert.True(t, ids["unique-conflict"])
	assert.True(t, ids["regular-orphan"])
	assert.False(t, ids["dup-conflict"])
}

func TestRecoverOrphanCloudNotes_DeduplicatesMultipleConflictCopies(t *testing.T) {
	ds, _, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	mockOps := rawOps.(*mockDriveOperations)

	conflict1 := &Note{ID: "conflict-a", Title: "Note - conflict copy", Content: "identical", Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339)}
	conflict2 := &Note{ID: "conflict-b", Title: "Note - conflict copy 2", Content: "identical", Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339)}

	data1, _ := json.Marshal(conflict1)
	data2, _ := json.Marshal(conflict2)

	mockOps.mu.Lock()
	mockOps.files["drive-a"] = data1
	mockOps.files["drive-b"] = data2
	mockOps.mu.Unlock()

	driveFiles := []*drive.File{
		{Id: "drive-a", Name: "conflict-a.json", ModifiedTime: time.Now().Format(time.RFC3339)},
		{Id: "drive-b", Name: "conflict-b.json", ModifiedTime: time.Now().Format(time.RFC3339)},
	}

	count, err := ds.recoverOrphanCloudNotes(driveFiles, ds.driveOps)
	assert.NoError(t, err)
	assert.Equal(t, 1, count)

	assert.Len(t, ds.noteService.noteList.Notes, 1)

	mockOps.mu.RLock()
	_, aExists := mockOps.files["drive-a"]
	_, bExists := mockOps.files["drive-b"]
	mockOps.mu.RUnlock()

	deletedCount := 0
	if !aExists {
		deletedCount++
	}
	if !bExists {
		deletedCount++
	}
	assert.Equal(t, 1, deletedCount, "exactly one of the two identical conflict copies should be deleted from Drive")
}

func TestRecoverOrphanCloudNotes_DeletesSameIDDuplicatesFromDrive(t *testing.T) {
	ds, _, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	mockOps := rawOps.(*mockDriveOperations)

	orphanNote := &Note{ID: "dup-note", Title: "Duplicated", Content: "content", Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339)}
	data, _ := json.Marshal(orphanNote)

	mockOps.mu.Lock()
	mockOps.files["drive-dup-old"] = data
	mockOps.files["drive-dup-new"] = data
	mockOps.mu.Unlock()

	now := time.Now()
	driveFiles := []*drive.File{
		{Id: "drive-dup-old", Name: "dup-note.json", ModifiedTime: now.Add(-1 * time.Hour).Format(time.RFC3339)},
		{Id: "drive-dup-new", Name: "dup-note.json", ModifiedTime: now.Format(time.RFC3339)},
	}

	count, err := ds.recoverOrphanCloudNotes(driveFiles, ds.driveOps)
	assert.NoError(t, err)
	assert.Equal(t, 1, count)

	mockOps.mu.RLock()
	_, oldExists := mockOps.files["drive-dup-old"]
	_, newExists := mockOps.files["drive-dup-new"]
	mockOps.mu.RUnlock()
	assert.False(t, oldExists, "older same-ID duplicate should be deleted from Drive")
	assert.True(t, newExists, "latest same-ID file should be kept in Drive")

	assert.Len(t, ds.noteService.noteList.Notes, 1)
	assert.Equal(t, "dup-note", ds.noteService.noteList.Notes[0].ID)
}

func TestRecoverOrphanCloudNotes_SameIDDuplicatesForExistingNoteAreDeleted(t *testing.T) {
	ds, _, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	mockOps := rawOps.(*mockDriveOperations)

	existingNote := &Note{ID: "my-note", Title: "My Note", Content: "content", Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339)}
	assert.NoError(t, ds.noteService.SaveNote(existingNote))

	mockOps.mu.Lock()
	mockOps.files["drive-v1"] = []byte(`{"id":"my-note"}`)
	mockOps.files["drive-v2"] = []byte(`{"id":"my-note"}`)
	mockOps.mu.Unlock()

	now := time.Now()
	driveFiles := []*drive.File{
		{Id: "drive-v1", Name: "my-note.json", ModifiedTime: now.Add(-1 * time.Hour).Format(time.RFC3339)},
		{Id: "drive-v2", Name: "my-note.json", ModifiedTime: now.Format(time.RFC3339)},
	}

	count, err := ds.recoverOrphanCloudNotes(driveFiles, ds.driveOps)
	assert.NoError(t, err)
	assert.Equal(t, 0, count, "existing note should not be recovered again")

	mockOps.mu.RLock()
	_, v1Exists := mockOps.files["drive-v1"]
	_, v2Exists := mockOps.files["drive-v2"]
	mockOps.mu.RUnlock()
	assert.False(t, v1Exists, "older same-ID duplicate should be deleted from Drive")
	assert.True(t, v2Exists, "latest same-ID file should be kept")

	assert.Len(t, ds.noteService.noteList.Notes, 1)
}
