# AGENTS_mobile.md — Monaco Notepad Mobile (Expo)

> このファイルは `mobile/` 配下で作業するエージェント向け。デスクトップ版の構成は `AGENTS.md` を参照。

## 位置づけ

`mobile/` は、デスクトップ版と同じ Google Drive の appDataFolder をバックエンドとする **独立したモバイルアプリ** (Expo / React Native)。デスクトップ版のバイナリとは別プロセス・別 OAuth クライアント ID で動く。同期するデータ構造・ファイル配置・ハッシュ計算・競合解決ルールは**デスクトップ版と 1:1 で互換**。

- **フレームワーク**: Expo SDK 57（React Native 0.86 / React 19.2）/ Expo Router（ファイルベースルーティング）
- **パッケージ名 / Bundle ID**: `dev.junmurakami.monaconotepad` (Android / iOS 共通)
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
├── app.config.ts                # Expo 動的設定 + OAuth client ID (.env.local 経由で注入)
├── eas.json                     # EAS Build プロファイル定義
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

**同期エンジン v3**。仕様は `docs/sync-engine-v3.md` が唯一の正で、デスクトップ版（Go）と同じ手順・同じ判定を実装する。
純粋コア（`core/`）の一致は `sync-spec/vectors/*.json` の共有ベクターで Go / TS 両方のテストが機械的に検証する。

| ファイル | 対応する Go | 責務 |
|---|---|---|
| `core/decideNote.ts` | `sync_core.go` の decideNote | ノート単位の判定（Drive の md5 + base で「誰が変えたか」を決める。編集は削除に勝つ / 新しい版が勝つ） |
| `core/mergeSequence.ts` | `sync_core.go` の mergeSequence | 順序の 3-way マージ（LCS で「ローカルで動かした項目」だけを相手の順序に再配置） |
| `core/mergeNoteList.ts` | `sync_core.go` の mergeNoteList | 構造（フォルダ・所属・notes 配列・トップレベル順・折りたたみ）の 3-way マージ |
| `syncEngine.ts` | `sync_engine.go` | 1 サイクルの実行（リモート読み取り → 判定 → 本体 I/O → ローカルコミット → noteList 書き込み → base 更新） |
| `driveGateway.ts` | `drive_gateway.go` | 状態を持たない Drive 操作（最古の root / noteList を使う、作成直後に重複を確認、重複本体の掃除） |
| `syncBase.ts` | `sync_base.go` | `sync_base.json`: 最後に同期が確定した noteList と、ノートごとの本文 hash / Drive md5 |
| `syncState.ts` | `sync_state.go` | `sync_state.json`: dirty 系（ヒント）と `deletedNoteIds`（削除の意図） |
| `codec.ts` | `drive_gateway.go` の decodeNoteList | Drive 上の JSON ⇄ 型（デスクトップ形式も読める） |
| `localActions.ts` | `app.go` の SaveNote / DeleteNote 等 | UI 操作に伴うローカル手順（保存 → 変更の記録）。アプリとテストで共有 |
| `driveClient.ts` | `drive_operations.go` | REST v3 低レベル fetch ラッパ (appDataFolder 専用、md5 / version / createdTime を要求) |
| `polling.ts` | `drive_polling.go` | 5→60s 指数 backoff + NetInfo + AppState + Changes API（消費した分だけ進める）+ 5 分ごとの定期同期 |
| `driveService.ts` | `drive_service.go` | 接続ライフサイクル。UI はこれ経由で操作（保存は記録 + debounce した同期要求） |
| `conflictBackup.ts` | `conflict_backup.go` | `cloud_wins` / `cloud_delete` / `local_wins` バックアップ（max 100 件） |
| `types.ts` / `hash.ts` / `retry.ts` / `asyncLock.ts` / `events.ts` | `domain.go` 等 | 型・本文 hash・再試行・排他・型付き pub/sub |

---

## モバイル固有の拡張 (デスクトップとの差分)

