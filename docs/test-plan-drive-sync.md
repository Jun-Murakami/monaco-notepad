# Google Drive 同期テスト計画書

---

## 1. 現状分析

### 1.1 同期アルゴリズムの概要

```
┌──────────────────────────────────────────────────────────────────────┐
│                    同期フロー全体図                                     │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ユーザー操作 ──→ SaveNoteAndUpdateList() ──→ syncMu Lock            │
│                  ├── CreateNote/UpdateNote (driveSync)                │
│                  ├── saveNoteList()                                   │
│                  └── updateNoteListInternal() ──→ "syncing"→"synced" │
│                                                                      │
│  ポーリング (5s～60s) ──→ checkForChanges()                          │
│    ├── Changes API (ListChanges)                                     │
│    ├── hasRelevantChanges() / isSelfNoteListChange()                 │
│    ├── forceNextSync = true                                          │
│    └── SyncNotes() ──→ syncMu Lock                                   │
│         ├── skipSyncIfQueuePending()                                 │
│         ├── ensureSyncIsPossible()                                   │
│         ├── "syncing" 通知                                           │
│         ├── DownloadNoteList[IfChanged]()                            │
│         ├── isNoteListChanged() / isStructureChanged()               │
│         ├── mergeNotes() ──→ 核心アルゴリズム                        │
│         │   ├── DeduplicateNotes()                                   │
│         │   ├── 双方存在: ContentHash比較                             │
│         │   │   ├── 一致 → ローカル保持                               │
│         │   │   ├── 不一致+空Hash → computeContentHash()再計算       │
│         │   │   ├── Cloud新しい → DownloadNote()                     │
│         │   │   ├── Local新しい → UpdateNote(upload)                 │
│         │   │   └── 同時刻 → isOneSidedChange()                     │
│         │   │       ├── 片方のみ → メタデータ更新のみ                 │
│         │   │       └── 両方変更 → MergeConflictContent()            │
│         │   ├── ローカルのみ:                                         │
│         │   │   ├── cloudLastSync後に変更 → Upload                   │
│         │   │   └── cloudLastSync前に変更 → 他端末で削除→ローカル削除 │
│         │   └── クラウドのみ:                                         │
│         │       ├── recentlyDeletedNoteIDs → スキップ                │
│         │       ├── Drive "not found" → noteList除外                 │
│         │       ├── 一時エラー → noteList残留(次回リトライ)           │
│         │       └── 正常 → DownloadNote()                            │
│         ├── mergeNoteListStructure()                                 │
│         └── notifySyncComplete()                                     │
│              ├── ValidateIntegrity()                                  │
│              ├── lastSyncResult.Summary() → logger.Info()            │
│              ├── queue有 → "syncing" 維持                             │
│              └── queue空 → "synced"                                   │
│                                                                      │
│  UpdateNoteList() ──→ syncMu Lock                                    │
│    ├── 2秒以内 → deferredUploadTimer (デバウンス)                    │
│    └── 2秒超過 → updateNoteListInternal() 即時実行                   │
│                                                                      │
│  performInitialSync() ──→ syncMu Lock                                │
│    ├── ensureCloudNoteList()                                         │
│    ├── prepareCloudNotesForMerge() (unknownNotes取り込み)            │
│    ├── publishPreviewNoteList()                                      │
│    ├── buildSyncJournal() + mergeNotes()                             │
│    ├── SaveNoteFromSync() × N (10件毎通知)                           │
│    └── saveAndUpdateNoteList() → "synced"                            │
│                                                                      │
│  DriveOperationsQueue                                                │
│    ├── CREATE → 即時enqueue                                          │
│    ├── UPDATE → 3秒デバウンス + 重複排除                              │
│    ├── DELETE → 同key全破棄 + CancelPendingCreates                   │
│    ├── processQueue() (goroutine) → executeOperation()               │
│    └── Cleanup() → cancel + 残留排出 + close                        │
│                                                                      │
│  接続断→再接続                                                       │
│    ├── reconnect() (ポーリングループ内)                               │
│    ├── 指数バックオフ (10s→最大3分)                                   │
│    └── 成功 → changePageToken="", interval=初期値                    │
│                                                                      │
│  通知ポイント:                                                        │
│    EventsEmit("drive:status", "syncing"|"synced"|"logging in")       │
│    EventsEmit("logMessage", ...)  via logger.Info()                  │
│    EventsEmit("notes:updated") + EventsEmit("notes:reload")          │
│    EventsEmit("drive:error", ...) via logger.ErrorWithNotify()       │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 既存テストカバレッジの評価

| テストファイル | テスト数 | 評価 |
|---|---|---|
| `drive_service_test.go` | ~60 | mergeNotes()の主要パス、コンフリクト解決、フォルダマージ、ジャーナルリカバリ、forceNextSync、ValidateIntegrity等を網羅。**ただし、通知検証は間接的** |
| `drive_operations_queue_test.go` | ~15 | 基本CRUD、デバウンス、キャンセル、Cleanup、HasItemsブロック回避を網羅 |
| `drive_polling_test.go` | ~5 | isSelfNoteListChange()のパターンを検証。**ポーリングループ自体のテストは無し** |
| `domain_test.go` (関連部分) | ~10 | isModifiedTimeAfter()、computeContentHash()、SyncResult.Summary() |

**総合評価**: 主要なハッピーパスとコンフリクトシナリオは十分にカバーされている。一方で以下の領域にギャップがある。

### 1.3 テストギャップの優先度付きリスト

| # | ギャップ | 優先度 | 理由 |
|---|---|---|---|
| G1 | ステータスバー通知の体系的検証 | P0 | ユーザーが同期状態を誤認するとデータ損失操作のリスク |
| G2 | リトライ成功/失敗パス (withRetry) | P1 | ネットワーク不安定時のデータ整合性 |
| G3 | UpdateNoteList デバウンス (2秒ルール) | P1 | 実装のタイマーロジックが未検証 |
| G4 | SaveNoteAndUpdateList アトミシティ | P0 | 途中失敗でnoteListとDriveが不整合に |
| G5 | performInitialSync 詳細フロー | P1 | unknownNotes取り込み、プレビュー、段階的通知が未検証 |
| G6 | キュー操作の追加エッジケース | P1 | UPDATE→DELETE→CREATE連鎖、バッファフル |
| G7 | ポーリング詳細 (接続断→再接続フロー) | P1 | 再接続失敗時のバックオフ、トークンリフレッシュ |
| G8 | 空ノート vs 非空ノートのコンフリクト | P2 | エッジケースだがデータ損失にはならない |
| G9 | タイトル/言語のみ変更のコンフリクト | P2 | ContentHashで検出される想定だが未検証 |
| G10 | WaitForEmpty のタイムアウト | P2 | パフォーマンス/UX影響 |
| G11 | noteList.json 破損リカバリ (DownloadNoteList) | P1 | cachedNoteList フォールバックの検証 |
| G12 | Cloud-only ノートの一時エラー→noteList残留→次回リトライ | P1 | データ損失回避の重要パス |

---

## 2. テスト計画書

### 2.1 進捗トラッキング

| Phase | カテゴリ | テスト数 | ステータス |
|---|---|---|---|
| Phase 1 (P0) | A (A-1~A-4, A-6) + D (D-1, D-3, D-4, D-7) | 9 | 未着手 |
| Phase 2 (P1-高) | B (B-1~B-8) + I (I-1~I-7) | 15 | 未着手 |
| Phase 3 (P1-中) | C (C-1~C-4) + D (D-2, D-5, D-6) + E (E-1~E-5) | 12 | 未着手 |
| Phase 4 (P1-低) | F (F-1, F-2, F-6, F-7) + G (G-1~G-6, G-8) + J (J-1~J-3) | 14 | 未着手 |
| Phase 5 (P2) | H (H-1~H-3) + F (F-3~F-5) + G (G-7, G-9) + B-5 + C-5 + I-8 | 12 | 未着手 |

---

### カテゴリA: ステータスバー通知の検証 (G1)

> **設計方針**: `AppLogger` のモックを拡張し、`NotifyDriveStatus()`, `Info()`, `ErrorWithNotify()`, `NotifyFrontendSyncedAndReload()` の呼び出し履歴を記録する `notificationRecorder` を導入する。

---

#### A-1: CreateNote 成功時の通知遷移

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestCreateNote_StatusNotification_SyncingToSynced` |
| **目的** | ノート作成時に "syncing" → "synced" の通知遷移が正しく行われること |
| **シナリオ** | **前提**: Drive接続済み、`notificationRecorder` を設定。**操作**: `driveService.CreateNote(note)` を呼び出す。**期待結果**: `NotifyDriveStatus("syncing")` が先に呼ばれる → `Info("Creating note: %s")` が呼ばれる → `NotifyDriveStatus("synced")` が後に呼ばれる → 順序が `syncing` → `synced` |
| **検証ポイント** | 通知の順序と完全性 |
| **優先度** | P0 |

