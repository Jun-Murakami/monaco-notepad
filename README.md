# Monaco Notepad

A programmer's notepad powered by Monaco Editor — the same engine behind VS Code — with Google Drive sync, split editing, and markdown preview.

<img width="1440" alt="Monaco Notepad Screenshot" src="https://github.com/user-attachments/assets/6d69d9be-55ee-46a2-a566-4b99d2d8e2b5" />

## Features

### Editor

- **Monaco Editor** with syntax highlighting for 50+ languages
- Auto-save with 3-second debounce
- Customizable font family, font size, and editor themes
- Word wrap and minimap toggles
- Dark / Light mode with smooth theme switching

### Split Editor

- Side-by-side split view for editing two notes simultaneously
- Right-click context menu: **Open in Left Pane** / **Open in Right Pane**
- Automatic split mode activation from context menu
- Duplicate detection — if the same file would appear in both panes, the other pane loads the next available item
- Split state persisted across app restarts
- Color-coded pane indicators

### Markdown Preview

- Live preview with GitHub Flavored Markdown (GFM) support
- Syntax-highlighted code blocks
- Configurable position: left or right side (via Settings)

### Note Management

- Create, edit, archive, and delete notes
- Folder organization with drag-and-drop reordering
- Archive system with restore capability
- Full-text search across all notes and file contents with match navigation

### Local File Editing

- Open and edit local files directly
- Save / Save As
- Unsaved changes indicator
- Convert local files to cloud notes
- Drag & drop to open files

### Google Drive Sync

- OAuth2 authentication
- Automatic background sync via Changes API
- Content-hash based change detection
- Async operation queue for uploads and downloads
- Visual sync status in the status bar

### Status Bar

- Character count, line count, cursor position
- Notification area with history (up to 1,000 entries)
- Quick-access buttons: Split Editor, Markdown Preview, Google Drive, Settings
- Version update notification

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + N` | New note |
| `Ctrl/Cmd + O` | Open file |
| `Ctrl/Cmd + S` | Save file |
| `Ctrl/Cmd + Alt + S` | Save As |
| `Ctrl/Cmd + W` | Close file / Archive note |
| `Ctrl/Cmd + Tab` | Next note |
| `Ctrl/Cmd + Shift + Tab` | Previous note |

## Getting Started

1. Download the latest release for your platform (macOS / Windows)
2. Launch the app — no additional setup required
3. Optionally connect your Google account for cloud sync

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Go + [Wails v2](https://wails.io/) |
| Frontend | React 19 + TypeScript + Vite |
| Editor | [Monaco Editor](https://microsoft.github.io/monaco-editor/) |
| UI | Material UI (MUI) v7 |
| Sync | Google Drive API v3 |

## Building from Source

### Development

```bash
wails dev
```

### Production

```bash
# macOS
./build_mac.sh

# Windows (PowerShell)
./build.ps1
```

## License

[MIT](LICENSE)