1. **保存は記録だけ、同期は debounce してまとめる** (`driveService.ts` / `polling.ts`)
   - 保存・削除は `localActions.ts` でローカルに書いて `sync_state.json` に記録するだけ。kill されても記録が残るので、
     起動後の最初の同期で必ず送られる（v2 の操作キュー `operationQueue` は廃止）
   - 同期要求は `kickDebounced()`（既定 2 秒）で入力中の連続保存を 1 回にまとめる
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
   - **Shiki** (TextMate grammar = VSCode/Monaco と同一エンジン) でデスクトップとほぼパリティの色付け
   - エンジンは `react-native-shiki-engine` の `createNativeEngine()` (JSI + 直リンク Oniguruma)、テーマは `dark-plus` / `light-plus` (VSCode デフォルト)
   - Highlighter は `src/lib/syntaxHighlight/highlighter.ts` のシングルトン。grammar は `languageLoaders.ts` の dynamic import で**遅延ロード**（起動時パースを回避）
   - Monaco ID → Shiki ID の対応は `languageMap.ts`。Shiki に grammar が無い 14 言語 (`UNSUPPORTED_MONACO_IDS`) は**モバイルピッカーから除外**するが、デスクトップで選ばれた値はそのまま保持し plaintext 描画にフォールバック
   - 編集モードは素の `TextInput` + monospace（ハイライトしない）

---

## データの対応表（デスクトップ ↔ モバイル）

| 項目 | デスクトップ (Go) | モバイル (TS) |
|---|---|---|
| Note 完全体 | `Note` struct | `Note` interface |
| noteList 要素 | `NoteMetadata` | `NoteMetadata` |
| SyncState（変更の記録） | `SyncState` struct (sync_state.go) | `SyncStateSnapshot` + `SyncStateManager` |
| 同期 base | `SyncBase` (sync_base.go, `sync_base.json`) | `SyncBase` (syncBase.ts, `sync_base.json`) |
| 同期の直列化 | `syncEngine.mu` + `driveService.syncMu` | `SyncEngine` 内の `AsyncLock` |
| ローカル書き込みの排他 | `noteService.mu`（`WithLock`） | `NoteService` 内の `AsyncLock`（`transact`） |
| ローカルパス | `appDataDir/` | `documentDirectory + 'monaco-notepad/'`（`storagePaths()` で差し替え可能） |
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
- テスト共通ヘルパは `src/test/` (helpers.ts, fakeDrive.ts, desktopPeer.ts, mobileDevice.ts, mocks/)

### 命名
- サービスクラス: `XxxService`、ファクトリなしの直接 export されたシングルトン
- イベント: `drive:*`, `notes:*`, `integrity:*`, `sync:*`（デスクトップ版と同名）
- MessageCode: `drive.sync.*` / `drive.conflict.*` / `orphan.*`（**デスクトップと同一キー**、frontend の i18n と揃える）

### インデント
- コード: **タブ**（`biome.json` で指定）
- JSON: space 2（Biome 既定）

---

## 同期ロジック編集時の厳守ルール

仕様は `docs/sync-engine-v3.md`。原則（P1〜P9）に反する変更をしないこと。

1. **判定・マージのロジックは `core/` の純粋関数だけに置き、Go 版と同時に変える**
   - まず `sync-spec/vectors/*.json` にケースを足して両方のテストが RED になることを確認し、両実装を直して GREEN にする
2. **本文の変更検知は Drive の md5 で行う。noteList の contentHash を同期判定に使わない**（P1）
3. **「無い」ことから削除を推論しない**（P2）
   - リモート削除 = Drive の本体ファイルが無くなったこと。ローカル削除 = `markNoteDeleted` で記録した意図
   - noteList に載っていないが本体があるノートは、配置情報の無いノートとしてトップレベル先頭に置く（不明ノートは作らない）
4. **失敗したものの base を進めない**（P5）。やり直し・中断時も `checkpoint` で確定した事実だけ保存する
5. **ローカルへの書き込みは必ず `NoteService` のロック内**（UI は通常メソッド、エンジンは `transact`）
   - エンジンのコミットは「その時点のローカル」に対して再マージする。スナップショット以降に触られたノートは上書き・削除しない
6. **所属フォルダは noteList が正**（P7）。本体ファイルの folderId を読まない。既存ノートの保存で所属を変えない
7. **Changes API のトークンは消費したぶんだけ進める**（P9）。自分の書き込み後に取り直さない
8. **上書き・削除の直前にバックアップ**: `cloud_wins`（ローカルが負け）/ `cloud_delete`（リモート削除）/ `local_wins`（負けたリモートの版）
9. **SyncState の `revision` は永続化しない**（同期中のユーザー操作の検知用、再起動でリセット）
10. **DriveClient を新規メソッド追加時は `spaces=appDataFolder` を必ず付け、必要な項目を `fields` に入れる**
   - FakeDrive は `fields` に無い項目を返さないので、入れ忘れはテストで落ちる