---

#### A-2: UpdateNote 成功時の通知遷移

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestUpdateNote_StatusNotification_SyncingToSynced` |
| **目的** | ノート更新時の "syncing" → "synced" 通知 |
| **シナリオ** | **前提**: Drive接続済み、ノートがDrive上に存在、`notificationRecorder` を設定。**操作**: `driveService.UpdateNote(note)` を呼び出す。**期待結果**: `NotifyDriveStatus("syncing")` → `Info("Updating note: %s")` → `Info("Note updated: %s")` → `NotifyDriveStatus("synced")` |
| **検証ポイント** | Update固有のログメッセージを含む通知の完全性 |
| **優先度** | P0 |

---

#### A-3: DeleteNoteDrive 成功時の通知遷移

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestDeleteNoteDrive_StatusNotification_SyncingToSynced` |
| **目的** | ノート削除時の "syncing" → "synced" 通知 |
| **シナリオ** | **前提**: Drive接続済み、ノートがDrive上に存在、`notificationRecorder` を設定。**操作**: `driveService.DeleteNoteDrive(noteID)` を呼び出す。**期待結果**: `NotifyDriveStatus("syncing")` → `Info("Deleting note: %s")` → `Info("Deleted note from cloud: %s")` → `NotifyDriveStatus("synced")` |
| **検証ポイント** | Delete固有のログメッセージを含む通知の完全性 |
| **優先度** | P0 |

---

#### A-4: CreateNote 失敗時の通知

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestCreateNote_Error_NoSyncedNotification` |
| **目的** | ノート作成失敗時に "synced" が送信されないこと |
| **シナリオ** | **前提**: `driveSync.CreateNote()` がエラーを返すように設定、`notificationRecorder` を設定。**操作**: `driveService.CreateNote(note)` を呼び出す。**期待結果**: `NotifyDriveStatus("syncing")` は呼ばれる → `NotifyDriveStatus("synced")` は呼ばれ**ない** → `HandleOfflineTransition()` が呼ばれる |
| **検証ポイント** | エラー時に誤った "synced" が出ない |
| **優先度** | P0 |

---

#### A-5: CreateNote キャンセル時の通知

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestCreateNote_Cancelled_NoSyncedNotification` |
| **目的** | キュー操作がキャンセルされた場合、"synced" 通知が出ないこと |
| **シナリオ** | **前提**: `driveSync.CreateNote()` が `"operation cancelled"` エラーを返す。**操作**: `driveService.CreateNote(note)` を呼び出す。**期待結果**: `NotifyDriveStatus("synced")` が呼ばれ**ない**、エラーも返さない (nil) |
| **検証ポイント** | キャンセルはユーザーに通知不要であること |
| **優先度** | P1 |

---

#### A-6: SyncNotes 変更あり時の通知

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestSyncNotes_WithChanges_NotificationSequence` |
| **目的** | 同期で変更があった場合の完全な通知シーケンス |
| **シナリオ** | **前提**: ローカル1件、クラウド1件（異なるノート）、`notificationRecorder` を設定。**操作**: `SyncNotes()` 実行。**期待結果**: `NotifyDriveStatus("syncing")` → `Info("Starting sync with Drive...")` → `Info("Sync complete: ↑N ↓N ...")` → `NotifyFrontendSyncedAndReload()` → `NotifyDriveStatus("synced")` |
| **検証ポイント** | Summary メッセージが logger.Info() に渡されること、全通知の順序 |
| **優先度** | P0 |

---

#### A-7: SyncNotes 変更なし(MD5一致)時の通知

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestSyncNotes_NoChanges_MD5Match_SyncedNotification` |
| **目的** | MD5一致で早期リターン時に "synced" が正しく送信されること |
| **シナリオ** | **前提**: `DownloadNoteListIfChanged()` が `changed=false` を返す。**操作**: `SyncNotes()` 実行。**期待結果**: `notifySyncComplete()` 経由で `NotifyDriveStatus("synced")`。`NotifyFrontendSyncedAndReload()` は呼ばれ**ない** |
| **検証ポイント** | 変更なし時にフロントエンドリロードが発生しないこと |
| **優先度** | P1 |

---

#### A-8: SyncNotes キュー残存時の "syncing" 維持

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestSyncNotes_QueueNotEmpty_KeepsSyncingStatus` |
| **目的** | 同期完了後もキューに項目が残っている場合 "syncing" が維持されること |
| **シナリオ** | **前提**: キューにダミーアイテムを注入、`notificationRecorder` を設定。**操作**: `notifySyncComplete()` 呼び出し。**期待結果**: `NotifyDriveStatus("syncing")` が最後に出力される（"synced" ではない） |
| **検証ポイント** | 既存テスト `TestNotifySyncComplete_QueueNotEmpty_KeepsSyncing` の通知記録版 |
| **優先度** | P1 |

---

#### A-9: updateNoteListInternal 成功時の通知

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestUpdateNoteListInternal_StatusNotification` |
| **目的** | noteList更新時に "syncing" → "synced" 通知が出ること |
| **シナリオ** | **前提**: 接続済み、noteListIDが設定済み、`notificationRecorder` を設定。**操作**: `updateNoteListInternal()` を呼び出す。**期待結果**: `NotifyDriveStatus("syncing")` → 処理完了 → `NotifyDriveStatus("synced")` |
| **検証ポイント** | noteList更新操作自体の通知 |
| **優先度** | P1 |

---

#### A-10: performInitialSync の段階的通知

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestPerformInitialSync_ProgressiveNotification` |
| **目的** | 初回同期で10件超のダウンロード時に段階的な `NotifyFrontendSyncedAndReload()` が出ること |
| **シナリオ** | **前提**: クラウドに15件のノート、`notificationRecorder` を設定。**操作**: `performInitialSync()` 実行。**期待結果**: `NotifyDriveStatus("syncing")` が最初 → `NotifyFrontendSyncedAndReload()` がプレビュー用に1回 + 10件目で1回 + 15件目で1回 + 完了時1回 → `NotifyDriveStatus("synced")` が最後 |
| **検証ポイント** | 段階的通知の回数とタイミング |
| **優先度** | P1 |

---

#### A-11: reconnect 成功時の通知

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestReconnect_Success_EmitsSynced` |
| **目的** | ポーリング中の再接続成功時に "synced" が通知されること |
| **シナリオ** | **前提**: 接続断状態からトークン復旧成功、`notificationRecorder` を設定。**操作**: ポーリングループの再接続パス。**期待結果**: `NotifyDriveStatus("synced")` が呼ばれる |
| **検証ポイント** | 再接続成功がユーザーに通知されること |
| **優先度** | P1 |

---

#### A-12: SyncNotes エラー時の ErrorWithNotify

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestSyncNotes_DriveError_ErrorWithNotifyEmitted` |
| **目的** | 同期失敗時に `ErrorWithNotify()` が呼ばれること |
| **シナリオ** | **前提**: `checkForChanges()` がエラーを返す、`notificationRecorder` を設定。**操作**: ポーリングループでの処理。**期待結果**: `ErrorWithNotify(err, "Failed to sync with Drive")` が呼ばれる |
| **検証ポイント** | エラーがフロントエンドに通知されること |
| **優先度** | P1 |

---

### カテゴリB: リトライロジック (G2)

> **設計方針**: `drive_sync_service.go` の `withRetry()` 関数とその呼び出し元を対象に、リトライ可否判定・回数・バックオフをテストする。

---

#### B-1: withRetry 成功パス（初回成功）

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestWithRetry_SuccessOnFirstAttempt` |
| **目的** | リトライなしで成功する場合の動作 |
| **シナリオ** | **前提**: 操作が即座に成功。**操作**: `withRetry()` を呼び出す。**期待結果**: 操作が1回だけ呼ばれ、nilが返される |
| **検証ポイント** | 呼び出し回数が1であること |
| **優先度** | P1 |

