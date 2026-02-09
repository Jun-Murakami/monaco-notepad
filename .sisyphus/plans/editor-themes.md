# Add User-Selectable Editor Themes

## TL;DR

> **Quick Summary**: Add editor theme selection using `monaco-themes` npm package with light/dark paired themes. When user toggles isDarkMode, the Monaco editor switches between light and dark variants of the selected theme pair.
> 
> **Deliverables**:
> - Theme pair definitions and registration system in `lib/monaco.ts`
> - New `editorTheme` setting persisted in Go backend + TypeScript frontend
> - Theme dropdown in Settings dialog
> - Editor applies correct theme variant based on `isDarkMode` + selected theme pair
> - Critical bug fix: remove `setTheme` override that disabled all theme switching
> 
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 2 waves
> **Critical Path**: Task 1 (npm install) → Task 2 (monaco.ts) → Task 3 (types) → Task 4 (Editor.tsx) / Task 5 (SettingsDialog) → Task 6 (Wails bindings)

---

## Context

### Original Request
Add user-selectable editor themes using `monaco-themes` npm package. Key design constraint: only themes available as light/dark pairs should be offered. When user toggles isDarkMode, the editor theme switches between the light and dark variant of the selected theme.

### Interview Summary
**Key Discussions**:
- 9 theme pairs identified: Default, GitHub, Solarized, Tomorrow, Clouds (natural light/dark pairs) + Monokai, Dracula, Nord, Night Owl (dark-only, paired with built-in `vs` for light mode)
- `ThemePair` type design: `{ id, label, light, dark }` where light/dark are Monaco theme names
- Critical bug found: `lib/monaco.ts` line 69 sets `_monaco.editor.setTheme = () => Promise.resolve()` which completely disables theme switching — must be removed
- New `editorTheme` field added to Settings with `"default"` as the default value
- Static imports of theme JSON files (16 files, ~50KB total — acceptable bundle impact)

**Research Findings**:
- `monaco-themes` package confirmed: `themes/themelist.json` maps IDs to filenames, JSON files at `monaco-themes/themes/{Filename}.json`
- Verified theme keys in the actual package: `github-dark`, `github-light`, `solarized-dark`, `solarized-light`, `tomorrow`, `tomorrow-night`, `clouds`, `clouds-midnight`, `monokai`, `dracula`, `nord`, `night-owl`
- Theme registration: `monaco.editor.defineTheme(name, data)` then apply via `monaco.editor.setTheme(name)`
- Go struct zero value for new `EditorTheme string` field is `""` — frontend maps empty string to `"default"`
- Line 70 `_monaco.editor.onDidCreateEditor` override is unrelated to themes (suppresses logging) — leave it

### Gap Analysis
**Identified Gaps (addressed)**:
- Theme registration timing: themes MUST be registered via `defineTheme()` BEFORE the editor uses them → registration happens in `initializeMonaco()`
- `updateOptions({theme:...})` vs `setTheme()`: current Editor.tsx uses `updateOptions` but `setTheme` is the proper global API → switch to `monaco.editor.setTheme()` for theme changes
- Backwards compatibility: existing `settings.json` files without `editorTheme` → Go deserializes as `""`, frontend treats as `"default"` theme pair
- Bundle size: 16 theme JSONs at ~2-5KB each ≈ ~50KB total, acceptable for static import
- MUI theme switching is separate and untouched — `ThemeProvider` still uses `lightTheme`/`darkTheme` based on `isDarkMode`

---

## Work Objectives

### Core Objective
Enable users to select from 9 curated editor theme pairs in Settings, where each pair has a light and dark variant that automatically switches when `isDarkMode` is toggled.

### Concrete Deliverables
- `monaco-themes` npm dependency installed
- Theme pair definitions + registration function in `frontend/src/lib/monaco.ts`
- `editorTheme` field in `Settings` type (TypeScript) and `Settings` struct (Go)
- Theme selector dropdown in `SettingsDialog.tsx`
- Theme application logic in `Editor.tsx` using `monaco.editor.setTheme()`
- Updated Wails bindings via `wails generate module`

