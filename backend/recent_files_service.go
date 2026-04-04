package backend

import (
	"encoding/json"
	"os"
	"path/filepath"
)

const maxRecentFiles = 20

// 最近開いたファイルの操作
type recentFilesService struct {
	appDataDir string
}

// 新しい最近開いたファイルサービスインスタンスを作成
func NewRecentFilesService(appDataDir string) *recentFilesService {
	return &recentFilesService{
		appDataDir: appDataDir,
	}
}

// 最近開いたファイルのリストを読み込む
func (s *recentFilesService) LoadRecentFiles() ([]string, error) {
	recentFilesPath := filepath.Join(s.appDataDir, "recentFiles.json")

	if _, err := os.Stat(recentFilesPath); os.IsNotExist(err) {
		return []string{}, nil
	}

	data, err := os.ReadFile(recentFilesPath)
	if err != nil {
		return nil, err
	}

	var list []string
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, err
	}

	return list, nil
}

// 最近開いたファイルのリストを保存する
func (s *recentFilesService) SaveRecentFiles(list []string) error {
	// 最大件数を超えた場合は切り詰める
	if len(list) > maxRecentFiles {
		list = list[:maxRecentFiles]
	}

	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}

	recentFilesPath := filepath.Join(s.appDataDir, "recentFiles.json")
	return os.WriteFile(recentFilesPath, data, 0644)
}
