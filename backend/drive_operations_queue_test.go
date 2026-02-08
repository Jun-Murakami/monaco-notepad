package backend

import (
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"google.golang.org/api/drive/v3"
)

type blockingDriveOps struct {
	*mockDriveOperations
	blockCh   chan struct{}
	startedCh chan struct{}
}

func newBlockingDriveOps() *blockingDriveOps {
	return &blockingDriveOps{
		mockDriveOperations: newMockDriveOperations(),
		blockCh:             make(chan struct{}),
		startedCh:           make(chan struct{}, 10),
	}
}

func (b *blockingDriveOps) CreateFile(name string, content []byte, rootFolderID string, mimeType string) (string, error) {
	b.startedCh <- struct{}{}
	<-b.blockCh
	return b.mockDriveOperations.CreateFile(name, content, rootFolderID, mimeType)
}

type errorableDriveOps struct {
	*mockDriveOperations
	listFilesErr error
	getFileIDErr error
}

func newErrorableDriveOps() *errorableDriveOps {
	return &errorableDriveOps{
		mockDriveOperations: newMockDriveOperations(),
	}
}

func (e *errorableDriveOps) ListFiles(query string) ([]*drive.File, error) {
	if e.listFilesErr != nil {
		return nil, e.listFilesErr
	}
	return e.mockDriveOperations.ListFiles(query)
}

func (e *errorableDriveOps) GetFileID(fileName string, noteFolderID string, rootFolderID string) (string, error) {
	if e.getFileIDErr != nil {
		return "", e.getFileIDErr
	}
	return e.mockDriveOperations.GetFileID(fileName, noteFolderID, rootFolderID)
}

// --- テスト ---

// TestQueue_BasicCreateFile はキューの基本動作を検証
func TestQueue_BasicCreateFile(t *testing.T) {
	ops := newMockDriveOperations()
	q := NewDriveOperationsQueue(ops)
	defer q.Cleanup()

	done := make(chan struct{})
	go func() {
		fileID, err := q.CreateFile("test.json", []byte(`{"id":"test"}`), "folder-id", "application/json")
		assert.NoError(t, err)
		assert.NotEmpty(t, fileID)
		close(done)
	}()

	select {
	case <-done:
		// OK
	case <-time.After(5 * time.Second):
		t.Fatal("BasicCreateFile timed out")
	}
}

// TestQueue_HasItemsNotBlockedByProcessing は processNextItem が I/O中に
// mutexを保持していないことを検証する。
//
// バグ: processNextItem() が mutex.Lock() を defer で保持したまま
// DriveOperations のネットワークI/Oを実行するため、HasItems() など
// RLockが必要な操作がI/O完了までブロックされる。
func TestQueue_HasItemsNotBlockedByProcessing(t *testing.T) {
	ops := newBlockingDriveOps()
	q := NewDriveOperationsQueue(ops)
	defer func() {
		close(ops.blockCh) // ブロック中のオペレーションを解放
		time.Sleep(200 * time.Millisecond)
		q.Cleanup()
	}()

	// ブロックするオペレーションをキューに追加
	go q.CreateFile("slow.json", []byte("data"), "folder", "application/json")

	// processNextItem がアイテムを取得してI/Oを開始するのを待つ
	select {
	case <-ops.startedCh:
		// processNextItem が I/O 実行中（バグ版ではmutex保持中）
	case <-time.After(5 * time.Second):
		t.Fatal("オペレーションが processNextItem に取得されなかった")
	}

	// HasItems() は RLock を取る — I/O中にブロックされてはならない
	done := make(chan bool, 1)
	go func() {
		_ = q.HasItems()
		done <- true
	}()

	select {
	case <-done:
		// 成功: HasItems がブロックされずに返った
	case <-time.After(3 * time.Second):
		t.Fatal("HasItems() が processNextItem の I/O 中にブロックされた — mutexがネットワーク呼び出し中に保持されている")
	}
}

// TestQueue_ListFiles_Error_ReturnsPromptly は ListFiles がエラー時に
// 速やかに返ることを検証（チャネルデッドロックなし）
func TestQueue_ListFiles_Error_ReturnsPromptly(t *testing.T) {
	ops := newErrorableDriveOps()
	ops.listFilesErr = fmt.Errorf("connection refused")
	q := NewDriveOperationsQueue(ops)
	defer q.Cleanup()

	done := make(chan struct{})
	go func() {
		files, err := q.ListFiles("test query")
		assert.Error(t, err)
		assert.Nil(t, files)
		close(done)
	}()

	select {
	case <-done:
		// OK
	case <-time.After(5 * time.Second):
		t.Fatal("ListFiles がエラー時にタイムアウト — チャネルデッドロックの可能性")
	}
}

// TestQueue_GetFileID_Error_ReturnsPromptly は GetFileID がエラー時に
// 速やかに返ることを検証（チャネルデッドロックなし）
func TestQueue_GetFileID_Error_ReturnsPromptly(t *testing.T) {
	ops := newErrorableDriveOps()
	ops.getFileIDErr = fmt.Errorf("file not found")
	q := NewDriveOperationsQueue(ops)
	defer q.Cleanup()

	done := make(chan struct{})
	go func() {
		fileID, err := q.GetFileID("missing.json", "folder", "root")
		assert.Error(t, err)
		assert.Empty(t, fileID)
		close(done)
	}()

	select {
	case <-done:
		// OK
	case <-time.After(5 * time.Second):
		t.Fatal("GetFileID がエラー時にタイムアウト — チャネルデッドロックの可能性")
	}
}
