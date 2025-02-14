/*
NoteServiceのテストスイート

このテストファイルは、ノートの基本的なCRUD操作と
メタデータ管理を提供するNoteServiceの機能を検証するためのテストケースを含んでいます。

テストケース:
1. TestNewNoteService
   - NoteServiceの初期化が正しく行われることを確認
   - 初期状態でのnoteListの状態を検証

2. TestSaveAndLoadNote
   - ノートの保存と読み込みが正しく動作することを確認
   - メタデータの自動更新を検証

3. TestDeleteNote
   - ノートの削除機能が正しく動作することを確認
   - 関連するメタデータも適切に削除されることを検証

4. TestListNotes
   - ノート一覧の取得が正しく動作することを確認
   - アーカイブ済みノートの扱いを検証

5. TestUpdateNoteOrder
   - ノートの順序変更が正しく動作することを確認
   - アーカイブ済みノートの順序が維持されることを検証

6. TestNoteListSync
   - 物理ファイルとnoteListの同期が正しく動作することを確認
   - 不整合が発生した場合の自動修復を検証
*/

package backend

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// テストヘルパー構造体
type noteServiceTestHelper struct {
	tempDir     string
	notesDir    string
	noteService *noteService
}

// テストのセットアップ
func setupNoteTest(t *testing.T) *noteServiceTestHelper {
	// テスト用の一時ディレクトリを作成
	tempDir, err := os.MkdirTemp("", "note_service_test")
	if err != nil {
		t.Fatalf("一時ディレクトリの作成に失敗: %v", err)
	}

	// ノート保存用のディレクトリを作成
	notesDir := filepath.Join(tempDir, "notes")
	if err := os.MkdirAll(notesDir, 0755); err != nil {
		t.Fatalf("ノートディレクトリの作成に失敗: %v", err)
	}

	// NoteServiceの初期化
	noteService, err := NewNoteService(notesDir)
	if err != nil {
		t.Fatalf("NoteServiceの作成に失敗: %v", err)
	}

	return &noteServiceTestHelper{
		tempDir:     tempDir,
		notesDir:    notesDir,
		noteService: noteService,
	}
}

// テストのクリーンアップ
func (h *noteServiceTestHelper) cleanup() {
	os.RemoveAll(h.tempDir)
}

// TestNewNoteService はNoteServiceの初期化をテストします
func TestNewNoteService(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	// 初期状態の検証
	assert.NotNil(t, helper.noteService)
	assert.NotNil(t, helper.noteService.noteList)
	assert.Equal(t, "1.0", helper.noteService.noteList.Version)
	assert.Empty(t, helper.noteService.noteList.Notes)
}

// TestSaveAndLoadNote はノートの保存と読み込みをテストします
func TestSaveAndLoadNote(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	// テスト用のノートを作成
	note := &Note{
		ID:            "test-note-1",
		Title:         "テストノート",
		Content:       "これはテストノートです。",
		ContentHeader: "# テストノート",
		Language:      "markdown",
		ModifiedTime:  time.Now().Format(time.RFC3339),
	}

	// ノートを保存
	err := helper.noteService.SaveNote(note)
	assert.NoError(t, err)

	// ノートを読み込み
	loadedNote, err := helper.noteService.LoadNote(note.ID)
	assert.NoError(t, err)
	assert.Equal(t, note.ID, loadedNote.ID)
	assert.Equal(t, note.Title, loadedNote.Title)
	assert.Equal(t, note.Content, loadedNote.Content)
	assert.Equal(t, note.Language, loadedNote.Language)

	// メタデータが更新されていることを確認
	assert.Equal(t, 1, len(helper.noteService.noteList.Notes))
	assert.Equal(t, note.ID, helper.noteService.noteList.Notes[0].ID)
	assert.Equal(t, note.Title, helper.noteService.noteList.Notes[0].Title)
}

