package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"google.golang.org/api/drive/v3"
)

// DriveSyncService は同期関連の操作を提供するインターフェース
type DriveSyncService interface {
	// 同期初期化
	CheckInitialSyncFlag(appDataDir string) (bool, error)
	SaveInitialSyncFlag(appDataDir string) error
	
	// ノート同期
	MergeNotes(
		ctx context.Context,
		localNotes []NoteMetadata,
		cloudNotes []NoteMetadata,
		downloadNote func(string) error,
		uploadNote func(*Note) error,
		loadNote func(string) (*Note, error),
	) ([]NoteMetadata, error)
	
	// クラウドとの同期
	FetchCloudNoteList(ctx context.Context, rootFolderID string) (*NoteList, error)
	SyncNoteWithCloud(
		ctx context.Context,
		noteID string,
		cloudNote NoteMetadata,
		loadNote func(string) (*Note, error),
		downloadNote func(string) error,
	) error
	CleanDuplicateNoteFiles(ctx context.Context, notesFolderID string) error
	
	// ノートアップロード
	UploadAllNotes(
		ctx context.Context,
		notes []NoteMetadata,
		notesFolderID string,
		uploadNote func(*Note) error,
		uploadNoteList func() error,
		isTestMode bool,
	) error
	UploadNote(
		ctx context.Context,
		note *Note,
		notesFolderID string,
		lastUpdated map[string]time.Time,
		isTestMode bool,
		handleTestModeUpload func(*Note) error,
	) error
	UploadNoteList(
		ctx context.Context,
		noteList *NoteList,
		rootFolderID string,
		isTestMode bool,
		handleTestModeNoteListUpload func() error,
	) error
	
	// ノートダウンロード
	DownloadNote(
		ctx context.Context,
		noteID string,
		notesFolderID string,
		saveNote func(*Note) error,
		removeFromNoteList func(string),
		lastUpdated map[string]time.Time,
	) error
	
	// ノート削除
	DeleteNoteDrive(
		ctx context.Context,
		noteID string,
		notesFolderID string,
		isTestMode bool,
		handleTestModeDelete func(string) error,
	) error
	RemoveFromNoteList(notes []NoteMetadata, noteID string) []NoteMetadata
	
	// 状態通知
	NotifyDriveStatus(ctx context.Context, status string, isTestMode bool)
	NotifyFrontendChanges(ctx context.Context, isTestMode bool)
}

// DriveSyncServiceの実装
type driveSyncServiceImpl struct {
	driveOps DriveOperations
}

// DriveSyncServiceインスタンスを作成
func NewDriveSyncService(driveOps DriveOperations) DriveSyncService {
	return &driveSyncServiceImpl{
		driveOps: driveOps,
	}
}

// 初回同期フラグの状態を確認
func (d *driveSyncServiceImpl) CheckInitialSyncFlag(appDataDir string) (bool, error) {
	syncFlagPath := filepath.Join(appDataDir, "initial_sync_completed")
	_, err := os.Stat(syncFlagPath)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("failed to check initial sync flag: %w", err)
	}
	return true, nil
}

// 初回同期完了フラグを保存
func (d *driveSyncServiceImpl) SaveInitialSyncFlag(appDataDir string) error {
	syncFlagPath := filepath.Join(appDataDir, "initial_sync_completed")
	if err := os.WriteFile(syncFlagPath, []byte("1"), 0644); err != nil {
		return fmt.Errorf("failed to save initial sync flag: %w", err)
	}
	return nil
}

// クラウドとローカルのノートをマージ
func (d *driveSyncServiceImpl) MergeNotes(
	ctx context.Context,
	localNotes []NoteMetadata,
	cloudNotes []NoteMetadata,
	downloadNote func(string) error,
	uploadNote func(*Note) error,
	loadNote func(string) (*Note, error),
) ([]NoteMetadata, error) {
	mergedNotes := make([]NoteMetadata, 0)
	localNotesMap := make(map[string]NoteMetadata)
	cloudNotesMap := make(map[string]NoteMetadata)

	// ローカルノートのマップを作成
	for _, note := range localNotes {
		localNotesMap[note.ID] = note
	}

	// クラウドノートのマップを作成
	for _, note := range cloudNotes {
		cloudNotesMap[note.ID] = note
	}

	// マージ処理
	for id, localNote := range localNotesMap {
		if cloudNote, exists := cloudNotesMap[id]; exists {
			// 同じIDのノートが存在する場合
			if localNote.ContentHash != "" && cloudNote.ContentHash != "" &&
				localNote.ContentHash == cloudNote.ContentHash {
				// ハッシュが一致する場合はスキップ
				mergedNotes = append(mergedNotes, localNote)
				delete(cloudNotesMap, id)
				continue
			}

			// ハッシュが一致しない場合は更新日時で比較
			if cloudNote.ModifiedTime.After(localNote.ModifiedTime) {
				mergedNotes = append(mergedNotes, cloudNote)
				if err := downloadNote(id); err != nil {
					return nil, fmt.Errorf("failed to download note %s: %w", id, err)
				}
			} else {
				mergedNotes = append(mergedNotes, localNote)
				note, err := loadNote(id)
				if err == nil {
					if err := uploadNote(note); err != nil {
						return nil, fmt.Errorf("failed to upload note %s: %w", id, err)
					}
				}
			}
			delete(cloudNotesMap, id)
		} else {
			// ローカルにしかないノートはアップロード
			mergedNotes = append(mergedNotes, localNote)
			note, err := loadNote(id)
			if err == nil {
				if err := uploadNote(note); err != nil {
					return nil, fmt.Errorf("failed to upload note %s: %w", id, err)
				}
			}
		}
	}

	// クラウドにしかないノートを追加
	for id, cloudNote := range cloudNotesMap {
		mergedNotes = append(mergedNotes, cloudNote)
		if err := downloadNote(id); err != nil {
			return nil, fmt.Errorf("failed to download note %s: %w", id, err)
		}
	}

	return mergedNotes, nil
}

