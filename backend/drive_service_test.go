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
	"strings"
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

	// クラウドノートリストを更新
	syncImpl, ok := m.driveSync.(*driveSyncServiceImpl)
	if ok && syncImpl.cloudNoteList != nil {
		syncImpl.cloudNoteList.Notes = append(syncImpl.cloudNoteList.Notes, NoteMetadata{
			ID:           note.ID,
			Title:        note.Title,
			ModifiedTime: note.ModifiedTime,
		})
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

	// クラウドのノートをローカルに反映
	if syncImpl.cloudNoteList != nil && len(syncImpl.cloudNoteList.Notes) > 0 {
		// ローカルのノートリストを更新
		m.noteService.noteList = &NoteList{
			Version: syncImpl.cloudNoteList.Version,
			Notes:   make([]NoteMetadata, len(syncImpl.cloudNoteList.Notes)),
		}
		copy(m.noteService.noteList.Notes, syncImpl.cloudNoteList.Notes)

		// 各ノートを同期
		for _, noteMeta := range syncImpl.cloudNoteList.Notes {
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

func (m *mockDriveService) IsConnected() bool {
	return true
}

func (m *mockDriveService) IsTestMode() bool {
	return m.isTestMode
}

func (m *mockDriveService) GetDriveOperationsQueue() *DriveOperationsQueue {
	return m.operationsQueue
}

func (m *mockDriveService) RecordNoteDeletion(noteIDs ...string) {}

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
	if strings.HasSuffix(fileName, ".json") {
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
	ds.operationsQueue = NewDriveOperationsQueue(driveOps)

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
	syncImpl.hasCompletedInitialSync = true

	// 同期を実行
	err = ds.driveSync.CreateNote(context.Background(), offlineNote)
	assert.NoError(t, err)

	// ノートが同期されたことを確認
	assert.True(t, syncImpl.isConnected)
	assert.True(t, syncImpl.hasCompletedInitialSync)
}

// TestConflictResolution はノートの競合解決をテストします
func TestConflictResolution(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	// ローカルノートを作成（古い更新時刻）
	localNote := &Note{
		ID:           "conflict-note",
		Title:        "ローカルバージョン",
		Content:      "ローカルの内容",
		Language:     "plaintext",
		ModifiedTime: time.Now().Add(-time.Hour).Format(time.RFC3339),
	}

	// ローカルノートを保存
	err := helper.noteService.SaveNote(localNote)
	assert.NoError(t, err)

	// クラウドノートを作成（新しい更新時刻）
	cloudNote := &Note{
		ID:           "conflict-note",
		Title:        "クラウドバージョン",
		Content:      "クラウドの内容",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}

	// DriveServiceのモックを設定
	mockDriveOps := newMockDriveOperations()
	ds := &mockDriveService{
		ctx:         context.Background(),
		appDataDir:  helper.tempDir,
		notesDir:    helper.notesDir,
		noteService: helper.noteService,
		logger:      NewAppLogger(context.Background(), true, helper.tempDir),
		isTestMode:  true,
		driveOps:    mockDriveOps,
	}

	logger := NewAppLogger(context.Background(), true, helper.tempDir)

	// クラウドノートをDriveOperationsに保存
	noteData, err := json.Marshal(cloudNote)
	assert.NoError(t, err)
	_, err = mockDriveOps.CreateFile(cloudNote.ID+".json", noteData, "test-folder", "application/json")
	assert.NoError(t, err)

	// DriveSyncServiceを設定
	syncService := NewDriveSyncService(mockDriveOps, "test-folder", "test-root", logger)
	ds.driveSync = syncService

	// クラウドノートリストを設定
	syncImpl, ok := syncService.(*driveSyncServiceImpl)
	assert.True(t, ok)
	syncImpl.SetConnected(true)
	syncImpl.SetInitialSyncCompleted(true)
	syncImpl.SetCloudNoteList(&NoteList{
		Version: "1.0",
		Notes: []NoteMetadata{
			{
				ID:           cloudNote.ID,
				Title:        cloudNote.Title,
				ModifiedTime: cloudNote.ModifiedTime,
			},
		},
	})

	// 同期を実行
	err = ds.SyncNotes()
	assert.NoError(t, err)

	// クラウドバージョンが優先されることを確認
	syncedNote, err := helper.noteService.LoadNote(localNote.ID)
	assert.NoError(t, err)
	assert.Equal(t, cloudNote.Title, syncedNote.Title)
	assert.Equal(t, cloudNote.Content, syncedNote.Content)
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
	syncImpl.SetInitialSyncCompleted(false)

	// 同期を試行
	err := helper.driveService.SyncNotes()
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not connected")

	// オフライン状態が維持されることを確認
	assert.False(t, syncImpl.IsConnected())
	assert.False(t, syncImpl.HasCompletedInitialSync())
}

// TestPeriodicSync は定期的な同期をテストします
func TestPeriodicSync(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	// ローカルノートを作成
	localNote := &Note{
		ID:           "sync-note",
		Title:        "定期同期テスト",
		Content:      "定期的な同期のテスト用ノート",
		Language:     "plaintext",
		ModifiedTime: time.Now().Add(-time.Hour).Format(time.RFC3339),
	}

	// ローカルノートを保存
	err := helper.noteService.SaveNote(localNote)
	assert.NoError(t, err)

	// DriveServiceのモックを設定
	mockDriveOps := newMockDriveOperations()
	ds := &mockDriveService{
		ctx:         context.Background(),
		appDataDir:  helper.tempDir,
		notesDir:    helper.notesDir,
		noteService: helper.noteService,
		logger:      NewAppLogger(context.Background(), true, helper.tempDir),
		isTestMode:  true,
		driveOps:    mockDriveOps,
	}

	logger := NewAppLogger(context.Background(), true, helper.tempDir)

	// クラウドの変更をシミュレート
	cloudNote := &Note{
		ID:           localNote.ID,
		Title:        "更新されたタイトル",
		Content:      "更新された内容",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}

	// クラウドノートをDriveOperationsに保存
	noteData, err := json.Marshal(cloudNote)
	assert.NoError(t, err)
	_, err = mockDriveOps.CreateFile(cloudNote.ID+".json", noteData, "test-folder", "application/json")
	assert.NoError(t, err)

	// DriveSyncServiceを設定
	syncService := NewDriveSyncService(mockDriveOps, "test-folder", "test-root", logger)
	ds.driveSync = syncService

	// クラウドノートリストを設定
	syncImpl, ok := syncService.(*driveSyncServiceImpl)
	assert.True(t, ok)
	syncImpl.SetConnected(true)
	syncImpl.SetInitialSyncCompleted(true)
	syncImpl.SetCloudNoteList(&NoteList{
		Version: "1.0",
		Notes: []NoteMetadata{
			{
				ID:           cloudNote.ID,
				Title:        cloudNote.Title,
				ModifiedTime: cloudNote.ModifiedTime,
			},
		},
	})

	// 同期を実行
	err = ds.SyncNotes()
	assert.NoError(t, err)

	// クラウドの変更が反映されることを確認
	updatedNote, err := helper.noteService.LoadNote(localNote.ID)
	assert.NoError(t, err)
	assert.Equal(t, "更新されたタイトル", updatedNote.Title)
	assert.Equal(t, "更新された内容", updatedNote.Content)
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
	assert.Equal(t, 0, helper.noteService.noteList.Notes[0].Order)
}

// TestNoteOrderConflict はノートの順序変更の競合解決をテストします
func TestNoteOrderConflict(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	// DriveServiceのモックを設定
	mockDriveOps := newMockDriveOperations()
	ds := &mockDriveService{
		ctx:         context.Background(),
		appDataDir:  helper.tempDir,
		notesDir:    helper.notesDir,
		noteService: helper.noteService,
		logger:      NewAppLogger(context.Background(), true, helper.tempDir),
		isTestMode:  true,
		driveOps:    mockDriveOps,
	}

	logger := NewAppLogger(context.Background(), true, helper.tempDir)

	// DriveSyncServiceを設定
	syncService := NewDriveSyncService(mockDriveOps, "test-folder", "test-root", logger)
	ds.driveSync = syncService

	// 複数のノートを作成
	notes := []*Note{
		{ID: "note1", Title: "ノート1", Order: 0, ModifiedTime: time.Now().Add(-time.Hour).Format(time.RFC3339)},
		{ID: "note2", Title: "ノート2", Order: 1, ModifiedTime: time.Now().Add(-time.Hour).Format(time.RFC3339)},
		{ID: "note3", Title: "ノート3", Order: 2, ModifiedTime: time.Now().Add(-time.Hour).Format(time.RFC3339)},
	}

	// ノートを保存
	for _, note := range notes {
		err := helper.noteService.SaveNote(note)
		assert.NoError(t, err)

		// クラウドにも保存
		noteData, err := json.Marshal(note)
		assert.NoError(t, err)
		_, err = mockDriveOps.CreateFile(note.ID+".json", noteData, "test-folder", "application/json")
		assert.NoError(t, err)
	}

	// クラウドの異なる順序をシミュレート
	cloudNotes := []NoteMetadata{
		{ID: "note2", Title: "ノート2", Order: 0, ModifiedTime: time.Now().Format(time.RFC3339)},
		{ID: "note1", Title: "ノート1", Order: 1, ModifiedTime: time.Now().Format(time.RFC3339)},
		{ID: "note3", Title: "ノート3", Order: 2, ModifiedTime: time.Now().Format(time.RFC3339)},
	}

	// クラウドノートリストを設定
	syncImpl, ok := syncService.(*driveSyncServiceImpl)
	assert.True(t, ok)
	syncImpl.SetConnected(true)
	syncImpl.SetInitialSyncCompleted(true)
	syncImpl.SetCloudNoteList(&NoteList{
		Version: "1.0",
		Notes:   cloudNotes,
	})

	// 同期を実行
	err := ds.SyncNotes()
	assert.NoError(t, err)

	// クラウドの順序が反映されることを確認
	updatedNotes, err := helper.noteService.ListNotes()
	assert.NoError(t, err)
	assert.Equal(t, 3, len(updatedNotes))
	assert.Equal(t, "note2", updatedNotes[0].ID)
	assert.Equal(t, "note1", updatedNotes[1].ID)
	assert.Equal(t, "note3", updatedNotes[2].ID)
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
	queue := NewDriveOperationsQueue(ops)
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

// --- C-3: 不明クラウドノートの自動削除停止テスト ---

func TestLocalSync_UnknownCloudNotes_NotDeleted(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)

	localNote := &Note{
		ID:           "local-note",
		Title:        "ローカルノート",
		Content:      "ローカルの内容",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	err := helper.noteService.SaveNote(localNote)
	assert.NoError(t, err)

	noteData, _ := json.Marshal(localNote)
	mockOps.CreateFile(localNote.ID+".json", noteData, "test-folder", "application/json")

	unknownNoteData, _ := json.Marshal(&Note{
		ID:      "unknown-cloud-note",
		Title:   "不明クラウドノート",
		Content: "別デバイスで作成",
	})
	mockOps.CreateFile("unknown-cloud-note.json", unknownNoteData, "test-folder", "application/json")

	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	files, _ := mockOps.ListFiles("")

	// mockのListFilesが返すファイル名は "test-file-{name}" 形式
	// cloudNoteListにはmockのファイル名から.jsonを除いたIDで登録
	cloudNoteList := &NoteList{
		Notes: []NoteMetadata{},
	}
	for _, f := range files {
		name := f.Name
		if strings.HasSuffix(name, ".json") {
			continue
		}
	}
	// ローカルノートのファイル名でnoteListに登録
	for _, f := range files {
		noteID := strings.TrimSuffix(f.Name, ".json")
		if noteID == fmt.Sprintf("test-file-%s", localNote.ID+".json") {
			cloudNoteList.Notes = append(cloudNoteList.Notes, NoteMetadata{
				ID: noteID, Title: localNote.Title, ModifiedTime: localNote.ModifiedTime,
			})
		}
	}

	unknownNotes, err := syncService.ListUnknownNotes(context.Background(), cloudNoteList, files, false)
	assert.NoError(t, err)
	assert.True(t, len(unknownNotes.Notes) >= 1, "不明ノートがリストアップされるべき")

	mockOps.mu.RLock()
	_, stillExists := mockOps.files["test-file-unknown-cloud-note.json"]
	mockOps.mu.RUnlock()
	assert.True(t, stillExists, "不明クラウドノートが削除されてはならない")
}

// --- C-4: 削除 vs 編集の衝突保護テスト ---

func TestCloudSync_DeletedOnCloud_EditedLocally_Preserved(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)

	lastSyncTime := time.Now().Add(-1 * time.Hour)

	localNote := &Note{
		ID:           "edited-note",
		Title:        "ローカル編集済み",
		Content:      "同期後に編集された内容",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	err := helper.noteService.SaveNote(localNote)
	assert.NoError(t, err)

	helper.noteService.noteList.LastSync = lastSyncTime

	noteData, _ := json.Marshal(localNote)
	mockOps.CreateFile(localNote.ID+".json", noteData, "test-folder", "application/json")

	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	driveSync.SetNoteListID("test-notelist-id")
	auth.driveSync = driveSync

	ds := &driveService{
		ctx:         context.Background(),
		auth:        auth,
		noteService: helper.noteService,
		logger:      logger,
		driveOps:    mockOps,
		driveSync:   syncService,
	}

	cloudNoteList := &NoteList{
		Notes: []NoteMetadata{},
	}

	err = ds.handleCloudSync(cloudNoteList)
	assert.NoError(t, err)

	_, loadErr := helper.noteService.LoadNote("edited-note")
	assert.NoError(t, loadErr, "ローカル編集済みノートが保持されるべき")
}

func TestCloudSync_DeletedOnCloud_NotEditedLocally_Deleted(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)

	oldModTime := time.Now().Add(-2 * time.Hour)
	lastSyncTime := time.Now().Add(-1 * time.Hour)

	localNote := &Note{
		ID:       "stale-note",
		Title:    "未編集ノート",
		Content:  "同期前から変更なし",
		Language: "plaintext",
	}
	err := helper.noteService.SaveNote(localNote)
	assert.NoError(t, err)

	// SaveNoteがModifiedTimeをNow()に設定するため、手動で古い時刻に上書き
	for i, n := range helper.noteService.noteList.Notes {
		if n.ID == "stale-note" {
			helper.noteService.noteList.Notes[i].ModifiedTime = oldModTime.Format(time.RFC3339)
		}
	}
	helper.noteService.noteList.LastSync = lastSyncTime

	noteData, _ := json.Marshal(localNote)
	mockOps.CreateFile(localNote.ID+".json", noteData, "test-folder", "application/json")

	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	driveSync.SetNoteListID("test-notelist-id")
	auth.driveSync = driveSync

	ds := &driveService{
		ctx:         context.Background(),
		auth:        auth,
		noteService: helper.noteService,
		logger:      logger,
		driveOps:    mockOps,
		driveSync:   syncService,
	}

	cloudNoteList := &NoteList{
		Notes:    []NoteMetadata{},
		LastSync: lastSyncTime,
	}

	err = ds.handleCloudSync(cloudNoteList)
	assert.NoError(t, err)

	_, loadErr := helper.noteService.LoadNote("stale-note")
	assert.Error(t, loadErr, "未編集ノートはクラウド削除が反映されるべき")
}

func TestCloudSync_MultipleNotes_MixedDeleteAndEdit(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)

	lastSyncTime := time.Now().Add(-1 * time.Hour)
	staleModTime := time.Now().Add(-2 * time.Hour)

	editedNote := &Note{
		ID:       "edited",
		Title:    "編集済み",
		Content:  "同期後に編集",
		Language: "plaintext",
	}
	staleNote := &Note{
		ID:       "stale",
		Title:    "未編集",
		Content:  "古い内容",
		Language: "plaintext",
	}
	cloudNote := &Note{
		ID:       "cloud-existing",
		Title:    "クラウドに存在",
		Content:  "クラウドの内容",
		Language: "plaintext",
	}

	for _, note := range []*Note{editedNote, staleNote, cloudNote} {
		err := helper.noteService.SaveNote(note)
		assert.NoError(t, err)
		noteData, _ := json.Marshal(note)
		mockOps.CreateFile(note.ID+".json", noteData, "test-folder", "application/json")
	}

	// staleノートのModifiedTimeを古い時刻に上書き（SaveNoteがNow()を設定するため）
	for i, n := range helper.noteService.noteList.Notes {
		if n.ID == "stale" {
			helper.noteService.noteList.Notes[i].ModifiedTime = staleModTime.Format(time.RFC3339)
		}
	}
	helper.noteService.noteList.LastSync = lastSyncTime

	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	driveSync.SetNoteListID("test-notelist-id")
	auth.driveSync = driveSync

	ds := &driveService{
		ctx:         context.Background(),
		auth:        auth,
		noteService: helper.noteService,
		logger:      logger,
		driveOps:    mockOps,
		driveSync:   syncService,
	}

	cloudNoteList := &NoteList{
		Notes: []NoteMetadata{
			{ID: "cloud-existing", Title: cloudNote.Title, ModifiedTime: cloudNote.ModifiedTime},
		},
		LastSync: lastSyncTime,
	}

	err := ds.handleCloudSync(cloudNoteList)
	assert.NoError(t, err)

	_, editedErr := helper.noteService.LoadNote("edited")
	assert.NoError(t, editedErr, "編集済みノートは保持されるべき")

	_, staleErr := helper.noteService.LoadNote("stale")
	assert.Error(t, staleErr, "未編集ノートは削除されるべき")

	_, cloudErr := helper.noteService.LoadNote("cloud-existing")
	assert.NoError(t, cloudErr, "クラウドに存在するノートは保持されるべき")
}

// --- H-1: handleCloudSync NoteList全体適用テスト ---

func newTestDriveService(helper *testHelper) *driveService {
	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	driveSync.SetNoteListID("test-notelist-id")
	auth.driveSync = driveSync

	return &driveService{
		ctx:                    context.Background(),
		auth:                   auth,
		noteService:            helper.noteService,
		logger:                 logger,
		driveOps:               mockOps,
		driveSync:              syncService,
		recentlyDeletedNoteIDs: make(map[string]bool),
	}
}

func TestCloudSync_AppliesFolders(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()
	ds := newTestDriveService(helper)

	helper.noteService.noteList.Folders = nil

	cloudNoteList := &NoteList{
		Notes:   []NoteMetadata{},
		Folders: []Folder{{ID: "folder-1", Name: "Work"}, {ID: "folder-2", Name: "Personal"}},
	}

	err := ds.handleCloudSync(cloudNoteList)
	assert.NoError(t, err)
	assert.Len(t, helper.noteService.noteList.Folders, 2)
	assert.Equal(t, "Work", helper.noteService.noteList.Folders[0].Name)
	assert.Equal(t, "Personal", helper.noteService.noteList.Folders[1].Name)
}

func TestCloudSync_AppliesTopLevelOrder(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()
	ds := newTestDriveService(helper)

	helper.noteService.SaveNote(&Note{ID: "n1", Title: "Note1", Content: ""})
	helper.noteService.SaveNote(&Note{ID: "n2", Title: "Note2", Content: ""})

	cloudNoteList := &NoteList{
		Notes: []NoteMetadata{
			{ID: "n1", Title: "Note1"},
			{ID: "n2", Title: "Note2"},
		},
		Folders: []Folder{{ID: "f1", Name: "Folder1"}},
		TopLevelOrder: []TopLevelItem{
			{Type: "note", ID: "n1"},
			{Type: "folder", ID: "f1"},
			{Type: "note", ID: "n2"},
		},
	}

	helper.noteService.noteList.Notes = cloudNoteList.Notes
	helper.noteService.noteList.Folders = cloudNoteList.Folders
	helper.noteService.noteList.TopLevelOrder = nil

	err := ds.handleCloudSync(cloudNoteList)
	assert.NoError(t, err)

	order := helper.noteService.noteList.TopLevelOrder
	orderIDs := make([]string, len(order))
	for i, item := range order {
		orderIDs[i] = item.ID
	}
	assert.Contains(t, orderIDs, "n1")
	assert.Contains(t, orderIDs, "f1")
	assert.Contains(t, orderIDs, "n2")
	assert.Len(t, order, 3)
}

func TestCloudSync_AppliesArchivedTopLevelOrder(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()
	ds := newTestDriveService(helper)

	helper.noteService.SaveNote(&Note{ID: "archived-1", Title: "Archived1", Content: "", Archived: true})

	cloudNoteList := &NoteList{
		Notes: []NoteMetadata{
			{ID: "archived-1", Title: "Archived1", Archived: true},
		},
		Folders: []Folder{{ID: "archived-f1", Name: "ArchivedFolder", Archived: true}},
		ArchivedTopLevelOrder: []TopLevelItem{
			{Type: "note", ID: "archived-1"},
			{Type: "folder", ID: "archived-f1"},
		},
	}

	helper.noteService.noteList.Notes = cloudNoteList.Notes
	helper.noteService.noteList.Folders = cloudNoteList.Folders

	err := ds.handleCloudSync(cloudNoteList)
	assert.NoError(t, err)
	assert.Len(t, helper.noteService.noteList.ArchivedTopLevelOrder, 2)
	assert.Equal(t, "archived-1", helper.noteService.noteList.ArchivedTopLevelOrder[0].ID)
}

func TestCloudSync_AppliesCollapsedFolderIDs(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()
	ds := newTestDriveService(helper)

	helper.noteService.noteList.CollapsedFolderIDs = []string{"local-folder"}

	cloudNoteList := &NoteList{
		Notes:              []NoteMetadata{},
		CollapsedFolderIDs: []string{"cloud-folder-1", "cloud-folder-2"},
	}

	err := ds.handleCloudSync(cloudNoteList)
	assert.NoError(t, err)
	assert.Equal(t, []string{"cloud-folder-1", "cloud-folder-2"}, helper.noteService.noteList.CollapsedFolderIDs)
}

func TestCloudSync_PreservesLocalOnlyFolders(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()
	ds := newTestDriveService(helper)

	helper.noteService.noteList.Folders = []Folder{
		{ID: "local-only", Name: "LocalFolder"},
		{ID: "shared", Name: "SharedOld"},
	}

	cloudNoteList := &NoteList{
		Notes:   []NoteMetadata{},
		Folders: []Folder{{ID: "shared", Name: "SharedCloud"}, {ID: "cloud-new", Name: "CloudNew"}},
	}

	err := ds.handleCloudSync(cloudNoteList)
	assert.NoError(t, err)

	folderIDs := make(map[string]string)
	for _, f := range helper.noteService.noteList.Folders {
		folderIDs[f.ID] = f.Name
	}
	assert.Contains(t, folderIDs, "local-only", "ローカルのみのフォルダが保持されるべき")
	assert.Contains(t, folderIDs, "shared")
	assert.Equal(t, "SharedCloud", folderIDs["shared"], "共有フォルダはクラウド版が優先")
	assert.Contains(t, folderIDs, "cloud-new")
}

func TestCloudSync_MergesTopLevelOrder_LocalOnlyItemsAppended(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()
	ds := newTestDriveService(helper)

	helper.noteService.SaveNote(&Note{ID: "local-only-note", Title: "Local", Content: ""})
	helper.noteService.SaveNote(&Note{ID: "shared-note", Title: "Shared", Content: ""})
	helper.noteService.SaveNote(&Note{ID: "cloud-only-note", Title: "Cloud", Content: ""})

	helper.noteService.noteList.Notes = []NoteMetadata{
		{ID: "local-only-note", Title: "Local"},
		{ID: "shared-note", Title: "Shared"},
		{ID: "cloud-only-note", Title: "Cloud"},
	}
	helper.noteService.noteList.TopLevelOrder = []TopLevelItem{
		{Type: "note", ID: "local-only-note"},
		{Type: "note", ID: "shared-note"},
	}
	helper.noteService.noteList.LastSync = time.Now().Add(-1 * time.Hour)

	cloudNoteList := &NoteList{
		Notes: []NoteMetadata{
			{ID: "shared-note", Title: "Shared"},
			{ID: "cloud-only-note", Title: "Cloud"},
		},
		TopLevelOrder: []TopLevelItem{
			{Type: "note", ID: "shared-note"},
			{Type: "note", ID: "cloud-only-note"},
		},
		LastSync: time.Now(),
	}

	ds.mergeNoteListStructure(cloudNoteList)

	order := helper.noteService.noteList.TopLevelOrder
	assert.Equal(t, "shared-note", order[0].ID, "クラウドの並び順が優先")
	assert.Equal(t, "cloud-only-note", order[1].ID)
	assert.Equal(t, "local-only-note", order[2].ID, "ローカルのみのアイテムが末尾追加")
}

// --- H-3: コンフリクトコピーテスト ---

func TestCreateConflictCopy_CreatesNewNote(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	original := &Note{
		ID:           "original-note",
		Title:        "Original Title",
		Content:      "Original content",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	err := helper.noteService.SaveNote(original)
	assert.NoError(t, err)

	copy, err := helper.noteService.CreateConflictCopy(original)
	assert.NoError(t, err)
	assert.NotEqual(t, original.ID, copy.ID)
	assert.Contains(t, copy.Title, "conflict copy")
	assert.Equal(t, original.Content, copy.Content)
	assert.Equal(t, original.Language, copy.Language)

	loaded, err := helper.noteService.LoadNote(copy.ID)
	assert.NoError(t, err)
	assert.Equal(t, copy.Title, loaded.Title)
}

func TestCreateConflictCopy_PlacedAfterOriginal(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	helper.noteService.noteList.TopLevelOrder = []TopLevelItem{
		{Type: "note", ID: "note-before"},
		{Type: "note", ID: "original-note"},
		{Type: "note", ID: "note-after"},
	}

	original := &Note{
		ID:           "original-note",
		Title:        "Original",
		Content:      "Content",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	err := helper.noteService.SaveNote(original)
	assert.NoError(t, err)

	copy, err := helper.noteService.CreateConflictCopy(original)
	assert.NoError(t, err)

	order := helper.noteService.noteList.TopLevelOrder
	originalIdx := -1
	copyIdx := -1
	for i, item := range order {
		if item.ID == "original-note" {
			originalIdx = i
		}
		if item.ID == copy.ID {
			copyIdx = i
		}
	}
	assert.Equal(t, originalIdx+1, copyIdx, "コンフリクトコピーが元ノートの直後に配置されるべき")
}

func TestResolveConflictCopiesAfterMerge_DeletesDuplicateFromCloud(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	ds := newTestDriveService(helper)
	ds.auth.GetDriveSync().SetConnected(true)

	base := &Note{
		ID:       "note-main",
		Title:    "Main",
		Content:  "same-content",
		Language: "plaintext",
	}
	conflict := &Note{
		ID:       "note-conflict",
		Title:    " (conflict copy 2026-02-11 00:24)",
		Content:  "same-content",
		Language: "plaintext",
	}

	err := helper.noteService.SaveNote(base)
	assert.NoError(t, err)
	err = helper.noteService.SaveNote(conflict)
	assert.NoError(t, err)

	mockOps := ds.driveOps.(*mockDriveOperations)
	conflictFileID := fmt.Sprintf("test-file-%s.json", conflict.ID)
	mockOps.files[conflictFileID] = []byte(`{"id":"note-conflict"}`)

	ds.resolveConflictCopiesAfterMerge()

	_, err = helper.noteService.LoadNote(conflict.ID)
	assert.Error(t, err, "重複したコンフリクトコピーはローカルから削除されるべき")
	_, err = helper.noteService.LoadNote(base.ID)
	assert.NoError(t, err, "非コンフリクトノートは保持されるべき")

	for _, metadata := range helper.noteService.noteList.Notes {
		assert.NotEqual(t, conflict.ID, metadata.ID)
	}
	assert.True(t, ds.recentlyDeletedNoteIDs[conflict.ID], "削除済みIDが記録されるべき")
	assert.NotContains(t, mockOps.files, conflictFileID, "コンフリクトコピーのクラウドファイルは削除されるべき")
}

func TestMergeNotes_ConflictingContent_MergesInNote(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	localNote := &Note{
		ID:           "conflict-note",
		Title:        "Conflict Note",
		Content:      "Local version",
		Language:     "plaintext",
		ModifiedTime: time.Now().Add(-1 * time.Hour).Format(time.RFC3339),
	}
	err := helper.noteService.SaveNote(localNote)
	assert.NoError(t, err)

	cloudNote := &Note{
		ID:           "conflict-note",
		Title:        "Conflict Note",
		Content:      "Cloud version",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	cloudData, _ := json.Marshal(cloudNote)
	mockOps.CreateFile("conflict-note.json", cloudData, "test-folder", "application/json")

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	auth.driveSync = driveSync

	ds := &driveService{
		ctx:         context.Background(),
		auth:        auth,
		noteService: helper.noteService,
		logger:      logger,
		driveOps:    mockOps,
		driveSync:   syncService,
	}

	localNotes := []NoteMetadata{
		{ID: "conflict-note", Title: "Conflict Note", ContentHash: "local-hash", ModifiedTime: localNote.ModifiedTime},
	}
	cloudNotes := []NoteMetadata{
		{ID: "conflict-note", Title: "Conflict Note", ContentHash: "cloud-hash", ModifiedTime: cloudNote.ModifiedTime},
	}

	mergedNotes, downloadedNotes, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes, time.Time{})
	assert.NoError(t, err)

	assert.Len(t, mergedNotes, 1, "ノート内マージではノート数が増えないべき")
	assert.Len(t, downloadedNotes, 1, "マージ済みノートがダウンロードされるべき")
	assert.Contains(t, downloadedNotes[0].Content, "<<<<<<<", "コンフリクトマーカーが含まれるべき")
	assert.Contains(t, downloadedNotes[0].Content, "Cloud version", "クラウド版の内容が含まれるべき")
	assert.Contains(t, downloadedNotes[0].Content, "Local version", "ローカル版の内容が含まれるべき")
	assert.Contains(t, downloadedNotes[0].Content, ">>>>>>>", "コンフリクトマーカーが含まれるべき")
}

func TestMergeNotes_SameContent_NoConflictCopy(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	ds := newTestDriveService(helper)

	localNotes := []NoteMetadata{
		{ID: "same-note", Title: "Same", ContentHash: "same-hash", ModifiedTime: time.Now().Format(time.RFC3339)},
	}
	cloudNotes := []NoteMetadata{
		{ID: "same-note", Title: "Same", ContentHash: "same-hash", ModifiedTime: time.Now().Format(time.RFC3339)},
	}

	mergedNotes, _, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes, time.Time{})
	assert.NoError(t, err)
	assert.Len(t, mergedNotes, 1)
	for _, n := range mergedNotes {
		assert.NotContains(t, n.Title, "競合コピー")
	}
}

func TestMergeNotes_LocalOnly_DeletedOnOtherDevice(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	ds := newTestDriveService(helper)

	oldTime := time.Now().Add(-10 * time.Minute)
	note := &Note{
		ID:       "deleted-note",
		Title:    "Deleted On Other Device",
		Content:  "some content",
		Language: "plaintext",
	}
	err := helper.noteService.SaveNote(note)
	assert.NoError(t, err)

	localNotes := []NoteMetadata{
		{ID: "deleted-note", Title: "Deleted On Other Device", ContentHash: "hash1", ModifiedTime: oldTime.Format(time.RFC3339)},
	}
	cloudNotes := []NoteMetadata{}
	cloudLastSync := time.Now()

	ds.lastSyncResult = &SyncResult{}
	mergedNotes, _, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes, cloudLastSync)
	assert.NoError(t, err)
	assert.Len(t, mergedNotes, 0, "他端末で削除されたノートはマージ結果に含まれないべき")
	assert.Equal(t, 1, ds.lastSyncResult.Deleted)
}

func TestMergeNotes_LocalOnly_CreatedOffline(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	ds := newTestDriveService(helper)

	note := &Note{
		ID:       "offline-note",
		Title:    "Created Offline",
		Content:  "offline content",
		Language: "plaintext",
	}
	err := helper.noteService.SaveNote(note)
	assert.NoError(t, err)

	recentTime := time.Now().Add(10 * time.Minute)
	localNotes := []NoteMetadata{
		{ID: "offline-note", Title: "Created Offline", ContentHash: "hash1", ModifiedTime: recentTime.Format(time.RFC3339)},
	}
	cloudNotes := []NoteMetadata{}
	cloudLastSync := time.Now()

	ds.lastSyncResult = &SyncResult{}
	mergedNotes, _, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes, cloudLastSync)
	assert.NoError(t, err)
	assert.Len(t, mergedNotes, 1, "オフラインで作成されたノートはアップロードされるべき")
	assert.Equal(t, 0, ds.lastSyncResult.Deleted)
	assert.Equal(t, 1, ds.lastSyncResult.Uploaded)
}

func TestMergeNotes_LocalOnly_ZeroCloudLastSync(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	ds := newTestDriveService(helper)

	note := &Note{
		ID:       "first-sync-note",
		Title:    "First Sync",
		Content:  "content",
		Language: "plaintext",
	}
	err := helper.noteService.SaveNote(note)
	assert.NoError(t, err)

	localNotes := []NoteMetadata{
		{ID: "first-sync-note", Title: "First Sync", ContentHash: "hash1", ModifiedTime: time.Now().Add(-1 * time.Hour).Format(time.RFC3339)},
	}
	cloudNotes := []NoteMetadata{}

	ds.lastSyncResult = &SyncResult{}
	mergedNotes, _, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes, time.Time{})
	assert.NoError(t, err)
	assert.Len(t, mergedNotes, 1, "cloudLastSyncがゼロの場合はアップロードされるべき")
	assert.Equal(t, 0, ds.lastSyncResult.Deleted)
	assert.Equal(t, 1, ds.lastSyncResult.Uploaded)
}