### Definition of Done
- [ ] User can select a theme from Settings dialog dropdown
- [ ] Toggling isDarkMode switches between light/dark variant of selected theme
- [ ] Theme persists across app restarts (saved in settings.json)
- [ ] Default theme ("Default") renders as `vs`/`vs-dark` (identical to current behavior)
- [ ] Existing settings.json files without `editorTheme` field work without errors
- [ ] Existing tests continue to pass

### Must Have
- All 9 theme pairs functional
- Theme persistence via Settings
- Backwards compatibility with existing settings.json
- `setTheme` bug fix (line 69 removal)

### Must NOT Have (Guardrails)
- Do NOT add custom theme editor or theme import functionality
- Do NOT add per-note theme settings
- Do NOT add theme preview/live preview outside the normal settings flow (settings dialog already applies changes live via `onChange`)
- Do NOT lazy-load themes — static imports only
- Do NOT modify MUI theme switching logic (`lightTheme`/`darkTheme` in App.tsx)
- Do NOT modify `onDidCreateEditor` override on line 70 (unrelated to themes)
- Do NOT add any themes beyond the specified 9 pairs

---

## Verification Strategy

> **UNIVERSAL RULE: ZERO HUMAN INTERVENTION**
>
> ALL tasks in this plan MUST be verifiable WITHOUT any human action.

### Test Decision
- **Infrastructure exists**: YES (Vitest for frontend, Go testing for backend)
- **Automated tests**: NO (user specified: don't break existing tests, no new tests required)
- **Framework**: Vitest (frontend), go test (backend)

### Agent-Executed QA Scenarios (MANDATORY — ALL tasks)

Verification will be done via:
- `npx vitest run` — frontend tests still pass
- `cd backend && go test ./...` — backend tests still pass
- Build verification: `cd frontend && npx tsc --noEmit` — TypeScript compiles
- Biome lint: `cd frontend && npx biome check src/` — no lint errors

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately):
├── Task 1: Install monaco-themes + fix setTheme bug + register themes
├── Task 2: Add editorTheme to Settings types (TS + Go)

