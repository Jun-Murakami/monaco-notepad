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

// TestCreateFolder はフォルダの作成をテストします
func TestCreateFolder(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	folder, err := helper.noteService.CreateFolder("My Folder")
	assert.NoError(t, err)
	assert.NotEmpty(t, folder.ID)
	assert.Equal(t, "My Folder", folder.Name)
	assert.Equal(t, 1, len(helper.noteService.noteList.Folders))
	assert.Equal(t, folder.ID, helper.noteService.noteList.Folders[0].ID)

	// 空の名前ではエラー
	_, err = helper.noteService.CreateFolder("")
	assert.Error(t, err)
}

// TestRenameFolder はフォルダ名の変更をテストします
func TestRenameFolder(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	folder, err := helper.noteService.CreateFolder("Original")
	assert.NoError(t, err)

	err = helper.noteService.RenameFolder(folder.ID, "Renamed")
	assert.NoError(t, err)
	assert.Equal(t, "Renamed", helper.noteService.noteList.Folders[0].Name)

	// 存在しないフォルダではエラー
	err = helper.noteService.RenameFolder("nonexistent", "Name")
	assert.Error(t, err)

	// 空の名前ではエラー
	err = helper.noteService.RenameFolder(folder.ID, "")
	assert.Error(t, err)
}

// TestDeleteFolder はフォルダの削除をテストします
func TestDeleteFolder(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	folder, err := helper.noteService.CreateFolder("ToDelete")
	assert.NoError(t, err)

	// 空のフォルダは削除できる
	err = helper.noteService.DeleteFolder(folder.ID)
	assert.NoError(t, err)
	assert.Empty(t, helper.noteService.noteList.Folders)

	// ノートが含まれるフォルダは削除できない
	folder2, err := helper.noteService.CreateFolder("WithNotes")
	assert.NoError(t, err)

	note := &Note{ID: "note-in-folder", Title: "In Folder"}
	err = helper.noteService.SaveNote(note)
	assert.NoError(t, err)
	err = helper.noteService.MoveNoteToFolder("note-in-folder", folder2.ID)
	assert.NoError(t, err)

	err = helper.noteService.DeleteFolder(folder2.ID)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not empty")

	// 存在しないフォルダではエラー
	err = helper.noteService.DeleteFolder("nonexistent")
	assert.Error(t, err)
}

// TestMoveNoteToFolder はノートのフォルダ移動をテストします
func TestMoveNoteToFolder(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	folder, err := helper.noteService.CreateFolder("Target Folder")
	assert.NoError(t, err)

	note := &Note{ID: "movable-note", Title: "Movable"}
	err = helper.noteService.SaveNote(note)
	assert.NoError(t, err)

	// フォルダに移動
	err = helper.noteService.MoveNoteToFolder("movable-note", folder.ID)
	assert.NoError(t, err)

	for _, m := range helper.noteService.noteList.Notes {
		if m.ID == "movable-note" {
			assert.Equal(t, folder.ID, m.FolderID)
		}
	}

	// 未分類に戻す
	err = helper.noteService.MoveNoteToFolder("movable-note", "")
	assert.NoError(t, err)

	for _, m := range helper.noteService.noteList.Notes {
		if m.ID == "movable-note" {
			assert.Empty(t, m.FolderID)
		}
	}

	// 存在しないノートではエラー
	err = helper.noteService.MoveNoteToFolder("nonexistent", folder.ID)
	assert.Error(t, err)

	// 存在しないフォルダではエラー
	err = helper.noteService.MoveNoteToFolder("movable-note", "nonexistent-folder")
	assert.Error(t, err)
}

// TestFolderIDPreservedOnSave はノート保存時にFolderIDが保持されることをテストします
func TestFolderIDPreservedOnSave(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	folder, err := helper.noteService.CreateFolder("Persistent")
	assert.NoError(t, err)

	note := &Note{ID: "persistent-note", Title: "Original Title", Content: "Original Content"}
	err = helper.noteService.SaveNote(note)
	assert.NoError(t, err)

	err = helper.noteService.MoveNoteToFolder("persistent-note", folder.ID)
	assert.NoError(t, err)

	// ノートの内容を更新して保存（FolderIDは変わらないはず）
	note.Title = "Updated Title"
	note.Content = "Updated Content"
	err = helper.noteService.SaveNote(note)
	assert.NoError(t, err)

	for _, m := range helper.noteService.noteList.Notes {
		if m.ID == "persistent-note" {
			assert.Equal(t, folder.ID, m.FolderID)
			assert.Equal(t, "Updated Title", m.Title)
		}
	}
}

// TestListNotesWithFolderID はListNotesがFolderIDを返すことをテストします
func TestListNotesWithFolderID(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	folder, err := helper.noteService.CreateFolder("ListTest")
	assert.NoError(t, err)

	note := &Note{ID: "list-note", Title: "List Note", Content: "Content"}
	err = helper.noteService.SaveNote(note)
	assert.NoError(t, err)

	err = helper.noteService.MoveNoteToFolder("list-note", folder.ID)
	assert.NoError(t, err)

	notes, err := helper.noteService.ListNotes()
	assert.NoError(t, err)
	assert.Equal(t, 1, len(notes))
	assert.Equal(t, folder.ID, notes[0].FolderID)
}

