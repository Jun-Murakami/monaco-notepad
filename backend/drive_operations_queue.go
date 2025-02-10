package backend

import (
	"context"
	"fmt"
	"sync"
	"time"

	"google.golang.org/api/drive/v3"
)

// キューアイテムの種類を定義
type QueueOperationType string

const (
	CreateOperation   QueueOperationType = "CREATE"
	UpdateOperation   QueueOperationType = "UPDATE"
	DeleteOperation   QueueOperationType = "DELETE"
	DownloadOperation QueueOperationType = "DOWNLOAD"
	ListOperation     QueueOperationType = "LIST"
	GetFileOperation  QueueOperationType = "GET_FILE"
)

// キューアイテムの構造体
type QueueItem struct {
	OperationType QueueOperationType
	FileID        string
	FileName      string
	Content       []byte
	ParentID      string
	MimeType      string
	CreatedAt     time.Time
	Result        chan error
	// 追加のフィールド
	Query         string             // ListFiles用
	NoteFolderID  string             // GetFileID用
	RootFolderID  string             // GetFileID用
	ListResult    chan []*drive.File // ListFiles用の結果チャネル
	GetFileResult chan string        // GetFileID用の結果チャネル
}

// DriveOperationsQueueの構造体
type DriveOperationsQueue struct {
	operations DriveOperations
	queue      chan *QueueItem
	items      map[string][]*QueueItem // FileIDごとのキューアイテム
	mutex      sync.RWMutex
	ctx        context.Context
	cancel     context.CancelFunc
}

// NewDriveOperationsQueueはキューシステムを作成
func NewDriveOperationsQueue(operations DriveOperations) *DriveOperationsQueue {
	ctx, cancel := context.WithCancel(context.Background())
	q := &DriveOperationsQueue{
		operations: operations,
		queue:      make(chan *QueueItem, 100),
		items:      make(map[string][]*QueueItem),
		ctx:        ctx,
		cancel:     cancel,
	}
	go q.processQueue()
	return q
}

// キューの処理を開始
func (q *DriveOperationsQueue) processQueue() {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-q.ctx.Done():
			return
		case <-ticker.C:
			q.processNextItem()
		}
	}
}

// 次のキューアイテムを処理
func (q *DriveOperationsQueue) processNextItem() {
	q.mutex.Lock()
	defer q.mutex.Unlock()

	select {
	case item := <-q.queue:
		var err error
		switch item.OperationType {
		case CreateOperation:
			fileID, createErr := q.operations.CreateFile(item.FileName, item.Content, item.ParentID, item.MimeType)
			if createErr != nil {
				err = fmt.Errorf("failed to create file: %w", createErr)
			}
			if fileID != "" {
				item.FileID = fileID
			}
		case UpdateOperation:
			err = q.operations.UpdateFile(item.FileID, item.Content)
		case DeleteOperation:
			err = q.operations.DeleteFile(item.FileID)
		case DownloadOperation:
			content, downloadErr := q.operations.DownloadFile(item.FileID)
			if downloadErr != nil {
				err = fmt.Errorf("failed to download file: %w", downloadErr)
			}
			item.Content = content
		case ListOperation:
			files, listErr := q.operations.ListFiles(item.Query)
			if listErr != nil {
				err = fmt.Errorf("failed to list files: %w", listErr)
			} else {
				item.ListResult <- files
			}
		case GetFileOperation:
			fileID, getErr := q.operations.GetFileID(item.FileName, item.NoteFolderID, item.RootFolderID)
			if getErr != nil {
				err = fmt.Errorf("failed to get file ID: %w", getErr)
			} else {
				item.GetFileResult <- fileID
			}
		}
		item.Result <- err
		q.removeItemFromMap(item)
	default:
		// キューが空の場合は何もしない
	}
}

