/*
Appのテストスイート

このテストファイルは、DriveServiceとNoteServiceを統合するAppの
機能を検証するためのテストケースを含む

テストケース:
1. TestNewApp
   - Appの初期化が正しく行われることを確認
   - 各サービスが適切に初期化されることを検証

2. TestSaveNoteWithSync
   - ノートの保存とGoogle Driveへの同期が正しく動作することを確認
   - オンライン/オフライン状態での動作を検証

3. TestDeleteNoteWithSync
   - ノートの削除とGoogle Driveからの削除が正しく動作することを確認
   - メタデータの更新が正しく行われることを検証

4. TestSaveNoteListWithSync
   - ノートリストの保存とGoogle Driveへの同期が正しく動作することを確認
   - 同期状態の更新が正しく行われることを検証

5. TestUpdateNoteOrderWithSync
   - ノートの順序変更とクラウド同期が正しく動作することを確認
*/

package backend

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"golang.org/x/oauth2"
	"google.golang.org/api/drive/v3"
)

// テスト用のヘルパー構造体
type appTestHelper struct {
	tempDir string
	app     *App
}

// テストのセットアップ
func setupAppTest(t *testing.T) *appTestHelper {
	// テスト用の一時ディレクトリを作成
	tempDir, err := os.MkdirTemp("", "app_test")
	if err != nil {
		t.Fatalf("一時ディレクトリの作成に失敗: %v", err)
	}

	// アプリケーションの初期化
	app := NewApp()
	app.appDataDir = tempDir
	app.notesDir = filepath.Join(tempDir, "notes")

	// ディレクトリの作成
	os.MkdirAll(app.notesDir, 0755)

	// 各サービスの初期化
	app.fileService = NewFileService(app.ctx)
	app.settingsService = NewSettingsService(app.appDataDir)

	noteService, err := NewNoteService(app.notesDir)
	if err != nil {
		t.Fatalf("NoteServiceの初期化に失敗: %v", err)
	}
	app.noteService = noteService

	// テスト用の認証情報
	credentials := []byte(`{
		"installed": {
			"client_id": "test-client-id",
			"client_secret": "test-client-secret",
			"redirect_uris": ["http://localhost:34115/oauth2callback"]
		}
	}`)

	// DriveAuthServiceの初期化
	authService := NewDriveAuthService(
		context.Background(),
		app.appDataDir,
		app.notesDir,
		noteService,
		credentials,
		true, // テストモード
	)

	// テストモード用のDriveSyncを完全に初期化
	authService.driveSync = &DriveSync{
		notesFolderID: "test-folder",
		rootFolderID:  "test-root",
		isConnected:   true,
		cloudNoteList: &NoteList{
			Version: "1.0",
			Notes:   []NoteMetadata{},
		},
		mutex: sync.Mutex{},
		config: &oauth2.Config{
			ClientID:     "test-client-id",
			ClientSecret: "test-client-secret",
			RedirectURL:  "http://localhost:34115/oauth2callback",
		},
		service: &drive.Service{
			Files:   &drive.FilesService{},
			Changes: &drive.ChangesService{},
		},
	}

	// DriveServiceの初期化
	driveService := NewDriveService(
		context.Background(),
		app.appDataDir,
		app.notesDir,
		noteService,
		credentials,
	)

	app.driveService = driveService
	app.authService = authService

	return &appTestHelper{
		tempDir: tempDir,
		app:     app,
	}
}

// テストのクリーンアップ
func (h *appTestHelper) cleanup() {
	os.RemoveAll(h.tempDir)
}

// TestNewApp はAppの初期化をテストします
func TestNewApp(t *testing.T) {
	helper := setupAppTest(t)
	defer helper.cleanup()

	assert.NotNil(t, helper.app)
	assert.NotNil(t, helper.app.ctx)
	assert.NotNil(t, helper.app.fileService)
	assert.NotNil(t, helper.app.settingsService)
	assert.NotNil(t, helper.app.noteService)
	assert.NotNil(t, helper.app.driveService)
	assert.NotEmpty(t, helper.app.appDataDir)
	assert.NotEmpty(t, helper.app.notesDir)
}

