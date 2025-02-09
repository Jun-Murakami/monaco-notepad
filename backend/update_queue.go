package backend

import (
	"fmt"
	"sync"
	"time"
)

// 操作タイプの定義
type OperationType string

const (
	OpCreate  OperationType = "CREATE"
	OpUpdate  OperationType = "UPDATE"
	OpDelete  OperationType = "DELETE"
	OpReorder OperationType = "REORDER"
)

// 更新操作の構造体
type UpdateOperation struct {
	Type      OperationType `json:"type"`
	NoteID    string        `json:"noteId"`
	Content   interface{}   `json:"content"`
	Timestamp string        `json:"timestamp"`
}

// 更新キューの構造体
type UpdateQueue struct {
	app           *App // 既存のAppへの参照
	operations    []UpdateOperation
	mutex         sync.Mutex
	flushTimer    *time.Timer
	batchInterval time.Duration
	logger        DriveLogger
	debugMode     bool // デバッグモードフラグ
}

// ------------------------------------------------------------
// ※ デバッグモードをtrueにすると最適化が無効になります
// ------------------------------------------------------------

// 新しい更新キューを作成
func NewUpdateQueue(app *App, logger DriveLogger) *UpdateQueue {
	queue := &UpdateQueue{
		app:           app,
		operations:    make([]UpdateOperation, 0),
		batchInterval: 5 * time.Second,
		logger:        logger,
		debugMode:     false, // デバッグモードを有効化（必要に応じて設定）
	}
	return queue
}

// 操作をキューに追加
func (q *UpdateQueue) QueueOperation(op UpdateOperation) error {
	q.mutex.Lock()
	defer q.mutex.Unlock()

	// タイムスタンプを検証
	if _, err := time.Parse(time.RFC3339, op.Timestamp); err != nil {
		q.logger.Console("Warning: Invalid timestamp format: %v", err)
	}

	q.logger.Console("Queuing operation: %s for note %s", op.Type, op.NoteID)
	q.operations = append(q.operations, op)

	// フラッシュタイマーをリセット
	if q.flushTimer != nil {
		q.flushTimer.Stop()
	}
	q.flushTimer = time.AfterFunc(q.batchInterval, q.Flush)

	return nil
}

