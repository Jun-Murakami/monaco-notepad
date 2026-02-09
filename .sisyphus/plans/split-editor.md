# Split Editor with Dual Monaco Instances

## TL;DR

> **Quick Summary**: Implement a split editor view with two independent Monaco Editor instances, allowing users to view and edit two documents simultaneously with resizable panes, focus-based sidebar routing, and complementary theme colors for visual distinction.
> 
> **Deliverables**:
> - Complementary secondary theme colors computed from primary
> - Multi-instance Monaco Editor support (replacing singleton)
> - Left/right split panes using `allotment` library
> - Dual title + language controls in AppBar when split
> - Split toggle button in AppBar
> - Primary/secondary colored sidebar selection for left/right editors
> - Focus-based note routing from sidebar to active editor
> - EditorStatusBar reflecting focused editor
> 
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 3 waves
> **Critical Path**: Task 1 (theme) + Task 2 (monaco multi-instance) → Task 3 (Editor.tsx) → Task 4 (useSplitEditor hook) → Task 5-7 (AppBar, NoteList, App.tsx) → Task 8 (StatusBar + integration)

---

## Context

### Original Request
Implement a comprehensive Split Editor feature with dual Monaco instances. The user wants left/right split view with two documents open simultaneously, resizable via the `allotment` library, with visual distinction via complementary theme colors and dual selection in the sidebar.

### Interview Summary
**Key Discussions**:
- Theme: Compute complementary colors from existing primary palette (`#00c1d9` light, `#01afc6` dark)
- Monaco: Refactor singleton `_editorInstance` pattern to support multiple independent instances
- Split UX: Focus-based sidebar routing — clicking a note opens it in whichever editor has focus
- AppBar: When split, show dual title/language controls; split toggle button left of cloud sync
- NoteList: Two simultaneous selections — primary color for left editor, secondary for right
- Allotment: Use `allotment` npm package for resizable split panes with `minSize`

### Self-Review (Metis Unavailable)
**Identified Gaps** (addressed):
- **Auto-save with dual notes**: Both left and right notes need independent auto-save. Addressed in Task 4 design.
- **Keyboard shortcut routing**: Shortcuts (Ctrl+N, Ctrl+O, etc.) registered per editor instance already work since each Editor registers its own. No change needed — they fire from the focused editor.
- **Same note in both panes**: Need to decide behavior. Defaulting to: allowed (same note can be in both panes, with shared Monaco model).
- **beforeclose save**: Currently saves single `currentNote`. Must save both left and right notes on close.
- **Drive sync events (notes:reload)**: Must update both left and right if affected.
- **Tab navigation (Ctrl+Tab)**: Currently cycles through all notes. In split mode, should cycle within the focused editor's pane context. Addressed in Task 4.
- **EditorStatusBar**: Currently takes single `editorInstanceRef`. Must reflect the focused editor.
- **Search highlighting**: `noteSearch` currently highlights in single editor. In split mode, should highlight in whichever pane has the matching note.
- **File note handling**: Both panes can independently hold either a Note or FileNote.

---

## Work Objectives

### Core Objective
Add split editor functionality that allows two documents to be viewed and edited simultaneously in resizable left/right panes, with clear visual distinction and intuitive focus-based interaction.

### Concrete Deliverables
- Modified `frontend/src/lib/theme.ts` with computed complementary secondary colors
- Modified `frontend/src/lib/monaco.ts` with `createEditor()` replacing singleton
- Modified `frontend/src/components/Editor.tsx` supporting independent instances
- New `frontend/src/hooks/useSplitEditor.ts` managing split state, focus, dual notes
- Modified `frontend/src/components/AppBar.tsx` with split toggle + dual controls
- Modified `frontend/src/components/NoteList.tsx` with dual selection colors
- Modified `frontend/src/App.tsx` orchestrating split mode with allotment
- Modified `frontend/src/components/EditorStatusBar.tsx` for focused editor
- Modified `frontend/src/types.ts` with split-related types
- `allotment` package installed

### Definition of Done
- [ ] Split toggle button toggles between single and dual editor mode
- [ ] Both editors are independently functional (editing, language, title)
- [ ] Sidebar shows two selections with primary/secondary colors when split
- [ ] Clicking sidebar note opens in focused editor
- [ ] Allotment drag-to-resize works between panes
- [ ] Auto-save works for both editors independently
- [ ] Theme secondary colors are complementary to primary
- [ ] Existing tests pass (`npx vitest run`)
- [ ] Biome lint passes (`npx biome check`)
- [ ] No `as any`, `@ts-ignore`, `@ts-expect-error` in new code

### Must Have
- Two independently functional Monaco Editor instances
- Resizable split panes via allotment
- Focus tracking to route sidebar clicks
- Dual selection colors in sidebar
- Dual title/language in AppBar when split
- Split toggle button in AppBar (left of cloud sync)
- Auto-save for both editors

### Must NOT Have (Guardrails)
- NO vertical split — only horizontal left/right split
- NO more than 2 editors — this is not a multi-tab/multi-pane system
- NO changes to backend Go code — this is purely frontend
- NO changes to Wails bindings or events API
- NO new npm packages beyond `allotment`
- NO `as any`, `@ts-ignore`, `@ts-expect-error` type escapes
- NO Context/Store introduction — maintain props drilling pattern
- NO breaking changes to existing single-editor mode behavior
- NO changes to DnD/folder/archive logic in NoteList
- AI slop: NO over-abstraction of the split state (keep it simple with a hook)
- AI slop: NO unnecessary re-renders from split state (use refs for focus tracking)

---

## Verification Strategy

> **UNIVERSAL RULE: ZERO HUMAN INTERVENTION**
>
> ALL tasks in this plan MUST be verifiable WITHOUT any human action.

### Test Decision
- **Infrastructure exists**: YES (Vitest + @testing-library/react)
- **Automated tests**: Tests-after (add tests for new hook, verify existing pass)
- **Framework**: Vitest

### Agent-Executed QA Scenarios (MANDATORY — ALL tasks)

Verification tools:
| Type | Tool | How Agent Verifies |
|------|------|-------------------|
| Frontend/UI | Playwright (playwright skill) | Navigate, interact, assert DOM, screenshot |
| Build/Lint | Bash | `npx vitest run`, `npx biome check` |
| Library/Module | Bash (node/bun) | Import, call functions, check output |

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — independent foundations):
├── Task 1: Theme complementary colors
├── Task 2: Monaco multi-instance refactor
└── Task 3: Install allotment + types.ts additions

