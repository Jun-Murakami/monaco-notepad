package backend

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
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

// --- C-1: CREATE操作後のマップ不整合修正テスト ---

func TestQueue_CreateOperation_ClearsFromMap(t *testing.T) {
	ops := newMockDriveOperations()
	q := NewDriveOperationsQueue(ops)
	defer q.Cleanup()

	done := make(chan struct{})
	go func() {
		_, err := q.CreateFile("note1.json", []byte(`{"id":"note1"}`), "folder-id", "application/json")
		assert.NoError(t, err)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("CREATE操作がタイムアウト")
	}

	assert.False(t, q.HasItems(), "CREATE完了後にHasItems()はfalseを返すべき")
}

func TestQueue_CreateThenDelete_MapConsistent(t *testing.T) {
	ops := newMockDriveOperations()
	q := NewDriveOperationsQueue(ops)
	defer q.Cleanup()

	done := make(chan struct{})
	go func() {
		_, err := q.CreateFile("note1.json", []byte(`{"id":"note1"}`), "folder-id", "application/json")
		assert.NoError(t, err)

		err = q.DeleteFile("test-file-note1.json")
		assert.NoError(t, err)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("CREATE+DELETE操作がタイムアウト")
	}

	assert.False(t, q.HasItems(), "CREATE→DELETE完了後にHasItems()はfalseを返すべき")
}

func TestQueue_MultipleCreates_AllClearFromMap(t *testing.T) {
	ops := newMockDriveOperations()
	q := NewDriveOperationsQueue(ops)
	defer q.Cleanup()

	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			name := fmt.Sprintf("note-%d.json", idx)
			_, err := q.CreateFile(name, []byte(`{}`), "folder-id", "application/json")
			assert.NoError(t, err)
		}(i)
	}

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("複数CREATE操作がタイムアウト")
	}

	assert.False(t, q.HasItems(), "全CREATE完了後にHasItems()はfalseを返すべき")
}

func TestQueue_CreateDoesNotBlockPolling(t *testing.T) {
	ops := newMockDriveOperations()
	q := NewDriveOperationsQueue(ops)
	defer q.Cleanup()

	done := make(chan struct{})
	go func() {
		_, err := q.CreateFile("test.json", []byte(`{}`), "folder", "application/json")
		assert.NoError(t, err)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("CREATE操作がタイムアウト")
	}

	assert.False(t, q.HasItems(), "CREATE完了後にポーリング再開可能な状態であるべき")
}

// --- M-9: DELETEのキャンセル範囲拡大テスト ---

