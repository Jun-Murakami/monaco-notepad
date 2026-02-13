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
	"context"
	"encoding/json"
	"fmt"
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
	logger := NewAppLogger(context.Background(), true, tempDir)
	noteService, err := NewNoteService(notesDir, logger)
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
	assert.Equal(t, CurrentVersion, helper.noteService.noteList.Version)
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

func TestArchivedNoteClearsFolderIDOnSave(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	folder, err := helper.noteService.CreateFolder("ArchiveTarget")
	assert.NoError(t, err)

	note := &Note{ID: "archivable-note", Title: "Archivable", Content: "content"}
	assert.NoError(t, helper.noteService.SaveNote(note))
	assert.NoError(t, helper.noteService.MoveNoteToFolder("archivable-note", folder.ID))

	note.Archived = true
	assert.NoError(t, helper.noteService.SaveNote(note))

	for _, m := range helper.noteService.noteList.Notes {
		if m.ID == "archivable-note" {
			assert.True(t, m.Archived)
			assert.Empty(t, m.FolderID, "ノート単体のアーカイブ時はFolderIDが解除されるべき")
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
		"notes": [{"id": "old-note", "title": "Old Note", "language": "plaintext", "modifiedTime": "2024-01-01T00:00:00Z"}]
	}`
	noteListPath := filepath.Join(helper.tempDir, "noteList_v2.json")
	err := os.WriteFile(noteListPath, []byte(oldNoteList), 0644)
	assert.NoError(t, err)

	// ノートファイルも作成
	noteData := `{"id": "old-note", "title": "Old Note", "content": "Old Content", "language": "plaintext", "modifiedTime": "2024-01-01T00:00:00Z"}`
	err = os.WriteFile(filepath.Join(helper.notesDir, "old-note.json"), []byte(noteData), 0644)
	assert.NoError(t, err)

	// NoteServiceを再初期化
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	service, err := NewNoteService(helper.notesDir, logger)
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
	assert.Equal(t, "note", order[0].Type)
	assert.Equal(t, "note", order[1].Type)
	assert.ElementsMatch(t, []string{"n1", "n2"}, []string{order[0].ID, order[1].ID})
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
	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	service, err := NewNoteService(helper.notesDir, logger)
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
	assert.False(t, changed)

	issues := helper.noteService.DrainPendingIntegrityIssues()
	if assert.Len(t, issues, 1) {
		assert.Equal(t, "orphan_file", issues[0].Kind)
		assert.Contains(t, issues[0].Summary, "同期テスト", "Summaryにノートタイトルを含むべき")
	}

	summary, err := helper.noteService.ApplyIntegrityFixes([]IntegrityFixSelection{
		{IssueID: "orphan_file:" + note.ID, FixID: "restore"},
	})
	assert.NoError(t, err)
	assert.Equal(t, 1, summary.Applied)

	assert.Equal(t, 1, len(helper.noteService.noteList.Notes))
	assert.Equal(t, note.ID, helper.noteService.noteList.Notes[0].ID)
	assert.Equal(t, note.Title, helper.noteService.noteList.Notes[0].Title)
}

func TestApplyIntegrityFixes_OrphanFile_Delete(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	note := &Note{
		ID:      "orphan-delete",
		Title:   "削除テスト",
		Content: "削除されるノート",
	}
	noteData, _ := json.MarshalIndent(note, "", "  ")
	err := os.WriteFile(filepath.Join(helper.notesDir, note.ID+".json"), noteData, 0644)
	assert.NoError(t, err)

	_, err = helper.noteService.ValidateIntegrity()
	assert.NoError(t, err)

	issues := helper.noteService.DrainPendingIntegrityIssues()
	if !assert.Len(t, issues, 1) {
		return
	}
	assert.Equal(t, "orphan_file", issues[0].Kind)

	summary, err := helper.noteService.ApplyIntegrityFixes([]IntegrityFixSelection{
		{IssueID: "orphan_file:" + note.ID, FixID: "delete"},
	})
	assert.NoError(t, err)
	assert.Equal(t, 1, summary.Applied)

	_, err = os.Stat(filepath.Join(helper.notesDir, note.ID+".json"))
	assert.True(t, os.IsNotExist(err), "物理ファイルが削除されるべき")
	assert.Empty(t, helper.noteService.noteList.Notes, "ノートリストに追加されないべき")
}

func TestValidateIntegrity_RemovesMissingFileSilently(t *testing.T) {
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
	assert.True(t, changed, "ファイルが無いノートの除外でchanged=trueであるべき")

	issues := helper.noteService.DrainPendingIntegrityIssues()
	assert.Empty(t, issues, "missing_fileはユーザー確認不要")

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

	repairs := helper.noteService.DrainPendingIntegrityRepairs()
	if assert.NotEmpty(t, repairs) {
		assert.Contains(t, repairs[0], "TopLevelOrder")
	}
	assert.Empty(t, helper.noteService.DrainPendingIntegrityRepairs(), "Drainは1回限りであるべき")
}

func TestValidateIntegrity_NoChangeWhenConsistent(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	note := &Note{ID: "n1", Title: "Note1", Content: "c"}
	assert.NoError(t, helper.noteService.SaveNote(note))

	changed, err := helper.noteService.ValidateIntegrity()
	assert.NoError(t, err)
	assert.False(t, changed)
	assert.Empty(t, helper.noteService.DrainPendingIntegrityRepairs())
}

func TestValidateIntegrity_MovesArchivedNotesFromTopLevelToArchived(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	activeNote := &Note{ID: "active", Title: "Active", Content: "c", Archived: false}
	archivedNote := &Note{ID: "archived", Title: "Archived", Content: "c", Archived: true}
	assert.NoError(t, helper.noteService.SaveNote(activeNote))
	assert.NoError(t, helper.noteService.SaveNote(archivedNote))

	for i := range helper.noteService.noteList.Notes {
		if helper.noteService.noteList.Notes[i].ID == "archived" {
			helper.noteService.noteList.Notes[i].Archived = true
		}
	}

	helper.noteService.noteList.TopLevelOrder = []TopLevelItem{
		{Type: "note", ID: "active"},
		{Type: "note", ID: "archived"},
	}
	helper.noteService.noteList.ArchivedTopLevelOrder = []TopLevelItem{}

	changed, err := helper.noteService.ValidateIntegrity()
	assert.NoError(t, err)
	assert.True(t, changed)

	for _, item := range helper.noteService.noteList.TopLevelOrder {
		assert.NotEqual(t, "archived", item.ID, "アーカイブノートがTopLevelOrderに残ってはならない")
	}

	foundInArchived := false
	for _, item := range helper.noteService.noteList.ArchivedTopLevelOrder {
		if item.ID == "archived" {
			foundInArchived = true
		}
	}
	assert.True(t, foundInArchived, "アーカイブノートがArchivedTopLevelOrderに追加されるべき")
}

func TestValidateIntegrity_MovesActiveNoteFromArchivedToTopLevel(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	note := &Note{ID: "n1", Title: "Note", Content: "c", Archived: false}
	assert.NoError(t, helper.noteService.SaveNote(note))

	helper.noteService.noteList.TopLevelOrder = []TopLevelItem{}
	helper.noteService.noteList.ArchivedTopLevelOrder = []TopLevelItem{
		{Type: "note", ID: "n1"},
	}

	changed, err := helper.noteService.ValidateIntegrity()
	assert.NoError(t, err)
	assert.True(t, changed)

	assert.Empty(t, helper.noteService.noteList.ArchivedTopLevelOrder,
		"非アーカイブノートがArchivedTopLevelOrderに残ってはならない")

	foundInTop := false
	for _, item := range helper.noteService.noteList.TopLevelOrder {
		if item.ID == "n1" {
			foundInTop = true
		}
	}
	assert.True(t, foundInTop, "非アーカイブノートがTopLevelOrderに復元されるべき")
}

func TestValidateIntegrity_AddsArchivedFolderToArchivedOrder(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	helper.noteService.noteList.Folders = []Folder{
		{ID: "f-active", Name: "Active"},
		{ID: "f-archived", Name: "Archived", Archived: true},
	}
	helper.noteService.noteList.TopLevelOrder = []TopLevelItem{
		{Type: "folder", ID: "f-active"},
		{Type: "folder", ID: "f-archived"},
	}
	helper.noteService.noteList.ArchivedTopLevelOrder = nil

	changed, err := helper.noteService.ValidateIntegrity()
	assert.NoError(t, err)
	assert.True(t, changed)

	for _, item := range helper.noteService.noteList.TopLevelOrder {
		assert.NotEqual(t, "f-archived", item.ID, "アーカイブフォルダがTopLevelOrderに残ってはならない")
	}

	foundInArchived := false
	for _, item := range helper.noteService.noteList.ArchivedTopLevelOrder {
		if item.ID == "f-archived" && item.Type == "folder" {
			foundInArchived = true
		}
	}
	assert.True(t, foundInArchived, "アーカイブフォルダがArchivedTopLevelOrderに追加されるべき")
}

func TestValidateIntegrity_ReproducesUserBug_ArchivedNotesNotShown(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	for i := 0; i < 5; i++ {
		note := &Note{
			ID:       fmt.Sprintf("active-%d", i),
			Title:    fmt.Sprintf("Active %d", i),
			Content:  "c",
			Archived: false,
		}
		assert.NoError(t, helper.noteService.SaveNote(note))
	}
	for i := 0; i < 10; i++ {
		note := &Note{
			ID:       fmt.Sprintf("archived-%d", i),
			Title:    fmt.Sprintf("Archived %d", i),
			Content:  "c",
			Archived: true,
		}
		assert.NoError(t, helper.noteService.SaveNote(note))
		for j := range helper.noteService.noteList.Notes {
			if helper.noteService.noteList.Notes[j].ID == fmt.Sprintf("archived-%d", i) {
				helper.noteService.noteList.Notes[j].Archived = true
			}
		}
	}

	helper.noteService.noteList.TopLevelOrder = []TopLevelItem{
		{Type: "note", ID: "active-0"},
		{Type: "note", ID: "archived-0"},
		{Type: "note", ID: "archived-1"},
		{Type: "note", ID: "active-1"},
	}
	helper.noteService.noteList.ArchivedTopLevelOrder = []TopLevelItem{
		{Type: "note", ID: "active-2"},
	}

	changed, err := helper.noteService.ValidateIntegrity()
	assert.NoError(t, err)
	assert.True(t, changed)

	for _, item := range helper.noteService.noteList.TopLevelOrder {
		if item.Type == "note" {
			isArchived := false
			for _, m := range helper.noteService.noteList.Notes {
				if m.ID == item.ID && m.Archived {
					isArchived = true
				}
			}
			assert.False(t, isArchived, "TopLevelOrderにアーカイブノート %s が残ってはならない", item.ID)
		}
	}

	archivedInOrder := make(map[string]bool)
	for _, item := range helper.noteService.noteList.ArchivedTopLevelOrder {
		archivedInOrder[item.ID] = true
	}
	for _, item := range helper.noteService.noteList.ArchivedTopLevelOrder {
		if item.Type == "note" {
			isActive := false
			for _, m := range helper.noteService.noteList.Notes {
				if m.ID == item.ID && !m.Archived {
					isActive = true
				}
			}
			assert.False(t, isActive, "ArchivedTopLevelOrderに非アーカイブノート %s が残ってはならない", item.ID)
		}
	}
	for i := 0; i < 10; i++ {
		id := fmt.Sprintf("archived-%d", i)
		assert.True(t, archivedInOrder[id], "アーカイブノート %s がArchivedTopLevelOrderに存在すべき", id)
	}
}

func TestValidateIntegrity_MovesArchivedNotesOutOfActiveFolder(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	folder, err := helper.noteService.CreateFolder("ActiveFolder")
	assert.NoError(t, err)

	note := &Note{ID: "n1", Title: "Note1", Content: "c"}
	assert.NoError(t, helper.noteService.SaveNote(note))
	assert.NoError(t, helper.noteService.MoveNoteToFolder(note.ID, folder.ID))

	for i := range helper.noteService.noteList.Notes {
		if helper.noteService.noteList.Notes[i].ID == note.ID {
			helper.noteService.noteList.Notes[i].Archived = true
		}
	}
	helper.noteService.noteList.ArchivedTopLevelOrder = []TopLevelItem{}

	changed, err := helper.noteService.ValidateIntegrity()
	assert.NoError(t, err)
	assert.True(t, changed)

	foundNote := false
	for _, metadata := range helper.noteService.noteList.Notes {
		if metadata.ID != note.ID {
			continue
		}
		foundNote = true
		assert.True(t, metadata.Archived)
		assert.Empty(t, metadata.FolderID, "アーカイブノートが非アーカイブフォルダを参照してはならない")
	}
	assert.True(t, foundNote)

	foundInArchivedOrder := false
	for _, item := range helper.noteService.noteList.ArchivedTopLevelOrder {
		if item.Type == "note" && item.ID == note.ID {
			foundInArchivedOrder = true
		}
	}
	assert.True(t, foundInArchivedOrder, "未分類化されたアーカイブノートはArchivedTopLevelOrderに含まれるべき")
}

func TestValidateIntegrity_FutureModifiedTimeRequiresConfirmation(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	note := &Note{ID: "future-note", Title: "Future", Content: "c"}
	assert.NoError(t, helper.noteService.SaveNote(note))

	futureTime := time.Now().Add(24 * time.Hour).Format(time.RFC3339)
	for i := range helper.noteService.noteList.Notes {
		if helper.noteService.noteList.Notes[i].ID == note.ID {
			helper.noteService.noteList.Notes[i].ModifiedTime = futureTime
		}
	}

	changed, err := helper.noteService.ValidateIntegrity()
	assert.NoError(t, err)
	assert.False(t, changed)

	issues := helper.noteService.DrainPendingIntegrityIssues()
	if assert.Len(t, issues, 1) {
		assert.Equal(t, "future_modified_time", issues[0].Kind)
	}

	summary, err := helper.noteService.ApplyIntegrityFixes([]IntegrityFixSelection{
		{IssueID: "future_time:" + note.ID, FixID: "normalize"},
	})
	assert.NoError(t, err)
	assert.Equal(t, 1, summary.Applied)

	for _, metadata := range helper.noteService.noteList.Notes {
		if metadata.ID == note.ID {
			assert.NotEqual(t, futureTime, metadata.ModifiedTime)
		}
	}
}

func TestValidateIntegrity_AutoResolvesDuplicateConflictCopies(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	base := &Note{ID: "base-note", Title: "Base", Content: "same content"}
	conflict := &Note{
		ID:      "conflict-note",
		Title:   "Base (conflict copy 2026-02-11 00:00)",
		Content: "same content",
	}

	assert.NoError(t, helper.noteService.SaveNote(base))
	assert.NoError(t, helper.noteService.SaveNote(conflict))

	changed, err := helper.noteService.ValidateIntegrity()
	assert.NoError(t, err)
	assert.True(t, changed, "重複するconflict copyは削除されるべき")

	foundConflict := false
	for _, metadata := range helper.noteService.noteList.Notes {
		if metadata.ID == conflict.ID {
			foundConflict = true
			break
		}
	}
	assert.False(t, foundConflict, "conflict copyはnoteListから除去されるべき")
}

func TestValidateIntegrity_KeepUniqueConflictCopy(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	base := &Note{ID: "base-note", Title: "Base", Content: "same content"}
	duplicate := &Note{
		ID:      "conflict-dup",
		Title:   "Base (conflict copy 2026-02-11 00:00)",
		Content: "same content",
	}
	unique := &Note{
		ID:      "conflict-unique",
		Title:   "Base (conflict copy 2026-02-11 00:01)",
		Content: "unique content",
	}

	assert.NoError(t, helper.noteService.SaveNote(base))
	assert.NoError(t, helper.noteService.SaveNote(duplicate))
	assert.NoError(t, helper.noteService.SaveNote(unique))

	changed, err := helper.noteService.ValidateIntegrity()
	assert.NoError(t, err)
	assert.True(t, changed, "重複するconflict copyのみ削除されるべき")

	foundDuplicate := false
	foundUnique := false
	for _, metadata := range helper.noteService.noteList.Notes {
		if metadata.ID == duplicate.ID {
			foundDuplicate = true
		}
		if metadata.ID == unique.ID {
			foundUnique = true
		}
	}
	assert.False(t, foundDuplicate, "重複conflict copyは削除されるべき")
	assert.True(t, foundUnique, "ユニークなconflict copyは残るべき")
}

func TestValidateIntegrity_AutoResolvesArchivedConflictCopyWithActiveOriginal(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	base := &Note{ID: "base-note", Title: "Base", Content: "same content", Language: "plaintext"}
	assert.NoError(t, helper.noteService.SaveNote(base))

	conflict := &Note{
		ID:       "conflict-note",
		Title:    "Base (conflict copy 2026-02-11 00:00)",
		Content:  "same content",
		Language: "plaintext",
		Archived: true,
	}
	assert.NoError(t, helper.noteService.SaveNote(conflict))

	changed, err := helper.noteService.ValidateIntegrity()
	assert.NoError(t, err)
	assert.True(t, changed, "archived conflict copyは重複として削除されるべき")

	foundConflict := false
	for _, metadata := range helper.noteService.noteList.Notes {
		if metadata.ID == conflict.ID {
			foundConflict = true
			break
		}
	}
	assert.False(t, foundConflict, "archived conflict copyはnoteListから除去されるべき")
}

// --- M-8: アーカイブ操作のModifiedTime更新テスト ---

func TestArchiveFolder_UpdatesNoteModifiedTime(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	folder, err := helper.noteService.CreateFolder("TestFolder")
	assert.NoError(t, err)

	note := &Note{ID: "n1", Title: "Note1", Content: "c", Language: "plaintext"}
	assert.NoError(t, helper.noteService.SaveNote(note))
	assert.NoError(t, helper.noteService.MoveNoteToFolder("n1", folder.ID))

	pastTime := time.Now().Add(-1 * time.Hour).Format(time.RFC3339)
	helper.noteService.noteList.Notes[0].ModifiedTime = pastTime

	assert.NoError(t, helper.noteService.ArchiveFolder(folder.ID))

	newModTime := helper.noteService.noteList.Notes[0].ModifiedTime
	assert.NotEqual(t, pastTime, newModTime, "ArchiveFolderでノートのModifiedTimeが更新されるべき")
	assert.True(t, helper.noteService.noteList.Notes[0].Archived)
}

func TestUnarchiveFolder_UpdatesNoteModifiedTime(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	folder, err := helper.noteService.CreateFolder("TestFolder")
	assert.NoError(t, err)

	note := &Note{ID: "n1", Title: "Note1", Content: "c", Language: "plaintext"}
	assert.NoError(t, helper.noteService.SaveNote(note))
	assert.NoError(t, helper.noteService.MoveNoteToFolder("n1", folder.ID))
	assert.NoError(t, helper.noteService.ArchiveFolder(folder.ID))

	pastTime := time.Now().Add(-1 * time.Hour).Format(time.RFC3339)
	helper.noteService.noteList.Notes[0].ModifiedTime = pastTime

	assert.NoError(t, helper.noteService.UnarchiveFolder(folder.ID))

	newModTime := helper.noteService.noteList.Notes[0].ModifiedTime
	assert.NotEqual(t, pastTime, newModTime, "UnarchiveFolderでノートのModifiedTimeが更新されるべき")
	assert.False(t, helper.noteService.noteList.Notes[0].Archived)
}

func TestArchiveFolder_UpdatesContentHash(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	folder, err := helper.noteService.CreateFolder("TestFolder")
	assert.NoError(t, err)

	note := &Note{ID: "n1", Title: "Note1", Content: "c", Language: "plaintext"}
	assert.NoError(t, helper.noteService.SaveNote(note))
	assert.NoError(t, helper.noteService.MoveNoteToFolder("n1", folder.ID))

	oldHash := helper.noteService.noteList.Notes[0].ContentHash

	assert.NoError(t, helper.noteService.ArchiveFolder(folder.ID))

	newHash := helper.noteService.noteList.Notes[0].ContentHash
	assert.NotEqual(t, oldHash, newHash, "ArchiveFolderでContentHashが更新されるべき")
}

func TestUnarchiveFolder_UpdatesContentHash(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	folder, err := helper.noteService.CreateFolder("TestFolder")
	assert.NoError(t, err)

	note := &Note{ID: "n1", Title: "Note1", Content: "c", Language: "plaintext"}
	assert.NoError(t, helper.noteService.SaveNote(note))
	assert.NoError(t, helper.noteService.MoveNoteToFolder("n1", folder.ID))
	assert.NoError(t, helper.noteService.ArchiveFolder(folder.ID))

	archivedHash := helper.noteService.noteList.Notes[0].ContentHash

	assert.NoError(t, helper.noteService.UnarchiveFolder(folder.ID))

	unarchivedHash := helper.noteService.noteList.Notes[0].ContentHash
	assert.NotEqual(t, archivedHash, unarchivedHash, "UnarchiveFolderでContentHashが更新されるべき")
}

// --- M-1: ContentHash テスト ---

func TestContentHash_ExcludesModifiedTime(t *testing.T) {
	note1 := &Note{
		ID:           "note-1",
		Title:        "Same Title",
		Content:      "Same Content",
		Language:     "plaintext",
		Archived:     false,
		FolderID:     "folder-1",
		ModifiedTime: time.Now().Add(-1 * time.Hour).Format(time.RFC3339),
	}
	note2 := &Note{
		ID:           "note-1",
		Title:        "Same Title",
		Content:      "Same Content",
		Language:     "plaintext",
		Archived:     false,
		FolderID:     "folder-1",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}

	hash1 := computeContentHash(note1)
	hash2 := computeContentHash(note2)
	assert.Equal(t, hash1, hash2, "同一コンテンツ + 異なる ModifiedTime → 同一ハッシュであるべき")
}

func TestContentHash_IncludesContent(t *testing.T) {
	base := &Note{
		ID:           "note-1",
		Title:        "Title",
		Content:      "Original content",
		Language:     "plaintext",
		Archived:     false,
		FolderID:     "",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	modified := &Note{
		ID:           "note-1",
		Title:        "Title",
		Content:      "Modified content",
		Language:     "plaintext",
		Archived:     false,
		FolderID:     "",
		ModifiedTime: base.ModifiedTime,
	}

	hashBase := computeContentHash(base)
	hashModified := computeContentHash(modified)
	assert.NotEqual(t, hashBase, hashModified, "同一タイムスタンプ + 異なる Content → 異なるハッシュであるべき")
}

func TestContentHash_IncludesAllStableFields(t *testing.T) {
	base := &Note{
		ID:           "note-1",
		Title:        "Title",
		Content:      "Content",
		Language:     "plaintext",
		Archived:     false,
		FolderID:     "",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}

	// Title 変更
	titleChanged := *base
	titleChanged.Title = "Different Title"
	assert.NotEqual(t, computeContentHash(base), computeContentHash(&titleChanged),
		"Title 変更でハッシュが変わるべき")

	// Language 変更
	langChanged := *base
	langChanged.Language = "javascript"
	assert.NotEqual(t, computeContentHash(base), computeContentHash(&langChanged),
		"Language 変更でハッシュが変わるべき")

	// Archived 変更
	archivedChanged := *base
	archivedChanged.Archived = true
	assert.NotEqual(t, computeContentHash(base), computeContentHash(&archivedChanged),
		"Archived 変更でハッシュが変わるべき")

	// FolderID 変更
	folderChanged := *base
	folderChanged.FolderID = "new-folder"
	assert.NotEqual(t, computeContentHash(base), computeContentHash(&folderChanged),
		"FolderID 変更でハッシュが変わるべき")

	// Content 変更
	contentChanged := *base
	contentChanged.Content = "Different Content"
	assert.NotEqual(t, computeContentHash(base), computeContentHash(&contentChanged),
		"Content 変更でハッシュが変わるべき")
}

// --- リカバリテスト ---

func TestLoadNoteList_CorruptedJSON_RecoverFromBackup(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	note := &Note{ID: "note-1", Title: "Test", Content: "hello", Language: "plaintext"}
	assert.NoError(t, helper.noteService.SaveNote(note))

	noteListPath := helper.noteService.noteListPath()
	backupPath := noteListPath + ".bak"

	goodData, _ := os.ReadFile(noteListPath)
	_ = os.WriteFile(backupPath, goodData, 0644)

	_ = os.WriteFile(noteListPath, []byte("{broken-json"), 0644)

	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	service, err := NewNoteService(helper.notesDir, logger)
	assert.NoError(t, err)
	assert.NotNil(t, service)
	assert.Equal(t, "backup", service.recoveryApplied)
	assert.Equal(t, 1, len(service.noteList.Notes))
	assert.Equal(t, "note-1", service.noteList.Notes[0].ID)

	_, statErr := os.Stat(noteListPath + ".corrupted")
	assert.False(t, os.IsNotExist(statErr), ".corrupted ファイルが保存されるべき")
}

func TestLoadNoteList_CorruptedJSON_NoBackup_RebuildFromFiles(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	note := &Note{ID: "note-1", Title: "Rebuilt", Content: "data", Language: "go"}
	assert.NoError(t, helper.noteService.SaveNote(note))

	noteListPath := helper.noteService.noteListPath()
	_ = os.WriteFile(noteListPath, []byte("{broken-json"), 0644)

	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	service, err := NewNoteService(helper.notesDir, logger)
	assert.NoError(t, err)
	assert.NotNil(t, service)
	assert.Equal(t, "rebuild", service.recoveryApplied)
	assert.Equal(t, 1, len(service.noteList.Notes))
	assert.Equal(t, "note-1", service.noteList.Notes[0].ID)
	assert.Equal(t, "Rebuilt", service.noteList.Notes[0].Title)
}

func TestLoadNoteList_MissingFile_RecoverFromBackup(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	note := &Note{ID: "note-1", Title: "Saved", Content: "c", Language: "plaintext"}
	assert.NoError(t, helper.noteService.SaveNote(note))

	noteListPath := helper.noteService.noteListPath()
	backupPath := noteListPath + ".bak"

	goodData, _ := os.ReadFile(noteListPath)
	_ = os.WriteFile(backupPath, goodData, 0644)

	os.Remove(noteListPath)

	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	service, err := NewNoteService(helper.notesDir, logger)
	assert.NoError(t, err)
	assert.Equal(t, "backup", service.recoveryApplied)
	assert.Equal(t, 1, len(service.noteList.Notes))
}

func TestLoadNoteList_EmptyFile_Recover(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	note := &Note{ID: "note-1", Title: "Test", Content: "c", Language: "plaintext"}
	assert.NoError(t, helper.noteService.SaveNote(note))

	noteListPath := helper.noteService.noteListPath()
	_ = os.WriteFile(noteListPath, []byte(""), 0644)

	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	service, err := NewNoteService(helper.notesDir, logger)
	assert.NoError(t, err)
	assert.NotNil(t, service)
	assert.Equal(t, "rebuild", service.recoveryApplied)
	assert.Equal(t, 1, len(service.noteList.Notes))
}

func TestSaveNoteList_AtomicWrite(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	note := &Note{ID: "note-1", Title: "Atomic", Content: "test", Language: "plaintext"}
	assert.NoError(t, helper.noteService.SaveNote(note))

	noteListPath := helper.noteService.noteListPath()
	data, err := os.ReadFile(noteListPath)
	assert.NoError(t, err)

	var nl NoteList
	assert.NoError(t, json.Unmarshal(data, &nl))
	assert.Equal(t, 1, len(nl.Notes))

	_, tmpErr := os.Stat(noteListPath + ".tmp")
	assert.True(t, os.IsNotExist(tmpErr), ".tmp ファイルが残っていないべき")
}

func TestLoadNoteList_SuccessCreatesBackup(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	note := &Note{ID: "note-1", Title: "Backup", Content: "test", Language: "plaintext"}
	assert.NoError(t, helper.noteService.SaveNote(note))

	noteListPath := helper.noteService.noteListPath()
	backupPath := noteListPath + ".bak"
	os.Remove(backupPath)

	logger := NewAppLogger(context.Background(), true, helper.tempDir)
	service, err := NewNoteService(helper.notesDir, logger)
	assert.NoError(t, err)
	assert.Empty(t, service.recoveryApplied)

	_, bakErr := os.Stat(backupPath)
	assert.False(t, os.IsNotExist(bakErr), ".bak ファイルが作成されるべき")
}

func TestValidateIntegrity_OrphanedFolderReference(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	note := &Note{ID: "note-1", Title: "Orphan", Content: "c", Language: "plaintext"}
	assert.NoError(t, helper.noteService.SaveNote(note))

	helper.noteService.noteList.Notes[0].FolderID = "non-existent-folder"
	helper.noteService.noteList.TopLevelOrder = []TopLevelItem{}

	changed, err := helper.noteService.ValidateIntegrity()
	assert.NoError(t, err)
	assert.True(t, changed)
	assert.Empty(t, helper.noteService.noteList.Notes[0].FolderID, "FolderID がクリアされるべき")

	found := false
	for _, item := range helper.noteService.noteList.TopLevelOrder {
		if item.Type == "note" && item.ID == "note-1" {
			found = true
			break
		}
	}
	assert.True(t, found, "ノートがTopLevelOrderに追加されるべき")
}

func TestRebuildFromPhysicalFiles_PreservesNoteData(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	notes := []*Note{
		{ID: "note-1", Title: "First", Content: "c1", Language: "go"},
		{ID: "note-2", Title: "Second", Content: "c2", Language: "python", Archived: true, ContentHeader: "c2"},
	}
	for _, n := range notes {
		assert.NoError(t, helper.noteService.SaveNote(n))
	}

	assert.NoError(t, helper.noteService.rebuildFromPhysicalFiles())

	assert.Equal(t, 2, len(helper.noteService.noteList.Notes))
	assert.Equal(t, "rebuild", helper.noteService.recoveryApplied)

	idSet := map[string]bool{}
	for _, m := range helper.noteService.noteList.Notes {
		idSet[m.ID] = true
	}
	assert.True(t, idSet["note-1"])
	assert.True(t, idSet["note-2"])
}

func TestNewEmptyNoteService_CreatesUsableService(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "empty_service_test")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	notesDir := filepath.Join(tempDir, "notes")
	os.MkdirAll(notesDir, 0755)

	logger := NewAppLogger(context.Background(), true, tempDir)
	service := NewEmptyNoteService(notesDir, logger)

	assert.NotNil(t, service)
	assert.Equal(t, "rebuild", service.recoveryApplied)
	assert.Equal(t, CurrentVersion, service.noteList.Version)

	notes, err := service.ListNotes()
	assert.NoError(t, err)
	assert.Empty(t, notes)

	note := &Note{ID: "test-1", Title: "Test", Content: "c", Language: "plaintext"}
	assert.NoError(t, service.SaveNote(note))
	assert.Equal(t, 1, len(service.noteList.Notes))
}
