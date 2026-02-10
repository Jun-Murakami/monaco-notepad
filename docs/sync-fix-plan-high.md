# 同期修正計画: High (🟠)

> **参照**: [sync-audit-report.md](./sync-audit-report.md)
> **UX方針**: Evernoteライク。サイレント同期が基本。ステータスバー通知領域にログを流す。ダイアログ確認は破壊的操作（データ消失リスク）のみ最低限。
> **対象シナリオ**: A1-A3, A6, A7, B2-B8, C1, C5, D4, D5, D7, E1-E4, F4, G1
> **依存**: Critical タスク (sync-fix-plan-critical.md) 完了後に着手

---

## UX通知ガイドライン（全タスク共通）

| レベル | 表示先 | 例 |
|--------|--------|-----|
| **ステータスバー（通常）** | EditorStatusBar 通知領域 | "3件同期完了", "1件ダウンロード" |
| **ステータスバー（警告）** | EditorStatusBar 通知領域（黄色系） | "競合を検出: ノート「xxx」の両方のバージョンを保持しました" |
| **ダイアログ（確認）** | MessageDialog | 使用しない（このレベルでは） |

→ Evernote流: 衝突時は自動で両バージョン保持。ユーザーが気づいたら自分で整理。通知はステータスバーに流すだけ。

---

## Task H-1: handleCloudSync で NoteList 全体を適用

**参照シナリオ**: B5, B6, B7, B8
**ファイル**: `backend/drive_service.go`

### 問題

`handleCloudSync()` がクラウド noteList の `Notes` のみ適用し、`Folders`, `TopLevelOrder`, `ArchivedTopLevelOrder` を無視している。結果としてフォルダ構造・並び順のクラウド変更がローカルに反映されない。

### 修正方針

- `handleCloudSync()` でクラウド noteList の全フィールドをローカルに適用:
  - `Folders` → ローカルにマージ（IDベース。クラウドに存在するフォルダを採用。ローカルのみのフォルダは保持）
  - `TopLevelOrder` → クラウド版を採用（ローカルのみのアイテムは末尾に追加）
  - `ArchivedTopLevelOrder` → 同上
- `handleLocalSync()` でも同様に、アップロードする noteList に全フィールドを含める（既存確認）

### テスト要件

```
TestCloudSync_AppliesFolders
  - クラウド noteList にフォルダ追加あり
  → ローカルの Folders に反映されることを確認

TestCloudSync_AppliesTopLevelOrder
  - クラウド noteList で並び順変更
  → ローカルの TopLevelOrder に反映されることを確認

TestCloudSync_AppliesArchivedTopLevelOrder
  - クラウド noteList でアーカイブ並び順変更
  → 反映確認

TestCloudSync_PreservesLocalOnlyFolders
  - ローカルにのみ存在するフォルダ
  → クラウド同期後も保持されることを確認

TestCloudSync_MergesTopLevelOrder_LocalOnlyItemsAppended
  - ローカルにのみ存在するノート/フォルダがTopLevelOrderの末尾に追加されることを確認
```

### 受入条件

- [ ] クラウドのフォルダ変更がローカルに反映される
- [ ] クラウドの並び順変更がローカルに反映される
- [ ] ローカルのみのアイテムが消失しない
- [ ] `go test ./...` パス

---

## Task H-2: skipSyncIfQueuePending を実際にスキップさせる

**参照シナリオ**: C1
**ファイル**: `backend/drive_service.go`

### 問題

`SyncNotes()` 内の「キュー非空時はスキップ」ロジックがログ出力のみで `return nil` していない。キュー処理中に同期が走り、不整合が発生する。

### 修正方針

- キュー非空チェック後に `return nil` を追加
- ログメッセージをステータスバー通知向けに調整（"同期をスキップ: 保留中の操作あり"）

### テスト要件

```
TestSyncNotes_SkipsWhenQueueHasItems
  - キューにアイテムがある状態で SyncNotes() 呼出
  → 同期処理が実行されないことを確認（DriveOps の呼出なし）

TestSyncNotes_ProceedsWhenQueueEmpty
  - キューが空の状態で SyncNotes() 呼出
  → 通常の同期処理が実行されることを確認
```