// TestBackwardCompatNoteListWithoutFolders は古い形式のnoteList.jsonとの互換性をテストします
func TestBackwardCompatNoteListWithoutFolders(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	// 古い形式のnoteList.json（foldersフィールドなし）を直接書き込む
	oldNoteList := `{
		"version": "1.0",
		"notes": [{"id": "old-note", "title": "Old Note", "language": "plaintext", "modifiedTime": "2024-01-01T00:00:00Z"}],
		"lastSync": "2024-01-01T00:00:00Z"
	}`
	noteListPath := filepath.Join(helper.tempDir, "noteList.json")
	err := os.WriteFile(noteListPath, []byte(oldNoteList), 0644)
	assert.NoError(t, err)

	// ノートファイルも作成
	noteData := `{"id": "old-note", "title": "Old Note", "content": "Old Content", "language": "plaintext", "modifiedTime": "2024-01-01T00:00:00Z"}`
	err = os.WriteFile(filepath.Join(helper.notesDir, "old-note.json"), []byte(noteData), 0644)
	assert.NoError(t, err)

	// NoteServiceを再初期化
	service, err := NewNoteService(helper.notesDir)
	assert.NoError(t, err)
	assert.NotNil(t, service)

	// Foldersがnilまたは空であること
	assert.Empty(t, service.noteList.Folders)

	// ノートが正しく読み込まれること
	assert.Equal(t, 1, len(service.noteList.Notes))
	assert.Empty(t, service.noteList.Notes[0].FolderID)
}

func TestGetTopLevelOrder_BackwardCompat(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	note1 := &Note{ID: "n1", Title: "Note1", Content: "c1"}
	note2 := &Note{ID: "n2", Title: "Note2", Content: "c2"}
	assert.NoError(t, helper.noteService.SaveNote(note1))
	assert.NoError(t, helper.noteService.SaveNote(note2))

	folder, err := helper.noteService.CreateFolder("F1")
	assert.NoError(t, err)

	// TopLevelOrderをnilにリセット（後方互換テスト）
	helper.noteService.noteList.TopLevelOrder = nil

	order := helper.noteService.GetTopLevelOrder()
	assert.Equal(t, 3, len(order))
	// 未分類ノートが先、フォルダが後
	assert.Equal(t, TopLevelItem{Type: "note", ID: "n1"}, order[0])
	assert.Equal(t, TopLevelItem{Type: "note", ID: "n2"}, order[1])
	assert.Equal(t, TopLevelItem{Type: "folder", ID: folder.ID}, order[2])
}

func TestUpdateTopLevelOrder(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	// TopLevelOrderに含むノートとフォルダを実際に作成する（ValidateIntegrityで除去されないように）
	note := &Note{ID: "n1", Title: "Note1", Content: "c"}
	assert.NoError(t, helper.noteService.SaveNote(note))
	_, err := helper.noteService.CreateFolder("F1")
	assert.NoError(t, err)
	folderID := helper.noteService.noteList.Folders[0].ID

	order := []TopLevelItem{
		{Type: "folder", ID: folderID},
		{Type: "note", ID: "n1"},
	}

	err = helper.noteService.UpdateTopLevelOrder(order)
	assert.NoError(t, err)
	assert.Equal(t, order, helper.noteService.noteList.TopLevelOrder)

	// 永続化されていることを確認
	service, err := NewNoteService(helper.notesDir)
	assert.NoError(t, err)
	assert.Equal(t, order, service.noteList.TopLevelOrder)
}

func TestCreateFolder_AddsToTopLevelOrder(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	note := &Note{ID: "n1", Title: "Note1", Content: "c"}
	assert.NoError(t, helper.noteService.SaveNote(note))

	folder, err := helper.noteService.CreateFolder("F1")
	assert.NoError(t, err)

	order := helper.noteService.noteList.TopLevelOrder
	found := false
	for _, item := range order {
		if item.Type == "folder" && item.ID == folder.ID {
			found = true
		}
	}
	assert.True(t, found)
}

func TestDeleteFolder_RemovesFromTopLevelOrder(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	folder, err := helper.noteService.CreateFolder("F1")
	assert.NoError(t, err)
	assert.True(t, len(helper.noteService.noteList.TopLevelOrder) > 0)

	err = helper.noteService.DeleteFolder(folder.ID)
	assert.NoError(t, err)

	for _, item := range helper.noteService.noteList.TopLevelOrder {
		assert.NotEqual(t, folder.ID, item.ID)
	}
}

