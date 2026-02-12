# 同期アーキテクチャ移行計画: noteList丸ごと上書き + dirtyフラグ方式

> **作成日**: 2026-02-12
> **対象リポジトリ**: `Jun-Murakami/monaco-notepad`
> **目的**: 複雑化した同期ロジックを根本的に簡素化し、安定したマルチデバイス同期を実現する

---

## 1. 現行アーキテクチャの問題分析

### 1.1 根本原因: Google Drive APIの上に同期プロトコルを自前構築している

Google Drive APIは「ファイルストレージAPI」であり、「同期プロトコル」ではない。現行コードはこのAPI上にマルチデバイス同期のための衝突検出・解決ロジックをフルスクラッチで構築しており、以下の構造的問題を抱えている。

### 1.2 具体的な問題

#### 問題1: noteList.jsonのフィールド単位マージが状態爆発を引き起こしている

現行の`mergeNoteListStructure()`は、Folders / TopLevelOrder / ArchivedTopLevelOrder / CollapsedFolderIDs / Notes のそれぞれを個別にマージしようとする。これにより：

- `mergeNoteListStructure()` (drive_service.go L1135-1178) がフォルダ・並び順・アーカイブ順をそれぞれマージ
- `mergeTopLevelOrder()` (drive_service.go L1222-1236) がTopLevelItemの和集合を計算
- `mergeNotes()` (drive_service.go L843-1037) が200行超のノート単位マージを実行
- `isStructureChanged()` (drive_service.go L1093-1133) が40行の構造比較を実行

これらが組み合わさり、「フォルダAを端末1で作成 + ノートBを端末2で移動 + 並び順を端末1で変更」のようなケースで予測不能な結果を生む。

#### 問題2: 同期の分岐パスが多すぎる

`SyncNotes()` (drive_service.go L588-672) の内部で以下の分岐が発生：

```
SyncNotes()
├── キューにアイテムがあればスキップ
├── クラウド未変更 (MD5一致) → 完了
├── クラウド noteList なし → 全アップロード → 再取得
├── ノートリスト長/ハッシュ一致 → 構造だけマージ
└── ノート内容が異なる → mergeNoteListsAndDownload()
    └── mergeNotes() 内部で:
        ├── 両方存在 + 同ハッシュ → スキップ
        ├── 両方存在 + 異ハッシュ + クラウド新しい → ダウンロード
        ├── 両方存在 + 異ハッシュ + ローカル新しい → アップロード
        ├── 両方存在 + 異ハッシュ + 同時刻 + isOneSidedChange → メタデータのみ更新
        ├── 両方存在 + 異ハッシュ + 同時刻 + 非OneSided → MergeConflictContent
        ├── ローカルのみ + cloudLastSync前 → ローカル削除
        ├── ローカルのみ + cloudLastSync後 → アップロード
        └── クラウドのみ → ダウンロード (recentlyDeletedチェック付き)
```

さらにこれとは別経路で `performInitialSync()` → `prepareCloudNotesForMerge()` → `publishPreviewNoteList()` → `mergeNotes()` → `saveAndUpdateNoteList()` というフローもある。加えて`handleCloudSync()` / `handleLocalSync()` という別の同期パスも存在し、コード上で到達する可能性がある。

#### 問題3: デバイスクロック依存のLWW

`isModifiedTimeAfter()` (domain.go L227-234) がローカルデバイスの時刻文字列で比較を行う。端末間の時刻ズレが存在する場合、誤った勝者が選ばれデータロストが発生する。

#### 問題4: 並行アクセス制御が複数レイヤーに分散

- `syncMu` (drive_service.go L51) — SyncNotes / UpdateNoteList の排他
- `deletedMu` (drive_service.go L56) — recentlyDeletedNoteIDs の排他
- `DriveSync.mutex` (domain.go L151) — DriveSync構造体のフィールド保護
- `cacheMu` (drive_sync_service.go L64) — fileIDCache の排他
- `DriveOperationsQueue` (drive_operations_queue.go) — API呼び出しの直列化
- `deferredUploadTimer` (drive_service.go L55) — noteListアップロードのデバウンス

これらが相互作用して、デッドロックやレース条件の温床になっている。

#### 問題5: 中断リカバリが複雑

`SyncJournal` (domain.go L237-247) + `recoverFromJournal()` (drive_service.go L537-583) で中断復旧を行うが、ジャーナル書き込み自体が失敗するケースや、ジャーナルの内容と実際のDrive/ローカル状態が不整合になるケースに対応しきれていない。

---

## 2. 新アーキテクチャ: 設計方針

### 2.1 基本原則

1. **noteList_v2.jsonは丸ごと上書き、フィールド単位マージはしない**
   - フォルダ構造・並び順・アーカイブ状態はnoteList_v2.json全体として1つの値
   - 「最後に書いた端末の構造が勝つ」というシンプルなLWW
   - ノートの内容さえ失われなければ、構造の一時的な巻き戻りは許容する
   
2. **同期パスを3つに限定する**
   - CASE A: クラウド未変更
   - CASE B: クラウド変更あり + ローカル未変更
   - CASE C: クラウド変更あり + ローカルも変更あり（コンフリクト）
   
3. **dirtyフラグで「ローカルに未同期の変更があるか」を管理する**
   - ローカルで何かを変更したら dirty = true + 変更ノートIDを記録
   - sync完了で dirty = false
   - クラッシュ時はdirty = trueのまま残り、起動時にリカバリ

4. **デバイスクロックに依存しない**
   - ModifiedTimeの比較はDrive APIのサーバー側タイムスタンプを使用する
   - ローカルのModifiedTimeはUI表示用にのみ使う

5. **コンフリクト時は「新しい方が勝つ」LWW一本**
   - コンフリクトコピーの作成は行わない
   - 構造もノート内容も、新しい方が勝つ
   - 必要になったら後からコンフリクトコピー機能を追加できる設計にしておく

### 2.2 なぜこの設計か

**対象ユーザーの使用パターン**: 個人が2〜3台のデバイスで使用。同時に2台で同じノートを編集するケースは稀。この前提において、完全な自動マージよりも「データロストしない + 挙動が予測可能」の方が価値が高い。

**Google Drive APIの特性との整合**: Drive APIはファイル単位のCRUDとメタデータ取得が得意。noteList_v2.json 1ファイルの丸ごと上書きはAPIの得意領域と一致する。フィールド単位マージはアプリ側の責務であり、Drive APIはそのための機能を持たない。

**コード量の削減**: 同期関連コードが現行約800行 → 推定200〜300行に削減され、バグの表面積が大幅に減る。

---

## 3. データ構造の変更

### 3.1 新規: SyncState（ローカル専用、Driveにはアップロードしない）

