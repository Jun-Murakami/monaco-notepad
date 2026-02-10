# Add Status Bar Notifications for Silent Backend Operations

## TL;DR

> **Quick Summary**: バックエンドで暗黙的に実行されるデータ修復・整合性チェック操作にステータスバー通知を追加する。noteServiceにloggerを注入し、ValidateIntegrity()が修復詳細レポートを返すように変更し、すべてのサイレント操作にlogger.Info()による通知を追加する。
> 
> **Deliverables**:
> - `noteService` に `logger AppLogger` フィールド追加、`NewNoteService` シグネチャ変更
> - `IntegrityReport` 構造体を `domain.go` に追加
> - `ValidateIntegrity()` の戻り値を `(bool, error)` → `(*IntegrityReport, error)` に変更
> - すべてのサイレント操作に日本語ステータスバー通知追加
> - `fmt.Println` デバッグ出力を `logger.Console()` に置換
> - 既存テストを新シグネチャに対応更新
> 
> **Estimated Effort**: Medium
> **Parallel Execution**: NO — sequential (all changes are interdependent)
> **Critical Path**: Task 1 (IntegrityReport) → Task 2 (noteService logger) → Task 3 (ValidateIntegrity refactor) → Task 4 (notifications) → Task 5 (fmt.Println cleanup) → Task 6 (test updates)

---

## Context

### Original Request
「バックエンドで暗黙的に修復・操作されている箇所にステータスバー通知を追加してほしい。バックエンド全体をレビューして、通知が必要な箇所を見つけて対応する。」

### Interview Summary
**Key Discussions**:
- UXスタイル: Evernote風のステータスバー通知のみ、ダイアログは使わない
- 通知チャネル: `logger.Info()` → `logMessage` イベント → `EditorStatusBar.tsx` で8秒間表示後フェードアウト
- 言語: 既存の日本語メッセージパターンに合わせる
- バッチ通知: 関連する操作はまとめてサマリーメッセージにする（過通知を避ける）

**Research Findings**:
- `noteService` は現在 `logger` フィールドを持たない純粋データサービス
- `driveService` は `logger AppLogger` フィールドを持ち広範囲に使用
- `logger` は `app.go:127` で作成され、`noteService` は `app.go:139` で作成される → logger を NewNoteService に渡せる
- `ValidateIntegrity()` は2箇所から呼ばれる: (1) `loadNoteList()` (起動時), (2) `notifySyncComplete()` (同期完了後)
- `EditorStatusBar.tsx` は `logMessage` イベントを受信し8秒間表示
- 既存日本語パターン例: "同期をスキップ: 保留中の操作あり", "「%s」の競合コピーを作成しました"
- テストの `setupNoteTest()` は `NewNoteService(notesDir)` を呼んでいる — シグネチャ変更で全テストに影響

### Self-Review Gap Analysis (Metis代替)
**Identified Gaps** (addressed):
- Gap: `NewNoteService` のシグネチャ変更が `drive_service_test.go` のヘルパーにも影響する → テスト更新タスクに含める
- Gap: テスト環境でloggerをどうするか → テスト用に `NewAppLogger(ctx, true, tempDir)` で `isTestMode=true` のloggerを渡す
- Gap: `loadNoteList()` 内の `fmt.Println` は起動時に呼ばれるが、この時点でloggerが設定済みか → app.go:127でlogger作成 → app.go:139でnoteService作成。logger渡し可能
- Gap: `resolveMetadataConflicts()` で修正が発生した場合の通知タイミング → loadNoteList内のサイレント操作はまとめて1つの通知にする
- Gap: `deduplicateNoteList()` が `SaveNote()` 内からも呼ばれる — SaveNote時の重複除去は通常発生しないので通知不要、loadNoteList時のみ通知

---

## Work Objectives

### Core Objective
バックエンドのすべてのサイレント修復・メンテナンス操作に対して、ユーザーが認知できるステータスバー通知を追加する。

### Concrete Deliverables
- `backend/domain.go`: `IntegrityReport` 構造体追加
- `backend/note_service.go`: logger注入、ValidateIntegrity戻り値変更、通知追加
- `backend/app.go`: NewNoteServiceへのlogger渡し、fmt.Println → logger.Console
- `backend/drive_service.go`: notifySyncComplete内のレポート活用
- `backend/drive_operations.go`: fmt.Println → logger.Console
- `backend/note_service_test.go`: 新シグネチャ対応
- `backend/drive_service_test.go`: 新シグネチャ対応

### Definition of Done
- [ ] すべての `fmt.Println` がバックエンドコードから除去されている（app_logger.go内の実装は除く）
- [ ] ValidateIntegrityが修復した内容の詳細を返す
- [ ] 修復が発生した場合、ステータスバーに日本語サマリーが表示される
- [ ] ListNotes/ArchiveFolder/UnarchiveFolder でノート読み込み失敗時に通知がある
- [ ] `go test ./backend/...` が全パス