---

#### B-2: withRetry リトライ後成功

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestWithRetry_SuccessAfterRetries` |
| **目的** | N回失敗後に成功する場合の動作 |
| **シナリオ** | **前提**: 2回 "connection" エラー → 3回目成功。**操作**: `withRetry()` を呼び出す。**期待結果**: 操作が3回呼ばれ、最終的にnilが返される |
| **検証ポイント** | 呼び出し回数が3であること、最終結果がnil |
| **優先度** | P1 |

---

#### B-3: withRetry 最大リトライ超過

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestWithRetry_ExhaustsAllRetries` |
| **目的** | 全リトライが失敗した場合にlastErrが返されること |
| **シナリオ** | **前提**: 全試行が "connection" エラー、maxRetries=3。**操作**: `withRetry()` を呼び出す。**期待結果**: 操作が3回呼ばれ、最後のエラーが返される |
| **検証ポイント** | 呼び出し回数がmaxRetries、エラー内容が最後の試行のもの |
| **優先度** | P1 |

---

#### B-4: withRetry リトライ不可エラー

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestWithRetry_NonRetryableError_StopsImmediately` |
| **目的** | shouldRetryがfalseを返すエラーの場合、即座に停止 |
| **シナリオ** | **前提**: "permission denied" エラー（shouldRetryの条件に合わない）。**操作**: `withRetry()` を呼び出す。**期待結果**: 操作が1回だけ呼ばれ、エラーが返される |
| **検証ポイント** | リトライ不可エラーでの即座停止 |
| **優先度** | P1 |

---

#### B-5: withRetry 指数バックオフ

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestWithRetry_ExponentialBackoff_DelayIncreases` |
| **目的** | 各リトライ間の遅延が指数的に増加し、maxDelayを超えないこと |
| **シナリオ** | **前提**: 時刻を記録するモック操作、baseDelay=100ms, maxDelay=500ms, maxRetries=5。**操作**: `withRetry()` を呼び出す。**期待結果**: 遅延が ~100ms, ~200ms, ~400ms, ~500ms (cap) |
| **検証ポイント** | 各呼び出し間の経過時間を計測 |
| **優先度** | P2 |

---

#### B-6: DownloadNote リトライ後のJSON解析

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestDownloadNote_RetryThenParseJSON` |
| **目的** | リトライで取得したコンテンツが正しくJSONパースされること |
| **シナリオ** | **前提**: 1回目 "connection" エラー → 2回目成功（有効なJSON）。**操作**: `DownloadNote()` を呼び出す。**期待結果**: `*Note` が正しく返される（ID, Title, Content一致） |
| **検証ポイント** | JSONパースの正常動作 |
| **優先度** | P1 |

---

#### B-7: UpdateNote リトライ全失敗 → CreateNote フォールバック

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestUpdateNote_AllRetriesFail_FallsBackToCreate` |
| **目的** | Update全失敗時にCreateNoteが呼ばれること（"not found" エラーの場合） |
| **シナリオ** | **前提**: `GetNoteID()` は成功（キャッシュにある）、`UpdateFile()` が "not found" エラーを返す。**操作**: `UpdateNote()` を呼び出す。**期待結果**: フォールバックとして `CreateNote()` が呼ばれ、新ファイルが作成される |
| **検証ポイント** | フォールバック動作、ファイルが最終的に存在すること |
| **優先度** | P1 |

---

#### B-8: 各リトライ設定の shouldRetry 条件

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestRetryConfig_ShouldRetry_Conditions` |
| **目的** | defaultRetryConfig, downloadRetryConfig, uploadRetryConfig, getFileIDRetryConfig, listOperationRetryConfig の shouldRetry 関数が正しい条件で true/false を返すこと |
| **シナリオ** | **前提**: 各設定のshouldRetry関数を取得。**操作**: "not found", "connection", "deadline exceeded", "internal error", "idle HTTP channel", "permission denied", nil 等のエラーで呼び出す。**期待結果**: 各設定に応じたtrue/falseの返却 |
| **検証ポイント** | サブテスト形式で各設定×エラー種別の組み合わせ |
| **優先度** | P1 |

---

### カテゴリC: UpdateNoteList デバウンス (G3)

> **設計方針**: `drive_service.go` の `UpdateNoteList()` メソッドの2秒デバウンスロジックをテスト。内部状態 (`lastNoteListUpload`, `deferredUploadTimer`) へのアクセスが必要。

---

#### C-1: 2秒以内の連続呼び出し → デバウンス

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestUpdateNoteList_WithinTwoSeconds_Deferred` |
| **目的** | 直前のアップロードから2秒以内に呼ばれた場合、即時実行されずデバウンスされること |
| **シナリオ** | **前提**: `lastNoteListUpload` を 1秒前に設定。**操作**: `UpdateNoteList()` を呼ぶ。**期待結果**: `deferredUploadTimer` が非nil、`updateNoteListInternal()` は即時呼ばれない（`notificationRecorder` で "syncing" が出ていないことを確認） |
| **検証ポイント** | デバウンスの条件分岐 |
| **優先度** | P1 |

---

#### C-2: 2秒超過後の呼び出し → 即時実行

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestUpdateNoteList_AfterTwoSeconds_Immediate` |
| **目的** | 直前のアップロードから2秒超過の場合、即時実行されること |
| **シナリオ** | **前提**: `lastNoteListUpload` を 3秒前に設定。**操作**: `UpdateNoteList()` を呼ぶ。**期待結果**: `updateNoteListInternal()` が即座に呼ばれる（`notificationRecorder` で "syncing" → "synced" が確認できる） |
| **検証ポイント** | 即時実行の条件分岐 |
| **優先度** | P1 |

---

#### C-3: デバウンス中の再呼び出し → タイマーリセット

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestUpdateNoteList_DeferredThenCalledAgain_TimerReset` |
| **目的** | デバウンス中に再度呼ばれた場合、既存タイマーが停止され新タイマーに置換されること |
| **シナリオ** | **前提**: `lastNoteListUpload` を 0.5秒前に設定。**操作**: `UpdateNoteList()` → 即座にもう一度 `UpdateNoteList()`。**期待結果**: 古いタイマーの `Stop()` が呼ばれる。最終的に `updateNoteListInternal()` は1回だけ実行 |
| **検証ポイント** | タイマーの置換と重複実行の防止 |
| **優先度** | P1 |

---

#### C-4: デバウンスタイマー発火後の実行確認

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestUpdateNoteList_DeferredTimer_EventuallyFires` |
| **目的** | デバウンスされたアップロードが2秒後に実際に実行されること |
| **シナリオ** | **前提**: `lastNoteListUpload` を現在時刻に設定。**操作**: `UpdateNoteList()` を呼び、3秒待つ（2秒デバウンス + マージン1秒）。**期待結果**: `updateNoteListInternal()` が最終的に呼ばれる（`notificationRecorder` で確認） |
| **検証ポイント** | デバウンス後の実際の実行 |
| **優先度** | P1 |

---

#### C-5: デバウンスタイマー内のエラーハンドリング

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestUpdateNoteList_DeferredTimer_ErrorLogged` |
| **目的** | タイマー発火時に `saveNoteList()` や `updateNoteListInternal()` が失敗した場合、エラーがログに記録されること |
| **シナリオ** | **前提**: `noteService.saveNoteList()` がエラーを返すように設定（ディスク書き込み失敗等）。**操作**: デバウンスタイマー発火を待つ（3秒）。**期待結果**: `logger.Error()` が呼ばれ、エラーメッセージがログに記録される |
| **検証ポイント** | タイマーgoroutine内のエラーが黙殺されないこと |
| **優先度** | P2 |

---

### カテゴリD: SaveNoteAndUpdateList アトミシティ (G4)

> **設計方針**: `drive_service.go` の `SaveNoteAndUpdateList()` が syncMu 内でノート保存とリスト更新を一括実行するアトミシティを検証。

---

