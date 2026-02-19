# AGENTS.md — Monaco Notepad

## プロジェクト概要

Monaco Notepad は、[Wails v2](https://wails.io/) で構築されたデスクトップノートアプリ。Monaco Editor を組み込み、Google Drive 同期機能を持つ。macOS / Windows 対応。

- **バックエンド**: Go 1.22 + Wails v2.11
- **フロントエンド**: React 19 + TypeScript + Vite + MUI v7
- **エディタ**: Monaco Editor（VSCode と同じエンジン）
- **同期**: Google Drive API v3（OAuth2 認証、appDataFolder スコープ）
- **テスト**: Go標準 `testing` + `testify` / Vitest + React Testing Library
- **リンター/フォーマッター**: Biome（フロントエンド）、gofmt（バックエンド）
- **国際化**: i18next（フロントエンド）、OS ネイティブ API（バックエンド）

---

## アーキテクチャ

```
┌─────────────────────────────────────────────────────┐
│  Frontend (React + TypeScript)                       │
│  ├── App.tsx (ルート)                                │
│  ├── components/ (UI部品 - Search, Preview, i18n)     │
│  ├── hooks/ (ビジネスロジック - Sync, Search, Split)  │
│  ├── lib/ (Monaco, Theme設定)                        │
│  ├── themes/ (カスタムMonacoテーマ群)                 │
│  ├── i18n/ (i18nextリソース)                         │
│  └── utils/ (ユーティリティ)                          │
├─────────────── Wails Bindings ──────────────────────┤
│  wailsjs/go/backend/App.ts  ← 自動生成バインディング   │
│  wailsjs/runtime/           ← Wailsランタイム API     │
├─────────────── Events (双方向) ─────────────────────┤
│  drive:status, drive:migration-needed,               │
│  notes:reload, notes:updated, integrity:issues,      │
│  backend:ready, logMessage, app:beforeclose          │
├─────────────────────────────────────────────────────┤
│  Backend (Go)                                        │
│  ├── app.go        (Wails公開メソッド=エントリ)        │
│  ├── domain.go     (全データ構造定義 + MessageCode)    │
│  ├── note_service  (ノートCRUD + 整合性チェック)       │
│  ├── drive_service (Drive同期オーケストレーション)      │
│  ├── drive_sync_service (中レベル同期ロジック)         │
│  ├── drive_migration (ストレージ移行ロジック)          │
│  ├── drive_operations (Drive低レベルAPI + ページング)   │
│  ├── sync_state    (同期状態の永続化 - dirtyフラグ)    │
│  ├── auth_service  (OAuth2認証フロー)                 │
│  ├── drive_polling (指数バックオフ付きポーリング)      │
│  ├── drive_operations_queue (非同期キュー)             │
│  ├── settings_service (設定永続化)                    │
│  ├── file_service  (ファイルダイアログ・I/O)           │
│  ├── locale        (OS言語検出・ネイティブメニュー)    │
│  └── migration/    (noteList v1→v2マイグレーション)    │
└─────────────────────────────────────────────────────┘
```

### 通信パターン

| 方向                  | 仕組み                           | 例                                  |
| --------------------- | -------------------------------- | ----------------------------------- |
| Frontend → Backend    | Wails バインディング関数呼び出し | `SaveNote()`, `ListNotes()`         |
| Backend → Frontend    | `wailsRuntime.EventsEmit()`      | `drive:status`, `notes:reload`      |
| Frontend イベント受信 | `runtime.EventsOn()`             | `notes:reload` でノートリスト再取得 |

---

## ディレクトリ構造

```
monaco-notepad/
├── main.go                  # Wails アプリエントリポイント
├── wails.json               # Wails設定 (アプリ名, バージョン, ビルド設定)
├── go.mod / go.sum          # Goモジュール定義
├── build/                   # ビルド成果物・アイコン
├── build_mac.sh             # macOS ビルドスクリプト
├── build.ps1                # Windows ビルドスクリプト (PowerShell)
│
├── backend/                 # Go バックエンド
│   ├── domain.go            # 全ドメイン型, MessageCode, 整合性関連型
│   ├── app.go               # Wails公開メソッド, ライフサイクル管理
│   ├── app_logger.go        # ログ + EventsEmit (多言語対応)
│   ├── note_service.go      # ノートCRUD, 整合性チェック, 孤立ファイル復元
│   ├── drive_service.go     # Drive同期統合, 移行ハンドリング
│   ├── drive_sync_service.go # 同期詳細ロジック (push/pull/conflict)
│   ├── drive_migration.go   # appDataFolder移行, 孤立ファイル検出
│   ├── drive_operations.go  # Drive API (Page対応), MD5チェック
│   ├── sync_state.go        # dirtyフラグ管理 (sync_state.json)
│   ├── auth_service.go      # OAuth2認証 (ブラウザ認証, トークン管理)
│   ├── drive_polling.go     # Changes APIポーリング (5s〜1m/3m)
│   ├── drive_operations_queue.go # 非同期操作キュー
│   ├── settings_service.go  # settings.json 永続化, ウィンドウ状態
│   ├── file_service.go      # OSファイルダイアログ, ファイルI/O
│   ├── file_note_service.go # ファイルノート管理 (fileNotes.json)
│   ├── locale.go            # システム言語検出, 正規化
│   ├── native_menu_localization.go # macOSネイティブメニュー翻訳
│   ├── mac_window_close_patch.go # macOS用ウィンドウクローズ回避
│   ├── migration/           # noteList.json v1→v2変換ロジック
│   └── *_test.go            # テストファイル
│
├── frontend/                # React フロントエンド
│   ├── src/
│   │   ├── App.tsx           # ルート (hook統合, ダイアログ管理)
│   │   ├── components/
│   │   │   ├── NoteSearchBox.tsx     # 全文検索UI
│   │   │   ├── MarkdownPreview.tsx   # Markdownプレビュー (GFM)
│   │   │   ├── MigrationDialog.tsx   # Drive移行ダイアログ
│   │   │   ├── ArchivedNoteContentDialog.tsx # アーカイブ表示
│   │   │   ├── PaneHeader.tsx        # スプリットペインヘッダー
│   │   │   └── ... (AppBar, Editor, NoteList等)
│   │   ├── hooks/
│   │   │   ├── useNoteSearch.ts      # 検索ロジック (複数ワード対応)
│   │   │   ├── useSplitEditor.ts     # 2画面分割管理
│   │   │   ├── usePaneSizes.ts       # ペインリサイズ管理
│   │   │   ├── useFileNotes.ts       # 外部ファイル管理
│   │   │   └── ... (useNotes, useDriveSync等)
│   │   ├── i18n/
│   │   │   └── locales/              # ja.json, en.json リソース
│   │   ├── themes/                   # Monaco カスタムテーマ (.json)
│   │   └── ...
│   └── ...
└── wailsjs/                 # Wails自動生成 (手動編集禁止)
```

---

## バックエンド詳細

### domain.go — データモデル

全てのデータ構造がここに集約されている。

| 型                       | 用途                                                             |
| ------------------------ | ---------------------------------------------------------------- |
| `App`                    | メイン構造体。全サービスと `SyncState` を保持                    |
| `Note` / `NoteMetadata`  | ノート本体 / メタデータ (ContentHash, ModifiedTime)              |
| `NoteList`               | 表示順, フォルダ, 展開状態, アーカイブ順を管理 (v2)              |
| `Settings`               | エディタ設定, UI言語, ペインサイズ, 競合バックアップ設定         |
| `SyncState`              | dirtyフラグ (Note/Folder), 最終同期トークン, MD5キャッシュ       |
| `IntegrityIssue`         | 整合性チェックで見つかった問題 (Kind, Severity)                  |
| `IntegrityFixOption`     | 問題に対する修復の選択肢 (Label, Description)                    |
| `MessageCode`            | フロントエンド側で翻訳するためのメッセージコードと引数           |
| `Context`                | `skipBeforeClose` フラグを持つ context ラッパー                  |

### app.go — Wails公開メソッド (フロントエンドAPI)

主要な新規・更新バインディング:

- `LoadNote(id)`, `SaveNoteList()`, `ApplyIntegrityFixes(selections)`
- `GetArchivedTopLevelOrder()`, `UpdateArchivedTopLevelOrder()`
- `GetCollapsedFolderIDs()`, `UpdateCollapsedFolderIDs()`
- `RespondToMigration(choice)` — "migrate_delete" / "migrate_keep" / "skip"
- `LoadFileNotes()`, `SaveFileNotes()`
- `GetModifiedTime()`, `CheckFileModified()`, `CheckFileExists()`
- `OpenAppFolder()`, `OpenConflictBackupFolder()`, `OpenURL()`
- `GetSystemLocale()`, `GetAppVersion()`, `BringToFront()`

### サービス層パターン

各サービスは**インターフェース + 実装構造体**で定義:

```go
type NoteService interface { ... }     // note_service.go
type AuthService interface { ... }     // auth_service.go
type DriveService interface { ... }    // drive_service.go
type AppLogger interface { ... }       // app_logger.go
```

### Google Drive同期 (v2)

1. **ストレージ移行** (`drive_migration.go`): 従来のルート直下から `appDataFolder` へ移行。孤立ノートの復元機能。
2. **同期判定** (`sync_state.go`): `SyncState` による dirty フラグ方式。不要なフルスキャンを回避。
3. **同期詳細** (`drive_sync_service.go`):
   - `pushLocalChanges`: ローカルの dirty 変更をアップロード。
   - `pullCloudChanges`: クラウドの変更をダウンロード。MD5比較で不要な転送を抑制。
   - `resolveConflict`: クラウド優先/ローカル優先を ModifiedTime で判定。クラウド優先時はローカルを `cloud_conflict_backups/` に保存。
4. **リトライとページング**:
   - `uploadRetryConfig`: 最大4回 (2s〜20s)
   - `downloadRetryConfig`: 最大5回 (2s〜30s)
   - `drive_operations.go`: 100件を超えるファイル/変更リストのページネーション対応。

### データ永続化

| データ                 | 場所                                    | 形式                |
| ---------------------- | --------------------------------------- | ------------------- |
| ノートリスト (v2)      | `{appDataDir}/noteList_v2.json`         | JSON (NoteList)     |
| 同期状態               | `{appDataDir}/sync_state.json`          | JSON (SyncState)    |
| 設定                   | `{appDataDir}/settings.json`            | JSON (Settings)     |
| ファイルノート         | `{appDataDir}/fileNotes.json`           | JSON                |
| 競合バックアップ       | `{appDataDir}/cloud_conflict_backups/`  | JSON (最大100件)    |
| マイグレーション状態   | `{appDataDir}/drive_storage_migration.json` | JSON            |

---

## フロントエンド詳細

### コンポーネント設計 (拡張)

- **2画面分割 (Split Mode)**: `useSplitEditor` で左右のペイン状態を管理。`PaneHeader` で切替。
- **全文検索**: `NoteSearchBox` で全ノート/外部ファイルを検索。ハイライトナビゲーション対応。
- **Markdownプレビュー**: `MarkdownPreview` を左右いずれかのペイン、または専用パネルで表示。
- **整合性修復**: `integrity:issues` イベント受信時に `MessageDialog` でユーザーに修復案を提示。

### Hook設計 (新規)

| Hook                | 責務                                                          |
| ------------------- | ------------------------------------------------------------- |
| `useNoteSearch`     | 全文検索ロジック。キャッシュによる高速化、マッチ箇所抽出       |
| `useSplitEditor`    | 左右ペインのノート/ファイル選択状態、プレビュー連動           |
| `useFileNotes`      | 最近開いたローカルファイルのパス・内容・変更検知管理           |
| `usePaneSizes`      | サイドバー、スプリットペイン、プレビューペインのサイズ永続化   |
| `useNoteSelecter`   | 複雑化したノート選択状態の単一ソース化                        |

### Monaco Editor 統合 (`lib/monaco.ts`)

- **シングルトン**: `getOrCreateEditor()` / `disposeEditor()` で1インスタンス管理。
- **モデル管理**: ノートごとに `inmemory://{id}` URI でモデル作成、タブ切替時にモデル差し替え。
- **言語マッピング**: 拡張子→言語のマッピング定義あり (`getLanguageByExtension()`)。

### 国際化 (i18n)

- `frontend/src/i18n/locales/` に `ja.json`, `en.json` を配置。
- バックエンドからの `MessageCode` は `i18next.t(code, args)` で翻訳して表示。
- `UILanguage` 設定 ("system", "ja", "en") に基づき、初期化時に OS 言語を考慮して適用。

---

## テスト

### バックエンド (Go)

```bash
cd backend && go test ./...
```

主要なテストファイル:
- `drive_migration_test.go`: appDataFolderへの移行ロジック。
- `drive_sync_service_test.go`: 競合解決・リトライを含む同期ロジック。
- `drive_sync_notes_test.go`: ノート同期の詳細テスト。
- `drive_service_test.go`: DriveService統合テスト。
- `drive_service_notification_test.go`: Drive通知イベントテスト。
- `drive_operations_queue_test.go`: 非同期キューのテスト。
- `drive_polling_test.go`: ポーリングロジックのテスト。
- `sync_state_test.go`: dirtyフラグの永続化と管理。
- `note_service_test.go`: ノートCRUDと整合性チェック。
- `file_service_test.go`: ファイル操作テスト。
- `file_note_service_test.go`: ファイルノート操作テスト。
- `locale_test.go`: ロケール検出・正規化テスト。
- `domain_test.go`: ドメイン型テスト。
- `app_test.go`: App統合テスト。
- `drive_test_compat_helpers_test.go`: テスト共通ヘルパー。
- `migration/v1_to_v2_test.go`: noteList v1→v2変換テスト。

テスト実行時の注意:
- `testify` の `assert`, `require` を使用
- `isTestMode: true` で Wails EventsEmit を無効化してテスト

### フロントエンド (Vitest)

```bash
cd frontend && npx vitest run
```

- `components/__tests__/`: 新規追加コンポーネントの表示・操作テスト。
- `hooks/__test__/`: 全文検索・スプリットエディタ等のビジネスロジックテスト。

---

## ビルド

### 開発

```bash
wails dev      # ホットリロード付き開発サーバー
```

### 本番ビルド

```bash
# macOS
./build_mac.sh

# Windows (PowerShell)
./build.ps1
```

---

## コーディング規約

### Go
- **パッケージ**: 全バックエンドコードは `package backend` (単一パッケージ)。`migration/` サブパッケージのみ例外。
- **多言語対応**: 直接文字列を返さず、`domain.go` の `MessageCode` と定数を使用する。
- **エラー処理**: `logger.ErrorCode()` 等を使用して、フロントエンドへ翻訳可能なメッセージを通知する。
- **DI**: `App` 構造体に必要なサービスを注入し、`isTestMode` フラグで環境を切り分ける。
- **ファクトリ**: `New*Service()` 関数パターンでサービスを作成する。
- **コメント**: 日本語コメントを使用する。

### TypeScript / React
- **ビジネスロジックの分離**: コンポーネント内にはUIのみを記述し、ロジックはカスタム hook に集約する。
- **Props Drilling**: 状態管理ライブラリ（Redux/Zustand等）は使用せず、`App.tsx` から props で各コンポーネントへ渡す。
- **Biome**: リンターおよびフォーマッターとして Biome を使用する。
- **型定義**: `types.ts` に集約。Wails自動生成型は `wailsjs/go/models.ts`。
- **インデント**: タブ。
- **命名**: コンポーネントは PascalCase、hookは `use` プレフィックス。

---

## 重要な注意事項

### SyncState による整合性
`sync_state.go` の `Dirty` フラグが立っている場合のみ同期が実行される。操作失敗時は `ClearDirtyIfUnchanged` を通じて安全にリトライが行われる。

### 孤立ファイル復元 (Orphan Recovery)
起動時に `noteList` に登録されていない物理ノートファイルを検知した場合、自動的に「不明ノート」フォルダを作成して登録する。Drive移行時にも同様のチェックを行い、データの紛失を防止する。

### 多言語対応メッセージ
バックエンドからユーザーへの通知は、直接文字列を渡すのではなく `MessageCode` (domain.go) を使用する。
1. `domain.go` に `Msg*` 定数を追加。
2. フロントエンドの `locales/*.json` に翻訳を追加。
3. `app_logger.go` の `InfoCode` / `ErrorCode` 等で呼び出す。

### macOS ウィンドウ制御
macOS ではウィンドウを閉じてもアプリを終了させない挙動を `mac_window_close_patch.go` で実装。`DestroyApp()` 呼び出し時のみ完全に終了する。

---

## 機能追加ガイド

### 新しいバックエンドAPIの追加
1. `domain.go` に必要なデータ型を定義。
2. 適切なサービスファイルにロジック実装。
3. `app.go` にパブリックメソッドを追加。
4. 必要に応じて `SyncState` に dirty フラグを追加し、`MarkDirty()` 等で同期をトリガー。
5. `wails dev` で再ビルド → `wailsjs/` が自動更新。
6. テスト追加 (`*_test.go`)。

### 新しいUIと言語リソースの追加
1. `locales/` の各 JSON にキーを追加。
2. 複雑なロジックはカスタムhookに分離 (`hooks/use*.ts`)。
3. UIコンポーネントを `components/` に作成。
4. `App.tsx` でhookを統合、propsとして子コンポーネントに渡す。
5. コンポーネント内で `useTranslation()` を使用。
6. テスト追加 (`__tests__/` or `__test__/`)。

### 新しいメッセージコードの追加
1. `domain.go` に `Msg*` 定数を追加。
2. フロントエンドの `locales/*.json` に翻訳を追加。
3. `app_logger.go` の `InfoCode` / `ErrorCode` 等で呼び出す。

### 新しい Wails イベントの追加
- Backend → Frontend: `wailsRuntime.EventsEmit(ctx, "event:name", data)` (Go側)
- Frontend 受信: `runtime.EventsOn("event:name", handler)` (React側)
- cleanup 忘れずに: `runtime.EventsOff("event:name")` を useEffect の return で呼ぶ
