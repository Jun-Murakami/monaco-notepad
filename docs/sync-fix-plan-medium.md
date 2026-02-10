# 同期修正計画: Medium (🟡)

> **参照**: [sync-audit-report.md](./sync-audit-report.md)
> **UX方針**: Evernoteライク。ステータスバー通知のみ。ダイアログは使用しない。
> **対象シナリオ**: A4, A5, A8, B3, B9, C4, C6, D1, D2, D6, D8, E2, E5, F3, F5, F6, G3, G5
> **依存**: Critical + High タスク完了後に着手

---

## Task M-1: ContentHash からタイムスタンプを除外

**参照シナリオ**: A8
**ファイル**: `backend/note_service.go`

### 問題

`ContentHash` に `ModifiedTime` が含まれるため、タイムスタンプ更新だけでハッシュが変わり、不要な同期が発生する。

### 修正方針

- `computeContentHash()` で `ModifiedTime` を除外
- ハッシュ対象: `ID + Title + Content + Language + Archived + FolderID` のみ
- 既存ノートのハッシュ再計算が必要（初回同期時に全ノート再ハッシュ、または起動時に一括更新）

### テスト要件

```
TestContentHash_ExcludesModifiedTime
  - 同一コンテンツ + 異なる ModifiedTime → 同一ハッシュ

TestContentHash_IncludesContent
  - 同一タイムスタンプ + 異なる Content → 異なるハッシュ

TestContentHash_IncludesAllStableFields
  - Title, Content, Language, Archived, FolderID の各変更でハッシュが変わることを確認
```

### 受入条件

- [ ] タイムスタンプ変更のみで不要な同期が発生しない
- [ ] コンテンツ変更時は正しく検出される
- [ ] `go test ./...` パス

---

## Task M-2: mergeNotes の構造フィールドマージ

**参照シナリオ**: B9, C6
**ファイル**: `backend/drive_service.go`

### 問題

同一 `LastSync` 時のマージパスが `Notes` の `ContentHash`/`Order` のみ比較し、`Folders`, `TopLevelOrder`, `ArchivedTopLevelOrder`, `FolderID`, `Archived` の変更を無視する。

### 修正方針

- `mergeNotes` を拡張:
  - `Folders` のマージ: IDベースのunion（両方に存在→クラウド採用、片方のみ→追加）
  - `TopLevelOrder` / `ArchivedTopLevelOrder`: クラウド版をベースに、ローカルのみのアイテムを末尾追加
  - ノート単位: `FolderID`, `Archived` の変更も `ContentHash` と同様に比較対象に含める
- → M-1 の ContentHash 改善と組み合わせることで、構造変更がハッシュに反映される

### テスト要件

```
TestMergeNotes_FolderChanges_Merged
  - ローカルとクラウドで異なるフォルダ変更 → union マージ確認

TestMergeNotes_TopLevelOrder_CloudBase_LocalAppended
  - クラウドの並び順をベースにローカルのみアイテム追加確認

TestMergeNotes_NoteArchiveChange_Detected
  - ノートの Archived フラグ変更が検出されることを確認

TestMergeNotes_NoteFolderIdChange_Detected
  - ノートの FolderID 変更が検出されることを確認
```

### 受入条件

- [ ] 構造変更がマージに反映される
- [ ] 片方のみの変更が保持される
- [ ] `go test ./...` パス

---

## Task M-3: 同期中クラッシュからの安全なリカバリ

**参照シナリオ**: C4
**ファイル**: `backend/drive_service.go`, `backend/note_service.go`

### 問題

ノートダウンロード後、noteList 更新前にクラッシュするとローカルファイルが不整合になる。`ValidateIntegrity()` が修復を試みるが、復活/再削除の可能性がある。

### 修正方針

- 同期処理にジャーナル機構を導入:
  - 同期開始時: `{appDataDir}/sync_journal.json` にアクションリストを書き込み
  - 各アクション完了時: ジャーナルを更新
  - 全完了時: ジャーナルファイルを削除
- 起動時に `sync_journal.json` が残っていたら:
  - 中断された同期の状態を確認
  - 未完了アクションをリトライ or ロールバック
- ステータスバー通知: "前回の同期が中断されていたため、修復しました"

### テスト要件

```
TestSyncJournal_CreatedOnSyncStart
  - 同期開始時にジャーナルファイルが作成されることを確認

TestSyncJournal_DeletedOnSyncComplete
  - 同期正常完了時にジャーナルファイルが削除されることを確認

TestSyncJournal_RecoveryOnStartup
  - ジャーナルファイルが残っている状態で起動
  → 修復処理が実行されることを確認

TestSyncJournal_PartialDownload_Recovery
  - 一部ノートダウンロード後の中断 → 起動時に残りをダウンロード
```