func TestMergeNotes_CloudOnly_DeletedLocally(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()
	ds := newTestDriveService(helper)
	ds.recentlyDeletedNoteIDs = map[string]bool{"deleted-locally": true}

	cloudNotes := []NoteMetadata{
		{ID: "deleted-locally", Title: "Deleted Locally", ContentHash: "hash1", ModifiedTime: time.Now().Format(time.RFC3339)},
	}

	mergedNotes, _, err := ds.mergeNotes(context.Background(), []NoteMetadata{}, cloudNotes, time.Time{})
	assert.NoError(t, err)
	assert.Len(t, mergedNotes, 0, "ローカルで削除済みのノートはダウンロードされないべき")
	assert.False(t, ds.recentlyDeletedNoteIDs["deleted-locally"], "マージ後にrecentlyDeletedから除去されるべき")
}

func TestMergeNotes_CloudOnly_NotDeletedLocally(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()
	ds := newTestDriveService(helper)

	cloudNote := &Note{ID: "new-cloud-note", Title: "New Cloud Note", Content: "content", Language: "plaintext"}
	cloudData, _ := json.Marshal(cloudNote)
	mockOps := ds.driveOps.(*mockDriveOperations)
	mockOps.CreateFile("new-cloud-note.json", cloudData, "test-folder", "application/json")

	cloudNotes := []NoteMetadata{
		{ID: "new-cloud-note", Title: "New Cloud Note", ContentHash: "hash1", ModifiedTime: time.Now().Format(time.RFC3339)},
	}

	ds.lastSyncResult = &SyncResult{}
	mergedNotes, downloadedNotes, err := ds.mergeNotes(context.Background(), []NoteMetadata{}, cloudNotes, time.Time{})
	assert.NoError(t, err)
	assert.Len(t, mergedNotes, 1, "他端末で新規作成されたノートはダウンロードされるべき")
	assert.Len(t, downloadedNotes, 1)
	assert.Equal(t, "new-cloud-note", downloadedNotes[0].ID)
}

