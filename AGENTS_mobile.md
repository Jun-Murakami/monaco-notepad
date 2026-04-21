# AGENTS_mobile.md — Monaco Notepad Mobile (Expo)

> このファイルは `mobile/` 配下で作業するエージェント向け。デスクトップ版の構成は `AGENTS.md` を参照。

## 位置づけ

`mobile/` は、デスクトップ版と同じ Google Drive の appDataFolder をバックエンドとする **独立したモバイルアプリ** (Expo / React Native)。デスクトップ版のバイナリとは別プロセス・別 OAuth クライアント ID で動く。同期するデータ構造・ファイル配置・ハッシュ計算・競合解決ルールは**デスクトップ版と 1:1 で互換**。

- **フレームワーク**: Expo SDK 52+ / Expo Router（ファイルベースルーティング）
- **言語**: TypeScript strict
- **UI**: React Native Paper（MD3）
- **状態管理**: Zustand（デスクトップと同じ思想）
- **i18n**: i18next + react-i18next
- **リンター/フォーマッター**: Biome（インデントは**タブ**、デスクトップ frontend は space なので注意）
- **テスト**: **Vitest**（Jest ではない）

---

## アーキテクチャ

```
mobile/
├── app.json                     # Expo 設定 + OAuth client ID (extra.googleOAuth*)
├── app/                         # Expo Router
│   ├── _layout.tsx              # ルートレイアウト (PaperProvider / i18n / 起動時初期化)
│   ├── index.tsx                # ノート一覧
│   ├── note/[id].tsx            # エディタ (view/edit トグル)
│   ├── settings.tsx
│   └── signin.tsx
└── src/
    ├── services/
    │   ├── auth/authService.ts           # OAuth2 (PKCE) + refresh_token 自動更新
    │   ├── notes/noteService.ts          # ローカル CRUD + noteList.json 管理
    │   ├── storage/{atomicFile,paths}.ts # 原子書き込み + パス定義
    │   └── sync/                         # ★ 同期レイヤー（後述）
    ├── stores/                  # Zustand: notesStore / authStore / syncStore
    ├── components/              # UI 部品 (Paper ベース)
    ├── hooks/useInitialize.ts   # 起動時の全サービス初期化
    ├── i18n/                    # locales/{en,ja}/common.json + index.ts
    ├── theme/                   # MD3 light/dark
    ├── utils/uuid.ts            # expo-crypto 依存の UUID v4
    └── test/                    # 全テストヘルパ + in-memory mocks
```

### 同期レイヤー (src/services/sync/)

**デスクトップ版 `backend/drive_service.go` + `drive_sync_service.go` + `sync_state.go` + `drive_operations_queue.go` + `drive_polling.go` の TS 移植**。挙動完全一致が鉄則。

| ファイル | 対応する Go | 責務 |
|---|---|---|
| `types.ts` | `domain.go` | Note/NoteMetadata/NoteList/SyncStateSnapshot/MessageCode の型と定数 |
| `hash.ts` | `domain.go` の computeContentHash | SHA-256 (`id,title,content,language,archived`) と conflict copy dedup |
| `asyncLock.ts` | `sync.Mutex` 相当 | Promise ベースの排他。JS はシングルスレッドだが非同期並行の直列化に必須 |
| `retry.ts` | `withRetry` | AuthError/RetryableError/HTTP status で分類、指数バックオフ |
| `syncState.ts` | `sync_state.go` | **revision ベース race 検知**。`clearDirtyIfUnchanged` / `updateSyncedState` |
| `driveClient.ts` | `drive_operations.go` | REST v3 低レベル fetch ラッパ (appDataFolder 専用) |
| `driveSyncService.ts` | `drive_sync_service.go` | ノート CRUD + noteList 更新 + fileId キャッシュ |
| `driveLayout.ts` | ensureFolders 相当 | appDataFolder 配下のフォルダ・ファイル ID を初期化 |
| `orchestrator.ts` | `SyncNotes/pushLocal/pullCloud/resolveConflict` | 4 分岐 + LWW 競合解決 + race 対応 |
| `polling.ts` | `drive_polling.go` | 5→60s 指数 backoff + NetInfo + AppState 連携 + Changes API pageToken |
| `operationQueue.ts` | `drive_operations_queue.go` | **SQLite 永続**キュー (モバイル固有)。UPDATE 3s debounce |
| `orphanRecovery.ts` | drive_service.go の orphan 処理 | 「不明ノート」復元 + Conflict Copy dedup |
| `conflictBackup.ts` | cloud_wins/cloud_delete バックアップ | ローカルに max 100 件保持 |
| `driveService.ts` | drive_service.go のライフサイクル部 | 上記を束ねる。UI はこれ経由で操作 |
| `events.ts` | Wails EventsEmit 相当 | `drive:status` / `notes:reload` / `sync:message` 等の型付き pub/sub |

