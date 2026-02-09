# AGENTS.md — Monaco Notepad

## プロジェクト概要

Monaco Notepad は、[Wails v2](https://wails.io/) で構築されたデスクトップノートアプリ。Monaco Editor を組み込み、Google Drive 同期機能を持つ。macOS / Windows 対応。

- **バックエンド**: Go 1.22 + Wails v2.11
- **フロントエンド**: React 19 + TypeScript + Vite + MUI v7
- **エディタ**: Monaco Editor（VSCode と同じエンジン）
- **同期**: Google Drive API v3（OAuth2 認証）
- **テスト**: Go標準 `testing` + `testify` / Vitest + React Testing Library
- **リンター/フォーマッター**: Biome（フロントエンド）、gofmt（バックエンド）

---

## アーキテクチャ

```
┌─────────────────────────────────────────────────────┐
│  Frontend (React + TypeScript)                       │
│  ├── App.tsx (ルート)                                │
│  ├── components/ (UI部品)                            │
│  ├── hooks/ (ビジネスロジック)                        │
│  ├── lib/ (Monaco, Theme設定)                        │
│  └── utils/ (ユーティリティ)                          │
├─────────────── Wails Bindings ──────────────────────┤
│  wailsjs/go/backend/App.ts  ← 自動生成バインディング   │
│  wailsjs/runtime/           ← Wailsランタイム API     │
├─────────────── Events (双方向) ─────────────────────┤
│  drive:status, notes:reload, note:updated,           │
│  app:beforeclose, file:open-external, logMessage     │
├─────────────────────────────────────────────────────┤
│  Backend (Go)                                        │
│  ├── app.go        (Wails公開メソッド=エントリ)        │
│  ├── domain.go     (全データ構造定義)                  │
│  ├── note_service  (ノートCRUD + ローカルファイルI/O)  │
│  ├── drive_service (Drive同期オーケストレーション)      │
│  ├── auth_service  (OAuth2認証フロー)                 │
│  ├── drive_polling (ポーリング + Changes API)         │
│  ├── drive_operations_queue (非同期キュー)             │
│  ├── settings_service (設定永続化)                    │
│  ├── file_note_service (外部ファイル操作)              │
│  └── app_logger    (ログ + フロントエンド通知)         │
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
│   ├── domain.go            # 全ドメイン型 (Note, NoteList, Settings, DriveSync等)
│   ├── app.go               # Wails公開メソッド (フロントエンドから呼べるAPI)
│   ├── app_logger.go        # ログ + EventsEmit
│   ├── note_service.go      # ノートCRUD・ファイルI/O・noteList.json管理
│   ├── auth_service.go      # OAuth2認証 (ブラウザ認証, トークン保存/更新)
│   ├── drive_service.go     # Drive同期オーケストレーション
│   ├── drive_polling.go     # Changes APIベースのポーリング (指数バックオフ)
│   ├── drive_operations_queue.go  # Drive操作の非同期キュー
│   ├── drive_ops.go         # Drive低レベル操作 (API呼出し)
│   ├── drive_sync_impl.go   # 同期ロジック実装
│   ├── settings_service.go  # settings.json 永続化
│   ├── file_note_service.go # 外部ファイル操作 (Open/Save/FileNotes管理)
│   └── *_test.go            # テストファイル
│
├── frontend/                # React フロントエンド
│   ├── package.json
│   ├── vite.config.ts
│   ├── vitest.config.ts
│   ├── tsconfig.json
│   ├── biome.json           # Biome リンター/フォーマッター設定
│   └── src/
│       ├── main.tsx          # Reactエントリポイント
│       ├── App.tsx           # ルートコンポーネント (全hookの統合)
│       ├── types.ts          # TypeScript型定義 (Note, FileNote, Settings等)
│       ├── components/
│       │   ├── AppBar.tsx              # ツールバー (タイトル編集, 言語選択, Drive同期)
│       │   ├── Editor.tsx              # Monaco Editor ラッパー
│       │   ├── NoteList.tsx            # サイドバーノート一覧 (DnD並替)
│       │   ├── ArchivedNoteList.tsx    # アーカイブ一覧
│       │   ├── EditorStatusBar.tsx     # ステータスバー
│       │   ├── SettingsDialog.tsx      # 設定ダイアログ
│       │   ├── MessageDialog.tsx       # 汎用メッセージダイアログ
│       │   ├── NotePreviewPopper.tsx   # ノートプレビューポップアップ
│       │   ├── LightDarkSwitch.tsx     # テーマ切替
│       │   ├── VersionUp.tsx           # バージョンアップ通知
│       │   ├── Icons.tsx               # カスタムアイコン
│       │   └── __tests__/             # コンポーネントテスト
│       ├── hooks/
│       │   ├── useNotes.ts             # ノートの状態管理 (CRUD, アーカイブ, フォルダ)
│       │   ├── useInitialize.ts        # アプリ初期化・キーボードショートカット
│       │   ├── useDriveSync.ts         # Drive同期状態管理
│       │   ├── useEditorSettings.ts    # エディタ設定 (永続化含む)
│       │   ├── useFileOperations.ts    # 外部ファイル操作
│       │   ├── useMessageDialog.ts     # ダイアログ状態管理
│       │   └── __test__/              # hookテスト
│       ├── lib/
│       │   ├── monaco.ts              # Monaco Editor 初期化・言語マッピング
│       │   └── theme.ts               # MUI テーマ定義
│       └── utils/
│           ├── fileUtils.ts           # バイナリファイル判定
│           └── dayjs.ts               # dayjs設定
│
└── wailsjs/                 # Wails自動生成 (手動編集禁止)
    ├── go/backend/App.ts    # Goメソッドのバインディング
    ├── go/models.ts         # Go構造体のTS型
    └── runtime/             # Wailsランタイム API
```

---

## バックエンド詳細

### domain.go — データモデル

全てのデータ構造がここに集約されている。**新しい型は必ずここに追加する。**

| 型             | 用途                                                           |
| -------------- | -------------------------------------------------------------- |
| `App`          | メイン構造体。全サービスを保持                                 |
| `Note`         | ノート本体 (ID, Title, Content, Language, Archived, FolderID)  |
| `NoteMetadata` | ノートリスト用の軽量メタ (ContentHashで変更検知)               |
| `NoteList`     | noteList.json の構造 (Notes, Folders, TopLevelOrder, LastSync) |
| `Folder`       | フォルダ (ID, Name, Archived)                                  |
| `TopLevelItem` | 表示順序管理 (Type: "note"/"folder", ID)                       |
| `Settings`     | エディタ設定 (フォント, テーマ, ウィンドウ位置等)              |
| `DriveSync`    | Drive接続状態 (service, token, folderIDs, mutex)               |
| `WailsConfig`  | wails.json パース用                                            |

### app.go — Wails公開メソッド (フロントエンドAPI)

`App` 構造体のパブリックメソッドが自動的にフロントエンドから呼び出し可能になる。

主要なバインディング:

- `ListNotes()`, `SaveNote()`, `DeleteNote()`, `LoadArchivedNote()`
- `CreateFolder()`, `RenameFolder()`, `DeleteFolder()`, `MoveNoteToFolder()`
- `ArchiveFolder()`, `UnarchiveFolder()`, `DeleteArchivedFolder()`
- `GetTopLevelOrder()`, `UpdateTopLevelOrder()`
- `AuthorizeDrive()`, `LogoutDrive()`, `CheckDriveConnection()`, `SyncNow()`
- `LoadSettings()`, `SaveSettings()`
- `OpenFile()`, `SaveFile()`, `SelectFile()`, `SelectSaveFileUri()`
- `NotifyFrontendReady()`, `DestroyApp()`

### サービス層パターン

各サービスは**インターフェース + 実装構造体**で定義:

```go
type NoteService interface { ... }     // note_service.go
type AuthService interface { ... }     // auth_service.go
type DriveService interface { ... }    // drive_service.go
type AppLogger interface { ... }       // app_logger.go
```

- サービスは `New*Service()` ファクトリ関数で作成
- `App` 構造体が全サービスを DI 的に保持
- テスト時は `isTestMode` フラグで EventsEmit を無効化

### Google Drive同期

1. **認証フロー** (`auth_service.go`): ローカルHTTPサーバー(`:34115`)でOAuth2コールバック受信
2. **ポーリング** (`drive_polling.go`): Changes API使用、指数バックオフ (20秒→最大3分)
3. **操作キュー** (`drive_operations_queue.go`): CREATE/UPDATE/DELETE/DOWNLOAD を非同期キューイング
4. **同期判定**: `NoteMetadata.ContentHash` (SHA-256) と `ModifiedTime` で変更検知

### データ永続化

| データ         | 場所                                    | 形式                |
| -------------- | --------------------------------------- | ------------------- |
| 各ノート       | `{notesDir}/{id}.json`                  | JSON                |
| ノートリスト   | `{appDataDir}/noteList.json`            | JSON (NoteList)     |
| 設定           | `{appDataDir}/settings.json`            | JSON (Settings)     |
| OAuthトークン  | `{appDataDir}/token.json`               | JSON (oauth2.Token) |
| Google認証情報 | `{appDataDir}/credentials.json`         | JSON                |
| ファイルノート | `{appDataDir}/fileNotes.json`           | JSON                |
| ログ           | `{appDataDir}/logs/app_{timestamp}.log` | テキスト            |

---

## フロントエンド詳細

### コンポーネント設計

App.tsx がルートで、全hookを統合して子コンポーネントにpropsで渡す。**Context/Storeは未使用、props drilling パターン。**

```
App.tsx
├── AppBar (タイトル, 言語選択, Drive状態, ファイル操作ボタン)
├── NoteList (サイドバー: ノート一覧, フォルダ, DnD並替)
├── Editor (Monaco Editor本体)
├── ArchivedNoteList (アーカイブ表示)
├── EditorStatusBar (行数, 言語, Drive同期ログ)
├── SettingsDialog (設定画面)
├── MessageDialog (確認ダイアログ)
└── VersionUp (バージョンアップ通知)
```

### Hook設計

| Hook                | 責務                                                          |
| ------------------- | ------------------------------------------------------------- |
| `useNotes`          | ノートCRUD, アーカイブ, フォルダ操作, 自動保存(3秒デバウンス) |
| `useInitialize`     | 初期データロード, キーボードショートカット登録                |
| `useDriveSync`      | Drive同期状態 (synced/syncing/offline), 認証/ログアウト       |
| `useEditorSettings` | 設定の読込/保存, ウィンドウ位置復元                           |
| `useFileOperations` | 外部ファイル Open/Save/SaveAs/DnD/CloseFile                   |
| `useMessageDialog`  | Promise ベースのダイアログ表示                                |

### Monaco Editor 統合 (`lib/monaco.ts`)

- **シングルトン**: `getOrCreateEditor()` / `disposeEditor()` で1インスタンス管理
- **モデル管理**: ノートごとに `inmemory://{id}` URI でモデル作成、タブ切替時にモデル差し替え
- **言語マッピング**: 拡張子→言語のマッピング定義あり (`getLanguageByExtension()`)
- **Worker**: Vite の `?worker` インポートで Monaco の Web Worker を設定

### UIライブラリ

- **MUI (Material UI) v6**: Box, Button, Dialog, TextField, Select, IconButton 等
- **@dnd-kit**: ノート一覧の並べ替え (SortableContext, DragOverlay)
- **simplebar-react**: カスタムスクロールバー
- **dayjs**: 日付フォーマット

### スタイリング

MUI の `sx` prop と `useTheme()` でインラインスタイリング。グローバルCSSは最小限。ダーク/ライトは MUI テーマ切替 + Monaco の `vs`/`vs-dark` テーマ。

### キーボードショートカット

| ショートカット         | 機能                              |
| ---------------------- | --------------------------------- |
| Ctrl/Cmd + N           | 新規ノート                        |
| Ctrl/Cmd + O           | ファイルを開く                    |
| Ctrl/Cmd + S           | ファイル保存                      |
| Ctrl/Cmd + Alt + S     | 名前を付けて保存                  |
| Ctrl/Cmd + W           | ファイル閉じる / ノートアーカイブ |
| Ctrl/Cmd + Tab         | 次のノートへ                      |
| Ctrl/Cmd + Shift + Tab | 前のノートへ                      |

---

## テスト

### バックエンド (Go)

```bash
cd backend && go test ./...
```

テストファイル: `app_test.go`, `note_service_test.go`, `drive_service_test.go`, `drive_operations_queue_test.go`, `domain_test.go`, `file_note_service_test.go`

- `testify` の `assert`, `require` を使用
- `isTestMode: true` で Wails EventsEmit を無効化してテスト

### フロントエンド (Vitest)

```bash
cd frontend && npx vitest run
```

テストファイル:

- `components/__tests__/`: App, AppBar, ArchivedNoteList, Editor, NoteList, etc.
- `hooks/__test__/`: useNotes, useDriveSync, useEditorSettings, useFileOperations, etc.

- `vitest` + `@testing-library/react`
- Monaco Editor はモック (`test/setup.ts` で `vi.mock`)
- Wails バインディングもモック

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

ビルドスクリプトは `wails.json` からバージョン情報を読み、ビルド成果物を `build/bin/` に出力。

### フロントエンド単体

```bash
cd frontend
npm install
npm run dev      # Vite dev server
npm run build    # 本番ビルド
npm run check    # Biome lint + format check
```

---

## コーディング規約

### Go

- **パッケージ**: 全バックエンドコードは `package backend` (単一パッケージ)
- **コメント**: 日本語 (`// ノート関連のローカル操作を提供するインターフェース`)
- **命名**: Go 標準 (CamelCase公開, camelCase非公開)
- **エラー処理**: `fmt.Errorf` でラップ、`logger.Error()` でログ+通知
- **ファクトリ**: `New*Service()` 関数パターン
- **テストモード**: `isTestMode` フラグでWailsランタイム呼出しを回避

### TypeScript / React

- **Biome** でlint + format (`biome.json` 設定)
- **命名**: コンポーネントは PascalCase (`NoteList.tsx`)、hookは `use` プレフィックス
- **型定義**: `types.ts` に集約。Wails自動生成型は `wailsjs/go/models.ts`
- **Hook パターン**: ビジネスロジックはカスタムhookに分離、コンポーネントはUI専念
- **Wails バインディング**: `wailsjs/go/backend/App` からインポート
- **イベント**: `wailsjs/runtime` の `EventsOn` / `EventsOff` / `EventsEmit`
- **インデント**: タブ

### 共通

- コミットメッセージ: `feat(scope): description` / `fix(scope): description` / `refactor:` / `style:` / `test:` / `perf:` — Conventional Commits
- ブランチ: `main` がデフォルト、機能ブランチは説明的な名前 (`FolderFunction`, `Add-file-mode`)

---

## 重要な注意事項

### wailsjs/ は自動生成

`wailsjs/` ディレクトリ配下は `wails dev` / `wails build` 時に自動生成される。**手動編集禁止。** Go の `App` 構造体にパブリックメソッドを追加すると、自動でバインディングが生成される。

### ノートのデータフロー

1. ノート作成/変更 → `useNotes` で React state 更新 → `SaveNote()` でバックエンドへ
2. バックエンド: ノートJSON保存 → noteList.json 更新 → (Drive接続時) operationsQueue 経由でアップロード
3. Drive変更検知 → `SyncNotes()` → noteList.json更新 → `EventsEmit("notes:reload")` → フロントエンド再取得

### フォルダ・並べ替え

- `TopLevelOrder` (noteList.json) でサイドバーの表示順を管理
- フォルダ内のノートは `NoteMetadata.FolderID` で紐付け
- DnD は `@dnd-kit` で実装 (`NoteList.tsx`)

### 自動保存

- エディタ変更後3秒デバウンスで自動保存 (`useNotes.ts`)
- アプリ終了時 (`app:beforeclose`) に未保存ノートを保存
- ウィンドウのサイズ/位置変更時に設定保存 (`useEditorSettings.ts`)

### Google Drive認証ポート

OAuth2コールバック用に `:34115` を使用。固定ポートのため競合注意。

---

## 機能追加ガイド

### 新しいバックエンドAPIの追加

1. `domain.go` に必要なデータ型を定義
2. 適切なサービスファイルにロジック実装
3. `app.go` の `App` 構造体にパブリックメソッドを追加 (→ Wails自動バインディング)
4. `wails dev` で再ビルド → `wailsjs/` が自動更新
5. フロントエンドから `wailsjs/go/backend/App` のインポートで呼び出し
6. テスト追加 (`*_test.go`)

### 新しいUI機能の追加

1. `types.ts` に必要な型定義追加
2. 複雑なロジックはカスタムhookに分離 (`hooks/use*.ts`)
3. UIコンポーネントを `components/` に作成
4. `App.tsx` でhookを統合、propsとして子コンポーネントに渡す
5. テスト追加 (`__tests__/` or `__test__/`)

### 新しい Wails イベントの追加

- Backend → Frontend: `wailsRuntime.EventsEmit(ctx, "event:name", data)` (Go側)
- Frontend 受信: `runtime.EventsOn("event:name", handler)` (React側)
- cleanup 忘れずに: `runtime.EventsOff("event:name")` を useEffect の return で呼ぶ