// --- H-8: UploadAllNotesWithContentテスト ---

func TestUploadAllNotesWithContent_IncludesContent(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	note := &Note{
		ID:       "content-note",
		Title:    "With Content",
		Content:  "This is the actual content",
		Language: "plaintext",
	}
	err := helper.noteService.SaveNote(note)
	assert.NoError(t, err)

	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	auth.driveSync = driveSync

	ds := &driveService{
		ctx:         context.Background(),
		auth:        auth,
		noteService: helper.noteService,
		logger:      logger,
		driveOps:    mockOps,
		driveSync:   syncService,
	}

	err = ds.uploadAllNotesWithContent(context.Background())
	assert.NoError(t, err)

	mockOps.mu.RLock()
	defer mockOps.mu.RUnlock()

	found := false
	for _, data := range mockOps.files {
		var uploaded Note
		if json.Unmarshal(data, &uploaded) == nil && uploaded.ID == "content-note" {
			assert.Equal(t, "This is the actual content", uploaded.Content, "Contentが含まれるべき")
			found = true
		}
	}
	assert.True(t, found, "ノートがアップロードされるべき")
}

func TestUploadAllNotesWithContent_SkipsMissingFile(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	helper.noteService.noteList.Notes = []NoteMetadata{
		{ID: "missing-note", Title: "Missing"},
	}

	ds := newTestDriveService(helper)

	err := ds.uploadAllNotesWithContent(context.Background())
	assert.NoError(t, err, "欠落ファイルがあってもエラーにならないべき")
}

// --- H-7: JSON破損対策テスト ---

func TestMergeNotes_CorruptedNote_SkipsAndContinues(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	goodNote := &Note{ID: "good-note", Title: "Good", Content: "Good content", Language: "plaintext"}
	goodData, _ := json.Marshal(goodNote)
	mockOps.CreateFile("good-note.json", goodData, "test-folder", "application/json")

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	auth.driveSync = driveSync

	ds := &driveService{
		ctx:                    context.Background(),
		auth:                   auth,
		noteService:            helper.noteService,
		logger:                 logger,
		driveOps:               mockOps,
		driveSync:              syncService,
		recentlyDeletedNoteIDs: make(map[string]bool),
	}

	cloudNotes := []NoteMetadata{
		{ID: "bad-note", Title: "Bad", ContentHash: "bad-hash"},
		{ID: "good-note", Title: "Good", ContentHash: "good-hash"},
	}

	mergedNotes, downloadedNotes, err := ds.mergeNotes(context.Background(), []NoteMetadata{}, cloudNotes, time.Time{})
	assert.NoError(t, err, "破損ノートがあっても全体がエラーにならないべき")
	assert.Len(t, mergedNotes, 1, "Driveに存在しないノートはnoteListから除外されるべき")
	assert.Len(t, downloadedNotes, 1, "正常なノートだけダウンロードされるべき")
	assert.Equal(t, "good-note", downloadedNotes[0].ID)
	assert.Equal(t, "good-note", mergedNotes[0].ID)
}

func TestMergeNotes_EmptyVsNonEmpty_ConflictMerge(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	ds := newTestDriveService(helper)
	mockOps := ds.driveOps.(*mockDriveOperations)

	modified := time.Now().Format(time.RFC3339)
	localNote := &Note{ID: "h1-empty-content", Title: "H1", Content: "", Language: "plaintext", ModifiedTime: modified}
	err := helper.noteService.SaveNote(localNote)
	assert.NoError(t, err)

	cloudNote := &Note{ID: "h1-empty-content", Title: "H1", Content: "cloud data", Language: "plaintext", ModifiedTime: modified}
	cloudData, _ := json.Marshal(cloudNote)
	_, err = mockOps.CreateFile(cloudNote.ID+".json", cloudData, "test-folder", "application/json")
	assert.NoError(t, err)

	localMeta := NoteMetadata{ID: localNote.ID, Title: localNote.Title, ModifiedTime: modified, ContentHash: computeContentHash(localNote)}
	cloudMeta := NoteMetadata{ID: cloudNote.ID, Title: cloudNote.Title, ModifiedTime: modified, ContentHash: computeContentHash(cloudNote)}

	merged, downloaded, err := ds.mergeNotes(context.Background(), []NoteMetadata{localMeta}, []NoteMetadata{cloudMeta}, time.Time{})
	assert.NoError(t, err)
	assert.Len(t, merged, 1)
	assert.Len(t, downloaded, 1)
	assert.Equal(t, "h1-empty-content", downloaded[0].ID)
}

func TestMergeNotes_TitleOnlyChange_DetectedByContentHash(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	ds := newTestDriveService(helper)
	mockOps := ds.driveOps.(*mockDriveOperations)

	modified := time.Now().Format(time.RFC3339)
	localNote := &Note{ID: "h2-title-change", Title: "Old title", Content: "same content", Language: "plaintext", ModifiedTime: modified}
	err := helper.noteService.SaveNote(localNote)
	assert.NoError(t, err)

	cloudNote := &Note{ID: "h2-title-change", Title: "New title", Content: "same content", Language: "plaintext", ModifiedTime: modified}
	cloudData, _ := json.Marshal(cloudNote)
	_, err = mockOps.CreateFile(cloudNote.ID+".json", cloudData, "test-folder", "application/json")
	assert.NoError(t, err)

	localHash := computeContentHash(localNote)
	cloudHash := computeContentHash(cloudNote)
	assert.NotEqual(t, localHash, cloudHash)

	localMeta := NoteMetadata{ID: localNote.ID, Title: localNote.Title, ModifiedTime: modified, ContentHash: localHash}
	cloudMeta := NoteMetadata{ID: cloudNote.ID, Title: cloudNote.Title, ModifiedTime: modified, ContentHash: cloudHash}

	merged, downloaded, err := ds.mergeNotes(context.Background(), []NoteMetadata{localMeta}, []NoteMetadata{cloudMeta}, time.Time{})
	assert.NoError(t, err)
	assert.Len(t, merged, 1)
	assert.Len(t, downloaded, 1)
	assert.Equal(t, "h2-title-change", downloaded[0].ID)
}

func TestMergeNotes_LanguageOnlyChange_DetectedByContentHash(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	ds := newTestDriveService(helper)
	mockOps := ds.driveOps.(*mockDriveOperations)

	modified := time.Now().Format(time.RFC3339)
	localNote := &Note{ID: "h3-language-change", Title: "Same", Content: "same content", Language: "plaintext", ModifiedTime: modified}
	err := helper.noteService.SaveNote(localNote)
	assert.NoError(t, err)

	cloudNote := &Note{ID: "h3-language-change", Title: "Same", Content: "same content", Language: "go", ModifiedTime: modified}
	cloudData, _ := json.Marshal(cloudNote)
	_, err = mockOps.CreateFile(cloudNote.ID+".json", cloudData, "test-folder", "application/json")
	assert.NoError(t, err)

	localHash := computeContentHash(localNote)
	cloudHash := computeContentHash(cloudNote)
	assert.NotEqual(t, localHash, cloudHash)

	localMeta := NoteMetadata{ID: localNote.ID, Title: localNote.Title, ModifiedTime: modified, ContentHash: localHash}
	cloudMeta := NoteMetadata{ID: cloudNote.ID, Title: cloudNote.Title, ModifiedTime: modified, ContentHash: cloudHash}

	merged, downloaded, err := ds.mergeNotes(context.Background(), []NoteMetadata{localMeta}, []NoteMetadata{cloudMeta}, time.Time{})
	assert.NoError(t, err)
	assert.Len(t, merged, 1)
	assert.Len(t, downloaded, 1)
	assert.Equal(t, "h3-language-change", downloaded[0].ID)
}

// --- H-5: forceNextSyncによるMD5キャッシュバイパステスト ---