#### D-1: Create成功 + リスト更新成功

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestSaveNoteAndUpdateList_CreateSuccess_ListUpdated` |
| **目的** | ノート作成とリスト更新が両方成功すること |
| **シナリオ** | **前提**: 接続済み、isCreate=true。**操作**: `SaveNoteAndUpdateList(note, true)`。**期待結果**: `CreateNote()` 成功 → `saveNoteList()` 成功 → `updateNoteListInternal()` が呼ばれる |
| **検証ポイント** | 全3ステップの成功 |
| **優先度** | P0 |

---

#### D-2: Update成功 + リスト更新成功

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestSaveNoteAndUpdateList_UpdateSuccess_ListUpdated` |
| **目的** | ノート更新とリスト更新が両方成功すること |
| **シナリオ** | **前提**: 接続済み、isCreate=false、ノートがDrive上に存在。**操作**: `SaveNoteAndUpdateList(note, false)`。**期待結果**: `UpdateNote()` 成功 → `saveNoteList()` 成功 → `updateNoteListInternal()` が呼ばれる |
| **検証ポイント** | Update版の全3ステップ成功 |
| **優先度** | P0 |

---

#### D-3: Create失敗 → リスト更新されないこと

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestSaveNoteAndUpdateList_CreateFails_ListNotUpdated` |
| **目的** | ノート作成失敗時にnoteListが更新されないこと |
| **シナリオ** | **前提**: `driveSync.CreateNote()` がエラーを返す。**操作**: `SaveNoteAndUpdateList(note, true)`。**期待結果**: エラー返却、`saveNoteList()` は呼ばれない（`notificationRecorder` で "synced" が出ていないことを確認） |
| **検証ポイント** | 作成失敗時のロールバック（リスト更新スキップ） |
| **優先度** | P0 |

---

#### D-4: Create成功 + saveNoteList失敗

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestSaveNoteAndUpdateList_SaveNoteListFails` |
| **目的** | Driveアップロード成功後にローカル保存が失敗した場合のエラーハンドリング |
| **シナリオ** | **前提**: ノート作成成功、`noteService.saveNoteList()` がエラー（ディスクフル等）。**操作**: `SaveNoteAndUpdateList(note, true)`。**期待結果**: エラーが返却される。`updateNoteListInternal()` は呼ばれない |
| **検証ポイント** | ローカル保存失敗時にDriveアップロード済みの状態でエラーが伝搬すること |
| **優先度** | P0 |

---

#### D-5: キャンセル時のnilリターン

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestSaveNoteAndUpdateList_Cancelled_ReturnsNil` |
| **目的** | "operation cancelled" エラー時にnilが返され、リスト更新も行われないこと |
| **シナリオ** | **前提**: `driveSync.CreateNote()` が "operation cancelled" エラーを返す。**操作**: `SaveNoteAndUpdateList(note, true)`。**期待結果**: nil返却、`saveNoteList()` は呼ばれない |
| **検証ポイント** | キャンセルが正常終了として扱われること |
| **優先度** | P1 |

---

#### D-6: 未接続時のエラー

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestSaveNoteAndUpdateList_NotConnected_Error` |
| **目的** | 未接続時にHandleOfflineTransitionが呼ばれ、エラーが返ること |
| **シナリオ** | **前提**: `IsConnected()` = false。**操作**: `SaveNoteAndUpdateList(note, true)`。**期待結果**: エラー返却、HandleOfflineTransition相当の処理 |
| **検証ポイント** | 未接続チェックの早期リターン |
| **優先度** | P1 |

---

#### D-7: syncMuの排他確認

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestSaveNoteAndUpdateList_MutualExclusionWithSyncNotes` |
| **目的** | `SaveNoteAndUpdateList()` と `SyncNotes()` が同時実行されないこと |
| **シナリオ** | **前提**: `SaveNoteAndUpdateList()` をブロッキングモック（チャネルで制御）で遅延させる。**操作**: goroutine A が `SaveNoteAndUpdateList()` を開始 → goroutine B が `SyncNotes()` を開始 → goroutine A をブロック解除。**期待結果**: goroutine B は goroutine A の完了後に実行される（同時実行されない） |
| **検証ポイント** | syncMuによる排他制御、タイムアウト付きチャネルで検証 |
| **優先度** | P0 |

---

### カテゴリE: performInitialSync 詳細フロー (G5)

> **設計方針**: `drive_service.go` の `performInitialSync()` 内部の各フェーズを個別にテスト。

---

#### E-1: クラウドにnoteListが存在しない場合

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestPerformInitialSync_NoCloudNoteList_UploadsAll` |
| **目的** | クラウドにnoteListが無い場合、全ローカルノートがアップロードされること |
| **シナリオ** | **前提**: `DownloadNoteList()` がnilを返す、ローカルに3件のノート。**操作**: `performInitialSync()` 実行。**期待結果**: `uploadAllNotesWithContent()` が呼ばれ、3件アップロード |
| **検証ポイント** | nil noteList 時のアップロードパス |
| **優先度** | P1 |

---

#### E-2: unknownNotes の取り込み

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestPerformInitialSync_UnknownNotes_Incorporated` |
| **目的** | noteListに登録されていないがDriveに存在するノートが取り込まれること |
| **シナリオ** | **前提**: クラウドnoteListに2件、Driveフォルダに3件（1件はnoteList未登録）。**操作**: `performInitialSync()` 実行。**期待結果**: unknownNote のメタデータが mergeCloudNotes に含まれ、ダウンロードされる |
| **検証ポイント** | `prepareCloudNotesForMerge()` / `ListUnknownNotes()` の動作 |
| **優先度** | P1 |

---

#### E-3: publishPreviewNoteList の検証

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestPerformInitialSync_PublishesPreview` |
| **目的** | ダウンロード前にメタデータだけのプレビューがフロントエンドに通知されること |
| **シナリオ** | **前提**: ローカル2件、クラウド3件（1件は新規）、`notificationRecorder` を設定。**操作**: `publishPreviewNoteList()` 呼び出し。**期待結果**: `noteService.noteList.Notes` にクラウド新規分が追加される。`NotifyFrontendSyncedAndReload()` が呼ばれる |
| **検証ポイント** | プレビューが正しいメタデータを含むこと |
| **優先度** | P1 |

---

#### E-4: 大量ノート(10件超)の段階的通知

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestPerformInitialSync_LargeDownload_ProgressiveNotification` |
| **目的** | 10件超のダウンロード時に10件毎に `NotifyFrontendSyncedAndReload()` が呼ばれること |
| **シナリオ** | **前提**: クラウドに25件のノート（ローカル0件）、`notificationRecorder` を設定。**操作**: `performInitialSync()` 実行。**期待結果**: `NotifyFrontendSyncedAndReload()` が少なくとも3回呼ばれる（10件目、20件目、25件完了時） |
| **検証ポイント** | `syncedAndReloadCalls >= 3` |
| **優先度** | P1 |

---

#### E-5: ジャーナル作成 → 完了 → 削除の完全フロー

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestPerformInitialSync_JournalLifecycle` |
| **目的** | ジャーナルが作成され、各アクション完了時にマークされ、最後に削除されること |
| **シナリオ** | **前提**: ローカル1件、クラウド2件（1件新規ダウンロード対象）。**操作**: `performInitialSync()` 実行。**期待結果**: `buildSyncJournal()` でジャーナル作成 → `markJournalActionCompleted()` が各ノートで呼ばれる → `deleteSyncJournal()` で削除。最終的にジャーナルファイルが存在しない |
| **検証ポイント** | 既存テストはジャーナル単体を検証。performInitialSyncとの統合を検証 |
| **優先度** | P1 |

---

### カテゴリF: キュー操作の追加エッジケース (G6)

> **設計方針**: `drive_operations_queue.go` の既存テストを拡張。

---

#### F-1: UPDATE→DELETE→CREATE の連鎖

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestQueue_UpdateDeleteCreate_Chain` |
| **目的** | 同一ファイルに対するUPDATE→DELETE→CREATE が正しく処理されること |
| **シナリオ** | **前提**: 既存ファイル "file-1"。**操作**: UPDATE("file-1", "v2") → DELETE("file-1") → CREATE("file-1.json", "v3")。**期待結果**: UPDATEはキャンセル（ErrOperationCancelled）。DELETEが実行（既存ファイル削除）。CREATEが実行（新ファイル作成）。最終状態は "v3" の新ファイル |
| **検証ポイント** | 各操作の結果（エラー or 成功）、最終ファイル内容 |
| **優先度** | P1 |

---

#### F-2: CREATE→UPDATE の連鎖（同一ファイル名）

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestQueue_CreateThenUpdate_SameFile` |
| **目的** | CREATE直後のUPDATEが正しく処理されること |
| **シナリオ** | **前提**: 新規ファイル。**操作**: CREATE("note.json", "v1") → 結果のfileIDを取得 → UPDATE(fileID, "v2")。**期待結果**: 両方成功。最終コンテンツは "v2" |
| **検証ポイント** | CREATE結果のfileIDがUPDATEに正しく使用されること |
| **優先度** | P1 |