```go
// SyncState はローカル端末の同期状態を管理する
// sync_state.json としてappDataDirに保存する（Driveにはアップロードしない）
type SyncState struct {
    Dirty              bool              `json:"dirty"`              // ローカルに未同期の変更があるか
    LastSyncedDriveTs  string            `json:"lastSyncedDriveTs"`  // 前回sync成功時のnoteList_v2.jsonのDrive modifiedTime
    DirtyNoteIDs       map[string]bool   `json:"dirtyNoteIDs"`       // 変更されたノートIDのセット
    DeletedNoteIDs     map[string]bool   `json:"deletedNoteIDs"`     // 削除されたノートIDのセット
    LastSyncedNoteHash map[string]string `json:"lastSyncedNoteHash"` // 前回sync成功時の各ノートのContentHash
}
```

**各フィールドの役割:**

- `Dirty`: 最もシンプルな変更検出フラグ。ローカルで何かが変更されたらtrue、sync完了でfalse。
- `LastSyncedDriveTs`: DriveのnoteList_v2.jsonの`modifiedTime`（サーバータイムスタンプ）。次回ポーリング時に「クラウドが変わったか」をこの値との比較で判定する。ローカルクロックに依存しない。
- `DirtyNoteIDs`: 変更されたノートのIDセット。syncの際にアップロードが必要なノートを特定するために使用。全ノートスキャンを回避する。
- `DeletedNoteIDs`: 削除されたノートのIDセット。sync時にクラウドからも削除するために使用。現行の`recentlyDeletedNoteIDs`を置き換える。
- `LastSyncedNoteHash`: 前回sync時の各ノートのContentHash。CASE Cで「クラウド側も変わっているか」を判定するために使用。

### 3.2 NoteList の変更 (noteList.json → noteList_v2.json)

