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

const CurrentVersion = "2.0"

// computeContentHash はノートの安定フィールドのみからハッシュを計算する
func computeContentHash(note *Note) string {
	h := sha256.New()
	fmt.Fprintf(h, "%s\n%s\n%s\n%s\n%v\n%s",
		note.ID, note.Title, note.Content, note.Language, note.Archived, note.FolderID)
	return fmt.Sprintf("%x", h.Sum(nil))
}

func isConflictCopyTitle(title string) bool {
	return strings.Contains(strings.ToLower(title), "conflict copy")
}

func computeConflictCopyDedupHash(note *Note) string {
	h := sha256.New()
	// Archived と FolderID は含めない。conflict copy は元ノートと異なる
	// archived 状態やフォルダに配置されることがあるため、内容の同一性のみで判定する。
	fmt.Fprintf(h, "%s\n%s", note.Content, note.Language)
	return fmt.Sprintf("%x", h.Sum(nil))
}

// ノート関連のローカル操作を提供するインターフェース
type NoteService interface {
	ListNotes() ([]Note, error)                             // 全てのノートのリストを返す
	LoadNote(id string) (*Note, error)                      // 指定されたIDのノートを読み込む
	SaveNote(note *Note) error                              // ノートを保存する
	DeleteNote(id string) error                             // 指定されたIDのノートを削除する
	LoadArchivedNote(id string) (*Note, error)              // アーカイブされたノートの完全なデータを読み込む
	UpdateNoteOrder(noteID string, newIndex int) error      // ノートの順序を更新する
	CreateFolder(name string) (*Folder, error)              // フォルダを作成する
	RenameFolder(id string, name string) error              // フォルダ名を変更する
	DeleteFolder(id string) error                           // フォルダを削除する（空の場合のみ）
	MoveNoteToFolder(noteID string, folderID string) error  // ノートをフォルダに移動する
	ListFolders() []Folder                                  // フォルダのリストを返す
	ArchiveFolder(id string) error                          // フォルダをアーカイブする（中のノートも全てアーカイブ）
	UnarchiveFolder(id string) error                        // アーカイブされたフォルダを復元する
	DeleteArchivedFolder(id string) error                   // アーカイブされたフォルダを削除する（中のノートも全て削除）
	GetArchivedTopLevelOrder() []TopLevelItem               // アーカイブされたアイテムの表示順序を返す
	UpdateArchivedTopLevelOrder(order []TopLevelItem) error // アーカイブされたアイテムの表示順序を更新する
}

// NoteServiceの実装
type noteService struct {
	notesDir               string
	noteList               *NoteList
	logger                 AppLogger
	pendingIntegrityIssues []IntegrityIssue
	recoveryApplied        string // 復旧方法: "", "backup", "rebuild"
}

type conflictCopyResolution struct {
	deleted []string
	kept    []string
	changed bool
}

// 最終フォールバック用の空のnoteServiceインスタンスを作成（NewNoteServiceが全リカバリ失敗時のみ使用）
func NewEmptyNoteService(notesDir string, logger AppLogger) *noteService {
	return &noteService{
		notesDir: notesDir,
		noteList: &NoteList{
			Version: CurrentVersion,
			Notes:   []NoteMetadata{},
		},
		logger:          logger,
		recoveryApplied: "rebuild",
	}
}

