package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type Note struct {
    ID           string    `json:"id"`
    Title        string    `json:"title"`
    Content      string    `json:"content"`
    ContentHeader string   `json:"contentHeader"`
    Language     string    `json:"language"`
    ModifiedTime time.Time `json:"modifiedTime"`
    Archived     bool      `json:"archived"`
}

type NoteMetadata struct {
    ID           string    `json:"id"`
    Title        string    `json:"title"`
    ContentHeader string   `json:"contentHeader"`
    Language     string    `json:"language"`
    ModifiedTime time.Time `json:"modifiedTime"`
    Archived     bool      `json:"archived"`
}

type NoteList struct {
    Version   string         `json:"version"`
    Notes     []NoteMetadata `json:"notes"`
    LastSync  time.Time      `json:"lastSync"`
}

type Settings struct {
    FontFamily string `json:"fontFamily"`
    FontSize   int    `json:"fontSize"`
    IsDarkMode bool   `json:"isDarkMode"`
    WordWrap   string `json:"wordWrap"`
    Minimap    bool   `json:"minimap"`
    WindowWidth  int  `json:"windowWidth"`
    WindowHeight int  `json:"windowHeight"`
    WindowX      int  `json:"windowX"`
    WindowY      int  `json:"windowY"`
    IsMaximized  bool `json:"isMaximized"`
}

type Context struct {
	ctx context.Context
	skipBeforeClose bool
}

func NewContext(ctx context.Context) *Context {
	return &Context{
		ctx: ctx,
		skipBeforeClose: false,
	}
}

func (c *Context) SkipBeforeClose(skip bool) {
	c.skipBeforeClose = skip
}

func (c *Context) ShouldSkipBeforeClose() bool {
	return c.skipBeforeClose
}

// App struct
type App struct {
	ctx *Context
	appDataDir string
	notesDir   string
	noteList   *NoteList
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{
		ctx: NewContext(context.Background()),
	}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx.ctx = ctx
	
	// アプリケーションデータディレクトリの設定
	appData, err := os.UserConfigDir()
	if err != nil {
		appData, err = os.UserHomeDir()
		if err != nil {
			appData = "."
		}
	}
	
	a.appDataDir = filepath.Join(appData, "monaco-notepad")
	a.notesDir = filepath.Join(a.appDataDir, "notes")
	
	// ディレクトリの作成
	os.MkdirAll(a.notesDir, 0755)

	// ノートリストの読み込みと同期
	if err := a.loadAndSyncNoteList(); err != nil {
		// エラーログ
		fmt.Printf("Error loading note list: %v\n", err)
	}
}

func (a *App) SelectFile() (string, error) {
    file, err := wailsRuntime.OpenFileDialog(a.ctx.ctx, wailsRuntime.OpenDialogOptions{
        Title: "Please select a file.",
        Filters: []wailsRuntime.FileFilter{
            {
                DisplayName: "All Files (*.*)",
                Pattern:     "*.*",
            },
        },
    })
    if err != nil {
        return "", err
    }
    return file, nil
}

// OpenFile reads the content of a file
func (a *App) OpenFile(filePath string) (string, error) {
	content, err := os.ReadFile(filePath)
	if err != nil {
		return "", err
	}
	return string(content), nil
}

func (a *App) SelectSaveFileUri(fileName string, extension string) (string, error) {
    defaultFileName := fmt.Sprintf("%s.%s", fileName, extension)
    file, err := wailsRuntime.SaveFileDialog(a.ctx.ctx, wailsRuntime.SaveDialogOptions{
        Title: "Please select export file path.",
        DefaultFilename: defaultFileName,
        Filters: []wailsRuntime.FileFilter{
            {
                DisplayName: "All Files (*.*)",
                Pattern:     "*." + extension,
            },
        },
    })
    if err != nil {
        return "", err
    }
    return file, nil
}

// SaveFile writes content to a file
func (a *App) SaveFile(filePath string, content string) error {
	return os.WriteFile(filePath, []byte(content), 0644)
}

// loadAndSyncNoteList loads and synchronizes the note list with the actual files
func (a *App) loadAndSyncNoteList() error {
	noteListPath := filepath.Join(a.appDataDir, "noteList.json")
	
	// ノートリストファイルが存在しない場合は新規作成
	if _, err := os.Stat(noteListPath); os.IsNotExist(err) {
		a.noteList = &NoteList{
			Version:  "1.0",
			Notes:    []NoteMetadata{},
			LastSync: time.Now(),
		}
		return a.saveNoteList()
	}
	
	// 既存のノートリストを読み込む
	data, err := os.ReadFile(noteListPath)
	if err != nil {
		return err
	}
	
	if err := json.Unmarshal(data, &a.noteList); err != nil {
		return err
	}

	// 物理ファイルとの同期
	return a.syncNoteList()
}

// syncNoteList synchronizes the note list with physical files
func (a *App) syncNoteList() error {
	// 物理ファイルの一覧を取得
	files, err := os.ReadDir(a.notesDir)
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
		for _, metadata := range a.noteList.Notes {
			if metadata.ID == noteID {
				found = true
				break
			}
		}

		if !found {
			// 物理ファイルからメタデータを読み込む
			note, err := a.LoadNote(noteID)
			if err != nil {
				continue
			}
			a.noteList.Notes = append(a.noteList.Notes, NoteMetadata{
				ID:           note.ID,
				Title:        note.Title,
				ContentHeader: note.ContentHeader,
				Language:     note.Language,
				ModifiedTime: note.ModifiedTime,
				Archived:     note.Archived,
			})
		}
	}

	// リストから存在しないノートを削除
	var validNotes []NoteMetadata
	for _, metadata := range a.noteList.Notes {
		if physicalNotes[metadata.ID] {
			validNotes = append(validNotes, metadata)
		}
	}
	a.noteList.Notes = validNotes
	a.noteList.LastSync = time.Now()

	return a.saveNoteList()
}