// キューにアイテムを追加
func (q *DriveOperationsQueue) addToQueue(item *QueueItem) {
	q.mutex.Lock()
	defer q.mutex.Unlock()

	// Deleteの場合は同じFileIDの既存のキューをすべて破棄
	if item.OperationType == DeleteOperation {
		q.removeExistingItems(item.FileID)
	}

	// Updateの場合は同じFileIDの古いUpdateキューを破棄
	if item.OperationType == UpdateOperation {
		// 既存のUpdateキューがある場合は、そのキューをキャンセルして新しいキューに置き換える
		if q.hasUpdateQueueForFile(item.FileID) {
			q.removeOldUpdateItems(item.FileID)
			// 3秒待ってからキューに追加
			go func() {
				time.Sleep(3 * time.Second)
				q.mutex.Lock()
				defer q.mutex.Unlock()
				// 再度チェック（この間に新しいUpdateが来ている可能性がある）
				if !q.hasNewerUpdateQueueForFile(item.FileID, item.CreatedAt) {
					q.queue <- item
				} else {
					item.Result <- fmt.Errorf("operation cancelled due to newer update operation")
					q.removeItemFromMap(item)
				}
			}()
			// キューマップには即座に追加
			q.items[item.FileID] = append(q.items[item.FileID], item)
			return
		}
	}

	// キューマップに追加
	q.items[item.FileID] = append(q.items[item.FileID], item)

	// Updateの場合は3秒待ってからキューに追加
	if item.OperationType == UpdateOperation {
		go func() {
			time.Sleep(3 * time.Second)
			q.mutex.Lock()
			defer q.mutex.Unlock()
			// 再度チェック（この間に新しいUpdateが来ている可能性がある）
			if !q.hasNewerUpdateQueueForFile(item.FileID, item.CreatedAt) {
				q.queue <- item
			} else {
				item.Result <- fmt.Errorf("operation cancelled due to newer update operation")
				q.removeItemFromMap(item)
			}
		}()
	} else {
		q.queue <- item
	}
}

// 指定されたファイルIDに対するUpdateキューが存在するかチェック
func (q *DriveOperationsQueue) hasUpdateQueueForFile(fileID string) bool {
	items, exists := q.items[fileID]
	if !exists {
		return false
	}
	for _, item := range items {
		if item.OperationType == UpdateOperation {
			return true
		}
	}
	return false
}

// 指定されたファイルIDに対して、より新しいUpdateキューが存在するかチェック
func (q *DriveOperationsQueue) hasNewerUpdateQueueForFile(fileID string, createdAt time.Time) bool {
	items, exists := q.items[fileID]
	if !exists {
		return false
	}
	for _, item := range items {
		if item.OperationType == UpdateOperation && item.CreatedAt.After(createdAt) {
			return true
		}
	}
	return false
}

// 古いUpdateキューを削除
func (q *DriveOperationsQueue) removeOldUpdateItems(fileID string) {
	if items, exists := q.items[fileID]; exists {
		var newItems []*QueueItem
		for _, item := range items {
			if item.OperationType == UpdateOperation {
				item.Result <- fmt.Errorf("operation cancelled due to new update operation")
			} else {
				newItems = append(newItems, item)
			}
		}
		q.items[fileID] = newItems
	}
}

// 既存のキューアイテムを削除
func (q *DriveOperationsQueue) removeExistingItems(fileID string) {
	if items, exists := q.items[fileID]; exists {
		for _, item := range items {
			item.Result <- fmt.Errorf("operation cancelled due to delete operation")
		}
		delete(q.items, fileID)
	}
}

// キューマップからアイテムを削除
func (q *DriveOperationsQueue) removeItemFromMap(item *QueueItem) {
	items := q.items[item.FileID]
	var newItems []*QueueItem
	for _, i := range items {
		if i != item {
			newItems = append(newItems, i)
		}
	}
	if len(newItems) == 0 {
		delete(q.items, item.FileID)
	} else {
		q.items[item.FileID] = newItems
	}
}