---

#### F-3: キューバッファフル（100件）

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestQueue_BufferFull_BlocksUntilSpace` |
| **目的** | キューバッファが満杯になった場合の動作確認 |
| **シナリオ** | **前提**: `processQueue` をブロッキングモック（blockingDriveOps）で停止させる。**操作**: 100件のCREATE操作をgoroutineでenqueue。101件目のenqueueを試行。**期待結果**: 101件目はchannelが満杯のためブロック。blockChを解放すると101件目も処理される |
| **検証ポイント** | バッファサイズ制限の動作、デッドロックが発生しないこと |
| **優先度** | P2 |

---

#### F-4: WaitForEmpty タイムアウト

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestQueue_WaitForEmpty_Timeout` |
| **目的** | キューが空にならない場合にタイムアウトでfalseを返すこと |
| **シナリオ** | **前提**: `processQueue` をblockingDriveOpsで停止。1件キューに追加。**操作**: `WaitForEmpty(200 * time.Millisecond)`。**期待結果**: false が返される（200ms以内にキューが空にならない） |
| **検証ポイント** | タイムアウト値の遵守 |
| **優先度** | P2 |

---

#### F-5: WaitForEmpty 成功（タイムアウト前に空になる）

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestQueue_WaitForEmpty_Success` |
| **目的** | キューが時間内に空になった場合にtrueを返すこと |
| **シナリオ** | **前提**: 1件の高速操作（mockDriveOperations）をenqueue。**操作**: `WaitForEmpty(5 * time.Second)`。**期待結果**: true が返される |
| **検証ポイント** | 正常ケースの成功リターン |
| **優先度** | P2 |

---

#### F-6: 複数ファイルへの同時UPDATE（異なるファイル）

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestQueue_ConcurrentUpdates_DifferentFiles` |
| **目的** | 異なるファイルへの同時UPDATEがすべて正しく処理されること |
| **シナリオ** | **前提**: 3つの異なるファイル ("file-a", "file-b", "file-c") が存在。**操作**: 3つのUPDATEをgoroutineで同時にenqueue。**期待結果**: 全てが成功（デバウンスは同一ファイルのみ適用）。各ファイルの最終コンテンツが正しい |
| **検証ポイント** | 異なるファイルへの操作が互いに干渉しないこと |
| **優先度** | P1 |

---

#### F-7: Cleanup後の遅延goroutine安全性

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestQueue_Cleanup_DelayedGoroutine_SafeReturn` |
| **目的** | デバウンスの遅延goroutineがCleanup後に安全に終了すること |
| **シナリオ** | **前提**: UPDATEをenqueue（3秒デバウンス開始）。**操作**: 1秒後にCleanup()。さらに5秒待ってgoroutineリークがないことを確認。**期待結果**: パニックなし。UPDATE結果はErrOperationCancelled。goroutineが安全に終了 |
| **検証ポイント** | 既存テスト `TestQueue_Cleanup_DuringDebouncedUpdate_NoPanic` を拡張し、goroutine終了の確認を追加 |
| **優先度** | P1 |

---

### カテゴリG: ポーリング詳細 (G7)

> **設計方針**: `drive_polling.go` の `DrivePollingService` の各メソッドを個別テスト。ポーリングループ全体の起動は避け、内部メソッドを直接テストする。

---

#### G-1: 接続断 → 再接続成功フロー

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestPolling_Disconnected_ReconnectSuccess` |
| **目的** | 接続断時に `reconnect()` が呼ばれ、成功後にトークンとインターバルがリセットされること |
| **シナリオ** | **前提**: `IsConnected()` = false。`reconnect()` がトークン更新に成功するモック。**操作**: ポーリングループ1反復を模擬。**期待結果**: `changePageToken` = ""（リセット）。interval = initialInterval。`NotifyDriveStatus("synced")` が呼ばれる |
| **検証ポイント** | 再接続後の状態リセット |
| **優先度** | P1 |

---

#### G-2: 接続断 → 再接続失敗 → 指数バックオフ

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestPolling_Disconnected_ReconnectFail_Backoff` |
| **目的** | 再接続失敗時にバックオフが指数的に増加すること |
| **シナリオ** | **前提**: `reconnect()` が連続で失敗するモック。**操作**: reconnectDelayを初期値(10s)から開始し、失敗ごとに更新。**期待結果**: reconnectDelay が 10s → 15s → 22.5s → ... → 最大3分（180秒）でキャップ |
| **検証ポイント** | factor=1.5の指数増加、maxReconnectDelay=3分のキャップ |
| **優先度** | P1 |

---

#### G-3: Changes API トークンなし → フルSync

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestPolling_NoChangeToken_FullSync` |
| **目的** | changePageTokenが空の場合にSyncNotes()が直接呼ばれ、その後トークンが初期化されること |
| **シナリオ** | **前提**: `changePageToken` = ""。**操作**: `checkForChanges()` 呼び出し。**期待結果**: 返却が `(true, nil)`。SyncNotes()が呼ばれる。`initChangeToken()` でトークンが設定される |
| **検証ポイント** | トークン未設定時のフルSyncフォールバック |
| **優先度** | P1 |

---

#### G-4: Changes API エラー → トークンクリア → 次回フルSync

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestPolling_ChangesAPIError_ClearsToken` |
| **目的** | ListChanges()がエラーの場合にトークンがクリアされ、次回のフルSyncが保証されること |
| **シナリオ** | **前提**: `changePageToken` = "valid-token"。`ListChanges()` がエラーを返す。**操作**: `checkForChanges()` 呼び出し。**期待結果**: `changePageToken` = ""（クリア）。`hasChanges` = true が返される（次回フルSync保証） |
| **検証ポイント** | エラーリカバリとしてのトークンクリア |
| **優先度** | P1 |

---

#### G-5: キュー非空時のポーリングスキップ

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestPolling_QueueHasItems_SkipsAndResetsInterval` |
| **目的** | キューに項目がある場合にチェック自体がスキップされ、インターバルがリセットされること |
| **シナリオ** | **前提**: `operationsQueue.HasItems()` = true。**操作**: ポーリングループの1反復を模擬。**期待結果**: `checkForChanges()` は呼ばれない。interval が initialInterval にリセットされる |
| **検証ポイント** | キュー非空時のスキップ動作 |
| **優先度** | P1 |

---

#### G-6: 変更検出 → SyncNotes成功 → 変更あり → インターバルリセット

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestPolling_ChangesDetected_SyncSuccess_IntervalReset` |
| **目的** | 変更を検出し同期成功した場合、インターバルが初期値にリセットされること |
| **シナリオ** | **前提**: `checkForChanges()` = (true, nil)。`SyncNotes()` 成功。`lastSyncResult.HasChanges()` = true。interval = 30秒（増加後の値）。**操作**: ポーリングループの1反復。**期待結果**: interval = initialInterval（5秒）にリセット |
| **検証ポイント** | 変更あり時のインターバルリセット |
| **優先度** | P1 |

---

#### G-7: 変更なし → インターバル増加

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestPolling_NoChanges_IntervalIncreases` |
| **目的** | 変更がない場合にインターバルが factor(1.5) 倍に増加し、maxInterval(60秒)でキャップされること |
| **シナリオ** | **前提**: `checkForChanges()` = (false, nil)。初期interval = 5秒。**操作**: ポーリングループの数反復。**期待結果**: 5s → 7.5s → 11.25s → ... → 最大60秒 |
| **検証ポイント** | factor=1.5、maxInterval=60秒のキャップ |
| **優先度** | P2 |

---

#### G-8: StopPolling の安全な停止

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestPolling_StopPolling_Safe` |
| **目的** | ポーリング実行中にStopPolling()を呼んでも安全に停止すること |
| **シナリオ** | **前提**: `StartPolling()` でポーリングgoroutineを起動。**操作**: 500ms後に `StopPolling()` 呼び出し。**期待結果**: goroutineが終了する。パニックなし。再度 `StartPolling()` を呼べること |
| **検証ポイント** | cancel()によるgoroutine終了の確認 |
| **優先度** | P1 |

---

#### G-9: ResetPollingInterval のノンブロッキング動作

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestPolling_ResetPollingInterval_NonBlocking` |
| **目的** | resetPollingChan が満杯でもブロックしないこと |
| **シナリオ** | **前提**: チャネルバッファ1で既に信号あり。**操作**: `ResetPollingInterval()` を2回連続呼び出し。**期待結果**: パニックもブロックもなし。2回目の呼び出しが即座に返る |
| **検証ポイント** | select default パターンの動作 |
| **優先度** | P2 |