// saveNoteList saves the note list to disk
func (a *App) saveNoteList() error {
	data, err := json.MarshalIndent(a.noteList, "", "  ")
	if err != nil {
		return err
	}
	
	noteListPath := filepath.Join(a.appDataDir, "noteList.json")
	return os.WriteFile(noteListPath, data, 0644)
}

// LoadSettings loads application settings from settings.json
func (a *App) LoadSettings() (*Settings, error) {
	settingsPath := filepath.Join(a.appDataDir, "settings.json")
	
	// ファイルが存在しない場合はデフォルト設定を返す
	if _, err := os.Stat(settingsPath); os.IsNotExist(err) {
		return &Settings{
			FontFamily: "Consolas, Monaco, \"Courier New\", monospace",
			FontSize:   14,
			IsDarkMode: false,
			WordWrap:   "off",
			Minimap:    true,
			WindowWidth:  800,
			WindowHeight: 600,
			WindowX:      0,
			WindowY:      0,
			IsMaximized:  false,
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
	
	return &settings, nil
}

// SaveSettings saves application settings to settings.json
func (a *App) SaveSettings(settings *Settings) error {
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	
	settingsPath := filepath.Join(a.appDataDir, "settings.json")
	return os.WriteFile(settingsPath, data, 0644)
}

// LoadNote loads a note from the notes directory
func (a *App) LoadNote(id string) (*Note, error) {
	notePath := filepath.Join(a.notesDir, id + ".json")
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

// SaveNote saves a note to the notes directory and updates the note list
func (a *App) SaveNote(note *Note) error {
	data, err := json.MarshalIndent(note, "", "  ")
	if err != nil {
		return err
	}
	
	notePath := filepath.Join(a.notesDir, note.ID + ".json")
	if err := os.WriteFile(notePath, data, 0644); err != nil {
		return err
	}

	// ノートリストの更新
	found := false
	for i, metadata := range a.noteList.Notes {
		if metadata.ID == note.ID {
			a.noteList.Notes[i] = NoteMetadata{
				ID:           note.ID,
				Title:        note.Title,
				ContentHeader: note.ContentHeader,
				Language:     note.Language,
				ModifiedTime: note.ModifiedTime,
				Archived:     note.Archived,
			}
			found = true
			break
		}
	}

	if !found {
		a.noteList.Notes = append(a.noteList.Notes, NoteMetadata{
			ID:           note.ID,
			Title:        note.Title,
			ContentHeader: note.ContentHeader,
			Language:     note.Language,
			ModifiedTime: note.ModifiedTime,
			Archived:     note.Archived,
		})
	}

	return a.saveNoteList()
}

// ListNotes returns a list of all notes with optional content loading
func (a *App) ListNotes() ([]Note, error) {
	var notes []Note
	
	for _, metadata := range a.noteList.Notes {
		if metadata.Archived {
			// アーカイブされたノートはコンテンツを読み込まない
			notes = append(notes, Note{
				ID:           metadata.ID,
				Title:        metadata.Title,
				Content:      "",  // コンテンツは空
				ContentHeader: metadata.ContentHeader,
				Language:     metadata.Language,
				ModifiedTime: metadata.ModifiedTime,
				Archived:     true,
			})
		} else {
			// アクティブなノートはコンテンツを読み込む
			note, err := a.LoadNote(metadata.ID)
			if err != nil {
				continue
			}
			notes = append(notes, *note)
		}
	}
	
	return notes, nil
}

// DeleteNote deletes a note from both the filesystem and the note list
func (a *App) DeleteNote(id string) error {
	notePath := filepath.Join(a.notesDir, id + ".json")
	if err := os.Remove(notePath); err != nil && !os.IsNotExist(err) {
		return err
	}

	// ノートリストから削除
	var updatedNotes []NoteMetadata
	for _, metadata := range a.noteList.Notes {
		if metadata.ID != id {
			updatedNotes = append(updatedNotes, metadata)
		}
	}
	a.noteList.Notes = updatedNotes

	return a.saveNoteList()
}

// LoadArchivedNote loads the content of an archived note
func (a *App) LoadArchivedNote(id string) (*Note, error) {
	return a.LoadNote(id)
}

// BeforeClose is called when the application is about to quit
func (a *App) BeforeClose(ctx context.Context) (prevent bool) {
  if a.ctx.ShouldSkipBeforeClose() {
    return false
  }

  // イベントを発行して、フロントエンドに保存を要求
  wailsRuntime.EventsEmit(ctx, "app:beforeclose")

  // ウィンドウの状態を保存
  settings, err := a.LoadSettings()
  if err != nil {
    return false
  }

  width, height := wailsRuntime.WindowGetSize(a.ctx.ctx)
  settings.WindowWidth = width
  settings.WindowHeight = height

  x, y := wailsRuntime.WindowGetPosition(a.ctx.ctx)
  settings.WindowX = x
  settings.WindowY = y

  maximized := wailsRuntime.WindowIsMaximised(a.ctx.ctx)
  settings.IsMaximized = maximized

  if err := a.SaveSettings(settings); err != nil {
    return false
  }

  return true
}

func (a *App) DestroyApp() {
	fmt.Println("DestroyApp")
	// BeforeCloseイベントをスキップしてアプリケーションを終了
	a.ctx.SkipBeforeClose(true)
	wailsRuntime.Quit(a.ctx.ctx)
}