11. **連携解除（signOut）で `sync_base.json` / `sync_state.json` を消さない**
   - 再接続は「オフラインからの復帰」として扱う。消すと相手の削除が復活し、離れていた間の移動・並び替えや削除が失われる
   - 別アカウントの Drive ではフォルダ ID が違うのでエンジンが base を使わない。消してよいのは Drive データ全削除時だけ

---

## 機能追加ガイド

### 新しい同期イベント/状態を足したい場合
1. `types.ts` の `SyncStatus` 型 or `MessageCode` 定数に追加
2. `events.ts` の `SyncEvents` 型に追加
3. `syncEngine.ts` から emit
4. `stores/syncStore.ts` で受ける（UI 反映）
5. `i18n/locales/{en,ja}/common.json` に翻訳追加
6. テスト（`syncEngine.test.ts` 等）を追加

### 新しい Drive 操作を追加する場合
1. `driveClient.ts` に低レベル fetch ラッパを追加（`withRetry` は上位で使う）
2. `driveGateway.ts` に同期エンジン向けの操作を追加（状態・キャッシュは持たない）
3. `src/test/fakeDrive.ts` が未対応の API / クエリならそこも実装する（未知のクエリは例外になる）
4. デスクトップ版 `drive_gateway.go` にも同じ操作を足す

### 新しいユーザー操作（ローカル変更）を追加する場合
1. `localActions.ts` に「ローカルへ保存 → `syncStateManager` に記録」の手順を追加
2. `driveService.ts` から呼び、最後に `requestSync()`
3. `src/test/mobileDevice.ts` に同じ操作を足し、シナリオ / シミュレーションで検証する

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

### 同期ロジックのテストの書き方（4 層）

| 層 | 場所 | 内容 |
|---|---|---|
| L0 共有ベクタ | `sync-spec/vectors/*.json` → `core/__tests__/specVectors.test.ts` | `decideNote` / `mergeSequence` / `mergeNoteList` の入出力表。**Go 版も同じファイルを読む** |
| L1 FakeDrive | `src/test/fakeDrive.ts` | fetch レベルの Drive 偽物。本物の `DriveClient` をそのまま通す。`fields` / md5 / version / Changes / 重複ファイル / 障害注入（`failWhen` / `beforeRequest`）を再現 |
| L2 端末間シナリオ | `crossDevice.scenarios.test.ts` | `mobileDevice.ts`（本物のサービス群）と `desktopPeer.ts`（プロトコルどおりに書くデスクトップ役）で、実際に報告された症状を再現する |
| L3 シミュレーション | `simulation.test.ts` | 乱数シード付きで複数端末の操作・同期・障害をランダムに実行し、収束 / 最新版が勝つ / 誰も消していないノートが消えない / 構造が正しい を検査 |

- `SyncStateManager` / `NoteService` は**本物を使う**（ファイルも SQLite も in-memory）
- 時刻依存は `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` で制御
- シミュレーションの規模は環境変数で変えられる: `SIM_SEEDS` / `SIM_STEPS` / `SIM_DEVICES` / `SIM_SEED`（1 シードだけ再実行）/ `SIM_DEBUG=1`（操作ログ）

### テストを追加すべきタイミング
- 判定・マージの規則を変える → まずベクタを追加（Go / TS 両方で RED を確認）
- 同期フローに影響する変更 → `syncEngine.test.ts` か `crossDevice.scenarios.test.ts` にシナリオ追加
- シミュレーションが落ちたら、そのシードを `SIM_SEED` で再現し、最小シナリオに落としてから直す
- `syncState.ts` 変更は `syncState.test.ts` に revision race ケース追加
- Drive REST 呼び出し変更は `driveClient.test.ts` に fetch mock 追加

---

## 依存関係の更新メモ

- **SDK の上げ方**: `npx expo install expo@^<版> && npx expo install --fix` → `npx expo-doctor` → `npx expo export --platform android`（Metro で本番バンドルが作れるか）→ ネイティブビルド。
  SDK を上げたら生成済みの `android/` `ios/` は古いので `npx expo prebuild --clean` で作り直す（`npm run prebuild` はビルド番号も進める）。
- **Expo が版を決めるもの**（`expo`・`expo-*`・`react`・`react-native`・`react-native-*` の多く・`typescript`・`@types/react`）は `npx expo install` で入れる。npm の latest に合わせない。
- **アイコン**: SDK 56 で `expo` が `@expo/vector-icons` に依存しなくなったため、React Native Paper のアイコンは
  `@react-native-vector-icons/material-design-icons` で出している（フォントは `expo-font` 経由で自動で読み込まれる。
  `expo-font` の config plugin にフォントのパスを足さないこと）。
