# Cross-Note Search Navigation Enhancement

## TL;DR

> **Quick Summary**: Enhance the sidebar search to count and navigate through every individual text occurrence across all notes, instead of just counting matching notes. Navigation arrows step through each match in order, auto-switching notes and selecting the exact match position in Monaco Editor.
> 
> **Deliverables**:
> - Modified `App.tsx`: Global match counting and flattened match index navigation
> - Modified `Editor.tsx`: Accept a match-index-within-note prop and select the correct occurrence
> - Consistent search experience: "TODO" appearing 3× in Note A and 2× in Note B shows "1/5" and arrows step through all 5
> 
> **Estimated Effort**: Short (2-3 focused tasks, ~1 hour of implementation)
> **Parallel Execution**: NO — sequential (Task 2 depends on Task 1, Task 3 depends on both)
> **Critical Path**: Task 1 → Task 2 → Task 3

---

## Context

### Original Request
Enhance sidebar search to navigate through ALL text occurrences across all notes, not just between matching notes. Match count should reflect total occurrences, and up/down arrows should step through each match in order, auto-switching notes and selecting the exact position in Monaco Editor.

### Interview Summary
**Key Details from Code Reading**:
- `App.tsx:150-186`: `orderedSearchMatches` builds array of matching `Note | FileNote` — one entry per note. `totalSearchMatches = orderedSearchMatches.length`
- `App.tsx:188-207`: `handleSearchNavigate` steps through `orderedSearchMatches` by index, calls `handleSelecAnyNote(target)`
- `Editor.tsx:123-136`: Search keyword effect calls `model.findMatches()` but always selects `matches[0]` — first match only
- `NoteSearchBox.tsx`: Pure UI — receives `matchIndex` and `matchCount`, renders `{matchIndex}/{matchCount}` and arrow buttons. No changes needed.
- `types.ts`: `Note.content: string | null`, `FileNote.content: string`
- `useNoteSelecter.ts`: `handleSelecAnyNote` correctly dispatches between Note and FileNote selection

