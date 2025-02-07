package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"google.golang.org/api/drive/v3"
)

// DriveOperations はGoogle Driveの低レベル操作を提供するインターフェース
type DriveOperations interface {
	// ファイル操作 (Driveネイティブ)
	CreateFile(name string, content []byte, parentID string, mimeType string) (string, error)
	UpdateFile(fileID string, content []byte) error
	DeleteFile(fileID string) error
	DownloadFile(fileID string) ([]byte, error)
	
	// フォルダ操作 (Driveネイティブ)
	CreateFolder(name string, parentID string) (string, error)
	
	// 検索 (Driveネイティブ)
	ListFiles(query string) ([]*drive.File, error)

	// 同期初期化関連
	checkInitialSyncFlag(appDataDir string) (bool, error) // 初回同期フラグの状態を確認
	saveInitialSyncFlag(appDataDir string) error // 初回同期完了フラグを保存
	notifyDriveStatus(ctx context.Context, status string, isTestMode bool) // ドライブの状態をフロントエンドに通知

	// 初期同期関連
	mergeNotes(
		ctx context.Context,
		localNotes []NoteMetadata,
		cloudNotes []NoteMetadata,
		downloadNote func(string) error,
		uploadNote func(*Note) error,
		loadNote func(string) (*Note, error),
	) ([]NoteMetadata, error) // クラウドとローカルのノートをマージ
	notifyFrontendChanges(ctx context.Context, isTestMode bool) // フロントエンドに変更を通知

	// ------------------------------------------------------------
	// ノートアップロード関連のヘルパー
	// ------------------------------------------------------------

	// uploadAllNotes は全てのローカルノートをGoogle Driveにアップロードします
	uploadAllNotes(
		ctx context.Context,
		notes []Note,
		notesFolderID string,
		uploadNote func(*Note) error,
		uploadNoteList func() error,
		isTestMode bool,
	) error

	// downloadNote はGoogle Driveからノートをダウンロードします
	downloadNote(
		ctx context.Context,
		noteID string,
		notesFolderID string,
		saveNote func(*Note) error,
		removeFromNoteList func(string),
		lastUpdated map[string]time.Time,
	) error

	// removeFromNoteList はノートリストから指定されたIDのノートを除外します
	removeFromNoteList(notes []NoteMetadata, noteID string) []NoteMetadata

	// uploadNote はノートをGoogle Driveにアップロードします
	uploadNote(
		ctx context.Context,
		note *Note,
		notesFolderID string,
		lastUpdated map[string]time.Time,
		isTestMode bool,
		handleTestModeUpload func(*Note) error,
	) error

	// ensureFile はファイルの存在確認と作成/更新を行います
	ensureFile(
		name string,
		parentID string,
		content []byte,
		mimeType string,
	) (string, error)

	// findLatestFile は複数のファイルから最新のものを返します
	findLatestFile(files []*drive.File) *drive.File

	// cleanupDuplicates は重複ファイルの整理を行います
	cleanupDuplicates(
		files []*drive.File,
		keepLatest bool,
	) error

	// deleteNoteDrive はGoogle Drive上のノートを削除します
	deleteNoteDrive(
		ctx context.Context,
		noteID string,
		notesFolderID string,
		isTestMode bool,
		handleTestModeDelete func(string) error,
	) error

	// uploadNoteList は現在のノートリスト(noteList.json)をアップロードします
	uploadNoteList(
		ctx context.Context,
		noteList *NoteList,
		rootFolderID string,
		isTestMode bool,
		handleTestModeNoteListUpload func() error,
	) error
}

// DriveOperationsの実装
type driveOperationsImpl struct {
	service *drive.Service
}

// DriveOperationsインスタンスを作成
func NewDriveOperations(service *drive.Service) DriveOperations {
	return &driveOperationsImpl{
		service: service,
	}
}

// ------------------------------------------------------------
// Google Driveファイル操作
// ------------------------------------------------------------