- **`expo/fetch`**: SDK 56 から `globalThis.fetch` が `expo/fetch` になった。Drive 通信で不具合が出たら
  `EXPO_PUBLIC_USE_RN_FETCH=1` で React Native 標準の fetch に戻して切り分ける。
- **`npm audit` 対策の `overrides`**（`package.json`）:
  - `decode-uri-component` → `vendor/decode-uri-component`（修正版 0.5.0 を CommonJS にしたもの）。`expo-router` が使う
    `query-string@7` から `require()` できる修正版が無いため。`expo-router` が `query-string@7` をやめたら削除する（`vendor/decode-uri-component/README.md`）。
  - `xcode` の `uuid` → `^11.1.1`（prebuild 用ツールの依存。`uuid@11` は CommonJS も配布している）。

## ローカル開発 / ビルド

```bash
cd mobile
npm install
npm run prebuild               # wails.json 由来のバージョン同期 + native プロジェクト生成 (ios/, android/)
npm run ios                    # iOS simulator (要 macOS + Xcode)
npm run android                # Android emulator (要 Android SDK)
npm start                      # Dev server (Expo Go ではネイティブ依存で動かないので prebuild 必要)
```

ローカルビルドは debug 検証用。**リリースは EAS Build で行う**（次セクション参照）。

---

## EAS Build / リリース

### 全体方針

- **クラウドビルド**: Apple Distribution / Google Play Store 提出用は EAS Build (cloud) で行う
- **OTA 配信**: JS / アセットの修正のみは `eas update` で配信し、再ビルド消費を抑える
- **`eas build --local` は macOS/Linux のみ動作**: Windows からは cloud ビルドのみ
- 無料枠 30 builds/月。基本は preview ビルド + OTA 運用で消費を最小化

### `eas.json` プロファイル

| プロファイル | 用途 | 出力 |
|---|---|---|
| `development` | dev client 接続用 | APK |
| `preview` | 社内テスト配布 | APK |
| `production` | Play Store / App Store 提出用 | AAB / IPA |
| `production-apk` | Play Console の所有権検証など特殊用途 | APK |

```bash
# 本番リリースビルド
npx eas-cli@latest build --profile production --platform all

# 検証用 APK
npx eas-cli@latest build --profile production-apk --platform android

# 社内配布
npx eas-cli@latest build --profile preview --platform android
```

### バージョン管理

`eas.json` に `appVersionSource: "remote"` を設定。**EAS が `versionCode` (Android) / `buildNumber` (iOS) をクラウド側で自動採番**する。

ローカル Gradle / Xcode でリリースビルドする場合のみ手動管理が必要 (`eas build:version:get` / `:set` で同期)。

### `.easignore` (重要)

**git リポジトリのルートに配置する** (`mobile/` ではない)。本リポジトリは Wails デスクトップ + Expo モバイルの monorepo なので、`mobile/` 以外の Wails ソース (`backend/` `frontend/` `build/` 等) を漏れなく除外しないとアップロードが GB 超になる。

`.easignore` が存在する場合 EAS は `.gitignore` を一切参照しない。除外対象は明示列挙する (gitignore 仕様上、`/*` deny-all + `!mobile/` 再包含が機能しないため)。

### Android キーストア管理