**Design Decision — Title-Only Matches**:
- Current `filteredNotes` includes notes where the **title** matches the query (even if content doesn't contain the keyword)
- These notes should remain in the filtered sidebar list, but contribute 0 to the global match count (since there are no in-content occurrences to navigate to)
- Navigation arrows skip notes with 0 content matches — they only step through actual content occurrences that Monaco can select

**Design Decision — Case Sensitivity**:
- Current search is case-insensitive (uses `toLowerCase()`)
- Match counting must also be case-insensitive to stay consistent
- Monaco's `findMatches(keyword, true, false, false, null, true)` — the 4th parameter `false` = case-insensitive. This is already correct.

---

## Work Objectives

### Core Objective
Replace per-note match counting with per-occurrence match counting across all notes, and enable arrow navigation to step through each individual text occurrence — auto-switching notes and selecting the correct match in Monaco Editor.

### Concrete Deliverables
- `frontend/src/App.tsx`: New `useMemo` computing flattened global match list with per-occurrence granularity; updated `handleSearchNavigate`; new `searchMatchIndexInNote` state derived from global index
- `frontend/src/components/Editor.tsx`: New `searchMatchIndexInNote` prop; updated `useEffect` to select `matches[N]` instead of `matches[0]`

### Definition of Done
- [ ] Searching "TODO" when it appears 3× in Note A and 2× in Note B shows "1/5"
- [ ] Pressing down arrow 3 times in Note A cycles through matches 1→2→3 with Monaco selecting each one
- [ ] Pressing down arrow a 4th time auto-switches to Note B and selects its first match ("4/5")
- [ ] Pressing up arrow from Note B's first match goes back to Note A's last match ("3/5")
- [ ] Wrapping: from "5/5" pressing down goes to "1/5" (back to Note A's first match)
- [ ] Notes matching only in title still appear in filtered sidebar but have 0 navigable matches
- [ ] Empty/null content notes contribute 0 matches

### Must Have
- Global occurrence count displayed in search box
- Per-occurrence navigation with auto note switching
- Monaco selects the correct match (not always first)
- Case-insensitive matching consistent with current behavior
- Wrap-around navigation (last → first, first → last)

### Must NOT Have (Guardrails)
- Do NOT change `NoteSearchBox.tsx` — it's a pure UI component, its props interface already supports this
- Do NOT add highlight decorations for all matches (out of scope, can be a future enhancement)
- Do NOT change the sidebar filtering logic — notes matching by title should still appear in the sidebar
- Do NOT introduce regex search or case-sensitive toggle (out of scope)
- Do NOT create a new custom hook file — this logic fits cleanly in the existing App.tsx useMemo/useCallback pattern
- Do NOT change `useNoteSelecter.ts` — `handleSelecAnyNote` already works correctly

---

## Verification Strategy

> **UNIVERSAL RULE: ZERO HUMAN INTERVENTION**
> ALL verification is executed by the agent using tools.

### Test Decision
- **Infrastructure exists**: YES (Vitest + React Testing Library)
- **Automated tests**: NO — the match counting logic is a pure `useMemo` computation inside App.tsx; the key verification is behavioral (does Monaco select the right match?). Agent-Executed QA via Playwright is the primary verification method.
- **Framework**: Vitest (existing) — but no new unit tests required for this change

### Agent-Executed QA Scenarios (MANDATORY — ALL tasks)

Verification will be done via `wails dev` running the app, then Playwright browser automation against the dev window, plus code inspection via grep/read tools.

---

## Execution Strategy

### Sequential Execution (No Parallelism)

```
Task 1: Modify App.tsx — global match counting + navigation logic
    ↓
Task 2: Modify Editor.tsx — accept and use searchMatchIndexInNote prop  
    ↓
Task 3: Integration verification — end-to-end QA
```

### Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|------------|--------|---------------------|
| 1 | None | 2, 3 | None |
| 2 | 1 | 3 | None |
| 3 | 1, 2 | None | None (final) |

### Agent Dispatch Summary

| Wave | Tasks | Recommended Agents |
|------|-------|-------------------|
| 1 | 1, 2 | `delegate_task(category="quick", load_skills=["frontend-ui-ux"])` — can be combined as single task |
| 2 | 3 | `delegate_task(category="quick", load_skills=["playwright"])` — QA verification |

---

## TODOs

- [ ] 1. Refactor App.tsx: Global match counting and per-occurrence navigation

  **What to do**:

  **Step 1 — Replace `orderedSearchMatches` with a flattened global match list:**

  Current code (`App.tsx:166-186`):
  ```typescript
  const orderedSearchMatches = useMemo(() => {
    if (!noteSearch) return [];
    const activeFiltered = filteredNotes.filter((n) => !n.archived);
    // ... builds array of Note|FileNote, one per matching note
    return ordered;
  }, [noteSearch, filteredNotes, filteredFileNotes, topLevelOrder]);

  const totalSearchMatches = orderedSearchMatches.length;
  ```

  Replace with a new `useMemo` that returns a structure like:
  ```typescript
  type SearchMatch = {
    note: Note | FileNote;         // which note this match is in
    matchIndexInNote: number;      // 0-based index within that note's content matches
  };

  const { globalMatches, totalSearchMatches } = useMemo(() => {
    if (!noteSearch) return { globalMatches: [], totalSearchMatches: 0 };
    
    const q = noteSearch.toLowerCase();
    const matches: SearchMatch[] = [];
    
    // Helper: count occurrences of `q` in `text` (case-insensitive)
    const countMatches = (text: string | null): number => {
      if (!text) return 0;
      const lower = text.toLowerCase();
      let count = 0;
      let pos = 0;
      while ((pos = lower.indexOf(q, pos)) !== -1) {
        count++;
        pos += q.length; // non-overlapping, matches Monaco behavior
      }
      return count;
    };
    
    // Build ordered list of notes (same sidebar order as current orderedSearchMatches)
    const activeFiltered = filteredNotes.filter((n) => !n.archived);
    const filteredNoteSet = new Set(activeFiltered.map((n) => n.id));
    const filteredNoteMap = new Map(activeFiltered.map((n) => [n.id, n]));
    const orderedNotes: (Note | FileNote)[] = [...filteredFileNotes];
    for (const item of topLevelOrder) {
      if (item.type === 'note') {
        if (filteredNoteSet.has(item.id)) {
          const note = filteredNoteMap.get(item.id);
          if (note) orderedNotes.push(note);
        }
      } else if (item.type === 'folder') {
        const folderNotes = activeFiltered.filter((n) => n.folderId === item.id);
        orderedNotes.push(...folderNotes);
      }
    }
    
    // For each note in order, expand to per-occurrence entries
    for (const note of orderedNotes) {
      const content = 'filePath' in note ? note.content : note.content;
      const matchCount = countMatches(content);
      for (let i = 0; i < matchCount; i++) {
        matches.push({ note, matchIndexInNote: i });
      }
    }
    
    return { globalMatches: matches, totalSearchMatches: matches.length };
  }, [noteSearch, filteredNotes, filteredFileNotes, topLevelOrder]);
  ```

  **CRITICAL — `SearchMatch` type**: Define the `SearchMatch` type at the top of `App.tsx` (above the `App` function), NOT in `types.ts`. It's internal to App's search logic.

  **Step 2 — Update `handleSearchChange`:**

  Current (`App.tsx:188-191`):
  ```typescript
  const handleSearchChange = useCallback((value: string) => {
    setNoteSearch(value);
    setSearchMatchIndex(value ? 1 : 0);
  }, []);
  ```

  No structural change needed — `searchMatchIndex` remains 1-based. But now "1" means "first occurrence globally" not "first matching note".

  **Step 3 — Update `handleSearchNavigate`:**

  Current (`App.tsx:193-207`):
  ```typescript
  const handleSearchNavigate = useCallback(
    (direction: 'next' | 'prev') => {
      if (totalSearchMatches === 0) return;
      let newIndex = searchMatchIndex;
      if (direction === 'next') {
        newIndex = searchMatchIndex >= totalSearchMatches ? 1 : searchMatchIndex + 1;
      } else {
        newIndex = searchMatchIndex <= 1 ? totalSearchMatches : searchMatchIndex - 1;
      }
      setSearchMatchIndex(newIndex);
      const target = orderedSearchMatches[newIndex - 1];
      if (target) handleSelecAnyNote(target);
    },
    [totalSearchMatches, searchMatchIndex, orderedSearchMatches, handleSelecAnyNote],
  );
  ```

  Replace with:
  ```typescript
  const handleSearchNavigate = useCallback(
    (direction: 'next' | 'prev') => {
      if (totalSearchMatches === 0) return;
      let newIndex = searchMatchIndex;
      if (direction === 'next') {
        newIndex = searchMatchIndex >= totalSearchMatches ? 1 : searchMatchIndex + 1;
      } else {
        newIndex = searchMatchIndex <= 1 ? totalSearchMatches : searchMatchIndex - 1;
      }
      setSearchMatchIndex(newIndex);
      const match = globalMatches[newIndex - 1];
      if (match) handleSelecAnyNote(match.note);
    },
    [totalSearchMatches, searchMatchIndex, globalMatches, handleSelecAnyNote],
  );
  ```

  The key difference: `globalMatches[newIndex - 1]` gives us the `SearchMatch` object, and we call `handleSelecAnyNote(match.note)`. The note might be the SAME note as current (just a different match within it), or a different note.

  **Step 4 — Derive `searchMatchIndexInNote` for Editor prop:**

  Add after the `handleSearchNavigate`:
  ```typescript
  // 現在のグローバルインデックスに対応するノート内マッチインデックス
  const searchMatchIndexInNote = useMemo(() => {
    if (totalSearchMatches === 0 || searchMatchIndex === 0) return 0;
    const match = globalMatches[searchMatchIndex - 1];
    return match ? match.matchIndexInNote : 0;
  }, [globalMatches, searchMatchIndex, totalSearchMatches]);
  ```

  **Step 5 — Pass new prop to Editor:**

  Update the `<Editor>` JSX (around line 444-469) to add:
  ```typescript
  <Editor
    // ... existing props ...
    searchKeyword={noteSearch}
    searchMatchIndexInNote={searchMatchIndexInNote}  // NEW
    // ...
  />
  ```

  **Step 6 — Handle initial search navigation (when user first types a query):**
  
  When `handleSearchChange` sets `searchMatchIndex` to `1`, we also need to navigate to the first match's note. Add a `useEffect` that watches for `searchMatchIndex` changing to 1 when a new search is initiated:

  Actually, this is already handled: when the user types, `filteredNotes` changes → sidebar updates. But we need to auto-select the first match's note. Currently, the code doesn't auto-navigate on first search input.

  Check current behavior: `handleSearchChange` sets `searchMatchIndex(1)` but doesn't call `handleSelecAnyNote`. The user currently must press Enter/arrow to navigate. **Keep this behavior** — don't auto-switch notes on typing. The index display shows "1/5" and user presses Enter/arrow to go to first match. This is consistent with current UX.

  **Must NOT do**:
  - Do NOT remove `filteredNotes` or `filteredFileNotes` — they're still used for sidebar rendering
  - Do NOT change `NoteSearchBox` props or component
  - Do NOT auto-navigate on search input change (keep current behavior)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Scoped changes in a single file, clear instructions, straightforward logic
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: React/TypeScript component modification expertise

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential — Wave 1
  - **Blocks**: Task 2, Task 3
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `frontend/src/App.tsx:150-157` — `filteredNotes` useMemo: shows the existing case-insensitive filter pattern with `toLowerCase()`. The new `countMatches` helper must use the same case-insensitive approach.
  - `frontend/src/App.tsx:166-186` — `orderedSearchMatches` useMemo: THIS IS WHAT GETS REPLACED. Shows the current sidebar-order logic (fileNotes first, then topLevelOrder-based notes/folders). The new `globalMatches` must preserve this exact ordering.
  - `frontend/src/App.tsx:193-207` — `handleSearchNavigate`: THIS IS WHAT GETS MODIFIED. Shows the current wrap-around logic and `handleSelecAnyNote` call pattern.
  - `frontend/src/App.tsx:444-469` — `<Editor>` JSX: WHERE to add the new `searchMatchIndexInNote` prop.

  **API/Type References**:
  - `frontend/src/types.ts:12-21` — `Note` type: `content: string | null` — must handle null in match counting
  - `frontend/src/types.ts:42-50` — `FileNote` type: `content: string` — always has content
  - `frontend/src/types.ts:1-4` — `TopLevelItem` type: used for sidebar ordering

  **Behavioral References**:
  - `frontend/src/hooks/useNoteSelecter.ts:26-42` — `handleSelecAnyNote`: Distinguishes Note vs FileNote via `'filePath' in note`. The `SearchMatch.note` will be passed to this function, so it must remain a `Note | FileNote`.

  **Acceptance Criteria**:

  **Code-level verification (agent inspects the code):**
  - [ ] `SearchMatch` type defined at module level in `App.tsx`
  - [ ] `globalMatches` useMemo exists and returns `SearchMatch[]` with `{ note, matchIndexInNote }` entries
  - [ ] `totalSearchMatches` derived from `globalMatches.length` (not `orderedSearchMatches.length`)
  - [ ] `handleSearchNavigate` references `globalMatches[newIndex - 1].note` to select the target note
  - [ ] `searchMatchIndexInNote` derived from `globalMatches[searchMatchIndex - 1].matchIndexInNote`
  - [ ] `<Editor>` receives `searchMatchIndexInNote` prop
  - [ ] `filteredNotes` and `filteredFileNotes` useMemos remain unchanged (still used for sidebar rendering)
  - [ ] Match counting is case-insensitive (uses `toLowerCase()`)
  - [ ] Null content handled gracefully (0 matches)

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Code structure verification
    Tool: Bash (grep/read)
    Preconditions: Task 1 changes applied
    Steps:
      1. Read App.tsx, verify SearchMatch type exists
      2. Grep for "globalMatches" — should appear in useMemo, handleSearchNavigate, searchMatchIndexInNote
      3. Grep for "orderedSearchMatches" — should be REMOVED (or renamed)
      4. Grep for "searchMatchIndexInNote" — should appear as a useMemo and as a prop on <Editor>
      5. Verify totalSearchMatches = globalMatches.length
    Expected Result: All structural changes in place
    Evidence: Code snippets captured
  ```

  **Commit**: YES
  - Message: `feat(search): compute global match count across all notes`
  - Files: `frontend/src/App.tsx`
  - Pre-commit: `cd frontend && npx biome check src/App.tsx`

---

- [ ] 2. Update Editor.tsx: Select specific match by index

  **What to do**:

  **Step 1 — Add `searchMatchIndexInNote` to EditorProps:**

  Current interface (`Editor.tsx:12-28`):
  ```typescript
  interface EditorProps {
    // ...existing props...
    searchKeyword?: string;
    // ...
  }
  ```

  Add:
  ```typescript
  interface EditorProps {
    // ...existing props...
    searchKeyword?: string;
    searchMatchIndexInNote?: number;  // 0-based index of which match to select within this note
    // ...
  }
  ```

  **Step 2 — Destructure the new prop:**

  In the component destructuring (line 30-46), add `searchMatchIndexInNote` with default `0`:
  ```typescript
  export const Editor: React.FC<EditorProps> = ({
    // ...existing...
    searchKeyword,
    searchMatchIndexInNote = 0,
    // ...
  }) => {
  ```

  **Step 3 — Update the search keyword useEffect:**

  Current (`Editor.tsx:123-136`):
  ```typescript
  useEffect(() => {
    const editor = editorInstanceRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model || !searchKeyword) return;
    const matches = model.findMatches(searchKeyword, true, false, false, null, true);
    if (matches.length > 0) {
      editor.setSelection(matches[0].range);
      editor.revealRangeInCenter(matches[0].range);
    }
  }, [searchKeyword, currentNote, editorInstanceRef]);
  ```

  Replace with:
  ```typescript
  // 検索キーワードをエディタ内でハイライト・選択（指定されたマッチインデックスを使用）
  useEffect(() => {
    const editor = editorInstanceRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model || !searchKeyword) return;
    const matches = model.findMatches(searchKeyword, true, false, false, null, true);
    if (matches.length > 0) {
      // searchMatchIndexInNote が範囲外の場合は 0 にフォールバック
      const idx = searchMatchIndexInNote < matches.length ? searchMatchIndexInNote : 0;
      editor.setSelection(matches[idx].range);
      editor.revealRangeInCenter(matches[idx].range);
    }
  }, [searchKeyword, searchMatchIndexInNote, currentNote, editorInstanceRef]);
  ```

  **CRITICAL**: Add `searchMatchIndexInNote` to the dependency array! This ensures that when the user navigates to a different match within the SAME note, the effect re-fires and selects the correct match.

  **Must NOT do**:
  - Do NOT add highlight decorations for all matches (scope creep)
  - Do NOT change the `findMatches` parameters (case-insensitive behavior must stay consistent with App.tsx counting)
  - Do NOT modify any other useEffect in Editor.tsx

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small, surgical change in a single file — add 1 prop, modify 1 useEffect
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: React/TypeScript/Monaco Editor modification

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential — Wave 1 (after Task 1)
  - **Blocks**: Task 3
  - **Blocked By**: Task 1 (Editor needs the new prop that App.tsx passes)

  **References**:

  **Pattern References**:
  - `frontend/src/components/Editor.tsx:12-28` — `EditorProps` interface: WHERE to add the new prop
  - `frontend/src/components/Editor.tsx:30-46` — Component destructuring: WHERE to destructure the new prop
  - `frontend/src/components/Editor.tsx:123-136` — Search keyword useEffect: THIS IS WHAT GETS MODIFIED

  **API/Type References**:
  - Monaco `model.findMatches()` returns `FindMatch[]` where each has `.range` — use `matches[idx].range` instead of `matches[0].range`

  **Behavioral References**:
  - `frontend/src/App.tsx` (after Task 1) — passes `searchMatchIndexInNote` prop derived from `globalMatches`

  **Acceptance Criteria**:

  **Code-level verification:**
  - [ ] `searchMatchIndexInNote` added to `EditorProps` interface as `number` (optional, defaulting to 0)
  - [ ] `searchMatchIndexInNote` destructured in component params with default `= 0`
  - [ ] Search useEffect uses `matches[idx]` where `idx` accounts for bounds checking
  - [ ] `searchMatchIndexInNote` is in the useEffect dependency array
  - [ ] No other useEffects or functionality changed

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: Code structure verification
    Tool: Bash (grep/read)
    Preconditions: Task 2 changes applied
    Steps:
      1. Read Editor.tsx, verify EditorProps includes searchMatchIndexInNote
      2. Verify the search useEffect dependency array includes searchMatchIndexInNote
      3. Verify matches[idx] is used with bounds checking, not matches[0]
      4. Run: cd frontend && npx biome check src/components/Editor.tsx
    Expected Result: Prop added, useEffect updated, linter passes
    Evidence: Code snippets and biome output captured
  ```

  **Commit**: YES (group with Task 1)
  - Message: `feat(search): select specific match by index in editor`
  - Files: `frontend/src/components/Editor.tsx`
  - Pre-commit: `cd frontend && npx biome check src/components/Editor.tsx`

---

- [ ] 3. Integration verification: End-to-end QA

  **What to do**:
  
  **Step 1 — Build and lint check:**
  - Run `cd frontend && npx biome check src/App.tsx src/components/Editor.tsx` to verify no lint errors
  - Run `cd frontend && npx tsc --noEmit` to verify no TypeScript errors
  
  **Step 2 — Run existing tests:**
  - Run `cd frontend && npx vitest run` to ensure no regressions in existing tests

  **Step 3 — Manual code review via agent:**
  - Read final App.tsx and Editor.tsx
  - Verify the data flow: `noteSearch` → `globalMatches` (useMemo) → `searchMatchIndex` (state) → `searchMatchIndexInNote` (derived) → `<Editor searchMatchIndexInNote={...}>` → `matches[idx]`
  - Verify wrap-around logic in `handleSearchNavigate`
  - Verify null content handling in `countMatches`
  - Verify the sidebar still renders correctly (filteredNotes/filteredFileNotes unchanged)

  **Must NOT do**:
  - Do NOT modify any code in this task — verification only
  - Do NOT start `wails dev` (environment may not support it)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Verification-only task, no code changes
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: Can verify React/TypeScript patterns and data flow

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential — Wave 2 (final)
  - **Blocks**: None
  - **Blocked By**: Task 1, Task 2

  **References**:

  **Pattern References**:
  - `frontend/src/App.tsx` — Full file after Task 1 modifications
  - `frontend/src/components/Editor.tsx` — Full file after Task 2 modifications

  **Acceptance Criteria**:

  **Build verification:**
  - [ ] `cd frontend && npx biome check src/App.tsx src/components/Editor.tsx` — no errors
  - [ ] `cd frontend && npx tsc --noEmit` — no TypeScript compilation errors
  - [ ] `cd frontend && npx vitest run` — all existing tests pass

  **Agent-Executed QA Scenarios:**

  ```
  Scenario: TypeScript compilation check
    Tool: Bash
    Preconditions: Tasks 1 and 2 completed
    Steps:
      1. cd frontend && npx tsc --noEmit
      2. Assert: exit code 0
      3. Assert: no error output
    Expected Result: Clean TypeScript compilation
    Evidence: Command output captured

  Scenario: Biome lint check
    Tool: Bash
    Preconditions: Tasks 1 and 2 completed
    Steps:
      1. cd frontend && npx biome check src/App.tsx src/components/Editor.tsx
      2. Assert: exit code 0
    Expected Result: No lint or format violations
    Evidence: Command output captured

  Scenario: Existing test suite regression check
    Tool: Bash
    Preconditions: Tasks 1 and 2 completed
    Steps:
      1. cd frontend && npx vitest run
      2. Assert: all tests pass
      3. Assert: exit code 0
    Expected Result: Zero test failures
    Evidence: Test output captured

  Scenario: Data flow verification via code inspection
    Tool: Bash (read/grep)
    Preconditions: Tasks 1 and 2 completed
    Steps:
      1. Read App.tsx — verify globalMatches useMemo computes per-occurrence entries
      2. Verify searchMatchIndexInNote useMemo derives from globalMatches
      3. Read Editor.tsx — verify searchMatchIndexInNote in dependency array
      4. Verify Editor uses bounds-checked index: matches[idx] not matches[0]
      5. Verify NoteSearchBox.tsx is UNCHANGED
    Expected Result: Complete data flow from search input to Monaco selection
    Evidence: Code excerpts captured
  ```

  **Commit**: NO (verification only, no code changes)

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 1 + 2 (combined) | `feat(search): navigate through all text occurrences across notes` | `frontend/src/App.tsx`, `frontend/src/components/Editor.tsx` | `cd frontend && npx tsc --noEmit && npx biome check src/App.tsx src/components/Editor.tsx && npx vitest run` |

---

## Success Criteria

### Verification Commands
```bash
cd frontend && npx tsc --noEmit          # Expected: clean compilation
cd frontend && npx biome check src/      # Expected: no errors
cd frontend && npx vitest run            # Expected: all tests pass
```

### Final Checklist
- [ ] Global match count: 3 matches in Note A + 2 in Note B = "X/5" displayed
- [ ] Arrow navigation steps through each occurrence, not just each note
- [ ] Auto note-switching when navigating past last match in current note
- [ ] Monaco selects the correct match position (not always first)
- [ ] Wrap-around works: last→first, first→last
- [ ] Null content notes handled (0 matches)
- [ ] Title-only matching notes visible in sidebar but contribute 0 navigable matches
- [ ] `NoteSearchBox.tsx` unchanged
- [ ] `useNoteSelecter.ts` unchanged
- [ ] Existing tests pass
- [ ] No TypeScript errors
- [ ] Biome lint clean

### Edge Cases Covered
- Note with `content: null` → 0 matches, skipped in navigation
- Search query that matches title but not content → note in sidebar, 0 navigable matches
- Single character search → works (e.g., "a" in "banana" = 3 matches)
- Search with no results → "0/0" displayed, arrows disabled
- Only one match total → "1/1", arrows wrap to same match
- Same note with many matches → arrows stay on same note, cycle through matches
