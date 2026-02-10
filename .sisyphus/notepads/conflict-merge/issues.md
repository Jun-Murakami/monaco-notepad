# Issues

## 2026-02-11 TestOfflineRecovery_ConflictMerged fails
- Uses `newTestDriveService` which has empty mock → DownloadNote fails → downloadedNotes empty → panic
- Need to add cloud note file to mockOps before calling mergeNotes

## 2026-02-11 Two obsolete tests remain
- `TestMergeNotes_ConflictCopyChainPrevention` (L2732) — tests old conflict copy chain prevention, irrelevant for in-note merge
- `TestMergeNotes_ConflictCopy_UploadedToDrive` (L2805) — tests old conflict copy upload, irrelevant for in-note merge
