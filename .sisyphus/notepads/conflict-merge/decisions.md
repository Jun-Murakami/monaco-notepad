# Decisions

## 2026-02-11 Conflict handling strategy
- Migrated from "conflict copy" (new note creation) to "in-note merge" (Git-style conflict markers)
- `SyncResult.ConflictCopies` renamed to `ConflictMerges`
- `CreateConflictCopy()` kept but deprecated
- `MergeConflictContent()` added to note_service.go
