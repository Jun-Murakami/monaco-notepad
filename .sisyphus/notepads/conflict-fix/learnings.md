# Conflict Copy Fix - Learnings

## 2026-02-11 Analysis

### Root Causes Identified

1. **Conflict copies not uploaded to Drive**: CreateConflictCopy() only saves locally. Cloud noteList references note IDs with no Drive file.
2. **LastSync updated on every save**: noteService.SaveNote() sets LastSync=time.Now() on every save, causing perpetual timestamp mismatch between devices.
3. **Race between SaveNote goroutine and SyncNotes**: SaveNote goroutine uploads note+noteList without syncMu, can interleave with SyncNotes.
4. **ContentHash includes Title**: Conflict copies have different titles → different hashes → detected as new conflicts.

### Key Code Locations
- mergeNotes(): drive_service.go:688-792
- CreateConflictCopy(): note_service.go:259-310
- SaveNote(): app.go:247-289 (goroutine race)
- SaveNote(): note_service.go:132-212 (LastSync update)
- computeContentHash(): note_service.go:20-25
- SyncNotes(): drive_service.go:451-540