// 新しいファイルを作成 (Driveネイティブ)
func (d *driveOperationsImpl) CreateFile(name string, content []byte, parentID string, mimeType string) (string, error) {
	f := &drive.File{
		Name:     name,
		Parents:  []string{parentID},
		MimeType: mimeType,
	}
	
	file, err := d.service.Files.Create(f).
		Media(bytes.NewReader(content)).
		Do()
	if err != nil {
		return "", fmt.Errorf("failed to create file: %w", err)
	}
	
	return file.Id, nil
}

// ファイルを更新 (Driveネイティブ)
func (d *driveOperationsImpl) UpdateFile(fileID string, content []byte) error {
	_, err := d.service.Files.Update(fileID, &drive.File{}).
		Media(bytes.NewReader(content)).
		Do()
	if err != nil {
		return fmt.Errorf("failed to update file: %w", err)
	}
	
	return nil
}

// ファイルを削除 (Driveネイティブ)
func (d *driveOperationsImpl) DeleteFile(fileID string) error {
	err := d.service.Files.Delete(fileID).Do()
	if err != nil {
		return fmt.Errorf("failed to delete file: %w", err)
	}
	return nil
}

// ファイルをダウンロード (Driveネイティブ)
func (d *driveOperationsImpl) DownloadFile(fileID string) ([]byte, error) {
	resp, err := d.service.Files.Get(fileID).Download()
	if err != nil {
		return nil, fmt.Errorf("failed to download file: %w", err)
	}
	defer resp.Body.Close()
	
	content := new(bytes.Buffer)
	_, err = content.ReadFrom(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read file content: %w", err)
	}
	
	return content.Bytes(), nil
}

// フォルダを作成 (Driveネイティブ)
func (d *driveOperationsImpl) CreateFolder(name string, parentID string) (string, error) {
	f := &drive.File{
		Name:     name,
		MimeType: "application/vnd.google-apps.folder",
	}
	if parentID != "" {
		f.Parents = []string{parentID}
	}
	
	folder, err := d.service.Files.Create(f).Fields("id").Do()
	if err != nil {
		return "", fmt.Errorf("failed to create folder: %w", err)
	}
	
	return folder.Id, nil
}

// ファイルを検索 (Driveネイティブ)
func (d *driveOperationsImpl) ListFiles(query string) ([]*drive.File, error) {
	files, err := d.service.Files.List().
		Q(query).
		Fields("files(id, name, createdTime)").
		Do()
	if err != nil {
		return nil, fmt.Errorf("failed to list files: %w", err)
	}
	
	return files.Files, nil
}

// ------------------------------------------------------------
// 同期関連のヘルパー
// ------------------------------------------------------------

// クラウドからノートリストを取得します
func (s *driveService) fetchCloudNoteList() (*NoteList, error) {
	query := fmt.Sprintf("name='noteList.json' and '%s' in parents and trashed=false", 
		s.auth.driveSync.rootFolderID)
	
	files, err := s.driveOps.ListFiles(query)
	if err != nil {
		return nil, s.logger.ErrorWithNotify(err, "Failed to list files")
	}
	if len(files) == 0 {
		return nil, nil
	}
	
	content, err := s.driveOps.DownloadFile(files[0].Id)
	if err != nil {
		return nil, s.logger.ErrorWithNotify(err, "Failed to download note list")
	}
	
	var noteList NoteList
	if err := json.Unmarshal(content, &noteList); err != nil {
		return nil, s.logger.ErrorWithNotify(err, "Failed to decode note list")
	}
	
	return &noteList, nil
}