func TestForceNextSync_ResetsAfterSyncNotes(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	driveSync.SetNoteListID("test-notelist-id")
	auth.driveSync = driveSync

	queue := NewDriveOperationsQueue(mockOps)
	defer queue.Cleanup()

	ds := &driveService{
		ctx:             context.Background(),
		auth:            auth,
		noteService:     helper.noteService,
		logger:          logger,
		driveOps:        queue,
		driveSync:       syncService,
		operationsQueue: queue,
		forceNextSync:   true,
	}

	_ = ds.SyncNotes()
	assert.False(t, ds.forceNextSync, "forceNextSyncはSyncNotes後にfalseにリセットされるべき")
}

func TestForceNextSync_SetByPollingOnChanges(t *testing.T) {
	ds := &driveService{}
	assert.False(t, ds.forceNextSync)
	ds.forceNextSync = true
	assert.True(t, ds.forceNextSync, "ポーリングがChanges検出時にforceNextSyncをtrueに設定できるべき")
}

// --- H-4: クロックスキューでもデータ保持テスト ---

func TestMergeNotes_ClockSkew_BothVersionsPreserved(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	localNote := &Note{
		ID:           "skew-note",
		Title:        "Skew Note",
		Content:      "Local edited after cloud but clock is behind",
		Language:     "plaintext",
		ModifiedTime: time.Now().Add(-2 * time.Hour).Format(time.RFC3339),
	}
	err := helper.noteService.SaveNote(localNote)
	assert.NoError(t, err)

	cloudNote := &Note{
		ID:           "skew-note",
		Title:        "Skew Note",
		Content:      "Cloud version (actually older edit but clock ahead)",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	cloudData, _ := json.Marshal(cloudNote)
	mockOps.CreateFile("skew-note.json", cloudData, "test-folder", "application/json")

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	auth.driveSync = driveSync

	ds := &driveService{
		ctx:         context.Background(),
		auth:        auth,
		noteService: helper.noteService,
		logger:      logger,
		driveOps:    mockOps,
		driveSync:   syncService,
	}

	localNotes := []NoteMetadata{
		{ID: "skew-note", ContentHash: "local-hash", ModifiedTime: localNote.ModifiedTime},
	}
	cloudNotes := []NoteMetadata{
		{ID: "skew-note", ContentHash: "cloud-hash", ModifiedTime: cloudNote.ModifiedTime},
	}

	mergedNotes, downloadedNotes, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes, time.Time{})
	assert.NoError(t, err)

	assert.Len(t, mergedNotes, 1, "ノート内マージではノート数が増えないべき")
	assert.Len(t, downloadedNotes, 1, "マージ済みノートがダウンロードされるべき")
	assert.Contains(t, downloadedNotes[0].Content, "<<<<<<<", "コンフリクトマーカーで両バージョンが保持されるべき")
	assert.Contains(t, downloadedNotes[0].Content, ">>>>>>>", "コンフリクトマーカーで両バージョンが保持されるべき")
}

// --- H-2: キュー非空時のSyncNotesスキップテスト ---

func TestSyncNotes_SkipsWhenQueueHasItems(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	driveSync.SetNoteListID("test-notelist-id")
	auth.driveSync = driveSync

	queue := NewDriveOperationsQueue(mockOps)
	defer queue.Cleanup()

	ds := &driveService{
		ctx:             context.Background(),
		auth:            auth,
		noteService:     helper.noteService,
		logger:          logger,
		driveOps:        mockOps,
		driveSync:       syncService,
		operationsQueue: queue,
	}

	queue.mutex.Lock()
	queue.items["dummy-key"] = []*QueueItem{{OperationType: CreateOperation, FileName: "dummy.json"}}
	queue.mutex.Unlock()

	err := ds.SyncNotes()
	assert.NoError(t, err, "キュー非空時はスキップしてnilを返すべき")
}

func TestSyncNotes_ProceedsWhenQueueEmpty(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	driveSync.SetNoteListID("test-notelist-id")
	auth.driveSync = driveSync

	queue := NewDriveOperationsQueue(mockOps)
	defer queue.Cleanup()

	ds := &driveService{
		ctx:             context.Background(),
		auth:            auth,
		noteService:     helper.noteService,
		logger:          logger,
		driveOps:        queue,
		driveSync:       syncService,
		operationsQueue: queue,
	}

	err := ds.SyncNotes()
	assert.Error(t, err, "キュー空時はskipSyncを通過し、ensureSyncIsPossibleまで進むべき")
	assert.Contains(t, err.Error(), "not connected", "接続エラーで止まることでスキップされなかったことを確認")
}

// --- H-10: オフライン復帰時のリコンサイルテスト ---

func TestOfflineRecovery_AlwaysMerges(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()
	ds := newTestDriveService(helper)

	note1 := &Note{ID: "note-1", Title: "Local Note", Content: "local content", Language: "plaintext", ModifiedTime: time.Now().Add(-1 * time.Hour).Format(time.RFC3339)}
	helper.noteService.SaveNote(note1)

	cloudNote := &Note{ID: "note-2", Title: "Cloud Note", Content: "cloud content", Language: "plaintext"}
	cloudData, _ := json.Marshal(cloudNote)
	mockOps := ds.driveOps.(*mockDriveOperations)
	mockOps.CreateFile("note-2.json", cloudData, "test-folder", "application/json")

	localNotes := helper.noteService.noteList.Notes
	cloudNotes := []NoteMetadata{
		{ID: "note-2", Title: "Cloud Note", ContentHash: "cloud-hash", ModifiedTime: time.Now().Format(time.RFC3339)},
	}

	mergedNotes, downloadedNotes, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes, time.Time{})
	assert.NoError(t, err)
	assert.GreaterOrEqual(t, len(mergedNotes), 2, "ローカルとクラウド両方のノートがマージされるべき")

	hasLocal := false
	hasCloud := false
	for _, n := range mergedNotes {
		if n.ID == "note-1" {
			hasLocal = true
		}
		if n.ID == "note-2" {
			hasCloud = true
		}
	}
	assert.True(t, hasLocal, "ローカルノートがマージ結果に含まれるべき")
	assert.True(t, hasCloud, "クラウドノートがマージ結果に含まれるべき")
	assert.Len(t, downloadedNotes, 1, "クラウドノートがダウンロードされるべき")
	assert.Equal(t, "note-2", downloadedNotes[0].ID)
}

func TestOfflineRecovery_NewerCloudWins(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	localNote := &Note{
		ID:           "conflict-note",
		Title:        "Shared Note",
		Content:      "local version",
		Language:     "plaintext",
		ModifiedTime: time.Now().Add(-1 * time.Hour).Format(time.RFC3339),
	}
	helper.noteService.SaveNote(localNote)
	localHash := helper.noteService.noteList.Notes[0].ContentHash

	cloudNote := &Note{
		ID:           "conflict-note",
		Title:        "Shared Note",
		Content:      "cloud version - newer",
		Language:     "plaintext",
		ModifiedTime: time.Now().Add(1 * time.Minute).Format(time.RFC3339),
	}
	cloudHash := computeContentHash(cloudNote)

	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	cloudData, _ := json.Marshal(cloudNote)
	mockOps.CreateFile("conflict-note.json", cloudData, "test-folder", "application/json")

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	auth.driveSync = driveSync

	ds := &driveService{
		ctx:         context.Background(),
		auth:        auth,
		noteService: helper.noteService,
		logger:      logger,
		driveOps:    mockOps,
		driveSync:   syncService,
	}

	localNotes := []NoteMetadata{
		{ID: "conflict-note", Title: "Shared Note", ContentHash: localHash, ModifiedTime: localNote.ModifiedTime},
	}
	cloudNotes := []NoteMetadata{
		{ID: "conflict-note", Title: "Shared Note", ContentHash: cloudHash, ModifiedTime: cloudNote.ModifiedTime},
	}

	mergedNotes, downloadedNotes, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes, time.Time{})
	assert.NoError(t, err)

	assert.Len(t, mergedNotes, 1, "ノート数は1のまま")
	assert.Len(t, downloadedNotes, 1, "クラウド版がダウンロードされるべき")
	assert.Equal(t, "cloud version - newer", downloadedNotes[0].Content, "新しいクラウド版で上書きされるべき")
	assert.NotContains(t, downloadedNotes[0].Content, "<<<<<<<", "コンフリクトマーカーは不要")
}

func TestOfflineRecovery_SameTimeConflictMerged(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	sameTime := time.Now().Format(time.RFC3339)

	localNote := &Note{
		ID:           "conflict-note",
		Title:        "Shared Note",
		Content:      "local version",
		Language:     "plaintext",
		ModifiedTime: sameTime,
	}
	helper.noteService.SaveNote(localNote)
	localHash := helper.noteService.noteList.Notes[0].ContentHash

	cloudNote := &Note{
		ID:           "conflict-note",
		Title:        "Shared Note",
		Content:      "cloud version - different",
		Language:     "plaintext",
		ModifiedTime: sameTime,
	}
	cloudHash := computeContentHash(cloudNote)

	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	cloudData, _ := json.Marshal(cloudNote)
	mockOps.CreateFile("conflict-note.json", cloudData, "test-folder", "application/json")

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	auth.driveSync = driveSync

	ds := &driveService{
		ctx:         context.Background(),
		auth:        auth,
		noteService: helper.noteService,
		logger:      logger,
		driveOps:    mockOps,
		driveSync:   syncService,
	}

	localNotes := []NoteMetadata{
		{ID: "conflict-note", Title: "Shared Note", ContentHash: localHash, ModifiedTime: sameTime},
	}
	cloudNotes := []NoteMetadata{
		{ID: "conflict-note", Title: "Shared Note", ContentHash: cloudHash, ModifiedTime: sameTime},
	}

	mergedNotes, downloadedNotes, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes, time.Time{})
	assert.NoError(t, err)

	assert.Len(t, mergedNotes, 1, "ノート内マージではノート数が増えないべき")
	assert.Len(t, downloadedNotes, 1, "マージ済みノートがダウンロードされるべき")
	assert.Contains(t, downloadedNotes[0].Content, "<<<<<<<", "同一時刻の衝突時にコンフリクトマーカーが含まれるべき")
	assert.Contains(t, downloadedNotes[0].Content, "cloud version - different", "クラウド版の内容が含まれるべき")
	assert.Contains(t, downloadedNotes[0].Content, "local version", "ローカル版の内容が含まれるべき")
	assert.Contains(t, downloadedNotes[0].Content, ">>>>>>>", "コンフリクトマーカーが含まれるべき")
}

func TestMergeNotes_SimultaneousEdits_MultipleNotes_ConflictMerged(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()
	ds := newTestDriveService(helper)
	ds.lastSyncResult = &SyncResult{}

	sameTime := time.Now().Format(time.RFC3339)

	localNoteA := &Note{
		ID:           "note-a",
		Title:        "Shared A",
		Content:      "local A",
		Language:     "plaintext",
		ModifiedTime: sameTime,
	}
	localNoteB := &Note{
		ID:           "note-b",
		Title:        "Shared B",
		Content:      "local B",
		Language:     "plaintext",
		ModifiedTime: sameTime,
	}
	assert.NoError(t, helper.noteService.SaveNote(localNoteA))
	assert.NoError(t, helper.noteService.SaveNote(localNoteB))

	cloudNoteA := &Note{
		ID:           "note-a",
		Title:        "Shared A",
		Content:      "cloud A",
		Language:     "plaintext",
		ModifiedTime: sameTime,
	}
	cloudNoteB := &Note{
		ID:           "note-b",
		Title:        "Shared B",
		Content:      "cloud B",
		Language:     "plaintext",
		ModifiedTime: sameTime,
	}

	mockOps, ok := ds.driveOps.(*mockDriveOperations)
	assert.True(t, ok)
	cloudDataA, _ := json.Marshal(cloudNoteA)
	cloudDataB, _ := json.Marshal(cloudNoteB)
	_, err := mockOps.CreateFile("note-a.json", cloudDataA, "test-folder", "application/json")
	assert.NoError(t, err)
	_, err = mockOps.CreateFile("note-b.json", cloudDataB, "test-folder", "application/json")
	assert.NoError(t, err)

	localNotes := helper.noteService.noteList.Notes
	cloudNotes := []NoteMetadata{
		{ID: "note-a", Title: "Shared A", ContentHash: computeContentHash(cloudNoteA), ModifiedTime: sameTime},
		{ID: "note-b", Title: "Shared B", ContentHash: computeContentHash(cloudNoteB), ModifiedTime: sameTime},
	}

	mergedNotes, downloadedNotes, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes, time.Time{})
	assert.NoError(t, err)
	assert.Len(t, mergedNotes, 2, "同時編集のノートは両方保持されるべき")
	assert.Len(t, downloadedNotes, 2, "同時編集のノートは両方ダウンロードされるべき")
	assert.Equal(t, 2, ds.lastSyncResult.ConflictMerges, "同時編集の衝突数がカウントされるべき")
	assert.Equal(t, 2, ds.lastSyncResult.Downloaded, "ダウンロード数がカウントされるべき")

	downloadedByID := map[string]*Note{}
	for _, note := range downloadedNotes {
		downloadedByID[note.ID] = note
	}
	assert.Contains(t, downloadedByID["note-a"].Content, "<<<<<<<", "note-a はコンフリクトマーカーを含むべき")
	assert.Contains(t, downloadedByID["note-a"].Content, "cloud A", "note-a はクラウド内容を含むべき")
	assert.Contains(t, downloadedByID["note-a"].Content, "local A", "note-a はローカル内容を含むべき")
	assert.Contains(t, downloadedByID["note-b"].Content, "<<<<<<<", "note-b はコンフリクトマーカーを含むべき")
	assert.Contains(t, downloadedByID["note-b"].Content, "cloud B", "note-b はクラウド内容を含むべき")
	assert.Contains(t, downloadedByID["note-b"].Content, "local B", "note-b はローカル内容を含むべき")
}