### 受入条件

- [ ] キュー非空時に SyncNotes がスキップされる
- [ ] キュー空時は通常動作
- [ ] `go test ./...` パス

---

## Task H-3: コンテンツ衝突時のコンフリクトコピー作成

**参照シナリオ**: A1, A2, A3, G1
**ファイル**: `backend/drive_service.go`, `backend/note_service.go`, `backend/app_logger.go`

### 問題

同一ノートが両デバイスで編集された場合、`ModifiedTime` が新しい方で上書きし、古い方のデータが消失する。ユーザーへの通知もない。

### 修正方針

**A. コンフリクトコピー生成** (`note_service.go`):
- `CreateConflictCopy(originalNote *Note) (*Note, error)` メソッドを追加
- 新しいIDで複製。タイトルに " (競合コピー YYYY-MM-DD HH:MM)" を付与
- noteList に追加、TopLevelOrder で元ノートの直後に配置

**B. mergeNotes 変更** (`drive_service.go`):
- 両方存在 + ContentHash 異なる場合: クラウド版をダウンロード前にローカル版のコンフリクトコピーを作成
- その後クラウド版で上書き（最新版が正位置に来る）
- ステータスバー通知: "「{タイトル}」の競合コピーを作成しました"

**C. 通知** (`app_logger.go`):
- 既存の `logMessage` イベントで通知（ステータスバーに流れる）
- ダイアログは使わない（Evernoteと同様、ユーザーが気づいたら整理する）

### テスト要件

```
TestCreateConflictCopy_CreatesNewNote
  - 元ノートからコンフリクトコピー作成
  → 新しいIDで作成され、タイトルに "(競合コピー ...)" が付くことを確認

TestCreateConflictCopy_PlacedAfterOriginal
  - コンフリクトコピーが TopLevelOrder で元ノートの直後に配置されることを確認

TestMergeNotes_ConflictingContent_CreatesConflictCopy
  - ローカルとクラウドで同一ノートのContentHashが異なる
  → コンフリクトコピーが作成されることを確認
  → クラウド版が正位置に適用されることを確認

TestMergeNotes_SameContent_NoConflictCopy
  - ローカルとクラウドで同一ノートのContentHashが同じ
  → コンフリクトコピーが作成されないことを確認

TestMergeNotes_ConflictCopy_LogMessageEmitted
  - 衝突時にlogMessageイベントが発行されることを確認
```

### 受入条件

- [ ] 衝突時にローカル版がコンフリクトコピーとして保存される
- [ ] クラウド版が正位置に適用される
- [ ] ステータスバーに通知が表示される
- [ ] ダイアログは表示されない
- [ ] `go test ./...` パス

---

## Task H-4: デバイスクロック依存の軽減

**参照シナリオ**: A6
**ファイル**: `backend/drive_sync_service.go`, `backend/drive_operations.go`, `backend/domain.go`

### 問題

`isModifiedTimeAfter()` がデバイスローカル時刻に完全依存。クロックスキューで誤った勝者が選択される。

### 修正方針

- `DownloadNoteListIfChanged` / `DownloadNoteList` で取得するクラウドnoteListの各ノートについて、Drive ファイルメタデータの `modifiedTime`（サーバー時刻）を参照可能にする
- `mergeNotes` での比較時に:
  - まず `ContentHash` で実際に異なるか判定（同一なら何もしない）
  - 異なる場合: 既にH-3でコンフリクトコピーを作成するので、クロック依存の「勝者選択」自体が不要になる
  - → H-3の実装後はクロックスキューの影響が無害化される（両バージョン保持のため）

### テスト要件

```
TestMergeNotes_ClockSkew_BothVersionsPreserved
  - ローカルのModifiedTimeがクラウドより新しいが、実際にはクラウドが後から変更
  → コンフリクトコピーにより両方保持されることを確認（H-3と組み合わせ）

TestIsModifiedTimeAfter_InvalidFormat
  - 不正なタイムスタンプ文字列での動作確認（既存テストがあれば確認）
```