### 受入条件

- [ ] 同期中断からの安全な復帰
- [ ] ジャーナルファイルのライフサイクルが正しい
- [ ] ステータスバーに通知
- [ ] `go test ./...` パス

---

## Task M-4: ノート単位のエラー分離（同期継続）

**参照シナリオ**: D6, F6
**ファイル**: `backend/drive_service.go`, `backend/drive_sync_service.go`

### 問題

1つのノートのダウンロード/アップロード失敗で同期全体がabortし、オフライン遷移する可能性がある。

### 修正方針

- `mergeNotes` / `handleCloudSync` / `handleLocalSync` で、個別ノート操作の失敗をcatch
- 失敗したノートをスキップし、残りの同期を続行
- 失敗したノートIDをリストに蓄積
- 同期完了後にステータスバーに "{N}件のノートの同期に失敗しました" と通知
- 次回同期でリトライ

### テスト要件

```
TestMergeNotes_OneNoteFails_OthersContinue
  - 3ノート中1ノートのダウンロードが失敗
  → 残り2ノートが正常に同期されることを確認

TestCloudSync_DownloadError_ContinuesWithOthers
  - handleCloudSync で1ノートのダウンロード失敗
  → 他のノートは正常にダウンロードされる

TestSyncNotes_PartialFailure_StatusBarNotification
  - 部分失敗時にステータスバー通知が出ることを確認

TestSyncNotes_PartialFailure_DoesNotGoOffline
  - ノート単位の失敗ではオフラインにならないことを確認
```

### 受入条件

- [ ] 個別ノート失敗で同期全体が止まらない
- [ ] 失敗ノートがステータスバーに通知される
- [ ] 失敗ノートが次回同期でリトライされる
- [ ] `go test ./...` パス

---

## Task M-5: "Synced" ステータスの信頼性向上

**参照シナリオ**: G3, F5
**ファイル**: `backend/drive_service.go`, `backend/drive_polling.go`, `backend/app_logger.go`

### 問題

"synced" ステータスがキュー未消化でも送信される。ユーザーに偽の安心感を与える。

### 修正方針

- `notifySyncComplete()` でキュー状態を確認:
  - キュー空 → "synced" を送信
  - キュー非空 → "syncing" を維持（キュー消化後にポーリングが "synced" を送信）
- ポーリングの "synced" 送信もキュー状態を確認してから
- アプリ終了前に `WaitForEmpty(timeout)` でキュー消化を待機（最大5秒）

### テスト要件

```
TestNotifySyncComplete_QueueEmpty_EmitsSynced
  - キュー空 → "synced" イベントが送信されること

TestNotifySyncComplete_QueueNotEmpty_EmitsSyncing
  - キュー非空 → "syncing" が維持されること

TestPolling_SyncedStatus_RequiresEmptyQueue
  - ポーリングでキュー非空時に "synced" が送信されないこと
```

### 受入条件

- [ ] キュー非空時に "synced" が送信されない
- [ ] キュー消化後に "synced" が送信される
- [ ] `go test ./...` パス

---

## Task M-6: 同期サマリー通知

**参照シナリオ**: G5
**ファイル**: `backend/drive_service.go`, `backend/app_logger.go`

### 問題

同期後に何が起きたかの構造化されたサマリーがない。

### 修正方針

- `SyncResult` 構造体を定義:

```go
type SyncResult struct {
    Uploaded       int
    Downloaded     int
    Deleted        int
    ConflictCopies int
    Errors         int
}
```

- `SyncNotes()` / `mergeNotes` / `handleCloudSync` / `handleLocalSync` 内でカウントを蓄積
- 同期完了時にサマリーをステータスバーに通知:
  - 変更なし: 通知なし（Evernote同様、静か）
  - 変更あり: "同期完了: ↑3 ↓1" （簡潔に）
  - 衝突あり: "同期完了: ↑3 ↓1 ⚡1件の競合コピー"
  - エラーあり: "同期完了: ↑3 ↓1 ⚠1件失敗"

### テスト要件

```
TestSyncResult_NoChanges_NoNotification
  - 変更なしの同期 → logMessage イベントが発行されないことを確認

TestSyncResult_WithChanges_SummaryEmitted
  - アップロード/ダウンロードあり → サマリーが通知されること

TestSyncResult_WithConflicts_IncludesConflictCount
  - コンフリクトコピー作成あり → サマリーにカウントが含まれること

TestSyncResult_WithErrors_IncludesErrorCount
  - 部分失敗あり → サマリーにエラーカウントが含まれること
```

