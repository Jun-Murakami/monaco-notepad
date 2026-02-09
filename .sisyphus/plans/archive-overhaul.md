# Archive Functionality Overhaul

## TL;DR

> **Quick Summary**: Comprehensive overhaul of the archive system to support folder archiving, folder-structured archive page with DnD reordering, content preview popups, and bulk folder operations (delete/restore all notes in folder).
> 
> **Deliverables**:
> - Backend: New `ArchiveFolder`, `UnarchiveFolder`, `DeleteArchivedFolder` APIs + `ArchivedTopLevelOrder` management
> - Frontend: Redesigned ArchivedNoteList with folder structure, DnD reordering, content popup dialog
> - Sidebar: Archive button on folder headers (non-empty) / delete button (empty)
> - Wails bindings regenerated
> 
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 3 waves
> **Critical Path**: Task 1 (domain) → Task 2 (backend APIs) → Task 3 (bindings) → Tasks 4-6 (frontend, parallel) → Task 7 (integration)

---

## Context

### Original Request
Comprehensive overhaul of the archive functionality in a Wails v2 + React + MUI + Monaco Editor notepad application, covering:
1. Folder header archive button (archive entire folders)
2. Empty folder → delete button on folder headers  
3. Archive page overhaul with folder structure and DnD reordering
4. Unnamed note display in archive using contentHeader
5. Click archived item → read-only content popup
6. Operations: delete/restore individual notes and entire folders

### Interview Summary
**Key Discussions**:
- Folder archiving design: Add `Archived bool` to Folder struct (mirrors Note pattern)
- Archive DnD: Reorder archived items (notes & folders) via new `ArchivedTopLevelOrder`
- Content popup: Read-only MUI Dialog with Monaco editor in read-only mode, Restore/Delete buttons
- Restore position: Restored folders/notes added to end of sidebar topLevelOrder
- Test strategy: No automated tests, agent-executed QA scenarios only
- Archive page replaces editor area (full-width view, not sidebar)

**Research Findings**:
- Current FolderHeader already has delete button for empty folders (NoteList.tsx:456-468)
- Archived notes already preserve `folderId` in metadata (NoteMetadata struct has FolderID)
- contentHeader generation: first 3 lines, max 200 chars (useNotes.ts:222-224)
- TopLevelOrder pattern exists and can be mirrored for archive ordering
- `DriveSync.UpdateCloudNoteList` already syncs folders and topLevelOrder — needs extension for archivedTopLevelOrder

### Self-Review (Gap Analysis)
**Identified Gaps** (addressed in plan):
- Edge case: Currently edited note's folder gets archived → must switch to another active note
- `DeleteFolder` currently requires empty folder → new `DeleteArchivedFolder` force-deletes folder + all notes
- NoteList.json schema change backward compatibility → use Go `omitempty` tags
- Drive sync needs to handle `archivedTopLevelOrder` field
- Folder header: requirement says "archive button for non-empty, delete button for empty" — current sidebar already shows Delete for empty, plan adds Archive for non-empty

---

## Work Objectives

### Core Objective
Enable folder-level archiving with a fully redesigned archive page that displays folder structure, supports DnD reordering, shows content previews for unnamed notes, and provides read-only content popups.

### Concrete Deliverables
- `backend/domain.go`: Updated `Folder` struct with `Archived` field, `ArchivedTopLevelOrder` in `NoteList`
- `backend/note_service.go`: New methods — `ArchiveFolder`, `UnarchiveFolder`, `DeleteArchivedFolder`, `GetArchivedTopLevelOrder`, `UpdateArchivedTopLevelOrder`
- `backend/app.go`: New Wails binding methods for all above
- `frontend/src/types.ts`: Updated `Folder` type, new `ArchivedTopLevelOrder` support in `NoteList`
- `frontend/src/hooks/useNotes.ts`: New handlers — `handleArchiveFolder`, `handleUnarchiveFolder`, `handleDeleteArchivedFolder`, `handleUpdateArchivedTopLevelOrder`
- `frontend/src/components/ArchivedNoteList.tsx`: Complete rewrite with folder structure, DnD, item click → popup
- `frontend/src/components/ArchivedNoteContentDialog.tsx`: New read-only content preview dialog
- `frontend/src/components/NoteList.tsx`: FolderHeader gets archive button for non-empty folders
- Regenerated `wailsjs` bindings

### Definition of Done
- [x] Folders can be archived from the sidebar (all notes inside move to archive)
- [x] Empty folders show delete button, non-empty show archive button in sidebar
- [x] Archive page displays folder structure with notes grouped inside folders
- [x] DnD reordering works in archive page for both top-level items and intra-folder notes
- [x] Unnamed archived notes show contentHeader preview (italic, 0.6 opacity)
- [x] Clicking an archived item opens a read-only content popup with Restore/Delete buttons
- [x] Individual note delete/restore works from archive page
- [x] Folder delete (with all notes) works from archive page
- [x] Folder restore (with all notes) works from archive page
- [x] `wails generate module` produces clean bindings
- [x] Google Drive sync handles new fields without errors

### Must Have
- Backward compatibility: existing noteList.json files must load without error (Go `omitempty`)
- Consistent behavior: archiving a folder archives ALL notes inside it
- Restoring a folder restores ALL notes inside it and adds folder to END of sidebar topLevelOrder
- FolderHeader archive button ONLY on non-empty folders; delete button ONLY on empty folders
- Content popup uses Monaco Editor in read-only mode for syntax highlighting
- Archive page DnD uses existing dnd-kit patterns

### Must NOT Have (Guardrails)
- NO nested folders (folders cannot contain other folders — current architecture is flat)
- NO editing archived notes from the popup (strictly read-only)
- NO changes to Google Drive OAuth or sync architecture
- NO changes to file mode (FileNote) functionality
- NO new npm dependencies beyond what's already installed
- NO changes to the sidebar layout or note search functionality
- NO partial folder archiving (archive a folder = archive ALL notes in it)
- NO preserving original topLevelOrder position on restore (goes to end)
- DO NOT add a separate "archived folders" data file — everything stays in noteList.json

---

## Verification Strategy

> **UNIVERSAL RULE: ZERO HUMAN INTERVENTION**
>
> ALL tasks in this plan MUST be verifiable WITHOUT any human action.

### Test Decision
- **Infrastructure exists**: YES (Vitest configured in package.json)
- **Automated tests**: None (per user decision)
- **Framework**: N/A
- **Agent-Executed QA**: ALWAYS (mandatory for all tasks)

### Agent-Executed QA Scenarios (MANDATORY — ALL tasks)

