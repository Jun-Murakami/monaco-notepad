package backend

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

// 既存のimportの下に追加
const CurrentVersion = "1.0"

// ノート関連のローカル操作を提供するインターフェース
type NoteService interface {
	ListNotes() ([]Note, error)                        // 全てのノートのリストを返す
	LoadNote(id string) (*Note, error)                 // 指定されたIDのノートを読み込む
	SaveNote(note *Note) error                         // ノートを保存する
	DeleteNote(id string) error                        // 指定されたIDのノートを削除する
	LoadArchivedNote(id string) (*Note, error)         // アーカイブされたノートの完全なデータを読み込む
	UpdateNoteOrder(noteID string, newIndex int) error // ノートの順序を更新する
	CreateFolder(name string) (*Folder, error)         // フォルダを作成する
	RenameFolder(id string, name string) error         // フォルダ名を変更する
	DeleteFolder(id string) error                      // フォルダを削除する（空の場合のみ）
	MoveNoteToFolder(noteID string, folderID string) error // ノートをフォルダに移動する
	ListFolders() []Folder                             // フォルダのリストを返す
	ArchiveFolder(id string) error                     // フォルダをアーカイブする（中のノートも全てアーカイブ）
	UnarchiveFolder(id string) error                   // アーカイブされたフォルダを復元する
	DeleteArchivedFolder(id string) error              // アーカイブされたフォルダを削除する（中のノートも全て削除）
	GetArchivedTopLevelOrder() []TopLevelItem          // アーカイブされたアイテムの表示順序を返す
	UpdateArchivedTopLevelOrder(order []TopLevelItem) error // アーカイブされたアイテムの表示順序を更新する
}

// NoteServiceの実装
type noteService struct {
	notesDir string
	noteList *NoteList
}

// 新しいnoteServiceインスタンスを作成
func NewNoteService(notesDir string) (*noteService, error) {
	service := &noteService{
		notesDir: notesDir,
		noteList: &NoteList{
			Version: "1.0",
			Notes:   []NoteMetadata{},
		},
	}

	// ノートリストの読み込み ※内部で物理ファイルとの不整合解決を行う
	if err := service.loadNoteList(); err != nil {
		return nil, fmt.Errorf("failed to load note list: %v", err)
	}

	return service, nil
}

// ------------------------------------------------------------
// 公開メソッド
// ------------------------------------------------------------

// 全てのノートのリストを返す ------------------------------------------------------------
func (s *noteService) ListNotes() ([]Note, error) {
	var notes []Note
	for _, metadata := range s.noteList.Notes {
		if metadata.Archived {
			// アーカイブされたノートはコンテンツを読み込まない
			notes = append(notes, Note{
				ID:            metadata.ID,
				Title:         metadata.Title,
				Content:       "", // コンテンツは空
				ContentHeader: metadata.ContentHeader,
				Language:      metadata.Language,
				ModifiedTime:  metadata.ModifiedTime,
				Order:         metadata.Order,
				Archived:      true,
				FolderID:      metadata.FolderID,
			})
		} else {
			// アクティブなノートはコンテンツを読み込む
			note, err := s.LoadNote(metadata.ID)
			if err != nil {
				continue
			}
			notes = append(notes, *note)
			notes[len(notes)-1].Order = metadata.Order
			notes[len(notes)-1].FolderID = metadata.FolderID
		}
	}

	// ノートの順序をOrderの値で並べ直す
	sort.Slice(notes, func(i, j int) bool {
		return notes[i].Order < notes[j].Order
	})

	return notes, nil
}

// 指定されたIDのノートを読み込む ------------------------------------------------------------
func (s *noteService) LoadNote(id string) (*Note, error) {
	notePath := filepath.Join(s.notesDir, id+".json")
	data, err := os.ReadFile(notePath)
	if err != nil {
		return nil, err
	}

	var note Note
	if err := json.Unmarshal(data, &note); err != nil {
		return nil, err
	}

	return &note, nil
}

