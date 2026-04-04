package backend

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/transform"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// OpenFileResult はファイル読み込み結果を表します
type OpenFileResult struct {
	Content        string `json:"content"`
	SourceEncoding string `json:"sourceEncoding"`
}

// FileService はファイル操作関連の機能を提供するインターフェースです
type FileService interface {
	SelectFile() (string, error)
	OpenFile(filePath string) (*OpenFileResult, error)
	SelectSaveFileUri(fileName string, extension string) (string, error)
	SaveFile(filePath string, content string) error
	GetModifiedTime(filePath string) (string, error)
	CheckFileExists(path string) bool
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
// UTF-8以外のエンコーディングを検出した場合、自動的にUTF-8に変換します
func (s *fileService) OpenFile(filePath string) (*OpenFileResult, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}
	content, encoding := detectAndConvertEncoding(data)
	return &OpenFileResult{Content: content, SourceEncoding: encoding}, nil
}

// detectAndConvertEncoding はバイト列のエンコーディングを検出し、必要に応じてUTF-8に変換します
func detectAndConvertEncoding(data []byte) (string, string) {
	// UTF-8 BOM を検出して除去
	if bytes.HasPrefix(data, []byte{0xEF, 0xBB, 0xBF}) {
		return string(data[3:]), ""
	}

	// 有効なUTF-8ならそのまま返す
	if utf8.Valid(data) {
		return string(data), ""
	}

	// ShiftJIS (CP932) として変換を試みる
	reader := transform.NewReader(bytes.NewReader(data), japanese.ShiftJIS.NewDecoder())
	decoded, err := io.ReadAll(reader)
	if err == nil {
		return string(decoded), "Shift_JIS"
	}

	// 変換に失敗した場合はそのまま返す（文字化けの可能性あり）
	return string(data), ""
}

// SelectSaveFileUri は保存ダイアログを表示し、選択された保存先のパスを返します
func (s *fileService) SelectSaveFileUri(fileName string, extension string) (string, error) {
	defaultFileName, pattern := buildSaveDialogDefaults(fileName, extension)

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

// buildSaveDialogDefaults は保存ダイアログ用の既定ファイル名とフィルタを組み立てる
func buildSaveDialogDefaults(fileName string, extension string) (string, string) {
	trimmedName := strings.TrimSpace(fileName)
	trimmedExt := strings.TrimSpace(extension)
	trimmedExt = strings.TrimPrefix(trimmedExt, ".")

	if trimmedExt == "" {
		if trimmedName == "" {
			return "untitled", "*.*"
		}
		return trimmedName, "*.*"
	}

	if trimmedName == "" {
		return fmt.Sprintf("untitled.%s", trimmedExt), "*." + trimmedExt
	}

	lowerName := strings.ToLower(trimmedName)
	lowerExt := strings.ToLower(trimmedExt)
	if strings.HasSuffix(lowerName, "."+lowerExt) {
		return trimmedName, "*." + trimmedExt
	}

	return fmt.Sprintf("%s.%s", trimmedName, trimmedExt), "*." + trimmedExt
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

// CheckFileExists は指定されたパスのファイルが存在するかチェックします
func (s *fileService) CheckFileExists(path string) bool {
	_, err := os.Stat(path)
	return !os.IsNotExist(err)
}

func (s *fileService) OpenFolder(path string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", path).Start()
	case "windows":
		return exec.Command("cmd", "/c", "start", "", path).Start()
	default:
		return exec.Command("xdg-open", path).Start()
	}
}
