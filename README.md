# Monaco Notepad

**English** | [日本語](README.ja.md)

**Like OS Notepad × VS Code × Evernote divided by 10**

A programmer's notepad powered by Monaco Editor (the same engine as VS Code). Edit local files directly or convert them to cloud notes and sync them across desktop and mobile via your own Google Drive.

[Download for Desktop](https://github.com/jun-murakami/monaco-notepad/releases/latest)

<img width="3024" height="1964" alt="image" src="https://github.com/user-attachments/assets/8c976163-f6fd-44a5-a93f-d26bbf3c6e0b" />

## Features

### 💡 Hybrid Approach

- **Direct file editing** — Open and edit local files directly
- **Convert to cloud notes** — Transform local files into cloud notes, syncing across devices like Evernote
- **Private storage** — Cloud notes use your Google Drive (the app only accesses its dedicated `appDataFolder`)
- **Offline ready** — Works completely without network; changes sync as soon as you're back online
- **Cross-platform sync** — Same notes on Windows / macOS desktop and iOS / Android mobile

### 📝 Editor

- **Monaco Editor** with syntax highlighting for 50+ languages (desktop)
- **Auto-save** with 3-second debounce
- **Customizable** font family, font size, and editor themes
- **Word wrap** and **minimap** toggles
- **Dark / Light mode** with smooth theme switching
- **Side-by-side view** for editing two notes simultaneously
- **Markdown preview** with GitHub Flavored Markdown (GFM) support
- **Mermaid diagrams** rendered live in the Markdown preview — flowcharts, sequence diagrams, class diagrams, ER diagrams, Gantt charts and more inside fenced ` ```mermaid ` code blocks

### 📁 Note Management

- **Basic operations** — Create, edit, archive, and delete notes
- **Folder organization** with drag-and-drop reordering
- **Full-text search** across all notes and file contents with match navigation
- **Conflict backups** — When a sync conflict resolves to "cloud wins", your local version is kept as a recoverable backup

### 💾 Local File Editing (Desktop only)

- **Open and edit** local files directly
- **Save / Save As**
- **Unsaved changes indicator**
- **Convert to cloud notes** — Promote a local file into a synced note
- **Drag & drop**, file association, and CLI argument to open files

## Mobile App

A companion mobile app is **available on the App Store and Google Play**. It uses the **same Google Drive `appDataFolder`** as the desktop version — the data structure, hash calculation, and conflict resolution rules are 1:1 compatible, so the same notes appear on every device.

- **Platforms** — iOS and Android (built with Expo / React Native)
- **Auth** — Google OAuth2 with automatic refresh-token renewal (no need to re-login)
- **Sync** — Same `drive.appdata` scope as the desktop app
- **Offline** — Pending operations are persisted in SQLite and replayed when you're back online
- **Read-mode highlighting** — Syntax highlighting in view mode powered by Shiki (TextMate grammar = same as VS Code / Monaco). Edit mode uses a plain monospace text input.
- **Bundle ID** — `dev.junmurakami.monaconotepad`

📱 **Install:**
- iOS — [App Store](https://apps.apple.com/us/app/monaco-notepad/id6764434901)
- Android — [Google Play](https://play.google.com/store/apps/details?id=dev.junmurakami.monaconotepad)
- Or open **Settings → Mobile App** in the desktop app to scan install QR codes.

## Keyboard Shortcuts (Desktop)

| Shortcut                 | Action                    |
| ------------------------ | ------------------------- |
| `Ctrl/Cmd + N`           | New note                  |
| `Ctrl/Cmd + O`           | Open file                 |
| `Ctrl/Cmd + S`           | Save file                 |
| `Ctrl/Cmd + Alt + S`     | Save As                   |
| `Ctrl/Cmd + W`           | Close file / Archive note |
| `Ctrl/Cmd + Tab`         | Next note                 |
| `Ctrl/Cmd + Shift + Tab` | Previous note             |
| `Ctrl/Cmd + F`           | Find                      |
| `Ctrl/Cmd + H`           | Find & Replace            |

## Tech Stack

### Desktop

| Layer        | Technology                                                  |
| ------------ | ----------------------------------------------------------- |
| Backend      | Go + [Wails v2](https://wails.io/)                          |
| Frontend     | React 19 + TypeScript + Vite                                |
| State        | Zustand                                                     |
| Editor       | [Monaco Editor](https://microsoft.github.io/monaco-editor/) |
| UI           | Material UI (MUI) v7                                        |
| Sync         | Google Drive API v3 (`appDataFolder` scope)                 |
| Lint/Format  | Biome (frontend), gofmt (backend)                           |
| Test         | Go `testing` + `testify`, Vitest + React Testing Library    |

### Mobile

| Layer        | Technology                                                  |
| ------------ | ----------------------------------------------------------- |
| Framework    | Expo SDK 55+ / React Native (Expo Router)                   |
| Language     | TypeScript (strict)                                         |
| State        | Zustand                                                     |
| UI           | React Native Paper (Material Design 3)                      |
| Highlight    | Shiki + react-native-shiki-engine (view mode only)          |
| Storage      | expo-file-system + expo-sqlite (operation queue)            |
| Auth         | expo-auth-session (PKCE) + expo-secure-store                |
| Sync         | Same `drive.appdata` scope as desktop                       |
| Test         | Vitest                                                      |

## Building from Source

### Prerequisites — Google Drive Credentials

To use Google Drive sync, you need OAuth credentials from [Google Cloud Console](https://console.cloud.google.com/).

#### Desktop: `backend/credentials.json`

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

#### Mobile: `mobile/.env.local`

```dotenv
GOOGLE_OAUTH_IOS_CLIENT_ID=xxxxx.apps.googleusercontent.com
GOOGLE_OAUTH_ANDROID_CLIENT_ID=yyyyy.apps.googleusercontent.com
```

Use the same Google Cloud project as the desktop app, but create separate iOS / Android OAuth clients with bundle ID / package name `dev.junmurakami.monaconotepad`. Only the `https://www.googleapis.com/auth/drive.appdata` scope is required.

### Desktop — Development & Build

```bash
# Hot-reload dev server
wails dev

# Production build
./build_mac.sh   # macOS
./build.ps1      # Windows (PowerShell)
```

### Mobile — Development & Build

```bash
cd mobile
npm install
npm run prebuild       # syncs version from wails.json + generates ios/, android/

# Local debug
npm run ios            # iOS Simulator (requires macOS + Xcode)
npm run android        # Android Emulator (requires Android SDK)

# Cloud build (release)
npx eas-cli@latest build --profile production --platform all
```

See [`AGENTS_mobile.md`](AGENTS_mobile.md) for the full mobile build / EAS / store-submission guide.

## Project Layout

```
monaco-notepad/
├── backend/      # Go backend (Wails)
├── frontend/     # React frontend for desktop
├── mobile/       # Expo / React Native mobile app
├── build/        # Wails build output
├── AGENTS.md         # Desktop dev guide
└── AGENTS_mobile.md  # Mobile dev guide
```

The desktop and mobile apps are independent processes with separate OAuth clients, but they share the same Google Drive `appDataFolder` layout, so the same account sees the same notes everywhere.

## License

[MIT](LICENSE.txt)

## Author

Jun-Murakami ([official site](https://jun-murakami.web.app/))