// ノートを保存する ------------------------------------------------------------
func (s *noteService) SaveNote(note *Note) error {
	note.ModifiedTime = time.Now().Format(time.RFC3339)

	// FolderIDはnoteList.jsonのみで管理するため、ノートファイルには書き込まない
	savedFolderID := note.FolderID
	note.FolderID = ""
	data, err := json.MarshalIndent(note, "", "  ")
	note.FolderID = savedFolderID
	if err != nil {
		return err
	}

	// コンテンツのハッシュ値を計算
	h := sha256.New()
	h.Write(data)
	contentHash := fmt.Sprintf("%x", h.Sum(nil))

	notePath := filepath.Join(s.notesDir, note.ID+".json")
	if err := os.WriteFile(notePath, data, 0644); err != nil {
		return err
	}

	// Update note list
	found := false
	var order int

	// 既存のノートを探す
	for i, metadata := range s.noteList.Notes {
		if metadata.ID == note.ID {
			order = metadata.Order
			// 既存のメタデータを更新（FolderIDは既存の値を保持）
			s.noteList.Notes[i] = NoteMetadata{
				ID:            note.ID,
				Title:         note.Title,
				ContentHeader: note.ContentHeader,
				Language:      note.Language,
				ModifiedTime:  note.ModifiedTime,
				Archived:      note.Archived,
				ContentHash:   contentHash,
				Order:         order,
				FolderID:      metadata.FolderID,
			}
			found = true
			break
		}
	}

	if !found {
		// 新規ノートの場合、最小の順序値-1を設定（リストの先頭に追加）
		order = 0
		if len(s.noteList.Notes) > 0 {
			minOrder := s.noteList.Notes[0].Order
			for _, metadata := range s.noteList.Notes {
				if metadata.Order < minOrder {
					minOrder = metadata.Order
				}
			}
			order = minOrder - 1
		}

		s.ensureTopLevelOrder()

		s.noteList.Notes = append(s.noteList.Notes, NoteMetadata{
			ID:            note.ID,
			Title:         note.Title,
			ContentHeader: note.ContentHeader,
			Language:      note.Language,
			ModifiedTime:  note.ModifiedTime,
			Archived:      note.Archived,
			ContentHash:   contentHash,
			Order:         order,
		})

		if note.FolderID == "" && !note.Archived {
			s.noteList.TopLevelOrder = append([]TopLevelItem{{Type: "note", ID: note.ID}}, s.noteList.TopLevelOrder...)
		}
	}

	// 保存前にローカルノートリストの重複削除を実施
	s.deduplicateNoteList()

	s.noteList.LastSync = time.Now()

	return s.saveNoteList()
}

// 指定されたIDのノートを削除する ------------------------------------------------------------
func (s *noteService) DeleteNote(id string) error {
	notePath := filepath.Join(s.notesDir, id+".json")
	if err := os.Remove(notePath); err != nil && !os.IsNotExist(err) {
		return err
	}

	// ノートリストから削除
	var updatedNotes []NoteMetadata
	for _, metadata := range s.noteList.Notes {
		if metadata.ID != id {
			updatedNotes = append(updatedNotes, metadata)
		}
	}
	s.noteList.Notes = updatedNotes
	s.ensureTopLevelOrder()
	s.removeFromTopLevelOrder(id)

	s.noteList.LastSync = time.Now()

	return s.saveNoteList()
}

// 同期パスから呼ばれるノート保存（LastSync/ModifiedTime を更新しない、noteList.json も書かない）
func (s *noteService) SaveNoteFromSync(note *Note) error {
	data, err := json.MarshalIndent(note, "", "  ")
	if err != nil {
		return err
	}
	notePath := filepath.Join(s.notesDir, note.ID+".json")
	return os.WriteFile(notePath, data, 0644)
}

