# Monaco Notepad

**English** | [日本語](README.ja.md)

**Like OS Notepad × VS Code × Evernote divided by 10**

A programmer's notepad powered by Monaco Editor (the same engine as VS Code). Edit files directly or convert them to cloud notes and sync across devices.

<img width="2700" height="1684" alt="Monaco Notepad Screenshot" src="https://github.com/user-attachments/assets/7609b7c5-2037-4801-bf5d-c70cb2d61e79" />

## Features

### 💡 Hybrid Approach

- **Direct file editing** — Open and edit local files directly
- **Convert to cloud notes** — Transform local files into cloud notes, syncing across devices like Evernote
- **Private storage** — Cloud notes use your Google Drive (app only accesses its dedicated folder)
- **Offline ready** — Works completely without network

### 📝 Editor

- **Monaco Editor** with syntax highlighting for 50+ languages
- **Auto-save** with 3-second debounce
- **Customizable** font family, font size, and editor themes
- **Convenient features** — Word wrap and minimap toggles
- **Dark / Light mode** with smooth theme switching
- **Side-by-side view** for editing two notes simultaneously
- **Markdown preview** with GitHub Flavored Markdown (GFM) support

### 📁 Note Management

- **Basic operations** — Create, edit, archive, and delete notes
- **Folder organization** with drag-and-drop reordering
- **Full-text search** across all notes and file contents with match navigation

### 💾 Local File Editing

- **Open and edit** local files directly
- **Save / Save As** functionality
- **Unsaved changes indicator**
- **Convert to cloud notes** — Transform local files into cloud notes
- **Drag & drop** to open files

## Keyboard Shortcuts

| Shortcut                 | Action                    |
| ------------------------ | ------------------------- |
| `Ctrl/Cmd + N`           | New note                  |
| `Ctrl/Cmd + O`           | Open file                 |
| `Ctrl/Cmd + S`           | Save file                 |
| `Ctrl/Cmd + Alt + S`     | Save As                   |
| `Ctrl/Cmd + W`           | Close file / Archive note |
| `Ctrl/Cmd + Tab`         | Next note                 |
| `Ctrl/Cmd + Shift + Tab` | Previous note             |

## Tech Stack

| Layer    | Technology                                                  |
| -------- | ----------------------------------------------------------- |
| Backend  | Go + [Wails v2](https://wails.io/)                          |
| Frontend | React 19 + TypeScript + Vite                                |
| Editor   | [Monaco Editor](https://microsoft.github.io/monaco-editor/) |
| UI       | Material UI (MUI) v7                                        |
| Sync     | Google Drive API v3                                         |

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

[MIT](LICENSE.txt)

## Author

Jun-Murakami ([official site](https://jun-murakami.web.app/))
