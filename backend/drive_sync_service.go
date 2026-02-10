package backend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"google.golang.org/api/drive/v3"
)

// DriveSyncService は抽象化されたノート操作を提供するインターフェース
type DriveSyncService interface {
	// ノート操作 ------------------------------------------------------------
	CreateNote(ctx context.Context, note *Note) error
	UpdateNote(ctx context.Context, note *Note) error
	UploadAllNotes(ctx context.Context, notes []NoteMetadata) error
	DownloadNote(ctx context.Context, noteID string) (*Note, error)
	DeleteNote(ctx context.Context, noteID string) error
	ListFiles(ctx context.Context, folderID string) ([]*drive.File, error)
	GetNoteID(ctx context.Context, noteID string) (string, error)
	RemoveDuplicateNoteFiles(ctx context.Context, files []*drive.File) error // 重複するノートファイルを削除
	RemoveNoteFromList(notes []NoteMetadata, noteID string) []NoteMetadata   // ノートリストから指定のノートを除外

	// ノートリスト操作 ------------------------------------------------------------
	CreateNoteList(ctx context.Context, noteList *NoteList) error
	UpdateNoteList(ctx context.Context, noteList *NoteList, noteListID string) error
	DownloadNoteList(ctx context.Context, noteListID string) (*NoteList, error)
	DownloadNoteListIfChanged(ctx context.Context, noteListID string) (*NoteList, bool, error)
	// クラウドのノートリストにないノートをリストアップ (ダウンロードオプション付き)
	ListUnknownNotes(ctx context.Context, cloudNoteList *NoteList, files []*drive.File, arrowDownload bool) (*NoteList, error)
	// クラウドに存在しないファイルをリストから除外して返す
	ListAvailableNotes(cloudNoteList *NoteList) (*NoteList, error)
	// 重複IDを持つノートを処理し、最新のものだけを保持
	DeduplicateNotes(notes []NoteMetadata) []NoteMetadata

	// キャッシュ操作 ------------------------------------------------------------
	RefreshFileIDCache(ctx context.Context) error // notes フォルダの files.list でキャッシュ再構築

	// テスト用メソッド ------------------------------------------------------------
	SetConnected(connected bool)
	SetInitialSyncCompleted(completed bool)
	SetCloudNoteList(noteList *NoteList)
	IsConnected() bool
	HasCompletedInitialSync() bool
}

// DriveSyncServiceの実装
type driveSyncServiceImpl struct {
	driveOps                DriveOperations
	notesFolderID           string
	rootFolderID            string
	isConnected             bool
	hasCompletedInitialSync bool
	cloudNoteList           *NoteList
	logger                  AppLogger
	fileIDCache             map[string]string
	cacheMu                 sync.RWMutex
	lastNoteListMd5         string
	cachedNoteList          *NoteList
}

// DriveSyncServiceインスタンスを作成
func NewDriveSyncService(
	driveOps DriveOperations,
	notesFolderID string,
	rootFolderID string,
	logger AppLogger,
) DriveSyncService {
	return &driveSyncServiceImpl{
		driveOps:      driveOps,
		notesFolderID: notesFolderID,
		rootFolderID:  rootFolderID,
		logger:        logger,
		fileIDCache:   make(map[string]string),
	}
}

func (d *driveSyncServiceImpl) getCachedFileID(noteID string) (string, bool) {
	d.cacheMu.RLock()
	defer d.cacheMu.RUnlock()
	id, ok := d.fileIDCache[noteID]
	return id, ok
}

func (d *driveSyncServiceImpl) setCachedFileID(noteID, driveFileID string) {
	d.cacheMu.Lock()
	defer d.cacheMu.Unlock()
	d.fileIDCache[noteID] = driveFileID
}

func (d *driveSyncServiceImpl) removeCachedFileID(noteID string) {
	d.cacheMu.Lock()
	defer d.cacheMu.Unlock()
	delete(d.fileIDCache, noteID)
}

func (d *driveSyncServiceImpl) resolveNoteFileID(noteID string) (string, error) {
	if cached, ok := d.getCachedFileID(noteID); ok {
		return cached, nil
	}

	var fileID string
	err := d.withRetry(func() error {
		var err error
		fileID, err = d.driveOps.GetFileID(noteID+".json", d.notesFolderID, d.rootFolderID)
		return err
	}, getFileIDRetryConfig)

	if err != nil {
		return "", err
	}
	d.setCachedFileID(noteID, fileID)
	return fileID, nil
}