- 鍵は EAS が credential 管理 (`eas credentials` で確認・差し替え)
- ローカル `.jks` で署名する場合の制約: **EAS は PKCS#12 のストア = 鍵パスワード一致を厳格にチェック**する。Android Studio が許容する「ストアと鍵で違うパスワード」は EAS で reject される (`Invalid PKCS#12` エラー)
  - 対処: [KeyStore Explorer](https://keystore-explorer.org/) GUI で鍵パスワードをストアパスワードに揃えて再保存し、EAS にアップロード
  - keytool では `-keypasswd` が PKCS#12 で動かないので使えない

### Play Console パッケージ登録時の注意

新規パッケージ名登録時、最初の APK アップロードで使った鍵が **そのパッケージに永続バインド**される。後から別の鍵に変更不可。

- 「対象となる公開鍵の選択」で過去アプリの鍵を選んでしまうと、その鍵で署名した APK しか以降アップロード不可になる
- 安全策: 何も選ばずいきなり「APK をアップロード」する。Google が新鍵を自動登録する

### Apple Distribution Certificate / Provisioning Profile

EAS が Apple Developer Portal と連携して自動セットアップ。初回 iOS ビルド時に対話プロンプトで生成。

- `Generate a new Apple Distribution Certificate?` → `Y` (アカウントあたり最大 3 個まで保有可)
- `Generate a new Apple Provisioning Profile?` → `Y`
- Push Notifications Key は不使用なら不要

### Encryption Export Compliance (iOS)

`app.config.ts` の `ios.infoPlist.ITSAppUsesNonExemptEncryption: false` を設定済み。本アプリは HTTPS / Keychain / SHA-256 など標準暗号のみ使用するため申告不要。これにより毎リリースの App Store Connect 申告がスキップされる。

### OAuth 設定 (Google Cloud Console 作業)
- プロジェクトは**デスクトップ版と同じで OK**（クライアント ID だけプラットフォームごとに作成）
- iOS OAuth Client: Bundle ID = `dev.junmurakami.monaconotepad`
- Android OAuth Client: パッケージ名 = `dev.junmurakami.monaconotepad` + デバッグ／リリース SHA-1 両方
- スコープ: `https://www.googleapis.com/auth/drive.appdata` のみ
- OAuth 同意画面の「アプリの確認」を通しておく（テストユーザーのみなら未認証でも可）

### Client ID の注入 (OSS 方針)
本リポジトリは OSS のため、Client ID を git 管理対象には入れない。`app.config.ts` が `process.env` から読み、`.env.local` でローカル注入する。

1. `mobile/.env.example` を `mobile/.env.local` にコピー
2. Google Cloud Console で発行した値を貼り付け:
   ```
   GOOGLE_OAUTH_IOS_CLIENT_ID=xxxxx.apps.googleusercontent.com
   GOOGLE_OAUTH_ANDROID_CLIENT_ID=yyyyy.apps.googleusercontent.com
   ```
3. `.env.local` は `.gitignore` 済。コミットされないことを `git check-ignore` で確認可能
4. EAS Build では `eas env:create --name GOOGLE_OAUTH_IOS_CLIENT_ID --value ... --scope project --visibility sensitive --environment production --environment preview --environment development` で同名の環境変数を登録（旧 `eas secret:create` は deprecated）
5. 未設定のまま起動すると `authService.resolveClientId` が明示エラーを投げる（プレースホルダのまま通さない）

### Android デバッグ SHA-1 の取得
```powershell
# Windows (keytool は JDK / Android Studio JBR 同梱)
& "C:\Program Files\Java\jdk-22\bin\keytool.exe" -list -v `
  -keystore "$env:USERPROFILE\.android\debug.keystore" `
  -alias androiddebugkey -storepass android -keypass android
```
```bash
# macOS / Linux
keytool -list -v -keystore ~/.android/debug.keystore \
  -alias androiddebugkey -storepass android -keypass android
```
出力の `SHA1:` 行を Google Cloud Console の Android OAuth Client 作成画面に貼り付ける。リリース用は EAS Credentials 画面（`eas credentials` コマンドでも可）から別途取得し、同じ OAuth Client に追加登録する。

---

## 絶対にやってはいけないこと

1. `MessageCode` のキー名をデスクトップと変えること（i18n が壊れる）
2. ContentHash の計算対象フィールドを変えること（`folderId` / `modifiedTime` は含めない、それ以外は含める）
3. `sync_state.json` のスキーマをデスクトップと非互換にすること
4. `drive.appdata` 以外のスコープを要求すること
5. 同期エンジンを経由せず Drive を直接書き換えること（base と食い違い、他端末の変更を消す）
6. `sync_base.json` を同期エンジン以外から書き換えること（消すのはサインアウト / Drive データ削除時のみ）
7. Expo Go で動かすことを前提にした実装（`expo-sqlite` や native 依存は prebuild 必須）
8. PII （ユーザーの Drive パス、トークン等）を `console.log` に流すこと
9. Drive から来たノート ID を検証せずにパスやクエリに使うこと（`isSafeNoteId` を通す。codec / gateway で実施済み）

---

## デバッグ Tips

- `syncEvents.on('sync:message', ...)` を直接購読すれば同期の進行が全て見える
- `syncStateManager.snapshot()` で未送信の変更（dirtyNoteIds / deletedNoteIds 等）を取得
- `syncBaseStore.load()` で前回同期時点の base（noteList / 各ノートの md5）を確認できる
- `FakeDrive` は `noteHistory()`（どの端末がいつ何を書いたか）と呼び出しログを持つので、テスト中はそれで検証するのが確実
- Drive 側の状態を調べたい時は Google OAuth 2 Playground で `drive.appdata` スコープをリクエストし、`spaces=appDataFolder` で `files.list` を叩く

### 開発環境の引っかかりポイント（Windows Android debug）

- **adb にゾンビエミュレータが残る**: 他アプリ（Nahimic の `NTKDaemon.exe` 等）が port 5563 を掴んでいると、adb はそれを「emulator-5562」と誤認し永続的な offline エントリを作る。`setx ADB_LOCAL_TRANSPORT_MAX_PORT 5561` で adb の emulator スキャン範囲を絞ると回避できる
- **Quick Boot スナップショット**: AVD がクイックブートで前回の状態（他アプリのスプラッシュ等）を復元することがある。`emulator -avd <name> -no-snapshot-load` でコールドブート
- **`react-native-reanimated` / `react-native-worklets` の版**: 組み合わせを手で固定しない。Expo SDK の対応表どおり `npx expo install --fix` に任せる（SDK 55 時代の worklets 0.7.x 固定は SDK 57 で不要になった）

### OAuth2 関連の設計メモ

- **GCP の「カスタム URI スキームを有効にする」をオンにすること**: 2024 年以降の新規 Android OAuth クライアントはデフォルト OFF。GCP コンソール → クライアント編集 → 詳細設定で ON にする。反映に 5 分〜数時間
- **iOS/Android の OAuth Client ID は環境変数経由で注入**: OSS リポジトリなので `.env.local` (gitignore) で管理。`app.config.ts` の `process.env.GOOGLE_OAUTH_*_CLIENT_ID` が参照する
- **redirect URI は `com.googleusercontent.apps.<client-id>:/oauth2redirect` を指定**: ただし expo-auth-session は内部的に `<scheme>://oauth2redirect` に変換して deep link を聴取する。ユーザー視点で deep link が `monaconotepad://oauth2redirect` で戻ってくるのは正常
- **`app/oauth2redirect.tsx`** はこの戻りを catch して Expo Router の "Unmatched Route" を回避する目的のダミールート。削除不可

---

## 未実装 / 後続タスク

### 動作検証（着手予定）
- [x] OAuth2 サインインフロー（Android debug build で 2026-04-22 確認）
- [x] EAS Build セットアップ完了（production / production-apk / preview / development の 4 プロファイル）
- [x] Play Console パッケージ登録（`dev.junmurakami.monaconotepad`、内部テスト準備中）
- [ ] 初回同期: 空 Drive ↔ 空 local / 既存 Drive → local 取り込みの両シナリオ
- [ ] ノート CRUD → Drive 反映（create / edit / archive / delete / move）
- [ ] アプリ再起動後の refresh_token 自動更新
- [ ] **デスクトップ版で作成した既存ノートがモバイルで読める** ことの検証（同期ロジック 1:1 互換の生命線）
- [ ] 競合解決シナリオ（同じノートをデスクトップとモバイルで同時編集）の実機確認（FakeDrive 上のシナリオ / シミュレーションでは検証済み）
- [ ] オフライン中の変更がオンライン復帰時に送られることの実機確認
- [ ] iOS 実機での動作確認（EAS で IPA 出力可能、TestFlight 配信は次ステップ）
- [ ] Play Console 内部テスト配信 → 実機検証

### 実装タスク
- [ ] UI コンポーネントの render テスト（Vitest + react-native-web or Jest + jest-expo）
- [ ] `polling.ts` / `driveService.ts` の結合テスト
- [ ] v1 legacy Drive からの移行フロー（モバイルは新規前提で未対応）
- [ ] Silent push 通知による即時同期（FCM/APNs）
- [ ] セルラー回線時の同期抑制オプション（UI は設定画面にあるが、`polling.ts` で未参照）
- [ ] 設定の永続化（現状メモリのみ）
- [ ] フォルダ UI（noteList 上はサポート、画面側未対応）

### 将来の検討事項
- [ ] `@react-native-google-signin/google-signin` への移行（Google 推奨の Credential Manager 方式）
  - 現状は expo-auth-session + Custom URI scheme（GCP 側で「おすすめしません」と警告が出る方式）
  - 移行すると: Chrome 遷移なしの in-app 認証 / refresh_token 不要 / URL hijacking リスク解消
  - 影響範囲: `authService.ts` 全面書き換え、`StoredToken` スキーマ変更、iOS/Android ともに config plugin 追加
  - タイミングの目安: ストア公開前、もしくは Google から deprecation 通知が来た時