func TestQueue_Delete_CancelsPendingCreate(t *testing.T) {
	ops := newMockDriveOperations()
	q := NewDriveOperationsQueue(ops)
	defer q.Cleanup()

	createResult := make(chan error, 1)
	go func() {
		_, err := q.CreateFile("note1.json", []byte(`{"id":"note1"}`), "folder-id", "application/json")
		createResult <- err
	}()

	time.Sleep(100 * time.Millisecond)

	deleteResult := make(chan error, 1)
	go func() {
		deleteResult <- q.DeleteFileWithName("some-drive-file-id", "note1.json")
	}()

	select {
	case err := <-createResult:
		if err != nil {
			assert.True(t, errors.Is(err, ErrOperationCancelled),
				"CREATEはキャンセルされるべき: got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("CREATE結果がタイムアウト")
	}

	select {
	case <-deleteResult:
	case <-time.After(5 * time.Second):
		t.Fatal("DELETE結果がタイムアウト")
	}
}

func TestQueue_Delete_ThenCreate_WorksCorrectly(t *testing.T) {
	ops := newMockDriveOperations()
	ops.files["existing-file-id"] = []byte(`{"id":"note1"}`)
	q := NewDriveOperationsQueue(ops)
	defer q.Cleanup()

	done := make(chan struct{})
	go func() {
		err := q.DeleteFile("existing-file-id")
		assert.NoError(t, err)

		_, err = q.CreateFile("note1.json", []byte(`{"id":"note1","title":"recreated"}`), "folder-id", "application/json")
		assert.NoError(t, err)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("DELETE→CREATE操作がタイムアウト")
	}

	ops.mu.RLock()
	found := false
	for _, data := range ops.files {
		var n Note
		if json.Unmarshal(data, &n) == nil && n.Title == "recreated" {
			found = true
		}
	}
	ops.mu.RUnlock()
	assert.True(t, found, "DELETE後のCREATEで新しいファイルが作成されるべき")
}

// --- C-2: UPDATEキャンセル時のErrOperationCancelledテスト ---

func TestQueue_CancelledUpdate_ReturnsSpecificError(t *testing.T) {
	ops := newMockDriveOperations()
	ops.files["file-1"] = []byte("existing")
	q := NewDriveOperationsQueue(ops)
	defer q.Cleanup()

	result1 := make(chan error, 1)
	go func() {
		result1 <- q.UpdateFile("file-1", []byte("v1"))
	}()

	time.Sleep(100 * time.Millisecond)

	result2 := make(chan error, 1)
	go func() {
		result2 <- q.UpdateFile("file-1", []byte("v2"))
	}()

	var err1 error
	select {
	case err1 = <-result1:
	case <-time.After(10 * time.Second):
		t.Fatal("最初のUPDATE結果がタイムアウト")
	}

	assert.True(t, errors.Is(err1, ErrOperationCancelled),
		"古いUPDATEはErrOperationCancelledを返すべき: got %v", err1)

	select {
	case err := <-result2:
		assert.NoError(t, err, "新しいUPDATEは成功すべき")
	case <-time.After(10 * time.Second):
		t.Fatal("新しいUPDATE結果がタイムアウト")
	}
}

func TestQueue_CancelledUpdate_FinalStateCorrect(t *testing.T) {
	ops := newMockDriveOperations()
	ops.files["file-x"] = []byte("original")
	q := NewDriveOperationsQueue(ops)
	defer q.Cleanup()

	results := make([]chan error, 3)
	for i := 0; i < 3; i++ {
		results[i] = make(chan error, 1)
		go func(idx int) {
			content := fmt.Sprintf("version-%d", idx)
			results[idx] <- q.UpdateFile("file-x", []byte(content))
		}(i)
		time.Sleep(50 * time.Millisecond)
	}

	for i, ch := range results {
		select {
		case err := <-ch:
			if i < 2 {
				assert.True(t, errors.Is(err, ErrOperationCancelled) || err == nil,
					"古いUPDATE[%d]はキャンセルまたは成功であるべき", i)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("UPDATE[%d]結果がタイムアウト", i)
		}
	}

	ops.mu.RLock()
	content := ops.files["file-x"]
	ops.mu.RUnlock()
	assert.Equal(t, "version-2", string(content), "最終コンテンツは最新のバージョンであるべき")
}

// --- C-5: Cleanupパニック修正テスト ---

func TestQueue_Cleanup_DuringDebouncedUpdate_NoPanic(t *testing.T) {
	ops := newMockDriveOperations()
	ops.files["file-1"] = []byte("data")
	q := NewDriveOperationsQueue(ops)

	result := make(chan error, 1)
	go func() {
		result <- q.UpdateFile("file-1", []byte("updated"))
	}()

	time.Sleep(100 * time.Millisecond)

	assert.NotPanics(t, func() {
		q.Cleanup()
	}, "デバウンス中のCleanup()でパニックしてはならない")

	select {
	case err := <-result:
		assert.True(t, errors.Is(err, ErrOperationCancelled) || err == nil,
			"結果はErrOperationCancelledまたはnilであるべき: got %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("UPDATE結果がタイムアウト")
	}
}

func TestQueue_Cleanup_MultipleInFlightOps_NoPanic(t *testing.T) {
	ops := newMockDriveOperations()
	ops.files["file-a"] = []byte("a")
	ops.files["file-b"] = []byte("b")
	ops.files["file-c"] = []byte("c")
	q := NewDriveOperationsQueue(ops)

	results := make([]chan error, 3)
	fileIDs := []string{"file-a", "file-b", "file-c"}
	for i, fid := range fileIDs {
		results[i] = make(chan error, 1)
		go func(idx int, id string) {
			results[idx] <- q.UpdateFile(id, []byte("new"))
		}(i, fid)
	}

	time.Sleep(100 * time.Millisecond)

	assert.NotPanics(t, func() {
		q.Cleanup()
	}, "複数インフライト操作中のCleanup()でパニックしてはならない")

	for i, ch := range results {
		select {
		case err := <-ch:
			assert.True(t, errors.Is(err, ErrOperationCancelled) || err == nil,
				"結果[%d]はErrOperationCancelledまたはnilであるべき: got %v", i, err)
		case <-time.After(10 * time.Second):
			t.Fatalf("結果[%d]がタイムアウト", i)
		}
	}
}

func TestQueue_Cleanup_ThenNewEnqueue_Rejected(t *testing.T) {
	ops := newMockDriveOperations()
	q := NewDriveOperationsQueue(ops)
	q.Cleanup()

	time.Sleep(200 * time.Millisecond)

	assert.NotPanics(t, func() {
		result := make(chan error, 1)
		item := &QueueItem{
			OperationType: CreateOperation,
			FileName:      "post-cleanup.json",
			Content:       []byte(`{}`),
			ParentID:      "folder",
			MimeType:      "application/json",
			CreatedAt:     time.Now(),
			Result:        result,
		}
		q.addToQueue(item)
	}, "Cleanup後のenqueueでパニックしてはならない")
}

func TestQueue_UpdateDeleteCreate_Chain(t *testing.T) {
	ops := newMockDriveOperations()
	ops.files["file-1"] = []byte("v1")
	q := NewDriveOperationsQueue(ops)
	defer q.Cleanup()

	updateResult := make(chan error, 1)
	go func() {
		updateResult <- q.UpdateFile("file-1", []byte("v2"))
	}()

	time.Sleep(100 * time.Millisecond)

	deleteResult := make(chan error, 1)
	go func() {
		deleteResult <- q.DeleteFile("file-1")
	}()

	createIDResult := make(chan string, 1)
	createResult := make(chan error, 1)
	go func() {
		fileID, err := q.CreateFile("file-1.json", []byte("v3"), "folder-id", "application/json")
		createIDResult <- fileID
		createResult <- err
	}()

	var updateErr error
	select {
	case updateErr = <-updateResult:
	case <-time.After(10 * time.Second):
		t.Fatal("UPDATE結果がタイムアウト")
	}
	assert.True(t, errors.Is(updateErr, ErrOperationCancelled), "UPDATEはDELETEによりキャンセルされるべき")

	select {
	case err := <-deleteResult:
		assert.NoError(t, err, "DELETEは成功するべき")
	case <-time.After(10 * time.Second):
		t.Fatal("DELETE結果がタイムアウト")
	}

	var createFileID string
	select {
	case createFileID = <-createIDResult:
	case <-time.After(10 * time.Second):
		t.Fatal("CREATE fileID取得がタイムアウト")
	}

	select {
	case err := <-createResult:
		assert.NoError(t, err, "CREATEは成功するべき")
	case <-time.After(10 * time.Second):
		t.Fatal("CREATE結果がタイムアウト")
	}

	ops.mu.RLock()
	finalContent, exists := ops.files[createFileID]
	ops.mu.RUnlock()
	assert.True(t, exists, "再作成されたファイルが存在するべき")
	assert.Equal(t, "v3", string(finalContent), "最終コンテンツはv3であるべき")
}

func TestQueue_CreateThenUpdate_SameFile(t *testing.T) {
	ops := newMockDriveOperations()
	q := NewDriveOperationsQueue(ops)
	defer q.Cleanup()

	fileID, err := q.CreateFile("note.json", []byte("v1"), "folder-id", "application/json")
	assert.NoError(t, err)
	assert.NotEmpty(t, fileID)

	err = q.UpdateFile(fileID, []byte("v2"))
	assert.NoError(t, err)

	ops.mu.RLock()
	finalContent, exists := ops.files[fileID]
	ops.mu.RUnlock()
	assert.True(t, exists)
	assert.Equal(t, "v2", string(finalContent))
}

func TestQueue_ConcurrentUpdates_DifferentFiles(t *testing.T) {
	ops := newMockDriveOperations()
	ops.files["file-a"] = []byte("a-old")
	ops.files["file-b"] = []byte("b-old")
	ops.files["file-c"] = []byte("c-old")

	q := NewDriveOperationsQueue(ops)
	defer q.Cleanup()

	updates := map[string]string{
		"file-a": "a-new",
		"file-b": "b-new",
		"file-c": "c-new",
	}

	results := make(map[string]chan error, len(updates))
	for fileID := range updates {
		results[fileID] = make(chan error, 1)
	}

	for fileID, content := range updates {
		go func(id string, data string) {
			results[id] <- q.UpdateFile(id, []byte(data))
		}(fileID, content)
	}

	for fileID, ch := range results {
		select {
		case err := <-ch:
			assert.NoError(t, err, "%s のUPDATEは成功するべき", fileID)
		case <-time.After(12 * time.Second):
			t.Fatalf("%s のUPDATE結果がタイムアウト", fileID)
		}
	}

	ops.mu.RLock()
	defer ops.mu.RUnlock()
	for fileID, expected := range updates {
		assert.Equal(t, expected, string(ops.files[fileID]), "%s の最終コンテンツが不正", fileID)
	}
}

func TestQueue_Cleanup_DelayedGoroutine_SafeReturn(t *testing.T) {
	ops := newMockDriveOperations()
	ops.files["file-1"] = []byte("before")
	q := NewDriveOperationsQueue(ops)

	updateResult := make(chan error, 1)
	go func() {
		updateResult <- q.UpdateFile("file-1", []byte("after"))
	}()

	time.Sleep(100 * time.Millisecond)
	q.Cleanup()

	time.Sleep(4 * time.Second)

	select {
	case err := <-updateResult:
		assert.True(t, errors.Is(err, ErrOperationCancelled), "Cleanup後の遅延UPDATEはErrOperationCancelledを返すべき: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("UPDATE結果がタイムアウト")
	}
}

func TestQueue_BufferFull_BlocksUntilSpace(t *testing.T) {
	ops := newBlockingDriveOps()
	q := NewDriveOperationsQueue(ops)
	defer q.Cleanup()

	seedDone := make(chan error, 1)
	go func() {
		_, err := q.CreateFile("seed.json", []byte("seed"), "folder", "application/json")
		seedDone <- err
	}()

	select {
	case <-ops.startedCh:
	case <-time.After(5 * time.Second):
		t.Fatal("seed create did not start")
	}

	for i := 0; i < cap(q.queue); i++ {
		q.queue <- &QueueItem{OperationType: ListOperation, Result: make(chan error, 1)}
	}

	overflowDone := make(chan struct{})
	go func() {
		overflow := &QueueItem{
			OperationType: CreateOperation,
			FileName:      "overflow.json",
			ParentID:      "folder",
			MimeType:      "application/json",
			CreatedAt:     time.Now(),
			Result:        make(chan error, 1),
		}
		q.addToQueue(overflow)
		close(overflowDone)
	}()

	select {
	case <-overflowDone:
		t.Fatal("overflow enqueue should block while buffer is full")
	case <-time.After(250 * time.Millisecond):
	}

	select {
	case item := <-q.queue:
		item.Result <- ErrOperationCancelled
	case <-time.After(2 * time.Second):
		t.Fatal("failed to drain one queued item")
	}

	close(ops.blockCh)

	select {
	case <-overflowDone:
	case <-time.After(5 * time.Second):
		t.Fatal("overflow enqueue did not proceed after buffer space was available")
	}

	select {
	case err := <-seedDone:
		assert.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("seed create did not complete")
	}
}

func TestQueue_WaitForEmpty_Timeout(t *testing.T) {
	ops := newBlockingDriveOps()
	q := NewDriveOperationsQueue(ops)
	defer q.Cleanup()

	done := make(chan error, 1)
	go func() {
		_, err := q.CreateFile("wait-timeout.json", []byte("x"), "folder", "application/json")
		done <- err
	}()

	select {
	case <-ops.startedCh:
	case <-time.After(5 * time.Second):
		t.Fatal("create did not start")
	}

	assert.False(t, q.WaitForEmpty(200*time.Millisecond))

	close(ops.blockCh)
	select {
	case err := <-done:
		assert.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("create did not complete after unblock")
	}
}

func TestQueue_WaitForEmpty_Success(t *testing.T) {
	ops := newMockDriveOperations()
	q := NewDriveOperationsQueue(ops)
	defer q.Cleanup()

	done := make(chan error, 1)
	go func() {
		_, err := q.CreateFile("wait-success.json", []byte("ok"), "folder", "application/json")
		done <- err
	}()

	select {
	case err := <-done:
		assert.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("create did not complete")
	}

	assert.True(t, q.WaitForEmpty(5*time.Second))
}