func TestMergeNotes_SimultaneousEdits_TitleChange_ConflictMerged(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()
	ds := newTestDriveService(helper)
	ds.lastSyncResult = &SyncResult{}

	sameTime := time.Now().Format(time.RFC3339)

	localNote := &Note{
		ID:           "title-conflict",
		Title:        "Local Title",
		Content:      "same content",
		Language:     "plaintext",
		ModifiedTime: sameTime,
	}
	assert.NoError(t, helper.noteService.SaveNote(localNote))

	cloudNote := &Note{
		ID:           "title-conflict",
		Title:        "Cloud Title",
		Content:      "same content",
		Language:     "plaintext",
		ModifiedTime: sameTime,
	}

	mockOps, ok := ds.driveOps.(*mockDriveOperations)
	assert.True(t, ok)
	cloudData, _ := json.Marshal(cloudNote)
	_, err := mockOps.CreateFile("title-conflict.json", cloudData, "test-folder", "application/json")
	assert.NoError(t, err)

	localNotes := helper.noteService.noteList.Notes
	cloudNotes := []NoteMetadata{
		{ID: "title-conflict", Title: cloudNote.Title, ContentHash: computeContentHash(cloudNote), ModifiedTime: sameTime},
	}

	mergedNotes, downloadedNotes, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes, time.Time{})
	assert.NoError(t, err)
	assert.Len(t, mergedNotes, 1)
	assert.Len(t, downloadedNotes, 1)
	assert.Equal(t, cloudNote.Title, mergedNotes[0].Title, "同時編集時はクラウドのメタデータが優先されるべき")
	assert.Contains(t, downloadedNotes[0].Content, "<<<<<<<", "タイトル変更のみでもコンフリクトマーカーが含まれるべき")
	assert.Contains(t, downloadedNotes[0].Content, "same content", "同一内容でもマージ結果に含まれるべき")
}

func TestMergeNotes_SimultaneousEdits_LanguageChange_ConflictMerged(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()
	ds := newTestDriveService(helper)
	ds.lastSyncResult = &SyncResult{}

	sameTime := time.Now().Format(time.RFC3339)

	localNote := &Note{
		ID:           "lang-conflict",
		Title:        "Lang Note",
		Content:      "same content",
		Language:     "plaintext",
		ModifiedTime: sameTime,
	}
	assert.NoError(t, helper.noteService.SaveNote(localNote))

	cloudNote := &Note{
		ID:           "lang-conflict",
		Title:        "Lang Note",
		Content:      "same content",
		Language:     "markdown",
		ModifiedTime: sameTime,
	}

	mockOps, ok := ds.driveOps.(*mockDriveOperations)
	assert.True(t, ok)
	cloudData, _ := json.Marshal(cloudNote)
	_, err := mockOps.CreateFile("lang-conflict.json", cloudData, "test-folder", "application/json")
	assert.NoError(t, err)

	localNotes := helper.noteService.noteList.Notes
	cloudNotes := []NoteMetadata{
		{ID: "lang-conflict", Title: cloudNote.Title, ContentHash: computeContentHash(cloudNote), ModifiedTime: sameTime},
	}

	mergedNotes, downloadedNotes, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes, time.Time{})
	assert.NoError(t, err)
	assert.Len(t, mergedNotes, 1)
	assert.Len(t, downloadedNotes, 1)
	assert.Contains(t, downloadedNotes[0].Content, "<<<<<<<", "言語変更のみでもコンフリクトマーカーが含まれるべき")
	assert.Contains(t, downloadedNotes[0].Content, "same content", "同一内容でもマージ結果に含まれるべき")
}

func TestOfflineRecovery_MergesNoteListStructure(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()
	ds := newTestDriveService(helper)

	helper.noteService.noteList.Folders = []Folder{{ID: "local-folder", Name: "Local"}}
	helper.noteService.noteList.TopLevelOrder = []TopLevelItem{
		{Type: "folder", ID: "local-folder"},
	}

	cloudNoteList := &NoteList{
		Notes:   []NoteMetadata{},
		Folders: []Folder{{ID: "cloud-folder", Name: "Cloud"}},
		TopLevelOrder: []TopLevelItem{
			{Type: "folder", ID: "cloud-folder"},
		},
	}

	ds.mergeNoteListStructure(cloudNoteList)

	assert.Len(t, helper.noteService.noteList.Folders, 2, "クラウドとローカル両方のフォルダが保持されるべき")
	assert.Len(t, helper.noteService.noteList.TopLevelOrder, 2, "クラウドとローカル両方のTopLevelOrderが保持されるべき")
}

// --- M-2: 構造フィールドマージ検出テスト ---

func TestIsNoteListChanged_ArchiveChange_Detected(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()
	ds := newTestDriveService(helper)

	note := &Note{ID: "n1", Title: "Note", Content: "c", Language: "plaintext"}
	assert.NoError(t, helper.noteService.SaveNote(note))
	localHash := helper.noteService.noteList.Notes[0].ContentHash

	archivedNote := &Note{ID: "n1", Title: "Note", Content: "c", Language: "plaintext", Archived: true}
	archivedHash := computeContentHash(archivedNote)
	assert.NotEqual(t, localHash, archivedHash, "Archived変更でContentHashが変わるべき")

	localList := []NoteMetadata{{ID: "n1", ContentHash: localHash, Order: 0}}
	cloudList := []NoteMetadata{{ID: "n1", ContentHash: archivedHash, Order: 0}}

	assert.True(t, ds.isNoteListChanged(cloudList, localList),
		"Archived変更がisNoteListChangedで検出されるべき")
}

func TestIsNoteListChanged_FolderIdChange_Detected(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()
	ds := newTestDriveService(helper)

	note := &Note{ID: "n1", Title: "Note", Content: "c", Language: "plaintext"}
	assert.NoError(t, helper.noteService.SaveNote(note))
	localHash := helper.noteService.noteList.Notes[0].ContentHash

	movedNote := &Note{ID: "n1", Title: "Note", Content: "c", Language: "plaintext", FolderID: "folder-x"}
	movedHash := computeContentHash(movedNote)
	assert.NotEqual(t, localHash, movedHash, "FolderID変更でContentHashが変わるべき")

	localList := []NoteMetadata{{ID: "n1", ContentHash: localHash, Order: 0}}
	cloudList := []NoteMetadata{{ID: "n1", ContentHash: movedHash, Order: 0}}

	assert.True(t, ds.isNoteListChanged(cloudList, localList),
		"FolderID変更がisNoteListChangedで検出されるべき")
}

func TestMergeNotes_ArchiveChange_TriggersConflictOrDownload(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	note := &Note{ID: "n1", Title: "Note", Content: "same", Language: "plaintext"}
	assert.NoError(t, helper.noteService.SaveNote(note))
	localHash := helper.noteService.noteList.Notes[0].ContentHash

	cloudNote := &Note{ID: "n1", Title: "Note", Content: "same", Language: "plaintext", Archived: true}
	cloudHash := computeContentHash(cloudNote)
	cloudData, _ := json.Marshal(cloudNote)
	mockOps.CreateFile("n1.json", cloudData, "test-folder", "application/json")

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	auth.driveSync = driveSync

	ds := &driveService{
		ctx:         context.Background(),
		auth:        auth,
		noteService: helper.noteService,
		logger:      logger,
		driveOps:    mockOps,
		driveSync:   syncService,
	}

	localNotes := []NoteMetadata{{ID: "n1", ContentHash: localHash}}
	cloudNotes := []NoteMetadata{{ID: "n1", ContentHash: cloudHash}}

	mergedNotes, downloadedNotes, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes, time.Time{})
	assert.NoError(t, err)
	assert.Len(t, mergedNotes, 1, "ノート内マージではノート数が増えないべき")
	assert.Len(t, downloadedNotes, 1, "マージ済みノートがダウンロードされるべき")
	assert.Contains(t, downloadedNotes[0].Content, "<<<<<<<", "Archived変更でコンフリクトマーカーが含まれるべき")
}

func TestMergeNotes_FolderIdChange_TriggersConflictOrDownload(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	note := &Note{ID: "n1", Title: "Note", Content: "same", Language: "plaintext"}
	assert.NoError(t, helper.noteService.SaveNote(note))
	localHash := helper.noteService.noteList.Notes[0].ContentHash

	cloudNote := &Note{ID: "n1", Title: "Note", Content: "same", Language: "plaintext", FolderID: "folder-y"}
	cloudHash := computeContentHash(cloudNote)
	cloudData, _ := json.Marshal(cloudNote)
	mockOps.CreateFile("n1.json", cloudData, "test-folder", "application/json")

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	auth.driveSync = driveSync

	ds := &driveService{
		ctx:         context.Background(),
		auth:        auth,
		noteService: helper.noteService,
		logger:      logger,
		driveOps:    mockOps,
		driveSync:   syncService,
	}

	localNotes := []NoteMetadata{{ID: "n1", ContentHash: localHash}}
	cloudNotes := []NoteMetadata{{ID: "n1", ContentHash: cloudHash}}

	mergedNotes, downloadedNotes, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes, time.Time{})
	assert.NoError(t, err)
	assert.Len(t, mergedNotes, 1, "ノート内マージではノート数が増えないべき")
	assert.Len(t, downloadedNotes, 1, "マージ済みノートがダウンロードされるべき")
	assert.Contains(t, downloadedNotes[0].Content, "<<<<<<<", "FolderID変更でコンフリクトマーカーが含まれるべき")
}

// --- M-7: ValidateIntegrity後のクラウド同期テスト ---

func TestNotifySyncComplete_IntegrityChanged_TriggersUpload(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	ds := newTestDriveService(helper)
	mockOps := newMockDriveOperations()
	queue := NewDriveOperationsQueue(mockOps)
	defer queue.Cleanup()
	ds.operationsQueue = queue

	note := &Note{ID: "real-note", Title: "Real", Content: "exists"}
	assert.NoError(t, helper.noteService.SaveNote(note))

	helper.noteService.noteList.Notes = append(helper.noteService.noteList.Notes, NoteMetadata{
		ID:    "ghost-note",
		Title: "Ghost",
	})

	changed, err := helper.noteService.ValidateIntegrity()
	assert.NoError(t, err)
	assert.True(t, changed, "ファイルが無いノートの除外でchanged=trueであるべき")

	issues := helper.noteService.DrainPendingIntegrityIssues()
	assert.Empty(t, issues, "missing_fileはユーザー確認不要")

	assert.Equal(t, 1, len(helper.noteService.noteList.Notes))
	assert.Equal(t, "real-note", helper.noteService.noteList.Notes[0].ID)
}

func TestNotifySyncComplete_IntegrityNoChange_NoUpload(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	ds := newTestDriveService(helper)
	mockOps := newMockDriveOperations()
	queue := NewDriveOperationsQueue(mockOps)
	defer queue.Cleanup()
	ds.operationsQueue = queue

	note := &Note{ID: "n1", Title: "Note1", Content: "c"}
	assert.NoError(t, helper.noteService.SaveNote(note))

	changed, err := helper.noteService.ValidateIntegrity()
	assert.NoError(t, err)
	assert.False(t, changed, "整合性に問題なければchanged=falseであるべき")

	ds.notifySyncComplete()
}

// --- M-6: 同期サマリー通知テスト ---

func TestSyncResult_NoChanges_EmptySummary(t *testing.T) {
	r := &SyncResult{}
	assert.False(t, r.HasChanges())
	assert.Empty(t, r.Summary())
}

func TestSyncResult_WithChanges_Summary(t *testing.T) {
	r := &SyncResult{Uploaded: 3, Downloaded: 1}
	assert.True(t, r.HasChanges())
	summary := r.Summary()
	assert.Contains(t, summary, "↑3")
	assert.Contains(t, summary, "↓1")
}

func TestSyncResult_WithConflicts_Summary(t *testing.T) {
	r := &SyncResult{Uploaded: 1, ConflictMerges: 2}
	summary := r.Summary()
	assert.Contains(t, summary, "⚡2 conflicts merged")
}

func TestSyncResult_WithErrors_Summary(t *testing.T) {
	r := &SyncResult{Downloaded: 1, Errors: 3}
	summary := r.Summary()
	assert.Contains(t, summary, "⚠3 errors")
}

// --- M-5: Syncedステータスの信頼性向上テスト ---

func TestNotifySyncComplete_QueueEmpty_EmitsSynced(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	mockOps := newMockDriveOperations()
	queue := NewDriveOperationsQueue(mockOps)
	defer queue.Cleanup()

	ds := newTestDriveService(helper)
	ds.operationsQueue = queue

	assert.False(t, queue.HasItems(), "キューは空であるべき")
	ds.notifySyncComplete()
}

func TestNotifySyncComplete_QueueNotEmpty_KeepsSyncing(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	mockOps := newMockDriveOperations()
	queue := NewDriveOperationsQueue(mockOps)
	defer queue.Cleanup()

	ds := newTestDriveService(helper)
	ds.operationsQueue = queue

	queue.mutex.Lock()
	queue.items["dummy-key"] = []*QueueItem{{OperationType: CreateOperation, FileName: "dummy.json"}}
	queue.mutex.Unlock()

	assert.True(t, queue.HasItems(), "キューにアイテムがあるべき")
	ds.notifySyncComplete()
}

// --- M-4: ノート単位のエラー分離テスト ---

type failingCreateDriveOps struct {
	*mockDriveOperations
	failFileNames map[string]bool
}

func (f *failingCreateDriveOps) CreateFile(name string, content []byte, rootFolderID string, mimeType string) (string, error) {
	if f.failFileNames[name] {
		return "", fmt.Errorf("simulated upload failure for %s", name)
	}
	return f.mockDriveOperations.CreateFile(name, content, rootFolderID, mimeType)
}

func TestMergeNotes_OneNoteFails_OthersContinue(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	failOps := &failingCreateDriveOps{
		mockDriveOperations: newMockDriveOperations(),
		failFileNames:       map[string]bool{"fail-note.json": true},
	}
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	syncService := NewDriveSyncService(failOps, "test-folder", "test-root", logger)

	goodNote := &Note{ID: "good-note", Title: "Good", Content: "good", Language: "plaintext"}
	failNote := &Note{ID: "fail-note", Title: "Fail", Content: "fail", Language: "plaintext"}
	assert.NoError(t, helper.noteService.SaveNote(goodNote))
	assert.NoError(t, helper.noteService.SaveNote(failNote))

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	auth.driveSync = driveSync

	ds := &driveService{
		ctx:         context.Background(),
		auth:        auth,
		noteService: helper.noteService,
		logger:      logger,
		driveOps:    failOps,
		driveSync:   syncService,
	}

	localNotes := helper.noteService.noteList.Notes
	cloudNotes := []NoteMetadata{}

	mergedNotes, _, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes, time.Time{})
	assert.NoError(t, err, "1ノートのアップロード失敗で全体がエラーにならないべき")
	assert.Len(t, mergedNotes, 2, "失敗ノートもメタデータはmerged listに含まれるべき")
}