// キューをフラッシュして操作を実行
func (q *UpdateQueue) Flush() {
	q.mutex.Lock()
	operations := q.operations
	q.operations = make([]UpdateOperation, 0)
	q.mutex.Unlock()

	if len(operations) == 0 {
		return
	}

	q.logger.Console("Flushing %d operations", len(operations))

	var targetOps []UpdateOperation
	if q.debugMode {
		// デバッグモード時は最適化をスキップ
		q.logger.Console("Debug mode: skipping optimization")
		targetOps = operations
	} else {
		// 通常モード時は操作を最適化
		targetOps = q.optimizeOperations(operations)
		q.logger.Console("Optimized to %d operations", len(targetOps))
	}

	// バッチ処理として実行
	for _, op := range targetOps {
		var err error
		switch op.Type {
		case OpCreate:
			if noteMap, ok := op.Content.(map[string]interface{}); ok {
				note := &Note{}
				if modifiedTime, ok := noteMap["modifiedTime"].(string); ok {
					if t, err := time.Parse(time.RFC3339, modifiedTime); err == nil {
						note.ModifiedTime = t
					}
				}
				if id, ok := noteMap["id"].(string); ok {
					note.ID = id
				}
				if title, ok := noteMap["title"].(string); ok {
					note.Title = title
				}
				if content, ok := noteMap["content"]; ok {
					if content == nil {
						note.Content = ""
					} else if contentStr, ok := content.(string); ok {
						note.Content = contentStr
					}
				}
				if contentHeader, ok := noteMap["contentHeader"]; ok {
					if contentHeader == nil {
						note.ContentHeader = ""
					} else if contentHeaderStr, ok := contentHeader.(string); ok {
						note.ContentHeader = contentHeaderStr
					}
				}
				if language, ok := noteMap["language"].(string); ok {
					note.Language = language
				}
				if archived, ok := noteMap["archived"].(bool); ok {
					note.Archived = archived
				}
				if order, ok := noteMap["order"].(float64); ok {
					note.Order = int(order)
				}
				err = q.app.CreateNote(note)
			}
		case OpUpdate:
			if noteMap, ok := op.Content.(map[string]interface{}); ok {
				note := &Note{}
				if modifiedTime, ok := noteMap["modifiedTime"].(string); ok {
					if t, err := time.Parse(time.RFC3339, modifiedTime); err == nil {
						note.ModifiedTime = t
					}
				}
				if id, ok := noteMap["id"].(string); ok {
					note.ID = id
				}
				if title, ok := noteMap["title"].(string); ok {
					note.Title = title
				}
				if content, ok := noteMap["content"]; ok {
					if content == nil {
						note.Content = ""
					} else if contentStr, ok := content.(string); ok {
						note.Content = contentStr
					}
				}
				if contentHeader, ok := noteMap["contentHeader"]; ok {
					if contentHeader == nil {
						note.ContentHeader = ""
					} else if contentHeaderStr, ok := contentHeader.(string); ok {
						note.ContentHeader = contentHeaderStr
					}
				}
				if language, ok := noteMap["language"].(string); ok {
					note.Language = language
				}
				if archived, ok := noteMap["archived"].(bool); ok {
					note.Archived = archived
				}
				if order, ok := noteMap["order"].(float64); ok {
					note.Order = int(order)
				}
				err = q.app.UpdateNote(note)
			}
		case OpDelete:
			err = q.app.DeleteNote(op.NoteID)
		case OpReorder:
			if notesData, ok := op.Content.([]interface{}); ok {
				notes := make([]Note, len(notesData))
				for i, noteData := range notesData {
					if noteMap, ok := noteData.(map[string]interface{}); ok {
						if modifiedTime, ok := noteMap["modifiedTime"].(string); ok {
							if t, err := time.Parse(time.RFC3339, modifiedTime); err == nil {
								notes[i].ModifiedTime = t
							}
						}
						if id, ok := noteMap["id"].(string); ok {
							notes[i].ID = id
						}
						if title, ok := noteMap["title"].(string); ok {
							notes[i].Title = title
						}
						if content, ok := noteMap["content"]; ok {
							if content == nil {
								notes[i].Content = ""
							} else if contentStr, ok := content.(string); ok {
								notes[i].Content = contentStr
							}
						}
						if contentHeader, ok := noteMap["contentHeader"]; ok {
							if contentHeader == nil {
								notes[i].ContentHeader = ""
							} else if contentHeaderStr, ok := contentHeader.(string); ok {
								notes[i].ContentHeader = contentHeaderStr
							}
						}
						if language, ok := noteMap["language"].(string); ok {
							notes[i].Language = language
						}
						if archived, ok := noteMap["archived"].(bool); ok {
							notes[i].Archived = archived
						}
						if order, ok := noteMap["order"].(float64); ok {
							notes[i].Order = int(order)
						}
					}
				}
				err = q.app.ReorderNotes(notes)
			}
		}

		if err != nil {
			q.logger.Error(err, fmt.Sprintf("Failed to process operation %s for note %s", op.Type, op.NoteID))
		}
	}
}

// 操作の最適化
func (q *UpdateQueue) optimizeOperations(ops []UpdateOperation) []UpdateOperation {
	// ノートIDごとにグループ化
	noteOps := make(map[string][]UpdateOperation)
	for _, op := range ops {
		noteOps[op.NoteID] = append(noteOps[op.NoteID], op)
	}

	var result []UpdateOperation

	// 各ノートの操作を最適化
	for _, ops := range noteOps {
		optimized := q.optimizeNoteOperations(ops)
		result = append(result, optimized...)
	}

	return result
}

// 単一ノートの操作を最適化
func (q *UpdateQueue) optimizeNoteOperations(ops []UpdateOperation) []UpdateOperation {
	if len(ops) == 0 {
		return nil
	}

	// 最新の操作のみを保持する単純な最適化
	latestOp := ops[len(ops)-1]

	// 削除操作が含まれている場合、それ以前の操作は無視
	for _, op := range ops {
		if op.Type == OpDelete {
			return []UpdateOperation{op}
		}
	}

	// それ以外の場合は最新の操作のみを返す
	return []UpdateOperation{latestOp}
}

// デバッグモードの設定を変更
func (q *UpdateQueue) SetDebugMode(enabled bool) {
	q.mutex.Lock()
	defer q.mutex.Unlock()
	q.debugMode = enabled
	q.logger.Console("Debug mode %s", map[bool]string{true: "enabled", false: "disabled"}[enabled])
}