---

### カテゴリH: コンフリクト解決の追加エッジケース (G8, G9)

> **設計方針**: `mergeNotes()` の追加エッジケースを `drive_service_test.go` に追加。

---

#### H-1: 空ノート vs 非空ノートのコンフリクト

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestMergeNotes_EmptyVsNonEmpty_ConflictMerge` |
| **目的** | ローカルが空、クラウドが非空（またはその逆）のコンフリクトマージが正しく行われること |
| **シナリオ** | **前提**: ローカル Content=""、クラウド Content="data"、同一ModifiedTime。**操作**: `mergeNotes()` 実行。**期待結果**: `isOneSidedChange()` で片方の変更と判定されるか、`MergeConflictContent()` が呼ばれ、コンフリクトマーカーが含まれる。空文字列側がマーカー内で適切に表現される |
| **検証ポイント** | 空文字列がクラッシュを引き起こさないこと。マージ結果に両バージョンが含まれること |
| **優先度** | P2 |

---

#### H-2: タイトルのみ変更のコンフリクト

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestMergeNotes_TitleOnlyChange_DetectedByContentHash` |
| **目的** | タイトルのみの変更がContentHashの差分として検出され、同期処理が発動すること |
| **シナリオ** | **前提**: 同一Content "hello"。ローカル Title="A"、クラウド Title="B"。同一ModifiedTime。**操作**: 各ノートの `computeContentHash()` で異なるハッシュが生成されることを確認。`mergeNotes()` 実行。**期待結果**: ContentHashが異なるため同期処理（ダウンロードまたはコンフリクトマージ）が発動する |
| **検証ポイント** | タイトルのみの差異でmergeNotesの "hash不一致" パスに入ること |
| **優先度** | P2 |

---

#### H-3: 言語設定のみ変更のコンフリクト

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestMergeNotes_LanguageOnlyChange_DetectedByContentHash` |
| **目的** | 言語変更のみでもContentHashの差分として検出されること |
| **シナリオ** | **前提**: 同一Content, Title。ローカル Language="plaintext"、クラウド Language="javascript"。同一ModifiedTime。**操作**: `computeContentHash()` で異なるハッシュ確認 → `mergeNotes()` 実行。**期待結果**: ContentHashが異なるため同期処理が発動する |
| **検証ポイント** | Language変更のハッシュ差異検出 |
| **優先度** | P2 |

---

### カテゴリI: データ整合性 (G11, G12)

> **設計方針**: `drive_sync_service.go` の `DownloadNoteList()`, `DownloadNoteListIfChanged()`, `DeduplicateNotes()` と `drive_service.go` のクラウドのみノート処理のエッジケースを検証。

---

#### I-1: noteList.json の破損 → cachedNoteList フォールバック

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestDownloadNoteList_CorruptedJSON_FallbackToCached` |
| **目的** | クラウドのnoteList.jsonが破損している場合、キャッシュされた最後の正常なnoteListが使われること |
| **シナリオ** | **前提**: 1回目の `DownloadNoteList()` で正常なJSONを取得（`cachedNoteList` に保存される）。2回目の `DownloadFile()` が不正JSON `{invalid}` を返す。**操作**: 2回目の `DownloadNoteList()` 呼び出し。**期待結果**: `cachedNoteList` が返される。`logger.Info("Cloud note list is corrupted, using cached version")` 相当が出力 |
| **検証ポイント** | キャッシュフォールバックの動作 |
| **優先度** | P1 |

---

#### I-2: noteList.json の破損 + キャッシュなし → エラー

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestDownloadNoteList_CorruptedJSON_NoCached_Error` |
| **目的** | キャッシュがない状態で破損JSONを受信した場合にエラーが返ること |
| **シナリオ** | **前提**: `cachedNoteList` = nil（初回ダウンロード）。`DownloadFile()` が不正JSON を返す。**操作**: `DownloadNoteList()` 呼び出し。**期待結果**: "failed to decode note list" エラーが返される |
| **検証ポイント** | キャッシュなし時のエラー伝搬 |
| **優先度** | P1 |

---

#### I-3: Cloud-only ノートの一時エラー → noteList残留

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestMergeNotes_CloudOnly_TempError_RemainsInNoteList` |
| **目的** | ダウンロード一時エラー時にノートがnoteListに残り、次回リトライ対象になること |
| **シナリオ** | **前提**: クラウドのみノート "temp-error-note"。`DownloadNote()` が "connection" エラーを返す（一時エラー）。**操作**: `mergeNotes()` 実行。**期待結果**: `mergedNotes` にクラウドメタデータが含まれる（除外されない）。`lastSyncResult.Errors++` |
| **検証ポイント** | 一時エラーでnoteListから除外されないこと（次回リトライ可能） |
| **優先度** | P1 |

---

#### I-4: Cloud-only ノートの "not found" → noteList除外

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestMergeNotes_CloudOnly_NotFound_RemovedFromNoteList` |
| **目的** | Driveから削除済みのノートがnoteListから除外されること |
| **シナリオ** | **前提**: クラウドのみノート "deleted-on-drive"。`DownloadNote()` が "file not found" エラーを返す。**操作**: `mergeNotes()` 実行。**期待結果**: `mergedNotes` にクラウドメタデータが含まれ**ない**（noteListから除外）。`logger.Info("Note %s not found on Drive, removing from note list")` 相当が出力 |
| **検証ポイント** | 永続エラーでのnoteList除外（既存テスト `TestMergeNotes_CorruptedNote_SkipsAndContinues` の "not found" 明示版） |
| **優先度** | P1 |

---

#### I-5: DownloadNoteListIfChanged MD5一致スキップ

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestDownloadNoteListIfChanged_MD5Match_SkipsDownload` |
| **目的** | MD5チェックサムが前回と一致する場合にダウンロードがスキップされること |
| **シナリオ** | **前提**: `lastNoteListMd5` = "abc123"。`GetFileMetadata()` が `Md5Checksum: "abc123"` を返す。**操作**: `DownloadNoteListIfChanged()` 呼び出し。**期待結果**: `(nil, false, nil)` が返される（ダウンロードなし） |
| **検証ポイント** | MD5比較によるダウンロードスキップ |
| **優先度** | P1 |

---

#### I-6: DownloadNoteListIfChanged メタデータ取得失敗 → フルダウンロード

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestDownloadNoteListIfChanged_MetadataError_FullDownload` |
| **目的** | メタデータ取得失敗時にフルダウンロードにフォールバックすること |
| **シナリオ** | **前提**: `GetFileMetadata()` がエラーを返す。**操作**: `DownloadNoteListIfChanged()` 呼び出し。**期待結果**: `DownloadNoteList()` が呼ばれ、`(noteList, true, nil)` が返される |
| **検証ポイント** | メタデータ失敗時のフォールバック |
| **優先度** | P1 |

---

#### I-7: DeduplicateNotes の重複ID処理

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestDeduplicateNotes_DuplicateIDs_KeepsLatest` |
| **目的** | 同一IDのノートが複数ある場合、最新の ModifiedTime を持つものだけが保持されること |
| **シナリオ** | **前提**: ID "note-1" が2件（古い版: ModifiedTime=1時間前、新しい版: ModifiedTime=現在）。**操作**: `DeduplicateNotes()` 呼び出し。**期待結果**: 1件だけ返される。ModifiedTimeが新しい方が残る |
| **検証ポイント** | 重複排除の正しさ |
| **優先度** | P1 |

---

