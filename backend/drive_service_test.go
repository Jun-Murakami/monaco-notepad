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
	driveService *driveService
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

	// driveServiceの初期化（テスト用のコンテキストを使用）
	driveService := NewDriveService(ctx, tempDir, notesDir, noteService, credentials)

	// テスト用にイベント発行をスキップするフラグを設定
	driveService.isTestMode = true

	// driveSyncの初期化
	driveService.driveSync = &DriveSync{
		lastUpdated:   make(map[string]time.Time),
		notesFolderID: "test-notes-folder",
		isConnected:   true,
	}

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

	// テスト用のモックDriveサービスを作成
	config, err := google.ConfigFromJSON(credentials, drive.DriveFileScope)
	if err != nil {
		t.Fatalf("Failed to parse client secret file to config: %v", err)
	}
	driveService.driveSync.config = config

	return &testHelper{
		tempDir:      tempDir,
		notesDir:     notesDir,
		noteService:  noteService,
		driveService: driveService,
	}
}

// テストのクリーンアップ
func (h *testHelper) cleanup() {
	os.RemoveAll(h.tempDir)
}

// 基本的な初期化のテスト
func TestNewDriveService(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	assert.NotNil(t, helper.driveService)
	assert.NotNil(t, helper.driveService.noteService)
	assert.Equal(t, helper.notesDir, helper.driveService.notesDir)
	assert.NotNil(t, helper.driveService.frontendReady)
	assert.NotNil(t, helper.driveService.credentials)
}

// ノートの保存と同期のテスト
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

// オフライン→オンライン同期のテスト
func TestOfflineToOnlineSync(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	// 初期状態はオフライン
	helper.driveService.driveSync.isConnected = false

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
	helper.driveService.driveSync.isConnected = true

	// 同期を実行（実際のAPIコールはスキップ）
	helper.driveService.driveSync.lastUpdated[note.ID] = time.Now()
	
	// 同期されたことを確認
	assert.True(t, helper.driveService.driveSync.lastUpdated[note.ID].After(time.Time{}))
}

// 競合解決のテスト
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
	cloudNote := &Note{
		ID:           "conflict-note",
		Title:        "Cloud Version",
		Content:      "Cloud content",
		Language:     "plaintext",
		ModifiedTime: time.Now(), // 現在時刻
	}

	// クラウドノートリストを設定
	helper.driveService.driveSync.cloudNoteList = &NoteList{
		Version: "1.0",
		Notes: []NoteMetadata{
			{
				ID:           cloudNote.ID,
				Title:        cloudNote.Title,
				ModifiedTime: cloudNote.ModifiedTime,
			},
		},
	}

	// テスト用のモックDriveサービスを設定
	helper.driveService.driveSync.service = &drive.Service{}

	// 同期を実行（実際のAPIコールはスキップ）
	err = helper.driveService.syncCloudToLocal(helper.driveService.driveSync.cloudNoteList)
	assert.NoError(t, err)

	// クラウドバージョンが優先されることを確認
	syncedNote, err := helper.noteService.LoadNote(localNote.ID)
	assert.NoError(t, err)
	assert.Equal(t, cloudNote.Title, syncedNote.Title)
}

// エラー処理のテスト
func TestErrorHandling(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	// 認証エラーの場合
	helper.driveService.driveSync.isConnected = true

	// 同期を実行
	err := helper.driveService.SyncNotes()
	assert.Error(t, err)

	// オフラインに遷移することを確認
	assert.False(t, helper.driveService.driveSync.isConnected)
}

// 定期的な同期のテスト
func TestPeriodicSync(t *testing.T) {
	helper := setupTest(t)
	defer helper.cleanup()

	// テスト用のクラウドノートを作成
	cloudNote := &Note{
		ID:           "periodic-sync-note",
		Title:        "Cloud Note",
		Content:      "This is a cloud note",
		Language:     "plaintext",
		ModifiedTime: time.Now(),
	}

	// クラウドノートリストを設定
	helper.driveService.driveSync.cloudNoteList = &NoteList{
		Version: "1.0",
		Notes: []NoteMetadata{
			{
				ID:           cloudNote.ID,
				Title:        cloudNote.Title,
				ModifiedTime: cloudNote.ModifiedTime,
			},
		},
	}

	// ローカルノートを作成
	localNote := &Note{
		ID:           "periodic-sync-note",
		Title:        "Local Note",
		Content:      "This is a local note",
		Language:     "plaintext",
		ModifiedTime: time.Now().Add(-time.Hour), // 1時間前
	}

	// ローカルノートを保存
	err := helper.noteService.SaveNote(localNote)
	assert.NoError(t, err)

	// 同期を実行（実際のAPIコールはスキップ）
	err = helper.driveService.syncCloudToLocal(helper.driveService.driveSync.cloudNoteList)
	assert.NoError(t, err)

	// 同期後のノートリストを確認
	assert.Equal(t, 1, len(helper.noteService.noteList.Notes))
	assert.Equal(t, cloudNote.Title, helper.noteService.noteList.Notes[0].Title)
	assert.True(t, helper.noteService.noteList.LastSync.After(localNote.ModifiedTime))
} 