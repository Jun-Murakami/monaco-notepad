# Decisions - Archive Overhaul

## Data Model
- Folder.Archived mirrors Note.Archived pattern
- ArchivedTopLevelOrder separate from TopLevelOrder
- Both use `omitempty` for backward compatibility

## Archive Behavior
- Archive folder → archives ALL notes inside
- Restore folder → restores ALL notes, adds to END of sidebar
- Delete archived folder → force deletes folder + all notes

## UI/UX
- Archive page replaces editor area (full-width)
- Content popup: read-only Monaco with syntax highlighting
- Unnamed notes: show contentHeader (italic, 0.6 opacity)
- Folder headers: expand/collapse state not persisted

## Testing
- No automated tests (per user decision)
- Agent-executed QA scenarios only