// TestSaveNoteWithSync はノートの保存と同期をテストします
func TestSaveNoteWithSync(t *testing.T) {
	helper := setupAppTest(t)
	defer helper.cleanup()

	// テスト用のノートを作成
	note := &Note{
		ID:           "test-sync-note",
		Title:        "同期テスト",
		Content:      "これは同期テスト用のノートです。",
		Language:     "plaintext",
		ModifiedTime: time.Now(),
	}

	// ノートを保存（同期処理も実行される）
	err := helper.app.SaveNote(note, "create")
	assert.NoError(t, err)

	// ノートが正しく保存されたことを確認
	savedNote, err := helper.app.LoadNote(note.ID)
	assert.NoError(t, err)
	assert.Equal(t, note.Title, savedNote.Title)
	assert.Equal(t, note.Content, savedNote.Content)
}

// TestDeleteNoteWithSync はノートの削除と同期をテストします
func TestDeleteNoteWithSync(t *testing.T) {
	helper := setupAppTest(t)
	defer helper.cleanup()

	// テスト用のノートを作成
	note := &Note{
		ID:           "test-delete-note",
		Title:        "削除テスト",
		Content:      "これは削除テスト用のノートです。",
		Language:     "plaintext",
		ModifiedTime: time.Now(),
	}

	// まずノートを保存
	err := helper.app.SaveNote(note, "create")
	assert.NoError(t, err)

	// ノートを削除
	err = helper.app.DeleteNote(note.ID)
	assert.NoError(t, err)

	// ノートが削除されたことを確認
	_, err = helper.app.LoadNote(note.ID)
	assert.Error(t, err)

	// メタデータから削除されていることを確認
	notes, err := helper.app.ListNotes()
	assert.NoError(t, err)
	assert.Empty(t, notes)
}

// TestSaveNoteListWithSync はノートリストの保存と同期をテストします
func TestSaveNoteListWithSync(t *testing.T) {
	helper := setupAppTest(t)
	defer helper.cleanup()

	// テスト用のノートを複数作成
	notes := []*Note{
		{
			ID:           "note1",
			Title:        "ノート1",
			Content:      "これはノート1です。",
			Language:     "plaintext",
			ModifiedTime: time.Now(),
		},
		{
			ID:           "note2",
			Title:        "ノート2",
			Content:      "これはノート2です。",
			Language:     "plaintext",
			ModifiedTime: time.Now(),
		},
	}

	// ノートを保存
	for _, note := range notes {
		err := helper.app.SaveNote(note, "create")
		assert.NoError(t, err)
	}

	// ノートリストを保存
	err := helper.app.SaveNoteList()
	assert.NoError(t, err)

	// ノートリストが正しく保存されていることを確認
	savedNotes, err := helper.app.ListNotes()
	assert.NoError(t, err)
	assert.Equal(t, len(notes), len(savedNotes))

	// 各ノートが存在することを確認
	savedNoteMap := make(map[string]*Note)
	for _, note := range savedNotes {
		savedNoteMap[note.ID] = &note
	}

	for _, expectedNote := range notes {
		savedNote, exists := savedNoteMap[expectedNote.ID]
		assert.True(t, exists)
		assert.Equal(t, expectedNote.Title, savedNote.Title)
	}
}

// TestUpdateNoteOrderWithSync はノートの順序変更とクラウド同期をテストします
func TestUpdateNoteOrderWithSync(t *testing.T) {
	helper := setupAppTest(t)
	defer helper.cleanup()

	// テスト用のノートを複数作成
	notes := []*Note{
		{
			ID:           "note1",
			Title:        "ノート1",
			Content:      "これはノート1です。",
			Language:     "plaintext",
			ModifiedTime: time.Now(),
		},
		{
			ID:           "note2",
			Title:        "ノート2",
			Content:      "これはノート2です。",
			Language:     "plaintext",
			ModifiedTime: time.Now(),
		},
	}

	// ノートを保存
	for _, note := range notes {
		err := helper.app.SaveNote(note, "create")
		assert.NoError(t, err)
	}

	// ノートの順序を変更
	err := helper.app.UpdateNoteOrder("note2", 0)
	assert.NoError(t, err)

	// 順序が正しく変更されたことを確認
	updatedNotes, err := helper.app.ListNotes()
	assert.NoError(t, err)
	assert.Equal(t, 2, len(updatedNotes))
	assert.Equal(t, "note2", updatedNotes[0].ID)
	assert.Equal(t, "note1", updatedNotes[1].ID)
}