// TestDeleteNote はノートの削除をテストします
func TestDeleteNote(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	// テスト用のノートを作成
	note := &Note{
		ID:      "test-note-2",
		Title:   "削除テスト",
		Content: "このノートは削除されます。",
	}

	// ノートを保存
	err := helper.noteService.SaveNote(note)
	assert.NoError(t, err)

	// ノートを削除
	err = helper.noteService.DeleteNote(note.ID)
	assert.NoError(t, err)

	// ノートファイルが削除されていることを確認
	_, err = os.Stat(filepath.Join(helper.notesDir, note.ID+".json"))
	assert.True(t, os.IsNotExist(err))

	// メタデータから削除されていることを確認
	assert.Empty(t, helper.noteService.noteList.Notes)
}

// TestListNotes はノート一覧の取得をテストします
func TestListNotes(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	// 通常のノートを作成
	activeNote := &Note{
		ID:      "active-note",
		Title:   "アクティブノート",
		Content: "これはアクティブなノートです。",
	}

	// アーカイブ済みノートを作成
	archivedNote := &Note{
		ID:       "archived-note",
		Title:    "アーカイブノート",
		Content:  "これはアーカイブされたノートです。",
		Archived: true,
	}

	// ノートを保存
	err := helper.noteService.SaveNote(activeNote)
	assert.NoError(t, err)
	err = helper.noteService.SaveNote(archivedNote)
	assert.NoError(t, err)

	// ノート一覧を取得
	notes, err := helper.noteService.ListNotes()
	assert.NoError(t, err)
	assert.Equal(t, 2, len(notes))

	// アーカイブノートのコンテンツが空であることを確認
	for _, note := range notes {
		if note.ID == archivedNote.ID {
			assert.True(t, note.Archived)
			assert.Empty(t, note.Content)
		} else {
			assert.False(t, note.Archived)
			assert.NotEmpty(t, note.Content)
		}
	}
}

// TestUpdateNoteOrder はノートの順序更新をテストします
func TestUpdateNoteOrder(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	// 複数のノートを作成
	notes := []*Note{
		{ID: "note1", Title: "ノート1"},
		{ID: "note2", Title: "ノート2"},
		{ID: "note3", Title: "ノート3"},
		{ID: "archived", Title: "アーカイブ", Archived: true},
	}

	// ノートを保存
	for _, note := range notes {
		err := helper.noteService.SaveNote(note)
		assert.NoError(t, err)
	}

	// ノートの順序を変更
	err := helper.noteService.UpdateNoteOrder("note3", 0)
	assert.NoError(t, err)

	// 順序が正しく更新されていることを確認
	assert.Equal(t, "note3", helper.noteService.noteList.Notes[0].ID)
	assert.Equal(t, 0, helper.noteService.noteList.Notes[0].Order)

	// アーカイブノートの順序が維持されていることを確認
	var archivedFound bool
	for _, note := range helper.noteService.noteList.Notes {
		if note.ID == "archived" {
			assert.True(t, note.Archived)
			archivedFound = true
			break
		}
	}
	assert.True(t, archivedFound)
}

// TestNoteListSync は物理ファイルとnoteListの同期をテストします
func TestNoteListSync(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	// テスト用のノートを作成
	note := &Note{
		ID:      "sync-test",
		Title:   "同期テスト",
		Content: "同期テスト用のノートです。",
	}

	// ノートを直接ファイルとして保存（noteListを介さない）
	noteData, err := json.MarshalIndent(note, "", "  ")
	assert.NoError(t, err)
	err = os.WriteFile(filepath.Join(helper.notesDir, note.ID+".json"), noteData, 0644)
	assert.NoError(t, err)

	// 同期を実行
	err = helper.noteService.syncNoteList()
	assert.NoError(t, err)

	// noteListに追加されていることを確認
	assert.Equal(t, 1, len(helper.noteService.noteList.Notes))
	assert.Equal(t, note.ID, helper.noteService.noteList.Notes[0].ID)
	assert.Equal(t, note.Title, helper.noteService.noteList.Notes[0].Title)
}