// クラウドからノートリストを取得
func (d *driveSyncServiceImpl) FetchCloudNoteList(ctx context.Context, rootFolderID string) (*NoteList, error) {
	query := fmt.Sprintf("name='noteList.json' and '%s' in parents and trashed=false", rootFolderID)
	
	files, err := d.driveOps.ListFiles(query)
	if err != nil {
		return nil, fmt.Errorf("failed to list files: %w", err)
	}
	if len(files) == 0 {
		return nil, nil
	}
	
	content, err := d.driveOps.DownloadFile(files[0].Id)
	if err != nil {
		return nil, fmt.Errorf("failed to download note list: %w", err)
	}
	
	var noteList NoteList
	if err := json.Unmarshal(content, &noteList); err != nil {
		return nil, fmt.Errorf("failed to decode note list: %w", err)
	}
	
	return &noteList, nil
}

// 個別のノートをクラウドと同期
func (d *driveSyncServiceImpl) SyncNoteWithCloud(
	ctx context.Context,
	noteID string,
	cloudNote NoteMetadata,
	loadNote func(string) (*Note, error),
	downloadNote func(string) error,
) error {
	localNote, err := loadNote(noteID)
	if err != nil {
		// ローカルにないノートはダウンロード
		if err := downloadNote(noteID); err != nil {
			if strings.Contains(err.Error(), "note file not found in both cloud and local") {
				return nil
			}
			return err
		}
		return nil
	}
	
	// クラウドの方が新しい場合は更新
	if cloudNote.ModifiedTime.After(localNote.ModifiedTime) {
		if err := downloadNote(noteID); err != nil {
			if strings.Contains(err.Error(), "note file not found in both cloud and local") {
				return nil
			}
			return err
		}
	}
	
	return nil
}

// notesフォルダ内の重複する {id}.jsonファイルを検出し、最新のファイルだけを残し古い方を削除
func (d *driveSyncServiceImpl) CleanDuplicateNoteFiles(ctx context.Context, notesFolderID string) error {
	// notesフォルダ内のファイル一覧を取得
	files, err := d.driveOps.ListFiles(
		fmt.Sprintf("'%s' in parents and trashed=false", notesFolderID))
	if err != nil {
		return fmt.Errorf("failed to list files in notes folder: %w", err)
	}

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
	for _, files := range duplicateMap {
		if len(files) > 1 {
			if err := d.driveOps.CleanupDuplicates(files, true); err != nil {
				return fmt.Errorf("failed to cleanup duplicates: %w", err)
			}
		}
	}

	return nil
}

// 全てのローカルノートをGoogle Driveにアップロード
func (d *driveSyncServiceImpl) UploadAllNotes(
	ctx context.Context,
	notes []NoteMetadata,
	notesFolderID string,
	uploadNote func(*Note) error,
	uploadNoteList func() error,
	isTestMode bool,
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
		if err := uploadNote(note); err != nil {
			errorCount++
			continue
		}
		uploadCount++
	}

	// ノートリストをアップロード
	if err := uploadNoteList(); err != nil {
		return fmt.Errorf("failed to upload note list: %w", err)
	}

	// 完了通知
	d.NotifyDriveStatus(ctx, "synced", isTestMode)

	return nil
}

// ノートをGoogle Driveにアップロード
func (d *driveSyncServiceImpl) UploadNote(
	ctx context.Context,
	note *Note,
	notesFolderID string,
	lastUpdated map[string]time.Time,
	isTestMode bool,
	handleTestModeUpload func(*Note) error,
) error {
	if isTestMode {
		return handleTestModeUpload(note)
	}

	noteContent, err := json.MarshalIndent(note, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal note content: %w", err)
	}

	lastUpdated[note.ID] = time.Now()

	fileName := note.ID + ".json"
	_, err = d.driveOps.EnsureFile(
		fileName,
		notesFolderID,
		noteContent,
		"application/json",
	)

	return err
}