func (d *driveSyncServiceImpl) RefreshFileIDCache(ctx context.Context) error {
	files, err := d.driveOps.ListFiles(
		fmt.Sprintf("'%s' in parents and trashed=false", d.notesFolderID))
	if err != nil {
		return fmt.Errorf("failed to refresh file ID cache: %w", err)
	}

	d.cacheMu.Lock()
	defer d.cacheMu.Unlock()
	d.fileIDCache = make(map[string]string, len(files))
	for _, f := range files {
		if strings.HasSuffix(f.Name, ".json") {
			noteID := strings.TrimSuffix(f.Name, ".json")
			d.fileIDCache[noteID] = f.Id
		}
	}
	d.logger.Console("File ID cache refreshed: %d entries", len(d.fileIDCache))
	return nil
}

// リトライ設定
type retryConfig struct {
	maxRetries  int
	baseDelay   time.Duration
	maxDelay    time.Duration
	shouldRetry func(error) bool
}

// デフォルトのリトライ設定
var defaultRetryConfig = &retryConfig{
	maxRetries: 3,
	baseDelay:  2 * time.Second,
	maxDelay:   30 * time.Second,
	shouldRetry: func(err error) bool {
		if err == nil {
			return false
		}
		// リトライ可能なエラーの条件
		return strings.Contains(err.Error(), "not found") ||
			strings.Contains(err.Error(), "connection") ||
			strings.Contains(err.Error(), "deadline exceeded")
	},
}

// リトライロジックを実行する汎用関数
func (d *driveSyncServiceImpl) withRetry(
	operation func() error,
	config *retryConfig,
) error {
	if config == nil {
		config = defaultRetryConfig
	}

	var lastErr error
	delay := config.baseDelay

	for i := 0; i < config.maxRetries; i++ {
		err := operation()
		if err == nil {
			return nil
		}

		lastErr = err
		if !config.shouldRetry(err) || i == config.maxRetries-1 {
			break
		}

		time.Sleep(delay)
		delay *= 2 // 指数バックオフ
		if delay > config.maxDelay {
			delay = config.maxDelay
		}
	}

	return lastErr
}

// ファイルID取得用のリトライ設定
var getFileIDRetryConfig = &retryConfig{
	maxRetries: 3,
	baseDelay:  1 * time.Second,
	maxDelay:   10 * time.Second,
	shouldRetry: func(err error) bool {
		return err != nil && strings.Contains(err.Error(), "not found")
	},
}

// ダウンロード用のリトライ設定
var downloadRetryConfig = &retryConfig{
	maxRetries: 5,
	baseDelay:  2 * time.Second,
	maxDelay:   30 * time.Second,
	shouldRetry: func(err error) bool {
		if err == nil {
			return false
		}
		return strings.Contains(err.Error(), "connection") ||
			strings.Contains(err.Error(), "deadline exceeded") ||
			strings.Contains(err.Error(), "internal error")
	},
}

// アップロード用のリトライ設定
var uploadRetryConfig = &retryConfig{
	maxRetries: 4,
	baseDelay:  2 * time.Second,
	maxDelay:   20 * time.Second,
	shouldRetry: func(err error) bool {
		if err == nil {
			return false
		}
		return strings.Contains(err.Error(), "connection") ||
			strings.Contains(err.Error(), "deadline exceeded")
	},
}

// リスト操作用のリトライ設定
var listOperationRetryConfig = &retryConfig{
	maxRetries: 4,
	baseDelay:  1 * time.Second,
	maxDelay:   15 * time.Second,
	shouldRetry: func(err error) bool {
		if err == nil {
			return false
		}
		return strings.Contains(err.Error(), "connection") ||
			strings.Contains(err.Error(), "deadline exceeded") ||
			strings.Contains(err.Error(), "internal error")
	},
}

// ----------------------------------------------------------------
// ノート操作
// ----------------------------------------------------------------

// ノートを新規作成 ------------------------------------------------------------
func (d *driveSyncServiceImpl) CreateNote(
	ctx context.Context,
	note *Note,
) error {
	noteContent, err := json.MarshalIndent(note, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal note content: %w", err)
	}

	fileName := note.ID + ".json"
	fileID, err := d.driveOps.CreateFile(
		fileName,
		noteContent,
		d.notesFolderID,
		"application/json",
	)
	if err == nil && fileID != "" {
		d.setCachedFileID(note.ID, fileID)
	}

	return err
}

