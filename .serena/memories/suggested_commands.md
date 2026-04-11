Windows/PowerShell commands:
- Frontend typecheck: `cd frontend; npm run typecheck`
- Frontend tests: `cd frontend; npm run test -- --run`
- Targeted frontend tests: `cd frontend; npm run test -- --run src/components/__tests__/NoteList.test.tsx`
- Frontend lint: `cd frontend; npm run lint`
- Frontend format: `cd frontend; .\node_modules\.bin\biome.cmd format --write <files>`
- Backend tests: `cd backend; go test ./...`
- Wails dev server: `wails dev`
- Windows production build: `./build.ps1`