ファイル名を `noteList_v2.json` に変更し、旧バージョンとの明確な境界を作る。マイグレーションの詳細は [11. スキーマ移行](#11-スキーマ移行-notelistjson--notelist_v2json) を参照。

```go
// NoteList — v2 スキーマ（noteList_v2.json）
type NoteList struct {
    Version               string         `json:"version"`                        // "2.0"
    Notes                 []NoteMetadata `json:"notes"`
    Folders               []Folder       `json:"folders,omitempty"`
    TopLevelOrder         []TopLevelItem `json:"topLevelOrder,omitempty"`
    ArchivedTopLevelOrder []TopLevelItem `json:"archivedTopLevelOrder,omitempty"`
    CollapsedFolderIDs    []string       `json:"collapsedFolderIDs,omitempty"`
    // v1 から削除:
    // LastSync         time.Time → SyncState.LastSyncedDriveTs に移行（ローカル専用）
    // LastSyncClientID string   → 不要（Drive modifiedTime で自己変更検出）
}

// NoteMetadata — v2 スキーマ
type NoteMetadata struct {
    ID            string `json:"id"`
    Title         string `json:"title"`
    ContentHeader string `json:"contentHeader"`
    Language      string `json:"language"`
    ModifiedTime  string `json:"modifiedTime"`
    Archived      bool   `json:"archived"`
    ContentHash   string `json:"contentHash"`
    FolderID      string `json:"folderId,omitempty"`
    // v1 から削除:
    // Order int → TopLevelOrder配列・フォルダ内の配列順序で表現（二重管理を排除）
}
```

### 3.3 DriveSync 構造体の変更

```go
// DriveSync — 変更後（簡素化）
type DriveSync struct {
    service       *drive.Service
    token         *oauth2.Token
    server        *http.Server
    listener      net.Listener
    config        *oauth2.Config
    rootFolderID  string
    notesFolderID string
    noteListID    string
    mutex         sync.RWMutex
    isConnected   bool
    // 以下削除:
    // hasCompletedInitialSync bool       → SyncState.Dirty で代替
    // cloudNoteList           *NoteList  → キャッシュ不要（毎回Driveメタデータチェック）
}
```

### 3.4 domain.go の変更

**削除する型:**

- `SyncResult` — 新設計ではアップロード/ダウンロード件数のカウントは不要（ログは残す）
- `SyncJournal` / `SyncJournalAction` — SyncState.Dirty + DirtyNoteIDs で代替

**削除するメソッド:**

- `DriveSync.UpdateCloudNoteList()` — クラウドノートリストのローカルキャッシュは不要

---

## 4. 同期フローの詳細設計

### 4.1 フロー概要

```
SyncNotes():
  1. DriveのnoteList_v2.jsonのメタデータを取得 (files.get: modifiedTimeのみ)
  2. cloudModifiedTime と SyncState.LastSyncedDriveTs を比較

  ── CASE A: cloudModifiedTime == LastSyncedDriveTs (クラウド未変更) ──
     ├── Dirty == false → 何もしない（完了）
     └── Dirty == true  → pushLocalChanges()

  ── CASE B: cloudModifiedTime != LastSyncedDriveTs & Dirty == false ──
     → pullCloudChanges()

  ── CASE C: cloudModifiedTime != LastSyncedDriveTs & Dirty == true ──
     → resolveConflict()
```

### 4.2 CASE A: pushLocalChanges()

ローカルの変更をクラウドにプッシュする。最も頻繁に発生するケース。

```
pushLocalChanges():
  1. DirtyNoteIDs の各ノートについて:
     - ローカルからノートを読み込み
     - Driveにアップロード (Create or Update)
     - noteList_v2.jsonのNoteMetadata.ContentHashを更新
  2. DeletedNoteIDs の各ノートについて:
     - DriveからノートJSONを削除
     - noteListから該当ノートのメタデータを削除
  3. ローカルのnoteList_v2.jsonを保存
  4. noteList_v2.jsonをDriveにアップロード
  5. DriveレスポンスのmodifiedTimeでSyncState.LastSyncedDriveTs を更新
  6. SyncState.Dirty = false, DirtyNoteIDs = {}, DeletedNoteIDs = {}
  7. SyncState.LastSyncedNoteHash を現在の全ノートのハッシュで更新
  8. sync_state.json を保存
```

### 4.3 CASE B: pullCloudChanges()

クラウドの変更をローカルにプルする。他のデバイスが変更を行った場合に発生。

```
pullCloudChanges():
  1. DriveからnoteList_v2.jsonをダウンロード → cloudNoteList
  2. cloudNoteList.Notes と ローカルnoteList.Notes を比較:
     a. クラウドにあってローカルにない → ノートをダウンロード
     b. 両方にあるがContentHashが異なる → ノートをダウンロード
     c. 両方にあってContentHashが同じ → スキップ
     d. ローカルにあってクラウドにない → ローカルから削除
  3. cloudNoteListを丸ごとローカルのnoteList_v2.jsonとして保存
     （Folders, TopLevelOrder, ArchivedTopLevelOrder, CollapsedFolderIDs も全て上書き）
  4. SyncState.LastSyncedDriveTs を更新
  5. SyncState.LastSyncedNoteHash を更新
  6. sync_state.json を保存
  7. フロントエンドにリロード通知
```

### 4.4 CASE C: resolveConflict()

ローカルとクラウドの両方が変更されている。最も稀だが最も重要なケース。

```
resolveConflict():
  1. DriveからnoteList_v2.jsonをダウンロード → cloudNoteList
  2. DirtyNoteIDs の各ノートについて:
     a. SyncState.LastSyncedNoteHash[noteID] と cloudNoteListのContentHash を比較
     b. クラウド側が前回syncから変わっていない → ローカルが勝ち → アップロード
     c. クラウド側も変わっている → Drive側のmodifiedTime vs ローカルのModifiedTime で判定
        - Drive側が新しい → ダウンロード（ローカル変更は破棄）
        - ローカル側が新しい → アップロード
  3. DeletedNoteIDs の各ノートについて:
     a. クラウドのnoteListにまだ存在する → Driveから削除
     b. クラウドのnoteListにない → 何もしない（他デバイスも削除済み）
  4. 非Dirtyノートについて:
     a. クラウドにあってローカルにない → ダウンロード
     b. ContentHashが異なる → ダウンロード
  5. cloudNoteListの構造(Folders, TopLevelOrder等)をベースに採用
     - ただしDirtyNoteIDsの変更（メタデータ含む）を反映
  6. 更新後のnoteListをローカルに保存 & Driveにアップロード
  7. SyncState を更新 (Dirty=false, DirtyNoteIDs={}, ...)
  8. フロントエンドにリロード通知
```

**CASE Cのポイント**: ステップ2cの「新しい方が勝つ」判定で**Drive APIのmodifiedTime**（サーバータイムスタンプ）を使用する。具体的には、ノートをDriveにアップロードした際のレスポンスに含まれるmodifiedTimeをNoteMetadataに記録し、それを比較に使う。これによりデバイスクロックスキューの問題を回避する。

### 4.5 初回接続 (performInitialSync) の簡素化

現行の`performInitialSync()`は専用の複雑なフローを持つが、新設計では**通常のSyncNotes()と同じフローを使う**。

```
初回接続時:
  1. DriveにnoteList_v2.jsonが存在しない → 全ローカルノートをアップロード（CASE Aと同じ）
  2. DriveにnoteList_v2.jsonが存在する → SyncState.LastSyncedDriveTs が空なのでCASE Bに入る
  3. 以降は通常のポーリングループ
```

初回同期を特別扱いしないことで、`performInitialSync()` / `publishPreviewNoteList()` / `prepareCloudNotesForMerge()` が全て不要になる。

### 4.6 ローカル変更時のdirty記録

各App公開メソッドでのdirty記録タイミング：

```
App.SaveNote(note, action):
  1. noteService.SaveNote(note)
  2. syncState.MarkNoteDirty(note.ID)  // dirty=true, DirtyNoteIDs に追加
  3. Driveに接続中 → pushLocalChanges() を非同期実行

App.DeleteNote(id):
  1. noteService.DeleteNote(id)
  2. syncState.MarkNoteDeleted(id)  // dirty=true, DeletedNoteIDs に追加
  3. Driveに接続中 → pushLocalChanges() を非同期実行

App.SaveNoteList():  // フォルダ操作・並び順変更など
  1. noteService.saveNoteList()
  2. syncState.MarkDirty()  // dirty=true (ノートIDなし、構造変更のみ)
  3. Driveに接続中 → pushLocalChanges() を非同期実行

App.UpdateNoteOrder(), App.CreateFolder(), App.RenameFolder(),
App.DeleteFolder(), App.MoveNoteToFolder(), App.ArchiveFolder(), etc.:
  1. noteServiceの対応メソッドを呼ぶ
  2. syncState.MarkDirty()
  3. Driveに接続中 → pushLocalChanges() を非同期実行
```

### 4.7 ポーリングの簡素化

現行のDrivePollingServiceはほぼそのまま使えるが、`checkForChanges()` の中身が簡素化される。

```
変更後の checkForChanges():
  1. Changes API で変更を検出（現行と同じ）
  2. 関連する変更があれば → SyncNotes() を呼ぶ
  // isSelfNoteListChange() は不要になる
  // （LastSyncedDriveTs で自分のアップロード直後のmodifiedTimeを記録済みなので、
  //   次回のメタデータ取得で「変わっていない」と判定される）
```

**`isSelfNoteListChange()` が不要になる理由**: 現行ではChanges APIで自分のアップロードを検出して不要な再同期を防ぐために、`LastSyncClientID` をnoteList.jsonに記録してダウンロード→比較している。新設計では、アップロード成功時にDriveレスポンスの`modifiedTime`を`LastSyncedDriveTs`に記録するため、次回のメタデータ取得で「同じmodifiedTime → CASE A → dirty=falseなら何もしない」となり、自然に自己変更がスキップされる。

### 4.8 オフライン→復帰のフロー

```
オフライン中:
  - ローカル編集は全てsyncState.DirtyNoteIDs に記録される
  - dirty = true のまま

オンライン復帰時:
  - ポーリングが接続復帰を検出 → SyncNotes() を呼ぶ
  - LastSyncedDriveTs と現在のDrive modifiedTime を比較
  - クラウドが変わっていなければ CASE A (dirty=trueなのでpush)
  - クラウドも変わっていれば CASE C (コンフリクト解決)
```

### 4.9 クラッシュリカバリ

```
アプリ起動時:
  1. sync_state.json を読み込み
  2. dirty == true の場合:
     - 「前回の同期が中断した」と判断
     - DirtyNoteIDs に記録されたノートは次回syncでアップロードされる
     - 特別なリカバリ処理は不要（通常のSyncNotes()で処理される）
  3. sync_state.json が存在しない場合:
     - 新規インストール or 初回起動
     - SyncState をデフォルト値で初期化
```

**SyncJournalが不要になる理由**: ジャーナルは「同期処理の途中でクラッシュした場合に、どのノートまで処理したか」を追跡するもの。新設計では、pushLocalChanges() が途中で失敗しても dirty=true + DirtyNoteIDs がそのまま残るため、次回のSyncNotes()で未処理分が自動的にリトライされる。

---

## 5. 実装対象ファイルと変更内容

### 5.1 新規作成

| ファイル | 内容 |
|---------|------|
| `backend/sync_state.go` | SyncState構造体の定義、読み書き、dirty操作メソッド |
| `backend/migration/migration.go` | マイグレーション実行エントリポイント `RunIfNeeded()` |
| `backend/migration/v1_types.go` | v1スキーマの型定義（旧 NoteList / NoteMetadata）|
| `backend/migration/v1_to_v2.go` | v1 → v2 変換ロジック |
| `backend/migration/snapshot.go` | スナップショット保存（migration_snapshots/ にバックアップ） |
| `backend/migration/v1_to_v2_test.go` | マイグレーションのユニットテスト |

`sync_state.go` に含めるメソッド:

```go
func NewSyncState(appDataDir string) *SyncState
func (s *SyncState) Load() error                         // sync_state.json を読み込み
func (s *SyncState) Save() error                         // sync_state.json を書き出し
func (s *SyncState) MarkNoteDirty(noteID string)         // dirty=true, DirtyNoteIDs に追加
func (s *SyncState) MarkNoteDeleted(noteID string)       // dirty=true, DeletedNoteIDs に追加
func (s *SyncState) MarkDirty()                          // dirty=true (構造変更用)
func (s *SyncState) ClearDirty(driveTs string, noteHashes map[string]string)  // sync完了
func (s *SyncState) IsDirty() bool
func (s *SyncState) CloudChangedSince() bool             // LastSyncedDriveTs と比較
```

### 5.2 大幅書き換え

| ファイル | 変更内容 |
|---------|---------|
| `backend/drive_service.go` | SyncNotes() を3パスに書き換え。大部分のメソッドを削除。ensureNoteList() を v2 対応に。ファイル名参照を `noteList_v2.json` に変更。 |
| `backend/app.go` | SaveNote/DeleteNote/SaveNoteList 等でSyncState.MarkDirtyを呼ぶよう変更。Startup() でマイグレーション呼び出し追加。 |
| `backend/domain.go` | NoteList/NoteMetadata を v2 スキーマに変更（LastSync/LastSyncClientID/Order 削除）。SyncResult/SyncJournal 削除。DriveSync 簡素化。 |
| `backend/note_service.go` | ローカルファイルパスを `noteList_v2.json` に変更。Order フィールド依存のコードを配列順序ベースに書き換え。 |
| `backend/drive_sync_service.go` | CreateNoteList のファイル名を `noteList_v2.json` に変更。 |
| `backend/drive_operations.go` | GetFileID 内のファイル名判定を `noteList_v2.json` に変更。 |

### 5.3 軽微な変更

| ファイル | 変更内容 |
|---------|---------|
| `backend/drive_polling.go` | isSelfNoteListChange() を削除。checkForChanges() を簡素化 |
| `backend/drive_sync_service.go` | DriveSyncService インターフェースからinitialSync関連メソッドを削除 |
| `frontend/src/hooks/useDriveSync.ts` | 変更なし（バックエンドのイベント通知は同じ仕組みを使う） |

### 5.4 削除対象

#### drive_service.go から削除するメソッド (推定 ~500行)

| メソッド | 行数(概算) | 削除理由 |
|---------|-----------|---------|
| `performInitialSync()` | ~60行 | 初回同期を特別扱いしない |
| `publishPreviewNoteList()` | ~20行 | プレビュー表示不要 |
| `prepareCloudNotesForMerge()` | ~20行 | 不明ノート取り込みはCASE Bで統一処理 |
| `mergeNoteListsAndDownload()` | ~25行 | 新しい3パスに統合 |
| `mergeNoteListStructure()` | ~45行 | 丸ごと上書きで不要 |
| `mergeTopLevelOrder()` | ~15行 | 丸ごと上書きで不要 |
| `isStructureChanged()` | ~40行 | 丸ごと上書きで不要 |
| `isNoteListChanged()` | ~30行 | Drive modifiedTimeで判定 |
| `isOneSidedChange()` | ~15行 | コンフリクトコピーを作らないので不要 |
| `handleCloudSync()` | ~50行 | CASE Bに統合 |
| `handleLocalSync()` | ~40行 | CASE Aに統合 |
| `syncNoteCloudToLocal()` | ~25行 | CASE Bのノートダウンロードに統合 |
| `syncNoteLocalToCloud()` | ~15行 | CASE Aのノートアップロードに統合 |
| `buildSyncJournal()` | ~35行 | SyncJournal廃止 |
| `writeSyncJournal()` | ~10行 | SyncJournal廃止 |
| `readSyncJournal()` | ~15行 | SyncJournal廃止 |
| `deleteSyncJournal()` | ~3行 | SyncJournal廃止 |
| `markJournalActionCompleted()` | ~10行 | SyncJournal廃止 |
| `recoverFromJournal()` | ~45行 | SyncJournal廃止 |
| `RecordNoteDeletion()` | ~10行 | SyncState.MarkNoteDeleted() に移行 |
| `saveAndUpdateNoteList()` | ~15行 | 新フローに統合 |
| `handleNoteListSync()` | ~15行 | 新フローに統合 |
| `ensureCloudNoteList()` | ~15行 | 新フローに統合 |
| `findNoteInList()` | ~10行 | 不要 |

#### drive_service.go から削除するフィールド

```go
// driveService から削除:
forceNextSync          bool        // CASE A/B/Cの判定で不要
lastSyncResult         *SyncResult // 削除
lastNoteListUpload     time.Time   // デバウンスはDriveOperationsQueueで管理
deferredUploadTimer    *time.Timer // デバウンスはDriveOperationsQueueで管理
deletedMu             sync.Mutex  // SyncStateに移行
recentlyDeletedNoteIDs map[string]bool // SyncState.DeletedNoteIDs に移行
```

#### domain.go から削除する型

```go
// 削除:
type SyncResult struct { ... }
type SyncJournalAction struct { ... }
type SyncJournal struct { ... }
func (r *SyncResult) HasChanges() bool { ... }
func (r *SyncResult) Summary() string { ... }
```

#### drive_sync_service.go から削除するメソッド

```go
// DriveSyncService インターフェースから削除:
ListUnknownNotes()     // CASE Bのダウンロードフローに統合
ListAvailableNotes()   // 不要
```

#### drive_service.go の mergeNotes() 内の MergeConflictContent 関連

`MergeConflictContent()` 関数自体とそれを呼び出す分岐を削除。

#### drive_polling.go の変更

```go
// 削除:
func (p *DrivePollingService) isSelfNoteListChange() // 不要になる

// 簡素化:
func (p *DrivePollingService) checkForChanges() // isSelfNoteListChangeの呼び出しを除去
```

### 5.5 変更しない (そのまま残す)

| ファイル/構造 | 理由 |
|-------------|------|
| `DriveOperations` インターフェース全体 | 低レベルAPI呼び出しは変更不要 |
| `DriveOperationsQueue` | API呼び出しの直列化・デバウンスは引き続き有用 |
| `DrivePollingService` の基本構造 | Changes API + ポーリングの仕組みは有効 |
| `DriveSyncService` の基本操作 | CreateNote, UpdateNote, DownloadNote, DeleteNote, DownloadNoteList, UpdateNoteList は変更不要 |
| `fileIDCache` | パフォーマンス最適化として有用 |
| `authService` 全体 | 認証フローは同期ロジックと独立 |
| `noteService` の大部分 | ローカルファイル操作は変更不要 |
| `computeContentHash()` | ノート内容の変更検出に引き続き使用 |
| `frontend/` 全体 | フロントエンドは変更不要（バックエンドのイベント通知は同じ） |

---

## 6. 新しい SyncNotes() の擬似コード

```go
func (s *driveService) SyncNotes() error {
    s.syncMu.Lock()
    defer s.syncMu.Unlock()

    if !s.IsConnected() {
        return fmt.Errorf("not connected")
    }

    s.logger.NotifyDriveStatus(s.ctx, "syncing")
    defer s.logger.NotifyDriveStatus(s.ctx, "synced")

    // 1. DriveのnoteList_v2.jsonのメタデータを取得
    noteListID := s.auth.GetDriveSync().NoteListID()
    meta, err := s.driveOps.GetFileMetadata(noteListID)
    if err != nil {
        return s.handleMetadataError(err)
    }
    cloudModifiedTime := meta.ModifiedTime

    // 2. 分岐判定
    cloudChanged := cloudModifiedTime != s.syncState.LastSyncedDriveTs
    localDirty := s.syncState.IsDirty()

    switch {
    case !cloudChanged && !localDirty:
        // 何もしない
        return nil

    case !cloudChanged && localDirty:
        // CASE A: ローカル変更をプッシュ
        return s.pushLocalChanges()

    case cloudChanged && !localDirty:
        // CASE B: クラウド変更をプル
        return s.pullCloudChanges(noteListID)

    default:
        // CASE C: コンフリクト解決
        return s.resolveConflict(noteListID)
    }
}
```

---

## 7. 移行手順

段階的に移行し、各ステップでテスト可能な状態を維持する。

### Phase 1: SyncState の導入（既存ロジックと併存）

1. `sync_state.go` を新規作成
2. `App` 構造体に `syncState *SyncState` フィールドを追加
3. `App.Startup()` で `syncState.Load()` を呼ぶ
4. 各App公開メソッド（SaveNote, DeleteNote, SaveNoteList等）で `syncState.MarkNoteDirty()` / `syncState.MarkNoteDeleted()` / `syncState.MarkDirty()` を追加呼び出し
5. この時点では既存の同期ロジックはそのまま動作する（SyncStateは記録するだけ）

**テスト**: sync_state.json が正しく書き出されること、dirty/DirtyNoteIDs/DeletedNoteIDs が正しく記録されることをユニットテストで確認。

### Phase 2: domain.go の整理 + スキーマ移行

1. `backend/migration/` パッケージを新規作成
   - `v1_types.go`: 旧スキーマの型定義（v1 の NoteList / NoteMetadata をここに閉じ込める）
   - `v1_to_v2.go`: v1 → v2 変換ロジック
   - `snapshot.go`: スナップショット保存（migration_snapshots/ にバックアップ）
   - `migration.go`: エントリポイント `RunIfNeeded()`
   - `v1_to_v2_test.go`: マイグレーションのユニットテスト
2. `domain.go` の `NoteList` / `NoteMetadata` を v2 スキーマに変更
   - `NoteList` から `LastSync` / `LastSyncClientID` を削除
   - `NoteMetadata` から `Order` を削除（配列順序で表現）
   - `SyncResult` / `SyncJournal` / `SyncJournalAction` を削除
   - `DriveSync` から `hasCompletedInitialSync` / `cloudNoteList` を削除、`UpdateCloudNoteList()` を削除
3. `note_service.go` のファイルパス参照を `noteList.json` → `noteList_v2.json` に変更
4. `App.Startup()` の冒頭で `migration.RunIfNeeded()` を呼ぶ
5. コンパイルエラーを潰す（参照箇所を一旦コメントアウトまたは最小限の修正）
6. ※ Drive上のマイグレーション（`ensureNoteList()` の v2 対応）は Phase 3 で実施

**詳細は [11. スキーマ移行](#11-スキーマ移行-notelistjson--notelist_v2json) を参照。**

### Phase 3: drive_service.go の書き換え（コア）

1. `SyncNotes()` を新しい3パス構造に書き換え
2. `pushLocalChanges()` を新規実装
3. `pullCloudChanges()` を新規実装
4. `resolveConflict()` を新規実装
5. 不要になったメソッドを全て削除（5.4節の一覧参照）
6. `driveService` 構造体から不要フィールドを削除
7. `onConnected()` を簡素化（performInitialSyncの特別扱いを除去）
8. `SaveNoteAndUpdateList()` を簡素化

### Phase 4: drive_polling.go の整理

1. `isSelfNoteListChange()` を削除
2. `checkForChanges()` を簡素化
3. `performInitialSync()` の呼び出しを除去し、通常のSyncNotes()に統一

### Phase 5: drive_sync_service.go の整理

1. `DriveSyncService` インターフェースから不要メソッドを削除
2. `ListUnknownNotes()` / `ListAvailableNotes()` を削除
3. テスト用メソッド（`SetInitialSyncCompleted`等）を削除

### Phase 6: app.go の整理

1. `SaveNote()` から直接Driveアップロードのgoroutineを削除し、`syncState.MarkNoteDirty()` + 非同期pushに変更
2. `DeleteNote()` を同様に変更
3. `syncNoteListToDrive()` を `syncState.MarkDirty()` + 非同期pushに変更
4. `SaveNoteList()` の直接Drive呼び出しを削除

### Phase 7: テストの更新

1. 既存のテストファイルのうち、削除したメソッドに依存するものを除去
2. 新しい3パス（CASE A/B/C）のユニットテストを作成
3. SyncState のユニットテストを作成
4. 統合テスト：2端末シミュレーション（モック使用）

---

## 8. テスト計画

### 8.1 SyncState ユニットテスト

```
TestSyncState_MarkNoteDirty
  - MarkNoteDirty(id) → Dirty=true, DirtyNoteIDs にid含む

TestSyncState_MarkNoteDeleted
  - MarkNoteDeleted(id) → Dirty=true, DeletedNoteIDs にid含む

TestSyncState_ClearDirty
  - MarkDirty → ClearDirty → Dirty=false, DirtyNoteIDs={}, DeletedNoteIDs={}

TestSyncState_PersistAndLoad
  - Mark操作 → Save → 新インスタンスでLoad → 状態が復元されている

TestSyncState_CrashRecovery
  - MarkDirty → Save → (クラッシュをシミュレート) → Load → Dirty=true
```

### 8.2 SyncNotes 3パステスト

```
TestSyncNotes_CaseA_NothingToDo
  - クラウド未変更 + dirty=false → API呼び出し0回

TestSyncNotes_CaseA_PushLocalChanges
  - クラウド未変更 + dirty=true + DirtyNoteIDs={"note1"}
  → note1がアップロードされる
  → noteList_v2.jsonがアップロードされる
  → dirty=false

TestSyncNotes_CaseA_PushDeletedNotes
  - クラウド未変更 + dirty=true + DeletedNoteIDs={"note2"}
  → note2がDriveから削除される
  → noteListから除外される

TestSyncNotes_CaseB_PullNewNote
  - クラウド変更あり + dirty=false + クラウドに新ノート
  → ノートがダウンロードされる
  → noteListが丸ごと上書き

TestSyncNotes_CaseB_PullUpdatedNote
  - クラウド変更あり + dirty=false + ContentHashが異なる
  → ノートがダウンロードされる

TestSyncNotes_CaseB_PullDeletedNote
  - クラウド変更あり + dirty=false + クラウドのnoteListからノートが消えている
  → ローカルからノートが削除される

TestSyncNotes_CaseB_StructureOverwrite
  - クラウド変更あり + dirty=false + フォルダ構造が異なる
  → クラウドのフォルダ構造で丸ごと上書き

TestSyncNotes_CaseC_LocalWins
  - クラウド変更あり + dirty=true + DirtyNoteIDsのノートはクラウド側が未変更
  → ローカル変更がアップロードされる

TestSyncNotes_CaseC_CloudWins
  - クラウド変更あり + dirty=true + DirtyNoteIDsのノートがクラウド側も変更 + クラウド側が新しい
  → クラウド版がダウンロードされる

TestSyncNotes_CaseC_LocalNewerWins
  - クラウド変更あり + dirty=true + DirtyNoteIDsのノートがクラウド側も変更 + ローカル側が新しい
  → ローカル版がアップロードされる

TestSyncNotes_CaseC_DeleteAndEdit
  - ローカルでノート削除 + クラウドで同ノート編集
  → 削除が勝つ（最後の操作）or 編集が勝つ（ポリシーによる）
  ※ 推奨: 削除をDrive側にも適用する。復元したい場合はDriveのゴミ箱から。

TestSyncNotes_InitialSync_NoCloud
  - LastSyncedDriveTs="" + DriveにnoteList_v2.jsonなし
  → 全ローカルノートアップロード + noteList_v2.json作成

TestSyncNotes_InitialSync_WithCloud
  - LastSyncedDriveTs="" + DriveにnoteList_v2.jsonあり
  → CASE Bと同じフロー
```

---

## 9. リスクと対策

### 9.1 構造変更の巻き戻り

**リスク**: 端末Aでフォルダを作成し、同時に端末Bでノートを編集して保存すると、端末Bがnotelistを上書きした際にフォルダが消える。

**対策**: 個人利用で同時に構造変更を行うことは稀。万一発生しても、フォルダを再作成すれば済み、ノート内容は失われない。将来的に「構造バージョン番号」を導入して構造変更のみの上書きを防ぐ拡張が可能。

### 9.2 大量ノートの初回同期が遅い

**リスク**: CASE Bで大量のノートをダウンロードする場合、UIがブロックされる可能性。

**対策**: ダウンロードは非同期で行い、10件ごとにフロントエンドにリロード通知を送る（現行のprogressiveダウンロードと同じ手法を使用）。

### 9.3 sync_state.json の破損

**リスク**: sync_state.json の書き込み中にクラッシュした場合、ファイルが壊れる。

**対策**: atomic write（一時ファイルに書き出し→リネーム）を使用。万一壊れた場合はデフォルト値（dirty=true）で初期化し、次回syncで全ノートのContentHashを比較して必要な同期を実行する。

### 9.4 DriveOperationsQueue との整合性

**リスク**: pushLocalChanges() でキューにアイテムを投入した後、SyncStateをクリアすると、キュー内のアイテムがまだ実行されていない可能性がある。

**対策**: pushLocalChanges() はキューを使わず、直接DriveOperationsを呼ぶ（syncMuロック内で実行されるため排他は保証される）。キューは個別のSaveNote/DeleteNoteの即座アップロード用にのみ使用する。もしくは、キュー内のアイテムが全て完了してからSyncStateをクリアする。

---

## 10. 補足: ファイル間の依存関係

```
app.go
  ├── noteService (note_service.go) — ローカルファイル操作
  ├── syncState (sync_state.go) — NEW: dirty状態管理
  └── driveService (drive_service.go) — Drive同期
       ├── driveOps (drive_operations.go) — 低レベルDrive API
       │    └── DriveOperationsQueue (drive_operations_queue.go) — API直列化
       ├── driveSync (drive_sync_service.go) — ノート/noteList の読み書き
       ├── pollingService (drive_polling.go) — 変更検出ループ
       └── authService (auth_service.go) — OAuth認証
```

syncState は driveService とは独立で、app.go が直接管理する。driveService は syncState を参照するが、変更はしない（app.go 経由でのみ変更される）。

---

## 11. スキーマ移行: noteList.json → noteList_v2.json

### 11.1 方針

今回のアーキテクチャ変更に伴い、**noteList.json を noteList_v2.json に移行**する。旧スキーマとの後方互換はマイグレーション時のスナップショット保存のみでカプセル化し、マイグレーションコードは本体ロジックから完全に分離する。

**なぜスキーマを切るか:**

- `NoteList.LastSync` / `LastSyncClientID` の削除、`NoteMetadata` のフィールド整理など、構造的な破壊的変更が複数入る
- 旧スキーマの互換処理を本体コードに残すと、新設計のシンプルさが損なわれる
- ファイル名を変えることで、旧バージョンのアプリが誤って v2 ファイルを読み書きする事故を防ぐ
- Drive上に noteList.json と noteList_v2.json が共存する過渡期でも安全

### 11.2 v2 スキーマ定義

```go
// ---- noteList_v2.json のスキーマ ----

type NoteListV2 struct {
    Version               string           `json:"version"`                        // "2.0"
    Notes                 []NoteMetadataV2 `json:"notes"`
    Folders               []Folder         `json:"folders,omitempty"`
    TopLevelOrder         []TopLevelItem   `json:"topLevelOrder,omitempty"`
    ArchivedTopLevelOrder []TopLevelItem   `json:"archivedTopLevelOrder,omitempty"`
    CollapsedFolderIDs    []string         `json:"collapsedFolderIDs,omitempty"`
    // v1 から削除:
    // LastSync         → SyncState に移行（ローカル専用）
    // LastSyncClientID → 不要（Drive modifiedTime で自己変更検出）
}

type NoteMetadataV2 struct {
    ID            string `json:"id"`
    Title         string `json:"title"`
    ContentHeader string `json:"contentHeader"`
    Language      string `json:"language"`
    ModifiedTime  string `json:"modifiedTime"`
    Archived      bool   `json:"archived"`
    ContentHash   string `json:"contentHash"`
    FolderID      string `json:"folderId,omitempty"`
    // v1 から削除:
    // Order → TopLevelOrder / フォルダ内の配列順序で表現（冗長な二重管理を排除）
}
```

**v1 → v2 の変更点まとめ:**

| フィールド | v1 (NoteList) | v2 (NoteListV2) | 理由 |
|-----------|--------------|-----------------|------|
| `Version` | `"1.0"` | `"2.0"` | スキーマバージョン識別 |
| `LastSync` | `time.Time` | **削除** | SyncState.LastSyncedDriveTs に移行 |
| `LastSyncClientID` | `string` | **削除** | Drive modifiedTime で代替 |
| `NoteMetadata.Order` | `int` | **削除** | TopLevelOrder配列とフォルダ内配列の順序で暗黙的に表現。Orderフィールドとの不整合バグを排除 |

**Folder / TopLevelItem / Note（個別ファイル）の構造は変更なし。**

### 11.3 マイグレーションコードの分離

マイグレーションロジックは `backend/migration/` パッケージとして完全に分離する。本体コード（note_service.go, drive_service.go 等）は v2 スキーマのみを扱い、v1 の型定義やパース処理を一切含まない。

```
backend/
  migration/
    migration.go          // マイグレーション実行エントリポイント
    v1_types.go           // v1スキーマの型定義（NoteList, NoteMetadata の旧定義）
    v1_to_v2.go           // v1 → v2 変換ロジック
    v1_to_v2_test.go      // マイグレーションのユニットテスト
    snapshot.go           // スナップショット保存・復元
```

#### migration.go

```go
package migration

// RunIfNeeded はアプリ起動時に呼ばれ、必要に応じてマイグレーションを実行する。
// マイグレーション不要（v2が既に存在）の場合は何もしない。
// 本体コードはこの関数のみを呼び出す。
func RunIfNeeded(appDataDir string, notesDir string) error {
    localV2Path := filepath.Join(filepath.Dir(notesDir), "noteList_v2.json")

    // v2 が既に存在すれば何もしない
    if _, err := os.Stat(localV2Path); err == nil {
        return nil
    }

    // v1 が存在しなければ何もしない（新規インストール）
    localV1Path := filepath.Join(filepath.Dir(notesDir), "noteList.json")
    if _, err := os.Stat(localV1Path); os.IsNotExist(err) {
        return nil
    }

    // v1 → v2 マイグレーション実行
    return migrateV1ToV2(localV1Path, localV2Path)
}
```

#### v1_types.go — v1の型定義をここに閉じ込める

```go
package migration

// v1NoteList は旧スキーマの型定義。本体コードには含めない。
type v1NoteList struct {
    Version               string           `json:"version"`
    Notes                 []v1NoteMetadata `json:"notes"`
    Folders               []v1Folder       `json:"folders,omitempty"`
    TopLevelOrder         []v1TopLevelItem `json:"topLevelOrder,omitempty"`
    ArchivedTopLevelOrder []v1TopLevelItem `json:"archivedTopLevelOrder,omitempty"`
    CollapsedFolderIDs    []string         `json:"collapsedFolderIDs,omitempty"`
    LastSync              time.Time        `json:"lastSync"`
    LastSyncClientID      string           `json:"lastSyncClientId,omitempty"`
}

type v1NoteMetadata struct {
    ID            string `json:"id"`
    Title         string `json:"title"`
    ContentHeader string `json:"contentHeader"`
    Language      string `json:"language"`
    ModifiedTime  string `json:"modifiedTime"`
    Archived      bool   `json:"archived"`
    ContentHash   string `json:"contentHash"`
    Order         int    `json:"order"`
    FolderID      string `json:"folderId,omitempty"`
}

// v1Folder, v1TopLevelItem は構造が同じでも migration パッケージ内に閉じた型として定義する
// （本体パッケージへの依存を断つため）
type v1Folder struct {
    ID       string `json:"id"`
    Name     string `json:"name"`
    Archived bool   `json:"archived,omitempty"`
}

type v1TopLevelItem struct {
    Type string `json:"type"`
    ID   string `json:"id"`
}
```

#### v1_to_v2.go — 変換ロジック

```go
package migration

func migrateV1ToV2(v1Path, v2Path string) error {
    // 1. v1 を読み込み
    v1Data, err := os.ReadFile(v1Path)
    if err != nil {
        return fmt.Errorf("failed to read v1 noteList: %w", err)
    }
    var v1List v1NoteList
    if err := json.Unmarshal(v1Data, &v1List); err != nil {
        return fmt.Errorf("failed to parse v1 noteList: %w", err)
    }

    // 2. スナップショットを保存（ロールバック用）
    if err := saveSnapshot(v1Path); err != nil {
        return fmt.Errorf("failed to save snapshot: %w", err)
    }

    // 3. v1 → v2 変換
    v2List := convertV1ToV2(&v1List)

    // 4. v2 を書き出し（atomic write）
    v2Data, err := json.MarshalIndent(v2List, "", "  ")
    if err != nil {
        return fmt.Errorf("failed to marshal v2 noteList: %w", err)
    }
    if err := atomicWrite(v2Path, v2Data); err != nil {
        return fmt.Errorf("failed to write v2 noteList: %w", err)
    }

    return nil
}

func convertV1ToV2(v1 *v1NoteList) *NoteListV2 {
    v2 := &NoteListV2{
        Version:            "2.0",
        CollapsedFolderIDs: v1.CollapsedFolderIDs,
    }

    // Folders: 構造は同じなのでそのままコピー
    for _, f := range v1.Folders {
        v2.Folders = append(v2.Folders, Folder{ID: f.ID, Name: f.Name, Archived: f.Archived})
    }

    // TopLevelOrder / ArchivedTopLevelOrder: そのままコピー
    for _, item := range v1.TopLevelOrder {
        v2.TopLevelOrder = append(v2.TopLevelOrder, TopLevelItem{Type: item.Type, ID: item.ID})
    }
    for _, item := range v1.ArchivedTopLevelOrder {
        v2.ArchivedTopLevelOrder = append(v2.ArchivedTopLevelOrder, TopLevelItem{Type: item.Type, ID: item.ID})
    }

    // Notes: Order を削除し、v1 の Order 順にソートした配列順序を維持
    sorted := make([]v1NoteMetadata, len(v1.Notes))
    copy(sorted, v1.Notes)
    sort.Slice(sorted, func(i, j int) bool { return sorted[i].Order < sorted[j].Order })

    for _, n := range sorted {
        v2.Notes = append(v2.Notes, NoteMetadataV2{
            ID:            n.ID,
            Title:         n.Title,
            ContentHeader: n.ContentHeader,
            Language:      n.Language,
            ModifiedTime:  n.ModifiedTime,
            Archived:      n.Archived,
            ContentHash:   n.ContentHash,
            FolderID:      n.FolderID,
        })
    }

    return v2
}
```

#### snapshot.go — スナップショット保存

```go
package migration

const snapshotDir = "migration_snapshots"

// saveSnapshot は v1 ファイルのバックアップを migration_snapshots/ に保存する
func saveSnapshot(v1Path string) error {
    dir := filepath.Join(filepath.Dir(v1Path), snapshotDir)
    if err := os.MkdirAll(dir, 0755); err != nil {
        return err
    }

    data, err := os.ReadFile(v1Path)
    if err != nil {
        return err
    }

    timestamp := time.Now().Format("20060102_150405")
    snapshotPath := filepath.Join(dir, fmt.Sprintf("noteList_v1_%s.json", timestamp))
    return os.WriteFile(snapshotPath, data, 0644)
}
```

### 11.4 Drive上のマイグレーション

ローカルだけでなく、Drive上のファイルもマイグレーションが必要。

```
Drive上のマイグレーションフロー（onConnected 内で実行）:

  1. Drive に noteList_v2.json が存在するか確認
     → 存在する: そのまま使用（マイグレーション済み）

  2. noteList_v2.json が存在しない & noteList.json が存在する:
     a. noteList.json をダウンロード
     b. v1 → v2 変換（ローカルのマイグレーションと同じロジック）
     c. noteList_v2.json を Drive にアップロード
     d. noteList.json は削除しない（旧バージョンのアプリがまだ使う可能性）
        ※ 旧バージョンの noteList.json は放置。noteList_v2.json が truth source になる。

  3. どちらも存在しない（新規ユーザー）:
     → noteList_v2.json を新規作成
```

**旧 noteList.json を削除しない理由**: 複数端末でアプリのアップデートタイミングが異なる場合、旧バージョンがまだ noteList.json を読み書きしている可能性がある。新バージョンは noteList_v2.json のみを使い、noteList.json は無視する。ユーザーが全端末をアップデートした後、noteList.json は手動削除するか自然に放置する。

### 11.5 ensureNoteList() の変更

現行の `ensureNoteList()` (drive_service.go L1438-1459) を noteList_v2.json に対応させる。

```go
func (s *driveService) ensureNoteList() error {
    rootID, notesID := s.auth.GetDriveSync().FolderIDs()

    // 1. noteList_v2.json を探す
    v2Files, err := s.driveOps.ListFiles(
        fmt.Sprintf("name='noteList_v2.json' and '%s' in parents and trashed=false", rootID))
    if err != nil {
        return err
    }

    if len(v2Files) > 0 {
        // v2 が見つかった → そのまま使用
        s.auth.GetDriveSync().SetNoteListID(v2Files[0].Id)
        return nil
    }

    // 2. v2 がない → v1 からマイグレーションを試みる
    v1Files, err := s.driveOps.ListFiles(
        fmt.Sprintf("name='noteList.json' and '%s' in parents and trashed=false", rootID))
    if err != nil {
        return err
    }

    if len(v1Files) > 0 {
        // v1 をダウンロードして v2 に変換・アップロード
        if err := s.migrateCloudNoteList(v1Files[0].Id, rootID); err != nil {
            return err
        }
        return nil
    }

    // 3. どちらもない → 新規作成
    if err := s.driveSync.CreateNoteList(s.ctx, s.noteService.noteList); err != nil {
        return err
    }
    noteListID, err := s.driveOps.GetFileID("noteList_v2.json", notesID, rootID)
    if err != nil {
        return err
    }
    s.auth.GetDriveSync().SetNoteListID(noteListID)
    return nil
}
```

### 11.6 本体コードの参照変更

マイグレーション完了後、本体コードでの `noteList.json` への参照を全て `noteList_v2.json` に変更する。

| ファイル | 変更箇所 |
|---------|---------|
| `backend/note_service.go` L831, L1017 | ローカルファイルパス `noteList.json` → `noteList_v2.json` |
| `backend/drive_service.go` L1441, L1452, L1472 | Drive上のファイル名検索 `noteList.json` → `noteList_v2.json` |
| `backend/drive_operations.go` L175, L180-187 | `GetFileID` 内のファイル名判定 |
| `backend/drive_sync_service.go` L490 | CreateNoteList のファイル名 |

型名も `NoteList` → `NoteListV2`、`NoteMetadata` → `NoteMetadataV2` にリネームする。ただし移行完了後は `V2` サフィックスを外して `NoteList` / `NoteMetadata` に戻しても良い（v1の型定義は migration パッケージに閉じているため衝突しない）。

### 11.7 移行手順への組み込み

本計画の Phase 2（domain.go の整理）に以下を追加：

```
Phase 2: domain.go の整理 + スキーマ移行
  2-1. backend/migration/ パッケージを新規作成
       - v1_types.go: 旧スキーマの型定義
       - v1_to_v2.go: 変換ロジック
       - snapshot.go: スナップショット保存
       - migration.go: エントリポイント
       - v1_to_v2_test.go: テスト
  2-2. domain.go の NoteList / NoteMetadata を v2 スキーマに変更
       - LastSync, LastSyncClientID を削除
       - NoteMetadata.Order を削除
  2-3. note_service.go のファイルパス参照を noteList_v2.json に変更
  2-4. App.Startup() の冒頭で migration.RunIfNeeded() を呼ぶ
  2-5. drive_service.go の ensureNoteList() を v2 対応に書き換え
```

### 11.8 マイグレーションのテスト

```
TestMigration_V1ToV2_Basic
  - v1 noteList.json を用意 → migrateV1ToV2() → v2 の構造が正しいことを確認
  - Notes が Order 順にソートされていること
  - LastSync / LastSyncClientID が除去されていること
  - Order フィールドが存在しないこと

TestMigration_V1ToV2_EmptyNoteList
  - 空の v1 noteList → v2 に変換 → Notes=[], Version="2.0"

TestMigration_V1ToV2_WithFolders
  - フォルダ・アーカイブ付きの v1 → v2 に変換 → 構造が保持されていること

TestMigration_Snapshot_Created
  - マイグレーション実行 → migration_snapshots/ にバックアップが存在すること

TestMigration_RunIfNeeded_AlreadyMigrated
  - noteList_v2.json が既に存在 → 何もしない（冪等性）

TestMigration_RunIfNeeded_FreshInstall
  - v1 も v2 も存在しない → 何もしない

TestMigration_RunIfNeeded_V1Exists
  - noteList.json のみ存在 → v2 に変換、スナップショット作成

TestMigration_DriveV1ToV2
  - Drive上に noteList.json のみ → ダウンロード → v2変換 → noteList_v2.json アップロード
  - 旧 noteList.json は削除されないこと
```