---

## モバイル固有の拡張 (デスクトップとの差分)

1. **操作キューを SQLite に永続化** (`operationQueue.ts`)
   - アプリが kill されてもペンディング操作を復元できる
   - 起動時に `driveService.initialize()` が `operationQueue.start()` を呼ぶと、残留項目を再生する
2. **NetInfo によるオフライン停止** (`polling.ts`)
   - `isConnected=false` になったらポーリング停止、`drive:status` を `offline` に
   - オンライン復帰で即座に同期再開、interval を 5s にリセット
3. **AppState による background 停止** (`polling.ts`)
   - `background`/`inactive` になったらポーリング停止
   - `active` 復帰で即時同期 + interval リセット
4. **OAuth refresh_token 自動更新** (`authService.ts`)
   - デスクトップ版は期限切れで手動再ログインだが、モバイルは `expo-auth-session` の `refreshAsync` で自動更新する
   - トークンは `expo-secure-store` (iOS Keychain / Android Keystore)
5. **シンタックスハイライトは View 時のみ** (`components/SyntaxHighlightView.tsx`)
   - GitHub モバイル方式。`react-native-syntax-highlighter` (hljs) で atomOneDark/Light
   - 編集モードは素の `TextInput` + monospace

---

## データの対応表（デスクトップ ↔ モバイル）

| 項目 | デスクトップ (Go) | モバイル (TS) |
|---|---|---|
| Note 完全体 | `Note` struct | `Note` interface |
| noteList 要素 | `NoteMetadata` | `NoteMetadata` |
| SyncState | `SyncState` struct (sync_state.go) | `SyncStateSnapshot` + `SyncStateManager` |
| 同期 mutex | `syncMu` | `AsyncLock` (orchestrator 内部) |
| ローカルパス | `appDataDir/` | `documentDirectory + 'monaco-notepad/'` |
| 不明ノートフォルダ名 | `"不明ノート"` | `"不明ノート"` (定数 `ORPHAN_FOLDER_NAME`) |
| conflict backup 場所 | `appDataDir/cloud_conflict_backups/` | 同じ相対配置 |
| noteList ファイル名 | `noteList_v2.json` | 同じ |

---

## コーディング規約

### TypeScript
- **strict mode 必須**。`any` は極力避ける（外部モジュール型定義不備の際のみ `as any` + biome-ignore コメント）
- **日本語コメント**。バックエンドと統一
- **関数より class**: サービス層は class ＋ シングルトン export（`syncStateManager`, `noteService`, `driveService` 等）
- **副作用は import 経由で注入**: `import * as FileSystem from 'expo-file-system'` → Vitest の `vi.mock` でテスト可能に

### ファイル配置
- Expo Router は `app/` 配下、ページは `app/<route>/page.tsx`（ページ名は `index.tsx` / `[id].tsx` 等）
- サービス層は `src/services/<area>/`
- 画面共通 UI は `src/components/`
- テストは対象ファイルと同階層の `__tests__/` に `.test.ts` で
- テスト共通ヘルパは `src/test/` (helpers.ts, fakeCloud.ts, mocks/)