// 個別のノートをクラウドと同期
func (s *driveService) syncNoteWithCloud(noteID string, cloudNote NoteMetadata) error {
	localNote, err := s.noteService.LoadNote(noteID)
	if err != nil {
		// ローカルにないノートはダウンロード
		if err := s.downloadNote(noteID); err != nil {
			if strings.Contains(err.Error(), "note file not found in both cloud and local") {
				s.logger.Info("Skipping non-existent note %s", noteID)
				return nil
			}
			return err
		}
		return nil
	}
	
	// クラウドの方が新しい場合は更新
	if cloudNote.ModifiedTime.After(localNote.ModifiedTime) {
		if err := s.downloadNote(noteID); err != nil {
			if strings.Contains(err.Error(), "note file not found in both cloud and local") {
				s.logger.Info("Skipping non-existent note %s", noteID)
				return nil
			}
			return err
		}
	}
	
	return nil
}

// フロントエンドに変更を通知
func (s *driveService) notifyFrontendChanges(status string) {
	if !s.IsTestMode() {
		if status != "" {
			wailsRuntime.EventsEmit(s.ctx, "drive:status", status)
		}
		wailsRuntime.EventsEmit(s.ctx, "notes:reload")
	}
}

// ------------------------------------------------------------
// 同期初期化関連のヘルパー
// ------------------------------------------------------------

