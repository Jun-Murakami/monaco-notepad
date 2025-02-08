package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"sort"
	"strings"

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
	RemoveDuplicateNoteFiles(ctx context.Context) error                    // 重複するノートファイルを削除
	RemoveNoteFromList(notes []NoteMetadata, noteID string) []NoteMetadata // ノートリストから指定のノートを除外

	// ノートリスト操作 ------------------------------------------------------------
	CreateNoteList(ctx context.Context, noteList *NoteList) error
	UpdateNoteList(ctx context.Context, noteList *NoteList, noteListID string) error
	DownloadNoteList(ctx context.Context, noteListID string) (*NoteList, error)
	// クラウドのノートリストにないノートをリストアップ
	ListUnknownNotes(ctx context.Context, cloudNoteList *NoteList) (*NoteList, error)
	// クラウドに存在しないファイルをリストから除外して返す
	ListAvailableNotes(cloudNoteList *NoteList) (*NoteList, error)
	// 重複IDを持つノートを処理し、最新のものだけを保持
	DeduplicateNotes(notes []NoteMetadata) []NoteMetadata
}

// DriveSyncServiceの実装
type driveSyncServiceImpl struct {
	driveOps      DriveOperations
	notesFolderID string
	rootFolderID  string
}

// DriveSyncServiceインスタンスを作成
func NewDriveSyncService(
	driveOps DriveOperations,
	notesFolderID string,
	rootFolderID string,
) DriveSyncService {
	return &driveSyncServiceImpl{
		driveOps:      driveOps,
		notesFolderID: notesFolderID,
		rootFolderID:  rootFolderID,
	}
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
	_, err = d.driveOps.CreateFile(
		fileName,
		noteContent,
		d.notesFolderID,
		"application/json",
	)

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

	fileID, err := d.driveOps.GetFileID(note.ID+".json", d.notesFolderID, d.rootFolderID)
	if err != nil {
		return fmt.Errorf("failed to get file ID: %w", err)
	}

	//更新
	err = d.driveOps.UpdateFile(
		fileID,
		noteContent,
	)
	if err != nil {
		// 更新失敗の場合は新規作成
		err = d.CreateNote(ctx, note)
		if err != nil {
			return fmt.Errorf("failed to update and create note: %w", err)
		}
		return nil
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

	// ノートファイルのIDを取得
	fileID, err := d.driveOps.GetFileID(noteID+".json", d.notesFolderID, d.rootFolderID)
	if err != nil {
		return nil, fmt.Errorf("failed to get file ID: %w", err)
	}

	// ノートファイルをダウンロード
	content, err := d.driveOps.DownloadFile(fileID)
	if err != nil {
		return nil, fmt.Errorf("failed to download note: %w", err)
	}

	var note Note
	if err := json.Unmarshal(content, &note); err != nil {
		return nil, fmt.Errorf("failed to decode note: %w", err)
	}

	return &note, nil
}

// ノートをクラウドから削除する ------------------------------------------------------------
func (d *driveSyncServiceImpl) DeleteNote(
	ctx context.Context,
	noteID string,
) error {

	// ノートファイルのIDを取得
	fileID, err := d.driveOps.GetFileID(noteID+".json", d.notesFolderID, d.rootFolderID)
	if err != nil {
		return fmt.Errorf("failed to get file ID: %w", err)
	}

	if err := d.driveOps.DeleteFile(fileID); err != nil {
		return fmt.Errorf("failed to delete note from cloud: %w", err)
	}

	return nil
}

// クラウド内の重複するノートファイルを削除する ------------------------------------------------------------
func (d *driveSyncServiceImpl) RemoveDuplicateNoteFiles(ctx context.Context) error {
	// notesフォルダ内のファイル一覧を取得
	files, err := d.driveOps.ListFiles(
		fmt.Sprintf("'%s' in parents and trashed=false", d.notesFolderID))
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

	_, err = d.driveOps.CreateFile("noteList.json", noteListContent, d.rootFolderID, "application/json")
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

	// 既存のファイルを更新
	if err := d.driveOps.UpdateFile(noteListID, noteListContent); err != nil {
		return fmt.Errorf("failed to update note list: %w", err)
	}

	return nil
}

// クラウドからノートリストをダウンロードする ------------------------------------------------------------
func (d *driveSyncServiceImpl) DownloadNoteList(ctx context.Context, noteListID string) (*NoteList, error) {
	content, err := d.driveOps.DownloadFile(noteListID)
	if err != nil {
		return nil, fmt.Errorf("failed to download note list: %w", err)
	}

	var noteList NoteList
	if err := json.Unmarshal(content, &noteList); err != nil {
		return nil, fmt.Errorf("failed to decode note list: %w", err)
	}

	// ダウンロード後に重複排除
	noteList.Notes = d.DeduplicateNotes(noteList.Notes)
	return &noteList, nil
}

// クラウドのnotesフォルダにある不明なノートをリストアップする ------------------------------------------------------------
func (d *driveSyncServiceImpl) ListUnknownNotes(ctx context.Context, cloudNoteList *NoteList) (*NoteList, error) {
	// notesフォルダ内のファイル一覧を取得
	files, err := d.driveOps.ListFiles(
		fmt.Sprintf("'%s' in parents and trashed=false", d.notesFolderID))
	if err != nil {
		return nil, fmt.Errorf("failed to list files in notes folder: %w", err)
	}

	// 実ファイルのノートを反復して不明なノートをリストアップ
	unknownNotes := make([]NoteMetadata, 0)
	for _, file := range files {
		noteID := strings.TrimSuffix(file.Name, ".json")
		if slices.IndexFunc(cloudNoteList.Notes, func(n NoteMetadata) bool { return n.ID == noteID }) == -1 {
			// 不明なノートを開いてメタデータを抽出
			note, err := d.driveOps.DownloadFile(file.Id)
			if err != nil {
				return nil, fmt.Errorf("failed to download note: %w", err)
			}
			var parsedNote Note
			if err := json.Unmarshal(note, &parsedNote); err != nil {
				return nil, fmt.Errorf("failed to decode note: %w", err)
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
		}
	}

	unknownNotesList := &NoteList{
		Notes: unknownNotes,
	}

	return unknownNotesList, nil
}

// クラウドに存在しないファイルをリストから除外して返す ------------------------------------------------------------
func (d *driveSyncServiceImpl) ListAvailableNotes(cloudNoteList *NoteList) (*NoteList, error) {
	query := fmt.Sprintf("'%s' in parents and trashed=false", d.notesFolderID)
	files, err := d.driveOps.ListFiles(query)
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
			if note.ModifiedTime.After(latest.ModifiedTime) {
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