// 現在のノートリスト(noteList.json)をアップロード
func (d *driveSyncServiceImpl) UploadNoteList(
	ctx context.Context,
	noteList *NoteList,
	rootFolderID string,
	isTestMode bool,
	handleTestModeNoteListUpload func() error,
) error {
	if isTestMode {
		return handleTestModeNoteListUpload()
	}

	noteListContent, err := json.MarshalIndent(noteList, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal note list: %w", err)
	}

	// すでに存在しているかチェック
	files, err := d.driveOps.ListFiles(
		fmt.Sprintf("name='noteList.json' and '%s' in parents and trashed=false", 
			rootFolderID))
	if err != nil {
		return fmt.Errorf("failed to list note list files: %w", err)
	}

	if len(files) > 0 {
		// 既存のファイルを更新
		if err := d.driveOps.UpdateFile(files[0].Id, noteListContent); err != nil {
			return fmt.Errorf("failed to update note list: %w", err)
		}
	} else {
		// 新規作成
		_, err = d.driveOps.CreateFile("noteList.json", noteListContent, rootFolderID, "application/json")
		if err != nil {
			return fmt.Errorf("failed to create note list: %w", err)
		}
	}

	// 完了通知
	d.NotifyDriveStatus(ctx, "synced", isTestMode)

	return nil
}

// Google Driveからノートをダウンロード
func (d *driveSyncServiceImpl) DownloadNote(
	ctx context.Context,
	noteID string,
	notesFolderID string,
	saveNote func(*Note) error,
	removeFromNoteList func(string),
	lastUpdated map[string]time.Time,
) error {
	// ノートファイルを検索
	files, err := d.driveOps.ListFiles(
		fmt.Sprintf("name='%s.json' and '%s' in parents and trashed=false", 
			noteID, notesFolderID))
	if err != nil {
		return fmt.Errorf("failed to list note file: %w", err)
	}

	if len(files) == 0 {
		// ノートリストから除外
		removeFromNoteList(noteID)
		return fmt.Errorf("note file not found in both cloud and local: %s", noteID)
	}

	// ノートファイルをダウンロード
	content, err := d.driveOps.DownloadFile(files[0].Id)
	if err != nil {
		return fmt.Errorf("failed to download note: %w", err)
	}

	var note Note
	if err := json.Unmarshal(content, &note); err != nil {
		return fmt.Errorf("failed to decode note: %w", err)
	}

	// ノートを保存
	if err := saveNote(&note); err != nil {
		return fmt.Errorf("failed to save note: %w", err)
	}

	// 最終更新時刻を記録
	lastUpdated[noteID] = time.Now()

	return nil
}

// ノートをGoogle Drive上から削除
func (d *driveSyncServiceImpl) DeleteNoteDrive(
	ctx context.Context,
	noteID string,
	notesFolderID string,
	isTestMode bool,
	handleTestModeDelete func(string) error,
) error {
	if isTestMode {
		return handleTestModeDelete(noteID)
	}

	// ノートファイルを検索
	files, err := d.driveOps.ListFiles(
		fmt.Sprintf("name='%s.json' and '%s' in parents and trashed=false", 
			noteID, notesFolderID))
	if err != nil {
		return fmt.Errorf("failed to list note files: %w", err)
	}

	if len(files) > 0 {
		if err := d.driveOps.DeleteFile(files[0].Id); err != nil {
			return fmt.Errorf("failed to delete note from cloud: %w", err)
		}
	}

	return nil
}

// ノートリストから指定されたIDのノートを除外
func (d *driveSyncServiceImpl) RemoveFromNoteList(notes []NoteMetadata, noteID string) []NoteMetadata {
	updatedNotes := make([]NoteMetadata, 0)
	for _, note := range notes {
		if note.ID != noteID {
			updatedNotes = append(updatedNotes, note)
		}
	}
	return updatedNotes
}

// ドライブの状態をフロントエンドに通知
func (d *driveSyncServiceImpl) NotifyDriveStatus(ctx context.Context, status string, isTestMode bool) {
	if !isTestMode {
		wailsRuntime.EventsEmit(ctx, "drive:status", status)
	}
}

// フロントエンドに変更を通知
func (d *driveSyncServiceImpl) NotifyFrontendChanges(ctx context.Context, isTestMode bool) {
	if !isTestMode {
		wailsRuntime.EventsEmit(ctx, "notes:updated")
		wailsRuntime.EventsEmit(ctx, "drive:status", "synced")
		wailsRuntime.EventsEmit(ctx, "notes:reload")
	}
} 