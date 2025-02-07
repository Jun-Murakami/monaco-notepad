package backend

import (
	"bytes"
	"fmt"
	"sort"
	"time"

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

	// ファイル管理ヘルパー
	EnsureFile(name string, parentID string, content []byte, mimeType string) (string, error)
	FindLatestFile(files []*drive.File) *drive.File
	CleanupDuplicates(files []*drive.File, keepLatest bool) error
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
// ファイル管理ヘルパー
// ------------------------------------------------------------

// ファイルの存在確認と作成/更新を行う
func (d *driveOperationsImpl) EnsureFile(
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
			latestFile := d.FindLatestFile(files)
			if err := d.CleanupDuplicates(files, true); err != nil {
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
func (d *driveOperationsImpl) FindLatestFile(files []*drive.File) *drive.File {
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