### 命名
- サービスクラス: `XxxService`、ファクトリなしの直接 export されたシングルトン
- イベント: `drive:*`, `notes:*`, `integrity:*`, `sync:*`（デスクトップ版と同名）
- MessageCode: `drive.sync.*` / `drive.conflict.*` / `orphan.*`（**デスクトップと同一キー**、frontend の i18n と揃える）

### インデント
- コード: **タブ**（`biome.json` で指定）
- JSON: space 2（Biome 既定）

---

## 同期ロジック編集時の厳守ルール

1. **SyncState の `revision` は決して永続化しない**
   - 永続化するのは `dirty`/`dirtyNoteIds`/`deletedNoteIds`/`deletedFolderIds`/`lastSyncedDriveTs`/`lastSyncedNoteHash` のみ
   - `revision` は in-memory の race 検知用カウンタ。再起動でリセットされる前提

2. **`clearDirtyIfUnchanged` の返り値チェックを省略しない**
   ```ts
   const cleared = await this.syncState.clearDirtyIfUnchanged(snap.revision, ts, hashes);
   if (!cleared) {
     // ★ 必須: 同期中にユーザー編集があった → dirty 維持、ts と hash だけ更新
     await this.syncState.updateSyncedState(ts, hashes);
   }
   ```
   これを忘れるとユーザーの編集が失われる。

3. **ローカル＋クラウド両変更の判定は `lastSyncedNoteHash` と照合**
   - `ModifiedTime` だけで競合判定してはダメ
   - `cloudMeta.contentHash === lastSyncedHash` なら「クラウドは前回同期から変わっていない」= ローカル勝ち固定

4. **Conflict Copy の dedup は `(content, language)` のみ**
   - `id` や `title` は違っても OK

5. **`backupLocalNote('cloud_wins', ...)` は上書き直前に取る**
   - 後から取るとデータが飛ぶ

6. **`syncLock` (`AsyncLock`) は `orchestrator.syncNotes()` と `saveNoteAndUpdateList()` 両方で取る**
   - ポーリング同期とユーザー保存の競合を防ぐ

7. **DriveClient を新規メソッド追加時は `space=appDataFolder` を必ず付ける**
   - 忘れるとユーザーの通常 Drive を漁りに行ってしまう

---

## 機能追加ガイド

### 新しい同期イベント/状態を足したい場合
1. `types.ts` の `SyncStatus` 型 or `MessageCode` 定数に追加
2. `events.ts` の `SyncEvents` 型に追加
3. `orchestrator.ts` から emit
4. `stores/syncStore.ts` で受ける（UI 反映）
5. `i18n/locales/{en,ja}/common.json` に翻訳追加
6. テスト (`orchestrator.test.ts` / `syncState.test.ts`) を追加

### 新しい Drive 操作を追加する場合
1. `driveClient.ts` に低レベル fetch ラッパを追加（`withRetry` は上位で使う）
2. `driveSyncService.ts` に高レベル API + fileId キャッシュ利用
3. `operationQueue.ts` の `OpType` に新しい種別を足すか既存を再利用
4. `driveService.ts` の `executeQueuedOp` で dispatch
5. `driveClient.test.ts` に fetch mock でテスト追加

### 新しい画面を追加する場合
1. `app/<route>.tsx` を作成（Expo Router が自動認識）
2. `_layout.tsx` の `<Stack.Screen>` にヘッダ設定を追加
3. 必要な i18n キーを追加
4. Zustand store が必要なら `src/stores/` に追加

---

## テスト

**Vitest** を使う（Jest ではない）。

```bash
cd mobile
npm test                 # run once
npm run test:watch       # watch
npm run test:coverage    # coverage
```

### モック戦略
- `vitest.setup.ts` で `vi.mock()` を登録 → `src/test/mocks/` の in-memory 実装を差し込む
- モック対象: `expo-file-system`, `expo-sqlite`, `expo-crypto`, `expo-secure-store`, `expo-auth-session`, `expo-constants`, `expo-localization`, `@react-native-community/netinfo`, `react-native`
- `afterEach` で自動リセット (`resetFileSystem` / `resetSqlite` / `resetSecureStore`)