#### I-8: DeduplicateNotes 空リスト

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestDeduplicateNotes_EmptyList` |
| **目的** | 空リストでパニックしないこと |
| **シナリオ** | **前提**: 空の `[]NoteMetadata{}`。**操作**: `DeduplicateNotes()` 呼び出し。**期待結果**: 空スライスが返される。パニックなし |
| **検証ポイント** | 境界値テスト |
| **優先度** | P2 |

---

### カテゴリJ: SyncNotes 統合シナリオ

> **設計方針**: `SyncNotes()` の統合レベルのテスト。複数の内部パスを横断するシナリオ。

---

#### J-1: SyncNotes コンテンツ同一 + 構造変更 → 構造マージのみ

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestSyncNotes_SameNotes_StructureChanged_MergesStructure` |
| **目的** | ノート内容は同じだがフォルダ構造が変わった場合に、構造のみマージされること |
| **シナリオ** | **前提**: ローカルとクラウドのノートが ContentHash 一致。クラウドに新規フォルダ追加。**操作**: `SyncNotes()` 実行。**期待結果**: `mergeNotes()` ではダウンロード/アップロードなし。`mergeNoteListStructure()` が呼ばれ、新規フォルダが追加される。`updateNoteListInternal()` が実行される |
| **検証ポイント** | ノート内容の変更なしでも構造変更が反映されること |
| **優先度** | P1 |

---

#### J-2: SyncNotes cloudNoteList が nil → 全ノートアップロード

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestSyncNotes_CloudNoteListNil_UploadsAll` |
| **目的** | クラウドにnoteListが無い場合、全ローカルノートアップロード後に再取得すること |
| **シナリオ** | **前提**: `DownloadNoteList()` がnilを返す。ローカルに2件のノート。**操作**: `SyncNotes()` 実行。**期待結果**: `uploadAllNotesWithContent()` が呼ばれ、2件アップロード。再度 `DownloadNoteList()` が呼ばれ、アップロード結果が反映される |
| **検証ポイント** | nil noteList 時の完全同期フロー |
| **優先度** | P1 |

---

#### J-3: SyncNotes forceSync=true → MD5チェックバイパス

| 項目 | 内容 |
|---|---|
| **テスト名** | `TestSyncNotes_ForceSync_BypassesMD5Check` |
| **目的** | `forceNextSync=true` の場合、`DownloadNoteListIfChanged()` ではなく `DownloadNoteList()` が呼ばれること |
| **シナリオ** | **前提**: `forceNextSync` = true。接続済み。**操作**: `SyncNotes()` 実行。**期待結果**: `DownloadNoteList()` が直接呼ばれる（IfChanged バージョンではない）。`forceNextSync` が false にリセットされる |
| **検証ポイント** | forceSync フラグによるバイパス動作（既存テスト `TestForceNextSync_ResetsAfterSyncNotes` はフラグリセットのみ検証。バイパス動作自体を追加検証） |
| **優先度** | P1 |

---

## 3. 実装ガイド

### 3.1 テスト用モック拡張の設計

#### notificationRecorder -- ステータス通知の記録

```go
// notificationRecorder はAppLoggerの通知メソッド呼び出しを記録するモック
type notificationRecorder struct {
	AppLogger // 埋め込みで既存の動作を保持（Console出力等）
	mu                    sync.Mutex
	driveStatusCalls      []string          // NotifyDriveStatus の引数履歴
	infoCalls             []string          // Info の引数履歴
	errorCalls            []string          // Error のメッセージ履歴
	errorWithNotifyCalls  []string          // ErrorWithNotify のメッセージ履歴
	syncedAndReloadCalls  int               // NotifyFrontendSyncedAndReload の呼び出し回数
}

func newNotificationRecorder(ctx context.Context, tempDir string) *notificationRecorder {
	return &notificationRecorder{
		AppLogger: NewAppLogger(ctx, true, tempDir),
	}
}

func (r *notificationRecorder) NotifyDriveStatus(ctx context.Context, status string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.driveStatusCalls = append(r.driveStatusCalls, status)
}

func (r *notificationRecorder) Info(format string, args ...interface{}) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.infoCalls = append(r.infoCalls, fmt.Sprintf(format, args...))
}

func (r *notificationRecorder) ErrorWithNotify(err error, format string, args ...interface{}) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.errorWithNotifyCalls = append(r.errorWithNotifyCalls, fmt.Sprintf(format, args...))
}

func (r *notificationRecorder) NotifyFrontendSyncedAndReload(ctx context.Context) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.syncedAndReloadCalls++
}

// アサーション用ヘルパー
func (r *notificationRecorder) AssertDriveStatusSequence(t *testing.T, expected []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	assert.Equal(t, expected, r.driveStatusCalls, "drive:status通知の順序が期待と異なる")
}

func (r *notificationRecorder) AssertInfoContains(t *testing.T, substr string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	found := false
	for _, msg := range r.infoCalls {
		if strings.Contains(msg, substr) {
			found = true
			break
		}
	}
	assert.True(t, found, "Info()に '%s' を含むメッセージが見つからない。記録: %v", substr, r.infoCalls)
}

func (r *notificationRecorder) AssertNoSyncedAfterError(t *testing.T) {
	r.mu.Lock()
	defer r.mu.Unlock()
	// "syncing" の後に "synced" が来ていないことを確認
	lastSyncing := -1
	for i, s := range r.driveStatusCalls {
		if s == "syncing" { lastSyncing = i }
	}
	for i, s := range r.driveStatusCalls {
		if s == "synced" && i > lastSyncing && lastSyncing >= 0 {
			t.Errorf("エラー後に 'synced' が送信された: %v", r.driveStatusCalls)
		}
	}
}
```

#### retryCountingOps -- リトライ回数を記録

```go
type retryCountingOps struct {
	*mockDriveOperations
	mu         sync.Mutex
	callCounts map[string]int  // メソッド名→呼び出し回数
	failUntil  map[string]int  // メソッド名→N回目まで失敗
	failErr    error           // 失敗時に返すエラー
}

func newRetryCountingOps(failUntil map[string]int, failErr error) *retryCountingOps {
	return &retryCountingOps{
		mockDriveOperations: newMockDriveOperations(),
		callCounts:          make(map[string]int),
		failUntil:           failUntil,
		failErr:             failErr,
	}
}

func (r *retryCountingOps) DownloadFile(fileID string) ([]byte, error) {
	r.mu.Lock()
	r.callCounts["DownloadFile"]++
	count := r.callCounts["DownloadFile"]
	r.mu.Unlock()
	if count <= r.failUntil["DownloadFile"] {
		return nil, r.failErr
	}
	return r.mockDriveOperations.DownloadFile(fileID)
}

// UpdateFile, CreateFile 等も同様に実装
```

#### delayTrackingOps -- リトライ間隔を記録

```go
type delayTrackingOps struct {
	*mockDriveOperations
	mu        sync.Mutex
	callTimes []time.Time
	failErr   error
}

func (d *delayTrackingOps) DownloadFile(fileID string) ([]byte, error) {
	d.mu.Lock()
	d.callTimes = append(d.callTimes, time.Now())
	d.mu.Unlock()
	return nil, d.failErr
}

func (d *delayTrackingOps) Delays() []time.Duration {
	d.mu.Lock()
	defer d.mu.Unlock()
	delays := make([]time.Duration, 0, len(d.callTimes)-1)
	for i := 1; i < len(d.callTimes); i++ {
		delays = append(delays, d.callTimes[i].Sub(d.callTimes[i-1]))
	}
	return delays
}
```

### 3.2 テストヘルパーの共通化案

```go
// newTestDriveServiceWithRecorder はnotificationRecorder付きのdriveServiceを返す
func newTestDriveServiceWithRecorder(helper *testHelper) (*driveService, *notificationRecorder) {
	recorder := newNotificationRecorder(context.Background(), helper.tempDir)
	ds := newTestDriveService(helper)
	ds.logger = recorder
	return ds, recorder
}

// setupCloudNotes はモックDriveOpsにN件のノートを配置し、メタデータリストを返す
func setupCloudNotes(t *testing.T, mockOps *mockDriveOperations, count int) []NoteMetadata {
	notes := make([]NoteMetadata, count)
	for i := 0; i < count; i++ {
		note := &Note{
			ID:           fmt.Sprintf("cloud-note-%d", i),
			Title:        fmt.Sprintf("Cloud Note %d", i),
			Content:      fmt.Sprintf("content %d", i),
			Language:     "plaintext",
			ModifiedTime: time.Now().Format(time.RFC3339),
		}
		data, _ := json.Marshal(note)
		_, err := mockOps.CreateFile(note.ID+".json", data, "test-folder", "application/json")
		assert.NoError(t, err)
		notes[i] = NoteMetadata{
			ID:           note.ID,
			Title:        note.Title,
			ContentHash:  computeContentHash(note),
			ModifiedTime: note.ModifiedTime,
		}
	}
	return notes
}