// キューにアイテムがあるかどうかを確認
func (q *DriveOperationsQueue) HasItems() bool {
	q.mutex.RLock()
	defer q.mutex.RUnlock()
	return len(q.items) > 0
}

// キューが空になるまで待機（タイムアウト付き）
func (q *DriveOperationsQueue) WaitForEmpty(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !q.HasItems() {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

// キューをクリーンアップ
func (q *DriveOperationsQueue) Cleanup() {
	q.cancel()
	close(q.queue)
}

// DriveOperationsのラッパーメソッド
func (q *DriveOperationsQueue) CreateFile(name string, content []byte, parentID string, mimeType string) (string, error) {
	result := make(chan error, 1)
	item := &QueueItem{
		OperationType: CreateOperation,
		FileName:      name,
		Content:       content,
		ParentID:      parentID,
		MimeType:      mimeType,
		CreatedAt:     time.Now(),
		Result:        result,
	}
	q.addToQueue(item)
	err := <-result
	return item.FileID, err
}

func (q *DriveOperationsQueue) UpdateFile(fileID string, content []byte) error {
	result := make(chan error, 1)
	item := &QueueItem{
		OperationType: UpdateOperation,
		FileID:        fileID,
		Content:       content,
		CreatedAt:     time.Now(),
		Result:        result,
	}
	q.addToQueue(item)
	return <-result
}

func (q *DriveOperationsQueue) DeleteFile(fileID string) error {
	result := make(chan error, 1)
	item := &QueueItem{
		OperationType: DeleteOperation,
		FileID:        fileID,
		CreatedAt:     time.Now(),
		Result:        result,
	}
	q.addToQueue(item)
	return <-result
}

func (q *DriveOperationsQueue) DownloadFile(fileID string) ([]byte, error) {
	result := make(chan error, 1)
	item := &QueueItem{
		OperationType: DownloadOperation,
		FileID:        fileID,
		CreatedAt:     time.Now(),
		Result:        result,
	}
	q.addToQueue(item)
	err := <-result
	return item.Content, err
}

// ListFilesをキューで処理
func (q *DriveOperationsQueue) ListFiles(query string) ([]*drive.File, error) {
	result := make(chan error, 1)
	listResult := make(chan []*drive.File, 1)
	item := &QueueItem{
		OperationType: ListOperation,
		Query:         query,
		CreatedAt:     time.Now(),
		Result:        result,
		ListResult:    listResult,
	}
	q.addToQueue(item)
	err := <-result
	if err != nil {
		return nil, err
	}
	return <-listResult, nil
}

// GetFileIDをキューで処理
func (q *DriveOperationsQueue) GetFileID(fileName string, noteFolderID string, rootFolderID string) (string, error) {
	result := make(chan error, 1)
	getFileResult := make(chan string, 1)
	item := &QueueItem{
		OperationType: GetFileOperation,
		FileName:      fileName,
		NoteFolderID:  noteFolderID,
		RootFolderID:  rootFolderID,
		CreatedAt:     time.Now(),
		Result:        result,
		GetFileResult: getFileResult,
	}
	q.addToQueue(item)
	err := <-result
	if err != nil {
		return "", err
	}
	return <-getFileResult, nil
}

// FindLatestFileは直接委譲（ローカル処理のため）
func (q *DriveOperationsQueue) FindLatestFile(files []*drive.File) *drive.File {
	return q.operations.FindLatestFile(files)
}

// CreateFolderは直接委譲（初期化時のみ使用）
func (q *DriveOperationsQueue) CreateFolder(name string, parentID string) (string, error) {
	return q.operations.CreateFolder(name, parentID)
}

// CleanupDuplicatesは直接委譲（初期化時のみ使用）
func (q *DriveOperationsQueue) CleanupDuplicates(files []*drive.File, keepLatest bool) error {
	return q.operations.CleanupDuplicates(files, keepLatest)
}