func TestMoveNoteToFolder_UpdatesTopLevelOrder(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	note := &Note{ID: "n1", Title: "Note1", Content: "c"}
	assert.NoError(t, helper.noteService.SaveNote(note))

	folder, err := helper.noteService.CreateFolder("F1")
	assert.NoError(t, err)

	// 初期状態: ノートはTopLevelOrderにいる
	hasNote := false
	for _, item := range helper.noteService.noteList.TopLevelOrder {
		if item.Type == "note" && item.ID == "n1" {
			hasNote = true
		}
	}
	assert.True(t, hasNote)

	// フォルダに移動 → TopLevelOrderから消える
	assert.NoError(t, helper.noteService.MoveNoteToFolder("n1", folder.ID))
	for _, item := range helper.noteService.noteList.TopLevelOrder {
		assert.False(t, item.Type == "note" && item.ID == "n1")
	}

	// 未分類に戻す → TopLevelOrderに復帰
	assert.NoError(t, helper.noteService.MoveNoteToFolder("n1", ""))
	hasNote = false
	for _, item := range helper.noteService.noteList.TopLevelOrder {
		if item.Type == "note" && item.ID == "n1" {
			hasNote = true
		}
	}
	assert.True(t, hasNote)
}

func TestCreateFolder_NoDuplicateWhenTopLevelOrderNil(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	helper.noteService.noteList.TopLevelOrder = nil

	folder, err := helper.noteService.CreateFolder("F1")
	assert.NoError(t, err)

	count := 0
	for _, item := range helper.noteService.noteList.TopLevelOrder {
		if item.Type == "folder" && item.ID == folder.ID {
			count++
		}
	}
	assert.Equal(t, 1, count)
}

func TestMoveNoteToFolder_NoDuplicateWhenTopLevelOrderNil(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	note := &Note{ID: "n1", Title: "Note1", Content: "c"}
	assert.NoError(t, helper.noteService.SaveNote(note))

	folder, err := helper.noteService.CreateFolder("F1")
	assert.NoError(t, err)

	assert.NoError(t, helper.noteService.MoveNoteToFolder("n1", folder.ID))

	helper.noteService.noteList.TopLevelOrder = nil
	assert.NoError(t, helper.noteService.MoveNoteToFolder("n1", ""))

	count := 0
	for _, item := range helper.noteService.noteList.TopLevelOrder {
		if item.Type == "note" && item.ID == "n1" {
			count++
		}
	}
	assert.Equal(t, 1, count)
}

func TestNoteListSync(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	note := &Note{
		ID:      "sync-test",
		Title:   "同期テスト",
		Content: "同期テスト用のノートです。",
	}

	noteData, err := json.MarshalIndent(note, "", "  ")
	assert.NoError(t, err)
	err = os.WriteFile(filepath.Join(helper.notesDir, note.ID+".json"), noteData, 0644)
	assert.NoError(t, err)

	changed, err := helper.noteService.ValidateIntegrity()
	assert.NoError(t, err)
	assert.True(t, changed)

	assert.Equal(t, 1, len(helper.noteService.noteList.Notes))
	assert.Equal(t, note.ID, helper.noteService.noteList.Notes[0].ID)
	assert.Equal(t, note.Title, helper.noteService.noteList.Notes[0].Title)
}

func TestValidateIntegrity_RemovesStaleEntries(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	note := &Note{ID: "real-note", Title: "Real", Content: "exists"}
	assert.NoError(t, helper.noteService.SaveNote(note))

	helper.noteService.noteList.Notes = append(helper.noteService.noteList.Notes, NoteMetadata{
		ID:       "ghost-note",
		Title:    "Ghost",
		Archived: true,
	})
	helper.noteService.noteList.ArchivedTopLevelOrder = []TopLevelItem{
		{Type: "note", ID: "ghost-note"},
	}

	changed, err := helper.noteService.ValidateIntegrity()
	assert.NoError(t, err)
	assert.True(t, changed)

	assert.Equal(t, 1, len(helper.noteService.noteList.Notes))
	assert.Equal(t, "real-note", helper.noteService.noteList.Notes[0].ID)
	assert.Empty(t, helper.noteService.noteList.ArchivedTopLevelOrder)
}

func TestValidateIntegrity_CleansTopLevelOrder(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	note := &Note{ID: "n1", Title: "Note1", Content: "c"}
	assert.NoError(t, helper.noteService.SaveNote(note))

	helper.noteService.noteList.TopLevelOrder = []TopLevelItem{
		{Type: "note", ID: "n1"},
		{Type: "note", ID: "deleted-note"},
		{Type: "folder", ID: "deleted-folder"},
	}

	changed, err := helper.noteService.ValidateIntegrity()
	assert.NoError(t, err)
	assert.True(t, changed)

	assert.Equal(t, 1, len(helper.noteService.noteList.TopLevelOrder))
	assert.Equal(t, "n1", helper.noteService.noteList.TopLevelOrder[0].ID)
}

func TestValidateIntegrity_NoChangeWhenConsistent(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	note := &Note{ID: "n1", Title: "Note1", Content: "c"}
	assert.NoError(t, helper.noteService.SaveNote(note))

	changed, err := helper.noteService.ValidateIntegrity()
	assert.NoError(t, err)
	assert.False(t, changed)
}
