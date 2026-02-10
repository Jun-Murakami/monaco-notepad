package backend

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"google.golang.org/api/drive/v3"
)

// ErrOperationCancelled はキュー操作がキャンセルされた場合のセンチネルエラー
var ErrOperationCancelled = errors.New("operation cancelled")

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
	mapKey        string             // マップ操作用の安定キー（enqueue時に確定）
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
	items      map[string][]*QueueItem // mapKeyごとのキューアイテム
	mutex      sync.RWMutex
	ctx        context.Context
	cancel     context.CancelFunc
	closed     bool
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

func (q *DriveOperationsQueue) processQueue() {
	for {
		select {
		case <-q.ctx.Done():
			return
		case item, ok := <-q.queue:
			if !ok {
				return
			}
			err := q.executeOperation(item)
			item.Result <- err

			q.mutex.Lock()
			q.removeItemFromMap(item)
			q.mutex.Unlock()
		}
	}
}

// executeOperation は実際のDrive I/Oを実行する（mutex外で呼ばれる）
func (q *DriveOperationsQueue) executeOperation(item *QueueItem) error {
	switch item.OperationType {
	case CreateOperation:
		fileID, err := q.operations.CreateFile(item.FileName, item.Content, item.ParentID, item.MimeType)
		if fileID != "" {
			item.FileID = fileID
		}
		if err != nil {
			return fmt.Errorf("failed to create file: %w", err)
		}
	case UpdateOperation:
		if err := q.operations.UpdateFile(item.FileID, item.Content); err != nil {
			return err
		}
	case DeleteOperation:
		if err := q.operations.DeleteFile(item.FileID); err != nil {
			return err
		}
	case DownloadOperation:
		content, err := q.operations.DownloadFile(item.FileID)
		if err != nil {
			return fmt.Errorf("failed to download file: %w", err)
		}
		item.Content = content
	case ListOperation:
		files, err := q.operations.ListFiles(item.Query)
		item.ListResult <- files // エラー時もnil送信（デッドロック防止）
		if err != nil {
			return fmt.Errorf("failed to list files: %w", err)
		}
	case GetFileOperation:
		fileID, err := q.operations.GetFileID(item.FileName, item.NoteFolderID, item.RootFolderID)
		item.GetFileResult <- fileID // エラー時も""送信（デッドロック防止）
		if err != nil {
			return fmt.Errorf("failed to get file ID: %w", err)
		}
	}
	return nil
}

// computeMapKey はenqueue時にマップキーを確定させる
// CREATE操作はFileIDが空のため fileName+parentID を使用し、それ以外はFileIDを使用する
func computeMapKey(item *QueueItem) string {
	if item.OperationType == CreateOperation {
		return "create:" + item.FileName + ":" + item.ParentID
	}
	return item.FileID
}

// キューにアイテムを追加
func (q *DriveOperationsQueue) addToQueue(item *QueueItem) {
	q.mutex.Lock()
	defer q.mutex.Unlock()

	if q.closed {
		item.Result <- ErrOperationCancelled
		return
	}

	// mapKeyをenqueue時に確定させる
	item.mapKey = computeMapKey(item)

	// Deleteの場合は同じmapKeyの既存のキューをすべて破棄
	if item.OperationType == DeleteOperation {
		q.removeExistingItems(item.mapKey)
	}

	// Updateの場合は同じmapKeyの古いUpdateキューを破棄
	if item.OperationType == UpdateOperation {
		if q.hasUpdateQueueForFile(item.mapKey) {
			q.removeOldUpdateItems(item.mapKey)
			go q.delayedEnqueue(item)
			q.items[item.mapKey] = append(q.items[item.mapKey], item)
			return
		}
	}

	// キューマップに追加
	q.items[item.mapKey] = append(q.items[item.mapKey], item)

	// Updateの場合は3秒待ってからキューに追加
	if item.OperationType == UpdateOperation {
		go q.delayedEnqueue(item)
	} else {
		select {
		case <-q.ctx.Done():
			item.Result <- ErrOperationCancelled
			q.removeItemFromMap(item)
		case q.queue <- item:
		}
	}
}

// delayedEnqueue はデバウンス遅延後にアイテムをキューに送信する
func (q *DriveOperationsQueue) delayedEnqueue(item *QueueItem) {
	time.Sleep(3 * time.Second)

	// ctx.Done()をチェックしてCleanup後のpanicを防止 (C-5)
	select {
	case <-q.ctx.Done():
		item.Result <- ErrOperationCancelled
		return
	default:
	}

	q.mutex.Lock()
	defer q.mutex.Unlock()

	if q.closed {
		item.Result <- ErrOperationCancelled
		q.removeItemFromMap(item)
		return
	}

	if !q.hasNewerUpdateQueueForFile(item.mapKey, item.CreatedAt) {
		select {
		case q.queue <- item:
		case <-q.ctx.Done():
			item.Result <- ErrOperationCancelled
			q.removeItemFromMap(item)
		}
	} else {
		item.Result <- ErrOperationCancelled
		q.removeItemFromMap(item)
	}
}

func (q *DriveOperationsQueue) hasUpdateQueueForFile(mapKey string) bool {
	items, exists := q.items[mapKey]
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

func (q *DriveOperationsQueue) hasNewerUpdateQueueForFile(mapKey string, createdAt time.Time) bool {
	items, exists := q.items[mapKey]
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

func (q *DriveOperationsQueue) removeOldUpdateItems(mapKey string) {
	if items, exists := q.items[mapKey]; exists {
		var newItems []*QueueItem
		for _, item := range items {
			if item.OperationType == UpdateOperation {
				item.Result <- ErrOperationCancelled
			} else {
				newItems = append(newItems, item)
			}
		}
		q.items[mapKey] = newItems
	}
}

func (q *DriveOperationsQueue) removeExistingItems(mapKey string) {
	if items, exists := q.items[mapKey]; exists {
		for _, item := range items {
			item.Result <- ErrOperationCancelled
		}
		delete(q.items, mapKey)
	}
}

func (q *DriveOperationsQueue) removeItemFromMap(item *QueueItem) {
	items := q.items[item.mapKey]
	var newItems []*QueueItem
	for _, i := range items {
		if i != item {
			newItems = append(newItems, i)
		}
	}
	if len(newItems) == 0 {
		delete(q.items, item.mapKey)
	} else {
		q.items[item.mapKey] = newItems
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

func (q *DriveOperationsQueue) Cleanup() {
	q.mutex.Lock()
	q.closed = true
	q.mutex.Unlock()

	q.cancel()
	// 遅延goroutineがctx.Done()を検知して停止するのを待つ
	time.Sleep(100 * time.Millisecond)
	// 残留アイテムを排出してからチャネルを閉じる
	q.mutex.Lock()
	for key, items := range q.items {
		for _, item := range items {
			select {
			case item.Result <- ErrOperationCancelled:
			default:
			}
		}
		delete(q.items, key)
	}
	q.mutex.Unlock()
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
	files := <-listResult
	if err != nil {
		return nil, err
	}
	return files, nil
}

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
	fileID := <-getFileResult
	if err != nil {
		return "", err
	}
	return fileID, nil
}

func (q *DriveOperationsQueue) GetFileMetadata(fileID string) (*drive.File, error) {
	return q.operations.GetFileMetadata(fileID)
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

func (q *DriveOperationsQueue) GetStartPageToken() (string, error) {
	return q.operations.GetStartPageToken()
}

func (q *DriveOperationsQueue) ListChanges(pageToken string) (*ChangesResult, error) {
	return q.operations.ListChanges(pageToken)
}