Wave 2 (After Wave 1 — depends on Monaco refactor):
├── Task 4: Editor.tsx refactor for independent instances
└── Task 5: useSplitEditor hook

Wave 3 (After Wave 2 — UI integration):
├── Task 6: AppBar split toggle + dual controls
├── Task 7: NoteList dual selection colors
└── Task 8: App.tsx orchestration + allotment integration + EditorStatusBar

Wave 4 (After Wave 3 — final verification):
└── Task 9: Integration testing + existing test verification
```

### Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|------------|--------|---------------------|
| 1 | None | 8 | 2, 3 |
| 2 | None | 4, 5 | 1, 3 |
| 3 | None | 4, 5, 8 | 1, 2 |
| 4 | 2 | 5, 8 | 5 (partial) |
| 5 | 2, 3 | 6, 7, 8 | 4 |
| 6 | 5 | 8 | 7 |
| 7 | 5 | 8 | 6 |
| 8 | 1, 4, 5, 6, 7 | 9 | None |
| 9 | All | None | None (final) |

### Agent Dispatch Summary

| Wave | Tasks | Recommended Agents |
|------|-------|-------------------|
| 1 | 1, 2, 3 | 3 parallel: quick, quick, quick |
| 2 | 4, 5 | 2 sequential-ish: visual-engineering |
| 3 | 6, 7, 8 | visual-engineering (8 depends on 6,7) |
| 4 | 9 | quick (verification only) |

---

## TODOs

- [ ] 1. Compute Complementary Secondary Theme Colors

  **What to do**:
  - In `frontend/src/lib/theme.ts`, write a helper function `getComplementaryColor(hex: string): string` that computes the complementary color (180° hue rotation on HSL color wheel) of a given hex color
  - Replace the hardcoded `secondary.main` values:
    - Light theme: compute complementary of `#00c1d9` → should yield a warm orange/red tone
    - Dark theme: compute complementary of `#01afc6` → should yield a warm orange tone
  - Keep `error.main` values as they are (they serve a different semantic purpose), OR set them to the new secondary if they were previously identical to secondary
  - The function should: parse hex → convert to HSL → rotate hue by 180° → convert back to hex

  **Must NOT do**:
  - Do not change primary colors
  - Do not change MUI component overrides
  - Do not add external color libraries — implement the conversion inline

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single file change with clear algorithm (color math)
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: Color theory and theme expertise

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3)
  - **Blocks**: Task 8 (App.tsx integration uses theme)
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `frontend/src/lib/theme.ts:1-55` — Current theme definition with hardcoded secondary colors. Light secondary is `#d91900`, dark secondary is `#c95023`. Both `error.main` values match their respective secondary values.

  **API/Type References**:
  - MUI `createTheme()` palette structure — `palette.secondary.main` accepts hex string

  **External References**:
  - Complementary color algorithm: HSL hue rotation by 180°. Formula: `newHue = (hue + 180) % 360`

  **WHY Each Reference Matters**:
  - `theme.ts` is the only file to modify. The executor needs to see current hardcoded values and structure.
  - Note that `error.main` currently equals `secondary.main` in both themes — the executor should decide whether to keep error as-is or update it too (keep as-is is safer).

  **Acceptance Criteria**:
  - [ ] `getComplementaryColor('#00c1d9')` returns a hex color that is roughly 180° opposite on HSL wheel (warm orange-ish)
  - [ ] `getComplementaryColor('#01afc6')` returns a hex color that is roughly 180° opposite on HSL wheel
  - [ ] Light theme `secondary.main` uses computed complementary of `#00c1d9`
  - [ ] Dark theme `secondary.main` uses computed complementary of `#01afc6`
  - [ ] No `as any` or type escapes
  - [ ] `npx biome check frontend/src/lib/theme.ts` passes

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: Theme file builds without errors
    Tool: Bash
    Preconditions: In frontend/ directory
    Steps:
      1. Run: npx tsc --noEmit --project tsconfig.json
      2. Assert: exit code 0, no errors mentioning theme.ts
    Expected Result: TypeScript compilation succeeds
    Evidence: Terminal output captured

  Scenario: Complementary color is visually correct
    Tool: Bash (node one-liner)
    Preconditions: theme.ts exports or contains getComplementaryColor
    Steps:
      1. Read the computed secondary.main values from theme.ts source
      2. Verify light secondary is NOT #d91900 (old hardcoded value)
      3. Verify dark secondary is NOT #c95023 (old hardcoded value)
      4. Verify both are valid 6-digit hex colors
    Expected Result: New computed complementary colors in place
    Evidence: Grep output of secondary.main values
  ```

  **Commit**: YES (groups alone)
  - Message: `feat(theme): compute complementary secondary colors from primary`
  - Files: `frontend/src/lib/theme.ts`
  - Pre-commit: `cd frontend && npx biome check src/lib/theme.ts`

---

- [ ] 2. Refactor Monaco Editor from Singleton to Multi-Instance

  **What to do**:
  - In `frontend/src/lib/monaco.ts`, remove the singleton pattern:
    - Remove the `_editorInstance` global variable
    - Remove `getOrCreateEditor()` function
    - Remove `disposeEditor()` function
    - Add a new `createEditor(container: HTMLElement, options: monaco.editor.IStandaloneEditorConstructionOptions): monaco.editor.IStandaloneCodeEditor` function that simply creates and returns a new editor instance every time
    - Add a new `disposeEditorInstance(instance: monaco.editor.IStandaloneCodeEditor): void` function that disposes a specific instance
  - Keep all other functions unchanged: `getMonaco()`, `getSupportedLanguages()`, `getLanguageByExtension()`, `getExtensionByLanguage()`, theme-related code
  - The Monaco module initialization (`initializeMonaco`) stays as-is (singleton init is fine — it's the editor instances that need to be multi)

  **Must NOT do**:
  - Do not change the Monaco initialization logic (workers, TypeScript config, theme registration)
  - Do not change language helper functions
  - Do not remove the `monaco` named export
  - Do not introduce a Map/registry for tracking instances (the components own their refs)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small refactor of a single module with clear before/after
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: Monaco Editor API knowledge

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3)
  - **Blocks**: Task 4 (Editor.tsx needs new API)
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `frontend/src/lib/monaco.ts:193-214` — Current singleton pattern: `_editorInstance` global, `getOrCreateEditor()` checks if instance exists, `disposeEditor()` disposes the single instance. This entire section must be replaced.
  - `frontend/src/lib/monaco.ts:78-141` — `initializeMonaco()` function. This MUST stay unchanged. It's correctly a singleton (one-time setup for workers, TypeScript config, themes).
  - `frontend/src/lib/monaco.ts:144-152` — `getMonaco()` function. This MUST stay unchanged.

  **API/Type References**:
  - `monaco.editor.create(container, options)` — The underlying Monaco API for creating editor instances. Currently called inside `getOrCreateEditor()`. The new `createEditor()` should just wrap this.
  - `monaco.editor.IStandaloneCodeEditor` — The type for editor instances. Used in `Editor.tsx` refs.

  **Test References**:
  - Existing tests mock Monaco via `vi.mock` in test setup. The mock needs to export `createEditor` and `disposeEditorInstance` instead of old names.

  **WHY Each Reference Matters**:
  - Lines 193-214 are the exact code being replaced — executor needs to see the before state
  - Lines 78-152 must NOT be touched — executor needs to know what to preserve
  - Test setup file may need mock name updates to match new exports

  **Acceptance Criteria**:
  - [ ] `_editorInstance` global variable removed
  - [ ] `getOrCreateEditor()` function removed
  - [ ] `disposeEditor()` function removed
  - [ ] `createEditor()` function exists and returns `monaco.editor.IStandaloneCodeEditor`
  - [ ] `disposeEditorInstance()` function exists and accepts an instance parameter
  - [ ] `getMonaco()`, `getSupportedLanguages()`, language helpers unchanged
  - [ ] No `as any` or type escapes (existing `as any` in theme registration is acceptable — it's pre-existing)
  - [ ] TypeScript compiles: `npx tsc --noEmit`

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: Monaco module exports correct functions
    Tool: Bash (grep)
    Preconditions: monaco.ts has been modified
    Steps:
      1. Grep for "export const createEditor" in monaco.ts → found
      2. Grep for "export const disposeEditorInstance" in monaco.ts → found
      3. Grep for "getOrCreateEditor" in monaco.ts → NOT found
      4. Grep for "let _editorInstance" in monaco.ts → NOT found
      5. Grep for "export const disposeEditor " in monaco.ts → NOT found (note trailing space to avoid matching disposeEditorInstance)
    Expected Result: Old singleton API removed, new multi-instance API present
    Evidence: Grep output captured

  Scenario: TypeScript compilation succeeds
    Tool: Bash
    Preconditions: frontend directory
    Steps:
      1. Run: cd frontend && npx tsc --noEmit
      2. Assert: exit code 0 (note: there may be pre-existing errors in other files from removed imports — those are addressed in Task 4)
    Expected Result: No new TypeScript errors from monaco.ts itself
    Evidence: Terminal output
  ```

  **Commit**: YES (groups alone)
  - Message: `refactor(monaco): replace singleton with multi-instance createEditor API`
  - Files: `frontend/src/lib/monaco.ts`
  - Pre-commit: `cd frontend && npx biome check src/lib/monaco.ts`