// 新しいnoteServiceインスタンスを作成
func NewNoteService(notesDir string, logger AppLogger) (*noteService, error) {
	service := &noteService{
		notesDir: notesDir,
		noteList: &NoteList{
			Version: CurrentVersion,
			Notes:   []NoteMetadata{},
		},
		logger: logger,
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
				Archived:      true,
				FolderID:      metadata.FolderID,
			})
		} else {
			// アクティブなノートはコンテンツを読み込む
			note, err := s.LoadNote(metadata.ID)
			if err != nil {
				// ファイルが未ダウンロードの場合はSyncing状態として返す
				notes = append(notes, Note{
					ID:            metadata.ID,
					Title:         metadata.Title,
					Content:       "",
					ContentHeader: metadata.ContentHeader,
					Language:      metadata.Language,
					ModifiedTime:  metadata.ModifiedTime,
					Archived:      false,
					FolderID:      metadata.FolderID,
					Syncing:       true,
				})
				continue
			}
			notes = append(notes, *note)
			notes[len(notes)-1].FolderID = metadata.FolderID
		}
	}

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

	contentHash := computeContentHash(note)

	notePath := filepath.Join(s.notesDir, note.ID+".json")
	if err := os.WriteFile(notePath, data, 0644); err != nil {
		return err
	}

	found := false

	// 既存のノートを探す
	for i, metadata := range s.noteList.Notes {
		if metadata.ID == note.ID {
			// 既存のメタデータを更新（FolderIDは既存の値を保持）
			s.noteList.Notes[i] = NoteMetadata{
				ID:            note.ID,
				Title:         note.Title,
				ContentHeader: note.ContentHeader,
				Language:      note.Language,
				ModifiedTime:  note.ModifiedTime,
				Archived:      note.Archived,
				ContentHash:   contentHash,
				FolderID:      metadata.FolderID,
			}
			found = true
			break
		}
	}

	if !found {
		s.ensureTopLevelOrder()

		newMetadata := NoteMetadata{
			ID:            note.ID,
			Title:         note.Title,
			ContentHeader: note.ContentHeader,
			Language:      note.Language,
			ModifiedTime:  note.ModifiedTime,
			Archived:      note.Archived,
			ContentHash:   contentHash,
		}

		// 新規ノートはアクティブリスト先頭に追加して、UIの表示順と揃える
		if !note.Archived {
			activeNotes := make([]NoteMetadata, 0)
			archivedNotes := make([]NoteMetadata, 0)
			for _, metadata := range s.noteList.Notes {
				if metadata.Archived {
					archivedNotes = append(archivedNotes, metadata)
				} else {
					activeNotes = append(activeNotes, metadata)
				}
			}
			s.noteList.Notes = append([]NoteMetadata{newMetadata}, activeNotes...)
			s.noteList.Notes = append(s.noteList.Notes, archivedNotes...)
		} else {
			s.noteList.Notes = append(s.noteList.Notes, newMetadata)
		}

		if note.FolderID == "" && !note.Archived {
			s.noteList.TopLevelOrder = append([]TopLevelItem{{Type: "note", ID: note.ID}}, s.noteList.TopLevelOrder...)
		}
	}

	// 保存前にローカルノートリストの重複削除を実施
	s.deduplicateNoteList()
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

