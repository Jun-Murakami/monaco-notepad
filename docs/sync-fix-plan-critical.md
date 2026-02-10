# 同期修正計画: Critical (🔴)

> **参照**: [sync-audit-report.md](./sync-audit-report.md)
> **対象シナリオ**: C2/F1, F2, D3, B1, G2
> **見積もり**: 各タスク 0.5〜1日

---

## Task C-1: キュー CREATE 操作後のマップ不整合修正

**参照シナリオ**: C2, F1
**ファイル**: `backend/drive_operations_queue.go`

### 問題

`QueueItem` の `FileID` が CREATE 操作時に空文字で `items` マップに登録される。CREATE 実行後に `FileID` がmutateされるが、`removeItemFromMap()` は変更後の `FileID` で検索するため元のエントリを見つけられない。結果として `HasItems()` が永久に `true` を返し、ポーリングと自動同期が停止する。

### 修正方針

- `QueueItem` に `mapKey string` フィールドを追加し、enqueue時に確定させる（CREATE は `fileName+parentID`、その他は `FileID`）
- `items` マップのキーを `mapKey` に統一
- `removeItemFromMap()` / `removeExistingItems()` / `removeOldUpdateItems()` を `mapKey` ベースに変更
- DELETE 時の既存操作キャンセルも `mapKey` ベースで動作させる

### テスト要件

```
TestQueue_CreateOperation_ClearsFromMap
  - CREATEをenqueue → 実行完了 → HasItems() == false を確認

TestQueue_CreateThenDelete_MapConsistent
  - CREATEをenqueue（まだ実行前）→ 同じファイル名でDELETEをenqueue
  → CREATEがキャンセルされることを確認

TestQueue_MultipleCreates_AllClearFromMap
  - 複数のCREATEをenqueue → 全て実行完了 → HasItems() == false

TestQueue_CreateDoesNotBlockPolling
  - CREATEをenqueue → 実行完了
  → HasItems() == false（ポーリングが再開可能な状態）
```

### 受入条件

- [ ] CREATE 操作完了後に `HasItems()` が `false` を返す
- [ ] DELETE が同じファイル名の未完了 CREATE をキャンセルできる
- [ ] 既存の全キューテストが引き続きパスする
- [ ] `go test ./...` パス

---

## Task C-2: UPDATE キャンセル → 重複 CREATE の防止

**参照シナリオ**: F2
**ファイル**: `backend/drive_operations_queue.go`, `backend/drive_sync_service.go`

### 問題

UPDATE 操作がデバウンスでキャンセルされると "operation cancelled due to newer update operation" エラーが返される。`driveSyncServiceImpl.UpdateNote()` はこのエラーを見て `CreateNote()` にフォールバックし、同一ノートの Drive ファイルが重複生成される。

### 修正方針

**A. キュー側**: キャンセルされた UPDATE は特別なエラー型（またはセンチネル値）を返す

```go
var ErrOperationCancelled = fmt.Errorf("operation cancelled")
```

**B. drive_sync_service.go 側**: `UpdateNote()` で `ErrOperationCancelled` を受け取った場合は no-op（nil 返却）にする。`CreateNote()` にフォールバックしない。

### テスト要件

```
TestQueue_CancelledUpdate_ReturnsSpecificError
  - UPDATEをenqueue → 同じFileIDでさらにUPDATEをenqueue
  → 古いUPDATEのerrorが ErrOperationCancelled であることを確認

TestSyncService_CancelledUpdate_DoesNotCreate
  - mock queue が ErrOperationCancelled を返す
  → UpdateNote() が nil を返し、CreateNote() を呼ばないことを確認

TestQueue_CancelledUpdate_FinalStateCorrect
  - 3回連続UPDATE → 最後のUPDATEだけが実行され、コンテンツが最新であることを確認
```

### 受入条件

- [ ] UPDATE キャンセル時に `ErrOperationCancelled` が返される
- [ ] `UpdateNote()` がキャンセルエラーで `CreateNote()` を呼ばない
- [ ] 連続 UPDATE の最終状態が正しい
- [ ] `go test ./...` パス

---

## Task C-3: 不明クラウドノートの自動削除を停止

**参照シナリオ**: D3
**ファイル**: `backend/drive_polling.go`, `backend/drive_service.go`

### 問題

ポーリング開始時（`StartPolling`）とローカル→クラウド同期時（`handleLocalSync`）で、クラウド noteList に記載がない Drive ファイルを確認なしで削除している。別デバイスで作成したばかりのノートが noteList 更新前に削除される。

### 修正方針

**A. ポーリング開始時** (`drive_polling.go` `StartPolling`):
- 不明ノートの削除ループを削除
- 代わりに不明ノートをダウンロードして noteList にマージ（`prepareCloudNotesForMerge` と同等のロジック）

**B. ローカル同期時** (`drive_service.go` `handleLocalSync`):
- 不明クラウドノートの自動削除を削除
- 代わりにダウンロードしてローカルに追加、noteList を更新