---

- [ ] 3. Install Allotment + Add Split-Related Types

  **What to do**:
  - Install `allotment` package: `npm install allotment` in `frontend/`
  - In `frontend/src/types.ts`, add new types for split editor state:
    ```typescript
    export type EditorPane = 'left' | 'right';
    
    export type PaneState = {
      note: Note | null;
      fileNote: FileNote | null;
    };
    ```
  - Verify allotment CSS import will work: `import "allotment/dist/style.css"`

  **Must NOT do**:
  - Do not modify any existing types
  - Do not add allotment-related components yet (that's Task 8)
  - Do not install any packages besides `allotment`

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Package install + small type additions
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: TypeScript type design

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2)
  - **Blocks**: Tasks 4, 5, 8
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `frontend/src/types.ts:1-78` — Current type definitions. New types should be added after existing types, before `DEFAULT_EDITOR_SETTINGS`. Follow existing naming conventions (PascalCase types, explicit field types).
  - `frontend/package.json:14-29` — Current dependencies. `allotment` goes in `dependencies` (not devDependencies).

  **External References**:
  - `allotment` npm package: https://github.com/johnwalley/allotment — React split pane component. Exports `Allotment` and `Allotment.Pane`.
  - CSS import: `import "allotment/dist/style.css"` must be added where Allotment is used (Task 8).

  **WHY Each Reference Matters**:
  - `types.ts` structure shows naming convention — executor should match it
  - `package.json` shows current deps — executor needs to install allotment alongside them

  **Acceptance Criteria**:
  - [ ] `allotment` appears in `frontend/package.json` dependencies
  - [ ] `EditorPane` type exported from `types.ts`
  - [ ] `PaneState` type exported from `types.ts` with `note: Note | null` and `fileNote: FileNote | null`
  - [ ] Existing types unchanged
  - [ ] `npm ls allotment` shows it installed
  - [ ] Biome check passes: `npx biome check src/types.ts`

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: Allotment package installed correctly
    Tool: Bash
    Preconditions: frontend directory
    Steps:
      1. Run: cd frontend && npm ls allotment
      2. Assert: output shows allotment with version number, no MISSING
      3. Run: node -e "require('allotment')"
      4. Assert: no error
    Expected Result: Package resolves correctly
    Evidence: Terminal output

  Scenario: Types compile correctly
    Tool: Bash
    Preconditions: types.ts modified
    Steps:
      1. Run: cd frontend && npx tsc --noEmit
      2. Assert: no errors from types.ts
    Expected Result: TypeScript accepts new types
    Evidence: Terminal output
  ```

  **Commit**: YES (groups alone)
  - Message: `feat(split-editor): install allotment and add split-related types`
  - Files: `frontend/package.json`, `frontend/package-lock.json`, `frontend/src/types.ts`
  - Pre-commit: `cd frontend && npx biome check src/types.ts`

---

- [ ] 4. Refactor Editor.tsx for Independent Multi-Instance Support

  **What to do**:
  - Update imports in `Editor.tsx`: replace `getOrCreateEditor` / `disposeEditor` with `createEditor` / `disposeEditorInstance` from `../lib/monaco`
  - Modify the editor initialization `useEffect`:
    - Call `createEditor(container, options)` to create a NEW instance (not singleton)
    - Store in `editorInstanceRef.current`
    - On cleanup, call `disposeEditorInstance(editorInstanceRef.current)` and set ref to null
  - Add an `onFocus` callback prop to `EditorProps` interface — this will be called when the editor gains focus. Use `editor.onDidFocusEditorText()` to detect focus.
  - All other useEffects (model switching, language change, settings, keyboard shortcuts, search) remain structurally the same — they already operate on `editorInstanceRef.current` which is correct for multi-instance.
  - The key insight: each `<Editor>` component now creates its own independent Monaco editor. When two `<Editor>` components mount, two separate instances exist.

  **Must NOT do**:
  - Do not change the model management pattern (`inmemory://{id}` URIs) — Monaco models are global and shared, which is fine
  - Do not change keyboard shortcut registration logic
  - Do not change the search/highlight logic
  - Do not add split-awareness to Editor.tsx — it should remain a pure, reusable editor component

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: Core UI component refactor with Monaco Editor integration
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: Monaco Editor lifecycle, React ref management

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on Task 2)
  - **Parallel Group**: Wave 2 (can start alongside Task 5 once Task 2 is done)
  - **Blocks**: Task 8 (App.tsx integration)
  - **Blocked By**: Task 2 (Monaco multi-instance API)

  **References**:

  **Pattern References**:
  - `frontend/src/components/Editor.tsx:1-292` — Entire file. Key areas:
    - Lines 4-9: Imports — must update `getOrCreateEditor`→`createEditor`, `disposeEditor`→`disposeEditorInstance`
    - Lines 12-29: `EditorProps` interface — add `onFocus?: () => void` prop
    - Lines 52-80: Editor initialization useEffect — change `getOrCreateEditor` to `createEditor`, change `disposeEditor()` to `disposeEditorInstance(editorInstanceRef.current)`
    - Lines 83-101: onChange listener — unchanged (already uses ref)
    - Lines 104-120: currentNote model switching — unchanged
    - Lines 150-177: settings/theme change — unchanged
    - Lines 180-272: keyboard shortcuts — unchanged

  **API/Type References**:
  - `monaco.editor.IStandaloneCodeEditor` — type for the ref, unchanged
  - `editor.onDidFocusEditorText()` — Monaco API to detect text area focus, returns disposable

  **WHY Each Reference Matters**:
  - Lines 4-9: exact import names that need changing
  - Lines 52-80: the initialization pattern that must be rewritten — executor must understand the before/after
  - `onDidFocusEditorText`: the specific Monaco event to use for focus tracking — more reliable than DOM focus events

  **Acceptance Criteria**:
  - [ ] `createEditor` imported instead of `getOrCreateEditor`
  - [ ] `disposeEditorInstance` imported instead of `disposeEditor`
  - [ ] Each `<Editor>` mount creates a new independent instance
  - [ ] Each `<Editor>` unmount disposes only its own instance
  - [ ] `onFocus` prop exists in `EditorProps` and is called on `onDidFocusEditorText`
  - [ ] `onFocus` disposable is cleaned up on unmount
  - [ ] TypeScript compiles without errors
  - [ ] Biome check passes

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: Editor.tsx compiles with new Monaco API
    Tool: Bash
    Preconditions: Tasks 2 and 4 complete
    Steps:
      1. Run: cd frontend && npx tsc --noEmit
      2. Assert: no errors in Editor.tsx
    Expected Result: Clean compilation
    Evidence: Terminal output

  Scenario: No references to old singleton API remain
    Tool: Bash (grep)
    Preconditions: Editor.tsx modified
    Steps:
      1. Grep for "getOrCreateEditor" in frontend/src/ → only in test mocks (if any)
      2. Grep for "disposeEditor(" in frontend/src/ (note: not disposeEditorInstance) → NOT found in non-test files
    Expected Result: Old API fully replaced
    Evidence: Grep output
  ```

  **Commit**: YES (groups alone)
  - Message: `refactor(editor): support independent multi-instance Monaco editors`
  - Files: `frontend/src/components/Editor.tsx`
  - Pre-commit: `cd frontend && npx biome check src/components/Editor.tsx`

---

- [ ] 5. Create useSplitEditor Hook

  **What to do**:
  - Create new file `frontend/src/hooks/useSplitEditor.ts`
  - This hook manages ALL split editor state and logic:
    
    **State**:
    - `isSplit: boolean` — whether split mode is active (default: false)
    - `leftNote: Note | null` — note in left pane
    - `leftFileNote: FileNote | null` — file note in left pane
    - `rightNote: Note | null` — note in right pane
    - `rightFileNote: FileNote | null` — file note in right pane
    - `focusedPane: EditorPane` — which pane has focus ('left' default)
    
    **Refs** (for performance — avoid re-renders on focus change):
    - `focusedPaneRef: React.MutableRefObject<EditorPane>` — updated immediately on focus, state updated in next tick
    
    **Computed**:
    - `activeNote` — the note in the focused pane (either left or right)
    - `activeFileNote` — the file note in the focused pane
    
    **Actions**:
    - `toggleSplit()` — toggle split mode. When enabling: right pane gets null (empty). When disabling: right pane content is discarded, left pane becomes the single editor.
    - `setFocusedPane(pane: EditorPane)` — called by Editor's onFocus callback
    - `handleSelectNoteForPane(note: Note | FileNote)` — routes note to focused pane. Sets note/fileNote for the focused pane, clears the other type in that pane. This replaces the current `handleSelecAnyNote` routing in split mode.
    - `setLeftNote`, `setRightNote`, `setLeftFileNote`, `setRightFileNote` — direct setters for integration
    
    **Integration with existing hooks**:
    - This hook does NOT replace `useNotes` or `useFileNotes` — it adds a layer on top
    - `useNotes.currentNote` and `useFileNotes.currentFileNote` continue to represent the "active" (focused) note for backwards compatibility with auto-save, events, etc.
    - The hook synchronizes: when focused pane changes, it updates `setCurrentNote`/`setCurrentFileNote` to match the focused pane's state

  **Must NOT do**:
  - Do not duplicate auto-save logic (that stays in useNotes)
  - Do not duplicate file modification tracking (stays in useFileNotes)
  - Do not add any UI concerns — this is pure state management
  - Do not use Context or any global state — return values from hook, pass via props

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: Core state management hook with complex interaction patterns
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: React hooks architecture, state management patterns

  **Parallelization**:
  - **Can Run In Parallel**: Partially with Task 4
  - **Parallel Group**: Wave 2
  - **Blocks**: Tasks 6, 7, 8
  - **Blocked By**: Tasks 2, 3 (needs EditorPane type + understanding of new Monaco API)

  **References**:

  **Pattern References**:
  - `frontend/src/hooks/useNoteSelecter.ts:1-97` — Current note selection routing pattern. `handleSelecAnyNote` checks `filePath in note` to determine if Note or FileNote. The new `handleSelectNoteForPane` must do the same check but route to the focused pane. This hook's pattern of receiving external setters and handlers is the pattern to follow.
  - `frontend/src/hooks/useNotes.ts:25-48` — State shape for notes: `currentNote`, `setCurrentNote`, `isNoteModified` ref, `previousContent` ref. The split hook must synchronize `currentNote` to match the focused pane's note.
  - `frontend/src/hooks/useFileNotes.ts:33-36` — State shape for file notes: `currentFileNote`, `setCurrentFileNote`. Same synchronization needed.
  - `frontend/src/App.tsx:117-131` — How `useNoteSelecter` is currently wired. The split hook will partially replace this routing.

  **API/Type References**:
  - `frontend/src/types.ts` — `EditorPane` type ('left' | 'right'), `PaneState` type (from Task 3)
  - `Note`, `FileNote` types from `types.ts`

  **WHY Each Reference Matters**:
  - `useNoteSelecter.ts` shows the EXACT routing pattern to replicate for split-awareness
  - `useNotes.ts` state shape shows what `currentNote`/`setCurrentNote` the split hook must synchronize with
  - `App.tsx` wiring shows how hooks connect — executor needs to understand integration point

  **Acceptance Criteria**:
  - [ ] `useSplitEditor.ts` created in `hooks/` directory
  - [ ] Exports: `isSplit`, `toggleSplit`, `focusedPane`, `setFocusedPane`, `leftNote`, `leftFileNote`, `rightNote`, `rightFileNote`, `activeNote`, `activeFileNote`, `handleSelectNoteForPane`, all setters
  - [ ] `toggleSplit()` correctly enables/disables split (right pane resets on disable)
  - [ ] `handleSelectNoteForPane()` routes Note vs FileNote to correct pane based on focus
  - [ ] Focus changes synchronize `currentNote`/`currentFileNote` with useNotes/useFileNotes
  - [ ] No `as any` or type escapes
  - [ ] TypeScript compiles
  - [ ] Biome check passes

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: Hook file exists and compiles
    Tool: Bash
    Preconditions: Task 5 complete
    Steps:
      1. Verify file exists: ls frontend/src/hooks/useSplitEditor.ts
      2. Run: cd frontend && npx tsc --noEmit
      3. Assert: no errors from useSplitEditor.ts
    Expected Result: Clean compilation
    Evidence: Terminal output

  Scenario: Hook exports correct interface
    Tool: Bash (grep)
    Preconditions: Hook file created
    Steps:
      1. Grep for "isSplit" in useSplitEditor.ts → found
      2. Grep for "toggleSplit" in useSplitEditor.ts → found
      3. Grep for "focusedPane" in useSplitEditor.ts → found
      4. Grep for "handleSelectNoteForPane" in useSplitEditor.ts → found
      5. Grep for "leftNote" in useSplitEditor.ts → found
      6. Grep for "rightNote" in useSplitEditor.ts → found
    Expected Result: All expected exports present
    Evidence: Grep output
  ```

  **Commit**: YES (groups alone)
  - Message: `feat(split-editor): add useSplitEditor hook for dual pane state management`
  - Files: `frontend/src/hooks/useSplitEditor.ts`
  - Pre-commit: `cd frontend && npx biome check src/hooks/useSplitEditor.ts`

