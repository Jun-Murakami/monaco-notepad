# Learnings

## 2026-02-11 Context: Conflict merge migration
- Project uses Go 1.22 + Wails v2, single `package backend`
- Comments in Japanese
- `newTestDriveService(helper)` creates a driveService with empty mockDriveOperations (no files)
- Tests that need DownloadNote to succeed must add cloud note files to mockOps via `mockOps.CreateFile()`
- The mock resolves file IDs by matching `{noteID}.json` filenames
- `computeContentHash(note)` hashes ID+Title+Content+Language+Archived+FolderID
- `MergeConflictContent()` produces Git-style conflict markers: `<<<<<<< Cloud ... ======= ... >>>>>>> Local`
- `strings` package is still used in drive_service.go for error handling (6 occurrences)
