# Issues - Archive Overhaul

## [2026-02-10] TypeScript Errors in App.tsx
- App.tsx not updated with new ArchivedNoteList props
- Missing: folders, archivedTopLevelOrder, onUnarchiveFolder, onDeleteFolder, onUpdateArchivedTopLevelOrder, isDarkMode
- Test files also need updating (but not in plan scope)

## Known Constraints
- No nested folders (flat architecture)
- Archive DnD simpler than sidebar (no cross-folder moves)
- Restored items go to END of topLevelOrder
- Empty folders show Delete, non-empty show Archive