---

- [ ] 6. AppBar: Split Toggle Button + Dual Title/Language Controls

  **What to do**:
  - Add new props to AppBar component:
    - `isSplit: boolean`
    - `onToggleSplit: () => void`
    - `rightNote: Note | FileNote | null` (the note in the right pane, for title/language display)
    - `onRightTitleChange: (title: string) => void`
    - `onRightLanguageChange: (language: string) => void`
    - `focusedPane: EditorPane` (to visually indicate which pane's controls are "active")
  - Add a split toggle `IconButton` to the LEFT of the sync status icon area (before the `<Box sx={{ ml: 0.5 }}>` that contains sync icons). Use MUI `VerticalSplit` icon from `@mui/icons-material`.
  - When `isSplit` is true:
    - The middle section (Title TextField + Language Select) should render TWICE: once for left pane, once for right pane
    - Layout: `[buttons] [left-title] [left-lang] | [right-title] [right-lang] [split-btn] [sync] [settings]`
    - The divider between left and right controls can be a subtle vertical `Divider`
    - Optionally: visually dim the non-focused pane's controls (e.g., 60% opacity) based on `focusedPane`
  - When `isSplit` is false: current single title/language layout unchanged
  - The split toggle button should have a tooltip: "Split Editor" / "Close Split"

  **Must NOT do**:
  - Do not change the New/Open/Save buttons section
  - Do not change the sync/logout/settings buttons section (only add split toggle before them)
  - Do not change `useDriveSync` integration
  - Do not change the AppBar height (56px) — fit dual controls within existing height

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: UI layout changes with conditional rendering and responsive design
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: MUI layout, conditional rendering, responsive controls

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Task 7)
  - **Blocks**: Task 8
  - **Blocked By**: Task 5 (needs split state types/contract)

  **References**:

  **Pattern References**:
  - `frontend/src/components/AppBar.tsx:29-57` — Current props interface. New props must be added here following the same pattern (typed inline, not extracted to a separate interface).
  - `frontend/src/components/AppBar.tsx:124-153` — Title TextField section. This is the section that must be conditionally duplicated for split mode. Note the `isFileNote()` helper for determining disabled state.
  - `frontend/src/components/AppBar.tsx:154-194` — Language Select section. Also must be conditionally duplicated.
  - `frontend/src/components/AppBar.tsx:196-230` — Sync status icons area. The split toggle button must be inserted BEFORE this `<Box>`.

  **API/Type References**:
  - `@mui/icons-material/VerticalSplit` — Icon for the split toggle button
  - `EditorPane` from `types.ts` — For the `focusedPane` prop type

  **WHY Each Reference Matters**:
  - Lines 29-57: Exact prop interface to extend — executor must add new props in this pattern
  - Lines 124-194: The title + language section to duplicate — executor needs to see exact MUI structure to replicate
  - Lines 196-230: Insertion point for split toggle — "left of the cloud sync button"

  **Acceptance Criteria**:
  - [ ] Split toggle button visible in AppBar, left of sync status
  - [ ] Clicking toggle button calls `onToggleSplit`
  - [ ] When `isSplit=true`: two Title fields and two Language selects visible
  - [ ] When `isSplit=false`: single Title field and single Language select (unchanged from current)
  - [ ] Right pane controls reflect `rightNote` data
  - [ ] Non-focused pane controls visually dimmed
  - [ ] Tooltip shows "Split Editor" when not split, "Close Split" when split
  - [ ] AppBar height remains 56px
  - [ ] No `as any` type escapes
  - [ ] Biome check passes

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: AppBar renders split toggle button
    Tool: Bash (grep)
    Preconditions: AppBar.tsx modified
    Steps:
      1. Grep for "VerticalSplit" in AppBar.tsx → found (icon import)
      2. Grep for "onToggleSplit" in AppBar.tsx → found (prop and onClick)
      3. Grep for "Split Editor" or "Close Split" in AppBar.tsx → found (tooltip)
    Expected Result: Split toggle elements present
    Evidence: Grep output

  Scenario: Dual controls conditional rendering
    Tool: Bash (grep)
    Preconditions: AppBar.tsx modified
    Steps:
      1. Grep for "isSplit" in AppBar.tsx → found (conditional rendering)
      2. Grep for "rightNote" in AppBar.tsx → found (right pane controls)
      3. Grep for "onRightTitleChange" in AppBar.tsx → found
      4. Grep for "onRightLanguageChange" in AppBar.tsx → found
    Expected Result: Dual control props and conditionals present
    Evidence: Grep output

  Scenario: TypeScript compiles
    Tool: Bash
    Steps:
      1. Run: cd frontend && npx tsc --noEmit
      2. Assert: no errors from AppBar.tsx
    Expected Result: Clean compilation
    Evidence: Terminal output
  ```

  **Commit**: YES (groups alone)
  - Message: `feat(appbar): add split toggle button and dual title/language controls`
  - Files: `frontend/src/components/AppBar.tsx`
  - Pre-commit: `cd frontend && npx biome check src/components/AppBar.tsx`

---

- [ ] 7. NoteList: Dual Selection with Primary/Secondary Colors

  **What to do**:
  - Add new props to `NoteListProps` interface:
    - `secondarySelectedNoteId?: string` — ID of the note selected in the "other" pane (for secondary color highlight)
  - In `NoteItem` component, add secondary selection styling:
    - Currently: `<ListItemButton selected={currentNote?.id === note.id}>` — this uses MUI default `selected` which applies primary color
    - Add: if `note.id === secondarySelectedNoteId`, apply secondary color background via `sx` prop
    - The secondary selection should use `theme.palette.secondary.main` with appropriate alpha for the background
    - Both selections can be active simultaneously (same note can be selected in both with primary taking precedence visually, or different notes)
  - The `sx` styling approach for secondary selection:
    ```typescript
    sx={{
      // ... existing styles
      ...(note.id === secondarySelectedNoteId && {
        backgroundColor: alpha(theme.palette.secondary.main, theme.palette.mode === 'dark' ? 0.16 : 0.12),
        '&:hover': {
          backgroundColor: alpha(theme.palette.secondary.main, theme.palette.mode === 'dark' ? 0.24 : 0.18),
        },
      }),
    }}
    ```
  - Pass `secondarySelectedNoteId` through to both NoteList instances in App.tsx (the Notes list and the FileNotes list)

  **Must NOT do**:
  - Do not change the DnD logic
  - Do not change the folder rendering logic
  - Do not change the NoteItem content layout (title, timestamp, action buttons)
  - Do not change the FolderHeader component
  - Do not override MUI's built-in `selected` styling for primary — only ADD secondary styling

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: Styling changes with conditional color application
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: MUI theming, conditional styles, color alpha

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Task 6)
  - **Blocks**: Task 8
  - **Blocked By**: Task 5 (needs to know what IDs to highlight), Task 1 (secondary color must be computed)

  **References**:

  **Pattern References**:
  - `frontend/src/components/NoteList.tsx:44-67` — `NoteListProps` interface. Add `secondarySelectedNoteId?: string` here.
  - `frontend/src/components/NoteList.tsx:69-84` — `NoteItemProps` interface. Add `secondarySelectedNoteId?: string` here too (it's passed through).
  - `frontend/src/components/NoteList.tsx:116-117` — Current selection: `<ListItemButton selected={currentNote?.id === note.id}>`. This is where secondary styling must be added.
  - `frontend/src/components/NoteList.tsx:602-617` — `renderNoteItem` function. Must pass `secondarySelectedNoteId` through to `NoteItem`.
  - `frontend/src/components/NoteList.tsx:37` — Already imports `useTheme` from MUI. Also need `alpha` from `@mui/material/styles` for color opacity.

  **API/Type References**:
  - `alpha()` from `@mui/material/styles` — utility to add alpha transparency to colors
  - `theme.palette.secondary.main` — the secondary color (will be complementary after Task 1)

  **WHY Each Reference Matters**:
  - Line 116-117: Exact location where secondary selection styling must be added
  - Lines 602-617: The render function that passes props to NoteItem — must add secondarySelectedNoteId
  - Line 37: Existing imports to extend — need to add `alpha` import

  **Acceptance Criteria**:
  - [ ] `NoteListProps` has `secondarySelectedNoteId?: string` prop
  - [ ] `NoteItemProps` has `secondarySelectedNoteId?: string` prop
  - [ ] When `secondarySelectedNoteId` matches a note, it gets secondary color background
  - [ ] When both `selected` (primary) and `secondarySelectedNoteId` match same note, primary wins (selected takes precedence)
  - [ ] Secondary color uses `theme.palette.secondary.main` with alpha
  - [ ] No changes to DnD, folders, or action buttons
  - [ ] Biome check passes
  - [ ] TypeScript compiles

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: Secondary selection prop added
    Tool: Bash (grep)
    Preconditions: NoteList.tsx modified
    Steps:
      1. Grep for "secondarySelectedNoteId" in NoteList.tsx → found multiple times
      2. Grep for "alpha" import in NoteList.tsx → found
      3. Grep for "secondary.main" in NoteList.tsx → found
    Expected Result: Secondary selection mechanism in place
    Evidence: Grep output

  Scenario: TypeScript compiles
    Tool: Bash
    Steps:
      1. Run: cd frontend && npx tsc --noEmit
      2. Assert: no errors from NoteList.tsx
    Expected Result: Clean compilation
    Evidence: Terminal output
  ```

  **Commit**: YES (groups alone)
  - Message: `feat(notelist): add secondary color selection for split editor right pane`
  - Files: `frontend/src/components/NoteList.tsx`
  - Pre-commit: `cd frontend && npx biome check src/components/NoteList.tsx`

