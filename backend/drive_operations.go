package backend

import (
	"bytes"
	"fmt"
	"sort"
	"strings"
	"time"

	"google.golang.org/api/drive/v3"
)

// ChangesResult は changes.list の結果をまとめた構造体
type ChangesResult struct {
	Changes       []*drive.Change // 変更リスト
	NewStartToken string          // 次回ポーリング用のトークン
}

// DriveOperations はGoogle Driveの低レベル操作を提供するインターフェース
type DriveOperations interface {
	CreateFile(name string, content []byte, rootFolderID string, mimeType string) (string, error)
	UpdateFile(fileID string, content []byte) error
	DeleteFile(fileID string) error
	DownloadFile(fileID string) ([]byte, error)
	GetFileMetadata(fileID string) (*drive.File, error)

	CreateFolder(name string, parentID string) (string, error)

	ListFiles(query string) ([]*drive.File, error)

	GetFileID(fileName string, noteFolderID string, rootFolderID string) (string, error)
	FindLatestFile(files []*drive.File) *drive.File
	CleanupDuplicates(files []*drive.File, keepLatest bool) error

	// Changes API: 増分変更検出
	GetStartPageToken() (string, error)
	ListChanges(pageToken string) (*ChangesResult, error)
}

// DriveOperationsの実装
type driveOperationsImpl struct {
	service *drive.Service
	logger  AppLogger
}

// DriveOperationsインスタンスを作成
func NewDriveOperations(service *drive.Service, logger AppLogger) DriveOperations {
	return &driveOperationsImpl{
		service: service,
		logger:  logger,
	}
}

// ------------------------------------------------------------
// Google Driveファイル操作
// ------------------------------------------------------------

// ファイルを作成 (Driveネイティブ) ------------------------------------------------------------
func (d *driveOperationsImpl) CreateFile(name string, content []byte, parentID string, mimeType string) (string, error) {
	d.logger.Console("[GAPI] Creating file: %s", name)
	f := &drive.File{
		Name:     name,
		MimeType: mimeType,
	}
	if parentID != "" {
		f.Parents = []string{parentID}
	}

	file, err := d.service.Files.Create(f).Media(bytes.NewReader(content)).Fields("id").Do()
	if err != nil {
		return "", fmt.Errorf("failed to create file: %w", err)
	}

	return file.Id, nil
}

// ファイルを更新 (Driveネイティブ) ------------------------------------------------------------
func (d *driveOperationsImpl) UpdateFile(fileId string, content []byte) error {
	d.logger.Console("[GAPI] Updating file: %s", fileId)
	// ファイルを更新
	_, err := d.service.Files.Update(fileId, &drive.File{}).
		Media(bytes.NewReader(content)).
		Do()
	if err != nil {
		return fmt.Errorf("failed to update file: %w", err)
	}

	return nil
}

// ファイルを削除 (Driveネイティブ) ------------------------------------------------------------
func (d *driveOperationsImpl) DeleteFile(fileID string) error {
	d.logger.Console("[GAPI] Deleting file: %s", fileID)
	err := d.service.Files.Delete(fileID).Do()
	if err != nil {
		return fmt.Errorf("failed to delete file: %w", err)
	}
	return nil
}

