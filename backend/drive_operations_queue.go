package backend

import (
	"fmt"
	"sync"
	"time"

	"google.golang.org/api/drive/v3"
)

// OperationType は操作の種類を表す
type OperationType int

const (
	OpCreate OperationType = iota
	OpUpdate
	OpDelete
	OpDownload
	OpList
)

// Priority は操作の優先度を表す
type Priority int

const (
	PriorityHigh Priority = iota
	PriorityNormal
	PriorityLow
)

// QueuedOperation はキューに格納される操作を表す
type QueuedOperation struct {
	Type     OperationType
	Priority Priority
	FileID   string // ファイルIDを追加
	Execute  func() (interface{}, error)
	Result   chan *OperationResult
	AddedAt  time.Time // キューに追加された時刻
}

// OperationResult は操作の結果を表す
type OperationResult struct {
	Data  interface{}
	Error error
}

// DriveOperationsQueue はDriveOperationsのラッパー
type DriveOperationsQueue struct {
	driveOps   DriveOperations
	queue      chan *QueuedOperation
	pendingOps map[string][]*QueuedOperation // FileID毎の保留中の操作
	rateLimit  time.Duration
	lastOp     time.Time
	mu         sync.Mutex
	done       chan struct{} // 終了通知用
}

// NewDriveOperationsQueue は新しいDriveOperationsQueueを作成
func NewDriveOperationsQueue(driveOps DriveOperations) DriveOperations {
	q := &DriveOperationsQueue{
		driveOps:   driveOps,
		queue:      make(chan *QueuedOperation, 100),
		pendingOps: make(map[string][]*QueuedOperation),
		rateLimit:  time.Second * 2,
		done:       make(chan struct{}),
	}
	go q.processQueue()
	return q
}

// HasPendingOperations はキューにアイテムがあるかどうかを返す
func (q *DriveOperationsQueue) HasPendingOperations() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.pendingOps) > 0 || len(q.queue) > 0
}