Wave 2 (After Wave 1):
├── Task 3: Update Editor.tsx theme application
├── Task 4: Add theme selector to SettingsDialog
└── Task 5: Wails bindings regeneration + final verification
```

### Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|------------|--------|---------------------|
| 1 | None | 3, 4 | 2 |
| 2 | None | 3, 4, 5 | 1 |
| 3 | 1, 2 | 5 | 4 |
| 4 | 1, 2 | 5 | 3 |
| 5 | 2, 3, 4 | None | None (final) |

---

## TODOs

- [x] 1. Install `monaco-themes`, fix `setTheme` bug, register themes in `lib/monaco.ts`

  **What to do**:
  
  **Step 1 — Install dependency**:
  - Run `npm install monaco-themes` in `frontend/` directory
  - Verify it appears in `package.json` dependencies

  **Step 2 — Fix critical bug in `lib/monaco.ts`**:
  - **Remove line 69**: `_monaco.editor.setTheme = () => Promise.resolve();`
  - This line completely disabled all theme switching. Removing it restores `setTheme` functionality.
  - **Keep line 70** (`_monaco.editor.onDidCreateEditor = () => ({ dispose: () => {} });`) — this is unrelated to themes and suppresses logging

  **Step 3 — Add theme pair definitions and registration**:
  - Add `ThemePair` type definition
  - Add `THEME_PAIRS` constant array with all 9 pairs
  - Import 16 theme JSON files from `monaco-themes/themes/*.json` (static imports)
  - Add `registerThemes()` function that calls `monaco.editor.defineTheme()` for each imported theme
  - Call `registerThemes()` inside `initializeMonaco()` BEFORE `_isInitialized = true`
  - Export `THEME_PAIRS` and `ThemePair` type, and a helper `getThemePair(id: string): ThemePair`

  **Exact theme imports needed** (JSON file names from the package — note the filename column in themelist.json maps key→display name, and the JSON files use the display name):
  ```
  monaco-themes/themes/GitHub Light.json     → defineTheme('github-light', data)
  monaco-themes/themes/GitHub Dark.json      → defineTheme('github-dark', data)
  monaco-themes/themes/Solarized-light.json  → defineTheme('solarized-light', data)
  monaco-themes/themes/Solarized-dark.json   → defineTheme('solarized-dark', data)
  monaco-themes/themes/Tomorrow.json         → defineTheme('tomorrow', data)
  monaco-themes/themes/Tomorrow-Night.json   → defineTheme('tomorrow-night', data)
  monaco-themes/themes/Clouds.json           → defineTheme('clouds', data)
  monaco-themes/themes/Clouds Midnight.json  → defineTheme('clouds-midnight', data)
  monaco-themes/themes/Monokai.json          → defineTheme('monokai', data)
  monaco-themes/themes/Dracula.json          → defineTheme('dracula', data)
  monaco-themes/themes/Nord.json             → defineTheme('nord', data)
  monaco-themes/themes/Night Owl.json        → defineTheme('night-owl', data)
  ```

  **THEME_PAIRS definition**:
  ```ts
  export type ThemePair = {
    id: string;
    label: string;
    light: string;  // monaco theme name
    dark: string;   // monaco theme name
  };

  export const THEME_PAIRS: ThemePair[] = [
    { id: 'default',    label: 'Default',    light: 'vs',              dark: 'vs-dark' },
    { id: 'github',     label: 'GitHub',     light: 'github-light',    dark: 'github-dark' },
    { id: 'solarized',  label: 'Solarized',  light: 'solarized-light', dark: 'solarized-dark' },
    { id: 'tomorrow',   label: 'Tomorrow',   light: 'tomorrow',        dark: 'tomorrow-night' },
    { id: 'clouds',     label: 'Clouds',     light: 'clouds',          dark: 'clouds-midnight' },
    { id: 'monokai',    label: 'Monokai',    light: 'vs',              dark: 'monokai' },
    { id: 'dracula',    label: 'Dracula',    light: 'vs',              dark: 'dracula' },
    { id: 'nord',       label: 'Nord',       light: 'vs',              dark: 'nord' },
    { id: 'night-owl',  label: 'Night Owl',  light: 'vs',              dark: 'night-owl' },
  ];
  ```

  **`getThemePair` helper**:
  ```ts
  export const getThemePair = (id: string): ThemePair => {
    return THEME_PAIRS.find((pair) => pair.id === id) || THEME_PAIRS[0];
  };
  ```

  **Must NOT do**:
  - Do NOT remove line 70 (`onDidCreateEditor` override)
  - Do NOT add themes beyond the 12 non-builtin themes listed above
  - Do NOT use dynamic `import()` — use static imports only
  - Do NOT modify existing `getOrCreateEditor`, `disposeEditor`, or language-related exports

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Focused changes to a single file plus npm install
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: Monaco Editor configuration and TypeScript module patterns

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 2)
  - **Blocks**: Tasks 3, 4
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `frontend/src/lib/monaco.ts:1-150` — The entire file; understand the singleton pattern (`_isInitialized`, `_monaco`), worker setup, and where `initializeMonaco()` runs. Theme registration MUST go inside `initializeMonaco()` after line 65 (after `_monaco = monaco` assignment) and BEFORE `_isInitialized = true` on line 72.
  - `frontend/src/lib/monaco.ts:69` — THE BUG: `_monaco.editor.setTheme = () => Promise.resolve();` — this line MUST be deleted
  - `frontend/src/lib/monaco.ts:70` — `_monaco.editor.onDidCreateEditor = () => ({ dispose: () => {} });` — this line must NOT be deleted (unrelated suppression)

  **External References**:
  - `monaco-themes` package: themes are JSON files at `node_modules/monaco-themes/themes/{Display Name}.json`
  - Theme JSON format: `{ base: 'vs'|'vs-dark'|'hc-black', inherit: boolean, rules: [...], colors: {...} }` — this is the format `monaco.editor.defineTheme()` expects
  - `monaco.editor.defineTheme(themeName, themeData)` — registers a theme globally; see https://github.com/brijeshb42/monaco-themes README

  **Acceptance Criteria**:

  - [ ] `monaco-themes` appears in `frontend/package.json` dependencies
  - [ ] `node_modules/monaco-themes` exists after `npm install`
  - [ ] Line 69 (`setTheme` override) is REMOVED from `lib/monaco.ts`
  - [ ] Line 70 (`onDidCreateEditor` override) is PRESERVED
  - [ ] `THEME_PAIRS` array exported with exactly 9 entries
  - [ ] `ThemePair` type exported
  - [ ] `getThemePair()` function exported
  - [ ] `registerThemes()` called inside `initializeMonaco()` before `_isInitialized = true`
  - [ ] TypeScript compiles: `cd frontend && npx tsc --noEmit` → no errors

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: TypeScript compilation succeeds after changes
    Tool: Bash
    Preconditions: npm install completed in frontend/
    Steps:
      1. cd frontend && npx tsc --noEmit
      2. Assert: exit code 0, no type errors
    Expected Result: Clean compilation
    Evidence: Terminal output captured

  Scenario: Biome lint passes
    Tool: Bash
    Preconditions: Changes saved to lib/monaco.ts
    Steps:
      1. cd frontend && npx biome check src/lib/monaco.ts
      2. Assert: no errors (warnings acceptable)
    Expected Result: Lint clean
    Evidence: Terminal output captured

  Scenario: Existing frontend tests still pass
    Tool: Bash
    Preconditions: npm install completed
    Steps:
      1. cd frontend && npx vitest run
      2. Assert: all tests pass, exit code 0
    Expected Result: No test regressions
    Evidence: Test output captured
  ```

  **Commit**: YES
  - Message: `feat(editor): add monaco-themes and register theme pairs`
  - Files: `frontend/package.json`, `frontend/package-lock.json`, `frontend/src/lib/monaco.ts`
  - Pre-commit: `cd frontend && npx tsc --noEmit`

---

- [ ] 2. Add `editorTheme` field to Settings types (TypeScript + Go)

  **What to do**:

  **Step 1 — Update TypeScript types** (`frontend/src/types.ts`):
  - Add `editorTheme: string;` to the `Settings` type (after `isDarkMode`)
  - Add `editorTheme: 'default'` to `DEFAULT_EDITOR_SETTINGS`

  **Step 2 — Update Go struct** (`backend/domain.go`):
  - Add `EditorTheme string \`json:"editorTheme"\`` to `Settings` struct (after `IsDarkMode`)

  **Step 3 — Update Go default settings** (`backend/settings_service.go`):
  - In `LoadSettings()` default settings return (line 37-49), add `EditorTheme: "default"`

  **Step 4 — Update `useEditorSettings.ts`**:
  - Add `editorTheme: 'default'` to the initial state in `useState<Settings>` (line 8-20)
  - Add `editorTheme: settings.editorTheme || 'default'` in the `loadSettings` mapping (line 28-39)
  - Note: the `|| 'default'` fallback handles existing settings.json files that don't have the field (Go returns `""` for missing string fields)

  **Must NOT do**:
  - Do NOT change any other Settings fields
  - Do NOT modify window state logic in `useEditorSettings.ts`
  - Do NOT add validation logic for theme IDs here (the UI dropdown constrains valid values)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small, mechanical additions to 4 files
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: TypeScript type patterns and React hook state management

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: Tasks 3, 4, 5
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `frontend/src/types.ts:53-65` — Current `Settings` type. Add `editorTheme: string;` after line 56 (`isDarkMode`)
  - `frontend/src/types.ts:68-75` — Current `DEFAULT_EDITOR_SETTINGS`. Add `editorTheme: 'default'` after line 72 (`isDarkMode: false`)
  - `backend/domain.go:85-97` — Current `Settings` struct. Add `EditorTheme` after line 88 (`IsDarkMode`)
  - `backend/settings_service.go:37-49` — Default settings in `LoadSettings()`. Add `EditorTheme: "default"` after line 41 (`IsDarkMode: false`)
  - `frontend/src/hooks/useEditorSettings.ts:8-20` — Initial useState. Add `editorTheme: 'default'` after `isDarkMode: false`
  - `frontend/src/hooks/useEditorSettings.ts:28-39` — LoadSettings mapping. Add `editorTheme: settings.editorTheme || 'default'`

  **Acceptance Criteria**:

  - [ ] `Settings` type in `types.ts` includes `editorTheme: string`
  - [ ] `DEFAULT_EDITOR_SETTINGS` includes `editorTheme: 'default'`
  - [ ] Go `Settings` struct includes `EditorTheme string \`json:"editorTheme"\``
  - [ ] Go `LoadSettings()` default includes `EditorTheme: "default"`
  - [ ] `useEditorSettings.ts` initial state includes `editorTheme: 'default'`
  - [ ] `useEditorSettings.ts` loadSettings maps `editorTheme` with `|| 'default'` fallback
  - [ ] TypeScript compiles: `cd frontend && npx tsc --noEmit` → no errors
  - [ ] Go compiles: `cd backend && go build ./...` → no errors
  - [ ] Backend tests pass: `cd backend && go test ./...` → PASS

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: Go backend compiles and tests pass
    Tool: Bash
    Preconditions: domain.go and settings_service.go updated
    Steps:
      1. cd backend && go build ./...
      2. Assert: exit code 0
      3. cd backend && go test ./...
      4. Assert: all tests PASS
    Expected Result: Clean build and all tests pass
    Evidence: Terminal output captured

  Scenario: TypeScript compiles with new field
    Tool: Bash
    Preconditions: types.ts and useEditorSettings.ts updated
    Steps:
      1. cd frontend && npx tsc --noEmit
      2. Assert: exit code 0
    Expected Result: No type errors
    Evidence: Terminal output captured
  ```

  **Commit**: YES
  - Message: `feat(settings): add editorTheme field to Settings`
  - Files: `frontend/src/types.ts`, `backend/domain.go`, `backend/settings_service.go`, `frontend/src/hooks/useEditorSettings.ts`
  - Pre-commit: `cd backend && go test ./... && cd ../frontend && npx tsc --noEmit`

---

- [ ] 3. Update `Editor.tsx` to apply themes using theme pairs

  **What to do**:

  **Step 1 — Import theme utilities**:
  - Add import of `getThemePair` from `'../lib/monaco'`

  **Step 2 — Update initial editor creation** (lines 46-66):
  - In the `getOrCreateEditor()` call, change `theme: 'vs'` to use the resolved theme:
    ```ts
    const pair = getThemePair(settings.editorTheme);
    const themeName = settings.isDarkMode ? pair.dark : pair.light;
    ```
  - Pass `theme: themeName` in the options

  **Step 3 — Update settings change effect** (lines 126-138):
  - Replace `theme: settings.isDarkMode ? 'vs-dark' : 'vs'` with theme pair resolution
  - CRITICAL: Use `monaco.editor.setTheme(themeName)` instead of passing theme via `updateOptions`. The `setTheme` API is the global theme setter and is the correct approach. `updateOptions` with `theme` internally calls `setTheme` anyway, but being explicit is clearer.
  - Updated effect:
    ```ts
    useEffect(() => {
      if (editorInstanceRef.current) {
        const monaco = getMonaco();
        const pair = getThemePair(settings.editorTheme);
        const themeName = settings.isDarkMode ? pair.dark : pair.light;
        monaco.editor.setTheme(themeName);
        editorInstanceRef.current.updateOptions({
          fontFamily: settings.fontFamily,
          fontSize: settings.fontSize,
          wordWrap: settings.wordWrap === 'on' ? 'on' : 'off',
          minimap: { enabled: settings.minimap },
        });
      }
    }, [settings, editorInstanceRef]);
    ```

  **Must NOT do**:
  - Do NOT change keyboard command registration
  - Do NOT change model/language management
  - Do NOT change the component's props interface (Settings type change in Task 2 flows through automatically)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small focused edits to one component file
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: React component patterns, Monaco Editor API usage

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Task 4)
  - **Blocks**: Task 5
  - **Blocked By**: Tasks 1, 2

  **References**:

  **Pattern References**:
  - `frontend/src/components/Editor.tsx:46-66` — Editor initialization; `theme: 'vs'` on line 49 needs to use resolved theme pair
  - `frontend/src/components/Editor.tsx:126-138` — Settings change effect; line 129 `theme: settings.isDarkMode ? 'vs-dark' : 'vs'` needs theme pair resolution
  - `frontend/src/lib/monaco.ts` — Import `getThemePair` and `getMonaco` (already imported)

  **API References**:
  - `monaco.editor.setTheme(themeName: string)` — Global theme setter. This is the correct API for switching themes after editor creation.
  - `getThemePair(id: string)` — Returns `ThemePair` with `.light` and `.dark` theme names

  **Acceptance Criteria**:

  - [ ] `getThemePair` imported from `'../lib/monaco'`
  - [ ] Initial editor creation uses resolved theme name (not hardcoded `'vs'`)
  - [ ] Settings effect uses `monaco.editor.setTheme()` with resolved theme name
  - [ ] Settings effect no longer passes `theme` in `updateOptions`
  - [ ] TypeScript compiles: `cd frontend && npx tsc --noEmit` → no errors
  - [ ] Biome lint passes: `cd frontend && npx biome check src/components/Editor.tsx`

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: TypeScript compilation with updated Editor
    Tool: Bash
    Preconditions: Tasks 1 and 2 completed
    Steps:
      1. cd frontend && npx tsc --noEmit
      2. Assert: exit code 0
    Expected Result: No type errors
    Evidence: Terminal output captured

  Scenario: Frontend tests still pass
    Tool: Bash
    Preconditions: Editor.tsx updated
    Steps:
      1. cd frontend && npx vitest run
      2. Assert: all tests pass
    Expected Result: No regressions
    Evidence: Test output captured
  ```

  **Commit**: YES (groups with Task 4)
  - Message: `feat(editor): apply theme pairs based on isDarkMode and editorTheme`
  - Files: `frontend/src/components/Editor.tsx`
  - Pre-commit: `cd frontend && npx tsc --noEmit`

---

- [ ] 4. Add theme selector dropdown to `SettingsDialog.tsx`

  **What to do**:

  **Step 1 — Import theme definitions**:
  - Add import of `THEME_PAIRS` from `'../lib/monaco'`

  **Step 2 — Add theme dropdown**:
  - Add a `FormControl` + `Select` for theme selection in the settings dialog
  - Place it in a new row AFTER the font row (lines 101-131) and BEFORE the toggles grid (lines 133+)
  - The dropdown should show all 9 theme pairs with their `label` as display text and `id` as value

  **Exact UI structure**:
  ```tsx
  <FormControl fullWidth size="small">
    <InputLabel>Editor Theme</InputLabel>
    <Select
      value={localSettings.editorTheme}
      label="Editor Theme"
      onChange={(e) =>
        handleChange({ editorTheme: e.target.value as string })
      }
    >
      {THEME_PAIRS.map((pair) => (
        <MenuItem key={pair.id} value={pair.id}>
          {pair.label}
        </MenuItem>
      ))}
    </Select>
  </FormControl>
  ```

  **Step 3 — Verify Reset to Default works**:
  - The existing `handleReset` function already uses `DEFAULT_EDITOR_SETTINGS` which now includes `editorTheme: 'default'`, so reset will work automatically. No changes needed to `handleReset`.

  **Must NOT do**:
  - Do NOT add theme preview functionality (the existing `onChange` prop already applies settings live to the editor)
  - Do NOT add theme color swatches or visual indicators
  - Do NOT modify the Dark Mode toggle behavior
  - Do NOT change dialog layout significantly — just add one dropdown

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Adding a single MUI Select component to existing dialog
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: MUI component patterns, form layout

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Task 3)
  - **Blocks**: Task 5
  - **Blocked By**: Tasks 1, 2

  **References**:

  **Pattern References**:
  - `frontend/src/components/SettingsDialog.tsx:111-130` — Existing Font Size `Select` component pattern. Follow this exact pattern for the theme dropdown (same `FormControl` + `InputLabel` + `Select` + `MenuItem` structure)
  - `frontend/src/components/SettingsDialog.tsx:50-55` — `handleChange` function. Theme change uses `handleChange({ editorTheme: value })` which triggers live preview via `onChange` prop
  - `frontend/src/components/SettingsDialog.tsx:67-81` — `handleReset` function. Already spreads `DEFAULT_EDITOR_SETTINGS` which will include new `editorTheme: 'default'`
  - `frontend/src/components/SettingsDialog.tsx:101-131` — Font row layout. Place the new theme dropdown after this row

  **API References**:
  - `THEME_PAIRS` from `'../lib/monaco'` — Array of `{ id, label, light, dark }` objects
  - MUI `Select` + `MenuItem` — value-based selection, `e.target.value` gives selected `id`

  **Acceptance Criteria**:

  - [ ] `THEME_PAIRS` imported from `'../lib/monaco'`
  - [ ] Theme dropdown rendered with `Select` component containing 9 `MenuItem` entries
  - [ ] Dropdown label is "Editor Theme"
  - [ ] Selecting a theme calls `handleChange({ editorTheme: id })`
  - [ ] Reset to Default sets theme back to "default"
  - [ ] TypeScript compiles: `cd frontend && npx tsc --noEmit` → no errors
  - [ ] Biome lint passes: `cd frontend && npx biome check src/components/SettingsDialog.tsx`

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: TypeScript compilation with updated SettingsDialog
    Tool: Bash
    Preconditions: Tasks 1 and 2 completed
    Steps:
      1. cd frontend && npx tsc --noEmit
      2. Assert: exit code 0
    Expected Result: No type errors
    Evidence: Terminal output captured

  Scenario: Frontend tests still pass
    Tool: Bash
    Preconditions: SettingsDialog.tsx updated
    Steps:
      1. cd frontend && npx vitest run
      2. Assert: all tests pass
    Expected Result: No regressions
    Evidence: Test output captured
  ```

  **Commit**: YES (combined with Task 3)
  - Message: `feat(settings): add editor theme selector to settings dialog`
  - Files: `frontend/src/components/SettingsDialog.tsx`
  - Pre-commit: `cd frontend && npx tsc --noEmit && npx vitest run`

---

- [ ] 5. Regenerate Wails bindings and final verification

  **What to do**:

  **Step 1 — Regenerate Wails bindings**:
  - Run `wails generate module` from the project root
  - This regenerates `wailsjs/go/backend/App.ts` and `wailsjs/go/models.ts` to include the new `EditorTheme` field in the Settings model

  **Step 2 — Verify generated bindings**:
  - Check `wailsjs/go/models.ts` — the `Settings` class should now include `editorTheme: string`
  - If the generated type doesn't include the field, the Go struct change in Task 2 may not have been saved properly

  **Step 3 — Full build verification**:
  - `cd backend && go test ./...` → all pass
  - `cd frontend && npx tsc --noEmit` → clean
  - `cd frontend && npx vitest run` → all pass
  - `cd frontend && npx biome check src/` → clean

  **Must NOT do**:
  - Do NOT manually edit files in `wailsjs/` — they are auto-generated
  - Do NOT run `wails build` (that's a full production build, not needed for verification)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Running commands and verifying output
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: Build toolchain familiarity

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential (final task)
  - **Blocks**: None
  - **Blocked By**: Tasks 2, 3, 4

  **References**:

  **Pattern References**:
  - `wailsjs/go/models.ts` — Auto-generated TypeScript models from Go structs. After regeneration, `Settings` class should include `editorTheme` field.
  - `.cursor/rules/description.mdc` — States: "バックエンドを修正したときは、リンタエラーが出るので、都度wails generate moduleを実行してください"

  **Acceptance Criteria**:

  - [ ] `wails generate module` completes without errors
  - [ ] `wailsjs/go/models.ts` contains `editorTheme` in the Settings class
  - [ ] `cd backend && go test ./...` → all PASS
  - [ ] `cd frontend && npx tsc --noEmit` → exit code 0
  - [ ] `cd frontend && npx vitest run` → all tests PASS
  - [ ] `cd frontend && npx biome check src/` → no errors

  **Agent-Executed QA Scenarios**:

  ```
  Scenario: Wails bindings regenerated successfully
    Tool: Bash
    Preconditions: Go Settings struct updated in Task 2
    Steps:
      1. wails generate module (from project root)
      2. Assert: exit code 0
      3. Grep wailsjs/go/models.ts for "editorTheme"
      4. Assert: field found in Settings class
    Expected Result: Bindings include new field
    Evidence: Terminal output + grep result

  Scenario: Full test suite passes
    Tool: Bash
    Preconditions: All previous tasks completed
    Steps:
      1. cd backend && go test ./...
      2. Assert: all PASS
      3. cd frontend && npx vitest run
      4. Assert: all PASS
      5. cd frontend && npx tsc --noEmit
      6. Assert: exit code 0
    Expected Result: Clean build, all tests pass
    Evidence: Terminal output captured
  ```

  **Commit**: YES
  - Message: `chore: regenerate wails bindings for editorTheme setting`
  - Files: `wailsjs/go/models.ts`, `wailsjs/go/backend/App.ts` (auto-generated)
  - Pre-commit: `cd backend && go test ./... && cd ../frontend && npx vitest run`

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 1 | `feat(editor): add monaco-themes and register theme pairs` | `frontend/package.json`, `frontend/package-lock.json`, `frontend/src/lib/monaco.ts` | `tsc --noEmit` |
| 2 | `feat(settings): add editorTheme field to Settings` | `frontend/src/types.ts`, `backend/domain.go`, `backend/settings_service.go`, `frontend/src/hooks/useEditorSettings.ts` | `go test ./...`, `tsc --noEmit` |
| 3+4 | `feat(editor): apply theme pairs and add theme selector` | `frontend/src/components/Editor.tsx`, `frontend/src/components/SettingsDialog.tsx` | `vitest run`, `tsc --noEmit` |
| 5 | `chore: regenerate wails bindings for editorTheme setting` | `wailsjs/go/models.ts`, `wailsjs/go/backend/App.ts` | `go test`, `vitest`, `tsc` |

---

## Success Criteria

### Verification Commands
```bash
cd backend && go test ./...                    # Expected: all PASS
cd frontend && npx vitest run                  # Expected: all tests pass
cd frontend && npx tsc --noEmit                # Expected: exit code 0
cd frontend && npx biome check src/            # Expected: no errors
```

### Final Checklist
- [ ] All 9 theme pairs defined and registered in monaco.ts
- [ ] `setTheme` bug (line 69) removed
- [ ] `editorTheme` field in Settings (TS type + Go struct + defaults)
- [ ] Theme dropdown in SettingsDialog with 9 options
- [ ] Editor.tsx uses `getThemePair()` + `setTheme()` for theme application
- [ ] Wails bindings regenerated
- [ ] All existing tests pass (Go + Vitest)
- [ ] No TypeScript compilation errors
- [ ] No Biome lint errors
- [ ] Backwards compatible: existing settings.json without `editorTheme` works (defaults to "default")
