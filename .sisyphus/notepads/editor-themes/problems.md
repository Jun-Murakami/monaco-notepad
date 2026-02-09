
## [2026-02-10 17:30] CRITICAL BUILD FAILURE

### Issue
Production build fails with error:
```
[commonjs--resolver] Missing "./themes/Clouds.json" specifier in "monaco-themes" package
```

### Root Cause
The `monaco-themes` package has a restrictive `package.json` exports field that only exports:
- `"."` → main API (parseTmTheme function)
- `"./dist/monaco-themes.js"` → bundled themes

It does NOT export individual theme JSON files from `./themes/` directory.

### Impact
- `wails dev` fails to start
- User cannot test the implemented feature
- All 5 implementation tasks are complete but application is broken

### Attempted Fix
Added vite.config.ts configuration to bypass exports restriction:
```typescript
resolve: {
  alias: {
    'monaco-themes/themes': 'monaco-themes/themes'
  }
},
assetsInclude: ['**/*.json']
```

### Alternative Solutions

**Option 1: Copy theme JSON files to project**
- Copy needed theme files from node_modules to `frontend/src/themes/`
- Import from local files instead of package
- Pros: Full control, no package.json exports issues
- Cons: Duplication, manual updates needed

**Option 2: Use different package or approach**
- Find alternative theme package without export restrictions
- Or manually define themes inline
- Pros: Clean solution
- Cons: More work, may lose theme quality

**Option 3: Configure Vite to ignore package.json exports**
- Use Vite's `resolve.externalConditions` or custom plugin
- Pros: Minimal code changes
- Cons: May break in future Vite versions

### Recommended Action
Test if vite.config.ts fix works. If not, proceed with Option 1 (copy theme files locally).
