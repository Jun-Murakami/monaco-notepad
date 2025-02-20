package backend

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// ファイルノートのメタデータ
type FileNote struct {
	ID              string `json:"id"`
	FilePath        string `json:"filePath"`
	FileName        string `json:"fileName"`
	Content         string `json:"content"`
	OriginalContent string `json:"originalContent"`
	Language        string `json:"language"`
	ModifiedTime    string `json:"modifiedTime"`
}

// ファイルノートの操作
type FileNotesService interface {
	LoadFileNotes() ([]FileNote, error)
	SaveFileNotes(list []FileNote) (string, error)
}

// ファイルノートの操作
type fileNoteService struct {
	appDataDir string
}

// 新しいファイルノートサービスインスタンスを作成
func NewFileNoteService(appDataDir string) *fileNoteService {
	return &fileNoteService{
		appDataDir: appDataDir,
	}
}

// ファイルノートを読み込む
func (s *fileNoteService) LoadFileNotes() ([]FileNote, error) {
	fileNotesPath := filepath.Join(s.appDataDir, "fileNotes.json")

	// If file doesn't exist, return empty list
	if _, err := os.Stat(fileNotesPath); os.IsNotExist(err) {
		return []FileNote{}, nil
	}

	data, err := os.ReadFile(fileNotesPath)
	if err != nil {
		return nil, err
	}

	var list []FileNote
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, err
	}

	return list, nil
}

// ファイルノートを保存する
func (s *fileNoteService) SaveFileNotes(list []FileNote) (string, error) {
	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return "", err
	}

	fileNotesPath := filepath.Join(s.appDataDir, "fileNotes.json")
	if err := os.WriteFile(fileNotesPath, data, 0644); err != nil {
		return "", err
	}

	return fileNotesPath, nil
}
