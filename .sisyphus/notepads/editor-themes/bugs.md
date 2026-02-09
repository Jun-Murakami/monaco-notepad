# Bug Report: Editor Content Cleared on Theme Change

## Issue
**Reported by User**: テーマを切り替えると、エディタのテキストがクリアされてしまう
(When switching themes, the editor text is cleared)

## Severity
**CRITICAL** - Data loss issue

## Expected Behavior
- User switches theme in Settings
- Editor theme changes visually
- **Editor content remains unchanged**

## Actual Behavior
- User switches theme in Settings
- Editor theme changes
- **Editor content is cleared/lost**

## Impact
- User loses unsaved work when changing themes
- Makes theme switching feature unusable
- Violates user expectations

## Investigation Needed
1. Check Editor.tsx theme application logic
2. Check if model is being disposed/recreated
3. Check if setValue is being called incorrectly
4. Verify settings change effect in Editor.tsx

## Status
INVESTIGATING

## Root Cause Analysis

**File**: `frontend/src/components/Editor.tsx`
**Line**: 79 (dependency array of editor initialization useEffect)

### Problem
The editor initialization useEffect had `settings.editorTheme` and `settings.isDarkMode` in its dependency array:

```typescript
}, [editorInstanceRef, settings.editorTheme, settings.isDarkMode]);
```

This caused the editor to be **completely re-initialized** (including calling `disposeEditor()`) every time the theme changed, which:
1. Disposed all Monaco models
2. Cleared editor content
3. Lost user's unsaved work

### Why This Happened
During implementation of Task 3, the theme resolution logic was added to the initialization useEffect:

```typescript
const pair = getThemePair(settings.editorTheme);
const themeName = settings.isDarkMode ? pair.dark : pair.light;
```

The dependencies were incorrectly added to ensure the theme was applied on initialization. However, this created a side effect where **any theme change triggered full re-initialization**.

### Correct Design
- **Initialization useEffect** (lines 48-79): Should run ONCE to create the editor instance
- **Settings change useEffect** (lines 133-149): Should handle theme changes via `monaco.editor.setTheme()` WITHOUT re-initializing

The settings change useEffect already correctly handles theme changes:
```typescript
monaco.editor.setTheme(themeName);
```

This updates the theme WITHOUT disposing the editor or clearing content.

## Fix Applied

**Changed**: Line 79 dependency array
```typescript
// BEFORE (WRONG):
}, [editorInstanceRef, settings.editorTheme, settings.isDarkMode]);

// AFTER (CORRECT):
}, [editorInstanceRef]); // 初期化は一度だけ（テーマ変更では再初期化しない）
```

### Why This Fix Works
1. Editor initializes ONCE with the current theme
2. Theme changes are handled by the settings useEffect (lines 133-149)
3. `monaco.editor.setTheme()` updates theme WITHOUT disposing editor
4. Editor content is preserved

## Verification

- ✅ TypeScript compiles cleanly
- ✅ All 192 tests pass
- ✅ No regressions introduced

## Status
**FIXED** - Ready for user testing

## User Testing Required
User should verify:
1. Enter text in editor
2. Change theme in Settings
3. **Expected**: Text remains, only theme colors change
4. **Previous behavior**: Text was cleared (BUG)