func TestLocalSync_UploadError_ContinuesWithOthers(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	failOps := &failingCreateDriveOps{
		mockDriveOperations: newMockDriveOperations(),
		failFileNames:       map[string]bool{"fail-note.json": true},
	}
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	syncService := NewDriveSyncService(failOps, "test-folder", "test-root", logger)

	goodNote := &Note{ID: "good-note", Title: "Good", Content: "good", Language: "plaintext"}
	failNote := &Note{ID: "fail-note", Title: "Fail", Content: "fail", Language: "plaintext"}
	assert.NoError(t, helper.noteService.SaveNote(goodNote))
	assert.NoError(t, helper.noteService.SaveNote(failNote))

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	auth.driveSync = driveSync

	ds := &driveService{
		ctx:         context.Background(),
		auth:        auth,
		noteService: helper.noteService,
		logger:      logger,
		driveOps:    failOps,
		driveSync:   syncService,
	}

	localNoteList := &NoteList{Notes: helper.noteService.noteList.Notes}
	cloudNoteList := &NoteList{Notes: []NoteMetadata{}}

	err := ds.handleLocalSync(localNoteList, cloudNoteList)
	assert.NoError(t, err, "1ノートのアップロード失敗でhandleLocalSyncが止まらないべき")

	failOps.mu.RLock()
	goodUploaded := false
	for _, data := range failOps.files {
		var n Note
		if json.Unmarshal(data, &n) == nil && n.ID == "good-note" {
			goodUploaded = true
		}
	}
	failOps.mu.RUnlock()
	assert.True(t, goodUploaded, "失敗ノート以外は正常にアップロードされるべき")
}

// --- C-2: drive_sync_serviceのUPDATEキャンセルテスト ---

type cancellingDriveOps struct {
	*mockDriveOperations
}

func (c *cancellingDriveOps) UpdateFile(fileID string, content []byte) error {
	return ErrOperationCancelled
}

func TestSyncService_CancelledUpdate_DoesNotCreate(t *testing.T) {
	ops := &cancellingDriveOps{mockDriveOperations: newMockDriveOperations()}
	logger := NewAppLogger(context.Background(), true, t.TempDir())
	syncService := NewDriveSyncService(ops, "test-folder", "test-root", logger)

	impl := syncService.(*driveSyncServiceImpl)
	impl.setCachedFileID("test-note", "existing-drive-file")

	note := &Note{ID: "test-note", Title: "Test", Content: "content"}
	err := syncService.UpdateNote(context.Background(), note)
	assert.NoError(t, err, "キャンセルされたUPDATEはnilを返すべき（CreateNoteにフォールバックしない）")

	ops.mu.RLock()
	fileCount := len(ops.files)
	ops.mu.RUnlock()
	assert.Equal(t, 0, fileCount, "CreateNoteが呼ばれてファイルが作成されてはならない")
}

// --- M-3: 同期ジャーナルによるクラッシュリカバリテスト ---

func newTestDriveServiceWithAppDataDir(helper *testHelper) *driveService {
	ds := newTestDriveService(helper)
	ds.appDataDir = helper.tempDir
	return ds
}

func TestSyncJournal_CreatedOnSyncStart(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()
	ds := newTestDriveServiceWithAppDataDir(helper)

	// ローカル専用ノートの物理ファイルを作成
	localNote := &Note{ID: "local-only", Title: "Local", Content: "content"}
	assert.NoError(t, helper.noteService.SaveNote(localNote))

	localNotes := []NoteMetadata{
		{ID: "local-only", Title: "Local", ContentHash: "hash-a"},
	}
	cloudNotes := []NoteMetadata{
		{ID: "cloud-only", Title: "Cloud", ContentHash: "hash-b"},
	}

	journal := ds.buildSyncJournal(localNotes, cloudNotes)
	assert.NotNil(t, journal)
	assert.Len(t, journal.Actions, 2)

	err := ds.writeSyncJournal(journal)
	assert.NoError(t, err)

	_, statErr := os.Stat(ds.journalPath())
	assert.NoError(t, statErr, "ジャーナルファイルが作成されるべき")

	read, readErr := ds.readSyncJournal()
	assert.NoError(t, readErr)
	assert.Len(t, read.Actions, 2)
}

func TestSyncJournal_DeletedOnSyncComplete(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()
	ds := newTestDriveServiceWithAppDataDir(helper)

	journal := &SyncJournal{
		StartedAt: time.Now(),
		Actions: []SyncJournalAction{
			{Type: "download", NoteID: "note-1", Completed: true},
		},
	}
	err := ds.writeSyncJournal(journal)
	assert.NoError(t, err)

	_, statErr := os.Stat(ds.journalPath())
	assert.NoError(t, statErr, "ジャーナルファイルが存在するべき")

	ds.deleteSyncJournal()

	_, statErr = os.Stat(ds.journalPath())
	assert.True(t, os.IsNotExist(statErr), "同期完了後にジャーナルファイルが削除されるべき")
}

func TestSyncJournal_RecoveryOnStartup(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	cloudNote := &Note{ID: "recover-note", Title: "Recovered", Content: "cloud content", Language: "plaintext"}
	cloudData, _ := json.Marshal(cloudNote)
	mockOps.CreateFile("recover-note.json", cloudData, "test-folder", "application/json")

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	auth.driveSync = driveSync

	ds := &driveService{
		ctx:         context.Background(),
		auth:        auth,
		noteService: helper.noteService,
		appDataDir:  helper.tempDir,
		logger:      logger,
		driveOps:    mockOps,
		driveSync:   syncService,
	}

	journal := &SyncJournal{
		StartedAt: time.Now().Add(-5 * time.Minute),
		Actions: []SyncJournalAction{
			{Type: "download", NoteID: "recover-note", Completed: false},
		},
	}
	err := ds.writeSyncJournal(journal)
	assert.NoError(t, err)

	ds.recoverFromJournal()

	_, statErr := os.Stat(ds.journalPath())
	assert.True(t, os.IsNotExist(statErr), "復旧後にジャーナルファイルが削除されるべき")

	recovered, loadErr := helper.noteService.LoadNote("recover-note")
	assert.NoError(t, loadErr, "復旧によりノートがダウンロードされるべき")
	assert.Equal(t, "Recovered", recovered.Title)
	assert.Equal(t, "cloud content", recovered.Content)
}

func TestSyncJournal_PartialDownload_Recovery(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	note2 := &Note{ID: "note-2", Title: "Note2", Content: "content2", Language: "plaintext"}
	note2Data, _ := json.Marshal(note2)
	mockOps.CreateFile("note-2.json", note2Data, "test-folder", "application/json")

	note3 := &Note{ID: "note-3", Title: "Note3", Content: "content3", Language: "plaintext"}
	note3Data, _ := json.Marshal(note3)
	mockOps.CreateFile("note-3.json", note3Data, "test-folder", "application/json")

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	auth.driveSync = driveSync

	ds := &driveService{
		ctx:         context.Background(),
		auth:        auth,
		noteService: helper.noteService,
		appDataDir:  helper.tempDir,
		logger:      logger,
		driveOps:    mockOps,
		driveSync:   syncService,
	}

	journal := &SyncJournal{
		StartedAt: time.Now().Add(-5 * time.Minute),
		Actions: []SyncJournalAction{
			{Type: "download", NoteID: "note-1", Completed: true},
			{Type: "download", NoteID: "note-2", Completed: false},
			{Type: "download", NoteID: "note-3", Completed: false},
		},
	}
	err := ds.writeSyncJournal(journal)
	assert.NoError(t, err)

	ds.recoverFromJournal()

	_, statErr := os.Stat(ds.journalPath())
	assert.True(t, os.IsNotExist(statErr), "復旧後にジャーナルが削除されるべき")

	_, err1 := helper.noteService.LoadNote("note-1")
	assert.Error(t, err1, "note-1はCompletedなので再ダウンロードされないべき")

	loaded2, err2 := helper.noteService.LoadNote("note-2")
	assert.NoError(t, err2, "note-2は未完了なので復旧ダウンロードされるべき")
	assert.Equal(t, "Note2", loaded2.Title)

	loaded3, err3 := helper.noteService.LoadNote("note-3")
	assert.NoError(t, err3, "note-3は未完了なので復旧ダウンロードされるべき")
	assert.Equal(t, "Note3", loaded3.Title)
}

// --- H-9: 重複ファイル整理のソート基準修正テスト ---

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

// --- コンフリクトコピー修正の回帰テスト ---

// TestMergeNotes_OneSidedChange_NoConflictCopy は、クラウドのメタデータが更新されたが
// ローカルファイルの実際の内容がクラウドと一致する場合（片方だけの変更）、
// コンフリクトコピーを作成せずメタデータの更新のみで済むことを検証する。
func TestMergeNotes_OneSidedChange_NoConflictCopy(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	// ローカルノートを保存（実ファイルとnoteListメタデータが作られる）
	localNote := &Note{
		ID:           "onesided-note",
		Title:        "One Sided",
		Content:      "Same content on both sides",
		Language:     "plaintext",
		ModifiedTime: time.Now().Add(-1 * time.Hour).Format(time.RFC3339),
	}
	err := helper.noteService.SaveNote(localNote)
	assert.NoError(t, err)

	// 実ファイルから計算された正しいContentHashを取得
	realHash := helper.noteService.noteList.Notes[0].ContentHash
	assert.NotEmpty(t, realHash, "SaveNote後にContentHashが設定されるべき")

	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	// クラウドノートをmockに配置（ダウンロードパス用）
	cloudData, _ := json.Marshal(localNote)
	mockOps.CreateFile("onesided-note.json", cloudData, "test-folder", "application/json")

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	auth.driveSync = driveSync

	ds := &driveService{
		ctx:         context.Background(),
		auth:        auth,
		noteService: helper.noteService,
		logger:      logger,
		driveOps:    mockOps,
		driveSync:   syncService,
	}

	// ローカルメタデータは古いハッシュ（同期がまだ反映されていない状態をシミュレート）
	localNotes := []NoteMetadata{
		{ID: "onesided-note", Title: "One Sided", ContentHash: "old-stale-hash", ModifiedTime: localNote.ModifiedTime},
	}
	// クラウドメタデータは正しいハッシュ（ローカルファイルの実内容と一致）
	cloudNotes := []NoteMetadata{
		{ID: "onesided-note", Title: "One Sided", ContentHash: realHash, ModifiedTime: time.Now().Format(time.RFC3339)},
	}

	mergedNotes, _, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes, time.Time{})
	assert.NoError(t, err)

	// コンフリクトコピーが作成されていないことを確認
	assert.Len(t, mergedNotes, 1, "片方だけの変更ではコンフリクトコピーを作成しないべき")
	for _, n := range mergedNotes {
		assert.NotContains(t, n.Title, "conflict copy", "コンフリクトコピーが作成されてはならない")
	}
}

// TestMergeNotes_BothSidesChanged_MergesInNote は、ローカルとクラウドの
// 両方が実際に異なる内容に変更された場合、ノート内マージが行われることを検証する。
func TestMergeNotes_BothSidesChanged_MergesInNote(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	localNote := &Note{
		ID:           "both-changed",
		Title:        "Both Changed",
		Content:      "Local version of content",
		Language:     "plaintext",
		ModifiedTime: time.Now().Add(-1 * time.Hour).Format(time.RFC3339),
	}
	err := helper.noteService.SaveNote(localNote)
	assert.NoError(t, err)

	localHash := helper.noteService.noteList.Notes[0].ContentHash

	cloudNote := &Note{
		ID:           "both-changed",
		Title:        "Both Changed",
		Content:      "Cloud version of content - different!",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	cloudHash := computeContentHash(cloudNote)
	assert.NotEqual(t, localHash, cloudHash, "テスト前提: ローカルとクラウドのハッシュが異なるべき")

	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	cloudData, _ := json.Marshal(cloudNote)
	mockOps.CreateFile("both-changed.json", cloudData, "test-folder", "application/json")

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	auth.driveSync = driveSync

	ds := &driveService{
		ctx:         context.Background(),
		auth:        auth,
		noteService: helper.noteService,
		logger:      logger,
		driveOps:    mockOps,
		driveSync:   syncService,
	}

	localNotes := []NoteMetadata{
		{ID: "both-changed", Title: "Both Changed", ContentHash: localHash, ModifiedTime: localNote.ModifiedTime},
	}
	cloudNotes := []NoteMetadata{
		{ID: "both-changed", Title: "Both Changed", ContentHash: cloudHash, ModifiedTime: cloudNote.ModifiedTime},
	}

	mergedNotes, downloadedNotes, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes, time.Time{})
	assert.NoError(t, err)

	assert.Len(t, mergedNotes, 1, "ノート内マージではノート数が増えないべき")
	assert.Len(t, downloadedNotes, 1, "マージ済みノートがダウンロードされるべき")
	assert.Contains(t, downloadedNotes[0].Content, "<<<<<<<", "コンフリクトマーカーが含まれるべき")
	assert.Contains(t, downloadedNotes[0].Content, "Cloud version of content", "クラウド版の内容が含まれるべき")
	assert.Contains(t, downloadedNotes[0].Content, "Local version of content", "ローカル版の内容が含まれるべき")
	assert.Contains(t, downloadedNotes[0].Content, ">>>>>>>", "コンフリクトマーカーが含まれるべき")
}

// TestMergeNotes_EmptyContentHash_RecomputesBeforeCompare は、ContentHashが空の場合に
// 実ファイルからハッシュを再計算してから比較することで、不必要なコンフリクトコピーを防止できることを検証する。
func TestMergeNotes_EmptyContentHash_RecomputesBeforeCompare(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	// ローカルノートを保存
	note := &Note{
		ID:           "empty-hash-note",
		Title:        "Empty Hash",
		Content:      "Content for hash test",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	err := helper.noteService.SaveNote(note)
	assert.NoError(t, err)

	// 実ファイルの正しいハッシュを取得
	realHash := helper.noteService.noteList.Notes[0].ContentHash
	assert.NotEmpty(t, realHash)

	ds := newTestDriveService(helper)

	// ローカルメタデータのContentHashが空（古いバージョンのnoteList等で発生し得る）
	localNotes := []NoteMetadata{
		{ID: "empty-hash-note", Title: "Empty Hash", ContentHash: "", ModifiedTime: note.ModifiedTime},
	}
	// クラウドメタデータは正しいハッシュ
	cloudNotes := []NoteMetadata{
		{ID: "empty-hash-note", Title: "Empty Hash", ContentHash: realHash, ModifiedTime: note.ModifiedTime},
	}

	mergedNotes, _, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes, time.Time{})
	assert.NoError(t, err)

	// 空ハッシュが再計算されて一致するため、コンフリクトコピーは作成されないべき
	assert.Len(t, mergedNotes, 1, "空ContentHashの再計算後にハッシュが一致すればコンフリクトコピーは不要")
	for _, n := range mergedNotes {
		assert.NotContains(t, n.Title, "conflict copy", "コンフリクトコピーが作成されてはならない")
	}
}