func (s *noteService) buildNoteMetadata(note *Note) NoteMetadata {
	return NoteMetadata{
		ID:            note.ID,
		Title:         note.Title,
		ContentHeader: note.ContentHeader,
		Language:      note.Language,
		ModifiedTime:  note.ModifiedTime,
		Archived:      note.Archived,
		ContentHash:   computeContentHash(note),
		FolderID:      note.FolderID,
	}
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

	// アクティブノートとアーカイブノートを結合
	s.noteList.Notes = append(activeNotes, archivedNotes...)

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

	now := time.Now().Format(time.RFC3339)
	for i, metadata := range s.noteList.Notes {
		if metadata.FolderID != id {
			continue
		}
		note, err := s.LoadNote(metadata.ID)
		if err != nil {
			s.logConsole("Skipped archiving note %s due to load failure: %v", metadata.ID, err)
			continue
		}
		note.Archived = true
		note.ModifiedTime = now
		note.ContentHeader = generateContentHeader(note.Content)
		s.noteList.Notes[i].Archived = true
		s.noteList.Notes[i].ModifiedTime = now
		s.noteList.Notes[i].ContentHash = computeContentHash(note)
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

	now := time.Now().Format(time.RFC3339)
	for i, metadata := range s.noteList.Notes {
		if metadata.FolderID != id || !metadata.Archived {
			continue
		}
		note, err := s.LoadNote(metadata.ID)
		if err != nil {
			s.logConsole("Skipped restoring note %s due to load failure: %v", metadata.ID, err)
			continue
		}
		note.Archived = false
		note.ModifiedTime = now
		s.noteList.Notes[i].Archived = false
		s.noteList.Notes[i].ModifiedTime = now
		s.noteList.Notes[i].ContentHash = computeContentHash(note)
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
	deletedCount := 0
	for _, metadata := range s.noteList.Notes {
		if metadata.FolderID == id {
			notePath := filepath.Join(s.notesDir, metadata.ID+".json")
			if err := os.Remove(notePath); err == nil {
				deletedCount++
				s.logConsole("Deleted archived note \"%s\"", metadata.Title)
			} else if !os.IsNotExist(err) {
				s.logConsole("Failed to delete archived note \"%s\": %v", metadata.Title, err)
			}
		} else {
			remainingNotes = append(remainingNotes, metadata)
		}
	}
	if deletedCount > 0 {
		s.logInfo("Deleted %d notes in archived folder", deletedCount)
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
	duplicateCount := 0
	for _, metadata := range s.noteList.Notes {
		if idx, exists := seen[metadata.ID]; exists {
			duplicateCount++
			if isModifiedTimeAfter(metadata.ModifiedTime, deduped[idx].ModifiedTime) {
				deduped[idx] = metadata
			}
		} else {
			seen[metadata.ID] = len(deduped)
			deduped = append(deduped, metadata)
		}
	}
	if duplicateCount > 0 {
		s.logInfo("Removed %d duplicate entries from note list", duplicateCount)
	}
	s.noteList.Notes = deduped
}

// ノートリストをJSONファイルから読み込む ------------------------------------------------------------
// 読み込み失敗時はバックアップ → 一時ファイル → 物理ファイルからの再構築を試みる
func (s *noteService) loadNoteList() error {
	noteListPath := s.noteListPath()
	backupPath := noteListPath + ".bak"

	// --- Phase 1: メインファイルの読み込み ---
	loaded := false

	if _, err := os.Stat(noteListPath); os.IsNotExist(err) {
		// メインファイルが存在しない → リカバリ試行
		s.logConsole("Note list file not found, attempting recovery...")
		if err := s.recoverNoteList(noteListPath); err != nil {
			// リカバリも失敗 → 新規作成
			s.logInfo("Note list not found, creating new one")
			s.noteList = &NoteList{
				Version: CurrentVersion,
				Notes:   []NoteMetadata{},
			}
			return s.saveNoteList()
		}
		loaded = true
	}

	if !loaded {
		data, readErr := os.ReadFile(noteListPath)
		if readErr != nil {
			s.logConsole("Failed to read note list: %v", readErr)
			if err := s.recoverNoteList(noteListPath); err != nil {
				return fmt.Errorf("failed to load note list and all recovery failed: %v", err)
			}
			loaded = true
		}

		if !loaded {
			if parseErr := json.Unmarshal(data, &s.noteList); parseErr != nil {
				s.logConsole("Note list JSON corrupted: %v", parseErr)
				s.preserveCorruptedFile(noteListPath)
				if err := s.recoverNoteList(noteListPath); err != nil {
					return fmt.Errorf("failed to parse note list and all recovery failed: %v", err)
				}
			} else {
				// 正常読み込み成功 → バックアップ保存
				_ = os.WriteFile(backupPath, data, 0644)
			}
		}
	}

	// --- Phase 2: 後処理（既存ロジック） ---
	s.deduplicateTopLevelOrder()

	originalNotes := make([]NoteMetadata, len(s.noteList.Notes))
	copy(originalNotes, s.noteList.Notes)

	s.deduplicateNoteList()

	if err := s.resolveMetadataConflicts(); err != nil {
		return fmt.Errorf("failed to resolve metadata conflicts: %v", err)
	}

	if _, err := s.ValidateIntegrity(); err != nil {
		return err
	}

	if !s.isNoteListEqual(originalNotes, s.noteList.Notes) {
		s.logConsole("Saving note list due to normalization changes")
		if err := s.saveNoteList(); err != nil {
			return fmt.Errorf("failed to save note list after changes: %v", err)
		}
	}

	return nil
}

// 破損したファイルを .corrupted として保存する（デバッグ用） ------------------------------------------------------------
func (s *noteService) preserveCorruptedFile(path string) {
	corruptedPath := path + ".corrupted"
	if data, err := os.ReadFile(path); err == nil {
		_ = os.WriteFile(corruptedPath, data, 0644)
		s.logConsole("Corrupted note list saved to %s", corruptedPath)
	}
}

// リカバリチェーン: バックアップ → 一時ファイル → 物理ファイルからの再構築 ------------------------------------------------------------
func (s *noteService) recoverNoteList(noteListPath string) error {
	backupPath := noteListPath + ".bak"
	tmpPath := noteListPath + ".tmp"

	// 1. バックアップから復旧
	if data, err := os.ReadFile(backupPath); err == nil {
		if err := json.Unmarshal(data, &s.noteList); err == nil {
			s.recoveryApplied = "backup"
			s.logInfo("Note list restored from backup")
			return s.saveNoteList()
		}
		s.logConsole("Backup file also corrupted, trying next recovery method...")
	}

	// 2. 一時ファイルから復旧（アトミック書き込み中断の可能性）
	if data, err := os.ReadFile(tmpPath); err == nil {
		if err := json.Unmarshal(data, &s.noteList); err == nil {
			s.recoveryApplied = "backup"
			s.logInfo("Note list restored from temporary file")
			_ = os.Remove(tmpPath)
			return s.saveNoteList()
		}
		s.logConsole("Temp file also corrupted, trying rebuild from note files...")
	}

	// 3. 物理ファイルから再構築
	return s.rebuildFromPhysicalFiles()
}

// 物理ノートファイルからノートリストを再構築する ------------------------------------------------------------
// フォルダ構造と表示順序は復元できないため、全ノートがトップレベルに配置される
func (s *noteService) rebuildFromPhysicalFiles() error {
	files, err := os.ReadDir(s.notesDir)
	if err != nil {
		return fmt.Errorf("failed to read notes directory: %w", err)
	}

	s.noteList = &NoteList{
		Version: CurrentVersion,
		Notes:   []NoteMetadata{},
	}

	recoveredCount := 0
	for _, file := range files {
		if filepath.Ext(file.Name()) != ".json" {
			continue
		}
		noteID := file.Name()[:len(file.Name())-5]
		note, loadErr := s.LoadNote(noteID)
		if loadErr != nil {
			s.logConsole("Skipping unreadable note file: %s", file.Name())
			continue
		}

		s.noteList.Notes = append(s.noteList.Notes, NoteMetadata{
			ID:            note.ID,
			Title:         note.Title,
			ContentHeader: note.ContentHeader,
			Language:      note.Language,
			ModifiedTime:  note.ModifiedTime,
			Archived:      note.Archived,
			ContentHash:   computeContentHash(note),
		})
		recoveredCount++
	}

	s.noteList.TopLevelOrder = s.buildTopLevelOrder()
	s.noteList.ArchivedTopLevelOrder = s.buildArchivedTopLevelOrder()
	s.recoveryApplied = "rebuild"

	s.logConsole("Rebuilt note list from %d physical files (folder structure lost)", recoveredCount)
	return s.saveNoteList()
}

// 復旧が適用されたかどうかと方法を返し、フラグをリセットする ------------------------------------------------------------
func (s *noteService) DrainRecoveryApplied() string {
	r := s.recoveryApplied
	s.recoveryApplied = ""
	return r
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
			sortedA[i].FolderID != sortedB[i].FolderID {
			return false
		}
	}

	return true
}

// メタデータの競合を解決する ------------------------------------------------------------
func (s *noteService) resolveMetadataConflicts() error {
	resolvedNotes := make([]NoteMetadata, 0)
	resolvedCount := 0
	skippedCount := 0

	// ノートリストの各メタデータについて処理
	for _, listMetadata := range s.noteList.Notes {
		// ノートファイルを読み込む
		note, err := s.LoadNote(listMetadata.ID)
		if err != nil {
			if os.IsNotExist(err) {
				skippedCount++
				s.logConsole("Metadata conflict resolution: skipping note %s (file not found)", listMetadata.ID)
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
			ContentHash:   listMetadata.ContentHash,
			FolderID:      listMetadata.FolderID,
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
			resolvedCount++
		}

		resolvedNotes = append(resolvedNotes, resolvedMetadata)
	}

	if resolvedCount > 0 {
		s.logInfo("Resolved %d metadata conflicts", resolvedCount)
	}
	if skippedCount > 0 {
		s.logConsole("Metadata conflict resolution: skipped %d notes (files not found)", skippedCount)
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
		fileMetadata.ContentHash = listMetadata.ContentHash
		return fileMetadata
	}

	fileMetadata.ContentHash = listMetadata.ContentHash
	return fileMetadata
}

// noteList_v2.json のファイルパスを返す ------------------------------------------------------------
func (s *noteService) noteListPath() string {
	return filepath.Join(filepath.Dir(s.notesDir), "noteList_v2.json")
}

// ノートリストをJSONファイルとしてアトミックに保存 ------------------------------------------------------------
// 一時ファイルに書き込んでからrenameすることで、書き込み途中のクラッシュによる破損を防止する
func (s *noteService) saveNoteList() error {
	s.deduplicateTopLevelOrder()
	s.deduplicateArchivedTopLevelOrder()

	data, err := json.MarshalIndent(s.noteList, "", "  ")
	if err != nil {
		return err
	}

	noteListPath := s.noteListPath()
	tmpPath := noteListPath + ".tmp"

	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write temp note list: %w", err)
	}

	if err := os.Rename(tmpPath, noteListPath); err != nil {
		// rename失敗時は直接書き込みにフォールバック
		s.logConsole("Atomic rename failed, falling back to direct write: %v", err)
		return os.WriteFile(noteListPath, data, 0644)
	}

	return nil
}

// logInfo はloggerが設定されている場合にInfo出力する
func (s *noteService) logInfo(format string, args ...interface{}) {
	if s.logger != nil {
		s.logger.Info(format, args...)
	}
}

// logConsole はloggerが設定されている場合にConsole出力する
func (s *noteService) logConsole(format string, args ...interface{}) {
	if s.logger != nil {
		s.logger.Console(format, args...)
	}
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

	var issues []IntegrityIssue
	var repairLogs []string
	logRepair := func(format string, args ...interface{}) {
		message := fmt.Sprintf(format, args...)
		repairLogs = append(repairLogs, message)
		if s.logger != nil {
			s.logger.Info("Integrity repair: %s", message)
		}
	}

	noteIDSet := make(map[string]bool)
	for _, metadata := range s.noteList.Notes {
		noteIDSet[metadata.ID] = true
	}

	// 1. 孤立物理ファイルを検出（ユーザー確認が必要）
	physicalNotes := make(map[string]bool)
	for _, file := range files {
		if filepath.Ext(file.Name()) != ".json" {
			continue
		}
		noteID := file.Name()[:len(file.Name())-5]
		physicalNotes[noteID] = true

		if !noteIDSet[noteID] {
			title := noteID
			if note, loadErr := s.LoadNote(noteID); loadErr == nil && note.Title != "" {
				title = note.Title
			}
			issues = append(issues, IntegrityIssue{
				ID:                "orphan_file:" + noteID,
				Kind:              "orphan_file",
				Severity:          "warn",
				NeedsUserDecision: true,
				NoteIDs:           []string{noteID},
				Summary:           fmt.Sprintf("Unknown file: \"%s\"", title),
				FixOptions: []IntegrityFixOption{
					{
						ID:          "restore",
						Label:       "Restore",
						Description: "Restore",
						Params:      map[string]string{"noteId": noteID},
					},
					{
						ID:          "delete",
						Label:       "Delete",
						Description: "Delete",
						Params:      map[string]string{"noteId": noteID},
					},
				},
			})
		}
	}

	// 2. 物理ファイルが無いリストエントリをサイレント除外
	missingFileIDs := make(map[string]bool)
	{
		var validNotes []NoteMetadata
		removedCount := 0
		for _, metadata := range s.noteList.Notes {
			if !physicalNotes[metadata.ID] {
				missingFileIDs[metadata.ID] = true
				removedCount++
				changed = true
				continue
			}
			validNotes = append(validNotes, metadata)
		}
		s.noteList.Notes = validNotes
		if removedCount > 0 {
			logRepair("Removed %d notes with missing files", removedCount)
		}
	}

	// 有効なノートID・フォルダIDのセットを構築（archived状態別）
	activeNoteIDs := make(map[string]bool)
	archivedNoteIDs := make(map[string]bool)
	for _, m := range s.noteList.Notes {
		if m.Archived {
			archivedNoteIDs[m.ID] = true
		} else {
			activeNoteIDs[m.ID] = true
		}
	}
	activeFolderIDs := make(map[string]bool)
	archivedFolderIDs := make(map[string]bool)
	for _, f := range s.noteList.Folders {
		if f.Archived {
			archivedFolderIDs[f.ID] = true
		} else {
			activeFolderIDs[f.ID] = true
		}
	}

	// 3. TopLevelOrder: アクティブなノート/フォルダのみ保持
	topLevelSeen := make(map[string]bool)
	{
		var cleaned []TopLevelItem
		removedCount := 0
		for _, item := range s.noteList.TopLevelOrder {
			key := item.Type + ":" + item.ID
			if topLevelSeen[key] {
				removedCount++
				changed = true
				continue
			}
			isValid := (item.Type == "note" && activeNoteIDs[item.ID]) ||
				(item.Type == "folder" && activeFolderIDs[item.ID])
			if isValid {
				topLevelSeen[key] = true
				cleaned = append(cleaned, item)
			} else {
				removedCount++
				changed = true
			}
		}
		s.noteList.TopLevelOrder = cleaned
		if removedCount > 0 {
			logRepair("TopLevelOrder: removed %d invalid/duplicate", removedCount)
		}
	}

	// 4. ArchivedTopLevelOrder: アーカイブ済みノート/フォルダのみ保持
	archivedSeen := make(map[string]bool)
	{
		var cleaned []TopLevelItem
		removedCount := 0
		for _, item := range s.noteList.ArchivedTopLevelOrder {
			key := item.Type + ":" + item.ID
			if archivedSeen[key] {
				removedCount++
				changed = true
				continue
			}
			isValid := (item.Type == "note" && archivedNoteIDs[item.ID]) ||
				(item.Type == "folder" && archivedFolderIDs[item.ID])
			if isValid {
				archivedSeen[key] = true
				cleaned = append(cleaned, item)
			} else {
				removedCount++
				changed = true
			}
		}
		s.noteList.ArchivedTopLevelOrder = cleaned
		if removedCount > 0 {
			logRepair("ArchivedTopLevelOrder: removed %d invalid/duplicate", removedCount)
		}
	}

	// 5. アクティブノート/フォルダがTopLevelOrderに存在しなければ追加
	for id := range activeNoteIDs {
		if !topLevelSeen["note:"+id] {
			if missingFileIDs[id] {
				continue
			}
			inFolder := false
			for _, m := range s.noteList.Notes {
				if m.ID == id && m.FolderID != "" {
					inFolder = true
					break
				}
			}
			if !inFolder {
				logRepair("TopLevelOrder: added missing note %s", id)
				s.noteList.TopLevelOrder = append(s.noteList.TopLevelOrder, TopLevelItem{Type: "note", ID: id})
				changed = true
			}
		}
	}
	for id := range activeFolderIDs {
		if !topLevelSeen["folder:"+id] {
			logRepair("TopLevelOrder: added missing folder %s", id)
			s.noteList.TopLevelOrder = append(s.noteList.TopLevelOrder, TopLevelItem{Type: "folder", ID: id})
			changed = true
		}
	}

	// 6. アーカイブノート/フォルダがArchivedTopLevelOrderに存在しなければ追加
	for id := range archivedNoteIDs {
		if !archivedSeen["note:"+id] {
			if missingFileIDs[id] {
				continue
			}
			inArchivedFolder := false
			for _, m := range s.noteList.Notes {
				if m.ID == id && m.FolderID != "" && archivedFolderIDs[m.FolderID] {
					inArchivedFolder = true
					break
				}
			}
			if !inArchivedFolder {
				logRepair("ArchivedTopLevelOrder: added missing note %s", id)
				s.noteList.ArchivedTopLevelOrder = append(s.noteList.ArchivedTopLevelOrder, TopLevelItem{Type: "note", ID: id})
				changed = true
			}
		}
	}
	for id := range archivedFolderIDs {
		if !archivedSeen["folder:"+id] {
			logRepair("ArchivedTopLevelOrder: added missing folder %s", id)
			s.noteList.ArchivedTopLevelOrder = append(s.noteList.ArchivedTopLevelOrder, TopLevelItem{Type: "folder", ID: id})
			changed = true
		}
	}

	// 6.5. 未来のModifiedTimeを検出（ユーザー確認が必要）
	futureThreshold := time.Now().Add(2 * time.Minute)
	for _, metadata := range s.noteList.Notes {
		parsedTime, parseErr := time.Parse(time.RFC3339, metadata.ModifiedTime)
		if parseErr != nil {
			continue
		}
		if parsedTime.After(futureThreshold) {
			issues = append(issues, IntegrityIssue{
				ID:                "future_time:" + metadata.ID,
				Kind:              "future_modified_time",
				Severity:          "warn",
				NeedsUserDecision: true,
				NoteIDs:           []string{metadata.ID},
				Summary:           fmt.Sprintf("Future modified time: %s", metadata.ID),
				FixOptions: []IntegrityFixOption{
					{
						ID:          "normalize",
						Label:       "Normalize",
						Description: "Set to now",
						Params:      map[string]string{"noteId": metadata.ID},
					},
					{
						ID:          "keep",
						Label:       "Keep",
						Description: "Keep as-is",
						Params:      map[string]string{"noteId": metadata.ID},
					},
				},
			})
		}
	}

	// 7. 存在しないフォルダを参照しているノートをトップレベルに移動
	{
		orphanCount := 0
		for i, m := range s.noteList.Notes {
			if m.FolderID == "" {
				continue
			}
			if !activeFolderIDs[m.FolderID] && !archivedFolderIDs[m.FolderID] {
				logRepair("Orphaned folder ref: note %s referenced non-existent folder %s", m.ID, m.FolderID)
				s.noteList.Notes[i].FolderID = ""
				if !m.Archived && !topLevelSeen["note:"+m.ID] {
					s.noteList.TopLevelOrder = append(s.noteList.TopLevelOrder, TopLevelItem{Type: "note", ID: m.ID})
					topLevelSeen["note:"+m.ID] = true
				} else if m.Archived && !archivedSeen["note:"+m.ID] {
					s.noteList.ArchivedTopLevelOrder = append(s.noteList.ArchivedTopLevelOrder, TopLevelItem{Type: "note", ID: m.ID})
					archivedSeen["note:"+m.ID] = true
				}
				orphanCount++
				changed = true
			}
		}
		if orphanCount > 0 {
			logRepair("Moved %d notes from non-existent folders to top level", orphanCount)
		}
	}

	// 8. ContentHash が空のノートは再計算（ファイルが存在する場合のみ）
	for i, metadata := range s.noteList.Notes {
		if metadata.ContentHash != "" {
			continue
		}
		note, loadErr := s.LoadNote(metadata.ID)
		if loadErr != nil {
			s.logConsole("Integrity check: skipping hash rebuild for %s (file missing)", metadata.ID)
			continue
		}
		newHash := computeContentHash(note)
		if newHash == "" {
			continue
		}
		s.noteList.Notes[i].ContentHash = newHash
		logRepair("ContentHash: rebuilt %s", metadata.ID)
		changed = true
	}

	// 9. conflict copy の自動解決（重複ハッシュのみ削除）
	resolution := s.autoResolveConflictCopies()
	if resolution.changed {
		changed = true
	}

	if changed {
		if len(repairLogs) == 0 {
			s.logInfo("Integrity check: repaired note list")
		}
		if saveErr := s.saveNoteList(); saveErr != nil {
			return changed, saveErr
		}
	}

	if len(issues) > 0 {
		s.logInfo("Integrity check: %d issue(s) need confirmation", len(issues))
		s.pendingIntegrityIssues = issues
	} else {
		s.pendingIntegrityIssues = nil
	}

	return changed, nil
}

// pendingの整合性問題を取り出す（1回限り）
func (s *noteService) DrainPendingIntegrityIssues() []IntegrityIssue {
	if len(s.pendingIntegrityIssues) == 0 {
		return nil
	}
	issues := s.pendingIntegrityIssues
	s.pendingIntegrityIssues = nil
	return issues
}

// conflict copy を自動解決する（同一ハッシュの重複のみ削除）
func (s *noteService) autoResolveConflictCopies() conflictCopyResolution {
	result := conflictCopyResolution{}
	if s.noteList == nil || len(s.noteList.Notes) == 0 {
		return result
	}

	type noteInfo struct {
		id         string
		hash       string
		title      string
		modifiedAt time.Time
		isConflict bool
	}

	noteInfos := make([]noteInfo, 0, len(s.noteList.Notes))
	for _, metadata := range s.noteList.Notes {
		hash := ""
		note, err := s.LoadNote(metadata.ID)
		if err == nil {
			hash = computeConflictCopyDedupHash(note)
		}
		modifiedAt, _ := time.Parse(time.RFC3339, metadata.ModifiedTime)
		noteInfos = append(noteInfos, noteInfo{
			id:         metadata.ID,
			hash:       hash,
			title:      metadata.Title,
			modifiedAt: modifiedAt,
			isConflict: isConflictCopyTitle(metadata.Title),
		})
	}

	notesByHash := make(map[string][]noteInfo)
	for _, info := range noteInfos {
		if info.hash == "" {
			continue
		}
		notesByHash[info.hash] = append(notesByHash[info.hash], info)
	}

	deleteIDs := make(map[string]string)
	keepIDs := make(map[string]bool)

	for _, group := range notesByHash {
		if len(group) == 1 {
			if group[0].isConflict {
				keepIDs[group[0].id] = true
			}
			continue
		}

		var nonConflict []noteInfo
		var conflicts []noteInfo
		for _, info := range group {
			if info.isConflict {
				conflicts = append(conflicts, info)
			} else {
				nonConflict = append(nonConflict, info)
			}
		}

		if len(conflicts) == 0 {
			continue
		}

		var keeper *noteInfo
		if len(nonConflict) > 0 {
			best := nonConflict[0]
			for i := 1; i < len(nonConflict); i++ {
				if nonConflict[i].modifiedAt.After(best.modifiedAt) {
					best = nonConflict[i]
				}
			}
			keeper = &best
		} else {
			best := conflicts[0]
			for i := 1; i < len(conflicts); i++ {
				if conflicts[i].modifiedAt.After(best.modifiedAt) {
					best = conflicts[i]
				}
			}
			keeper = &best
			keepIDs[keeper.id] = true
		}

		for _, conflict := range conflicts {
			if keeper != nil && conflict.id == keeper.id {
				continue
			}
			if deleteIDs[conflict.id] == "" {
				duplicateOf := ""
				if keeper != nil {
					duplicateOf = keeper.id
				}
				deleteIDs[conflict.id] = duplicateOf
			}
		}
	}

	if len(deleteIDs) == 0 && len(keepIDs) == 0 {
		return result
	}

	if s.logger != nil {
		for id, duplicateOf := range deleteIDs {
			if duplicateOf != "" {
				s.logger.Info("Auto-resolve conflict copy: deleted %s (duplicate of %s)", id, duplicateOf)
			} else {
				s.logger.Info("Auto-resolve conflict copy: deleted %s (duplicate)", id)
			}
		}
		for id := range keepIDs {
			if _, deleted := deleteIDs[id]; deleted {
				continue
			}
			s.logger.Info("Auto-resolve conflict copy: kept %s (unique content)", id)
		}
	}

	if len(deleteIDs) == 0 {
		return result
	}

	// ファイル削除 + noteListから除去
	for id := range deleteIDs {
		notePath := filepath.Join(s.notesDir, id+".json")
		if err := os.Remove(notePath); err != nil && !os.IsNotExist(err) {
			s.logConsole("Auto-resolve conflict copy: failed to delete file %s: %v", id, err)
		}
		s.removeFromTopLevelOrder(id)
		s.removeFromArchivedTopLevelOrder(id)
		result.deleted = append(result.deleted, id)
		result.changed = true
	}

	if result.changed {
		var remaining []NoteMetadata
		for _, metadata := range s.noteList.Notes {
			if _, shouldDelete := deleteIDs[metadata.ID]; shouldDelete {
				continue
			}
			remaining = append(remaining, metadata)
		}
		s.noteList.Notes = remaining
	}

	for id := range keepIDs {
		result.kept = append(result.kept, id)
	}

	return result
}

// 整合性修復の選択を適用する ------------------------------------------------------------
func (s *noteService) ApplyIntegrityFixes(selections []IntegrityFixSelection) (IntegrityRepairSummary, error) {
	summary := IntegrityRepairSummary{}
	if len(selections) == 0 {
		return summary, nil
	}

	noteIDSet := make(map[string]bool)
	for _, metadata := range s.noteList.Notes {
		noteIDSet[metadata.ID] = true
	}

	logApply := func(message string) {
		summary.Messages = append(summary.Messages, message)
		if s.logger != nil {
			s.logger.Info("Integrity repair: %s", message)
		}
	}

	now := time.Now().Format(time.RFC3339)

	for _, selection := range selections {
		parts := strings.SplitN(selection.IssueID, ":", 2)
		if len(parts) != 2 {
			summary.Skipped++
			continue
		}
		issueKind := parts[0]
		noteID := parts[1]

		switch issueKind {
		case "orphan_file":
			switch selection.FixID {
			case "restore":
				if noteIDSet[noteID] {
					summary.Skipped++
					continue
				}
				note, loadErr := s.LoadNote(noteID)
				if loadErr != nil {
					summary.Errors++
					s.logConsole("Integrity repair: failed to load orphan file %s: %v", noteID, loadErr)
					continue
				}

				s.noteList.Notes = append(s.noteList.Notes, NoteMetadata{
					ID:            note.ID,
					Title:         note.Title,
					ContentHeader: note.ContentHeader,
					Language:      note.Language,
					ModifiedTime:  note.ModifiedTime,
					Archived:      note.Archived,
					ContentHash:   computeContentHash(note),
					FolderID:      note.FolderID,
				})

				if note.FolderID == "" && !note.Archived {
					s.ensureTopLevelOrder()
					s.noteList.TopLevelOrder = append([]TopLevelItem{{Type: "note", ID: note.ID}}, s.noteList.TopLevelOrder...)
				} else if note.Archived {
					s.ensureArchivedTopLevelOrder()
					s.noteList.ArchivedTopLevelOrder = append(
						s.noteList.ArchivedTopLevelOrder,
						TopLevelItem{Type: "note", ID: note.ID},
					)
				}

				noteIDSet[noteID] = true
				logApply(fmt.Sprintf("Unknown file restored: %s", noteID))
				summary.Applied++

			case "delete":
				notePath := filepath.Join(s.notesDir, noteID+".json")
				if rmErr := os.Remove(notePath); rmErr != nil {
					summary.Errors++
					s.logConsole("Integrity repair: failed to delete file %s: %v", noteID, rmErr)
					continue
				}
				logApply(fmt.Sprintf("Unknown file deleted: %s", noteID))
				summary.Applied++

			default:
				summary.Skipped++
			}

		case "future_time":
			if selection.FixID != "normalize" {
				summary.Skipped++
				continue
			}
			note, loadErr := s.LoadNote(noteID)
			if loadErr != nil {
				summary.Errors++
				s.logConsole("Integrity repair: failed to load note %s for time normalization: %v", noteID, loadErr)
				continue
			}
			note.ModifiedTime = now
			if err := s.SaveNoteFromSync(note); err != nil {
				summary.Errors++
				s.logConsole("Integrity repair: failed to save note %s after time normalization: %v", noteID, err)
				continue
			}
			for i := range s.noteList.Notes {
				if s.noteList.Notes[i].ID == noteID {
					s.noteList.Notes[i].ModifiedTime = now
					break
				}
			}
			logApply(fmt.Sprintf("Modified time normalized: %s", noteID))
			summary.Applied++

		default:
			summary.Skipped++
		}
	}

	if summary.Applied > 0 {
		if err := s.saveNoteList(); err != nil {
			return summary, err
		}
	}

	return summary, nil
}