// 初回同期フラグの状態を確認
func (d *driveOperationsImpl) checkInitialSyncFlag(appDataDir string) (bool, error) {
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
func (d *driveOperationsImpl) saveInitialSyncFlag(appDataDir string) error {
	syncFlagPath := filepath.Join(appDataDir, "initial_sync_completed")
	if err := os.WriteFile(syncFlagPath, []byte("1"), 0644); err != nil {
		return fmt.Errorf("failed to save initial sync flag: %w", err)
	}
	return nil
}

// ドライブの状態をフロントエンドに通知
func (d *driveOperationsImpl) notifyDriveStatus(ctx context.Context, status string, isTestMode bool) {
	if !isTestMode {
		wailsRuntime.EventsEmit(ctx, "drive:status", status)
	}
}

// ------------------------------------------------------------
// 初期同期関連のヘルパー
// ------------------------------------------------------------

// クラウドとローカルのノートをマージ
func (d *driveOperationsImpl) mergeNotes(
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

// フロントエンドに変更を通知
func (d *driveOperationsImpl) notifyFrontendChanges(ctx context.Context, isTestMode bool) {
	if !isTestMode {
		wailsRuntime.EventsEmit(ctx, "notes:updated")
		wailsRuntime.EventsEmit(ctx, "drive:status", "synced")
		wailsRuntime.EventsEmit(ctx, "notes:reload")
	}
}

// ------------------------------------------------------------
// ノートアップロード関連のヘルパー
// ------------------------------------------------------------

// 全てのローカルノートをGoogle Driveにアップロード
func (d *driveOperationsImpl) uploadAllNotes(
	ctx context.Context,
	notes []Note,
	notesFolderID string,
	uploadNote func(*Note) error,
	uploadNoteList func() error,
	isTestMode bool,
) error {
	// 既存の notes フォルダを削除
	if notesFolderID != "" {
		if err := d.DeleteFile(notesFolderID); err != nil {
			return fmt.Errorf("failed to delete notes folder: %w", err)
		}
	}

	// アップロード処理
	uploadCount := 0
	errorCount := 0
	for _, note := range notes {
		if err := uploadNote(&note); err != nil {
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
	d.notifyDriveStatus(ctx, "synced", isTestMode)

	return nil
}

// Google Driveからノートをダウンロード
func (d *driveOperationsImpl) downloadNote(
	ctx context.Context,
	noteID string,
	notesFolderID string,
	saveNote func(*Note) error,
	removeFromNoteList func(string),
	lastUpdated map[string]time.Time,
) error {
	// ノートファイルを検索
	files, err := d.ListFiles(
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
	content, err := d.DownloadFile(files[0].Id)
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

// ノートリストから指定されたIDのノートを除外
func (d *driveOperationsImpl) removeFromNoteList(notes []NoteMetadata, noteID string) []NoteMetadata {
	updatedNotes := make([]NoteMetadata, 0)
	for _, note := range notes {
		if note.ID != noteID {
			updatedNotes = append(updatedNotes, note)
		}
	}
	return updatedNotes
}

// ノートをGoogle Driveにアップロードします
func (d *driveOperationsImpl) uploadNote(
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
	_, err = d.ensureFile(
		fileName,
		notesFolderID,
		noteContent,
		"application/json",
	)

	return err
}

// ファイルの存在確認と作成/更新を行う
func (d *driveOperationsImpl) ensureFile(
	name string,
	parentID string,
	content []byte,
	mimeType string,
) (string, error) {
	query := fmt.Sprintf("name='%s' and '%s' in parents and trashed=false",
		name, parentID)

	files, err := d.ListFiles(query)
	if err != nil {
		return "", err
	}

	if len(files) > 0 {
		// 重複ファイルがある場合は整理
		if len(files) > 1 {
			latestFile := d.findLatestFile(files)
			if err := d.cleanupDuplicates(files, true); err != nil {
				return "", err
			}
			files = []*drive.File{latestFile}
		}

		// 更新
		if err := d.UpdateFile(files[0].Id, content); err != nil {
			return "", fmt.Errorf("failed to update file: %w", err)
		}
		return files[0].Id, nil
	}

	// 新規作成
	fileID, err := d.CreateFile(name, content, parentID, mimeType)
	if err != nil {
		return "", fmt.Errorf("failed to create file: %w", err)
	}
	return fileID, nil
}

// 複数のファイルから最新のものを返す
func (d *driveOperationsImpl) findLatestFile(files []*drive.File) *drive.File {
	if len(files) == 0 {
		return nil
	}
	if len(files) == 1 {
		return files[0]
	}

	sort.Slice(files, func(i, j int) bool {
		t1, err1 := time.Parse(time.RFC3339, files[i].CreatedTime)
		t2, err2 := time.Parse(time.RFC3339, files[j].CreatedTime)
		if err1 != nil || err2 != nil {
			return false
		}
		return t1.After(t2)
	})
	return files[0]
}

// 重複ファイルの整理
func (d *driveOperationsImpl) cleanupDuplicates(
	files []*drive.File,
	keepLatest bool,
) error {
	if len(files) <= 1 {
		return nil
	}

	var targetFiles []*drive.File
	if keepLatest {
		targetFiles = files[1:] // 最新以外を削除
	} else {
		targetFiles = files // すべて削除
	}

	for _, file := range targetFiles {
		if err := d.DeleteFile(file.Id); err != nil {
			return fmt.Errorf("failed to delete file %s: %w", file.Name, err)
		}
	}
	return nil
}

// ノートをGoogle Drive上から削除
func (d *driveOperationsImpl) deleteNoteDrive(
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
	files, err := d.ListFiles(
		fmt.Sprintf("name='%s.json' and '%s' in parents and trashed=false", 
			noteID, notesFolderID))
	if err != nil {
		return fmt.Errorf("failed to list note files: %w", err)
	}

	if len(files) > 0 {
		if err := d.DeleteFile(files[0].Id); err != nil {
			return fmt.Errorf("failed to delete note from cloud: %w", err)
		}
	}

	return nil
}

// 現在のノートリスト(noteList.json)をアップロード
func (d *driveOperationsImpl) uploadNoteList(
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
	files, err := d.ListFiles(
		fmt.Sprintf("name='noteList.json' and '%s' in parents and trashed=false", 
			rootFolderID))
	if err != nil {
		return fmt.Errorf("failed to list note list files: %w", err)
	}

	if len(files) > 0 {
		// 既存のファイルを更新
		if err := d.UpdateFile(files[0].Id, noteListContent); err != nil {
			return fmt.Errorf("failed to update note list: %w", err)
		}
	} else {
		// 新規作成
		_, err = d.CreateFile("noteList.json", noteListContent, rootFolderID, "application/json")
		if err != nil {
			return fmt.Errorf("failed to create note list: %w", err)
		}
	}

	// 完了通知
	d.notifyDriveStatus(ctx, "synced", isTestMode)

	return nil
}