// ノートを更新 ------------------------------------------------------------
func (d *driveSyncServiceImpl) UpdateNote(
	ctx context.Context,
	note *Note,
) error {
	noteContent, err := json.MarshalIndent(note, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal note content: %w", err)
	}

	fileID, err := d.resolveNoteFileID(note.ID)
	if err != nil {
		return d.CreateNote(ctx, note)
	}

	// ファイル更新をリトライ付きで実行
	err = d.withRetry(func() error {
		return d.driveOps.UpdateFile(fileID, noteContent)
	}, uploadRetryConfig)

	if err != nil {
		// キャンセルされた場合は新規作成にフォールバックしない (C-2: 重複CREATE防止)
		if errors.Is(err, ErrOperationCancelled) {
			return nil
		}
		return d.CreateNote(ctx, note)
	}

	return nil
}

// 複数のノートをまとめてアップロード ------------------------------------------------------------
func (d *driveSyncServiceImpl) UploadAllNotes(
	ctx context.Context,
	notes []NoteMetadata,
) error {
	// アップロード処理
	uploadCount := 0
	errorCount := 0
	for _, metadata := range notes {
		note := &Note{
			ID:            metadata.ID,
			Title:         metadata.Title,
			ContentHeader: metadata.ContentHeader,
			Language:      metadata.Language,
			ModifiedTime:  metadata.ModifiedTime,
			Archived:      metadata.Archived,
		}
		if err := d.UpdateNote(ctx, note); err != nil {
			errorCount++
			continue
		}
		uploadCount++
	}

	return nil
}

// Google Driveからノートをダウンロード ------------------------------------------------------------
func (d *driveSyncServiceImpl) DownloadNote(
	ctx context.Context,
	noteID string,
) (*Note, error) {
	var content []byte

	fileID, err := d.resolveNoteFileID(noteID)
	if err != nil {
		return nil, fmt.Errorf("failed to get file ID: %w", err)
	}

	// ダウンロードをリトライ付きで実行
	err = d.withRetry(func() error {
		var err error
		content, err = d.driveOps.DownloadFile(fileID)
		return err
	}, downloadRetryConfig)

	if err != nil {
		return nil, fmt.Errorf("failed to download note: %w", err)
	}

	var note Note
	if err := json.Unmarshal(content, &note); err != nil {
		return nil, fmt.Errorf("failed to decode note %s: %w", noteID, err)
	}

	return &note, nil
}

// ノートをクラウドから削除する ------------------------------------------------------------
func (d *driveSyncServiceImpl) DeleteNote(
	ctx context.Context,
	noteID string,
) error {
	fileID, err := d.resolveNoteFileID(noteID)
	if err != nil {
		return fmt.Errorf("failed to get file ID: %w", err)
	}

	fileName := noteID + ".json"
	err = d.withRetry(func() error {
		if queue, ok := d.driveOps.(*DriveOperationsQueue); ok {
			return queue.DeleteFileWithName(fileID, fileName)
		}
		return d.driveOps.DeleteFile(fileID)
	}, defaultRetryConfig)

	if err != nil {
		return fmt.Errorf("failed to delete note from cloud: %w", err)
	}

	d.removeCachedFileID(noteID)
	return nil
}

// クラウド内のファイル一覧を取得する ------------------------------------------------------------
func (d *driveSyncServiceImpl) ListFiles(ctx context.Context, folderID string) ([]*drive.File, error) {
	return d.driveOps.ListFiles(fmt.Sprintf("'%s' in parents and trashed=false", folderID))
}

// クラウド内のノートのIDを取得する ------------------------------------------------------------
func (d *driveSyncServiceImpl) GetNoteID(ctx context.Context, noteID string) (string, error) {
	return d.resolveNoteFileID(noteID)
}

// クラウド内の重複するノートファイルを削除する ------------------------------------------------------------

func (d *driveSyncServiceImpl) RemoveDuplicateNoteFiles(ctx context.Context, files []*drive.File) error {
	duplicateMap := make(map[string][]*drive.File)
	for _, file := range files {
		// 対象は「.json」で終わるファイルのみとする
		if !strings.HasSuffix(file.Name, ".json") {
			continue
		}
		// 拡張子を除いた部分をIDとみなす
		noteID := strings.TrimSuffix(file.Name, ".json")
		duplicateMap[noteID] = append(duplicateMap[noteID], file)
	}

	// 各noteIDごとに複数ファイルが存在すれば最新1つ以外を削除
	cleanupCount := 0
	for _, files := range duplicateMap {
		if len(files) > 1 {
			// 重複ファイルの削除をリトライ付きで実行
			err := d.withRetry(func() error {
				return d.driveOps.CleanupDuplicates(files, true)
			}, defaultRetryConfig)

			if err != nil {
				return fmt.Errorf("failed to cleanup duplicates: %w", err)
			}
			cleanupCount++
			noteID := strings.TrimSuffix(files[0].Name, ".json")
			d.logger.Console("Cleaned up duplicate file \"%s.json\"", noteID)
		}
	}
	if cleanupCount > 0 {
		d.logger.Info("Cleaned up %d duplicate note files on cloud", cleanupCount)
	}

	return nil
}