**Verification Tool by Deliverable Type:**

| Type | Tool | How Agent Verifies |
|------|------|-------------------|
| **Go Backend** | Bash (`go build`, `go vet`) | Compile, lint, verify no errors |
| **Wails Bindings** | Bash (`wails generate module`) | Regenerate and verify output |
| **Frontend Components** | Bash (`npm run build`) | TypeScript compilation + build |
| **UI Behavior** | Playwright (playwright skill) | Navigate, interact, assert DOM, screenshot |

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately):
└── Task 1: Go domain model changes (Folder.Archived, ArchivedTopLevelOrder)

Wave 2 (After Wave 1):
├── Task 2: Backend service methods (ArchiveFolder, UnarchiveFolder, etc.)
└── Task 3: Wails bindings + app.go exposure (depends on Task 2)

Wave 3 (After Task 3):
├── Task 4: Frontend types + useNotes hook handlers
├── Task 5: FolderHeader archive/delete button in sidebar
└── Task 6: ArchivedNoteContentDialog (popup component)

Wave 4 (After Wave 3):
└── Task 7: ArchivedNoteList complete rewrite (DnD, folder structure, integration)

Wave 5 (After Wave 4):
└── Task 8: App.tsx integration + final wiring
```

### Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|------------|--------|---------------------|
| 1 | None | 2 | None |
| 2 | 1 | 3 | None |
| 3 | 2 | 4, 5, 6 | None |
| 4 | 3 | 7 | 5, 6 |
| 5 | 3 | 8 | 4, 6 |
| 6 | 3 | 7 | 4, 5 |
| 7 | 4, 6 | 8 | 5 |
| 8 | 5, 7 | None | None (final) |

### Agent Dispatch Summary

| Wave | Tasks | Recommended Agents |
|------|-------|-------------------|
| 1 | 1 | quick |
| 2 | 2, 3 | unspecified-high (sequential) |
| 3 | 4, 5, 6 | quick (parallel) |
| 4 | 7 | visual-engineering |
| 5 | 8 | unspecified-low |

---

## TODOs

- [x] 1. Go Domain Model Changes — Add Folder.Archived and ArchivedTopLevelOrder

  **What to do**:
  - In `backend/domain.go`, add `Archived bool` field to the `Folder` struct with JSON tag `json:"archived,omitempty"`
  - In `backend/domain.go`, add `ArchivedTopLevelOrder []TopLevelItem` field to `NoteList` struct with JSON tag `json:"archivedTopLevelOrder,omitempty"`
  - In `frontend/src/types.ts`, update the `Folder` type to include `archived?: boolean`
  - In `frontend/src/types.ts`, update the `NoteList` type to include `archivedTopLevelOrder?: TopLevelItem[]`
  - Verify `DriveSync.UpdateCloudNoteList` in `backend/domain.go` — it currently copies folders and topLevelOrder. Add copying of `ArchivedTopLevelOrder` to this method

  **Must NOT do**:
  - Do not change any existing field semantics
  - Do not add any fields not specified above
  - Do not modify any service logic yet (that's Task 2)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small struct field additions across 2 files, no complex logic
  - **Skills**: [`git-master`]
    - `git-master`: For clean atomic commit

  **Parallelization**:
  - **Can Run In Parallel**: NO (foundation for all other tasks)
  - **Parallel Group**: Wave 1 (solo)
  - **Blocks**: Task 2
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `backend/domain.go:48-58` — `Note` struct with `Archived bool` field and JSON tags — follow this exact pattern for Folder
  - `backend/domain.go:42-45` — Current `Folder` struct that needs the new field
  - `backend/domain.go:74-80` — `NoteList` struct where `ArchivedTopLevelOrder` field should be added, following `TopLevelOrder` pattern
  - `backend/domain.go:150-169` — `DriveSync.UpdateCloudNoteList` method that needs to copy `ArchivedTopLevelOrder`

  **Type References**:
  - `frontend/src/types.ts:6-9` — Current `Folder` type to update
  - `frontend/src/types.ts:32-37` — Current `NoteList` type to update

  **Acceptance Criteria**:
  - [ ] `go build ./backend/...` compiles without errors
  - [ ] `Folder` struct in domain.go has `Archived bool` with `json:"archived,omitempty"` tag
  - [ ] `NoteList` struct has `ArchivedTopLevelOrder []TopLevelItem` with `json:"archivedTopLevelOrder,omitempty"` tag
  - [ ] `UpdateCloudNoteList` copies `ArchivedTopLevelOrder` when non-nil
  - [ ] Frontend types.ts `Folder` type includes `archived?: boolean`
  - [ ] Frontend types.ts `NoteList` type includes `archivedTopLevelOrder?: TopLevelItem[]`
  - [ ] Existing noteList.json files (without new fields) can still be loaded without error (omitempty ensures this)

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: Go code compiles after domain changes
    Tool: Bash
    Preconditions: Go toolchain available
    Steps:
      1. Run: go build ./backend/...
      2. Assert: Exit code 0, no errors in output
      3. Run: go vet ./backend/...
      4. Assert: Exit code 0, no warnings
    Expected Result: Clean compilation
    Evidence: Build output captured

  Scenario: Frontend types compile
    Tool: Bash
    Preconditions: Node modules installed
    Steps:
      1. Run: cd frontend && npx tsc --noEmit
      2. Assert: Exit code 0, no type errors
    Expected Result: Clean TypeScript compilation
    Evidence: TSC output captured
  ```

  **Commit**: YES
  - Message: `feat(domain): add Folder.Archived and ArchivedTopLevelOrder to data model`
  - Files: `backend/domain.go`, `frontend/src/types.ts`
  - Pre-commit: `go build ./backend/...`

---