### 受入条件

- [ ] クロックスキューがあってもデータ消失しない（コンフリクトコピーで担保）
- [ ] `go test ./...` パス

---

## Task H-5: noteList.json MD5 未変更時のノートファイル変更検出

**参照シナリオ**: A7
**ファイル**: `backend/drive_service.go`, `backend/drive_sync_service.go`

### 問題

`DownloadNoteListIfChanged()` が noteList.json の MD5 が同一ならスキップするが、noteList は同じでもノートファイル本体がDrive上で変更されている可能性がある（部分失敗、外部編集等）。

### 修正方針

- noteList MD5 未変更時も、一定間隔（例: 5回に1回）でフルチェックを実行するカウンタを導入
- または `checkForChanges()` の Changes API 結果にノートファイル変更が含まれていれば、noteList MD5 に関わらず同期を実行（既に `hasRelevantChanges` で検出されるはず → `SyncNotes` で noteList MD5 スキップが問題）
- `SyncNotes()` が `hasChanges=true` で呼ばれた場合は、`DownloadNoteListIfChanged` の MD5 キャッシュを無視して必ずダウンロードするオプションを追加

### テスト要件

```
TestSyncNotes_ChangesDetected_ForcesNoteListDownload
  - Changes API で変更検出 → SyncNotes 呼出
  → noteList MD5 キャッシュをバイパスしてダウンロードすることを確認

TestSyncNotes_NoChanges_UsesMd5Cache
  - 変更なしの通常ポーリング
  → MD5 キャッシュが有効に機能することを確認

TestSyncNotes_PeriodicFullCheck
  - N回連続MD5同一 → N+1回目でフルチェックが実行されることを確認（カウンタ方式の場合）
```

### 受入条件

- [ ] Changes API で変更検出時に noteList が確実にダウンロードされる
- [ ] 通常のポーリングでは MD5 キャッシュが有効
- [ ] `go test ./...` パス

---

## Task H-6: 一時的認証エラーでの過激なオフライン遷移の緩和

**参照シナリオ**: C5, E2, G4
**ファイル**: `backend/auth_service.go`, `frontend/src/hooks/useDriveSync.ts`

### 問題

**バックエンド**: 401エラーで即座にトークン削除＋完全オフライン遷移。一時的なAPI障害でも再ログインが必要になる。

**フロントエンド**: `useDriveSync.ts` の同期監視で接続不可検知→`LogoutDrive()` 呼出→トークン削除。ネットワーク一時断で強制ログアウト。

### 修正方針

**A. バックエンド** (`auth_service.go`):
- 401/認証エラー時に即トークン削除しない
- まずトークンリフレッシュを1回試行
- リフレッシュ失敗 + `invalid_grant`/`revoked` → 完全オフライン（トークン削除）
- リフレッシュ失敗 + その他エラー → 一時オフライン（トークン保持）
- ステータスバー通知: "接続を再試行中..." / "再ログインが必要です"

**B. フロントエンド** (`useDriveSync.ts`):
- 同期監視の `handleForcedLogout` を廃止
- 代わりに "接続チェック失敗" → ステータスを "offline" に変更（トークンは保持）
- バックエンドが自動的にリトライ/復帰する
- 本当にトークンが無効な場合のみバックエンドから `drive:status "offline"` + `drive:error` が来る → その時だけ UI でオフライン表示
- 同期タイムアウト（5分）→ 強制ログアウトではなく、ステータスバーに "同期タイムアウト。手動で同期してください" と通知 + ステータスを "offline" に

### テスト要件

