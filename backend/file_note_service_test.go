package backend

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

type fileNoteServiceTestHelper struct {
	tempDir         string
	appDataDir      string
	fileNoteService *fileNoteService
}

func setupFileNoteTest(t *testing.T) *fileNoteServiceTestHelper {
	// テスト用の一時ディレクトリを作成
	tempDir, err := os.MkdirTemp("", "file_note_service_test")
	if err != nil {
		t.Fatalf("一時ディレクトリの作成に失敗: %v", err)
	}

	appDataDir := filepath.Join(tempDir, "app_data")
	if err := os.MkdirAll(appDataDir, 0755); err != nil {
		t.Fatalf("アプリケーションデータディレクトリの作成に失敗: %v", err)
	}

	fileNoteService := NewFileNoteService(appDataDir)

	return &fileNoteServiceTestHelper{
		tempDir:         tempDir,
		appDataDir:      appDataDir,
		fileNoteService: fileNoteService,
	}
}

func (h *fileNoteServiceTestHelper) cleanup() {
	os.RemoveAll(h.tempDir)
}

// TestNewFileNoteService はFileNoteServiceの初期化をテストします
func TestNewFileNoteService(t *testing.T) {
	helper := setupFileNoteTest(t)
	defer helper.cleanup()

	assert.NotNil(t, helper.fileNoteService)
	assert.Equal(t, helper.appDataDir, helper.fileNoteService.appDataDir)

	// fileNotes.jsonが存在しない場合、空のリストが返されることを確認
	notes, err := helper.fileNoteService.LoadFileNotes()
	assert.NoError(t, err)
	assert.Empty(t, notes)
}

// TestSaveAndLoadFileNotes はファイルノートの保存と読み込みをテストします
func TestSaveAndLoadFileNotes(t *testing.T) {
	helper := setupFileNoteTest(t)
	defer helper.cleanup()

	// テスト用のファイルノートを作成
	fileNotes := []FileNote{
		{
			ID:              "test-file-1",
			FilePath:        filepath.Join(helper.tempDir, "test1.txt"),
			FileName:        "test1.txt",
			Content:         "Test content 1",
			OriginalContent: "Test content 1",
			Language:        "plaintext",
			ModifiedTime:    time.Now().Format(time.RFC3339),
		},
		{
			ID:              "test-file-2",
			FilePath:        filepath.Join(helper.tempDir, "test2.md"),
			FileName:        "test2.md",
			Content:         "# Test content 2",
			OriginalContent: "# Test content 2",
			Language:        "markdown",
			ModifiedTime:    time.Now().Format(time.RFC3339),
		},
	}

	// テスト用のファイルを作成
	for _, note := range fileNotes {
		err := os.WriteFile(note.FilePath, []byte(note.Content), 0644)
		assert.NoError(t, err)
	}

	// ファイルノートを保存
	savedPath, err := helper.fileNoteService.SaveFileNotes(fileNotes)
	assert.NoError(t, err)
	assert.NotEmpty(t, savedPath)

	// 保存されたJSONファイルが存在することを確認
	_, err = os.Stat(savedPath)
	assert.NoError(t, err)

	// JSONファイルの内容を直接検証
	data, err := os.ReadFile(savedPath)
	assert.NoError(t, err)
	var savedNotes []FileNote
	err = json.Unmarshal(data, &savedNotes)
	assert.NoError(t, err)
	assert.Equal(t, len(fileNotes), len(savedNotes))

	// ファイルノートを読み込み
	loadedNotes, err := helper.fileNoteService.LoadFileNotes()
	assert.NoError(t, err)
	assert.Equal(t, len(fileNotes), len(loadedNotes))

	// 内容を検証
	for i, expected := range fileNotes {
		assert.Equal(t, expected.ID, loadedNotes[i].ID)
		assert.Equal(t, expected.FilePath, loadedNotes[i].FilePath)
		assert.Equal(t, expected.FileName, loadedNotes[i].FileName)
		assert.Equal(t, expected.Content, loadedNotes[i].Content)
		assert.Equal(t, expected.OriginalContent, loadedNotes[i].OriginalContent)
		assert.Equal(t, expected.Language, loadedNotes[i].Language)
	}
}

// TestFileNotePersistence はファイルノートの永続化をテストします
func TestFileNotePersistence(t *testing.T) {
	helper := setupFileNoteTest(t)
	defer helper.cleanup()

	// テスト用のファイルノートを作成
	fileNote := FileNote{
		ID:              "test-persistence",
		FilePath:        filepath.Join(helper.tempDir, "test.txt"),
		FileName:        "test.txt",
		Content:         "Test content",
		OriginalContent: "Test content",
		Language:        "plaintext",
		ModifiedTime:    time.Now().Format(time.RFC3339),
	}

	// テストファイルを作成
	err := os.WriteFile(fileNote.FilePath, []byte(fileNote.Content), 0644)
	assert.NoError(t, err)

	// ファイルノートを保存
	_, err = helper.fileNoteService.SaveFileNotes([]FileNote{fileNote})
	assert.NoError(t, err)

	// 新しいFileNoteServiceインスタンスを作成（永続化のテスト）
	newService := NewFileNoteService(helper.appDataDir)
	loadedNotes, err := newService.LoadFileNotes()
	assert.NoError(t, err)
	assert.Equal(t, 1, len(loadedNotes))
	assert.Equal(t, fileNote.ID, loadedNotes[0].ID)
	assert.Equal(t, fileNote.Content, loadedNotes[0].Content)
}

// TestEmptyFileNotes は空のファイルノートリストの処理をテストします
func TestEmptyFileNotes(t *testing.T) {
	helper := setupFileNoteTest(t)
	defer helper.cleanup()

	// 空のリストを保存
	_, err := helper.fileNoteService.SaveFileNotes([]FileNote{})
	assert.NoError(t, err)

	// 空のリストを読み込み
	notes, err := helper.fileNoteService.LoadFileNotes()
	assert.NoError(t, err)
	assert.Empty(t, notes)
}

// TestInvalidFileNotes は無効なファイルノートの処理をテストします
func TestInvalidFileNotes(t *testing.T) {
	helper := setupFileNoteTest(t)
	defer helper.cleanup()

	// 無効なJSONファイルを作成
	invalidJSON := []byte(`{"invalid": "json"`)
	err := os.WriteFile(filepath.Join(helper.appDataDir, "fileNotes.json"), invalidJSON, 0644)
	assert.NoError(t, err)

	// 無効なJSONファイルを読み込み
	notes, err := helper.fileNoteService.LoadFileNotes()
	assert.Error(t, err)
	assert.Nil(t, notes)
}