// WaitForCompletion は全ての操作が完了するまで待機する
func (q *DriveOperationsQueue) WaitForCompletion(timeout time.Duration) bool {
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case <-timer.C:
			return false // タイムアウト
		default:
			if !q.HasPendingOperations() {
				return true // 完了
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
}

// Shutdown はキューを安全に終了する
func (q *DriveOperationsQueue) Shutdown() {
	close(q.done)
}

// cleanupOperations は指定されたファイルIDの古い操作を削除する
func (q *DriveOperationsQueue) cleanupOperations(fileID string, opType OperationType) {
	q.mu.Lock()
	defer q.mu.Unlock()

	if ops, exists := q.pendingOps[fileID]; exists {
		var newOps []*QueuedOperation
		for _, op := range ops {
			// Delete操作の場合は全ての操作を削除
			// Update操作の場合は古いUpdate操作のみを削除
			if opType == OpDelete || (opType == OpUpdate && op.Type == OpUpdate) {
				continue
			}
			newOps = append(newOps, op)
		}
		if len(newOps) > 0 {
			q.pendingOps[fileID] = newOps
		} else {
			delete(q.pendingOps, fileID)
		}
	}
}

// processQueue はキューの処理を行う
func (q *DriveOperationsQueue) processQueue() {
	for {
		select {
		case <-q.done:
			return
		case op := <-q.queue:
			// レート制限の適用
			q.mu.Lock()
			if elapsed := time.Since(q.lastOp); elapsed < q.rateLimit {
				time.Sleep(q.rateLimit - elapsed)
			}
			q.mu.Unlock()

			// 操作の実行前にクリーンアップ
			if op.FileID != "" {
				q.cleanupOperations(op.FileID, op.Type)
			}

			result, err := op.Execute()

			q.mu.Lock()
			q.lastOp = time.Now()
			q.mu.Unlock()

			op.Result <- &OperationResult{Data: result, Error: err}

			// 操作完了後に保留中リストから削除
			if op.FileID != "" {
				q.mu.Lock()
				if ops, exists := q.pendingOps[op.FileID]; exists {
					for i, pendingOp := range ops {
						if pendingOp == op {
							ops = append(ops[:i], ops[i+1:]...)
							break
						}
					}
					if len(ops) > 0 {
						q.pendingOps[op.FileID] = ops
					} else {
						delete(q.pendingOps, op.FileID)
					}
				}
				q.mu.Unlock()
			}
		}
	}
}

// キューの状態をログ出力する関数を追加
func (q *DriveOperationsQueue) logQueueState(newOp *QueuedOperation) {
	q.mu.Lock()
	defer q.mu.Unlock()

	timestamp := time.Now().Format("2006/01/02 15:04:05")

	// 現在のキュー内容を文字列化
	var queueInfo string
	if len(q.pendingOps) == 0 {
		queueInfo = "空"
	} else {
		queueInfo = "["
		for fileID, ops := range q.pendingOps {
			queueInfo += fmt.Sprintf("\n  %s: ", fileID)
			for i, op := range ops {
				opType := ""
				switch op.Type {
				case OpCreate:
					opType = "作成"
				case OpUpdate:
					opType = "更新"
				case OpDelete:
					opType = "削除"
				case OpDownload:
					opType = "ダウンロード"
				case OpList:
					opType = "一覧"
				}
				queueInfo += fmt.Sprintf("%s", opType)
				if i < len(ops)-1 {
					queueInfo += ", "
				}
			}
		}
		queueInfo += "\n]"
	}

	// 新しい操作の種類を文字列化
	newOpType := ""
	switch newOp.Type {
	case OpCreate:
		newOpType = "作成"
	case OpUpdate:
		newOpType = "更新"
	case OpDelete:
		newOpType = "削除"
	case OpDownload:
		newOpType = "ダウンロード"
	case OpList:
		newOpType = "一覧"
	}

	fmt.Printf("%s キュー追加: %s (FileID: %s)\n現在のキュー: %s\n",
		timestamp,
		newOpType,
		newOp.FileID,
		queueInfo)
}

// enqueueOperationを修正
func (q *DriveOperationsQueue) enqueueOperation(
	opType OperationType,
	fileID string,
	execute func() (interface{}, error),
) (interface{}, error) {
	op := &QueuedOperation{
		Type:    opType,
		FileID:  fileID,
		Execute: execute,
		Result:  make(chan *OperationResult, 1),
		AddedAt: time.Now(),
	}

	q.mu.Lock()
	if opType == OpUpdate && fileID != "" {
		q.cleanupOperations(fileID, opType)
	}
	if _, exists := q.pendingOps[fileID]; !exists {
		q.pendingOps[fileID] = []*QueuedOperation{}
	}
	q.pendingOps[fileID] = append(q.pendingOps[fileID], op)
	q.mu.Unlock()

	// キューの状態をログ出力
	q.logQueueState(op)

	// Update操作の場合は遅延を追加
	if opType == OpUpdate {
		time.Sleep(3 * time.Second)
	}

	q.queue <- op

	opResult := <-op.Result
	return opResult.Data, opResult.Error
}

// DriveOperationsインターフェースの実装

func (q *DriveOperationsQueue) CreateFile(name string, content []byte, parentID string, mimeType string) (string, error) {
	result, err := q.enqueueOperation(OpCreate, name, func() (interface{}, error) {
		return q.driveOps.CreateFile(name, content, parentID, mimeType)
	})
	if err != nil {
		return "", err
	}
	return result.(string), nil
}

func (q *DriveOperationsQueue) UpdateFile(fileID string, content []byte) error {
	_, err := q.enqueueOperation(OpUpdate, fileID, func() (interface{}, error) {
		return nil, q.driveOps.UpdateFile(fileID, content)
	})
	return err
}

func (q *DriveOperationsQueue) DeleteFile(fileID string) error {
	_, err := q.enqueueOperation(OpDelete, fileID, func() (interface{}, error) {
		return nil, q.driveOps.DeleteFile(fileID)
	})
	return err
}

func (q *DriveOperationsQueue) DownloadFile(fileID string) ([]byte, error) {
	result, err := q.enqueueOperation(OpDownload, fileID, func() (interface{}, error) {
		return q.driveOps.DownloadFile(fileID)
	})
	if err != nil {
		return nil, err
	}
	return result.([]byte), nil
}

func (q *DriveOperationsQueue) CreateFolder(name string, parentID string) (string, error) {
	result, err := q.enqueueOperation(OpCreate, name, func() (interface{}, error) {
		return q.driveOps.CreateFolder(name, parentID)
	})
	if err != nil {
		return "", err
	}
	return result.(string), nil
}

func (q *DriveOperationsQueue) ListFiles(query string) ([]*drive.File, error) {
	result, err := q.enqueueOperation(OpList, query, func() (interface{}, error) {
		return q.driveOps.ListFiles(query)
	})
	if err != nil {
		return nil, err
	}
	return result.([]*drive.File), nil
}

func (q *DriveOperationsQueue) GetFileID(fileName string, noteFolderID string, rootFolderID string) (string, error) {
	result, err := q.enqueueOperation(OpList, fileName, func() (interface{}, error) {
		return q.driveOps.GetFileID(fileName, noteFolderID, rootFolderID)
	})
	if err != nil {
		return "", err
	}
	return result.(string), nil
}

// 以下のメソッドはキューを通さない（同期的な処理）
func (q *DriveOperationsQueue) FindLatestFile(files []*drive.File) *drive.File {
	return q.driveOps.FindLatestFile(files)
}

func (q *DriveOperationsQueue) CleanupDuplicates(files []*drive.File, keepLatest bool) error {
	_, err := q.enqueueOperation(OpDelete, "", func() (interface{}, error) {
		return nil, q.driveOps.CleanupDuplicates(files, keepLatest)
	})
	return err
}