// 同期パスから呼ばれるノート削除（LastSync を更新しない、noteList.json も書かない）
func (s *noteService) DeleteNoteFromSync(id string) error {
	notePath := filepath.Join(s.notesDir, id+".json")
	if err := os.Remove(notePath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// CreateConflictCopy はローカルノートのコンフリクトコピーを作成する。
// 新しいIDを生成し、タイトルに "(競合コピー YYYY-MM-DD HH:MM)" を付与。
// TopLevelOrderでは元ノートの直後に配置する。
func (s *noteService) CreateConflictCopy(originalNote *Note) (*Note, error) {
	newID := uuid.New().String()
	timestamp := time.Now().Format("2006-01-02 15:04")
	copyNote := &Note{
		ID:            newID,
		Title:         originalNote.Title + " (競合コピー " + timestamp + ")",
		Content:       originalNote.Content,
		ContentHeader: originalNote.ContentHeader,
		Language:      originalNote.Language,
		ModifiedTime:  originalNote.ModifiedTime,
		Archived:      originalNote.Archived,
		FolderID:      originalNote.FolderID,
	}

	data, err := json.MarshalIndent(copyNote, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("failed to marshal conflict copy: %w", err)
	}

	h := sha256.New()
	h.Write(data)
	contentHash := fmt.Sprintf("%x", h.Sum(nil))

	notePath := filepath.Join(s.notesDir, newID+".json")
	if err := os.WriteFile(notePath, data, 0644); err != nil {
		return nil, fmt.Errorf("failed to write conflict copy: %w", err)
	}

	meta := NoteMetadata{
		ID:            newID,
		Title:         copyNote.Title,
		ContentHeader: copyNote.ContentHeader,
		Language:      copyNote.Language,
		ModifiedTime:  copyNote.ModifiedTime,
		Archived:      copyNote.Archived,
		ContentHash:   contentHash,
		FolderID:      originalNote.FolderID,
	}
	s.noteList.Notes = append(s.noteList.Notes, meta)

	originalIdx := -1
	for i, item := range s.noteList.TopLevelOrder {
		if item.Type == "note" && item.ID == originalNote.ID {
			originalIdx = i
			break
		}
	}
	newItem := TopLevelItem{Type: "note", ID: newID}
	if originalIdx >= 0 {
		s.noteList.TopLevelOrder = append(
			s.noteList.TopLevelOrder[:originalIdx+1],
			append([]TopLevelItem{newItem}, s.noteList.TopLevelOrder[originalIdx+1:]...)...)
	} else {
		s.noteList.TopLevelOrder = append(s.noteList.TopLevelOrder, newItem)
	}

	return copyNote, nil
}

// アーカイブされたノートの完全なデータを読み込む ------------------------------------------------------------
func (s *noteService) LoadArchivedNote(id string) (*Note, error) {
	return s.LoadNote(id)
}

// ノートの順序を更新 ------------------------------------------------------------
func (s *noteService) UpdateNoteOrder(noteID string, newIndex int) error {
	// アクティブなノートのみを対象とする
	activeNotes := make([]NoteMetadata, 0)
	archivedNotes := make([]NoteMetadata, 0)

	// アクティブノートとアーカイブノートを分離
	for _, note := range s.noteList.Notes {
		if note.Archived {
			archivedNotes = append(archivedNotes, note)
		} else {
			activeNotes = append(activeNotes, note)
		}
	}

	// 移動対象のノートの現在のインデックスを探す
	oldIndex := -1
	for i, note := range activeNotes {
		if note.ID == noteID {
			oldIndex = i
			break
		}
	}

	if oldIndex == -1 {
		return fmt.Errorf("note not found: %s", noteID)
	}

	// ノートを新しい位置に移動
	note := activeNotes[oldIndex]
	activeNotes = append(activeNotes[:oldIndex], activeNotes[oldIndex+1:]...)
	if newIndex > len(activeNotes) {
		newIndex = len(activeNotes)
	}
	activeNotes = append(activeNotes[:newIndex], append([]NoteMetadata{note}, activeNotes[newIndex:]...)...)

	// 順序を振り直す（1ずつ増加）
	for i := range activeNotes {
		activeNotes[i].Order = i
	}

	// アクティブノートとアーカイブノートを結合
	s.noteList.Notes = append(activeNotes, archivedNotes...)

	s.noteList.LastSync = time.Now()

	return s.saveNoteList()
}

// フォルダを作成する ------------------------------------------------------------
func (s *noteService) CreateFolder(name string) (*Folder, error) {
	if name == "" {
		return nil, fmt.Errorf("folder name is empty")
	}

	folder := &Folder{
		ID:   uuid.New().String(),
		Name: name,
	}

	s.ensureTopLevelOrder()
	s.noteList.Folders = append(s.noteList.Folders, *folder)
	s.noteList.TopLevelOrder = append(s.noteList.TopLevelOrder, TopLevelItem{Type: "folder", ID: folder.ID})
	s.noteList.LastSync = time.Now()

	if err := s.saveNoteList(); err != nil {
		return nil, err
	}
	return folder, nil
}

// フォルダ名を変更する ------------------------------------------------------------
func (s *noteService) RenameFolder(id string, name string) error {
	if name == "" {
		return fmt.Errorf("folder name is empty")
	}

	for i, folder := range s.noteList.Folders {
		if folder.ID == id {
			s.noteList.Folders[i].Name = name
			s.noteList.LastSync = time.Now()
			return s.saveNoteList()
		}
	}
	return fmt.Errorf("folder not found: %s", id)
}

// フォルダを削除する（空の場合のみ） ------------------------------------------------------------
func (s *noteService) DeleteFolder(id string) error {
	for _, note := range s.noteList.Notes {
		if note.FolderID == id {
			return fmt.Errorf("folder is not empty")
		}
	}

	var updatedFolders []Folder
	found := false
	for _, folder := range s.noteList.Folders {
		if folder.ID == id {
			found = true
			continue
		}
		updatedFolders = append(updatedFolders, folder)
	}

	if !found {
		return fmt.Errorf("folder not found: %s", id)
	}

	s.noteList.Folders = updatedFolders
	s.ensureTopLevelOrder()
	s.removeFromTopLevelOrder(id)
	s.noteList.LastSync = time.Now()
	return s.saveNoteList()
}

// ノートをフォルダに移動する（folderIDが空文字の場合は未分類に戻す） ------------------------------------------------------------
func (s *noteService) MoveNoteToFolder(noteID string, folderID string) error {
	if folderID != "" {
		folderFound := false
		for _, folder := range s.noteList.Folders {
			if folder.ID == folderID {
				folderFound = true
				break
			}
		}
		if !folderFound {
			return fmt.Errorf("folder not found: %s", folderID)
		}
	}

	for i, note := range s.noteList.Notes {
		if note.ID == noteID {
			oldFolderID := note.FolderID
			s.ensureTopLevelOrder()
			s.noteList.Notes[i].FolderID = folderID

			if folderID != "" && oldFolderID == "" {
				s.removeFromTopLevelOrder(noteID)
			} else if folderID == "" && oldFolderID != "" {
				s.noteList.TopLevelOrder = append(s.noteList.TopLevelOrder, TopLevelItem{Type: "note", ID: noteID})
			}

			s.noteList.LastSync = time.Now()
			return s.saveNoteList()
		}
	}
	return fmt.Errorf("note not found: %s", noteID)
}

// フォルダのリストを返す ------------------------------------------------------------
func (s *noteService) ListFolders() []Folder {
	if s.noteList.Folders == nil {
		return []Folder{}
	}
	return s.noteList.Folders
}

// トップレベルの表示順序を返す（後方互換: nilの場合は自動生成） ------------------------------------------------------------
func (s *noteService) GetTopLevelOrder() []TopLevelItem {
	if s.noteList.TopLevelOrder != nil {
		return s.noteList.TopLevelOrder
	}
	return s.buildTopLevelOrder()
}

// トップレベルの表示順序を更新する ------------------------------------------------------------
func (s *noteService) UpdateTopLevelOrder(order []TopLevelItem) error {
	s.noteList.TopLevelOrder = order
	s.noteList.LastSync = time.Now()
	return s.saveNoteList()
}

// TopLevelOrderがnilの場合、既存データから自動生成して初期化する ------------------------------------------------------------
func (s *noteService) ensureTopLevelOrder() {
	if s.noteList.TopLevelOrder == nil {
		s.noteList.TopLevelOrder = s.buildTopLevelOrder()
	}
}

// TopLevelOrder内の重複エントリを除去する ------------------------------------------------------------
func (s *noteService) deduplicateTopLevelOrder() {
	if s.noteList.TopLevelOrder == nil {
		return
	}
	seen := make(map[string]bool)
	var deduped []TopLevelItem
	for _, item := range s.noteList.TopLevelOrder {
		key := item.Type + ":" + item.ID
		if !seen[key] {
			seen[key] = true
			deduped = append(deduped, item)
		}
	}
	s.noteList.TopLevelOrder = deduped
}

// TopLevelOrderから指定IDを除去する ------------------------------------------------------------
func (s *noteService) removeFromTopLevelOrder(id string) {
	var updated []TopLevelItem
	for _, item := range s.noteList.TopLevelOrder {
		if item.ID != id {
			updated = append(updated, item)
		}
	}
	s.noteList.TopLevelOrder = updated
}

// 後方互換用: 未分類ノート+フォルダからTopLevelOrderを生成する ------------------------------------------------------------
func (s *noteService) buildTopLevelOrder() []TopLevelItem {
	var order []TopLevelItem
	for _, note := range s.noteList.Notes {
		if note.FolderID == "" && !note.Archived {
			order = append(order, TopLevelItem{Type: "note", ID: note.ID})
		}
	}
	for _, folder := range s.noteList.Folders {
		order = append(order, TopLevelItem{Type: "folder", ID: folder.ID})
	}
	return order
}

// フォルダをアーカイブする（中のノートも全てアーカイブ） ------------------------------------------------------------
func (s *noteService) ArchiveFolder(id string) error {
	folderIdx := -1
	for i, folder := range s.noteList.Folders {
		if folder.ID == id {
			folderIdx = i
			break
		}
	}
	if folderIdx == -1 {
		return fmt.Errorf("folder not found: %s", id)
	}

	s.noteList.Folders[folderIdx].Archived = true

	for i, metadata := range s.noteList.Notes {
		if metadata.FolderID != id {
			continue
		}
		note, err := s.LoadNote(metadata.ID)
		if err != nil {
			continue
		}
		note.Archived = true
		note.ContentHeader = generateContentHeader(note.Content)
		s.noteList.Notes[i].Archived = true
		s.noteList.Notes[i].ContentHeader = note.ContentHeader
		if err := s.SaveNoteFromSync(note); err != nil {
			return fmt.Errorf("failed to save note %s: %v", note.ID, err)
		}
	}

	s.ensureTopLevelOrder()
	s.removeFromTopLevelOrder(id)

	s.ensureArchivedTopLevelOrder()
	s.noteList.ArchivedTopLevelOrder = append(
		[]TopLevelItem{{Type: "folder", ID: id}},
		s.noteList.ArchivedTopLevelOrder...,
	)

	s.noteList.LastSync = time.Now()
	return s.saveNoteList()
}

// アーカイブされたフォルダを復元する（中のノートも全て復元） ------------------------------------------------------------
func (s *noteService) UnarchiveFolder(id string) error {
	folderIdx := -1
	for i, folder := range s.noteList.Folders {
		if folder.ID == id {
			folderIdx = i
			break
		}
	}
	if folderIdx == -1 {
		return fmt.Errorf("folder not found: %s", id)
	}
	if !s.noteList.Folders[folderIdx].Archived {
		return fmt.Errorf("folder is not archived: %s", id)
	}

	s.noteList.Folders[folderIdx].Archived = false

	for i, metadata := range s.noteList.Notes {
		if metadata.FolderID != id || !metadata.Archived {
			continue
		}
		note, err := s.LoadNote(metadata.ID)
		if err != nil {
			continue
		}
		note.Archived = false
		s.noteList.Notes[i].Archived = false
		if err := s.SaveNoteFromSync(note); err != nil {
			return fmt.Errorf("failed to save note %s: %v", note.ID, err)
		}
	}

	s.removeFromArchivedTopLevelOrder(id)

	s.ensureTopLevelOrder()
	s.noteList.TopLevelOrder = append(
		s.noteList.TopLevelOrder,
		TopLevelItem{Type: "folder", ID: id},
	)

	s.noteList.LastSync = time.Now()
	return s.saveNoteList()
}

// アーカイブされたフォルダを削除する（中のノートファイルも全て削除） ------------------------------------------------------------
func (s *noteService) DeleteArchivedFolder(id string) error {
	found := false
	for _, folder := range s.noteList.Folders {
		if folder.ID == id {
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("folder not found: %s", id)
	}

	var remainingNotes []NoteMetadata
	for _, metadata := range s.noteList.Notes {
		if metadata.FolderID == id {
			notePath := filepath.Join(s.notesDir, metadata.ID+".json")
			os.Remove(notePath)
		} else {
			remainingNotes = append(remainingNotes, metadata)
		}
	}
	s.noteList.Notes = remainingNotes

	var remainingFolders []Folder
	for _, folder := range s.noteList.Folders {
		if folder.ID != id {
			remainingFolders = append(remainingFolders, folder)
		}
	}
	s.noteList.Folders = remainingFolders

	s.removeFromArchivedTopLevelOrder(id)
	s.removeFromTopLevelOrder(id)

	s.noteList.LastSync = time.Now()
	return s.saveNoteList()
}

// アーカイブされたアイテムの表示順序を返す ------------------------------------------------------------
func (s *noteService) GetArchivedTopLevelOrder() []TopLevelItem {
	if s.noteList.ArchivedTopLevelOrder != nil {
		return s.noteList.ArchivedTopLevelOrder
	}
	return s.buildArchivedTopLevelOrder()
}

// アーカイブされたアイテムの表示順序を更新する ------------------------------------------------------------
func (s *noteService) UpdateArchivedTopLevelOrder(order []TopLevelItem) error {
	s.noteList.ArchivedTopLevelOrder = order
	s.noteList.LastSync = time.Now()
	return s.saveNoteList()
}

func (s *noteService) ensureArchivedTopLevelOrder() {
	if s.noteList.ArchivedTopLevelOrder == nil {
		s.noteList.ArchivedTopLevelOrder = s.buildArchivedTopLevelOrder()
	}
}

func (s *noteService) buildArchivedTopLevelOrder() []TopLevelItem {
	archivedFolderIDs := make(map[string]bool)
	for _, folder := range s.noteList.Folders {
		if folder.Archived {
			archivedFolderIDs[folder.ID] = true
		}
	}

	var order []TopLevelItem
	for _, folder := range s.noteList.Folders {
		if folder.Archived {
			order = append(order, TopLevelItem{Type: "folder", ID: folder.ID})
		}
	}
	for _, note := range s.noteList.Notes {
		if note.Archived && !archivedFolderIDs[note.FolderID] {
			order = append(order, TopLevelItem{Type: "note", ID: note.ID})
		}
	}
	return order
}

func (s *noteService) removeFromArchivedTopLevelOrder(id string) {
	var updated []TopLevelItem
	for _, item := range s.noteList.ArchivedTopLevelOrder {
		if item.ID != id {
			updated = append(updated, item)
		}
	}
	s.noteList.ArchivedTopLevelOrder = updated
}

func (s *noteService) deduplicateArchivedTopLevelOrder() {
	if s.noteList.ArchivedTopLevelOrder == nil {
		return
	}
	seen := make(map[string]bool)
	var deduped []TopLevelItem
	for _, item := range s.noteList.ArchivedTopLevelOrder {
		key := item.Type + ":" + item.ID
		if !seen[key] {
			seen[key] = true
			deduped = append(deduped, item)
		}
	}
	s.noteList.ArchivedTopLevelOrder = deduped
}

func generateContentHeader(content string) string {
	lines := strings.Split(content, "\n")
	var nonEmpty []string
	for _, line := range lines {
		if strings.TrimSpace(line) != "" {
			nonEmpty = append(nonEmpty, line)
			if len(nonEmpty) >= 3 {
				break
			}
		}
	}
	header := strings.Join(nonEmpty, "\n")
	if len(header) > 200 {
		header = header[:200]
	}
	return header
}

// ------------------------------------------------------------
// 内部ヘルパー
// ------------------------------------------------------------

func generateUUID() string {
	return uuid.New().String()
}

// noteList内の重複するノートを削除し、最新のものだけを保持 ------------------------------------------------------------
func (s *noteService) deduplicateNoteList() {
	seen := make(map[string]int)
	deduped := make([]NoteMetadata, 0, len(s.noteList.Notes))
	for _, metadata := range s.noteList.Notes {
		if idx, exists := seen[metadata.ID]; exists {
			if isModifiedTimeAfter(metadata.ModifiedTime, deduped[idx].ModifiedTime) {
				deduped[idx] = metadata
			}
		} else {
			seen[metadata.ID] = len(deduped)
			deduped = append(deduped, metadata)
		}
	}
	s.noteList.Notes = deduped
}

// ノートリストをJSONファイルから読み込む ------------------------------------------------------------
func (s *noteService) loadNoteList() error {
	noteListPath := filepath.Join(filepath.Dir(s.notesDir), "noteList.json")

	if _, err := os.Stat(noteListPath); os.IsNotExist(err) {
		fmt.Println("loadNoteList: noteList.json not found, creating new one")
		s.noteList = &NoteList{
			Version: "1.0",
			Notes:   []NoteMetadata{},
			// LastSync はゼロ値のまま（クラウドに既存データがあれば cloud→local を優先させる）
		}
		return s.saveNoteList()
	}

	// 既存のノートリストを読み込む
	data, err := os.ReadFile(noteListPath)
	if err != nil {
		return err
	}

	if err := json.Unmarshal(data, &s.noteList); err != nil {
		return err
	}

	s.deduplicateTopLevelOrder()

	// 処理前のノートリストをコピー
	originalNotes := make([]NoteMetadata, len(s.noteList.Notes))
	copy(originalNotes, s.noteList.Notes)

	// 読み込んだ後に重複削除を実施
	s.deduplicateNoteList()

	// メタデータの競合解決を実行
	if err := s.resolveMetadataConflicts(); err != nil {
		return fmt.Errorf("failed to resolve metadata conflicts: %v", err)
	}

	// ノートリストと物理ファイルの整合性を検証・修復
	if _, err := s.ValidateIntegrity(); err != nil {
		return err
	}

	// resolveMetadataConflicts で変更があった場合、LastSync を変えずに保存（起動時の正規化は同期方向に影響させない）
	if !s.isNoteListEqual(originalNotes, s.noteList.Notes) {
		if err := s.saveNoteList(); err != nil {
			return fmt.Errorf("failed to save note list after changes: %v", err)
		}
	}

	return nil
}

// 2つのノートリストが等しいかどうかを比較する ------------------------------------------------------------
func (s *noteService) isNoteListEqual(a, b []NoteMetadata) bool {
	if len(a) != len(b) {
		return false
	}

	// IDでソートした配列を作成
	sortedA := make([]NoteMetadata, len(a))
	sortedB := make([]NoteMetadata, len(b))
	copy(sortedA, a)
	copy(sortedB, b)

	sort.Slice(sortedA, func(i, j int) bool {
		return sortedA[i].ID < sortedA[j].ID
	})
	sort.Slice(sortedB, func(i, j int) bool {
		return sortedB[i].ID < sortedB[j].ID
	})

	// 各要素を比較
	for i := range sortedA {
		if sortedA[i].ID != sortedB[i].ID ||
			sortedA[i].Title != sortedB[i].Title ||
			sortedA[i].ContentHeader != sortedB[i].ContentHeader ||
			sortedA[i].Language != sortedB[i].Language ||
			sortedA[i].ModifiedTime != sortedB[i].ModifiedTime ||
			sortedA[i].Archived != sortedB[i].Archived ||
			sortedA[i].ContentHash != sortedB[i].ContentHash ||
			sortedA[i].Order != sortedB[i].Order ||
			sortedA[i].FolderID != sortedB[i].FolderID {
			return false
		}
	}

	return true
}

// メタデータの競合を解決する ------------------------------------------------------------
func (s *noteService) resolveMetadataConflicts() error {
	resolvedNotes := make([]NoteMetadata, 0)

	// ノートリストの各メタデータについて処理
	for _, listMetadata := range s.noteList.Notes {
		// ノートファイルを読み込む
		note, err := s.LoadNote(listMetadata.ID)
		if err != nil {
			if os.IsNotExist(err) {
				// ノートファイルが存在しない場合はスキップ
				continue
			}
			return fmt.Errorf("failed to load note %s: %v", listMetadata.ID, err)
		}

		// ノートファイルから新しいメタデータを作成
		fileMetadata := NoteMetadata{
			ID:            note.ID,
			Title:         note.Title,
			ContentHeader: note.ContentHeader,
			Language:      note.Language,
			ModifiedTime:  note.ModifiedTime,
			Archived:      note.Archived,
			// ContentHash, Order, FolderIDはノートリストの値を保持
			ContentHash: listMetadata.ContentHash,
			Order:       listMetadata.Order,
			FolderID:    listMetadata.FolderID,
		}

		// メタデータの競合を解決
		resolvedMetadata := s.resolveMetadata(listMetadata, fileMetadata)

		if resolvedMetadata.ModifiedTime != note.ModifiedTime ||
			resolvedMetadata.Title != note.Title ||
			resolvedMetadata.ContentHeader != note.ContentHeader ||
			resolvedMetadata.Language != note.Language ||
			resolvedMetadata.Archived != note.Archived {

			note.ModifiedTime = resolvedMetadata.ModifiedTime
			note.Title = resolvedMetadata.Title
			note.ContentHeader = resolvedMetadata.ContentHeader
			note.Language = resolvedMetadata.Language
			note.Archived = resolvedMetadata.Archived

			if err := s.SaveNoteFromSync(note); err != nil {
				return fmt.Errorf("failed to save resolved note %s: %v", note.ID, err)
			}
		}

		resolvedNotes = append(resolvedNotes, resolvedMetadata)
	}

	// 解決したメタデータでノートリストを更新
	s.noteList.Notes = resolvedNotes
	return nil
}

// 2つのメタデータを比較して競合を解決する ------------------------------------------------------------
func (s *noteService) resolveMetadata(listMetadata, fileMetadata NoteMetadata) NoteMetadata {
	// ModifiedTimeを比較して新しい方を採用
	if isModifiedTimeAfter(listMetadata.ModifiedTime, fileMetadata.ModifiedTime) {
		return listMetadata
	} else if isModifiedTimeAfter(fileMetadata.ModifiedTime, listMetadata.ModifiedTime) {
		// ファイルの方が新しい場合はファイルのメタデータを採用（OrderとContentHashは保持）
		fileMetadata.Order = listMetadata.Order
		fileMetadata.ContentHash = listMetadata.ContentHash
		return fileMetadata
	}

	// ModifiedTimeが同じ場合はファイルのメタデータを優先（OrderとContentHashは保持）
	fileMetadata.Order = listMetadata.Order
	fileMetadata.ContentHash = listMetadata.ContentHash
	return fileMetadata
}

// ノートリストをJSONファイルとして保存 ------------------------------------------------------------
func (s *noteService) saveNoteList() error {
	s.deduplicateTopLevelOrder()
	s.deduplicateArchivedTopLevelOrder()

	data, err := json.MarshalIndent(s.noteList, "", "  ")
	if err != nil {
		return err
	}

	noteListPath := filepath.Join(filepath.Dir(s.notesDir), "noteList.json")
	return os.WriteFile(noteListPath, data, 0644)
}

// 物理ファイルとノートリストの整合性を検証・修復する ------------------------------------------------------------
// 起動時および同期完了後に呼ばれ、以下を行う:
// 1. リストに無い孤立物理ファイル → noteListに復活
// 2. 物理ファイルが無いリストエントリ → noteListから除去
// 3. TopLevelOrder / ArchivedTopLevelOrder の無効参照を除去
func (s *noteService) ValidateIntegrity() (changed bool, err error) {
	files, err := os.ReadDir(s.notesDir)
	if err != nil {
		return false, err
	}

	noteIDSet := make(map[string]bool)
	for _, metadata := range s.noteList.Notes {
		noteIDSet[metadata.ID] = true
	}

	// 1. 孤立物理ファイルをnoteListに復活
	physicalNotes := make(map[string]bool)
	for _, file := range files {
		if filepath.Ext(file.Name()) != ".json" {
			continue
		}
		noteID := file.Name()[:len(file.Name())-5]
		physicalNotes[noteID] = true

		if !noteIDSet[noteID] {
			note, loadErr := s.LoadNote(noteID)
			if loadErr != nil {
				continue
			}
			s.noteList.Notes = append(s.noteList.Notes, NoteMetadata{
				ID:            note.ID,
				Title:         note.Title,
				ContentHeader: note.ContentHeader,
				Language:      note.Language,
				ModifiedTime:  note.ModifiedTime,
				Archived:      note.Archived,
			})
			changed = true
		}
	}

	// 2. 物理ファイルが無いリストエントリを除去
	var validNotes []NoteMetadata
	for _, metadata := range s.noteList.Notes {
		if physicalNotes[metadata.ID] {
			validNotes = append(validNotes, metadata)
		} else {
			changed = true
		}
	}
	s.noteList.Notes = validNotes

	// 有効なノートID・フォルダIDのセットを構築
	validNoteIDs := make(map[string]bool)
	for _, m := range s.noteList.Notes {
		validNoteIDs[m.ID] = true
	}
	validFolderIDs := make(map[string]bool)
	for _, f := range s.noteList.Folders {
		validFolderIDs[f.ID] = true
	}

	// 3. TopLevelOrder の無効参照を除去
	if s.noteList.TopLevelOrder != nil {
		var cleaned []TopLevelItem
		for _, item := range s.noteList.TopLevelOrder {
			if (item.Type == "note" && validNoteIDs[item.ID]) ||
				(item.Type == "folder" && validFolderIDs[item.ID]) {
				cleaned = append(cleaned, item)
			} else {
				changed = true
			}
		}
		s.noteList.TopLevelOrder = cleaned
	}

	// 4. ArchivedTopLevelOrder の無効参照を除去
	if s.noteList.ArchivedTopLevelOrder != nil {
		var cleaned []TopLevelItem
		for _, item := range s.noteList.ArchivedTopLevelOrder {
			if (item.Type == "note" && validNoteIDs[item.ID]) ||
				(item.Type == "folder" && validFolderIDs[item.ID]) {
				cleaned = append(cleaned, item)
			} else {
				changed = true
			}
		}
		s.noteList.ArchivedTopLevelOrder = cleaned
	}

	if changed {
		if saveErr := s.saveNoteList(); saveErr != nil {
			return changed, saveErr
		}
	}

	return changed, nil
}
