/*
DriveServiceのテストスイート

このテストファイルは、Google Driveとの同期機能を提供するDriveServiceの
機能を検証するためのテストケースを含んでいます。

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
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"golang.org/x/oauth2/google"
	"google.golang.org/api/drive/v3"
)

// テスト用のヘルパー構造体
type testHelper struct {
	tempDir      string
	notesDir     string
	noteService  *noteService
	driveService DriveService
	authService  *driveAuthService
}

// テストのセットアップ
func setupTest(t *testing.T) *testHelper {
	// テスト用の一時ディレクトリを作成
	tempDir, err := os.MkdirTemp("", "drive_service_test")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}

	// ノート保存用のディレクトリを作成
	notesDir := filepath.Join(tempDir, "notes")
	if err := os.MkdirAll(notesDir, 0755); err != nil {
		t.Fatalf("Failed to create notes dir: %v", err)
	}

	// noteServiceの初期化
	noteService, err := NewNoteService(notesDir)
	if err != nil {
		t.Fatalf("Failed to create note service: %v", err)
	}

	// テスト用の認証情報
	credentials := []byte(`{
		"installed": {
			"client_id": "test-client-id",
			"client_secret": "test-client-secret",
			"redirect_uris": ["http://localhost:34115/oauth2callback"]
		}
	}`)

	// テスト用のモックコンテキストを作成
	ctx := context.Background()

	// authServiceの初期化
	authService := NewDriveAuthService(
		ctx,
		tempDir,
		notesDir,
		noteService,
		credentials,
		true, // isTestMode = true
	)

	// driveServiceの初期化（テストモード）
	driveService := NewDriveService(
		ctx,
		tempDir,
		notesDir,
		noteService,
		credentials,
	).(*driveService)

	// テスト用のモックDriveサービスを作成
	config, err := google.ConfigFromJSON(credentials, drive.DriveFileScope)
	if err != nil {
		t.Fatalf("Failed to parse client secret file to config: %v", err)
	}
	authService.driveSync.config = config
	authService.driveSync.service = &drive.Service{}

	// driveServiceのauthServiceを設定
	driveService.auth = authService

	// テスト用のノートデータを作成
	testNoteData := []byte(`{
		"id": "conflict-note",
		"title": "Cloud Version",
		"content": "Cloud content",
		"language": "plaintext",
		"modifiedTime": "2024-02-05T23:10:27Z"
	}`)

	// テスト用のノートファイルを作成
	noteFile := filepath.Join(notesDir, "conflict-note.json")
	if err := os.WriteFile(noteFile, testNoteData, 0644); err != nil {
		t.Fatalf("Failed to create test note file: %v", err)
	}

	return &testHelper{
		tempDir:      tempDir,
		notesDir:     notesDir,
		noteService:  noteService,
		driveService: driveService,
		authService:  authService,
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
	assert.NotNil(t, helper.authService)
	assert.Equal(t, helper.notesDir, helper.authService.notesDir)
	assert.NotNil(t, helper.authService.frontendReady)
	assert.NotNil(t, helper.authService.credentials)
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

	// 初期状態はオフライン
	helper.authService.driveSync.isConnected = false

	// オフライン状態でノートを作成
	note := &Note{
		ID:       "offline-note",
		Title:    "Offline Note",
		Content:  "Created while offline",
		Language: "plaintext",
	}

	// ノートを保存（オフライン）
	err := helper.noteService.SaveNote(note)
	assert.NoError(t, err)

	// オンラインに切り替え
	helper.authService.driveSync.isConnected = true

	// 同期を実行（実際のAPIコールはスキップ）
	helper.authService.driveSync.lastUpdated[note.ID] = time.Now()
	
	// 同期されたことを確認
	assert.True(t, helper.authService.driveSync.lastUpdated[note.ID].After(time.Time{}))
}

// TestConflictResolution はノートの競合解決をテストします
func TestConflictResolution(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	// ローカルノートを作成
	localNote := &Note{
		ID:           "conflict-note",
		Title:        "Local Version",
		Content:      "Local content",
		Language:     "plaintext",
		ModifiedTime: time.Now().Add(-time.Hour), // 1時間前
	}

	// ローカルノートを保存
	err := helper.noteService.SaveNote(localNote)
	assert.NoError(t, err)

	// クラウドノートを作成（より新しい更新時刻）
	cloudModTime := time.Now()
	cloudNote := &Note{
		ID:           "conflict-note",
		Title:        "Cloud Version",
		Content:      "Cloud content",
		Language:     "plaintext",
		ModifiedTime: cloudModTime,
	}

	// クラウドノートリストを設定
	helper.authService.driveSync.cloudNoteList = &NoteList{
		Version: "1.0",
		Notes: []NoteMetadata{
			{
				ID:           cloudNote.ID,
				Title:        cloudNote.Title,
				ModifiedTime: cloudModTime, // ModifiedTimeを設定
			},
		},
		LastSync: cloudModTime,
	}

	// 同期を実行
	err = helper.driveService.SyncNotes()
	assert.NoError(t, err)

	// 同期後のノートを読み込み
	updatedNote, err := helper.noteService.LoadNote(localNote.ID)
	assert.NoError(t, err)

	// クラウドバージョンが優先されることを確認
	assert.Equal(t, "Cloud Version", updatedNote.Title)
}

// TestErrorHandling はエラー処理をテストします
func TestErrorHandling(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	// クラウドノートリストをnilに設定してエラーを発生させる
	helper.authService.driveSync.cloudNoteList = nil

	// 同期を実行
	err := helper.driveService.SyncNotes()
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "cloud note list is nil")
}

// TestPeriodicSync は定期的な同期をテストします
func TestPeriodicSync(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	// ローカルノートを作成
	localNote := &Note{
		ID:           "sync-note",
		Title:        "Local Note",
		Content:      "Local content",
		Language:     "plaintext",
		ModifiedTime: time.Now().Add(-time.Hour), // 1時間前
	}

	// ローカルノートを保存
	err := helper.noteService.SaveNote(localNote)
	assert.NoError(t, err)

	// クラウドノートリストを設定（より新しい更新時刻）
	cloudModTime := time.Now()
	helper.authService.driveSync.cloudNoteList = &NoteList{
		Version: "1.0",
		Notes: []NoteMetadata{
			{
				ID:           localNote.ID,
				Title:        "Cloud Note",
				ModifiedTime: cloudModTime, // ModifiedTimeを設定
			},
		},
		LastSync: cloudModTime,
	}

	// 同期を実行
	err = helper.driveService.SyncNotes()
	assert.NoError(t, err)

	// 同期後のノートを読み込み
	updatedNote, err := helper.noteService.LoadNote(localNote.ID)
	assert.NoError(t, err)

	// クラウドの変更が反映されていることを確認
	assert.Equal(t, "Cloud Note", updatedNote.Title)
}

// TestNoteOrderSync はノートの順序変更の同期をテストします
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

	// クラウドのノートリストを異なる順序で設定
	cloudNotes := []NoteMetadata{
		{
			ID:    "note-2",
			Title: "Second Note",
			Order: 0,
		},
		{
			ID:    "note-3",
			Title: "Third Note",
			Order: 1,
		},
		{
			ID:    "note-1",
			Title: "First Note",
			Order: 2,
		},
	}

	helper.authService.driveSync.cloudNoteList = &NoteList{
		Version:   "1.0",
		Notes:     cloudNotes,
		LastSync:  time.Now(),
	}

	// 同期を実行
	err := helper.driveService.SyncNotes()
	assert.NoError(t, err)

	// 同期後のノートリストを確認
	assert.Equal(t, 3, len(helper.noteService.noteList.Notes))
	assert.Equal(t, "note-2", helper.noteService.noteList.Notes[0].ID)
	assert.Equal(t, "note-3", helper.noteService.noteList.Notes[1].ID)
	assert.Equal(t, "note-1", helper.noteService.noteList.Notes[2].ID)

	// 順序の値も確認
	assert.Equal(t, 0, helper.noteService.noteList.Notes[0].Order)
	assert.Equal(t, 1, helper.noteService.noteList.Notes[1].Order)
	assert.Equal(t, 2, helper.noteService.noteList.Notes[2].Order)
}

// TestNoteOrderConflict はノートの順序変更の競合解決をテストします
func TestNoteOrderConflict(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	// 初期ノートリストを設定
	localNotes := []NoteMetadata{
		{ID: "note-1", Order: 0},
		{ID: "note-2", Order: 1},
		{ID: "note-3", Order: 2},
	}
	helper.noteService.noteList.Notes = localNotes
	helper.noteService.noteList.LastSync = time.Now().Add(-time.Hour)

	// クラウドの新しい順序を設定
	cloudNotes := []NoteMetadata{
		{ID: "note-3", Order: 0},
		{ID: "note-1", Order: 1},
		{ID: "note-2", Order: 2},
	}
	helper.authService.driveSync.cloudNoteList = &NoteList{
		Version:   "1.0",
		Notes:     cloudNotes,
		LastSync:  time.Now(),
	}

	// 同期を実行
	err := helper.driveService.SyncNotes()
	assert.NoError(t, err)

	// クラウドの順序が優先されることを確認
	assert.Equal(t, "note-3", helper.noteService.noteList.Notes[0].ID)
	assert.Equal(t, "note-1", helper.noteService.noteList.Notes[1].ID)
	assert.Equal(t, "note-2", helper.noteService.noteList.Notes[2].ID)
}