// ノートリストから指定のノートを除外する ------------------------------------------------------------
func (d *driveSyncServiceImpl) RemoveNoteFromList(notes []NoteMetadata, noteID string) []NoteMetadata {
	updatedNotes := make([]NoteMetadata, 0)
	for _, note := range notes {
		if note.ID != noteID {
			updatedNotes = append(updatedNotes, note)
		}
	}
	return updatedNotes
}

// ----------------------------------------------------------------
// ノートリスト操作
// ----------------------------------------------------------------

// ノートリストを新規作成 ------------------------------------------------------------
func (d *driveSyncServiceImpl) CreateNoteList(
	ctx context.Context,
	noteList *NoteList,
) error {
	// アップロード前に重複排除
	noteList.Notes = d.DeduplicateNotes(noteList.Notes)

	noteListContent, err := json.MarshalIndent(noteList, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal note list: %w", err)
	}

	// ファイル作成をリトライ付きで実行
	err = d.withRetry(func() error {
		_, err := d.driveOps.CreateFile(
			"noteList.json",
			noteListContent,
			d.rootFolderID,
			"application/json",
		)
		return err
	}, uploadRetryConfig)

	if err != nil {
		return fmt.Errorf("failed to create note list: %w", err)
	}

	return nil
}

// ノートリスト(noteList.json)をアップロードして更新 ------------------------------------------------------------
func (d *driveSyncServiceImpl) UpdateNoteList(
	ctx context.Context,
	noteList *NoteList,
	noteListID string,
) error {
	// アップロード前に重複排除
	noteList.Notes = d.DeduplicateNotes(noteList.Notes)

	noteListContent, err := json.MarshalIndent(noteList, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal note list: %w", err)
	}

	err = d.withRetry(func() error {
		return d.driveOps.UpdateFile(noteListID, noteListContent)
	}, uploadRetryConfig)

	if err != nil {
		return fmt.Errorf("failed to update note list: %w", err)
	}

	d.lastNoteListMd5 = ""
	return nil
}

func (d *driveSyncServiceImpl) DownloadNoteListIfChanged(
	ctx context.Context,
	noteListID string,
) (*NoteList, bool, error) {
	meta, err := d.driveOps.GetFileMetadata(noteListID)
	if err != nil {
		d.logger.Console("Metadata check failed, falling back to full download: %v", err)
		noteList, dlErr := d.DownloadNoteList(ctx, noteListID)
		if dlErr != nil {
			return nil, false, dlErr
		}
		return noteList, true, nil
	}

	if meta.Md5Checksum != "" && meta.Md5Checksum == d.lastNoteListMd5 {
		d.logger.Console("noteList.json unchanged (md5: %s), skipping download", meta.Md5Checksum)
		return nil, false, nil
	}

	noteList, err := d.DownloadNoteList(ctx, noteListID)
	if err != nil {
		return nil, false, err
	}
	d.lastNoteListMd5 = meta.Md5Checksum
	return noteList, true, nil
}

// クラウドからノートリストをダウンロードする ------------------------------------------------------------
func (d *driveSyncServiceImpl) DownloadNoteList(
	ctx context.Context,
	noteListID string,
) (*NoteList, error) {
	var content []byte

	// ダウンロードをリトライ付きで実行
	err := d.withRetry(func() error {
		var err error
		content, err = d.driveOps.DownloadFile(noteListID)
		return err
	}, downloadRetryConfig)

	if err != nil {
		return nil, fmt.Errorf("failed to download note list: %w", err)
	}

	var noteList NoteList
	if err := json.Unmarshal(content, &noteList); err != nil {
		if d.cachedNoteList != nil {
			d.logger.Info("Cloud note list is corrupted. Using last known good state")
			return d.cachedNoteList, nil
		}
		return nil, fmt.Errorf("failed to decode note list: %w", err)
	}

	noteList.Notes = d.DeduplicateNotes(noteList.Notes)
	d.cachedNoteList = &noteList
	return &noteList, nil
}