### テスト要件

```
TestPolling_UnknownCloudNotes_NotDeleted
  - クラウドにnoteListに無いノートファイルが存在
  → ポーリング後もクラウドファイルが存在することを確認

TestPolling_UnknownCloudNotes_DownloadedAndMerged
  - クラウドにnoteListに無いノートファイルが存在
  → ダウンロードされてローカルnoteListに追加されることを確認

TestLocalSync_UnknownCloudNotes_NotDeleted
  - ローカルが新しい状態でhandleLocalSync実行
  - クラウドにnoteListに無いノートファイルが存在
  → 削除されないことを確認

TestLocalSync_UnknownCloudNotes_Downloaded
  - 上記の続き → ダウンロードされてローカルに追加されることを確認
```

### 受入条件

- [ ] ポーリング開始時にクラウドの不明ノートが削除されない
- [ ] ローカル同期時にクラウドの不明ノートが削除されない
- [ ] 不明ノートがダウンロードされてローカルにマージされる
- [ ] `go test ./...` パス

---

## Task C-4: 削除 vs 編集の衝突保護

**参照シナリオ**: B1, G2
**ファイル**: `backend/drive_service.go`

### 問題

`handleCloudSync()` で、クラウド noteList にないローカルノートを無条件削除している。デバイスAでノートを削除し、デバイスBで同じノートを編集した場合、デバイスBのローカル編集がサイレントに消失する。

### 修正方針

- `handleCloudSync()` のローカル専用ノート削除ロジックを変更
- 削除前にローカルノートの `ModifiedTime` と `NoteList.LastSync`（前回の同期時刻）を比較
- `ModifiedTime` > 前回の `LastSync` なら、前回同期後にローカル編集があった → 削除せず保持（クラウドにアップロード）
- `ModifiedTime` <= 前回の `LastSync` なら、前回同期時点で既にあったものがクラウドで削除された → 削除OK
- 保持した場合はログ + `drive:conflict` 的な通知（G2対策の一環として後続タスクで詳細化）

### テスト要件

```
TestCloudSync_DeletedOnCloud_EditedLocally_Preserved
  - ローカルノートの ModifiedTime > LastSync
  - クラウド noteList にそのノートなし
  → ローカルノートが削除されないことを確認

TestCloudSync_DeletedOnCloud_NotEditedLocally_Deleted
  - ローカルノートの ModifiedTime < LastSync
  - クラウド noteList にそのノートなし
  → ローカルノートが削除されることを確認

TestCloudSync_DeletedOnCloud_EditedLocally_UploadedToCloud
  - 上記の保持ケース → クラウドにアップロードされることを確認

TestCloudSync_MultipleNotes_MixedDeleteAndEdit
  - 複数ノート: 一部はクラウドで削除+ローカル未編集、一部はクラウドで削除+ローカル編集済み
  → 正しく分類されることを確認
```

### 受入条件

- [ ] ローカル編集済みノートがクラウド削除でサイレント消失しない
- [ ] 未編集ノートはクラウド側の削除が反映される
- [ ] 保持されたノートがクラウドにアップロードされる
- [ ] `go test ./...` パス

---

## Task C-5: Cleanup 時の delayed goroutine パニック修正

**参照シナリオ**: F4
**ファイル**: `backend/drive_operations_queue.go`

### 問題

`Cleanup()` が `close(q.queue)` を呼ぶが、UPDATE のデバウンス遅延（3秒 `time.Sleep`）中の goroutine がまだ生きており、close 済みチャネルに send してパニックする。

### 修正方針

- `addToQueue` 内の遅延 goroutine で、send前に `q.ctx.Done()` をチェック
- `q.queue <- item` の前に select で ctx.Done チェック:

```go
select {
case <-q.ctx.Done():
    item.Result <- ErrOperationCancelled
    return
default:
}
// safe to send
select {
case q.queue <- item:
case <-q.ctx.Done():
    item.Result <- ErrOperationCancelled
}
```

- `Cleanup()` で `cancel()` を先に呼び、goroutineが停止するのを短時間待ってから `close(q.queue)` する

### テスト要件

```
TestQueue_Cleanup_DuringDebouncedUpdate_NoPanic
  - UPDATEをenqueue（3秒遅延中）
  → 即座にCleanup()
  → パニックしないことを確認
  → UPDATEの Result が ErrOperationCancelled であることを確認

TestQueue_Cleanup_MultipleInFlightOps_NoPanic
  - 複数のUPDATEをenqueue（遅延中）
  → Cleanup() → パニックなし

TestQueue_Cleanup_ThenNewEnqueue_Rejected
  - Cleanup() 後に新しい操作をenqueue
  → 適切にエラーが返されること（またはno-op）
```

### 受入条件

- [ ] Cleanup 中にパニックが発生しない
- [ ] 遅延中の操作が適切にキャンセルされる
- [ ] `go test ./...` パス（`go test -race` 含む）