### 同期ロジックのテストの書き方
- `FakeCloud` (`src/test/fakeCloud.ts`) を `DriveSyncService` の代わりに注入
  - 呼び出しカウンタ (`cloud.calls.create` 等) で検証可能
  - `setCloudNote()` / `rebuildNoteListFromCloud(ts)` で任意の初期状態を構築
  - `updateNoteList` を上書きすれば race シナリオを再現できる
- `SyncStateManager` / `NoteService` は**本物を使う**（ファイルも SQLite も in-memory）
- 時刻依存は `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` で制御

### テストを追加すべきタイミング
- 同期フローに影響する変更は必ず `orchestrator.test.ts` にシナリオ追加
- `syncState.ts` 変更は `syncState.test.ts` に revision race ケース追加
- Drive REST 呼び出し変更は `driveClient.test.ts` に fetch mock 追加

---

## ビルド / 実行

```bash
cd mobile
npm install
npx expo prebuild              # native プロジェクト生成 (ios/, android/)
npm run ios                    # iOS simulator
npm run android                # Android emulator
npm start                      # Dev server (Expo Go ではネイティブ依存で動かないので prebuild 必要)
```

### OAuth 設定 (Google Cloud Console 作業)
- プロジェクトは**デスクトップ版と同じで OK**（クライアント ID だけ別途作成）
- iOS OAuth Client: Bundle ID = `app.monaconotepad.mobile`
- Android OAuth Client: パッケージ名 = `app.monaconotepad.mobile` + デバッグ／リリース SHA-1 両方
- スコープ: `https://www.googleapis.com/auth/drive.appdata` のみ
- 取得した Client ID は `mobile/app.json` の `extra.googleOAuth{Ios,Android,Web}ClientId` に入れる
- OAuth 同意画面の「アプリの確認」を通しておく（テストユーザーのみなら未認証でも可）

---

## 絶対にやってはいけないこと

1. `MessageCode` のキー名をデスクトップと変えること（i18n が壊れる）
2. ContentHash の計算対象フィールドを変えること（`folderId` / `modifiedTime` は含めない、それ以外は含める）
3. `sync_state.json` のスキーマをデスクトップと非互換にすること
4. `drive.appdata` 以外のスコープを要求すること
5. `operationQueue` を同期レイヤーを経由せず直接叩くこと（順序保証が壊れる）
6. Expo Go で動かすことを前提にした実装（`expo-sqlite` や native 依存は prebuild 必須）
7. PII （ユーザーの Drive パス、トークン等）を `console.log` に流すこと

---

## デバッグ Tips

- `syncEvents.on('sync:message', ...)` を直接購読すれば同期の進行が全て見える
- `syncStateManager.snapshot()` で dirty / 最後の同期 ts / hash を取得
- `operationQueue.pendingCount()` で積み残し件数
- `FakeCloud` は呼び出しカウンタを持つので、テスト中は期待呼び出し回数で検証するのが確実
- Drive 側の状態を調べたい時は Google OAuth 2 Playground で `drive.appdata` スコープをリクエストし、`spaces=appDataFolder` で `files.list` を叩く

---

## 未実装 / 後続タスク

- [ ] `expo-background-fetch` による true bg 同期（iOS は制約多いため優先度低）
- [ ] UI コンポーネントの render テスト（Vitest + react-native-web or Jest + jest-expo）
- [ ] `polling.ts` / `driveService.ts` の結合テスト
- [ ] v1 legacy Drive からの移行フロー（モバイルは新規前提で未対応）
- [ ] Silent push 通知による即時同期（FCM/APNs）
- [ ] セルラー回線時の同期抑制オプション（UI は設定画面にあるが、`polling.ts` で未参照）
- [ ] 設定の永続化（現状メモリのみ）
- [ ] フォルダ UI（noteList 上はサポート、画面側未対応）