```
TestAuth_TransientError_KeepsToken
  - 一時的なネットワークエラー
  → トークンが保持されること
  → temporary offline になること

TestAuth_InvalidGrant_DeletesToken
  - invalid_grant エラー
  → トークンが削除されること
  → full offline になること

TestAuth_401_RetriesRefresh
  - 401エラー → リフレッシュ試行
  → リフレッシュ成功時は接続維持を確認

TestFrontend_SyncTimeout_NoForcedLogout（Vitest）
  - 同期タイムアウト → LogoutDrive が呼ばれないことを確認
  - ステータスが "offline" になることを確認

TestFrontend_ConnectionLost_NoForcedLogout（Vitest）
  - CheckDriveConnection が false 返却
  → LogoutDrive が呼ばれないことを確認
```

### 受入条件

- [ ] 一時的エラーでトークンが削除されない
- [ ] `invalid_grant`/`revoked` のみでトークン削除
- [ ] フロントエンドが強制ログアウトしない
- [ ] ステータスバーに適切な通知
- [ ] `go test ./...` パス + `npx vitest run` パス

---

## Task H-7: クラウド noteList.json / ノート JSON の破損対策

**参照シナリオ**: D5, D6
**ファイル**: `backend/drive_sync_service.go`, `backend/drive_polling.go`, `backend/drive_service.go`

### 問題

**D5**: クラウド noteList.json が破損 → unmarshalエラー → オフライン遷移。`drive_polling.go` で `cloudNoteList=nil` のままデリファレンスの可能性。

**D6**: 個別ノートのJSON破損 → 同期全体がabort。

### 修正方針

**A. noteList.json 破損** (`drive_sync_service.go`, `drive_polling.go`):
- `DownloadNoteList` でunmarshal失敗時、直前の正常な noteList をキャッシュとして保持
- 破損時はキャッシュを使用し、ステータスバーに "クラウドのノートリストが破損しています。前回の正常な状態を使用します" と通知
- `cloudNoteList` が nil の場合のガードを全箇所に追加

**B. ノート JSON 破損** (`drive_service.go`, `drive_sync_service.go`):
- `DownloadNote` / `mergeNotes` でunmarshal失敗時、そのノートをスキップして残りを続行
- 破損ノートのIDをログに記録
- ステータスバーに "ノート「{ID}」の同期をスキップしました（データ破損）" と通知

### テスト要件

```
TestDownloadNoteList_CorruptedJSON_UsesCachedVersion
  - 1回目: 正常な noteList ダウンロード
  - 2回目: 破損JSON → キャッシュされた noteList が返されることを確認

TestDownloadNoteList_CorruptedJSON_NilCloudNoteList_NoPanic
  - キャッシュなし + 破損JSON → パニックしないことを確認

TestMergeNotes_CorruptedNote_SkipsAndContinues
  - 3ノート中1ノートが破損JSON
  → 残り2ノートが正常に同期されることを確認

TestMergeNotes_CorruptedNote_LogsWarning
  - 破損ノートスキップ時にログメッセージが出力されることを確認
```

### 受入条件

- [ ] noteList 破損時にパニックしない
- [ ] noteList 破損時にキャッシュが使用される
- [ ] ノート破損時に同期が継続される
- [ ] ステータスバーに通知
- [ ] `go test ./...` パス

---

## Task H-8: UploadAllNotes の Content 欠落修正

**参照シナリオ**: D7
**ファイル**: `backend/drive_sync_service.go`

### 問題

`UploadAllNotes()` が `NoteMetadata` から `Note` を構築するが、`Content` フィールドを含めていない。クラウド noteList 消失時の再アップロードで空のノートファイルが作成される。

### 修正方針

- `UploadAllNotes()` のシグネチャ変更: `noteService` へのアクセスを追加（インターフェース経由 or コールバック）
- 各ノートについてローカルファイルからフルコンテンツを読み込んでからアップロード
- または `drive_service.go` 側で呼び出し前にフルノートを読み込んで渡す

### テスト要件

```
TestUploadAllNotes_IncludesContent
  - ローカルにコンテンツのあるノートが存在
  → アップロードされたファイルに Content が含まれることを確認

TestUploadAllNotes_MissingLocalFile_Skips
  - noteList にあるがローカルファイルがないノート
  → スキップして残りを続行

TestSyncNotes_NoCloudNoteList_UploadsWithContent
  - クラウド noteList なし → 全アップロード
  → アップロードされたノートに Content が含まれることを確認
```

