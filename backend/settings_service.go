package backend

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	defaultEditorFontFamily = "\"Cascadia Mono\", \"Cascadia Code\", Consolas, \"BIZ UDGothic\", \"Yu Gothic UI\", \"Meiryo UI\", Meiryo, \"MS Gothic\", Monaco, \"Courier New\", monospace"
	legacyEditorFontFamily  = "Consolas, Monaco, \"Courier New\", monospace"
)

// SettingsService は設定関連の操作を提供するインターフェースです
type SettingsService interface {
	LoadSettings() (*Settings, error)
	SaveSettings(settings *Settings) error
	SaveWindowState(ctx *Context) error
}

// settingsService はSettingsServiceの実装です
type settingsService struct {
	appDataDir string
}

// NewSettingsService は新しいsettingsServiceインスタンスを作成します
func NewSettingsService(appDataDir string) *settingsService {
	return &settingsService{
		appDataDir: appDataDir,
	}
}

// LoadSettings はsettings.jsonから設定を読み込みます
// ファイルが存在しない場合はデフォルト設定を返します
func (s *settingsService) LoadSettings() (*Settings, error) {
	settingsPath := filepath.Join(s.appDataDir, "settings.json")

	// ファイルが存在しない場合はデフォルト設定を返す
	if _, err := os.Stat(settingsPath); os.IsNotExist(err) {
		return &Settings{
			FontFamily:           defaultEditorFontFamily,
			FontSize:             14,
			IsDarkMode:           false,
			EditorTheme:          "default",
			WordWrap:             "off",
			Minimap:              true,
			WindowWidth:          800,
			WindowHeight:         600,
			WindowX:              0,
			WindowY:              0,
			IsMaximized:          false,
			IsDebug:              false,
			EnableConflictBackup: true,
			UILanguage:           LocaleSystem,
		}, nil
	}

	data, err := os.ReadFile(settingsPath)
	if err != nil {
		return nil, err
	}

	var settings Settings
	if err := json.Unmarshal(data, &settings); err != nil {
		return nil, err
	}

	// 旧既定値・未設定値を新しい既定フォントへ寄せる
	if strings.TrimSpace(settings.FontFamily) == "" ||
		settings.FontFamily == legacyEditorFontFamily {
		settings.FontFamily = defaultEditorFontFamily
	}

	// 古いsettings.jsonでenableConflictBackupが未定義の場合は既定値(true)を適用する
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		settings.EnableConflictBackup = true
	} else if _, exists := raw["enableConflictBackup"]; !exists {
		settings.EnableConflictBackup = true
	}

	// デバッグモードを設定
	return &settings, nil
}

// SaveSettings は設定をsettings.jsonに保存します
func (s *settingsService) SaveSettings(settings *Settings) error {
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}

	settingsPath := filepath.Join(s.appDataDir, "settings.json")
	return os.WriteFile(settingsPath, data, 0644)
}

// SaveWindowState はウィンドウの状態を保存します
func (s *settingsService) SaveWindowState(ctx *Context) error {
	settings, err := s.LoadSettings()
	if err != nil {
		return err
	}

	width, height := wailsRuntime.WindowGetSize(ctx.ctx)
	settings.WindowWidth = width
	settings.WindowHeight = height

	x, y := wailsRuntime.WindowGetPosition(ctx.ctx)
	settings.WindowX = x
	settings.WindowY = y

	maximized := wailsRuntime.WindowIsMaximised(ctx.ctx)
	settings.IsMaximized = maximized

	return s.SaveSettings(settings)
}
