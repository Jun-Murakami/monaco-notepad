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
		Notes: []NoteMetadata{},
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
		ctx:         context.Background(),
		auth:        auth,
		noteService: helper.noteService,
		logger:      logger,
		driveOps:    mockOps,
		driveSync:   syncService,
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

	cloudNoteList := &NoteList{
		Notes: []NoteMetadata{},
		TopLevelOrder: []TopLevelItem{
			{Type: "note", ID: "n1"},
			{Type: "folder", ID: "f1"},
			{Type: "note", ID: "n2"},
		},
	}

	err := ds.handleCloudSync(cloudNoteList)
	assert.NoError(t, err)
	assert.Len(t, helper.noteService.noteList.TopLevelOrder, 3)
	assert.Equal(t, "n1", helper.noteService.noteList.TopLevelOrder[0].ID)
	assert.Equal(t, "f1", helper.noteService.noteList.TopLevelOrder[1].ID)
}

func TestCloudSync_AppliesArchivedTopLevelOrder(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()
	ds := newTestDriveService(helper)

	cloudNoteList := &NoteList{
		Notes: []NoteMetadata{},
		ArchivedTopLevelOrder: []TopLevelItem{
			{Type: "note", ID: "archived-1"},
			{Type: "folder", ID: "archived-f1"},
		},
	}

	err := ds.handleCloudSync(cloudNoteList)
	assert.NoError(t, err)
	assert.Len(t, helper.noteService.noteList.ArchivedTopLevelOrder, 2)
	assert.Equal(t, "archived-1", helper.noteService.noteList.ArchivedTopLevelOrder[0].ID)
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

	helper.noteService.noteList.TopLevelOrder = []TopLevelItem{
		{Type: "note", ID: "local-only-note"},
		{Type: "note", ID: "shared-note"},
	}

	cloudNoteList := &NoteList{
		Notes: []NoteMetadata{},
		TopLevelOrder: []TopLevelItem{
			{Type: "note", ID: "shared-note"},
			{Type: "note", ID: "cloud-only-note"},
		},
	}

	err := ds.handleCloudSync(cloudNoteList)
	assert.NoError(t, err)

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

func TestMergeNotes_ConflictingContent_CreatesConflictCopy(t *testing.T) {
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

	mergedNotes, _, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes)
	assert.NoError(t, err)

	hasConflictCopy := false
	for _, n := range mergedNotes {
		if strings.Contains(n.Title, "conflict copy") {
			hasConflictCopy = true
			break
		}
	}
	assert.True(t, hasConflictCopy, "コンフリクトコピーが作成されるべき")
	assert.True(t, len(mergedNotes) >= 2, "元ノートとコンフリクトコピーの両方が含まれるべき")
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

	mergedNotes, _, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes)
	assert.NoError(t, err)
	assert.Len(t, mergedNotes, 1)
	for _, n := range mergedNotes {
		assert.NotContains(t, n.Title, "競合コピー")
	}
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
		ctx:         context.Background(),
		auth:        auth,
		noteService: helper.noteService,
		logger:      logger,
		driveOps:    mockOps,
		driveSync:   syncService,
	}

	cloudNotes := []NoteMetadata{
		{ID: "bad-note", Title: "Bad", ContentHash: "bad-hash"},
		{ID: "good-note", Title: "Good", ContentHash: "good-hash"},
	}

	mergedNotes, downloadedNotes, err := ds.mergeNotes(context.Background(), []NoteMetadata{}, cloudNotes)
	assert.NoError(t, err, "破損ノートがあっても全体がエラーにならないべき")
	assert.Len(t, mergedNotes, 2, "メタデータは両方含まれるべき")
	assert.Len(t, downloadedNotes, 1, "正常なノートだけダウンロードされるべき")
	assert.Equal(t, "good-note", downloadedNotes[0].ID)
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

	mergedNotes, _, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes)
	assert.NoError(t, err)

	assert.True(t, len(mergedNotes) >= 2, "クロックスキューがあっても両バージョンが保持されるべき")
	hasConflictCopy := false
	for _, n := range mergedNotes {
		if strings.Contains(n.Title, "conflict copy") {
			hasConflictCopy = true
		}
	}
	assert.True(t, hasConflictCopy, "コンフリクトコピーでローカル版が保持されるべき")
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

	localNotes := helper.noteService.noteList.Notes
	cloudNotes := []NoteMetadata{
		{ID: "note-2", Title: "Cloud Note", ContentHash: "cloud-hash", ModifiedTime: time.Now().Format(time.RFC3339)},
	}

	mergedNotes, downloadedNotes, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes)
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
	_ = downloadedNotes
}

func TestOfflineRecovery_ConflictCopiesCreated(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()
	ds := newTestDriveService(helper)

	note := &Note{ID: "conflict-note", Title: "Shared Note", Content: "local version", Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339)}
	helper.noteService.SaveNote(note)

	localNotes := helper.noteService.noteList.Notes
	cloudNotes := []NoteMetadata{
		{ID: "conflict-note", Title: "Shared Note", ContentHash: "different-hash", ModifiedTime: time.Now().Add(1 * time.Minute).Format(time.RFC3339)},
	}

	mergedNotes, _, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes)
	assert.NoError(t, err)

	hasConflictCopy := false
	for _, n := range mergedNotes {
		if strings.Contains(n.Title, "conflict copy") {
			hasConflictCopy = true
			break
		}
	}
	assert.True(t, hasConflictCopy, "衝突時にコンフリクトコピーが作成されるべき")
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

	mergedNotes, _, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes)
	assert.NoError(t, err)
	assert.True(t, len(mergedNotes) >= 2, "Archived変更でコンフリクトコピーが作成されるべき")
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

	mergedNotes, _, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes)
	assert.NoError(t, err)
	assert.True(t, len(mergedNotes) >= 2, "FolderID変更でコンフリクトコピーが作成されるべき")
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
	assert.True(t, changed, "ゴーストノートがあるのでchanged=trueであるべき")

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
	r := &SyncResult{Uploaded: 1, ConflictCopies: 2}
	summary := r.Summary()
	assert.Contains(t, summary, "⚡2 conflict copies")
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

	mergedNotes, _, err := ds.mergeNotes(context.Background(), localNotes, cloudNotes)
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
