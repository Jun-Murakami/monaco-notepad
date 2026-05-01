# Monaco Notepad

[English](README.md) | **日本語**

**メモ帳 × VSCode × Evernote を足して 10 で割ったようなアプリ**

Monaco Editor（VS Code と同じエンジン）を搭載したプログラマー向けノートアプリです。ローカルファイルを直接編集することも、クラウドノートに変換して自分の Google Drive 経由でデスクトップ・モバイル間で同期することもできます。

[デスクトップ版ダウンロード](https://github.com/jun-murakami/monaco-notepad/releases/latest)

<img width="3024" height="1964" alt="image" src="https://github.com/user-attachments/assets/8c976163-f6fd-44a5-a93f-d26bbf3c6e0b" />

## 特徴

### 💡 ハイブリッド設計

- **ローカルファイルの直接編集** — ファイルを開いてそのまま編集
- **クラウドノート変換** — ローカルファイルをクラウドノートに変換し、Evernote のように複数デバイスで同期
- **プライベートストレージ** — クラウドノートはユーザー自身の Google Drive を使用（アプリ専用 `appDataFolder` のみアクセス）
- **オフライン対応** — ネットワークが無くても完全に動作。オンライン復帰時に自動で同期再開
- **クロスプラットフォーム同期** — Windows / macOS デスクトップ、iOS / Android モバイルで同じノート

### 📝 エディタ

- **Monaco Editor** — 50 種類以上の言語でシンタックスハイライト（デスクトップ）
- **自動保存** — 3 秒のデバウンス
- **カスタマイズ可能** — フォントファミリー、フォントサイズ、エディタテーマ
- **ワードラップ / ミニマップ** の切り替え
- **ダーク / ライトモード** をスムーズに切り替え
- **2 画面分割モード** — 2 つのノートを同時に編集
- **Markdown プレビュー** — GitHub Flavored Markdown (GFM) をサポート
- **Mermaid ダイアグラム** — Markdown プレビュー上でライブレンダリング。フローチャート、シーケンス図、クラス図、ER 図、ガントチャート等を ` ```mermaid ` コードブロック内に記述するだけで描画

### 📁 ノート管理

- **基本操作** — ノートの作成、編集、アーカイブ、削除
- **フォルダ整理** — ドラッグ & ドロップで並び替え
- **全文検索** — すべてのノートとファイル内容を横断検索、マッチ箇所をナビゲート
- **競合バックアップ** — 「クラウド優先」で同期解決された場合、ローカル版が復元可能なバックアップとして保持される

### 💾 ローカルファイル編集（デスクトップ専用）

- **ファイルを開く** — ローカルファイルを直接開いて編集
- **保存 / 名前を付けて保存**
- **未保存変更インジケータ**
- **クラウドノート変換** — ローカルファイルをクラウドノートに昇格
- ドラッグ & ドロップ、ファイル関連付け、コマンド引数からの起動に対応

## モバイル版アプリ

コンパニオンとなるモバイル版アプリを **App Store / Google Play で公開中**です。デスクトップ版と**同じ Google Drive `appDataFolder`** を使用し、データ構造・ハッシュ計算・競合解決ロジックが 1:1 互換のため、すべての端末に同じノートが表示されます。

- **対応プラットフォーム** — iOS / Android（Expo / React Native 製）
- **認証** — Google OAuth2、refresh token を自動更新（再ログイン不要）
- **同期** — デスクトップと同じ `drive.appdata` スコープ
- **オフライン対応** — 保留中の操作を SQLite に永続化し、オンライン復帰時に再生
- **閲覧モードのハイライト** — Shiki（TextMate grammar = VS Code / Monaco と同一エンジン）でシンタックスハイライト。編集モードは素のモノスペース TextInput
- **Bundle ID** — `dev.junmurakami.monaconotepad`

📱 **インストール:**
- iOS — [App Store](https://apps.apple.com/jp/app/monaco-notepad/id6764434901)
- Android — [Google Play](https://play.google.com/store/apps/details?id=dev.junmurakami.monaconotepad)
- またはデスクトップ版の **設定 → モバイル版アプリ** ダイアログから QR コードをスキャン。

## キーボードショートカット（デスクトップ）

| ショートカット           | 動作                                  |
| ------------------------ | ------------------------------------- |
| `Ctrl/Cmd + N`           | 新しいノート                          |
| `Ctrl/Cmd + O`           | ファイルを開く                        |
| `Ctrl/Cmd + S`           | ファイルを保存                        |
| `Ctrl/Cmd + Alt + S`     | 名前を付けて保存                      |
| `Ctrl/Cmd + W`           | ファイルを閉じる / ノートをアーカイブ |
| `Ctrl/Cmd + Tab`         | 次のノート                            |
| `Ctrl/Cmd + Shift + Tab` | 前のノート                            |
| `Ctrl/Cmd + F`           | 検索                                  |
| `Ctrl/Cmd + H`           | 検索と置換                            |

## 技術スタック

### デスクトップ

| レイヤー       | 技術                                                        |
| -------------- | ----------------------------------------------------------- |
| バックエンド   | Go + [Wails v2](https://wails.io/)                          |
| フロントエンド | React 19 + TypeScript + Vite                                |
| 状態管理       | Zustand                                                     |
| エディタ       | [Monaco Editor](https://microsoft.github.io/monaco-editor/) |
| UI             | Material UI (MUI) v7                                        |
| 同期           | Google Drive API v3 (`appDataFolder` スコープ)              |
| Lint / Format  | Biome（フロントエンド）、gofmt（バックエンド）              |
| テスト         | Go `testing` + `testify`、Vitest + React Testing Library    |

### モバイル

| レイヤー       | 技術                                                        |
| -------------- | ----------------------------------------------------------- |
| フレームワーク | Expo SDK 55+ / React Native (Expo Router)                   |
| 言語           | TypeScript (strict)                                         |
| 状態管理       | Zustand                                                     |
| UI             | React Native Paper (Material Design 3)                      |
| ハイライト     | Shiki + react-native-shiki-engine（閲覧モードのみ）         |
| ストレージ     | expo-file-system + expo-sqlite（操作キュー）                |
| 認証           | expo-auth-session (PKCE) + expo-secure-store                |
| 同期           | デスクトップと同じ `drive.appdata` スコープ                 |
| テスト         | Vitest                                                      |

## ソースからビルド

### 事前準備 — Google Drive クレデンシャル

Google Drive 同期機能を使用するには、[Google Cloud Console](https://console.cloud.google.com/) で OAuth クレデンシャルを作成する必要があります。

#### デスクトップ版: `backend/credentials.json`

```json
{
  "installed": {
    "client_id": "XXX",
    "project_id": "monaco-notepad",
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
    "client_secret": "XXX",
    "redirect_uris": ["http://localhost"]
  }
}
```

#### モバイル版: `mobile/.env.local`

```dotenv
GOOGLE_OAUTH_IOS_CLIENT_ID=xxxxx.apps.googleusercontent.com
GOOGLE_OAUTH_ANDROID_CLIENT_ID=yyyyy.apps.googleusercontent.com
```

デスクトップ版と同じ Google Cloud プロジェクトを使えますが、iOS / Android それぞれに OAuth クライアントを作成し、bundle ID / パッケージ名は `dev.junmurakami.monaconotepad` を指定します。スコープは `https://www.googleapis.com/auth/drive.appdata` のみで OK。

### デスクトップ版 — 開発 & ビルド

```bash
# ホットリロード付き開発サーバー
wails dev

# 本番ビルド
./build_mac.sh   # macOS
./build.ps1      # Windows (PowerShell)
```

### モバイル版 — 開発 & ビルド

```bash
cd mobile
npm install
npm run prebuild       # wails.json からバージョン同期 + ios/, android/ を生成

# ローカルデバッグ
npm run ios            # iOS Simulator（要 macOS + Xcode）
npm run android        # Android Emulator（要 Android SDK）

# クラウドビルド（リリース用）
npx eas-cli@latest build --profile production --platform all
```

モバイル版の EAS / ストア提出に関する詳細は [`AGENTS_mobile.md`](AGENTS_mobile.md) を参照。

## プロジェクト構成

```
monaco-notepad/
├── backend/      # Go バックエンド (Wails)
├── frontend/     # デスクトップ用 React フロントエンド
├── mobile/       # Expo / React Native モバイルアプリ
├── build/        # Wails ビルド成果物
├── AGENTS.md         # デスクトップ開発ガイド
└── AGENTS_mobile.md  # モバイル開発ガイド
```

デスクトップ版とモバイル版は別プロセス・別 OAuth クライアントの**独立したアプリ**ですが、Google Drive `appDataFolder` のレイアウトを共有しているため、同じアカウントなら全端末で同じノートが見えます。

## ライセンス

[MIT](LICENSE.txt)

## 作者

Jun-Murakami ([official site](https://jun-murakami.web.app/))
