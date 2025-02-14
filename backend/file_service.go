package backend

import (
	"fmt"
	"os"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// FileService はファイル操作関連の機能を提供するインターフェースです
type FileService interface {
	SelectFile() (string, error)
	OpenFile(filePath string) (string, error)
	SelectSaveFileUri(fileName string, extension string) (string, error)
	SaveFile(filePath string, content string) error
	GetModifiedTime(filePath string) (string, error)
}

// fileService はFileServiceの実装です
type fileService struct {
	ctx *Context
}

// NewFileService は新しいfileServiceインスタンスを作成します
func NewFileService(ctx *Context) *fileService {
	return &fileService{
		ctx: ctx,
	}
}

// SelectFile はファイル選択ダイアログを表示し、選択されたファイルのパスを返します
func (s *fileService) SelectFile() (string, error) {
	file, err := wailsRuntime.OpenFileDialog(s.ctx.ctx, wailsRuntime.OpenDialogOptions{
		Title: "Please select a file.",
		Filters: []wailsRuntime.FileFilter{
			{
				DisplayName: "All Files (*.*)",
				Pattern:     "",
			},
		},
	})
	if err != nil {
		return "", err
	}
	return file, nil
}

// OpenFile は指定されたパスのファイルの内容を読み込みます
func (s *fileService) OpenFile(filePath string) (string, error) {
	content, err := os.ReadFile(filePath)
	if err != nil {
		return "", err
	}
	return string(content), nil
}

// SelectSaveFileUri は保存ダイアログを表示し、選択された保存先のパスを返します
func (s *fileService) SelectSaveFileUri(fileName string, extension string) (string, error) {
	var defaultFileName string
	var pattern string

	if extension == "" {
		defaultFileName = fileName
		pattern = "*.*"
	} else {
		defaultFileName = fmt.Sprintf("%s.%s", fileName, extension)
		pattern = "*." + extension
	}

	file, err := wailsRuntime.SaveFileDialog(s.ctx.ctx, wailsRuntime.SaveDialogOptions{
		Title:           "Please select export file path.",
		DefaultFilename: defaultFileName,
		Filters: []wailsRuntime.FileFilter{
			{
				DisplayName: "All Files (*.*)",
				Pattern:     pattern,
			},
		},
	})
	if err != nil {
		return "", err
	}
	return file, nil
}

// SaveFile は指定されたパスにコンテンツを保存します
func (s *fileService) SaveFile(filePath string, content string) error {
	return os.WriteFile(filePath, []byte(content), 0644)
}

// GetModifiedTime は指定されたパスのファイルの変更時間を取得します
func (s *fileService) GetModifiedTime(filePath string) (time.Time, error) {
	info, err := os.Stat(filePath)
	if err != nil {
		return time.Time{}, err
	}
	return info.ModTime(), nil
}

// ファイルが変更されているかチェック
func (s *fileService) CheckFileModified(filePath string, lastModifiedTime string) (bool, error) {
	info, err := os.Stat(filePath)
	if err != nil {
		return false, err
	}
	lastModified, err := time.Parse(time.RFC3339, lastModifiedTime)
	if err != nil {
		return false, err
	}
	return info.ModTime().After(lastModified), nil
}
