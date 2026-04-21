@AGENTS_mobile.md

# AGENTS.md — Monaco Notepad

## プロジェクト概要

Monaco Notepad は、[Wails v2](https://wails.io/) で構築されたデスクトップノートアプリ。Monaco Editor を組み込み、Google Drive 同期機能を持つ。macOS / Windows 対応。

- **バックエンド**: Go + Wails v2
- **フロントエンド**: React + TypeScript + Vite + MUI
- **エディタ**: Monaco Editor
- **同期**: Google Drive API v3（OAuth2、appDataFolder スコープ）
- **テスト**: Go `testing` + `testify` / Vitest + React Testing Library
- **リンター/フォーマッター**: Biome（フロントエンド）、gofmt（バックエンド）
- **国際化**: i18next（フロントエンド）、OS ネイティブ API（バックエンド）

---

## アーキテクチャ

```
┌─────────────────────────────────────────────────────┐
│  Frontend (React + TypeScript)                       │
│  ├── App.tsx (ルート)                                │
│  ├── components/ (UI部品)                            │
│  ├── hooks/ (ビジネスロジック)                        │
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
│  ├── app.go           (Wails公開メソッド=エントリ)     │
│  ├── domain.go        (全データ構造定義 + MessageCode) │
│  ├── note_service     (ノートCRUD + 整合性チェック)    │
│  ├── drive_service    (Drive同期オーケストレーション)   │
│  ├── drive_sync_service (中レベル同期ロジック)         │
│  ├── drive_migration  (ストレージ移行ロジック)         │
│  ├── drive_operations (Drive低レベルAPI + ページング)   │
│  ├── drive_operations_queue (非同期キュー)             │
│  ├── drive_polling    (指数バックオフ付きポーリング)    │
│  ├── sync_state       (同期状態の永続化 - dirtyフラグ) │
│  ├── auth_service     (OAuth2認証フロー)               │
│  ├── settings_service (設定永続化)                     │
│  ├── file_service     (ファイルダイアログ・I/O)        │
│  ├── file_note_service (ファイルノート管理)            │
│  ├── recent_files_service (最近のファイル管理)         │
│  ├── updater          (アプリ自動更新)                 │
│  ├── locale           (OS言語検出・ネイティブメニュー) │
│  ├── window_bounds    (ウィンドウ位置追跡)             │
│  └── migration/       (noteList v1→v2マイグレーション) │
└─────────────────────────────────────────────────────┘
```

### 通信パターン

| 方向                  | 仕組み                           | 例                                  |
| --------------------- | -------------------------------- | ----------------------------------- |
| Frontend → Backend    | Wails バインディング関数呼び出し | `SaveNote()`, `ListNotes()`         |
| Backend → Frontend    | `wailsRuntime.EventsEmit()`      | `drive:status`, `notes:reload`      |
| Frontend イベント受信 | `runtime.EventsOn()`             | `notes:reload` でノートリスト再取得 |

---

## テスト

### バックエンド (Go)

```bash
cd backend && go test ./...
```

- `testify` の `assert`, `require` を使用
- `isTestMode: true` で Wails EventsEmit を無効化してテスト

### フロントエンド (Vitest)

```bash
cd frontend && npx vitest run
```

---

## ビルド

```bash
wails dev          # ホットリロード付き開発サーバー
./build_mac.sh     # macOS 本番ビルド
./build.ps1        # Windows 本番ビルド (PowerShell)
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
- **状態管理**: エディタ設定（`Settings`）は Zustand ストア（`useEditorSettingsStore`）で管理。それ以外の状態は `App.tsx` から props で各コンポーネントへ渡す。
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
macOS ではウィンドウを閉じてもアプリを終了させない挙動を `mac_window_close_patch_darwin.go` で実装。`DestroyApp()` 呼び出し時のみ完全に終了する。

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

### 新しい Wails イベントの追加
- Backend → Frontend: `wailsRuntime.EventsEmit(ctx, "event:name", data)` (Go側)
- Frontend 受信: `runtime.EventsOn("event:name", handler)` (React側)
- cleanup 忘れずに: `runtime.EventsOff("event:name")` を useEffect の return で呼ぶ
