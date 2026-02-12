package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

type driveSyncOverride struct {
	DriveSyncService

	createNoteFn       func(ctx context.Context, note *Note) error
	downloadNoteListFn func(ctx context.Context, noteListID string) (*NoteList, error)
}

func (o *driveSyncOverride) CreateNote(ctx context.Context, note *Note) error {
	if o.createNoteFn != nil {
		return o.createNoteFn(ctx, note)
	}
	return o.DriveSyncService.CreateNote(ctx, note)
}

func (o *driveSyncOverride) DownloadNoteList(ctx context.Context, noteListID string) (*NoteList, error) {
	if o.downloadNoteListFn != nil {
		return o.downloadNoteListFn(ctx, noteListID)
	}
	return o.DriveSyncService.DownloadNoteList(ctx, noteListID)
}

func seedCloudNoteListFile(t *testing.T, ds *driveService, rawOps DriveOperations) {
	t.Helper()

	mockOps, ok := rawOps.(*mockDriveOperations)
	if !ok {
		t.Fatalf("expected *mockDriveOperations, got %T", rawOps)
	}

	noteListID := ds.auth.GetDriveSync().NoteListID()
	noteListData, err := json.Marshal(ds.noteService.noteList)
	if err != nil {
		t.Fatalf("failed to marshal noteList: %v", err)
	}

	mockOps.mu.Lock()
	mockOps.files[noteListID] = noteListData
	mockOps.mu.Unlock()
}

type failingCreateDriveOps struct {
	*mockDriveOperations
	failFileNames map[string]bool
}

func (f *failingCreateDriveOps) CreateFile(name string, content []byte, rootFolderID string, mimeType string) (string, error) {
	if f.failFileNames[name] {
		return "", fmt.Errorf("simulated upload failure for %s", name)
	}
	return f.mockDriveOperations.CreateFile(name, content, rootFolderID, mimeType)
}
