package backend

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"google.golang.org/api/drive/v3"
)

// テスト共通ヘルパー（同期エンジンを使わない App / 移行ロジックのテスト用）。
// 同期そのもののテストは fakedrive_test.go + sync_harness_test.go を使う。

type testHelper struct {
	tempDir      string
	notesDir     string
	noteService  *noteService
	driveService DriveService
}

// mockDriveService は DriveService の最小モック。同期要求の回数だけを記録する。
type mockDriveService struct {
	ctx         context.Context
	appDataDir  string
	notesDir    string
	noteService *noteService
	driveOps    DriveOperations
	logger      AppLogger
	isTestMode  bool

	mu           sync.Mutex
	syncCalls    int
	requestCalls int
}

func (m *mockDriveService) InitializeDrive() error    { return nil }
func (m *mockDriveService) AuthorizeDrive() error     { return nil }
func (m *mockDriveService) LogoutDrive() error        { return nil }
func (m *mockDriveService) CancelLoginDrive() error   { return nil }
func (m *mockDriveService) DeleteAllDriveData() error { return nil }
func (m *mockDriveService) NotifyFrontendReady()      {}
func (m *mockDriveService) RespondToMigration(string) {}
func (m *mockDriveService) IsConnected() bool         { return true }
func (m *mockDriveService) IsTestMode() bool          { return m.isTestMode }

func (m *mockDriveService) SyncNotes() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.syncCalls++
	return nil
}

func (m *mockDriveService) RequestSync() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.requestCalls++
}

func (m *mockDriveService) syncRequests() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.requestCalls
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
	return &ChangesResult{Changes: nil, NewStartToken: pageToken}, nil
}

// テストのセットアップ
func setupTest(t *testing.T) *testHelper {
	tempDir := t.TempDir()
	notesDir := filepath.Join(tempDir, "notes")
	if err := os.MkdirAll(notesDir, 0755); err != nil {
		t.Fatalf("ノートディレクトリの作成に失敗: %v", err)
	}
	ctx := context.Background()
	logger := NewAppLogger(ctx, true, tempDir)
	noteService, err := NewNoteService(notesDir, logger)
	if err != nil {
		t.Fatalf("Failed to create note service: %v", err)
	}
	ds := &mockDriveService{
		ctx:         ctx,
		appDataDir:  tempDir,
		notesDir:    notesDir,
		noteService: noteService,
		logger:      logger,
		isTestMode:  true,
		driveOps:    newMockDriveOperations(),
	}
	return &testHelper{tempDir: tempDir, notesDir: notesDir, noteService: noteService, driveService: ds}
}

// テストのクリーンアップ（t.TempDir が後片付けするので何もしない。既存呼び出し互換のため残す）
func (h *testHelper) cleanup() {}

var _ = fmt.Sprintf
var _ = time.Now
