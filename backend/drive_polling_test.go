package backend

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"google.golang.org/api/drive/v3"
)

type fakeDriveSyncService struct {
	noteList *NoteList
	err      error
}

func (f *fakeDriveSyncService) CreateNote(ctx context.Context, note *Note) error {
	return nil
}
func (f *fakeDriveSyncService) UpdateNote(ctx context.Context, note *Note) error {
	return nil
}
func (f *fakeDriveSyncService) UploadAllNotes(ctx context.Context, notes []NoteMetadata) error {
	return nil
}
func (f *fakeDriveSyncService) DownloadNote(ctx context.Context, noteID string) (*Note, error) {
	return nil, nil
}
func (f *fakeDriveSyncService) DeleteNote(ctx context.Context, noteID string) error {
	return nil
}
func (f *fakeDriveSyncService) ListFiles(ctx context.Context, folderID string) ([]*drive.File, error) {
	return nil, nil
}
func (f *fakeDriveSyncService) GetNoteID(ctx context.Context, noteID string) (string, error) {
	return "", nil
}
func (f *fakeDriveSyncService) RemoveDuplicateNoteFiles(ctx context.Context, files []*drive.File) error {
	return nil
}
func (f *fakeDriveSyncService) RemoveNoteFromList(notes []NoteMetadata, noteID string) []NoteMetadata {
	return notes
}
func (f *fakeDriveSyncService) CreateNoteList(ctx context.Context, noteList *NoteList) error {
	return nil
}
func (f *fakeDriveSyncService) UpdateNoteList(ctx context.Context, noteList *NoteList, noteListID string) error {
	return nil
}
func (f *fakeDriveSyncService) DownloadNoteList(ctx context.Context, noteListID string) (*NoteList, error) {
	return f.noteList, f.err
}
func (f *fakeDriveSyncService) DownloadNoteListIfChanged(ctx context.Context, noteListID string) (*NoteList, bool, error) {
	return f.noteList, true, f.err
}
func (f *fakeDriveSyncService) ListUnknownNotes(ctx context.Context, cloudNoteList *NoteList, files []*drive.File, arrowDownload bool) (*NoteList, error) {
	return cloudNoteList, nil
}
func (f *fakeDriveSyncService) ListAvailableNotes(cloudNoteList *NoteList) (*NoteList, error) {
	return cloudNoteList, nil
}
func (f *fakeDriveSyncService) DeduplicateNotes(notes []NoteMetadata) []NoteMetadata {
	return notes
}
func (f *fakeDriveSyncService) RefreshFileIDCache(ctx context.Context) error {
	return nil
}
func (f *fakeDriveSyncService) SetConnected(connected bool) {
}
func (f *fakeDriveSyncService) SetInitialSyncCompleted(completed bool) {
}
func (f *fakeDriveSyncService) SetCloudNoteList(noteList *NoteList) {
}
func (f *fakeDriveSyncService) IsConnected() bool {
	return true
}
func (f *fakeDriveSyncService) HasCompletedInitialSync() bool {
	return true
}

func TestIsSelfNoteListChange(t *testing.T) {
	ctx := context.Background()
	logger := NewAppLogger(ctx, true, t.TempDir())

	auth := &authService{
		driveSync: &DriveSync{
			cloudNoteList: &NoteList{Version: "1.0", Notes: []NoteMetadata{}},
		},
	}
	auth.driveSync.SetFolderIDs("root-folder", "notes-folder")
	auth.driveSync.SetNoteListID("noteList-id")

	makePolling := func(noteList *NoteList) *DrivePollingService {
		ds := &driveService{
			ctx:            ctx,
			auth:           auth,
			driveSync:      &fakeDriveSyncService{noteList: noteList},
			logger:         logger,
			clientID:       "client-1",
			lastSyncResult: nil,
		}
		return NewDrivePollingService(ctx, ds)
	}

	noteListChange := []*drive.Change{
		{
			File: &drive.File{
				Id:      "noteList-id",
				Name:    "noteList.json",
				Parents: []string{"root-folder"},
			},
		},
	}

	otherChange := []*drive.Change{
		{
			File: &drive.File{
				Id:      "noteList-id",
				Name:    "noteList.json",
				Parents: []string{"root-folder"},
			},
		},
		{
			File: &drive.File{
				Id:      "note-1",
				Name:    "note-1.json",
				Parents: []string{"notes-folder"},
			},
		},
	}

	t.Run("self noteList change is skipped", func(t *testing.T) {
		polling := makePolling(&NoteList{
			Version:          "1.0",
			LastSyncClientID: "client-1",
		})
		assert.True(t, polling.isSelfNoteListChange(noteListChange, "root-folder", "notes-folder"))
	})

	t.Run("different client is not skipped", func(t *testing.T) {
		polling := makePolling(&NoteList{
			Version:          "1.0",
			LastSyncClientID: "client-2",
		})
		assert.False(t, polling.isSelfNoteListChange(noteListChange, "root-folder", "notes-folder"))
	})

	t.Run("missing client id is not skipped", func(t *testing.T) {
		polling := makePolling(&NoteList{
			Version: "1.0",
		})
		assert.False(t, polling.isSelfNoteListChange(noteListChange, "root-folder", "notes-folder"))
	})

	t.Run("other changes are not skipped", func(t *testing.T) {
		polling := makePolling(&NoteList{
			Version:          "1.0",
			LastSyncClientID: "client-1",
		})
		assert.False(t, polling.isSelfNoteListChange(otherChange, "root-folder", "notes-folder"))
	})
}