- [x] 2. Backend Service Methods — ArchiveFolder, UnarchiveFolder, DeleteArchivedFolder, ArchivedTopLevelOrder Management

  **What to do**:
  - In `backend/note_service.go`, add the following methods to `noteService`:

  **`ArchiveFolder(id string) error`**:
  - Find the folder by ID in `noteList.Folders`; return error if not found
  - Set folder's `Archived = true`
  - Find all notes with `FolderID == id` — for each, set `Archived = true` and generate `ContentHeader` (first 3 lines, max 200 chars from content loaded via `LoadNote`)
  - Save each modified note via existing `SaveNote` logic (file + metadata)
  - Remove the folder from `TopLevelOrder` (using existing `removeFromTopLevelOrder`)
  - Add folder to `ArchivedTopLevelOrder` (ensure/initialize if nil, add as `{type: "folder", id: folderId}`)
  - For each archived note, if it was in TopLevelOrder, remove it; do NOT add individual notes to ArchivedTopLevelOrder (they're inside the folder)
  - Save noteList

  **`UnarchiveFolder(id string) error`**:
  - Find the folder by ID; return error if not found or not archived
  - Set folder's `Archived = false`
  - Find all notes with `FolderID == id` and `Archived == true` — set `Archived = false` for each, save via `SaveNote`
  - Remove folder from `ArchivedTopLevelOrder`
  - Add folder to END of `TopLevelOrder` as `{type: "folder", id: folderId}` (use `ensureTopLevelOrder` first)
  - Save noteList

  **`DeleteArchivedFolder(id string) error`**:
  - Find the folder by ID; return error if not found
  - Find all notes with `FolderID == id` — delete each note file (os.Remove) and remove from noteList.Notes
  - Remove folder from `noteList.Folders`
  - Remove folder from `ArchivedTopLevelOrder`
  - Remove folder from `TopLevelOrder` (in case it's there)
  - Save noteList

  **`GetArchivedTopLevelOrder() []TopLevelItem`**:
  - If `noteList.ArchivedTopLevelOrder` is not nil, return it
  - Otherwise, build it from archived data: iterate `noteList.Folders` for archived folders as `{type: "folder"}`, then archived notes without folderId as `{type: "note"}`
  - Return the built order

  **`UpdateArchivedTopLevelOrder(order []TopLevelItem) error`**:
  - Set `noteList.ArchivedTopLevelOrder = order`
  - Update LastSync, save noteList

  - Also update `NoteService` interface to include the new methods
  - Update the existing `handleArchiveNote` flow in useNotes.ts — when a note is archived, also add it to `ArchivedTopLevelOrder` if it's a top-level note (not in a folder). This means updating the `SaveNote` path or adding logic in `ArchiveNote` equivalent. Actually, the frontend handles archiving via `SaveNote` with `archived: true`. The backend `SaveNote` should check: if a note transitions to `archived = true` and has no `folderId` (or its folder is not archived), add it to `ArchivedTopLevelOrder`. If it transitions to `archived = false`, remove it from `ArchivedTopLevelOrder`.

  **IMPORTANT**: The existing archive flow for individual notes (setting `archived: true` and calling `SaveNote`) must also manage `ArchivedTopLevelOrder`. In `SaveNote`, when `note.Archived` changes:
  - If becoming archived AND `FolderID == ""` (unfiled note): add to `ArchivedTopLevelOrder` as `{type: "note", id: noteID}`
  - If becoming unarchived: remove from `ArchivedTopLevelOrder`
  - This keeps the existing individual-note archive flow working with the new ordering system

  **Must NOT do**:
  - Do not modify the existing `SaveNote` signature
  - Do not change how individual note archiving works from the frontend perspective
  - Do not touch Drive sync code (that's handled by existing `syncNoteListToDrive` in app.go)
  - Do not add any frontend code yet

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Complex Go service methods with multiple edge cases, interaction with existing SaveNote flow
  - **Skills**: [`git-master`]
    - `git-master`: Atomic commit for backend changes

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on Task 1, blocks Task 3)
  - **Parallel Group**: Wave 2 (sequential with Task 3)
  - **Blocks**: Task 3
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `backend/note_service.go:62-96` — `ListNotes()` shows how to iterate notes and check Archived status
  - `backend/note_service.go:114-199` — `SaveNote()` shows the full note save flow with metadata update, TopLevelOrder management, and noteList save — this is the method that needs ArchivedTopLevelOrder handling
  - `backend/note_service.go:297-317` — `CreateFolder()` shows folder creation pattern with TopLevelOrder management
  - `backend/note_service.go:336-362` — `DeleteFolder()` shows folder deletion pattern (currently requires empty)
  - `backend/note_service.go:422-426` — `ensureTopLevelOrder()` helper pattern to mirror for ArchivedTopLevelOrder
  - `backend/note_service.go:446-454` — `removeFromTopLevelOrder()` helper to reuse/mirror
  - `backend/note_service.go:406-419` — `GetTopLevelOrder/UpdateTopLevelOrder` pattern to mirror exactly

  **API/Type References**:
  - `backend/note_service.go:19-31` — `NoteService` interface — add new methods here
  - `backend/domain.go:42-45` — `Folder` struct (now with Archived)
  - `backend/domain.go:74-80` — `NoteList` struct (now with ArchivedTopLevelOrder)

  **ContentHeader generation pattern**:
  - `frontend/src/hooks/useNotes.ts:222-224` — Frontend contentHeader generation: `content.match(/^.+$/gm)?.slice(0, 3).join('\n').slice(0, 200)` — replicate this logic in Go for `ArchiveFolder`

  **Acceptance Criteria**:
  - [ ] `NoteService` interface includes: `ArchiveFolder`, `UnarchiveFolder`, `DeleteArchivedFolder`, `GetArchivedTopLevelOrder`, `UpdateArchivedTopLevelOrder`
  - [ ] `ArchiveFolder` sets folder.Archived=true, archives all contained notes with contentHeader, updates TopLevelOrder and ArchivedTopLevelOrder
  - [ ] `UnarchiveFolder` restores folder and all notes, moves folder to end of TopLevelOrder
  - [ ] `DeleteArchivedFolder` deletes folder and all contained note files
  - [ ] `SaveNote` manages ArchivedTopLevelOrder when note.Archived changes (for unfiled notes)
  - [ ] `GetArchivedTopLevelOrder` returns existing order or builds from archived data
  - [ ] `go build ./backend/...` compiles without errors
  - [ ] `go vet ./backend/...` passes

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: Go code compiles with new service methods
    Tool: Bash
    Preconditions: Task 1 completed
    Steps:
      1. Run: go build ./backend/...
      2. Assert: Exit code 0
      3. Run: go vet ./backend/...
      4. Assert: Exit code 0
    Expected Result: Clean compilation with all new methods
    Evidence: Build output captured
  ```

  **Commit**: YES
  - Message: `feat(backend): add folder archive/unarchive/delete service methods and ArchivedTopLevelOrder management`
  - Files: `backend/note_service.go`
  - Pre-commit: `go build ./backend/... && go vet ./backend/...`

---

- [x] 3. Wails Bindings — Expose New APIs in app.go and Regenerate Bindings

  **What to do**:
  - In `backend/app.go`, add the following binding methods (following existing patterns):

  ```go
  // フォルダをアーカイブする
  func (a *App) ArchiveFolder(id string) error {
      if err := a.noteService.ArchiveFolder(id); err != nil {
          return err
      }
      a.syncNoteListToDrive()
      return nil
  }

  // アーカイブされたフォルダを復元する
  func (a *App) UnarchiveFolder(id string) error {
      if err := a.noteService.UnarchiveFolder(id); err != nil {
          return err
      }
      a.syncNoteListToDrive()
      return nil
  }

  // アーカイブされたフォルダを削除する（中のノートも全て削除）
  func (a *App) DeleteArchivedFolder(id string) error {
      if err := a.noteService.DeleteArchivedFolder(id); err != nil {
          return err
      }
      // Drive上のノートも削除が必要
      // DeleteArchivedFolderはnote filesも削除するので、Drive側も同期
      a.syncNoteListToDrive()
      return nil
  }

  // アーカイブされたアイテムの表示順序を返す
  func (a *App) GetArchivedTopLevelOrder() []TopLevelItem {
      return a.noteService.GetArchivedTopLevelOrder()
  }

  // アーカイブされたアイテムの表示順序を更新する
  func (a *App) UpdateArchivedTopLevelOrder(order []TopLevelItem) error {
      if err := a.noteService.UpdateArchivedTopLevelOrder(order); err != nil {
          return err
      }
      a.syncNoteListToDrive()
      return nil
  }
  ```

  - Run `wails generate module` to regenerate frontend bindings in `wailsjs/` directory
  - Verify generated TypeScript bindings include the new methods

  **Must NOT do**:
  - Do not add Drive-specific deletion logic for individual notes in `DeleteArchivedFolder` — the `syncNoteListToDrive` handles noteList sync; individual note file deletion on Drive is handled by subsequent syncs
  - Do not modify any existing app.go methods

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Boilerplate binding methods following established patterns
  - **Skills**: [`git-master`]
    - `git-master`: Atomic commit

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on Task 2)
  - **Parallel Group**: Wave 2 (after Task 2)
  - **Blocks**: Tasks 4, 5, 6
  - **Blocked By**: Task 2

  **References**:

  **Pattern References**:
  - `backend/app.go:364-372` — `CreateFolder` binding pattern: call noteService method, then syncNoteListToDrive — follow exactly
  - `backend/app.go:385-392` — `DeleteFolder` binding pattern
  - `backend/app.go:404-417` — `GetTopLevelOrder/UpdateTopLevelOrder` binding pattern — mirror exactly for archived versions
  - `backend/app.go:420-430` — `syncNoteListToDrive` helper — reuse for all new methods

  **Acceptance Criteria**:
  - [ ] `backend/app.go` contains: `ArchiveFolder`, `UnarchiveFolder`, `DeleteArchivedFolder`, `GetArchivedTopLevelOrder`, `UpdateArchivedTopLevelOrder`
  - [ ] `wails generate module` completes without errors
  - [ ] Generated `wailsjs/go/backend/App.js` contains the 5 new function exports
  - [ ] `go build ./backend/...` compiles
  - [ ] `cd frontend && npx tsc --noEmit` passes (no type errors from generated bindings)

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: Wails bindings generation succeeds
    Tool: Bash
    Preconditions: Tasks 1-2 completed, wails CLI available
    Steps:
      1. Run: wails generate module
      2. Assert: Exit code 0, no errors
      3. Run: grep -l "ArchiveFolder\|UnarchiveFolder\|DeleteArchivedFolder\|GetArchivedTopLevelOrder\|UpdateArchivedTopLevelOrder" wailsjs/go/backend/App.js
      4. Assert: File found with all 5 function names
      5. Run: cd frontend && npx tsc --noEmit
      6. Assert: Exit code 0
    Expected Result: All new bindings available for frontend consumption
    Evidence: grep output and tsc output captured
  ```

  **Commit**: YES
  - Message: `feat(bindings): expose folder archive APIs as Wails bindings`
  - Files: `backend/app.go`, `wailsjs/go/backend/*`
  - Pre-commit: `go build ./backend/...`

---

- [x] 4. Frontend Hooks — useNotes Archive Handlers and State

  **What to do**:
  - In `frontend/src/hooks/useNotes.ts`:
    - Add imports for new Wails bindings: `ArchiveFolder`, `UnarchiveFolder`, `DeleteArchivedFolder`, `GetArchivedTopLevelOrder`, `UpdateArchivedTopLevelOrder`
    - Add new state: `const [archivedTopLevelOrder, setArchivedTopLevelOrder] = useState<TopLevelItem[]>([]);`
    - Load `archivedTopLevelOrder` in the existing `notes:reload` and `note:updated` event handlers (alongside the existing `GetTopLevelOrder` call, also call `GetArchivedTopLevelOrder`)
    - Add `handleArchiveFolder`:
      ```
      - Call ArchiveFolder(folderId) backend API
      - If current note is inside the folder being archived, switch to first active note or create new
      - Refresh notes, folders, topLevelOrder, archivedTopLevelOrder from backend
      - Close archive view if open (set showArchived = false won't apply since it may open archive)
      ```
    - Add `handleUnarchiveFolder`:
      ```
      - Call UnarchiveFolder(folderId) backend API
      - Refresh notes, folders, topLevelOrder, archivedTopLevelOrder from backend
      - Close archive view, select the restored folder's first note
      ```
    - Add `handleDeleteArchivedFolder`:
      ```
      - Call DeleteArchivedFolder(folderId) backend API
      - Refresh notes, folders, archivedTopLevelOrder from backend
      - If no archived items remain, close archive view
      ```
    - Add `handleUpdateArchivedTopLevelOrder`:
      ```
      - Optimistically update local archivedTopLevelOrder state
      - Call UpdateArchivedTopLevelOrder backend API
      ```
    - Update `handleArchiveNote` to also refresh `archivedTopLevelOrder` after archiving
    - Update `handleUnarchiveNote` to also refresh `archivedTopLevelOrder` after unarchiving
    - Update `handleDeleteNote` to also refresh `archivedTopLevelOrder` after deleting
    - Update `handleDeleteAllArchivedNotes` to also clear `archivedTopLevelOrder`
    - Export all new state and handlers from the hook

  **Must NOT do**:
  - Do not change the existing archive note API call pattern (SaveNote with archived=true)
  - Do not modify any UI components yet
  - Do not add DnD logic (that's in ArchivedNoteList component)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Adding handlers following existing patterns, no UI work
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 5, 6)
  - **Blocks**: Task 7
  - **Blocked By**: Task 3

  **References**:

  **Pattern References**:
  - `frontend/src/hooks/useNotes.ts:216-252` — `handleArchiveNote` pattern: find note, modify state, call backend, handle current note switch — follow this for `handleArchiveFolder`
  - `frontend/src/hooks/useNotes.ts:272-294` — `handleUnarchiveNote` pattern: load from backend, update state, switch to restored note — follow for `handleUnarchiveFolder`
  - `frontend/src/hooks/useNotes.ts:418-430` — `handleDeleteFolder` pattern: call backend, update local state — follow for `handleDeleteArchivedFolder`
  - `frontend/src/hooks/useNotes.ts:470-482` — `handleUpdateTopLevelOrder` pattern: optimistic update + backend call — follow exactly for `handleUpdateArchivedTopLevelOrder`
  - `frontend/src/hooks/useNotes.ts:73-106` — `notes:reload` event handler pattern: load all state from backend
  - `frontend/src/hooks/useNotes.ts:1-17` — Wails binding imports — add new imports here

  **API/Type References**:
  - `frontend/src/types.ts:1-4` — `TopLevelItem` type for archivedTopLevelOrder state
  - Generated `wailsjs/go/backend/App.js` — new binding function signatures

  **Acceptance Criteria**:
  - [ ] `useNotes` exports: `archivedTopLevelOrder`, `setArchivedTopLevelOrder`, `handleArchiveFolder`, `handleUnarchiveFolder`, `handleDeleteArchivedFolder`, `handleUpdateArchivedTopLevelOrder`
  - [ ] `notes:reload` and `note:updated` handlers also load `archivedTopLevelOrder`
  - [ ] `handleArchiveNote`, `handleUnarchiveNote`, `handleDeleteNote` refresh `archivedTopLevelOrder`
  - [ ] `cd frontend && npx tsc --noEmit` passes

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: Frontend compiles with new hook handlers
    Tool: Bash
    Preconditions: Task 3 completed, bindings regenerated
    Steps:
      1. Run: cd frontend && npx tsc --noEmit
      2. Assert: Exit code 0, no type errors
    Expected Result: All new handlers type-check correctly
    Evidence: TSC output captured
  ```

  **Commit**: YES
  - Message: `feat(hooks): add folder archive/unarchive/delete handlers and archivedTopLevelOrder state`
  - Files: `frontend/src/hooks/useNotes.ts`
  - Pre-commit: `cd frontend && npx tsc --noEmit`

---

- [x] 5. FolderHeader Archive Button — Sidebar Folder Header Update

  **What to do**:
  - In `frontend/src/components/NoteList.tsx`, update the `FolderHeaderProps` interface:
    - Add `onArchive: () => void` prop
  - In the `FolderHeader` component:
    - When the folder is NOT empty (`!isEmpty`), show an Archive icon button (using `Archive` from `@mui/icons-material`) in place of the Delete button
    - When the folder IS empty (`isEmpty`), keep the existing Delete button as-is
    - The Archive button should:
      - Have className `folder-action` (matches existing hover pattern)
      - Same styling as existing Delete button (`opacity: 0, transition: 'opacity 0.2s', p: 0.25`)
      - Use `Archive` icon with `width: 14, height: 14, color: 'text.secondary'`
      - Tooltip: "Archive folder"
      - onClick: call `onArchive()` with stopPropagation
      - onPointerDown: stopPropagation
  - Update FolderHeader usage in the NoteList render (around line 1156):
    - Pass `onArchive` prop: `onArchive={() => onArchiveFolder?.(folder.id)}`
  - Update `NoteListProps` interface:
    - Add `onArchiveFolder?: (folderId: string) => Promise<void>`
  - Update NoteList component parameter destructuring to include `onArchiveFolder`

  **Must NOT do**:
  - Do not change any DnD logic in NoteList
  - Do not change the Delete button behavior for empty folders
  - Do not add Rename button changes
  - Do not change folder collapse/expand behavior

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small UI addition following existing patterns
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: UI component modification

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 4, 6)
  - **Blocks**: Task 8
  - **Blocked By**: Task 3

  **References**:

  **Pattern References**:
  - `frontend/src/components/NoteList.tsx:443-469` — Existing FolderHeader action buttons section: Rename button (always) + Delete button (isEmpty only) — add Archive button here for `!isEmpty`
  - `frontend/src/components/NoteList.tsx:244-271` — NoteItem Archive button styling pattern — follow same icon button style
  - `frontend/src/components/NoteList.tsx:333-343` — `FolderHeaderProps` interface — add `onArchive` here
  - `frontend/src/components/NoteList.tsx:43-65` — `NoteListProps` interface — add `onArchiveFolder` here
  - `frontend/src/components/NoteList.tsx:1148-1172` — FolderHeader usage in render where props are passed

  **API/Type References**:
  - MUI `Archive` icon: already imported at line 27 (`import { Archive, ... }`)

  **Acceptance Criteria**:
  - [ ] Non-empty folders show Archive icon button on hover (next to Rename)
  - [ ] Empty folders show Delete icon button on hover (existing behavior preserved)
  - [ ] Archive icon button is `Archive` from MUI icons
  - [ ] `NoteListProps` includes `onArchiveFolder?: (folderId: string) => Promise<void>`
  - [ ] `FolderHeaderProps` includes `onArchive: () => void`
  - [ ] `cd frontend && npx tsc --noEmit` passes

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: Frontend compiles with FolderHeader changes
    Tool: Bash
    Preconditions: Task 3 completed
    Steps:
      1. Run: cd frontend && npx tsc --noEmit
      2. Assert: Exit code 0
    Expected Result: No type errors
    Evidence: TSC output captured
  ```

  **Commit**: YES
  - Message: `feat(sidebar): add archive button to folder headers for non-empty folders`
  - Files: `frontend/src/components/NoteList.tsx`
  - Pre-commit: `cd frontend && npx tsc --noEmit`

---

- [x] 6. ArchivedNoteContentDialog — Read-Only Content Preview Popup

  **What to do**:
  - Create new file `frontend/src/components/ArchivedNoteContentDialog.tsx`
  - Implement a MUI Dialog component that shows archived note content:
    - Props interface:
      ```typescript
      interface ArchivedNoteContentDialogProps {
        open: boolean;
        note: Note | null;
        onClose: () => void;
        onRestore: (noteId: string) => void;
        onDelete: (noteId: string) => void;
      }
      ```
    - Dialog should be large (maxWidth="lg", fullWidth)
    - DialogTitle: show note title, or contentHeader preview (italic) if no title, or "Empty Note"
    - DialogContent: 
      - Monaco Editor in READ-ONLY mode showing `note.content`
      - Language: `note.language` for syntax highlighting
      - Use the same editor settings pattern from `Editor.tsx` but with `readOnly: true`
      - Since Monaco Editor is heavy, load content on demand — when the dialog opens, call `LoadArchivedNote(note.id)` to get full content
      - Show a loading state while content is being fetched
    - DialogActions:
      - "Restore" button (primary, with Unarchive icon) — calls `onRestore(note.id)` then `onClose()`
      - "Delete" button (error color, with DeleteForever icon) — calls `onDelete(note.id)` then `onClose()`
      - "Close" button — calls `onClose()`
    - Follow the `MessageDialog` pattern for Dialog structure

  **Must NOT do**:
  - Do not allow editing in the dialog
  - Do not create a full-featured editor component — just Monaco in read-only mode
  - Do not add any state management beyond local dialog state (loading, loaded content)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Self-contained component following existing Dialog pattern
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: UI component creation with MUI Dialog

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 4, 5)
  - **Blocks**: Task 7
  - **Blocked By**: Task 3

  **References**:

  **Pattern References**:
  - `frontend/src/components/MessageDialog.tsx:1-68` — MUI Dialog pattern: Dialog, DialogTitle, DialogContent, DialogActions structure — follow this
  - `frontend/src/components/Editor.tsx` — Monaco Editor integration pattern — reference for read-only Monaco setup (use `editor.create` options with `readOnly: true`)
  
  **API/Type References**:
  - `frontend/src/types.ts:11-20` — `Note` type with `content`, `language`, `title`, `contentHeader`
  - `wailsjs/go/backend/App.js` — `LoadArchivedNote(id)` binding for fetching full content

  **External References**:
  - Monaco Editor read-only mode: `options: { readOnly: true, domReadOnly: true }`

  **Acceptance Criteria**:
  - [ ] `ArchivedNoteContentDialog.tsx` exists with correct interface
  - [ ] Dialog shows note title (or contentHeader fallback) in title bar
  - [ ] Monaco Editor renders in read-only mode with correct language
  - [ ] Content loaded via `LoadArchivedNote` on dialog open
  - [ ] Loading state shown while fetching
  - [ ] Restore button calls onRestore callback
  - [ ] Delete button calls onDelete callback  
  - [ ] Close button/backdrop click closes dialog
  - [ ] `cd frontend && npx tsc --noEmit` passes

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: Frontend compiles with new dialog component
    Tool: Bash
    Preconditions: Task 3 completed
    Steps:
      1. Run: cd frontend && npx tsc --noEmit
      2. Assert: Exit code 0
    Expected Result: New component type-checks
    Evidence: TSC output captured
  ```

  **Commit**: YES
  - Message: `feat(archive): add read-only content preview dialog for archived notes`
  - Files: `frontend/src/components/ArchivedNoteContentDialog.tsx`
  - Pre-commit: `cd frontend && npx tsc --noEmit`

---

- [x] 7. ArchivedNoteList Rewrite — Folder Structure, DnD, Content Popup Integration

  **What to do**:
  - Complete rewrite of `frontend/src/components/ArchivedNoteList.tsx`
  - This is the most complex frontend task. The new component must:

  **Props interface update**:
  ```typescript
  interface ArchivedNoteListProps {
    notes: Note[];
    folders: Folder[];
    archivedTopLevelOrder: TopLevelItem[];
    onUnarchive: (noteId: string) => void;
    onDelete: (noteId: string) => void;
    onDeleteAll: () => void;
    onClose: () => void;
    onUnarchiveFolder: (folderId: string) => void;
    onDeleteFolder: (folderId: string) => void;
    onUpdateArchivedTopLevelOrder: (order: TopLevelItem[]) => void;
  }
  ```

  **Layout** (replaces editor area, full-width view):
  - Header bar: Back button (ArrowBack), "Archived notes" title, "Delete all" button (existing)
  - Divider
  - Scrollable content area (SimpleBar) with folder structure:
    - Archived folders with their notes grouped inside (indented, like sidebar)
    - Unfiled archived notes (archived notes without folderId or whose folder is not archived)
    - Each item shows: title (or contentHeader fallback styled italic/0.6 opacity), modified time, action buttons

  **Folder display in archive**:
  - Archived folder header: folder icon, folder name, note count, expand/collapse toggle
  - Action buttons on folder header (shown on hover):
    - Restore folder (Unarchive icon) — calls `onUnarchiveFolder`
    - Delete folder (DeleteForever icon) — calls `onDeleteFolder`
  - Collapsed/expanded state: local state, not persisted

  **Note display in archive**:
  - Title display: use `getNoteTitle` pattern from NoteList.tsx
    - If note.title exists: show title
    - If no title but contentHeader exists: show contentHeader (first 30 chars, newlines→spaces), italic, 0.6 opacity
    - If neither: "Empty Note"
  - Modified time below title
  - Action buttons (hover):
    - Restore (Unarchive icon) — calls `onUnarchive`
    - Delete (DeleteForever icon) — calls `onDelete`
  - **Clicking the note item** (not action buttons) opens the ArchivedNoteContentDialog

  **DnD reordering**:
  - Use `@dnd-kit/core` and `@dnd-kit/sortable` following existing NoteList patterns
  - Build `flatItems` array from `archivedTopLevelOrder`:
    - For each folder: add `folder:{id}`, then if expanded, add `folder-note:{noteId}` for each note in that folder
    - For each unfiled note: add `note:{id}`
  - SortableContext with verticalListSortingStrategy
  - DragOverlay for visual feedback
  - On drag end: update `archivedTopLevelOrder` via `onUpdateArchivedTopLevelOrder`
  - Simpler DnD than sidebar: only reorder top-level items, reorder notes within folders. NO moving notes between folders in archive view.
  - Use `restrictToVerticalAxis` modifier

  **Content popup integration**:
  - Local state: `selectedNote: Note | null` for which note's popup is open
  - Render `ArchivedNoteContentDialog` with selected note
  - On note item click (not action buttons): set selectedNote
  - Dialog onRestore → call `onUnarchive`, close dialog
  - Dialog onDelete → call `onDelete`, close dialog

  **Must NOT do**:
  - Do not allow moving notes between folders in archive DnD (only reorder)
  - Do not allow editing archived notes
  - Do not add archive/unarchive for individual notes within the list (only via popup or inline buttons)
  - Do not change the "Delete all" behavior
  - Do not implement DnD complexity matching the sidebar (no folder-boundary indentation logic needed)

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: Complex UI component with DnD, folder structure, popup integration, following existing design patterns
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: Complex React component with MUI and dnd-kit integration

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on Tasks 4 and 6)
  - **Parallel Group**: Wave 4 (solo)
  - **Blocks**: Task 8
  - **Blocked By**: Tasks 4, 6

  **References**:

  **Pattern References**:
  - `frontend/src/components/ArchivedNoteList.tsx:1-168` — Current implementation to rewrite — preserve header layout pattern (back button, title, delete all button)
  - `frontend/src/components/NoteList.tsx:295-331` — `SortableWrapper` component — reuse/copy for archive DnD
  - `frontend/src/components/NoteList.tsx:475-786` — NoteList DnD setup: sensors, SortableContext, flatItems generation — simplified version for archive
  - `frontend/src/components/NoteList.tsx:522-547` — `getNoteTitle` function — copy/adapt for archive (use contentHeader for archived notes)
  - `frontend/src/components/NoteList.tsx:345-473` — FolderHeader component — reference for archived folder header design (simpler version without rename/DnD)
  - `frontend/src/components/NoteList.tsx:84-274` — NoteItem component — reference for note display pattern

  **API/Type References**:
  - `frontend/src/types.ts:1-4` — `TopLevelItem` type for archivedTopLevelOrder
  - `frontend/src/types.ts:6-9` — `Folder` type (now with `archived?: boolean`)
  - `frontend/src/types.ts:11-20` — `Note` type
  - `frontend/src/components/ArchivedNoteContentDialog.tsx` — The popup component (from Task 6)

  **External References**:
  - `@dnd-kit/core` — DndContext, DragEndEvent, useSortable, SortableContext
  - `@dnd-kit/sortable` — arrayMove, verticalListSortingStrategy
  - `simplebar-react` — Used for scrollable content

  **Acceptance Criteria**:
  - [ ] ArchivedNoteList shows archived folders with their notes grouped inside
  - [ ] ArchivedNoteList shows unfiled archived notes separately
  - [ ] Folder headers show name, note count, expand/collapse, restore/delete buttons
  - [ ] Note items show title (or contentHeader fallback with italic/0.6 opacity)
  - [ ] Clicking a note opens ArchivedNoteContentDialog
  - [ ] DnD reorders top-level items and intra-folder notes
  - [ ] "Delete all" button still works
  - [ ] Back button closes archive view
  - [ ] `cd frontend && npx tsc --noEmit` passes

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: Frontend compiles with rewritten ArchivedNoteList
    Tool: Bash
    Preconditions: Tasks 4, 6 completed
    Steps:
      1. Run: cd frontend && npx tsc --noEmit
      2. Assert: Exit code 0
    Expected Result: Full component tree type-checks
    Evidence: TSC output captured

  Scenario: Archive page renders with archived items
    Tool: Playwright (playwright skill)
    Preconditions: App running with at least 1 archived note and 1 archived folder
    Steps:
      1. Navigate to app
      2. Click the "Archives" button at bottom of sidebar
      3. Wait for archive page to render (timeout: 5s)
      4. Assert: "Archived notes" heading visible
      5. Assert: At least one archived folder header visible (has folder icon)
      6. Assert: At least one archived note item visible
      7. Screenshot: .sisyphus/evidence/task-7-archive-page.png
    Expected Result: Archive page renders with folder structure
    Evidence: .sisyphus/evidence/task-7-archive-page.png

  Scenario: Clicking archived note opens content dialog
    Tool: Playwright (playwright skill)
    Preconditions: Archive page open with at least 1 archived note
    Steps:
      1. Click on the first archived note item (not action buttons)
      2. Wait for MUI Dialog to appear (timeout: 5s)
      3. Assert: Dialog title contains note title or content preview
      4. Assert: Dialog has "Restore" button
      5. Assert: Dialog has "Delete" button
      6. Assert: Dialog has "Close" button
      7. Screenshot: .sisyphus/evidence/task-7-content-dialog.png
    Expected Result: Content preview dialog opens with correct content
    Evidence: .sisyphus/evidence/task-7-content-dialog.png

  Scenario: Unnamed note shows contentHeader preview
    Tool: Playwright (playwright skill)
    Preconditions: Archive page open with an archived note that has no title
    Steps:
      1. Find note item without a bold title
      2. Assert: Note displays text in italic style (fontStyle: italic)
      3. Assert: Note text opacity is 0.6
      4. Screenshot: .sisyphus/evidence/task-7-unnamed-preview.png
    Expected Result: Unnamed note shows contentHeader with italic + reduced opacity
    Evidence: .sisyphus/evidence/task-7-unnamed-preview.png
  ```

  **Commit**: YES
  - Message: `feat(archive): rewrite archive page with folder structure, DnD reordering, and content popup`
  - Files: `frontend/src/components/ArchivedNoteList.tsx`
  - Pre-commit: `cd frontend && npx tsc --noEmit`

---

- [x] 8. App.tsx Integration — Wire Everything Together

  **What to do**:
  - In `frontend/src/App.tsx`:
    - Destructure new exports from `useNotes()`:
      - `archivedTopLevelOrder`, `handleArchiveFolder`, `handleUnarchiveFolder`, `handleDeleteArchivedFolder`, `handleUpdateArchivedTopLevelOrder`
    - Update `ArchivedNoteList` usage (around line 368-374) to pass new props:
      ```tsx
      <ArchivedNoteList
        notes={notes}
        folders={folders}
        archivedTopLevelOrder={archivedTopLevelOrder}
        onUnarchive={handleUnarchiveNote}
        onDelete={handleDeleteNote}
        onDeleteAll={handleDeleteAllArchivedNotes}
        onClose={() => setShowArchived(false)}
        onUnarchiveFolder={handleUnarchiveFolder}
        onDeleteFolder={handleDeleteArchivedFolder}
        onUpdateArchivedTopLevelOrder={handleUpdateArchivedTopLevelOrder}
      />
      ```
    - Update `NoteList` usage (around line 305-324) to pass `onArchiveFolder`:
      ```tsx
      onArchiveFolder={handleArchiveFolder}
      ```
    - Verify the Archives button count still works (counts both archived notes AND notes inside archived folders)

  **Must NOT do**:
  - Do not change any other App.tsx layout or functionality
  - Do not modify Editor, EditorStatusBar, AppBar, or other components
  - Do not change file mode behavior
  - Do not alter the sidebar width (242px) or STATUS_BAR_HEIGHT

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low`
    - Reason: Straightforward prop wiring, no complex logic
  - **Skills**: [`frontend-ui-ux`]

  **Parallelization**:
  - **Can Run In Parallel**: NO (final integration task)
  - **Parallel Group**: Wave 5 (solo, final)
  - **Blocks**: None (final task)
  - **Blocked By**: Tasks 5, 7

  **References**:

  **Pattern References**:
  - `frontend/src/App.tsx:41-69` — useNotes() destructuring — add new exports here
  - `frontend/src/App.tsx:367-374` — Current ArchivedNoteList usage — replace with new props
  - `frontend/src/App.tsx:305-324` — Current NoteList usage — add `onArchiveFolder` prop
  - `frontend/src/App.tsx:335-353` — Archives button in sidebar — verify count logic still works

  **Acceptance Criteria**:
  - [ ] ArchivedNoteList receives all new props (folders, archivedTopLevelOrder, folder operation callbacks)
  - [ ] NoteList receives `onArchiveFolder` prop
  - [ ] Archives button count reflects total archived items (notes + notes in archived folders)
  - [ ] `cd frontend && npx tsc --noEmit` passes
  - [ ] `cd frontend && npm run build` succeeds (full production build)

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: Full application builds successfully
    Tool: Bash
    Preconditions: All previous tasks completed
    Steps:
      1. Run: cd frontend && npm run build
      2. Assert: Exit code 0, no errors
      3. Run: go build ./backend/...
      4. Assert: Exit code 0
    Expected Result: Complete application builds without errors
    Evidence: Build output captured

  Scenario: End-to-end folder archive flow
    Tool: Playwright (playwright skill)
    Preconditions: App running, at least one folder with 2+ notes exists
    Steps:
      1. Navigate to app
      2. Hover over a non-empty folder header in sidebar
      3. Assert: Archive icon button appears on hover
      4. Click the Archive icon button
      5. Assert: Folder disappears from sidebar
      6. Click "Archives" button at bottom of sidebar
      7. Assert: Archive page shows the archived folder with its notes
      8. Screenshot: .sisyphus/evidence/task-8-folder-archived.png
    Expected Result: Folder and notes moved to archive, visible in archive page
    Evidence: .sisyphus/evidence/task-8-folder-archived.png

  Scenario: End-to-end folder restore flow
    Tool: Playwright (playwright skill)
    Preconditions: Archive page open with an archived folder
    Steps:
      1. Find the archived folder header in archive page
      2. Hover to reveal action buttons
      3. Click the Restore (Unarchive) button on the folder
      4. Assert: Archive page updates (folder removed from archive)
      5. Assert: Sidebar shows the restored folder at the bottom
      6. Screenshot: .sisyphus/evidence/task-8-folder-restored.png
    Expected Result: Folder and all notes restored to sidebar
    Evidence: .sisyphus/evidence/task-8-folder-restored.png

  Scenario: Content popup shows correct content
    Tool: Playwright (playwright skill)
    Preconditions: Archive page with an archived note
    Steps:
      1. Click on an archived note item
      2. Wait for dialog to open (timeout: 5s)
      3. Assert: Monaco editor visible in dialog (read-only)
      4. Assert: Note content matches expected text
      5. Click "Close" button
      6. Assert: Dialog closes
      7. Screenshot: .sisyphus/evidence/task-8-popup-content.png
    Expected Result: Read-only popup shows note content with syntax highlighting
    Evidence: .sisyphus/evidence/task-8-popup-content.png

  Scenario: Empty folder shows delete (not archive) in sidebar
    Tool: Playwright (playwright skill)
    Preconditions: App running, an empty folder exists in sidebar
    Steps:
      1. Hover over the empty folder header
      2. Assert: Delete icon button visible (NOT Archive icon)
      3. Screenshot: .sisyphus/evidence/task-8-empty-folder-delete.png
    Expected Result: Empty folder shows delete button, not archive button
    Evidence: .sisyphus/evidence/task-8-empty-folder-delete.png

  Scenario: Archives button count is accurate
    Tool: Playwright (playwright skill)
    Preconditions: App running, known number of archived notes/folders
    Steps:
      1. Count total archived notes in sidebar's Archives button text
      2. Assert: Count matches expected total (individual + in-folder archived notes)
      3. Screenshot: .sisyphus/evidence/task-8-archive-count.png
    Expected Result: Count accurately reflects all archived notes
    Evidence: .sisyphus/evidence/task-8-archive-count.png
  ```

  **Commit**: YES
  - Message: `feat(app): integrate archive overhaul - wire folder archive props to components`
  - Files: `frontend/src/App.tsx`
  - Pre-commit: `cd frontend && npm run build`

---

## Commit Strategy

| After Task | Message | Key Files | Verification |
|------------|---------|-----------|--------------|
| 1 | `feat(domain): add Folder.Archived and ArchivedTopLevelOrder to data model` | domain.go, types.ts | `go build` + `tsc` |
| 2 | `feat(backend): add folder archive/unarchive/delete service methods` | note_service.go | `go build` + `go vet` |
| 3 | `feat(bindings): expose folder archive APIs as Wails bindings` | app.go, wailsjs/* | `wails generate module` |
| 4 | `feat(hooks): add folder archive handlers and archivedTopLevelOrder state` | useNotes.ts | `tsc --noEmit` |
| 5 | `feat(sidebar): add archive button to folder headers` | NoteList.tsx | `tsc --noEmit` |
| 6 | `feat(archive): add read-only content preview dialog` | ArchivedNoteContentDialog.tsx | `tsc --noEmit` |
| 7 | `feat(archive): rewrite archive page with folder structure and DnD` | ArchivedNoteList.tsx | `tsc --noEmit` |
| 8 | `feat(app): integrate archive overhaul` | App.tsx | `npm run build` |

---

## Success Criteria

### Verification Commands
```bash
# Backend compiles
go build ./backend/...      # Expected: clean build, exit 0
go vet ./backend/...        # Expected: no warnings, exit 0

# Bindings generated
wails generate module       # Expected: clean generation, exit 0

# Frontend compiles and builds
cd frontend && npx tsc --noEmit   # Expected: no type errors
cd frontend && npm run build      # Expected: successful production build
```

### Final Checklist
- [x] All "Must Have" present (folder archiving, restore, delete, DnD, popup, contentHeader display)
- [x] All "Must NOT Have" absent (no nested folders, no editing in popup, no new deps, no Drive auth changes)
- [x] Backend compiles without errors
- [x] Frontend builds without errors
- [x] Existing noteList.json files load without error (backward compatibility)
- [x] Individual note archive/unarchive still works as before
- [x] Google Drive sync handles new fields