// クラウドのnotesフォルダにある不明なノートをリストアップする ------------------------------------------------------------
func (d *driveSyncServiceImpl) ListUnknownNotes(ctx context.Context, cloudNoteList *NoteList, files []*drive.File, arrowDownload bool) (*NoteList, error) {
	// 実ファイルのノートを反復して不明なノートをリストアップ
	unknownNotes := make([]NoteMetadata, 0)
	for _, file := range files {
		noteID := strings.TrimSuffix(file.Name, ".json")
		if slices.IndexFunc(cloudNoteList.Notes, func(n NoteMetadata) bool { return n.ID == noteID }) == -1 {
			var note []byte
			// 不明なノートのダウンロードをリトライ付きで実行
			if arrowDownload {
				err := d.withRetry(func() error {
					var err error
					d.logger.Console("Downloading note %s from cloud because it doesn't exist in local", noteID)
					note, err = d.driveOps.DownloadFile(file.Id)
					return err
				}, downloadRetryConfig)

				if err != nil {
					return nil, fmt.Errorf("failed to download note: %w", err)
				}

				var parsedNote Note
				if err := json.Unmarshal(note, &parsedNote); err != nil {
					return nil, fmt.Errorf("failed to decode note %s: %w", noteID, err)
				}

				//メタデータのみを抽出
				metadata := NoteMetadata{
					ID:            parsedNote.ID,
					Title:         parsedNote.Title,
					ContentHeader: parsedNote.ContentHeader,
					ModifiedTime:  parsedNote.ModifiedTime,
					Language:      parsedNote.Language,
					Archived:      parsedNote.Archived,
				}
				unknownNotes = append(unknownNotes, metadata)
			} else {
				unknownNotes = append(unknownNotes, NoteMetadata{
					ID: noteID,
				})
			}
		}
	}

	unknownNotesList := &NoteList{
		Notes: unknownNotes,
	}

	return unknownNotesList, nil
}

// クラウドに存在しないファイルをリストから除外して返す ------------------------------------------------------------
func (d *driveSyncServiceImpl) ListAvailableNotes(cloudNoteList *NoteList) (*NoteList, error) {
	var files []*drive.File

	// ファイル一覧取得をリトライ付きで実行
	err := d.withRetry(func() error {
		var err error
		files, err = d.driveOps.ListFiles(
			fmt.Sprintf("'%s' in parents and trashed=false", d.notesFolderID))
		return err
	}, listOperationRetryConfig)

	if err != nil {
		return nil, fmt.Errorf("failed to list files in notes folder: %w", err)
	}

	// 実体ファイルのIDマップを作成（ファイル名から拡張子を除去）
	existingIDs := make(map[string]bool)
	for _, file := range files {
		id := strings.TrimSuffix(file.Name, filepath.Ext(file.Name))
		existingIDs[id] = true
	}

	// クラウドノートリストをフィルタリング
	var filteredNotes []NoteMetadata
	for _, note := range cloudNoteList.Notes {
		if existingIDs[note.ID] {
			filteredNotes = append(filteredNotes, note)
		}
	}

	cloudNoteList.Notes = filteredNotes

	return cloudNoteList, nil
}

// ノートリストをソート（順序を保持しながら重複を排除） ------------------------------------------------------------
func (d *driveSyncServiceImpl) DeduplicateNotes(notes []NoteMetadata) []NoteMetadata {
	// IDでグループ化
	noteMap := make(map[string][]NoteMetadata)
	for _, note := range notes {
		noteMap[note.ID] = append(noteMap[note.ID], note)
	}

	// 重複を排除し、最新のものを保持
	result := make([]NoteMetadata, 0)
	for _, noteVersions := range noteMap {
		latest := noteVersions[0]
		for _, note := range noteVersions[1:] {
			if isModifiedTimeAfter(note.ModifiedTime, latest.ModifiedTime) {
				latest = note
			}
		}
		result = append(result, latest)
	}

	// Order値でソート
	sort.Slice(result, func(i, j int) bool {
		return result[i].Order < result[j].Order
	})

	return result
}

// テスト用メソッド ------------------------------------------------------------
func (d *driveSyncServiceImpl) SetConnected(connected bool) {
	d.isConnected = connected
}

func (d *driveSyncServiceImpl) SetInitialSyncCompleted(completed bool) {
	d.hasCompletedInitialSync = completed
}

func (d *driveSyncServiceImpl) SetCloudNoteList(noteList *NoteList) {
	d.cloudNoteList = noteList
}

func (d *driveSyncServiceImpl) IsConnected() bool {
	return d.isConnected
}

func (d *driveSyncServiceImpl) HasCompletedInitialSync() bool {
	return d.hasCompletedInitialSync
}