---

- [ ] 8. App.tsx Orchestration + Allotment Integration + EditorStatusBar

  **What to do**:
  This is the integration task that wires everything together.

  **App.tsx changes**:
  - Import `allotment`: `import { Allotment } from "allotment"; import "allotment/dist/style.css";`
  - Import and use `useSplitEditor` hook
  - Add second `editorInstanceRef`: `const rightEditorInstanceRef = useRef<editor.IStandaloneCodeEditor | null>(null);`
  - Wire `useSplitEditor` into the component:
    - Pass `setCurrentNote`, `setCurrentFileNote` from useNotes/useFileNotes to useSplitEditor for synchronization
    - Use `isSplit` to conditionally render single or dual editor
    - Use `handleSelectNoteForPane` instead of `handleSelecAnyNote` when split mode is active
  - Replace the single `<Editor>` with an `<Allotment>` wrapper:
    ```tsx
    <Allotment>
      <Allotment.Pane minSize={200}>
        <Editor
          editorInstanceRef={leftEditorInstanceRef}
          currentNote={isSplit ? leftNote || leftFileNote : currentNote || currentFileNote}
          onFocus={() => setFocusedPane('left')}
          // ... other props for left pane
        />
      </Allotment.Pane>
      {isSplit && (
        <Allotment.Pane minSize={200}>
          <Editor
            editorInstanceRef={rightEditorInstanceRef}
            currentNote={rightNote || rightFileNote}
            onFocus={() => setFocusedPane('right')}
            // ... other props for right pane
          />
        </Allotment.Pane>
      )}
    </Allotment>
    ```
  - Wire AppBar new props: `isSplit`, `onToggleSplit`, `rightNote`, `onRightTitleChange`, `onRightLanguageChange`, `focusedPane`
  - Wire NoteList `secondarySelectedNoteId`: when split, pass the right pane's note ID as secondary for the Notes list, and similarly for the FileNotes list
  - Update `useNoteSelecter` usage: when split, route `handleSelecAnyNote` through split hook
  - Update `onFocusEditor` callback passed to AppBar: focus the correct editor based on `focusedPane`
  
  **EditorStatusBar changes** (`EditorStatusBar.tsx`):
  - Change `editorInstanceRef` prop to accept the currently focused editor's ref
  - In App.tsx, pass the focused editor ref: `editorInstanceRef={focusedPane === 'left' ? leftEditorInstanceRef : rightEditorInstanceRef}`
  - No changes to EditorStatusBar's internal logic needed — it already reads from whatever ref is passed

  **useNoteSelecter update** (`useNoteSelecter.ts`):
  - The hook needs to support split-aware routing. Add an optional parameter or adjust the integration:
    - Option A (simpler): In App.tsx, when split is active, intercept `handleSelecAnyNote` to route through `handleSelectNoteForPane` instead
    - Option B: Add split-awareness to the hook itself
  - Recommend Option A to minimize hook changes

  **Must NOT do**:
  - Do not change Archived view logic
  - Do not change the sidebar layout/structure (242px width, SimpleBar, etc.)
  - Do not change the drag-and-drop logic
  - Do not change the settings dialog
  - Do not change the message dialog
  - Do not introduce React Context — maintain props drilling

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: Complex integration task spanning multiple components with UI layout changes
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: React component integration, Allotment layout, state wiring

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (after Tasks 6, 7 complete)
  - **Blocks**: Task 9 (final verification)
  - **Blocked By**: Tasks 1, 4, 5, 6, 7 (all foundations must be in place)

  **References**:

  **Pattern References**:
  - `frontend/src/App.tsx:41-590` — Entire App component. Key integration points:
    - Lines 174: `editorInstanceRef` — add a second ref
    - Lines 117-131: `useNoteSelecter` wiring — intercept for split routing
    - Lines 325-337: `<AppBar>` — add new props
    - Lines 490-566: Editor area — wrap in `<Allotment>`, conditionally render second editor
    - Lines 526-561: Single `<Editor>` — becomes left editor, add right editor
    - Lines 562-565: `<EditorStatusBar>` — pass focused editor ref
    - Lines 387-401: FileNotes `<NoteList>` — add `secondarySelectedNoteId`
    - Lines 440-460: Notes `<NoteList>` — add `secondarySelectedNoteId`
  - `frontend/src/components/EditorStatusBar.tsx:25-28` — Props interface. May need no changes if we pass the correct ref from App.tsx.
  - `frontend/src/hooks/useNoteSelecter.ts:26-42` — `handleSelecAnyNote` function. Must be intercepted/wrapped for split mode.

  **External References**:
  - Allotment API: `<Allotment>` wraps panes, `<Allotment.Pane>` children with optional `minSize`, `maxSize`, `preferredSize`, `visible` props
  - CSS import required: `import "allotment/dist/style.css"`

  **WHY Each Reference Matters**:
  - App.tsx lines are the EXACT integration points — executor needs line numbers to know where to insert code
  - EditorStatusBar props show that the ref is already a prop — just pass the right one
  - useNoteSelecter shows the routing function to intercept

  **Acceptance Criteria**:
  - [ ] Allotment imported and CSS loaded
  - [ ] Single editor mode works identically to before (no visual/behavioral changes)
  - [ ] Split toggle creates two editor panes side by side
  - [ ] Left editor shows left pane's note, right editor shows right pane's note
  - [ ] Allotment drag handle visible between panes
  - [ ] Resizing panes works by dragging
  - [ ] Clicking sidebar note opens in focused editor pane
  - [ ] EditorStatusBar reflects focused editor's cursor/selection info
  - [ ] Both NoteList instances show secondary selection for right pane
  - [ ] AppBar shows dual controls when split
  - [ ] Toggling split off returns to single editor cleanly
  - [ ] `npx tsc --noEmit` succeeds
  - [ ] `npx biome check` passes for all modified files

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: App compiles and builds
    Tool: Bash
    Preconditions: All tasks 1-8 complete
    Steps:
      1. Run: cd frontend && npx tsc --noEmit
      2. Assert: exit code 0
      3. Run: cd frontend && npx vite build
      4. Assert: exit code 0, build succeeds
    Expected Result: Full build succeeds
    Evidence: Build output captured

  Scenario: Allotment integration in place
    Tool: Bash (grep)
    Preconditions: App.tsx modified
    Steps:
      1. Grep for 'import.*Allotment' in App.tsx → found
      2. Grep for 'allotment/dist/style.css' in App.tsx → found
      3. Grep for '<Allotment' in App.tsx → found
      4. Grep for 'Allotment.Pane' in App.tsx → found
      5. Grep for 'useSplitEditor' in App.tsx → found
      6. Grep for 'rightEditorInstanceRef' in App.tsx → found
    Expected Result: All split editor integrations present
    Evidence: Grep output

  Scenario: EditorStatusBar receives focused ref
    Tool: Bash (grep)
    Preconditions: App.tsx modified
    Steps:
      1. Grep for 'focusedPane.*left.*editorInstanceRef\|editorInstanceRef.*focusedPane' in App.tsx → found (conditional ref passing)
    Expected Result: StatusBar gets correct ref based on focus
    Evidence: Grep output
  ```

  **Commit**: YES (groups alone)
  - Message: `feat(split-editor): integrate allotment split panes with dual editors in App`
  - Files: `frontend/src/App.tsx`, `frontend/src/components/EditorStatusBar.tsx` (if changed)
  - Pre-commit: `cd frontend && npx tsc --noEmit && npx biome check src/App.tsx`

---

- [ ] 9. Integration Verification + Existing Test Fix-up

  **What to do**:
  - Run the full test suite: `cd frontend && npx vitest run`
  - Fix any broken tests due to:
    - Monaco mock changes (old `getOrCreateEditor`/`disposeEditor` → new `createEditor`/`disposeEditorInstance`)
    - New required props on components (AppBar, NoteList, Editor)
    - Changed import paths
  - Update test mocks in `frontend/src/test/setup.ts` (or wherever Monaco is mocked) to export new function names
  - Update component test files that render `<AppBar>`, `<NoteList>`, or `<Editor>` to pass new required props
  - Run Biome check on entire frontend: `npx biome check`
  - Run TypeScript check: `npx tsc --noEmit`
  - Optionally: Add a basic unit test for `useSplitEditor` hook testing toggle and focus state

  **Must NOT do**:
  - Do not delete existing tests
  - Do not skip failing tests
  - Do not add `@ts-ignore` to fix test compilation

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Test fix-up and verification, not new feature development
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: Vitest/RTL testing patterns, mock updates

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4 (final, sequential)
  - **Blocks**: None (final task)
  - **Blocked By**: All previous tasks (1-8)

  **References**:

  **Pattern References**:
  - `frontend/src/components/__tests__/` — Component test files. Tests for App, AppBar, Editor, NoteList will likely need prop updates.
  - `frontend/src/hooks/__test__/` — Hook test files. Tests for useNotes, useDriveSync, etc. should be unaffected.
  - Test setup files that mock Monaco — need to export `createEditor` and `disposeEditorInstance` instead of old names.

  **Test References**:
  - Existing test patterns use `vi.mock('../lib/monaco', ...)` — the mock must be updated to match new exports.
  - Component tests render with required props — new props need defaults in test renders.

  **WHY Each Reference Matters**:
  - Test directories contain the files that may break — executor needs to check each one
  - Mock patterns show how Monaco is faked in tests — must update function names

  **Acceptance Criteria**:
  - [ ] `npx vitest run` — all tests pass (0 failures)
  - [ ] `npx tsc --noEmit` — 0 errors
  - [ ] `npx biome check` — 0 errors (warnings acceptable if pre-existing)
  - [ ] No `@ts-ignore` or `@ts-expect-error` added to fix tests
  - [ ] All Monaco mocks export new function names

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: Full test suite passes
    Tool: Bash
    Preconditions: All tasks complete
    Steps:
      1. Run: cd frontend && npx vitest run
      2. Assert: exit code 0
      3. Assert: output shows "X passed" with 0 failures
    Expected Result: All existing + new tests pass
    Evidence: Full vitest output captured

  Scenario: TypeScript compilation clean
    Tool: Bash
    Steps:
      1. Run: cd frontend && npx tsc --noEmit
      2. Assert: exit code 0, no error output
    Expected Result: Zero compilation errors
    Evidence: Terminal output

  Scenario: Biome linting clean
    Tool: Bash
    Steps:
      1. Run: cd frontend && npx biome check
      2. Assert: exit code 0 or only pre-existing warnings
    Expected Result: No new lint errors
    Evidence: Terminal output

  Scenario: Full Vite build succeeds
    Tool: Bash
    Steps:
      1. Run: cd frontend && npx vite build
      2. Assert: exit code 0, build output generated
    Expected Result: Production build succeeds
    Evidence: Build output
  ```

  **Commit**: YES (groups alone)
  - Message: `test(split-editor): fix existing tests for multi-instance Monaco and new component props`
  - Files: Test files in `__tests__/` and `__test__/` directories, test setup files
  - Pre-commit: `cd frontend && npx vitest run`

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 1 | `feat(theme): compute complementary secondary colors from primary` | theme.ts | biome check |
| 2 | `refactor(monaco): replace singleton with multi-instance createEditor API` | monaco.ts | biome check |
| 3 | `feat(split-editor): install allotment and add split-related types` | package.json, types.ts | biome check |
| 4 | `refactor(editor): support independent multi-instance Monaco editors` | Editor.tsx | biome check |
| 5 | `feat(split-editor): add useSplitEditor hook for dual pane state management` | useSplitEditor.ts | biome check |
| 6 | `feat(appbar): add split toggle button and dual title/language controls` | AppBar.tsx | biome check |
| 7 | `feat(notelist): add secondary color selection for split editor right pane` | NoteList.tsx | biome check |
| 8 | `feat(split-editor): integrate allotment split panes with dual editors in App` | App.tsx, EditorStatusBar.tsx | tsc + biome |
| 9 | `test(split-editor): fix existing tests for multi-instance Monaco and new component props` | test files | vitest run |

---

## Success Criteria

### Verification Commands
```bash
cd frontend && npx tsc --noEmit           # Expected: 0 errors
cd frontend && npx vitest run             # Expected: all tests pass
cd frontend && npx biome check            # Expected: 0 errors
cd frontend && npx vite build             # Expected: successful build
```

### Final Checklist
- [ ] All "Must Have" requirements present
- [ ] All "Must NOT Have" guardrails respected
- [ ] Single editor mode behaves identically to pre-change
- [ ] Split mode creates two functional independent editors
- [ ] Focus tracking routes sidebar clicks correctly
- [ ] Theme secondary colors are computed complementary
- [ ] Dual selection in sidebar with primary/secondary colors
- [ ] AppBar shows dual controls when split
- [ ] Allotment resize works
- [ ] Auto-save works for both panes
- [ ] All tests pass
- [ ] Biome lint passes
- [ ] Vite build succeeds