### Must Have
- noteServiceにloggerフィールド追加
- IntegrityReport構造体（修復カウント付き）
- ValidateIntegrity()の戻り値変更
- 日本語の通知メッセージ
- 全既存テストが新シグネチャで通る

### Must NOT Have (Guardrails)
- ❌ フロントエンド変更（`EditorStatusBar.tsx` は既にlogMessageを表示する仕組みがある）
- ❌ ダイアログやモーダル通知（ステータスバーのみ）
- ❌ 英語のユーザー向けメッセージ（Console出力は英語OK、Info出力は日本語）
- ❌ 新しいイベントの追加（既存の `logMessage` イベントのみ使用）
- ❌ ValidateIntegrityのロジック変更（戻り値の型変更のみ、修復ロジック自体は変えない）
- ❌ 過度な通知（正常時・変更なし時はステータスバーに何も出さない）
- ❌ `deduplicateNoteList()` を `SaveNote()` 経路で呼んだ場合の通知（通常はノーオペのため不要）

---

## Verification Strategy

> **UNIVERSAL RULE: ZERO HUMAN INTERVENTION**
>
> ALL tasks in this plan MUST be verifiable WITHOUT any human action.

### Test Decision
- **Infrastructure exists**: YES
- **Automated tests**: YES (Tests-after — 既存テストの更新)
- **Framework**: Go標準 `testing` + `testify`

### Agent-Executed QA Scenarios (MANDATORY — ALL tasks)

**Verification Tool:**

| Type | Tool | How Agent Verifies |
|------|------|-------------------|
| **Backend Go** | Bash (go test) | Run tests, verify pass count, check output |
| **Build check** | Bash (go build) | Compile without errors |

---

## Execution Strategy

### Sequential Execution (Mandatory)

All tasks are interdependent and must be executed in order:

```
Task 1: IntegrityReport struct (domain.go)
  ↓
Task 2: Add logger to noteService (note_service.go constructor)
  ↓
Task 3: Refactor ValidateIntegrity return type + add notifications
  ↓
Task 4: Add notifications to all other silent operations
  ↓
Task 5: Replace fmt.Println with logger.Console
  ↓
Task 6: Update all callers and tests
```

**Why sequential**: Each task builds on the previous — IntegrityReport must exist before ValidateIntegrity can return it, logger must be injected before any notifications can be added, etc.

---

## TODOs