### 受入条件

- [ ] アップロードされるノートに Content が含まれる
- [ ] ローカルファイル欠落時はスキップして続行
- [ ] `go test ./...` パス

---

## Task H-9: 重複ファイル整理のソート基準修正

**参照シナリオ**: D4
**ファイル**: `backend/drive_operations.go`

### 問題

`FindLatestFile()` が Drive `createdTime` でソートしているが、最新コンテンツは `modifiedTime` が新しいファイルにある。`createdTime` ソートで最新コンテンツが削除される可能性がある。

### 修正方針

- `FindLatestFile()` のソート基準を `createdTime` → `modifiedTime` に変更
- `ListFiles` のクエリで `modifiedTime` フィールドも取得するよう `Fields` を拡張
- 重複ファイル整理時、削除前にコンテンツ比較（ハッシュ比較）で最もデータの多いファイルを保持

### テスト要件

```
TestFindLatestFile_SortsByModifiedTime
  - 複数ファイルで createdTime と modifiedTime の順序が異なる
  → modifiedTime が最新のファイルが返されることを確認

TestRemoveDuplicateNoteFiles_KeepsLatestModified
  - 重複ファイルの整理で modifiedTime 最新が保持されることを確認
```

### 受入条件

- [ ] `FindLatestFile` が `modifiedTime` でソート
- [ ] 重複整理で最新コンテンツが保持される
- [ ] `go test ./...` パス

---

## Task H-10: オフライン復帰時の安全なリコンサイル

**参照シナリオ**: E1, E3, E4
**ファイル**: `backend/drive_service.go`, `backend/drive_polling.go`

### 問題

長期オフライン後の復帰時に `LastSync` ベースで方向が決まり、構造データが一方的に上書きされる。オフライン中の削除と編集の衝突が未処理。

### 修正方針

- `performInitialSync()` / 復帰時の同期で、常に `mergeNotes` パスを使用（LastSync に関わらず）
- → H-3 のコンフリクトコピー機構により、衝突は両バージョン保持で安全に解決
- → H-1 の NoteList 全体適用により、構造データもマージ
- 復帰時はステータスバーに "オフライン中の変更を同期中..." と通知

### テスト要件

```
TestOfflineRecovery_AlwaysMerges
  - 長期オフライン後の復帰 → mergeNotes が使用されることを確認

TestOfflineRecovery_ConflictCopiesCreated
  - オフライン中に両方で編集 → コンフリクトコピーが作成されることを確認

TestOfflineRecovery_LocalDeletedCloudEdited_BothPreserved
  - ローカルで削除、クラウドで編集 → 削除されず、クラウド版がダウンロードされることを確認
  （B1/C-4 のTask C-4で削除保護が入っている前提）

TestOfflineRecovery_StatusBarNotification
  - 復帰時にステータスバー通知が発行されることを確認
```

### 受入条件

- [ ] 復帰時に常にマージが実行される
- [ ] 衝突時にコンフリクトコピーが作成される
- [ ] ステータスバーに通知
- [ ] `go test ./...` パス

---

## 実行順序（依存関係）

```
H-2 (skipSync修正) ← 独立、最初に実施
    ↓
H-1 (NoteList全体適用) ← 構造マージの基盤
    ↓
H-3 (コンフリクトコピー) ← コンテンツ衝突の核心
    ↓
H-4 (クロック依存軽減) ← H-3に依存（コンフリクトコピーで無害化）
    ↓
H-5 (MD5スキップ修正) ← 独立
H-6 (認証エラー緩和) ← 独立（バックエンド+フロントエンド）
H-7 (JSON破損対策) ← 独立
H-8 (UploadAllNotes修正) ← 独立
H-9 (重複ソート修正) ← 独立
    ↓
H-10 (オフライン復帰) ← H-1, H-3 に依存
```
