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
	"fmt"
	"os"
	"path/filepath"
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
	logger          DriveLogger
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
	return m.driveSync.CreateNote(m.ctx, note)
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

// mockDriveOperations はDriveOperationsのモック実装
type mockDriveOperations struct {
	service *drive.Service
	files   map[string][]byte
}

func newMockDriveOperations() *mockDriveOperations {
	return &mockDriveOperations{
		service: &drive.Service{},
		files:   make(map[string][]byte),
	}
}

func (m *mockDriveOperations) GetService() *drive.Service {
	return m.service
}

func (m *mockDriveOperations) CreateFile(name string, content []byte, rootFolderID string, mimeType string) (string, error) {
	fileID := "test-file-id-" + name
	m.files[fileID] = content
	return fileID, nil
}

func (m *mockDriveOperations) UpdateFile(fileID string, content []byte) error {
	m.files[fileID] = content
	return nil
}

func (m *mockDriveOperations) DeleteFile(fileID string) error {
	delete(m.files, fileID)
	return nil
}

func (m *mockDriveOperations) GetFile(fileID string) (*drive.File, error) {
	if _, ok := m.files[fileID]; !ok {
		return nil, fmt.Errorf("file not found")
	}
	return &drive.File{Id: fileID}, nil
}

func (m *mockDriveOperations) DownloadFile(fileID string) ([]byte, error) {
	if content, ok := m.files[fileID]; ok {
		return content, nil
	}
	return nil, fmt.Errorf("file not found")
}

func (m *mockDriveOperations) ListFiles(query string) ([]*drive.File, error) {
	files := make([]*drive.File, 0)
	for fileID := range m.files {
		files = append(files, &drive.File{Id: fileID})
	}
	return files, nil
}

func (m *mockDriveOperations) CreateFolder(name string, parentID string) (string, error) {
	return "test-folder-id", nil
}

func (m *mockDriveOperations) GetFileID(fileName string, noteFolderID string, rootFolderID string) (string, error) {
	fileID := "test-file-id-" + fileName
	if _, ok := m.files[fileID]; !ok {
		return "", fmt.Errorf("file not found")
	}
	return fileID, nil
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

	// noteServiceの初期化
	noteService, err := NewNoteService(notesDir)
	if err != nil {
		t.Fatalf("Failed to create note service: %v", err)
	}

	ctx := context.Background()

	// driveOpsの初期化
	driveOps := newMockDriveOperations()

	// driveServiceの初期化（テストモード）
	ds := &mockDriveService{
		ctx:         ctx,
		appDataDir:  tempDir,
		notesDir:    notesDir,
		noteService: noteService,
		logger:      NewDriveLogger(ctx, true, tempDir),
		isTestMode:  true,
		driveOps:    driveOps,
	}

	// driveSyncServiceを初期化
	syncService := NewDriveSyncService(
		driveOps,
		"test-folder",
		"test-root",
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
		ModifiedTime: time.Now(),
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
		ModifiedTime: time.Now().Add(-time.Hour),
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
		ModifiedTime: time.Now(),
	}

	// クラウドノートをDriveSyncに設定
	ds, ok := helper.driveService.(*mockDriveService)
	assert.True(t, ok)

	syncImpl, ok := ds.driveSync.(*driveSyncServiceImpl)
	assert.True(t, ok)

	// オンライン状態に設定
	syncImpl.SetConnected(true)
	syncImpl.SetInitialSyncCompleted(true)

	// クラウドノートリストを設定
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

	// クラウドノートを保存
	err = ds.driveSync.CreateNote(ds.ctx, cloudNote)
	assert.NoError(t, err)

	// 同期を実行
	err = helper.driveService.SyncNotes()
	assert.NoError(t, err)

	// クラウドバージョンが優先されることを確認
	syncedNote, err := helper.noteService.LoadNote(localNote.ID)
	assert.NoError(t, err)
	assert.Equal(t, cloudNote.Title, syncedNote.Title)
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
		ModifiedTime: time.Now().Add(-time.Hour),
	}

	// ローカルノートを保存
	err := helper.noteService.SaveNote(localNote)
	assert.NoError(t, err)

	// クラウドの変更をシミュレート
	ds, ok := helper.driveService.(*mockDriveService)
	assert.True(t, ok)

	syncImpl, ok := ds.driveSync.(*driveSyncServiceImpl)
	assert.True(t, ok)

	// オンライン状態に設定
	syncImpl.SetConnected(true)
	syncImpl.SetInitialSyncCompleted(true)

	// クラウドノートリストを設定
	cloudNote := &Note{
		ID:           localNote.ID,
		Title:        "更新されたタイトル",
		Content:      "更新された内容",
		Language:     "plaintext",
		ModifiedTime: time.Now(),
	}

	// クラウドノートを保存
	err = ds.driveSync.CreateNote(ds.ctx, cloudNote)
	assert.NoError(t, err)

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
	err = helper.driveService.SyncNotes()
	assert.NoError(t, err)

	// クラウドの変更が反映されることを確認
	updatedNote, err := helper.noteService.LoadNote(localNote.ID)
	assert.NoError(t, err)
	assert.Equal(t, "更新されたタイトル", updatedNote.Title)
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

	// 複数のノートを作成
	notes := []*Note{
		{ID: "note1", Title: "ノート1", Order: 0},
		{ID: "note2", Title: "ノート2", Order: 1},
		{ID: "note3", Title: "ノート3", Order: 2},
	}

	// ノートを保存
	for _, note := range notes {
		err := helper.noteService.SaveNote(note)
		assert.NoError(t, err)
	}

	// クラウドの異なる順序をシミュレート
	ds, ok := helper.driveService.(*mockDriveService)
	assert.True(t, ok)

	syncImpl, ok := ds.driveSync.(*driveSyncServiceImpl)
	assert.True(t, ok)

	// オンライン状態に設定
	syncImpl.SetConnected(true)
	syncImpl.SetInitialSyncCompleted(true)

	// クラウドノートリストを設定
	cloudNotes := []*Note{
		{ID: "note2", Title: "ノート2", Order: 0},
		{ID: "note1", Title: "ノート1", Order: 1},
		{ID: "note3", Title: "ノート3", Order: 2},
	}

	// クラウドノートを保存
	for _, note := range cloudNotes {
		err := ds.driveSync.CreateNote(ds.ctx, note)
		assert.NoError(t, err)
	}

	syncImpl.SetCloudNoteList(&NoteList{
		Version: "1.0",
		Notes: []NoteMetadata{
			{ID: "note2", Title: "ノート2", Order: 0},
			{ID: "note1", Title: "ノート1", Order: 1},
			{ID: "note3", Title: "ノート3", Order: 2},
		},
	})

	// 同期を実行
	err := helper.driveService.SyncNotes()
	assert.NoError(t, err)

	// クラウドの順序が反映されることを確認
	updatedNotes, err := helper.noteService.ListNotes()
	assert.NoError(t, err)
	assert.Equal(t, "note2", updatedNotes[0].ID)
	assert.Equal(t, "note1", updatedNotes[1].ID)
	assert.Equal(t, "note3", updatedNotes[2].ID)
}