- [ ] 1. IntegrityReport 構造体を domain.go に追加

  **What to do**:
  - `domain.go` に `IntegrityReport` 構造体を追加する:
    ```go
    // IntegrityReport はデータ整合性チェックの修復結果を報告する
    type IntegrityReport struct {
        OrphansRestored  int  // リストに無い孤立ファイルを復元した数
        StaleRemoved     int  // ファイルが無いリストエントリを除去した数
        OrderFixed       int  // TopLevelOrder/ArchivedTopLevelOrderの修正数
        Changed          bool // いずれかの修復が行われたか
    }
    ```
  - `IntegrityReport` に `Summary() string` メソッドを追加する:
    ```go
    func (r *IntegrityReport) Summary() string {
        if !r.Changed {
            return ""
        }
        parts := []string{}
        if r.OrphansRestored > 0 {
            parts = append(parts, fmt.Sprintf("%d件復元", r.OrphansRestored))
        }
        if r.StaleRemoved > 0 {
            parts = append(parts, fmt.Sprintf("%d件除去", r.StaleRemoved))
        }
        if r.OrderFixed > 0 {
            parts = append(parts, fmt.Sprintf("表示順序を修正", ))
        }
        return "データ整合性チェック: " + strings.Join(parts, "、")
    }
    ```
    - 注意: `Summary()` の `OrderFixed` 部分は件数を表示しない（「表示順序を修正」のみ）。理由: TopLevelOrderの修正は内部的な件数がユーザーにとって意味がないため
    - `strings` パッケージのimportが必要なら `domain.go` のimportに追加

  **Must NOT do**:
  - 既存の `SyncResult` 構造体を変更しない
  - `IntegrityReport` に修復ロジックを含めない（データ構造のみ）

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 単一ファイルへの構造体追加のみ。シンプルな変更
  - **Skills**: [`git-master`]
    - `git-master`: コミット関連で必要になる可能性

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential
  - **Blocks**: Task 3
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `backend/domain.go:101-134` — `SyncResult` 構造体と `Summary()` メソッド。IntegrityReportも同じパターンで実装する。Summary()メソッドの日本語メッセージフォーマットを参考にする

  **Acceptance Criteria**:
  - [ ] `backend/domain.go` に `IntegrityReport` 構造体が追加されている
  - [ ] `Summary()` メソッドが、変更がない場合に空文字を返す
  - [ ] `Summary()` メソッドが、修復内容に応じた日本語サマリーを返す
  - [ ] `go build ./backend/...` がエラーなくコンパイルされる

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Go build succeeds after adding IntegrityReport
    Tool: Bash
    Preconditions: None
    Steps:
      1. Run: cd backend && go build ./...
      2. Assert: exit code is 0
      3. Assert: no compilation errors in output
    Expected Result: Clean build
    Evidence: Build output captured
  ```

  **Commit**: NO (groups with Task 6)

---

- [ ] 2. noteService に logger を注入する

  **What to do**:
  - `backend/note_service.go` の `noteService` 構造体に `logger AppLogger` フィールドを追加:
    ```go
    type noteService struct {
        notesDir string
        noteList *NoteList
        logger   AppLogger
    }
    ```
  - `NewNoteService` のシグネチャを変更:
    ```go
    func NewNoteService(notesDir string, logger AppLogger) (*noteService, error) {
    ```
  - `NewNoteService` 内で `service.logger = logger` を設定
  - `backend/app.go` の `Startup()` 内の呼び出しを更新:
    ```go
    // 変更前: noteService, err := NewNoteService(a.notesDir)
    // 変更後:
    noteService, err := NewNoteService(a.notesDir, a.logger)
    ```

  **Must NOT do**:
  - noteService の既存のパブリックメソッドシグネチャを変更しない
  - この時点ではloggerをまだ使用しない（注入のみ）
  - テストファイルはTask 6でまとめて更新するのでここでは触らない（ビルドが通らなくてOK — テストファイルは別コンパイル単位ではないので注意。テストが同じパッケージ内なので、テストファイルの `NewNoteService` 呼び出しもここで更新する必要がある）

  **Important**: Go では同一パッケージのテストファイルもビルド対象なので、`NewNoteService` シグネチャ変更時にテストファイルの呼び出しも同時に更新しないとコンパイルエラーになる。以下のテストファイルの `NewNoteService` 呼び出しを更新すること:
  - `backend/note_service_test.go` の `setupNoteTest()` (line 68)
  - `backend/drive_service_test.go` 内の `NewNoteService` 呼び出し（grepで特定）
  
  テスト用loggerは `NewAppLogger(context.Background(), true, tempDir)` で作成する（`isTestMode=true` でイベント通知が無効化される）。

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 構造体フィールド追加とコンストラクタシグネチャ変更。機械的な変更
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential
  - **Blocks**: Task 3, 4, 5
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `backend/note_service.go:48-69` — 現在の `noteService` 構造体と `NewNoteService` コンストラクタ。ここにloggerフィールドを追加する
  - `backend/app.go:126-144` — `Startup()` 内でloggerが先に初期化され、その後noteServiceが初期化される流れ。line 127でlogger作成、line 139でnoteService作成
  - `backend/drive_service.go` の `driveService` 構造体 — loggerフィールドの持ち方の参考パターン（grepで `logger AppLogger` を検索）
  - `backend/note_service_test.go:54-78` — `setupNoteTest()` テストヘルパー。NewNoteServiceの呼び出しを更新する必要がある
  - `backend/app_logger.go:34-45` — `NewAppLogger(ctx, isTestMode, appDataDir)` の呼び出しパターン。テスト用には `isTestMode=true` で作成する

  **Acceptance Criteria**:
  - [ ] `noteService` 構造体に `logger AppLogger` フィールドがある
  - [ ] `NewNoteService` が `(notesDir string, logger AppLogger)` シグネチャになっている
  - [ ] `app.go` の `Startup()` が `NewNoteService(a.notesDir, a.logger)` を呼んでいる
  - [ ] テストファイル内の `NewNoteService` 呼び出しが更新されている
  - [ ] `go build ./backend/...` がエラーなくコンパイルされる
  - [ ] `go test ./backend/... -count=1` が全パス

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: All Go tests pass after logger injection
    Tool: Bash
    Preconditions: Tasks 1-2 complete
    Steps:
      1. Run: cd backend && go test ./... -count=1
      2. Assert: exit code is 0
      3. Assert: output contains "ok" for all packages
      4. Assert: no "FAIL" in output
    Expected Result: All tests pass
    Evidence: Test output captured
  ```

  **Commit**: NO (groups with Task 6)

---

- [ ] 3. ValidateIntegrity() の戻り値を IntegrityReport に変更し通知を追加

  **What to do**:
  - `backend/note_service.go` の `ValidateIntegrity()` メソッドシグネチャを変更:
    ```go
    // 変更前: func (s *noteService) ValidateIntegrity() (changed bool, err error) {
    // 変更後:
    func (s *noteService) ValidateIntegrity() (*IntegrityReport, error) {
    ```
  - メソッド冒頭で `report := &IntegrityReport{}` を初期化
  - 各修復箇所で `report` のカウンターをインクリメント:
    - 孤立ファイル復元（line 994-1008付近）: `report.OrphansRestored++`
    - 不在ファイル除去（line 1012-1020付近）: `report.StaleRemoved++`
    - TopLevelOrder修正（line 1042-1062付近の各 `changed = true`）: `report.OrderFixed++`
    - ArchivedTopLevelOrder修正（line 1064-1084付近）: `report.OrderFixed++`
    - アクティブノート/フォルダ追加（line 1086-1130付近）: `report.OrderFixed++`
  - 既存の `changed` ローカル変数を削除し、代わりに `report.Changed` を使用
    - 各 `changed = true` を `report.Changed = true` に置換
  - 戻り値を `return report, nil` / `return report, err` に変更
  - メソッド末尾（saveNoteList呼び出しの後）でlogger通知を追加:
    ```go
    if report.Changed && s.logger != nil {
        if summary := report.Summary(); summary != "" {
            s.logger.Info(summary)
        }
    }
    ```
  - `loadNoteList()` 内の呼び出し（line 828）を更新:
    ```go
    // 変更前: if _, err := s.ValidateIntegrity(); err != nil {
    // 変更後:
    if _, err := s.ValidateIntegrity(); err != nil {
    ```
    （戻り値の `_` はそのまま。ValidateIntegrity内部でlogger.Infoが呼ばれるので、callerでの追加通知は不要）
  - `resolveMetadataConflicts()` 内でスキップされたノートの通知を追加（line 888-893付近）:
    ```go
    if os.IsNotExist(err) {
        if s.logger != nil {
            s.logger.Console("resolveMetadataConflicts: ノート %s のファイルが見つかりません（スキップ）", listMetadata.ID)
        }
        continue
    }
    ```
    - これは `Console` を使う（ファイル不在はValidateIntegrityが別途修復するため、ユーザー通知は不要）
  
  **Must NOT do**:
  - ValidateIntegrity の修復ロジック自体を変更しない（カウンターの追加と戻り値の型変更のみ）
  - loadNoteList内での追加通知は不要（ValidateIntegrity内部で通知される）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low`
    - Reason: 戻り値の型変更とカウンター追加。ロジック理解が必要だが変更は機械的
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential
  - **Blocks**: Task 4, 6
  - **Blocked By**: Task 1, 2

  **References**:

  **Pattern References**:
  - `backend/note_service.go:974-1139` — `ValidateIntegrity()` メソッド全体。各 `changed = true` の箇所がカウンターインクリメントに変わる
  - `backend/note_service.go:828` — `loadNoteList()` 内での `ValidateIntegrity()` 呼び出し
  - `backend/note_service.go:879-935` — `resolveMetadataConflicts()` でのサイレントスキップ箇所
  - `backend/domain.go` — Task 1で追加した `IntegrityReport` 構造体

  **API/Type References**:
  - `backend/domain.go:IntegrityReport` — 新しい戻り値の型（Task 1で追加）

  **Acceptance Criteria**:
  - [ ] `ValidateIntegrity()` の戻り値が `(*IntegrityReport, error)` になっている
  - [ ] 孤立ファイル復元時に `report.OrphansRestored` がインクリメントされる
  - [ ] 不在ファイル除去時に `report.StaleRemoved` がインクリメントされる
  - [ ] TopLevelOrder/ArchivedTopLevelOrder修正時に `report.OrderFixed` がインクリメントされる
  - [ ] 修復が発生した場合、`s.logger.Info(report.Summary())` が呼ばれる
  - [ ] `go build ./backend/...` がコンパイルエラーなし（テストファイルの更新はTask 6）

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Build succeeds after ValidateIntegrity refactor
    Tool: Bash
    Preconditions: Tasks 1-3 complete
    Steps:
      1. Run: cd backend && go vet ./...
      2. Assert: exit code is 0
      3. Run: cd backend && go build ./...
      4. Assert: exit code is 0
    Expected Result: Clean build, no vet warnings
    Evidence: Build output captured
  ```

  **Commit**: NO (groups with Task 6)

---

- [ ] 4. すべてのサイレント操作に通知を追加

  **What to do**:

  **4a. `ListNotes()` の読み込み失敗スキップ (note_service.go:95-96)**:
  ```go
  // 変更前:
  // note, err := s.LoadNote(metadata.ID)
  // if err != nil {
  //     continue
  // }
  // 変更後:
  note, err := s.LoadNote(metadata.ID)
  if err != nil {
      if s.logger != nil {
          s.logger.Console("ListNotes: ノート %s の読み込みをスキップ: %v", metadata.ID, err)
      }
      continue
  }
  ```
  - **Console** を使う理由: ListNotesはフロントエンドから頻繁に呼ばれる。毎回エラーをステータスバーに出すとうるさい。コンソールログで十分

  **4b. `ArchiveFolder()` の読み込み失敗スキップ (note_service.go:560-562)**:
  ```go
  note, err := s.LoadNote(metadata.ID)
  if err != nil {
      if s.logger != nil {
          s.logger.Info("フォルダアーカイブ中にノート「%s」の読み込みをスキップしました", metadata.Title)
      }
      continue
  }
  ```
  - **Info** を使う理由: ユーザーがフォルダアーカイブを明示的に操作した結果。ノートが欠損していることを知らせるべき

  **4c. `UnarchiveFolder()` の読み込み失敗スキップ (note_service.go:612-614)**:
  ```go
  note, err := s.LoadNote(metadata.ID)
  if err != nil {
      if s.logger != nil {
          s.logger.Info("フォルダ復元中にノート「%s」の読み込みをスキップしました", metadata.Title)
      }
      continue
  }
  ```

  **4d. `DeleteArchivedFolder()` のファイル削除ログ (note_service.go:654-655)**:
  - 個別のファイル削除にはログ不要（過通知になる）
  - ただし、メソッド末尾でサマリー通知を追加:
  ```go
  // DeleteArchivedFolder メソッドの末尾、return の前に:
  // 削除したノート数をカウント（remainingNotes計算後）
  deletedCount := len(s.noteList.Notes) - len(remainingNotes)  // ← ここはnoteListの更新前に計算する必要あり
  ```
  - 実際の実装: ループ内で削除カウントを計算する:
  ```go
  var remainingNotes []NoteMetadata
  deletedCount := 0
  for _, metadata := range s.noteList.Notes {
      if metadata.FolderID == id {
          notePath := filepath.Join(s.notesDir, metadata.ID+".json")
          os.Remove(notePath)
          deletedCount++
      } else {
          remainingNotes = append(remainingNotes, metadata)
      }
  }
  // ... 既存のフォルダ削除処理 ...
  if s.logger != nil && deletedCount > 0 {
      s.logger.Console("DeleteArchivedFolder: %d件のノートファイルを削除", deletedCount)
  }
  ```
  - **Console** を使う理由: ユーザーが明示的にアーカイブフォルダを削除した操作。削除されること自体はユーザーの意図通りなのでステータスバー通知は不要

  **4e. `loadNoteList()` の fmt.Println 置換 (note_service.go:794)**:
  ```go
  // 変更前: fmt.Println("loadNoteList: noteList.json not found, creating new one")
  // 変更後:
  if s.logger != nil {
      s.logger.Info("ノートリストを新規作成しました")
  }
  ```
  - **Info** を使う理由: 初回起動時のみ発生。ユーザーに新規作成されたことを知らせるのが適切

  **4f. `loadNoteList()` 内の deduplicateNoteList/deduplicateTopLevelOrder/resolveMetadataConflicts**:
  - これらの結果は `isNoteListEqual` で間接的に検出される（line 833）
  - 個別の通知は不要。ValidateIntegrity が包括的にレポートする
  - ただし、deduplicateNoteListで実際に重複が除去された場合のログ追加:
  ```go
  // deduplicateNoteList() の末尾:
  func (s *noteService) deduplicateNoteList() int {
      // ... 既存ロジック ...
      removed := len(s.noteList.Notes) - len(deduped)
      s.noteList.Notes = deduped
      return removed  // 戻り値を追加
  }
  ```
  - **注意**: `deduplicateNoteList()` は `SaveNote()` からも呼ばれるため、戻り値変更がSaveNoteに影響する。SaveNote側では戻り値を無視して良い:
    ```go
    // SaveNote 内:
    s.deduplicateNoteList()  // 戻り値を使わなくてもOK（Goは戻り値を無視できる）
    ```
  - `loadNoteList()` 内では:
    ```go
    removedDups := s.deduplicateNoteList()
    if removedDups > 0 && s.logger != nil {
        s.logger.Console("loadNoteList: %d件の重複ノートを除去", removedDups)
    }
    ```
  - **Console** を使う理由: 重複除去は内部的なデータクリーンアップ。ユーザーには ValidateIntegrity のサマリーで十分

  **4g. `RemoveDuplicateNoteFiles()` in drive_sync_service.go (line 409-436)**:
  - この関数は `drive_polling.go:67` から呼ばれ、`driveService` の logger が使える
  - `drive_polling.go` 内で呼び出し結果をログに追加:
    ```go
    // 変更前 (drive_polling.go:67):
    // if err := p.driveService.driveSync.RemoveDuplicateNoteFiles(p.ctx, files); err != nil {
    //     p.logger.Error(err, "Failed to clean duplicate note files")
    // }
    // 変更後:
    if err := p.driveService.driveSync.RemoveDuplicateNoteFiles(p.ctx, files); err != nil {
        p.logger.Error(err, "Failed to clean duplicate note files")
    }
    // ← 既存のErrorログで十分。RemoveDuplicateNoteFiles自体はloggerを持たないため追加不要
    ```
  - 実際には `RemoveDuplicateNoteFiles` は既にエラー時にcallerでログされている。成功時の通知は不要（重複がなければノーオペ、あっても自動修復は正常動作）

  **4h. `notifySyncComplete()` の IntegrityReport 活用 (drive_service.go:627-649)**:
  ```go
  func (s *driveService) notifySyncComplete() {
      // 変更前: if changed, err := s.noteService.ValidateIntegrity()
      // 変更後:
      report, err := s.noteService.ValidateIntegrity()
      if err != nil {
          s.logger.Error(err, "同期後の整合性チェックに失敗しました")
      } else if report.Changed {
          // ValidateIntegrity内部でlogger.Info(summary)が呼ばれるため、ここでは追加通知不要
          // ただしクラウドへのアップロードは必要
          s.logger.Console("Note list integrity fixed after sync, uploading corrected noteList")
          if s.IsConnected() {
              if uploadErr := s.updateNoteListInternal(); uploadErr != nil {
                  s.logger.Error(uploadErr, "修正済みノートリストのアップロードに失敗しました")
              }
          }
      }
      // ... 残りは既存のまま ...
  }
  ```

  **Must NOT do**:
  - `driveService` の既存ログレベル（Error/Info/Console）を変更しない
  - 同期中の個別ノート操作への通知追加（既にlogger.Errorで通知されている）
  - `deduplicateNoteList()` のロジック変更（戻り値の追加のみ）
  - フロントエンドの変更

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 複数ファイルにまたがる変更、各箇所で適切なログレベル判断が必要
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential
  - **Blocks**: Task 5, 6
  - **Blocked By**: Task 2, 3

  **References**:

  **Pattern References**:
  - `backend/note_service.go:93-97` — ListNotes内のサイレントcontinue
  - `backend/note_service.go:559-563` — ArchiveFolder内のサイレントcontinue
  - `backend/note_service.go:611-614` — UnarchiveFolder内のサイレントcontinue
  - `backend/note_service.go:651-655` — DeleteArchivedFolder内のos.Remove
  - `backend/note_service.go:790-840` — loadNoteList全体（fmt.Println + サイレント操作群）
  - `backend/note_service.go:772-787` — deduplicateNoteList（戻り値追加対象）
  - `backend/drive_service.go:627-649` — notifySyncComplete（ValidateIntegrity呼び出し元）
  - `backend/drive_polling.go:66-69` — RemoveDuplicateNoteFiles呼び出し

  **API/Type References**:
  - `backend/app_logger.go:14-23` — AppLoggerインターフェース。Info (ユーザー可視), Console (コンソールのみ), Error (エラー) の使い分け

  **Acceptance Criteria**:
  - [ ] `ListNotes` でLoadNote失敗時に `logger.Console` が呼ばれる
  - [ ] `ArchiveFolder` でLoadNote失敗時に `logger.Info` で日本語メッセージが出る
  - [ ] `UnarchiveFolder` でLoadNote失敗時に `logger.Info` で日本語メッセージが出る
  - [ ] `DeleteArchivedFolder` でノート削除時に `logger.Console` でカウントログが出る
  - [ ] `loadNoteList` の `fmt.Println` が `logger.Info` に置換されている
  - [ ] `notifySyncComplete` が `IntegrityReport` を使用している
  - [ ] `go build ./backend/...` がエラーなくコンパイルされる

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Build succeeds after all notification additions
    Tool: Bash
    Preconditions: Tasks 1-4 complete
    Steps:
      1. Run: cd backend && go build ./...
      2. Assert: exit code is 0
    Expected Result: Clean build
    Evidence: Build output captured

  Scenario: No fmt.Println remains in note_service.go
    Tool: Bash
    Preconditions: Tasks 1-4 complete
    Steps:
      1. Run: grep -n "fmt.Println" backend/note_service.go
      2. Assert: no matches found (exit code 1)
    Expected Result: No fmt.Println in note_service.go
    Evidence: grep output captured
  ```

  **Commit**: NO (groups with Task 6)

---

- [ ] 5. fmt.Println デバッグ出力を logger.Console に置換

  **What to do**:

  **5a. `app.go:121`**:
  ```go
  // 変更前: fmt.Println("appDataDir: ", a.appDataDir)
  // 変更後:
  a.logger.Console("appDataDir: %s", a.appDataDir)
  ```
  - **注意**: この行は `a.logger = NewAppLogger(...)` (line 127) の**前**にある。loggerがまだnilの可能性がある
  - 解決策: この行を logger 初期化の後（line 127の後）に移動する。もしくは、Startup() の並びを見ると line 121 は line 127 より前なので、loggerがまだ存在しない。2つの選択肢:
    1. 行を logger 初期化後に移動する
    2. `fmt.Println` のまま残す（logger初期化前なので仕方ない）
  - **推奨**: 行を logger 初期化の直後に移動する:
    ```go
    // line 127付近:
    a.logger = NewAppLogger(ctx, false, a.appDataDir)
    a.logger.Console("appDataDir: %s", a.appDataDir)
    ```

  **5b. `app.go:292`**:
  ```go
  // 変更前: fmt.Println("SaveNoteList called")
  // 変更後:
  a.logger.Console("SaveNoteList called")
  ```

  **5c. `app.go:349`**:
  ```go
  // 変更前: fmt.Println("UpdateNoteOrder called")
  // 変更後:
  a.logger.Console("UpdateNoteOrder called")
  ```

  **5d. `drive_operations.go:211`**:
  ```go
  // 変更前: fmt.Println("GetFileID done: ", fileName, "id: ", fixedFileId)
  // 変更後: ← driveOperationsImpl はloggerを持たない
  ```
  - `driveOperationsImpl` 構造体を確認して、loggerフィールドがあるか確認する
  - もしloggerがなければ、`fmt.Printf` のまま残す（drive_operationsは低レベル層でlogger注入の範囲外）
  - もしくは単純に削除する（デバッグ用途のみの出力と思われる）
  - **推奨**: この行を削除する。GetFileIDの結果はcallerで使われるため、低レベルの完了ログは不要

  **Must NOT do**:
  - `app_logger.go` 内の `fmt.Println` は変更しない（logger実装内部のconsole出力）
  - drive_operations.go にloggerを注入する（スコープ外、構造的変更が大きすぎる）

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 4箇所の機械的な置換
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential
  - **Blocks**: Task 6
  - **Blocked By**: Task 2

  **References**:

  **Pattern References**:
  - `backend/app.go:121` — `fmt.Println("appDataDir: ", a.appDataDir)` — logger初期化前の位置にある
  - `backend/app.go:127` — `a.logger = NewAppLogger(ctx, false, a.appDataDir)` — logger初期化箇所
  - `backend/app.go:292` — `fmt.Println("SaveNoteList called")` — 単純なデバッグログ
  - `backend/app.go:349` — `fmt.Println("UpdateNoteOrder called")` — 単純なデバッグログ
  - `backend/drive_operations.go:211` — `fmt.Println("GetFileID done: ...")` — 低レベルデバッグログ

  **Acceptance Criteria**:
  - [ ] `app.go` に `fmt.Println` が存在しない
  - [ ] `drive_operations.go:211` の `fmt.Println` が削除されている
  - [ ] `go build ./backend/...` がエラーなくコンパイルされる

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: No fmt.Println in app.go or drive_operations.go
    Tool: Bash
    Preconditions: Task 5 complete
    Steps:
      1. Run: grep -n "fmt.Println" backend/app.go
      2. Assert: no matches found
      3. Run: grep -n "fmt.Println" backend/drive_operations.go
      4. Assert: no matches found
    Expected Result: All fmt.Println removed from target files
    Evidence: grep output captured
  ```

  **Commit**: NO (groups with Task 6)

---

- [ ] 6. 全テストの更新と最終検証、コミット

  **What to do**:

  **6a. `note_service_test.go` の ValidateIntegrity テスト更新**:
  - すべての `ValidateIntegrity()` 呼び出しの戻り値を `(bool, error)` → `(*IntegrityReport, error)` に更新
  - テスト内の `assert.True(t, changed)` → `assert.True(t, report.Changed)` に変更
  - テスト内の `assert.False(t, changed)` → `assert.False(t, report.Changed)` に変更
  - 具体的な更新箇所（note_service_test.go内）:
    - line 612: `changed, err := helper.noteService.ValidateIntegrity()` → `report, err := ...` + `report.Changed`
    - line 637: 同上
    - line 659: 同上
    - line 674: 同上
    - line 700: 同上
    - line 729: 同上
    - line 759: 同上
    - line 814: 同上

  **6b. `drive_service_test.go` の ValidateIntegrity テスト更新**:
  - grep で `ValidateIntegrity` を検索し、同様に更新
  - line 2109: `changed, err := helper.noteService.ValidateIntegrity()` → `report, err := ...`
  - line 2130: 同上

  **6c. IntegrityReport.Summary() のテスト追加**（新規テスト）:
  - `note_service_test.go` に以下のテストを追加:
  ```go
  func TestIntegrityReport_Summary(t *testing.T) {
      // 変更なし
      report := &IntegrityReport{Changed: false}
      assert.Equal(t, "", report.Summary())

      // 孤立ファイル復元のみ
      report = &IntegrityReport{Changed: true, OrphansRestored: 3}
      assert.Contains(t, report.Summary(), "3件復元")
      assert.Contains(t, report.Summary(), "データ整合性チェック")

      // 複合修復
      report = &IntegrityReport{Changed: true, OrphansRestored: 1, StaleRemoved: 2, OrderFixed: 1}
      summary := report.Summary()
      assert.Contains(t, summary, "1件復元")
      assert.Contains(t, summary, "2件除去")
      assert.Contains(t, summary, "表示順序を修正")
  }
  ```

  **6d. 最終テスト実行**:
  - `go test ./backend/... -count=1 -v` で全テストパスを確認

  **6e. wails generate module 実行**:
  - `NewNoteService` のシグネチャ変更はWailsバインディングに影響しない（noteServiceはprivate型）
  - ただし念のため `wails generate module` を実行してバインディングが壊れていないことを確認
  - **注意**: wailsコマンドが利用できない場合はスキップ可（noteServiceは非公開型のためバインディングに影響しない）

  **6f. コミット作成**:
  - メッセージ: `feat(backend): サイレント操作にステータスバー通知を追加`
  - ファイル:
    - `backend/domain.go`
    - `backend/note_service.go`
    - `backend/app.go`
    - `backend/drive_service.go`
    - `backend/drive_operations.go`
    - `backend/note_service_test.go`
    - `backend/drive_service_test.go`

  **Must NOT do**:
  - テストのロジック（アサーション内容）を変更しない（型変更への対応のみ）
  - 新しいテストケースを既存テストの意図を変えるような形で追加しない

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 複数テストファイルの更新、新規テスト追加、最終検証
  - **Skills**: [`git-master`]
    - `git-master`: コミット作成に必須

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential (final task)
  - **Blocks**: None
  - **Blocked By**: Task 1, 2, 3, 4, 5

  **References**:

  **Pattern References**:
  - `backend/note_service_test.go:612-849` — ValidateIntegrity系テスト群。すべて `changed` → `report.Changed` に変更
  - `backend/drive_service_test.go:2089-2198` — M-7テスト群。同様の変更
  - `backend/note_service_test.go:54-78` — setupNoteTest（Task 2で更新済み）

  **Test References**:
  - `backend/domain_test.go` — SyncResult.Summary()のテストがあれば参考パターン。なければ `note_service_test.go` のテスト構造を参考

  **Acceptance Criteria**:
  - [ ] `go test ./backend/... -count=1` が全パス（0 failures）
  - [ ] `go vet ./backend/...` がwarningなし
  - [ ] `IntegrityReport.Summary()` のテストが追加されている
  - [ ] すべてのValidateIntegrityテストが新しい戻り値型に対応している
  - [ ] gitコミットが作成されている

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: All Go tests pass
    Tool: Bash
    Preconditions: All tasks 1-6 complete
    Steps:
      1. Run: cd backend && go test ./... -count=1 -v
      2. Assert: exit code is 0
      3. Assert: output contains "PASS" for each test package
      4. Assert: no "FAIL" in output
      5. Count: total test cases run (should be >= existing count)
    Expected Result: All tests pass, including new IntegrityReport test
    Evidence: Full test output captured

  Scenario: No fmt.Println remains in non-logger backend files
    Tool: Bash
    Preconditions: All tasks complete
    Steps:
      1. Run: grep -rn "fmt.Println" backend/ --include="*.go" | grep -v app_logger.go | grep -v _test.go
      2. Assert: no matches found (only app_logger.go should have fmt.Println)
    Expected Result: All fmt.Println removed from production code (except logger implementation)
    Evidence: grep output captured

  Scenario: Go vet passes
    Tool: Bash
    Preconditions: All tasks complete
    Steps:
      1. Run: cd backend && go vet ./...
      2. Assert: exit code is 0
    Expected Result: No vet issues
    Evidence: vet output captured
  ```

  **Commit**: YES
  - Message: `feat(backend): サイレント操作にステータスバー通知を追加`
  - Files: `backend/domain.go`, `backend/note_service.go`, `backend/app.go`, `backend/drive_service.go`, `backend/drive_operations.go`, `backend/note_service_test.go`, `backend/drive_service_test.go`
  - Pre-commit: `cd backend && go test ./... -count=1`

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 6 | `feat(backend): サイレント操作にステータスバー通知を追加` | domain.go, note_service.go, app.go, drive_service.go, drive_operations.go, note_service_test.go, drive_service_test.go | `go test ./backend/... -count=1` |

---

## Success Criteria

### Verification Commands
```bash
cd backend && go test ./... -count=1        # Expected: all PASS
cd backend && go vet ./...                   # Expected: no issues
cd backend && go build ./...                 # Expected: clean build
grep -rn "fmt.Println" backend/ --include="*.go" | grep -v app_logger.go | grep -v _test.go  # Expected: no matches
```

### Final Checklist
- [ ] All "Must Have" present:
  - [ ] noteServiceにloggerフィールドあり
  - [ ] IntegrityReport構造体がdomain.goにある
  - [ ] ValidateIntegrity()が*IntegrityReportを返す
  - [ ] 日本語通知メッセージが実装されている
  - [ ] 全テストがパスする
- [ ] All "Must NOT Have" absent:
  - [ ] フロントエンド変更なし
  - [ ] ダイアログ/モーダル通知なし
  - [ ] 英語のユーザー向けメッセージなし（Console除く）
  - [ ] 新イベント追加なし
  - [ ] ValidateIntegrityのロジック変更なし
  - [ ] fmt.Println が production code に残っていない（app_logger.go除く）
