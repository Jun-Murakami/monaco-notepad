package backend

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
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
			})
		} else {
			// アクティブなノートはコンテンツを読み込む
			note, err := s.LoadNote(metadata.ID)
			if err != nil {
				continue
			}
			notes = append(notes, *note)
			notes[len(notes)-1].Order = metadata.Order
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
	data, err := json.MarshalIndent(note, "", "  ")
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
			// 既存のメタデータを更新
			s.noteList.Notes[i] = NoteMetadata{
				ID:            note.ID,
				Title:         note.Title,
				ContentHeader: note.ContentHeader,
				Language:      note.Language,
				ModifiedTime:  note.ModifiedTime,
				Archived:      note.Archived,
				ContentHash:   contentHash,
				Order:         order,
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

		// 新規ノートをリストに追加
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

	s.noteList.LastSync = time.Now()

	return s.saveNoteList()
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

// ------------------------------------------------------------
// 内部ヘルパー
// ------------------------------------------------------------

// noteList内の重複するノートを削除し、最新のものだけを保持 ------------------------------------------------------------
func (s *noteService) deduplicateNoteList() {
	noteMap := make(map[string]NoteMetadata)
	for _, metadata := range s.noteList.Notes {

		existing, exists := noteMap[metadata.ID]
		if !exists || metadata.ModifiedTime.After(existing.ModifiedTime) {
			noteMap[metadata.ID] = metadata
		}
	}
	deduped := make([]NoteMetadata, 0, len(noteMap))
	for _, m := range noteMap {
		deduped = append(deduped, m)
	}
	s.noteList.Notes = deduped
}

// ノートリストをJSONファイルから読み込む ------------------------------------------------------------
func (s *noteService) loadNoteList() error {
	noteListPath := filepath.Join(filepath.Dir(s.notesDir), "noteList.json")

	// ノートリストファイルが存在しない場合は新規作成
	if _, err := os.Stat(noteListPath); os.IsNotExist(err) {
		fmt.Println("loadNoteList: noteList.json not found, creating new one")
		s.noteList = &NoteList{
			Version:  "1.0",
			Notes:    []NoteMetadata{},
			LastSync: time.Now(),
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

	// 読み込んだ後に重複削除を実施
	s.deduplicateNoteList()

	// ノートリストと物理ファイルの同期を行って返す
	return s.syncNoteList()
}

// ノートリストをJSONファイルとして保存 ------------------------------------------------------------
func (s *noteService) saveNoteList() error {
	data, err := json.MarshalIndent(s.noteList, "", "  ")
	if err != nil {
		return err
	}

	noteListPath := filepath.Join(filepath.Dir(s.notesDir), "noteList.json")
	return os.WriteFile(noteListPath, data, 0644)
}

// 物理ファイルとノートリストの同期 ------------------------------------------------------------
func (s *noteService) syncNoteList() error {
	// 物理ファイルの一覧を取得
	files, err := os.ReadDir(s.notesDir)
	if err != nil {
		return err
	}

	// 物理ファイルのマップを作成
	physicalNotes := make(map[string]bool)
	for _, file := range files {
		if filepath.Ext(file.Name()) != ".json" {
			continue
		}
		noteID := file.Name()[:len(file.Name())-5]
		physicalNotes[noteID] = true

		// リストに存在しないノートを追加
		found := false
		for _, metadata := range s.noteList.Notes {
			if metadata.ID == noteID {
				found = true
				break
			}
		}

		if !found {
			// 物理ファイルからメタデータを読み込む
			note, err := s.LoadNote(noteID)
			if err != nil {
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
		}
	}

	// リストから存在しないノートを削除
	var validNotes []NoteMetadata
	for _, metadata := range s.noteList.Notes {
		if physicalNotes[metadata.ID] {
			validNotes = append(validNotes, metadata)
		}
	}
	s.noteList.Notes = validNotes

	return s.saveNoteList()
}