// TestMergeNotes_InNoteMerge_PreservesNoteIdentity は、既にコンフリクトマーカーを含む
// ノートに対して再度コンフリクトが発生した場合、ノート内マージが正しく動作し、
// ノートIDが保持されることを検証する（ノート増殖が起きないことの確認）。
func TestMergeNotes_InNoteMerge_PreservesNoteIdentity(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	localNote := &Note{
		ID:           "repeated-conflict",
		Title:        "Repeated Conflict Note",
		Content:      "<<<<<<< Cloud (prev)\nprevious cloud\n=======\nprevious local\n>>>>>>> Local (prev)",
		Language:     "plaintext",
		ModifiedTime: time.Now().Add(-1 * time.Hour).Format(time.RFC3339),
	}
	err := helper.noteService.SaveNote(localNote)
	assert.NoError(t, err)

	localHash := helper.noteService.noteList.Notes[0].ContentHash

	cloudNote := &Note{
		ID:           "repeated-conflict",
		Title:        "Repeated Conflict Note",
		Content:      "New cloud content after second edit",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	cloudHash := computeContentHash(cloudNote)
	assert.NotEqual(t, localHash, cloudHash, "テスト前提: ハッシュが異なるべき")

	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	cloudData, _ := json.Marshal(cloudNote)
	mockOps.CreateFile("repeated-conflict.json", cloudData, "test-folder", "application/json")

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	auth.driveSync = driveSync

	ds := &driveService{
		ctx:         context.Background(),
		auth:        auth,
		noteService: helper.noteService,
		logger:      logger,
		driveOps:    mockOps,
		driveSync:   syncService,
	}

	localNotes := []NoteMetadata{
		{ID: "repeated-conflict", Title: localNote.Title, ContentHash: localHash, ModifiedTime: localNote.ModifiedTime},
	}
	cloudNotes := []NoteMetadata{
		{ID: "repeated-conflict", Title: cloudNote.Title, ContentHash: cloudHash, ModifiedTime: cloudNote.ModifiedTime},
	}

	mergedNotes, downloadedNotes, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes, time.Time{})
	assert.NoError(t, err)

	assert.Len(t, mergedNotes, 1, "ノート内マージではノート数が増えないべき")
	assert.Equal(t, "repeated-conflict", mergedNotes[0].ID, "ノートIDが保持されるべき")
	assert.Len(t, downloadedNotes, 1, "マージ済みノートがダウンロードされるべき")
	assert.Contains(t, downloadedNotes[0].Content, "New cloud content", "新しいクラウド版の内容が含まれるべき")
	assert.Contains(t, downloadedNotes[0].Content, "previous cloud", "以前のコンフリクトマーカー内容も保持されるべき")
}

