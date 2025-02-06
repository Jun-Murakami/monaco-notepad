# Monaco Notepad

A cloud-synchronized notepad application built for programmers, featuring the Monaco Editor (VS Code's editor component) and Google Drive integration.

<img width="1440" alt="スクリーンショット 2025-02-06 23 09 01" src="https://github.com/user-attachments/assets/6d69d9be-55ee-46a2-a566-4b99d2d8e2b5" />

## Overview

Monaco Notepad is a specialized note-taking application designed for programmers who need a temporary, cloud-synchronized workspace for code snippets and technical notes. Unlike traditional text editors, it doesn't modify files directly on your system but instead manages notes in a dedicated cloud-synchronized environment.

## Key Features

- **Monaco Editor Integration**: Powered by the same editor component used in VS Code
- **Google Drive Sync**: Automatic cloud synchronization with your Google Drive
- **Language Support**: Syntax highlighting for multiple programming languages
- **Non-Invasive Design**: Never modifies your local files directly
- **Import/Export Workflow**:
  - Import text files to create new notes
  - Export notes to text files when needed
  - Keeps your file system clean and organized

## Use Cases

- **Code Snippet Management**: Store and organize frequently used code snippets
- **Temporary Workspace**: Quick notes during debugging or development
- **Cross-Device Access**: Access your programming notes from any device
- **Collaborative Sharing**: Share notes through Google Drive when needed

## Getting Started

1. **Installation**

   - Download the latest release for your platform
   - No additional setup required

2. **Google Drive Integration**

   - Sign in with your Google account on first launch
   - Notes are automatically synchronized

3. **Basic Usage**
   - Create new notes with the "New" button
   - Import existing files via the "Import" button
   - Export notes to files using the "Export" button
   - Select programming language for proper syntax highlighting

## Technical Details

- Built with Go and React
- Uses Wails for desktop application framework
- Implements Monaco Editor for code editing
- Integrates with Google Drive API for cloud synchronization

## Design Philosophy

Monaco Notepad is designed to be a "programmer's Evernote" with a focus on:

- Cloud-first approach
- Clean workspace management
- Programming-specific features
- Minimal file system interaction

## Requirements

- Windows/macOS
- Google account for cloud synchronization
- Internet connection for sync features

## License

[MIT] - See LICENSE file for details