### 受入条件

- [ ] 変更なし時は通知なし
- [ ] 変更あり時にサマリーがステータスバーに表示
- [ ] ダイアログは使用しない
- [ ] `go test ./...` パス

---

## Task M-7: ValidateIntegrity 後のクラウド同期

**参照シナリオ**: D1, D2
**ファイル**: `backend/drive_service.go`, `backend/note_service.go`

### 問題

`ValidateIntegrity()` がローカルの不整合を修復するが、修復結果がクラウドに反映されない。次の同期で意図しない削除/復活が起こる可能性。

### 修正方針

- `ValidateIntegrity()` が `changed=true` を返した場合、Drive 接続中なら noteList のアップロードをトリガー
- `notifySyncComplete()` 内の `ValidateIntegrity` 呼出後に、`changed=true` なら noteList アップロード
- 起動時の `loadNoteList()` 内の呼出は、Drive 接続前なので後続の初期同期に任せる

### テスト要件

```
TestValidateIntegrity_Changed_TriggersNoteListUpload
  - ValidateIntegrity が変更を行った場合 → noteList がクラウドにアップロードされること

TestValidateIntegrity_NoChange_NoUpload
  - 変更なし → アップロードが発生しないこと
```

### 受入条件

- [ ] 整合性修復後にクラウドが更新される
- [ ] 不要なアップロードが発生しない
- [ ] `go test ./...` パス

---

## Task M-8: アーカイブ操作の ModifiedTime 更新

**参照シナリオ**: B3
**ファイル**: `backend/note_service.go`

### 問題

フォルダアーカイブ時にノートの `ModifiedTime` が更新されない（`SaveNoteFromSync` 使用）。衝突判定でアーカイブ変更が検出されない。

### 修正方針

- `ArchiveFolder` / `UnarchiveFolder` / `ArchiveNote` / `UnarchiveNote` で、対象ノートの `ModifiedTime` を更新
- `SaveNoteFromSync` ではなく `SaveNote` を使用（または `ModifiedTime` を明示的に更新してから保存）

### テスト要件

```
TestArchiveFolder_UpdatesNoteModifiedTime
  - フォルダアーカイブ → 含まれるノートの ModifiedTime が更新されること

TestUnarchiveFolder_UpdatesNoteModifiedTime
  - フォルダアンアーカイブ → 同上

TestArchiveNote_UpdatesModifiedTime
  - ノートアーカイブ → ModifiedTime 更新確認

TestUnarchiveNote_UpdatesModifiedTime
  - ノートアンアーカイブ → 同上
```

### 受入条件

- [ ] アーカイブ操作でModifiedTimeが更新される
- [ ] 衝突判定でアーカイブ変更が検出される
- [ ] `go test ./...` パス

---

## Task M-9: DELETE のキャンセル範囲拡大

**参照シナリオ**: F3
**ファイル**: `backend/drive_operations_queue.go`

### 問題

DELETE が FileID ベースでのみ既存操作をキャンセルするが、CREATE は FileID が空のためカバーされない。

### 修正方針

- C-1 (Critical) で導入する `mapKey` を使用して、DELETE が同じノートの全操作（CREATEを含む）をキャンセルできるようにする
- "delete then recreate" パターン: DELETE 後の CREATE は新しいファイルとして正常に動作することを確認

### テスト要件

```
TestQueue_Delete_CancelsPendingCreate
  - CREATEをenqueue → 同じファイル名でDELETEをenqueue
  → CREATEがキャンセルされること

TestQueue_Delete_ThenCreate_WorksCorrectly
  - DELETE → CREATE → 両方正常に実行されること
```

### 受入条件

- [ ] DELETE が CREATE も含む全操作をキャンセルできる
- [ ] delete→recreate パターンが動作する
- [ ] `go test ./...` パス

---

## 実行順序（依存関係）

```
M-1 (ContentHash改善) ← 独立、早期に実施
    ↓
M-2 (構造マージ拡張) ← M-1 + H-1 に依存
    ↓
M-4 (エラー分離) ← 独立
M-5 (Syncedステータス) ← 独立
M-6 (サマリー通知) ← H-3, M-4 に依存（カウント対象が確定後）
M-7 (ValidateIntegrity連携) ← 独立
M-8 (アーカイブModifiedTime) ← 独立
M-9 (DELETEキャンセル範囲) ← C-1 に依存
    ↓
M-3 (ジャーナル機構) ← 最後（大きな変更、他が安定後）
```