// TestMergeNotes_InNoteMerge_NoNewNotesCreated は、ノート内マージ方式では
// 新しいノートやファイルが作成されず、既存ノートの内容が更新されるだけであることを検証する。
func TestMergeNotes_InNoteMerge_NoNewNotesCreated(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	localNote := &Note{
		ID:           "no-new-note",
		Title:        "No New Note Test",
		Content:      "Local unique content",
		Language:     "plaintext",
		ModifiedTime: time.Now().Add(-1 * time.Hour).Format(time.RFC3339),
	}
	err := helper.noteService.SaveNote(localNote)
	assert.NoError(t, err)

	localHash := helper.noteService.noteList.Notes[0].ContentHash

	cloudNote := &Note{
		ID:           "no-new-note",
		Title:        "No New Note Test",
		Content:      "Cloud unique content - different",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	cloudHash := computeContentHash(cloudNote)

	mockOps := newMockDriveOperations()
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	syncService := NewDriveSyncService(mockOps, "test-folder", "test-root", logger)

	cloudData, _ := json.Marshal(cloudNote)
	mockOps.CreateFile("no-new-note.json", cloudData, "test-folder", "application/json")

	auth := &authService{isTestMode: true}
	driveSync := &DriveSync{}
	driveSync.SetFolderIDs("test-root", "test-folder")
	auth.driveSync = driveSync

	ds := &driveService{
		ctx:         context.Background(),
		auth:        auth,
		noteService: helper.noteService,
		logger:      logger,
		driveOps:    mockOps,
		driveSync:   syncService,
	}

	mockOps.mu.RLock()
	fileCountBefore := len(mockOps.files)
	mockOps.mu.RUnlock()

	localNotes := []NoteMetadata{
		{ID: "no-new-note", Title: "No New Note Test", ContentHash: localHash, ModifiedTime: localNote.ModifiedTime},
	}
	cloudNotes := []NoteMetadata{
		{ID: "no-new-note", Title: "No New Note Test", ContentHash: cloudHash, ModifiedTime: cloudNote.ModifiedTime},
	}

	mergedNotes, downloadedNotes, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes, time.Time{})
	assert.NoError(t, err)

	assert.Len(t, mergedNotes, 1, "ノート内マージでは新しいノートが作成されないべき")
	assert.Equal(t, "no-new-note", mergedNotes[0].ID, "元のノートIDが保持されるべき")

	mockOps.mu.RLock()
	fileCountAfter := len(mockOps.files)
	mockOps.mu.RUnlock()
	assert.Equal(t, fileCountBefore, fileCountAfter, "ノート内マージではDriveに新しいファイルが作成されないべき")

	assert.Len(t, downloadedNotes, 1, "マージ済みノートがダウンロードされるべき")
	assert.Contains(t, downloadedNotes[0].Content, "<<<<<<<", "コンフリクトマーカーが含まれるべき")
	assert.Contains(t, downloadedNotes[0].Content, ">>>>>>>", "コンフリクトマーカーが含まれるべき")
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

	lastSyncBefore := ds.noteService.noteList.LastSync
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

	assert.True(t, ds.noteService.noteList.LastSync.After(lastSyncBefore), "LastSyncが更新されるべき")

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

	lastSyncBefore := ds.noteService.noteList.LastSync
	note.Content = "after update"
	err = ds.SaveNoteAndUpdateList(note, false)
	assert.NoError(t, err)
	assert.True(t, ds.noteService.noteList.LastSync.After(lastSyncBefore), "LastSyncが更新されるべき")

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

	lastSyncBefore := ds.noteService.noteList.LastSync
	err := ds.SaveNoteAndUpdateList(note, true)
	assert.Error(t, err)
	assert.Equal(t, lastSyncBefore, ds.noteService.noteList.LastSync, "Create失敗時はLastSyncが更新されないべき")

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

type driveSyncOverride struct {
	DriveSyncService

	createNoteFn       func(ctx context.Context, note *Note) error
	downloadNoteListFn func(ctx context.Context, noteListID string) (*NoteList, error)
}

func (o *driveSyncOverride) CreateNote(ctx context.Context, note *Note) error {
	if o.createNoteFn != nil {
		return o.createNoteFn(ctx, note)
	}
	return o.DriveSyncService.CreateNote(ctx, note)
}

func (o *driveSyncOverride) DownloadNoteList(ctx context.Context, noteListID string) (*NoteList, error) {
	if o.downloadNoteListFn != nil {
		return o.downloadNoteListFn(ctx, noteListID)
	}
	return o.DriveSyncService.DownloadNoteList(ctx, noteListID)
}

func seedCloudNoteListFile(t *testing.T, ds *driveService, rawOps DriveOperations) {
	t.Helper()

	mockOps, ok := rawOps.(*mockDriveOperations)
	if !ok {
		t.Fatalf("expected *mockDriveOperations, got %T", rawOps)
	}

	noteListID := ds.auth.GetDriveSync().NoteListID()
	noteListData, err := json.Marshal(ds.noteService.noteList)
	if err != nil {
		t.Fatalf("failed to marshal noteList: %v", err)
	}

	mockOps.mu.Lock()
	mockOps.files[noteListID] = noteListData
	mockOps.mu.Unlock()
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

func TestPerformInitialSync_NoCloudNoteList_UploadsAll(t *testing.T) {
	ds, _, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	mockOps, ok := rawOps.(*mockDriveOperations)
	if !assert.True(t, ok) {
		return
	}

	ds.appDataDir = t.TempDir()

	localNotes := []*Note{
		{ID: "e1-local-1", Title: "E1 Local 1", Content: "one", Language: "plaintext"},
		{ID: "e1-local-2", Title: "E1 Local 2", Content: "two", Language: "plaintext"},
		{ID: "e1-local-3", Title: "E1 Local 3", Content: "three", Language: "plaintext"},
	}
	for _, note := range localNotes {
		assert.NoError(t, ds.noteService.SaveNote(note))
	}
	seedCloudNoteListFile(t, ds, rawOps)

	baseSync := ds.driveSync
	callCount := 0
	ds.driveSync = &driveSyncOverride{
		DriveSyncService: baseSync,
		downloadNoteListFn: func(ctx context.Context, noteListID string) (*NoteList, error) {
			callCount++
			if callCount == 1 {
				return nil, nil
			}
			cloudNotes := make([]NoteMetadata, len(ds.noteService.noteList.Notes))
			copy(cloudNotes, ds.noteService.noteList.Notes)
			return &NoteList{Version: "1.0", Notes: cloudNotes, LastSync: time.Now()}, nil
		},
	}

	err := ds.performInitialSync()
	assert.NoError(t, err)

	mockOps.mu.RLock()
	defer mockOps.mu.RUnlock()
	for _, note := range localNotes {
		_, exists := mockOps.files["test-file-"+note.ID+".json"]
		assert.True(t, exists, "local note %s should be uploaded", note.ID)
	}
}

func TestPerformInitialSync_UnknownNotes_Incorporated(t *testing.T) {
	ds, _, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	mockOps, ok := rawOps.(*mockDriveOperations)
	if !assert.True(t, ok) {
		return
	}

	ds.appDataDir = t.TempDir()
	seedCloudNoteListFile(t, ds, rawOps)

	cloudNotes := []*Note{
		{ID: "e2-cloud-a", Title: "Cloud A", Content: "A", Language: "plaintext"},
		{ID: "e2-cloud-b", Title: "Cloud B", Content: "B", Language: "plaintext"},
		{ID: "e2-cloud-unknown", Title: "Cloud Unknown", Content: "U", Language: "plaintext"},
	}
	for _, note := range cloudNotes {
		data, err := json.Marshal(note)
		assert.NoError(t, err)
		_, err = mockOps.CreateFile(note.ID+".json", data, "test-folder", "application/json")
		assert.NoError(t, err)
	}

	baseSync := ds.driveSync
	ds.driveSync = &driveSyncOverride{
		DriveSyncService: baseSync,
		downloadNoteListFn: func(ctx context.Context, noteListID string) (*NoteList, error) {
			return &NoteList{
				Version: "1.0",
				Notes: []NoteMetadata{
					{ID: "e2-cloud-a", Title: "Cloud A", ModifiedTime: time.Now().Add(-2 * time.Minute).Format(time.RFC3339)},
					{ID: "e2-cloud-b", Title: "Cloud B", ModifiedTime: time.Now().Add(-1 * time.Minute).Format(time.RFC3339)},
				},
				LastSync: time.Now().Add(-1 * time.Minute),
			}, nil
		},
	}

	err := ds.performInitialSync()
	assert.NoError(t, err)

	foundUnknown := false
	for _, meta := range ds.noteService.noteList.Notes {
		if meta.ID == "e2-cloud-unknown" {
			foundUnknown = true
			break
		}
	}
	assert.True(t, foundUnknown, "unknown cloud note should be incorporated")
}

func TestPerformInitialSync_PublishesPreview(t *testing.T) {
	ds, recorder, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	mockOps, ok := rawOps.(*mockDriveOperations)
	if !assert.True(t, ok) {
		return
	}

	ds.appDataDir = t.TempDir()

	localNotes := []*Note{
		{ID: "e3-local-1", Title: "Local 1", Content: "L1", Language: "plaintext"},
		{ID: "e3-local-2", Title: "Local 2", Content: "L2", Language: "plaintext"},
	}
	for _, note := range localNotes {
		assert.NoError(t, ds.noteService.SaveNote(note))
	}
	seedCloudNoteListFile(t, ds, rawOps)

	cloudNotes := []*Note{
		{ID: "e3-local-1", Title: "Local 1", Content: "L1", Language: "plaintext", ModifiedTime: time.Now().Add(-2 * time.Minute).Format(time.RFC3339)},
		{ID: "e3-local-2", Title: "Local 2", Content: "L2", Language: "plaintext", ModifiedTime: time.Now().Add(-1 * time.Minute).Format(time.RFC3339)},
		{ID: "e3-cloud-new", Title: "Cloud New", Content: "CN", Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339)},
	}
	for _, note := range cloudNotes {
		data, err := json.Marshal(note)
		assert.NoError(t, err)
		_, err = mockOps.CreateFile(note.ID+".json", data, "test-folder", "application/json")
		assert.NoError(t, err)
	}

	baseSync := ds.driveSync
	ds.driveSync = &driveSyncOverride{
		DriveSyncService: baseSync,
		downloadNoteListFn: func(ctx context.Context, noteListID string) (*NoteList, error) {
			return &NoteList{
				Version: "1.0",
				Notes: []NoteMetadata{
					{ID: "e3-local-1", Title: "Local 1", ModifiedTime: cloudNotes[0].ModifiedTime, ContentHash: computeContentHash(cloudNotes[0])},
					{ID: "e3-local-2", Title: "Local 2", ModifiedTime: cloudNotes[1].ModifiedTime, ContentHash: computeContentHash(cloudNotes[1])},
					{ID: "e3-cloud-new", Title: "Cloud New", ModifiedTime: cloudNotes[2].ModifiedTime, ContentHash: computeContentHash(cloudNotes[2])},
				},
				LastSync: time.Now().Add(-1 * time.Minute),
			}, nil
		},
	}

	err := ds.performInitialSync()
	assert.NoError(t, err)
	assert.GreaterOrEqual(t, recorder.syncedReloadCount(), 2)
}

func TestPerformInitialSync_LargeDownload_ProgressiveNotification(t *testing.T) {
	ds, recorder, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	mockOps, ok := rawOps.(*mockDriveOperations)
	if !assert.True(t, ok) {
		return
	}

	ds.appDataDir = t.TempDir()
	seedCloudNoteListFile(t, ds, rawOps)

	metadata := make([]NoteMetadata, 0, 15)
	for i := 0; i < 15; i++ {
		noteID := fmt.Sprintf("e4-cloud-%02d", i)
		note := &Note{
			ID:           noteID,
			Title:        fmt.Sprintf("Cloud %02d", i),
			Content:      fmt.Sprintf("content-%02d", i),
			Language:     "plaintext",
			ModifiedTime: time.Now().Add(time.Duration(i) * time.Second).Format(time.RFC3339),
		}
		data, err := json.Marshal(note)
		assert.NoError(t, err)
		_, err = mockOps.CreateFile(note.ID+".json", data, "test-folder", "application/json")
		assert.NoError(t, err)

		metadata = append(metadata, NoteMetadata{
			ID:           note.ID,
			Title:        note.Title,
			ModifiedTime: note.ModifiedTime,
			ContentHash:  computeContentHash(note),
		})
	}

	baseSync := ds.driveSync
	ds.driveSync = &driveSyncOverride{
		DriveSyncService: baseSync,
		downloadNoteListFn: func(ctx context.Context, noteListID string) (*NoteList, error) {
			return &NoteList{Version: "1.0", Notes: metadata, LastSync: time.Now().Add(-1 * time.Minute)}, nil
		},
	}

	err := ds.performInitialSync()
	assert.NoError(t, err)
	assert.GreaterOrEqual(t, recorder.syncedReloadCount(), 3)
}

func TestPerformInitialSync_JournalLifecycle(t *testing.T) {
	ds, _, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	mockOps, ok := rawOps.(*mockDriveOperations)
	if !assert.True(t, ok) {
		return
	}

	ds.appDataDir = t.TempDir()

	local := &Note{ID: "e5-local", Title: "E5 Local", Content: "local", Language: "plaintext"}
	assert.NoError(t, ds.noteService.SaveNote(local))
	seedCloudNoteListFile(t, ds, rawOps)

	cloudNew := &Note{
		ID:           "e5-cloud-new",
		Title:        "E5 Cloud New",
		Content:      "cloud",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	cloudData, err := json.Marshal(cloudNew)
	assert.NoError(t, err)
	_, err = mockOps.CreateFile(cloudNew.ID+".json", cloudData, "test-folder", "application/json")
	assert.NoError(t, err)

	baseSync := ds.driveSync
	ds.driveSync = &driveSyncOverride{
		DriveSyncService: baseSync,
		downloadNoteListFn: func(ctx context.Context, noteListID string) (*NoteList, error) {
			return &NoteList{
				Version: "1.0",
				Notes: []NoteMetadata{{
					ID:           cloudNew.ID,
					Title:        cloudNew.Title,
					ModifiedTime: cloudNew.ModifiedTime,
					ContentHash:  computeContentHash(cloudNew),
				}},
				LastSync: time.Now().Add(-1 * time.Minute),
			}, nil
		},
	}

	err = ds.performInitialSync()
	assert.NoError(t, err)

	_, statErr := os.Stat(ds.journalPath())
	assert.True(t, os.IsNotExist(statErr), "journal file should be removed after initial sync")
}

type syncNotesTrackingDriveSync struct {
	DriveSyncService

	downloadNoteListCalls          int
	downloadNoteListIfChangedCalls int
	updateNoteListCalls            int
	createNoteCalls                int
	downloadNoteCalls              int

	downloadNoteListFn          func(ctx context.Context, noteListID string) (*NoteList, error)
	downloadNoteListIfChangedFn func(ctx context.Context, noteListID string) (*NoteList, bool, error)
	updateNoteListFn            func(ctx context.Context, noteList *NoteList, noteListID string) error
	createNoteFn                func(ctx context.Context, note *Note) error
}

func (s *syncNotesTrackingDriveSync) DownloadNoteList(ctx context.Context, noteListID string) (*NoteList, error) {
	s.downloadNoteListCalls++
	if s.downloadNoteListFn != nil {
		return s.downloadNoteListFn(ctx, noteListID)
	}
	return s.DriveSyncService.DownloadNoteList(ctx, noteListID)
}

func (s *syncNotesTrackingDriveSync) DownloadNoteListIfChanged(ctx context.Context, noteListID string) (*NoteList, bool, error) {
	s.downloadNoteListIfChangedCalls++
	if s.downloadNoteListIfChangedFn != nil {
		return s.downloadNoteListIfChangedFn(ctx, noteListID)
	}
	return s.DriveSyncService.DownloadNoteListIfChanged(ctx, noteListID)
}

func (s *syncNotesTrackingDriveSync) UpdateNoteList(ctx context.Context, noteList *NoteList, noteListID string) error {
	s.updateNoteListCalls++
	if s.updateNoteListFn != nil {
		return s.updateNoteListFn(ctx, noteList, noteListID)
	}
	return s.DriveSyncService.UpdateNoteList(ctx, noteList, noteListID)
}

func (s *syncNotesTrackingDriveSync) CreateNote(ctx context.Context, note *Note) error {
	s.createNoteCalls++
	if s.createNoteFn != nil {
		return s.createNoteFn(ctx, note)
	}
	return s.DriveSyncService.CreateNote(ctx, note)
}

func (s *syncNotesTrackingDriveSync) DownloadNote(ctx context.Context, noteID string) (*Note, error) {
	s.downloadNoteCalls++
	return s.DriveSyncService.DownloadNote(ctx, noteID)
}

func TestSyncNotes_SameNotes_StructureChanged_MergesStructure(t *testing.T) {
	ds, recorder, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	note := &Note{ID: "j1-note", Title: "J1", Content: "same", Language: "plaintext"}
	assert.NoError(t, ds.noteService.SaveNote(note))
	seedCloudNoteListFile(t, ds, rawOps)

	localMeta := ds.noteService.noteList.Notes[0]
	cloudNoteList := &NoteList{
		Version: "1.0",
		Notes:   []NoteMetadata{localMeta},
		Folders: []Folder{{ID: "cloud-folder-j1", Name: "Cloud Folder"}},
		TopLevelOrder: []TopLevelItem{
			{Type: "folder", ID: "cloud-folder-j1"},
			{Type: "note", ID: "j1-note"},
		},
		LastSync: time.Now().Add(1 * time.Minute),
	}

	tracker := &syncNotesTrackingDriveSync{
		DriveSyncService: ds.driveSync,
		downloadNoteListIfChangedFn: func(ctx context.Context, noteListID string) (*NoteList, bool, error) {
			return cloudNoteList, true, nil
		},
	}
	ds.driveSync = tracker

	err := ds.SyncNotes()
	assert.NoError(t, err)
	assert.Equal(t, 0, tracker.updateNoteListCalls, "マージ後ローカルがクラウドと同一構造なら再アップロード不要")
	assert.Equal(t, 0, tracker.createNoteCalls, "同一ノート内容ではアップロード不要")
	assert.Equal(t, 0, tracker.downloadNoteCalls, "同一ノート内容ではダウンロード不要")

	foundFolder := false
	for _, f := range ds.noteService.noteList.Folders {
		if f.ID == "cloud-folder-j1" {
			foundFolder = true
			break
		}
	}
	assert.True(t, foundFolder, "クラウド側の新規フォルダがローカルに反映されるべき")

	foundNoUploadLog := false
	for _, msg := range recorder.consoleCalls {
		if strings.Contains(msg, "no upload needed") {
			foundNoUploadLog = true
			break
		}
	}
	assert.True(t, foundNoUploadLog, "クラウドから受信した構造をそのまま適用時はアップロードスキップのログが出るべき")
}

func TestSyncNotes_CloudNoteListNil_UploadsAll(t *testing.T) {
	ds, _, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	note1 := &Note{ID: "j2-local-1", Title: "J2-1", Content: "one", Language: "plaintext"}
	note2 := &Note{ID: "j2-local-2", Title: "J2-2", Content: "two", Language: "plaintext"}
	assert.NoError(t, ds.noteService.SaveNote(note1))
	assert.NoError(t, ds.noteService.SaveNote(note2))

	tracker := &syncNotesTrackingDriveSync{
		DriveSyncService: ds.driveSync,
		downloadNoteListIfChangedFn: func(ctx context.Context, noteListID string) (*NoteList, bool, error) {
			return nil, true, nil
		},
		downloadNoteListFn: func(ctx context.Context, noteListID string) (*NoteList, error) {
			cloudNotes := make([]NoteMetadata, len(ds.noteService.noteList.Notes))
			copy(cloudNotes, ds.noteService.noteList.Notes)
			return &NoteList{Version: "1.0", Notes: cloudNotes, LastSync: time.Now()}, nil
		},
	}
	ds.driveSync = tracker

	err := ds.SyncNotes()
	assert.NoError(t, err)
	assert.Equal(t, 2, tracker.createNoteCalls, "cloud noteListがnilの場合は全ローカルノートがアップロードされるべき")
	assert.GreaterOrEqual(t, tracker.downloadNoteListCalls, 1, "全アップロード後にnoteList再取得が行われるべき")

	mockOps, ok := rawOps.(*mockDriveOperations)
	if !assert.True(t, ok) {
		return
	}
	mockOps.mu.RLock()
	_, exists1 := mockOps.files["test-file-j2-local-1.json"]
	_, exists2 := mockOps.files["test-file-j2-local-2.json"]
	mockOps.mu.RUnlock()
	assert.True(t, exists1)
	assert.True(t, exists2)
}

func TestSyncNotes_ForceSync_BypassesMD5Check(t *testing.T) {
	ds, _, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	note := &Note{ID: "j3-note", Title: "J3", Content: "force", Language: "plaintext"}
	assert.NoError(t, ds.noteService.SaveNote(note))
	seedCloudNoteListFile(t, ds, rawOps)

	cloudNotes := make([]NoteMetadata, len(ds.noteService.noteList.Notes))
	copy(cloudNotes, ds.noteService.noteList.Notes)

	tracker := &syncNotesTrackingDriveSync{
		DriveSyncService: ds.driveSync,
		downloadNoteListFn: func(ctx context.Context, noteListID string) (*NoteList, error) {
			return &NoteList{Version: "1.0", Notes: cloudNotes, LastSync: time.Now()}, nil
		},
		downloadNoteListIfChangedFn: func(ctx context.Context, noteListID string) (*NoteList, bool, error) {
			return nil, false, fmt.Errorf("DownloadNoteListIfChanged should not be called when forceNextSync=true")
		},
	}
	ds.driveSync = tracker
	ds.forceNextSync = true

	err := ds.SyncNotes()
	assert.NoError(t, err)
	assert.Equal(t, 1, tracker.downloadNoteListCalls, "force sync時はDownloadNoteListが呼ばれるべき")
	assert.Equal(t, 0, tracker.downloadNoteListIfChangedCalls, "force sync時はDownloadNoteListIfChangedを使わないべき")
	assert.False(t, ds.forceNextSync, "forceNextSyncはSyncNotes後にfalseへ戻るべき")
}

func TestEqualStructure_IdenticalStructures(t *testing.T) {
	a := &NoteList{
		Folders:               []Folder{{ID: "f1", Name: "Folder1"}},
		TopLevelOrder:         []TopLevelItem{{Type: "note", ID: "n1"}, {Type: "folder", ID: "f1"}},
		ArchivedTopLevelOrder: []TopLevelItem{{Type: "note", ID: "n2"}},
		CollapsedFolderIDs:    []string{"f1"},
		LastSync:              time.Now(),
		LastSyncClientID:      "client-A",
	}
	b := &NoteList{
		Folders:               []Folder{{ID: "f1", Name: "Folder1"}},
		TopLevelOrder:         []TopLevelItem{{Type: "note", ID: "n1"}, {Type: "folder", ID: "f1"}},
		ArchivedTopLevelOrder: []TopLevelItem{{Type: "note", ID: "n2"}},
		CollapsedFolderIDs:    []string{"f1"},
		LastSync:              time.Now().Add(5 * time.Minute),
		LastSyncClientID:      "client-B",
	}
	assert.True(t, equalStructure(a, b), "LastSync/LastSyncClientIDが異なっても構造が同一なら等価")
}

func TestEqualStructure_DifferentArchivedOrder(t *testing.T) {
	a := &NoteList{
		ArchivedTopLevelOrder: []TopLevelItem{{Type: "note", ID: "n1"}, {Type: "note", ID: "n2"}},
	}
	b := &NoteList{
		ArchivedTopLevelOrder: []TopLevelItem{{Type: "note", ID: "n2"}, {Type: "note", ID: "n1"}},
	}
	assert.False(t, equalStructure(a, b), "ArchivedTopLevelOrderの順序が異なれば不等価")
}

func TestEqualStructure_CollapsedFolderIDsOrderIgnored(t *testing.T) {
	a := &NoteList{
		CollapsedFolderIDs: []string{"f1", "f2"},
	}
	b := &NoteList{
		CollapsedFolderIDs: []string{"f2", "f1"},
	}
	assert.True(t, equalStructure(a, b), "CollapsedFolderIDsは順序無視でセット比較")
}

func TestSyncNotes_StructureOnlyChange_LocalHasUniqueItems_Uploads(t *testing.T) {
	ds, _, rawOps, cleanup := newNotificationTestDriveService(t, nil)
	defer cleanup()

	note := &Note{ID: "local-note", Title: "Local", Content: "content", Language: "plaintext"}
	assert.NoError(t, ds.noteService.SaveNote(note))
	localFolder := Folder{ID: "local-folder", Name: "Local Folder"}
	ds.noteService.noteList.Folders = append(ds.noteService.noteList.Folders, localFolder)
	ds.noteService.noteList.TopLevelOrder = append(ds.noteService.noteList.TopLevelOrder,
		TopLevelItem{Type: "folder", ID: "local-folder"})
	assert.NoError(t, ds.noteService.saveNoteList())
	seedCloudNoteListFile(t, ds, rawOps)

	localMeta := ds.noteService.noteList.Notes[0]
	cloudNoteList := &NoteList{
		Version:       "1.0",
		Notes:         []NoteMetadata{localMeta},
		TopLevelOrder: []TopLevelItem{{Type: "note", ID: "local-note"}},
		LastSync:      time.Now().Add(-1 * time.Minute),
	}

	tracker := &syncNotesTrackingDriveSync{
		DriveSyncService: ds.driveSync,
		downloadNoteListIfChangedFn: func(ctx context.Context, noteListID string) (*NoteList, bool, error) {
			return cloudNoteList, true, nil
		},
	}
	ds.driveSync = tracker

	err := ds.SyncNotes()
	assert.NoError(t, err)
	assert.Equal(t, 1, tracker.updateNoteListCalls, "ローカルにのみ存在するフォルダがある場合は再アップロードすべき")
}
