@AGENTS_mobile.md

# AGENTS.md — Monaco Notepad

## プロジェクト概要

Monaco Notepad は、[Wails v2](https://wails.io/) で構築されたデスクトップノートアプリ。Monaco Editor を組み込み、Google Drive 同期機能を持つ。macOS / Windows 対応。

- **バックエンド**: Go + Wails v2
- **フロントエンド**: React 19 + TypeScript + Vite + MUI
- **エディタ**: Monaco Editor
- **状態管理**: Zustand（フロントエンド全体）
- **同期**: Google Drive API v3（OAuth2、appDataFolder スコープ）
- **テスト**: Go `testing` + `testify` / Vitest + React Testing Library
- **リンター/フォーマッター**: Biome（フロントエンド）、gofmt（バックエンド）
- **国際化**: i18next（フロントエンド）、OS ネイティブ API（バックエンド）

---

## アーキテクチャ

### Frontend (React + TypeScript)

- `main.tsx` — ルート。Providers / i18n / bridge 登録
- `App.tsx` — オーケストレータ。購読は最小限
- `components/`
  - `Providers.tsx` — Theme / MessageDialog / DialogHost を内包
  - `DialogHost.tsx` — Settings / About / Conflict / Mobile を lazy 配下で常駐
  - `Sidebar` / `EditorArea` / `EditorPane` / `NoteList` / `SearchReplacePanel` ほか
- `stores/` ★ Zustand 中心の state レイヤー
  - `useNotesStore` — ノート / フォルダ / 表示順
  - `useFileNotesStore` — 開いているローカルファイル群
  - `useCurrentNoteStore` — currentNote / currentFileNote
  - `useSplitEditorStore` — 分割表示 / 各ペインのノート
  - `useEditorSettingsStore` — エディタ設定 + Monaco 適用関数
  - `useSearchReplaceStore` — 検索置換の状態 + DI コンテキスト
  - `useSearchHistoryStore` — 検索履歴の永続化（localStorage）
  - `useDialogsStore` — Settings / About 等の開閉
  - `useMessageDialogStore` — showMessage Promise API
- `hooks/` ★ ロジックを集約。多くは action のみ提供（state は store から）
- `lib/` — Monaco / Theme 設定
- `themes/` — カスタム Monaco テーマ群
- `i18n/` — i18next リソース
- `utils/` — ユーティリティ

### Wails Bindings

- `wailsjs/go/backend/App.ts` — 自動生成バインディング
- `wailsjs/runtime/` — Wails ランタイム API

### Events（双方向）

`drive:status` / `drive:migration-needed` / `notes:reload` / `notes:updated` / `integrity:issues` / `backend:ready` / `logMessage` / `app:beforeclose` / `show-message`

### Backend (Go) — `package backend`

- `app.go` — Wails 公開メソッド（エントリ）
- `domain.go` — 全データ構造定義 + MessageCode
- `note_service` — ノート CRUD + 整合性チェック
- `drive_service` — Drive 同期オーケストレーション
- `drive_sync_service` — 中レベル同期ロジック
- `drive_migration` — ストレージ移行ロジック
- `drive_operations` — Drive 低レベル API + ページング
- `drive_operations_queue` — 非同期キュー
- `drive_polling` — 指数バックオフ付きポーリング
- `sync_state` — 同期状態の永続化（dirty フラグ）
- `auth_service` — OAuth2 認証フロー
- `settings_service` — 設定永続化
- `file_service` — ファイルダイアログ・I/O
- `file_note_service` — ファイルノート管理
- `recent_files_service` — 最近のファイル管理
- `updater` — アプリ自動更新
- `locale` — OS 言語検出・ネイティブメニュー
- `window_bounds` — ウィンドウ位置追跡
- `migration/` — noteList v1→v2 マイグレーション（サブパッケージ）

### 通信パターン

| 方向                  | 仕組み                           | 例                                  |
| --------------------- | -------------------------------- | ----------------------------------- |
| Frontend → Backend    | Wails バインディング関数呼び出し | `SaveNote()`, `ListNotes()`         |
| Backend → Frontend    | `wailsRuntime.EventsEmit()`      | `drive:status`, `notes:reload`      |
| Frontend イベント受信 | `runtime.EventsOn()`             | `notes:reload` でノートリスト再取得 |

---

## フロントエンド: state 管理の方針

**最重要原則**: 「真の保持者は Zustand ストア。`App.tsx` は購読しない」。

App.tsx を `notes` / `fileNotes` / `currentNote` 等の値変化で再レンダーさせると、ツリー全体の reconciliation が走り React DevTools で開けないほど重くなる。再描画範囲を最小化するため、共有 state はすべて Zustand ストアに集約し、**末端 consumer（Sidebar / EditorArea / NoteList 等）が必要な slice だけを購読**する形にする。

### ストア一覧

| ストア | 役割 | 購読 hook（末端用） |
| --- | --- | --- |
| `useNotesStore` | `notes` / `folders` / `topLevelOrder` / `archivedTopLevelOrder` / `collapsedFolders` / `showArchived` | `useAllNotes()`, `useFolders()`, `useTopLevelOrder()`, `useArchivedTopLevelOrder()`, `useCollapsedFolders()`, `useShowArchived()`, `useActiveNotesCount()` |
| `useFileNotesStore` | `fileNotes`（開いているローカルファイル群） | `useAllFileNotes()` |
| `useCurrentNoteStore` | `currentNote` / `currentFileNote` / `titleFocusToken` | `useCurrentNote()`, `useCurrentFileNote()`, `useCurrentNoteId()`, `useCurrentFileNoteId()`, `useTitleFocusToken()` |
| `useSplitEditorStore` | `isSplit` / `isMarkdownPreview` / `focusedPane` / `leftNote` / `leftFileNote` / `rightNote` / `rightFileNote` | `useIsSplit()`, `useIsMarkdownPreview()`, `useFocusedPane()`, `useLeftNote()`, `useRightNote()`, `useLeftFileNote()`, `useRightFileNote()`, `useSecondarySelectedNoteId()` |
| `useEditorSettingsStore` | `Settings`（フォント / テーマ / ペインサイズ等） + Monaco レジストリ | 直接 selector で購読（`useEditorSettingsStore((s) => s.settings.isDarkMode)` 等） |
| `useSearchReplaceStore` | 検索/置換 panel の state + DI コンテキスト（`getNotes` / `setNotes` / `getActiveEditor` 等を App から登録） | コンポーネントごとに必要な field だけ selector で取る |
| `useSearchHistoryStore` | 検索履歴（localStorage 永続化、最大 50 件） | `useSearchHistoryStore((s) => s.history)` 等 |
| `useDialogsStore` | Settings / About / Conflict / Mobile ダイアログの開閉 + 復元ハンドラ | `useDialogsStore((s) => s.isSettingsOpen)` 等 |
| `useMessageDialogStore` | 確認/通知ダイアログ。**`showMessage` を非コンポーネント文脈からも import 可能**（top-level `export const showMessage = ...`） | `<MessageDialog />` が直接購読 |

### Hook の役割

state はストア側に出したので、**カスタムフックは「アクション群と副作用の登録」だけを返す**設計に揃っている。

- `useNotes` / `useFileNotes` / `useSplitEditor` … ノート/ファイル/分割の **アクション**（`handleSelectNote`, `handleArchiveNote` など）と Wails イベント購読を提供。state は store の `getState()` / subscribe で読む。
- `useEditorSettings` … 起動時に `LoadSettings` するだけ。設定値の読み出しは `useEditorSettingsStore` から直接。
- `usePaneSizes` … ペインサイズはローカル `useState`（ドラッグ追従用）+ debounced save。初期値は `useEditorSettingsStore.getState().settings` から取得。
- `useFileOperations` / `useNoteSelecter` / `useRecentFiles` / `useNoteSearch` … いずれも store を `getState()` で都度読み、必要な末端だけ selector hook で購読する。
- `useInitialize` … 起動時のマイグレーション・最初のノート選択など、副作用を集約。
- `useMessageDialog` は薄いラッパで、`useMessageDialogStore` の `showMessage` をフック API として提供しているだけ（既存呼び出し互換のため残置）。

### App.tsx で守るべきこと

1. **store を「state として」購読しない**。書き込み action（参照不変）だけ取得する。
   - 例外: `isDarkMode` のように極めて narrow なセレクタを 1 つだけ取る場合や、`useNotes` などフック自身が他フックに渡す action を返す場合。
2. **ハンドラ内では必ず `useStore.getState()` で都度読む**。クロージャに store の値を閉じ込めない。
3. **派生計算（`canSplit` / `orderedAvailableNotes` 等）は consumer 側で行う**。App でやると notes/fileNotes 変化で App が再レンダーする。
4. **モジュールレベル関数で `getState()` をラップする**と、`useCallback` の依存配列が安定する。
   ```ts
   const getIsSplit = () => useSplitEditorStore.getState().isSplit;
   const getFileNotes = () => useFileNotesStore.getState().fileNotes;
   const setFileNotes = (updater) =>
     useFileNotesStore.getState().setFileNotes(updater);
   ```
5. **App tree 外の副作用（Theme / グローバルダイアログ / MessageDialog）は `<Providers>` に切り出す**。`Providers.tsx` がストアを直接購読する。
6. **`useEffect` で Monaco を後追い同期しない**。設定変更時は `applySettingsToAllEditors(settings)` / `applyLanguageToEditor(editor, lang)` をハンドラから直接呼ぶ。

---

## 保存・永続化のパターン

ホットパス（ノート切替・タイプ中）でブロックしないため、**Fire-and-forget** を徹底する。

```ts
// ❌ ノート切替を await で詰まらせる
await SaveNote(...);
setCurrentNote(next);

// ✅ ローカル state を先に楽観更新してから投げっぱなし
isNoteModified.current = false;
pendingContentRef.current = null;
useNotesStore.getState().setNotes((prev) => prev.map(...));
SaveNote(backend.Note.createFrom(noteToSave), 'update').catch((err) =>
  console.error('SaveNote failed:', err),
);
setCurrentNote(next);
```

ルール:
- **フラグ（`isNoteModified` / `pendingContentRef`）は SaveNote を投げる「前」にクリア**する。並行する別ノート切替時の二重保存を防ぐため。
- **アプリ終了経路（`app:beforeclose`）は引き続き同期 `await`**。データロスを防ぐ最後の砦。
- 同パターンを `SaveFileNotes` / `MoveNoteToFolder` / `DeleteNote` / `SetLastActiveNote` / `UpdateNoteOrder` 等にも適用。

テスト時は fire-and-forget の `.catch()` が `undefined` で落ちないよう、Wails モックは必ず `.mockResolvedValue(undefined)` で返す。

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

ストア state はテスト間で漏れるため、`src/test/setup.ts` の `afterEach` で全ストアを `reset()` する。新しい store を追加した場合はここにも追加する。

```ts
afterEach(() => {
  useCurrentNoteStore.getState().resetCurrentNote();
  useNotesStore.getState().reset();
  useFileNotesStore.getState().reset();
  useSplitEditorStore.getState().reset();
});
```

テスト内でストアを seed する場合は **action（`setNotes` 等）を介さず `setState` で直接書く**。spy したい action を bypass できる。
```ts
useFileNotesStore.setState({ fileNotes: [...] }); // spy 経由しない
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
- **state は Zustand に集約**。コンポーネント内 `useState` はドラッグ位置などの真にローカルな副作用に限る。
- **コンポーネントは UI のみ**。ビジネスロジックはカスタム hook、共有 state はストア。
- **App.tsx は購読しない**。書き込み action と narrow selector のみ取得。詳細は本ドキュメント「フロントエンド: state 管理の方針」節。
- **イベントハンドラから `useEffect` で同期しない**。Monaco への適用は `applySettingsToAllEditors` / `applyLanguageToEditor` を直接呼ぶ（`stores/useEditorSettingsStore.ts` で export）。
- **`useCallback` の依存はストアアクション or モジュールレベル関数のみ**。store の state field は依存に入れない。
- **保存系は fire-and-forget**（前節「保存・永続化のパターン」を参照）。
- **Biome**: リンターおよびフォーマッターとして Biome を使用する。
- **型定義**: `types.ts` に集約。Wails 自動生成型は `wailsjs/go/models.ts`。
- **インデント**: タブ。
- **命名**: コンポーネントは PascalCase、hook は `use` プレフィックス、ストアは `useXxxStore`、末端購読 hook は `useAllXxx` / `useXxxId` 等で区別。

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

### グローバル `showMessage`
`useMessageDialogStore.ts` が top-level に `export const showMessage` を出しているので、フックでない場所（ストア内 / イベントハンドラ / async helper）からも `import { showMessage } from 'stores/useMessageDialogStore'` だけで呼べる。`<MessageDialog />` は `<Providers>` 直下に常駐し、ストアを購読して開閉する。

### ダイアログのレイジーロード
`<DialogHost />` 内で `SettingsDialog` / `LicenseDialog` / `ConflictBackupsDialog` / `MobileAppDialog` を `React.lazy` で動的インポートしている。初回起動時のバンドルから外し、開いた時だけロードする。設定ダイアログは再オープン時に内部 state を初期化したいため `settingsKey` を `key` に渡して remount。

---

## 機能追加ガイド

### 新しいバックエンドAPIの追加
1. `domain.go` に必要なデータ型を定義。
2. 適切なサービスファイルにロジック実装。
3. `app.go` にパブリックメソッドを追加。
4. 必要に応じて `SyncState` に dirty フラグを追加し、`MarkDirty()` 等で同期をトリガー。
5. `wails dev` で再ビルド → `wailsjs/` が自動更新。
6. テスト追加 (`*_test.go`)。

### 新しい共有 state の追加（フロントエンド）
1. `src/stores/useXxxStore.ts` を作成。state interface と actions interface を分けて書く。
2. **末端購読用の selector hook を同ファイルから export**（`useAllXxx` / `useXxxId` など。重い slice は selector を限定して再描画範囲を絞る）。
3. `INITIAL_STATE` と `reset()` を必ず用意し、**`src/test/setup.ts` の `afterEach` に `reset()` を追加**。
4. ロジックを集約したいなら `src/hooks/useXxx.ts` を作り、**state は store から `getState()` / subscribe で読む**。フックは action / 副作用 / `useCallback` 化したラッパだけを返す。
5. App.tsx に統合する場合は **書き込み action のみ取得**し、状態の読み出しは consumer 側 or `getState()` 経由。

### 新しい UI と言語リソースの追加
1. `locales/` の各 JSON にキーを追加。
2. 複雑なロジックはカスタム hook に分離 (`hooks/use*.ts`)。
3. UI コンポーネントを `components/` に作成。state は store の selector hook で必要な slice だけ購読。
4. App.tsx 経由でハンドラを渡す必要がある場合のみ props で。それ以外は store を直接読む。
5. コンポーネント内で `useTranslation()` を使用。
6. テスト追加 (`__tests__/` or `__test__/`)。

### 新しい Wails イベントの追加
- Backend → Frontend: `wailsRuntime.EventsEmit(ctx, "event:name", data)` (Go側)
- Frontend 受信: `runtime.EventsOn("event:name", handler)` (React側)
- cleanup 忘れずに: `runtime.EventsOff("event:name")` を useEffect の return で呼ぶ
- 1 度だけ登録すれば良いブリッジは `main.tsx` で `register*Bridge()` 関数として呼ぶ（例: `registerMessageDialogBridge`）。

### 新しいダイアログの追加
1. `src/components/XxxDialog.tsx` を作成。`useDialogsStore` の `isXxxOpen` を購読して表示制御。
2. `useDialogsStore` に `openXxx` / `closeXxx` action を追加。
3. `<DialogHost />` 内で `React.lazy` 経由で `<Suspense fallback={null}>` 内に追加。
4. App.tsx 配下の state を触る必要がある場合は、`useDialogsStore` に register/unregister 方式で handler を流し込む（`onRestoreFromBackup` を参照）。