// ファイルをダウンロード (Driveネイティブ) ------------------------------------------------------------
func (d *driveOperationsImpl) DownloadFile(fileID string) ([]byte, error) {
	d.logger.Console("[GAPI] Downloading file: %s", fileID)
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

func (d *driveOperationsImpl) GetFileMetadata(fileID string) (*drive.File, error) {
	d.logger.Console("[GAPI] Getting metadata: %s", fileID)
	file, err := d.service.Files.Get(fileID).
		Fields("id, name, modifiedTime, md5Checksum, version").
		Do()
	if err != nil {
		return nil, fmt.Errorf("failed to get file metadata: %w", err)
	}
	return file, nil
}

// フォルダを作成 (Driveネイティブ) ------------------------------------------------------------
func (d *driveOperationsImpl) CreateFolder(name string, rootFolderID string) (string, error) {
	d.logger.Console("[GAPI] Creating folder: %s", name)
	f := &drive.File{
		Name:     name,
		MimeType: "application/vnd.google-apps.folder",
	}
	if rootFolderID != "" {
		f.Parents = []string{rootFolderID}
	}

	folder, err := d.service.Files.Create(f).Fields("id").Do()
	if err != nil {
		return "", fmt.Errorf("failed to create folder: %w", err)
	}

	return folder.Id, nil
}

// ファイルを検索 (Driveネイティブ)
func (d *driveOperationsImpl) ListFiles(query string) ([]*drive.File, error) {
	d.logger.Console("[GAPI] Listing files: %s", query)
	files, err := d.service.Files.List().
		Q(query).
		Fields("files(id, name, createdTime, modifiedTime)").
		Do()
	if err != nil {
		return nil, fmt.Errorf("failed to list files: %w", err)
	}

	return files.Files, nil
}

// ------------------------------------------------------------
// ファイル管理ヘルパー
// ------------------------------------------------------------

// ファイル名からファイルIDを取得 ------------------------------------------------------------
func (d *driveOperationsImpl) GetFileID(fileName string, noteFolderID string, rootFolderID string) (string, error) {
	// rootFolderIDのバリデーション
	if rootFolderID == "" {
		return "", fmt.Errorf("rootFolderID is empty")
	}

	// noteFolderIDのバリデーション（ノートファイル用）
	if strings.Contains(fileName, ".json") && !strings.Contains(fileName, "noteList.json") && noteFolderID == "" {
		return "", fmt.Errorf("noteFolderID is empty for note file")
	}

	var fixedFileId string
	if strings.Contains(fileName, "noteList.json") {
		query := fmt.Sprintf("name='noteList.json' and '%s' in parents and trashed=false", rootFolderID)
		files, err := d.ListFiles(query)
		if err != nil {
			return "", fmt.Errorf("failed to list files for noteList.json in root folder %s: %w", rootFolderID, err)
		}
		if len(files) == 0 {
			return "", fmt.Errorf("noteList.json not found in root folder %s", rootFolderID)
		}
		fixedFileId = files[0].Id
	} else if strings.Contains(fileName, ".json") {
		query := fmt.Sprintf("name='%s' and '%s' in parents and trashed=false", fileName, noteFolderID)
		files, err := d.ListFiles(query)
		if err != nil {
			return "", fmt.Errorf("failed to list files in notes folder %s: %w", noteFolderID, err)
		}
		if len(files) == 0 {
			return "", fmt.Errorf("note file %s not found in folder %s", fileName, noteFolderID)
		}
		fixedFileId = files[0].Id
	} else {
		query := fmt.Sprintf("name='%s' and '%s' in parents and trashed=false", fileName, rootFolderID)
		files, err := d.ListFiles(query)
		if err != nil {
			return "", fmt.Errorf("failed to list files in root folder %s: %w", rootFolderID, err)
		}
		if len(files) == 0 {
			return "", fmt.Errorf("file %s not found in root folder %s", fileName, rootFolderID)
		}
		fixedFileId = files[0].Id
	}
	fmt.Println("GetFileID done: ", fileName, "id: ", fixedFileId)
	return fixedFileId, nil
}

// 複数のファイルから最新のものを返す ------------------------------------------------------------
func (d *driveOperationsImpl) FindLatestFile(files []*drive.File) *drive.File {
	if len(files) == 0 {
		return nil
	}
	if len(files) == 1 {
		return files[0]
	}

	sort.Slice(files, func(i, j int) bool {
		t1, err1 := time.Parse(time.RFC3339, files[i].ModifiedTime)
		t2, err2 := time.Parse(time.RFC3339, files[j].ModifiedTime)
		if err1 != nil || err2 != nil {
			return false
		}
		return t1.After(t2)
	})
	return files[0]
}

func (d *driveOperationsImpl) GetStartPageToken() (string, error) {
	d.logger.Console("[GAPI] GetStartPageToken")
	resp, err := d.service.Changes.GetStartPageToken().Do()
	if err != nil {
		return "", fmt.Errorf("failed to get start page token: %w", err)
	}
	return resp.StartPageToken, nil
}

func (d *driveOperationsImpl) ListChanges(pageToken string) (*ChangesResult, error) {
	d.logger.Console("[GAPI] ListChanges pageToken=%s", pageToken)
	var allChanges []*drive.Change
	nextToken := pageToken

	for {
		resp, err := d.service.Changes.List(nextToken).
			Fields("nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,parents,mimeType,modifiedTime))").
			PageSize(100).
			Do()
		if err != nil {
			return nil, fmt.Errorf("failed to list changes: %w", err)
		}

		allChanges = append(allChanges, resp.Changes...)

		if resp.NextPageToken == "" {
			return &ChangesResult{
				Changes:       allChanges,
				NewStartToken: resp.NewStartPageToken,
			}, nil
		}
		nextToken = resp.NextPageToken
	}
}

// 重複ファイルの整理 ------------------------------------------------------------
func (d *driveOperationsImpl) CleanupDuplicates(
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