// setupLocalNotes はnoteServiceにN件のノートを保存し、メタデータリストを返す
func setupLocalNotes(t *testing.T, ns *noteService, count int) []NoteMetadata {
	for i := 0; i < count; i++ {
		note := &Note{
			ID:       fmt.Sprintf("local-note-%d", i),
			Title:    fmt.Sprintf("Local Note %d", i),
			Content:  fmt.Sprintf("local content %d", i),
			Language: "plaintext",
		}
		err := ns.SaveNote(note)
		assert.NoError(t, err)
	}
	return ns.noteList.Notes
}

// awaitWithTimeout は指定チャネルからの受信をタイムアウト付きで待つ
func awaitWithTimeout(t *testing.T, ch <-chan struct{}, timeout time.Duration, msg string) {
	select {
	case <-ch:
		// OK
	case <-time.After(timeout):
		t.Fatal(msg)
	}
}
```

### 3.3 テストファイル構成案

```
backend/
├── drive_service_test.go                # 既存 (~3100行、60+テスト)
│   └── 追加: カテゴリD (D-1~D-7), E (E-1~E-5), H (H-1~H-3), J (J-1~J-3)
│       計18テスト追加
│
├── drive_service_notification_test.go   # 新規: カテゴリA全体 (12テスト)
│   ├── notificationRecorder 構造体
│   ├── newTestDriveServiceWithRecorder()
│   └── テスト:
│       TestCreateNote_StatusNotification_SyncingToSynced
│       TestUpdateNote_StatusNotification_SyncingToSynced
│       TestDeleteNoteDrive_StatusNotification_SyncingToSynced
│       TestCreateNote_Error_NoSyncedNotification
│       TestCreateNote_Cancelled_NoSyncedNotification
│       TestSyncNotes_WithChanges_NotificationSequence
│       TestSyncNotes_NoChanges_MD5Match_SyncedNotification
│       TestSyncNotes_QueueNotEmpty_KeepsSyncingStatus
│       TestUpdateNoteListInternal_StatusNotification
│       TestPerformInitialSync_ProgressiveNotification
│       TestReconnect_Success_EmitsSynced
│       TestSyncNotes_DriveError_ErrorWithNotifyEmitted
│
├── drive_sync_service_test.go           # 新規: カテゴリB (8テスト) + I (8テスト)
│   ├── retryCountingOps, delayTrackingOps
│   └── テスト:
│       TestWithRetry_SuccessOnFirstAttempt
│       TestWithRetry_SuccessAfterRetries
│       TestWithRetry_ExhaustsAllRetries
│       TestWithRetry_NonRetryableError_StopsImmediately
│       TestWithRetry_ExponentialBackoff_DelayIncreases
│       TestDownloadNote_RetryThenParseJSON
│       TestUpdateNote_AllRetriesFail_FallsBackToCreate
│       TestRetryConfig_ShouldRetry_Conditions
│       TestDownloadNoteList_CorruptedJSON_FallbackToCached
│       TestDownloadNoteList_CorruptedJSON_NoCached_Error
│       TestMergeNotes_CloudOnly_TempError_RemainsInNoteList
│       TestMergeNotes_CloudOnly_NotFound_RemovedFromNoteList
│       TestDownloadNoteListIfChanged_MD5Match_SkipsDownload
│       TestDownloadNoteListIfChanged_MetadataError_FullDownload
│       TestDeduplicateNotes_DuplicateIDs_KeepsLatest
│       TestDeduplicateNotes_EmptyList
│
├── drive_operations_queue_test.go       # 既存 (~500行、15テスト)
│   └── 追加: カテゴリF (F-1~F-7)
│       TestQueue_UpdateDeleteCreate_Chain
│       TestQueue_CreateThenUpdate_SameFile
│       TestQueue_BufferFull_BlocksUntilSpace
│       TestQueue_WaitForEmpty_Timeout
│       TestQueue_WaitForEmpty_Success
│       TestQueue_ConcurrentUpdates_DifferentFiles
│       TestQueue_Cleanup_DelayedGoroutine_SafeReturn
│
├── drive_polling_test.go                # 既存 (~160行、5テスト)
│   └── 追加: カテゴリG (G-1~G-9)
│       TestPolling_Disconnected_ReconnectSuccess
│       TestPolling_Disconnected_ReconnectFail_Backoff
│       TestPolling_NoChangeToken_FullSync
│       TestPolling_ChangesAPIError_ClearsToken
│       TestPolling_QueueHasItems_SkipsAndResetsInterval
│       TestPolling_ChangesDetected_SyncSuccess_IntervalReset
│       TestPolling_NoChanges_IntervalIncreases
│       TestPolling_StopPolling_Safe
│       TestPolling_ResetPollingInterval_NonBlocking
│
└── drive_notelist_debounce_test.go      # 新規: カテゴリC (5テスト)
    └── テスト:
        TestUpdateNoteList_WithinTwoSeconds_Deferred
        TestUpdateNoteList_AfterTwoSeconds_Immediate
        TestUpdateNoteList_DeferredThenCalledAgain_TimerReset
        TestUpdateNoteList_DeferredTimer_EventuallyFires
        TestUpdateNoteList_DeferredTimer_ErrorLogged
```

### 3.4 テスト合計サマリー

| カテゴリ | テスト数 | P0 | P1 | P2 | 対応ファイル |
|---|---|---|---|---|---|
| A: ステータスバー通知 | 12 | 4 | 8 | 0 | `drive_service_notification_test.go` (新規) |
| B: リトライロジック | 8 | 0 | 7 | 1 | `drive_sync_service_test.go` (新規) |
| C: デバウンス | 5 | 0 | 4 | 1 | `drive_notelist_debounce_test.go` (新規) |
| D: アトミシティ | 7 | 4 | 3 | 0 | `drive_service_test.go` (既存拡張) |
| E: 初回同期 | 5 | 0 | 5 | 0 | `drive_service_test.go` (既存拡張) |
| F: キュー追加 | 7 | 0 | 4 | 3 | `drive_operations_queue_test.go` (既存拡張) |
| G: ポーリング | 9 | 0 | 6 | 3 | `drive_polling_test.go` (既存拡張) |
| H: コンフリクト追加 | 3 | 0 | 0 | 3 | `drive_service_test.go` (既存拡張) |
| I: データ整合性 | 8 | 0 | 7 | 1 | `drive_sync_service_test.go` (新規) |
| J: 統合シナリオ | 3 | 0 | 3 | 0 | `drive_service_test.go` (既存拡張) |
| **合計** | **67** | **8** | **47** | **12** | |

### 3.5 実装上の注意事項

1. **テスト用タイマー制御**: カテゴリC (デバウンス) のテストでは `time.Sleep` の使用が不可避。テストのフレーキーさを避けるため、十分なマージン（期待値の2倍以上）を設ける。例: 2秒デバウンス → 5秒のタイムアウト。

2. **syncMuのデッドロック回避**: カテゴリD-7のmutex排他テストでは、goroutineとチャネルを使い、タイムアウト付きで検証する。テスト関数内で syncMu のロックを直接取ることは避け、公開メソッド経由で間接的に検証する。

3. **ポーリングループのテスト**: カテゴリGではポーリングループの完全起動はせず、`checkForChanges()` や `reconnect()` の個別メソッドをテストする方針。ループ全体のテストはインテグレーション向きであり、unit testの範囲では内部メソッドの検証に留める。

4. **notificationRecorder のスレッドセーフ**: `mu sync.Mutex` で保護し、並行テストでも安全に記録を読み取れるようにする。アサーションメソッドでもロックを取得する。

5. **既存テストへの影響**: 新しいモック構造体は別ファイルに配置し、既存テストの `mockDriveOperations` や `setupTest()` は変更しない。共通ヘルパー（`setupCloudNotes`, `setupLocalNotes`）のみ新規ファイルに追加する。

6. **推奨実装順序**:
   - Phase 1 (P0): カテゴリA (A-1~A-4, A-6) + カテゴリD (D-1, D-3, D-4, D-7) -- 9テスト
   - Phase 2 (P1-高): カテゴリB全体 + カテゴリI (I-1~I-7) -- 15テスト
   - Phase 3 (P1-中): カテゴリC + D残り + E全体 -- 12テスト
   - Phase 4 (P1-低): カテゴリF (P1部分) + G (P1部分) + J全体 -- 14テスト
   - Phase 5 (P2): カテゴリH + F (P2部分) + G (P2部分) + 残り -- 12テスト
