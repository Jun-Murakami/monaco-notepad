package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/api/drive/v3"
)

type migrationMockFile struct {
	id       string
	name     string
	parentID string
	mimeType string
	space    string
	content  []byte
	trashed  bool
}

type migrationMockDriveStore struct {
	mu sync.RWMutex

	nextID int
	files  map[string]*migrationMockFile

	listErrByContains      map[string]error
	listErrBySpaceContains map[string]map[string]error
	createErrByName        map[string]error
	downloadErrByID        map[string]error
	deleteErrByID          map[string]error
	folderErrByName        map[string]error

	createCalls []string
	deleteCalls []string
}

type migrationMockDriveOps struct {
	*mockDriveOperations
	store *migrationMockDriveStore
	space string
}

var (
	nameFilterRe   = regexp.MustCompile(`name='([^']+)'`)
	mimeFilterRe   = regexp.MustCompile(`mimeType='([^']+)'`)
	parentFilterRe = regexp.MustCompile(`'([^']+)' in parents`)
)

func newMigrationMockDriveStore() *migrationMockDriveStore {
	return &migrationMockDriveStore{
		nextID:                 1,
		files:                  make(map[string]*migrationMockFile),
		listErrByContains:      make(map[string]error),
		listErrBySpaceContains: make(map[string]map[string]error),
		createErrByName:        make(map[string]error),
		downloadErrByID:        make(map[string]error),
		deleteErrByID:          make(map[string]error),
		folderErrByName:        make(map[string]error),
	}
}

func (s *migrationMockDriveStore) setListError(space string, marker string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listErrBySpaceContains[space] == nil {
		s.listErrBySpaceContains[space] = make(map[string]error)
	}
	s.listErrBySpaceContains[space][marker] = err
}

func (s *migrationMockDriveStore) addFile(space string, name string, parentID string, mimeType string, content []byte) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := fmt.Sprintf("mock-%d", s.nextID)
	s.nextID++
	s.files[id] = &migrationMockFile{
		id:       id,
		name:     name,
		parentID: parentID,
		mimeType: mimeType,
		space:    space,
		content:  append([]byte(nil), content...),
	}
	return id
}

func (s *migrationMockDriveStore) fileCountBySpace(space string) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	count := 0
	for _, f := range s.files {
		if f.space == space && !f.trashed {
			count++
		}
	}
	return count
}

func (s *migrationMockDriveStore) hasFile(space string, name string, parentID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, f := range s.files {
		if f.space == space && !f.trashed && f.name == name {
			if parentID == "" || f.parentID == parentID {
				return true
			}
		}
	}
	return false
}

func (s *migrationMockDriveStore) findFolderID(space string, name string, parentID string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, f := range s.files {
		if f.space == space && !f.trashed && f.name == name && f.mimeType == "application/vnd.google-apps.folder" {
			if parentID == "" || f.parentID == parentID {
				return f.id
			}
		}
	}
	return ""
}

func (s *migrationMockDriveStore) newOps(useAppData bool) DriveOperations {
	space := "legacy"
	if useAppData {
		space = "appData"
	}
	return &migrationMockDriveOps{
		mockDriveOperations: newMockDriveOperations(),
		store:               s,
		space:               space,
	}
}

func (s *migrationMockDriveStore) addLegacyData(noteCount int, withNoteList bool) (string, string) {
	rootID := s.addFile("legacy", "monaco-notepad", "", "application/vnd.google-apps.folder", nil)
	notesID := s.addFile("legacy", "notes", rootID, "application/vnd.google-apps.folder", nil)
	if withNoteList {
		s.addFile("legacy", "noteList_v2.json", rootID, "application/json", []byte(`{"version":"2.0"}`))
	}
	for i := 0; i < noteCount; i++ {
		s.addFile("legacy", fmt.Sprintf("note-%d.json", i+1), notesID, "application/json", []byte(fmt.Sprintf(`{"id":"note-%d"}`, i+1)))
	}
	return rootID, notesID
}

func (s *migrationMockDriveStore) addAppDataRoot(withNoteList bool) (string, string) {
	rootID := s.addFile("appData", "monaco-notepad", "", "application/vnd.google-apps.folder", nil)
	notesID := s.addFile("appData", "notes", rootID, "application/vnd.google-apps.folder", nil)
	if withNoteList {
		s.addFile("appData", "noteList_v2.json", rootID, "application/json", []byte(`{"version":"2.0"}`))
	}
	return rootID, notesID
}

func (s *migrationMockDriveStore) addMigrationCompleteMarker(appDataRootID string) {
	s.addFile("appData", migrationCompleteMarkerName, appDataRootID, "application/json", []byte(`{"completedAt":"2026-02-17T00:00:00Z"}`))
}

func (m *migrationMockDriveOps) CreateFile(name string, content []byte, parentID string, mimeType string) (string, error) {
	m.store.mu.Lock()
	defer m.store.mu.Unlock()
	if err, ok := m.store.createErrByName[name]; ok {
		return "", err
	}
	id := fmt.Sprintf("mock-%d", m.store.nextID)
	m.store.nextID++
	m.store.files[id] = &migrationMockFile{
		id:       id,
		name:     name,
		parentID: parentID,
		mimeType: mimeType,
		space:    m.space,
		content:  append([]byte(nil), content...),
	}
	m.store.createCalls = append(m.store.createCalls, fmt.Sprintf("%s:%s", m.space, name))
	return id, nil
}

func (m *migrationMockDriveOps) UpdateFile(fileID string, content []byte) error {
	m.store.mu.Lock()
	defer m.store.mu.Unlock()
	f, ok := m.store.files[fileID]
	if !ok || f.space != m.space || f.trashed {
		return fmt.Errorf("file not found: %s", fileID)
	}
	f.content = append([]byte(nil), content...)
	return nil
}

func (m *migrationMockDriveOps) DeleteFile(fileID string) error {
	m.store.mu.Lock()
	defer m.store.mu.Unlock()
	if err, ok := m.store.deleteErrByID[fileID]; ok {
		return err
	}
	f, ok := m.store.files[fileID]
	if !ok || f.space != m.space || f.trashed {
		return fmt.Errorf("file not found: %s", fileID)
	}
	f.trashed = true
	m.store.deleteCalls = append(m.store.deleteCalls, fileID)
	return nil
}

func (m *migrationMockDriveOps) DownloadFile(fileID string) ([]byte, error) {
	m.store.mu.RLock()
	defer m.store.mu.RUnlock()
	if err, ok := m.store.downloadErrByID[fileID]; ok {
		return nil, err
	}
	f, ok := m.store.files[fileID]
	if !ok || f.space != m.space || f.trashed {
		return nil, fmt.Errorf("file not found: %s", fileID)
	}
	return append([]byte(nil), f.content...), nil
}

func (m *migrationMockDriveOps) GetFileMetadata(fileID string) (*drive.File, error) {
	m.store.mu.RLock()
	defer m.store.mu.RUnlock()
	f, ok := m.store.files[fileID]
	if !ok || f.space != m.space || f.trashed {
		return nil, fmt.Errorf("file not found: %s", fileID)
	}
	return &drive.File{Id: f.id, Name: f.name, MimeType: f.mimeType, Parents: []string{f.parentID}}, nil
}

func (m *migrationMockDriveOps) CreateFolder(name string, parentID string) (string, error) {
	m.store.mu.Lock()
	defer m.store.mu.Unlock()
	if err, ok := m.store.folderErrByName[name]; ok {
		return "", err
	}
	id := fmt.Sprintf("mock-%d", m.store.nextID)
	m.store.nextID++
	m.store.files[id] = &migrationMockFile{
		id:       id,
		name:     name,
		parentID: parentID,
		mimeType: "application/vnd.google-apps.folder",
		space:    m.space,
	}
	m.store.createCalls = append(m.store.createCalls, fmt.Sprintf("%s:folder:%s", m.space, name))
	return id, nil
}

func (m *migrationMockDriveOps) ListFiles(query string) ([]*drive.File, error) {
	m.store.mu.RLock()
	defer m.store.mu.RUnlock()
	if scopedErrMap, ok := m.store.listErrBySpaceContains[m.space]; ok {
		for marker, err := range scopedErrMap {
			if strings.Contains(query, marker) {
				return nil, err
			}
		}
	}
	for marker, err := range m.store.listErrByContains {
		if strings.Contains(query, marker) {
			return nil, err
		}
	}

	nameFilter := extractSingleQuotedValue(query, "name='")
	mimeFilter := extractSingleQuotedValue(query, "mimeType='")
	parentFilters := extractParentIDs(query)
	wantNotTrashed := strings.Contains(query, "trashed=false")

	files := make([]*drive.File, 0)
	for _, f := range m.store.files {
		if f.space != m.space {
			continue
		}
		if wantNotTrashed && f.trashed {
			continue
		}
		if nameFilter != "" && f.name != nameFilter {
			continue
		}
		if mimeFilter != "" && f.mimeType != mimeFilter {
			continue
		}
		if len(parentFilters) > 0 {
			matched := false
			for _, p := range parentFilters {
				if f.parentID == p {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
		}
		files = append(files, &drive.File{Id: f.id, Name: f.name, MimeType: f.mimeType, Parents: []string{f.parentID}})
	}

	sort.Slice(files, func(i, j int) bool {
		return files[i].Id < files[j].Id
	})

	return files, nil
}

func (m *migrationMockDriveOps) GetFileID(fileName string, noteFolderID string, rootFolderID string) (string, error) {
	queryParent := rootFolderID
	if strings.HasSuffix(fileName, ".json") && fileName != "noteList_v2.json" {
		queryParent = noteFolderID
	}
	files, err := m.ListFiles(fmt.Sprintf("name='%s' and '%s' in parents and trashed=false", fileName, queryParent))
	if err != nil {
		return "", err
	}
	if len(files) == 0 {
		return "", fmt.Errorf("file not found: %s", fileName)
	}
	return files[0].Id, nil
}

func (m *migrationMockDriveOps) FindLatestFile(files []*drive.File) *drive.File {
	if len(files) == 0 {
		return nil
	}
	return files[0]
}

func (m *migrationMockDriveOps) CleanupDuplicates(files []*drive.File, keepLatest bool) error {
	return nil
}

func (m *migrationMockDriveOps) GetStartPageToken() (string, error) {
	return "mock-token", nil
}

func (m *migrationMockDriveOps) ListChanges(pageToken string) (*ChangesResult, error) {
	return &ChangesResult{Changes: nil, NewStartToken: pageToken}, nil
}

func extractSingleQuotedValue(query string, prefix string) string {
	var matches []string
	if strings.HasPrefix(prefix, "name=") {
		matches = nameFilterRe.FindStringSubmatch(query)
	} else {
		matches = mimeFilterRe.FindStringSubmatch(query)
	}
	if len(matches) < 2 {
		return ""
	}
	return matches[1]
}

func extractParentIDs(query string) []string {
	matches := parentFilterRe.FindAllStringSubmatch(query, -1)
	parents := make([]string, 0, len(matches))
	for _, m := range matches {
		if len(m) >= 2 {
			parents = append(parents, m[1])
		}
	}
	return parents
}

func newMigrationTestDriveService(t *testing.T, store *migrationMockDriveStore) (*driveService, func()) {
	t.Helper()
	helper := setupTest(t)
	ctx := context.Background()
	logger := NewAppLogger(ctx, true, helper.tempDir)

	auth := &authService{
		ctx:        ctx,
		appDataDir: helper.tempDir,
		isTestMode: true,
		logger:     logger,
	}
	driveSync := &DriveSync{service: &drive.Service{}}
	driveSync.SetConnected(true)
	auth.driveSync = driveSync

	ds := &driveService{
		ctx:                 ctx,
		auth:                auth,
		noteService:         helper.noteService,
		appDataDir:          helper.tempDir,
		notesDir:            helper.notesDir,
		logger:              logger,
		migrationChoiceChan: make(chan string, 1),
		syncState:           NewSyncState(helper.tempDir),
		migrationChoiceWait: 5 * time.Minute,
		driveOpsFactory: func(useAppDataFolder bool) DriveOperations {
			return store.newOps(useAppDataFolder)
		},
	}

	ds.pollingService = NewDrivePollingService(ctx, ds)

	cleanup := func() {
		if ds.operationsQueue != nil {
			ds.operationsQueue.Cleanup()
		}
		helper.cleanup()
	}

	return ds, cleanup
}

func TestLoadMigrationState_FileMissingReturnsEmptyState(t *testing.T) {
	store := newMigrationMockDriveStore()
	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	state := ds.loadMigrationState()
	assert.False(t, state.Migrated)
	assert.Empty(t, state.MigratedAt)
	assert.False(t, state.OldDataDeleted)
}

func TestLoadMigrationState_CorruptedJSONReturnsEmptyState(t *testing.T) {
	store := newMigrationMockDriveStore()
	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	path := filepath.Join(ds.appDataDir, migrationStateFileName)
	require.NoError(t, os.WriteFile(path, []byte("{broken json"), 0644))

	state := ds.loadMigrationState()
	assert.False(t, state.Migrated)
	assert.Empty(t, state.MigratedAt)
	assert.False(t, state.OldDataDeleted)
}

func TestSaveMigrationState_WritesReadableJSON(t *testing.T) {
	store := newMigrationMockDriveStore()
	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	expected := &driveStorageMigration{
		Migrated:       true,
		MigratedAt:     "2026-02-17T00:00:00Z",
		OldDataDeleted: true,
	}

	require.NoError(t, ds.saveMigrationState(expected))
	reloaded := ds.loadMigrationState()
	assert.Equal(t, expected, reloaded)

	data, err := os.ReadFile(filepath.Join(ds.appDataDir, migrationStateFileName))
	require.NoError(t, err)
	var raw map[string]interface{}
	require.NoError(t, json.Unmarshal(data, &raw))
	assert.Equal(t, true, raw["migrated"])
}

func TestIsMigrated_ReflectsStateFile(t *testing.T) {
	store := newMigrationMockDriveStore()
	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	assert.False(t, ds.isMigrated())
	require.NoError(t, ds.saveMigrationState(&driveStorageMigration{Migrated: true, MigratedAt: time.Now().UTC().Format(time.RFC3339)}))
	assert.True(t, ds.isMigrated())
}

func TestRespondToMigration_BufferedChannelReceivesChoice(t *testing.T) {
	store := newMigrationMockDriveStore()
	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	ds.RespondToMigration("migrate_keep")
	select {
	case choice := <-ds.migrationChoiceChan:
		assert.Equal(t, "migrate_keep", choice)
	default:
		t.Fatal("expected migration choice to be queued")
	}
}

func TestRespondToMigration_DoubleCallDoesNotBlockWhenChannelFull(t *testing.T) {
	store := newMigrationMockDriveStore()
	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	ds.RespondToMigration("first")
	done := make(chan struct{})
	go func() {
		ds.RespondToMigration("second")
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("second RespondToMigration call should not block")
	}

	choice := <-ds.migrationChoiceChan
	assert.Equal(t, "first", choice)
}

func TestMigrationChoiceChannel_BufferSizeOne(t *testing.T) {
	store := newMigrationMockDriveStore()
	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	assert.Equal(t, 1, cap(ds.migrationChoiceChan))
}

func TestExecuteMigration_NoteListDownloadFailureReturnsErrorAndDoesNotMarkMigrated(t *testing.T) {
	store := newMigrationMockDriveStore()
	legacyRootID, _ := store.addLegacyData(1, true)

	files, err := store.newOps(false).ListFiles(fmt.Sprintf("name='noteList_v2.json' and '%s' in parents and trashed=false", legacyRootID))
	require.NoError(t, err)
	require.Len(t, files, 1)
	store.downloadErrByID[files[0].Id] = fmt.Errorf("download failed")

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	err = ds.executeMigration(false)
	assert.Error(t, err)
	assert.False(t, ds.isMigrated())
}

func TestExecuteMigration_PartialNoteCopyFailureReturnsErrorAndDoesNotMarkMigrated(t *testing.T) {
	store := newMigrationMockDriveStore()
	_, notesID := store.addLegacyData(2, true)

	noteFiles, err := store.newOps(false).ListFiles(fmt.Sprintf("'%s' in parents and trashed=false", notesID))
	require.NoError(t, err)
	require.Len(t, noteFiles, 2)
	store.downloadErrByID[noteFiles[0].Id] = fmt.Errorf("download failed")

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	err = ds.executeMigration(true)
	assert.Error(t, err)
	assert.False(t, ds.isMigrated())
	assert.True(t, store.hasFile("legacy", "monaco-notepad", ""), "legacy data should not be deleted on failed migration")
}

func TestExecuteMigration_AllNoteCopiesFailReturnsErrorAndDoesNotMarkMigrated(t *testing.T) {
	store := newMigrationMockDriveStore()
	_, notesID := store.addLegacyData(2, true)

	noteFiles, err := store.newOps(false).ListFiles(fmt.Sprintf("'%s' in parents and trashed=false", notesID))
	require.NoError(t, err)
	require.Len(t, noteFiles, 2)
	for _, f := range noteFiles {
		store.downloadErrByID[f.Id] = fmt.Errorf("download failed")
	}

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	err = ds.executeMigration(false)
	assert.Error(t, err)
	assert.False(t, ds.isMigrated())
}

func TestExecuteMigration_SuccessAllCopiedSavesMigratedState(t *testing.T) {
	store := newMigrationMockDriveStore()
	store.addLegacyData(2, true)

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	require.NoError(t, ds.executeMigration(false))
	state := ds.loadMigrationState()
	assert.True(t, state.Migrated)
	assert.NotEmpty(t, state.MigratedAt)
	assert.False(t, state.OldDataDeleted)
}

func TestCheckAppDataFolderExists_ReturnsTrueWhenFolderExists(t *testing.T) {
	store := newMigrationMockDriveStore()
	store.addAppDataRoot(false)
	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	assert.True(t, ds.checkAppDataFolderExists(store.newOps(true)))
}

func TestCheckAppDataFolderExists_ReturnsFalseWhenFolderMissing(t *testing.T) {
	store := newMigrationMockDriveStore()
	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	assert.False(t, ds.checkAppDataFolderExists(store.newOps(true)))
}

func TestCheckAppDataFolderExists_ReturnsFalseOnAPIError(t *testing.T) {
	store := newMigrationMockDriveStore()
	store.listErrByContains["name='monaco-notepad'"] = fmt.Errorf("list failed")
	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	assert.False(t, ds.checkAppDataFolderExists(store.newOps(true)))
}

func TestCheckOldDriveFoldersExist_CoversExistsMissingAndError(t *testing.T) {
	t.Run("exists", func(t *testing.T) {
		store := newMigrationMockDriveStore()
		store.addLegacyData(0, false)
		ds, cleanup := newMigrationTestDriveService(t, store)
		defer cleanup()
		assert.True(t, ds.checkOldDriveFoldersExist(store.newOps(false)))
	})

	t.Run("missing", func(t *testing.T) {
		store := newMigrationMockDriveStore()
		ds, cleanup := newMigrationTestDriveService(t, store)
		defer cleanup()
		assert.False(t, ds.checkOldDriveFoldersExist(store.newOps(false)))
	})

	t.Run("error", func(t *testing.T) {
		store := newMigrationMockDriveStore()
		store.listErrByContains["name='monaco-notepad'"] = fmt.Errorf("list failed")
		ds, cleanup := newMigrationTestDriveService(t, store)
		defer cleanup()
		assert.False(t, ds.checkOldDriveFoldersExist(store.newOps(false)))
	})
}

func TestExecuteMigration_FreshInstallMarksMigrated(t *testing.T) {
	store := newMigrationMockDriveStore()
	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	require.NoError(t, ds.executeMigration(false))
	assert.True(t, ds.isMigrated())
	assert.Equal(t, 0, store.fileCountBySpace("legacy"))
	assert.Equal(t, 0, store.fileCountBySpace("appData"))
}

func TestExecuteMigration_CopiesNoteListAndNotesToAppDataFolder(t *testing.T) {
	store := newMigrationMockDriveStore()
	legacyRootID, _ := store.addLegacyData(2, true)
	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	require.NoError(t, ds.executeMigration(false))
	appRootID := store.findFolderID("appData", "monaco-notepad", "appDataFolder")
	if appRootID == "" {
		appRootID = store.findFolderID("appData", "monaco-notepad", "")
	}
	require.NotEmpty(t, appRootID)
	appNotesID := store.findFolderID("appData", "notes", appRootID)
	require.NotEmpty(t, appNotesID)
	assert.True(t, store.hasFile("appData", "noteList_v2.json", appRootID))
	assert.True(t, store.hasFile("legacy", "noteList_v2.json", legacyRootID))
	assert.True(t, store.hasFile("appData", "note-1.json", appNotesID))
	assert.True(t, store.hasFile("appData", "note-2.json", appNotesID))
}

func TestExecuteMigration_DeleteOldTrueDeletesLegacyDataAfterCopy(t *testing.T) {
	store := newMigrationMockDriveStore()
	store.addLegacyData(1, true)
	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	require.NoError(t, ds.executeMigration(true))
	assert.False(t, store.hasFile("legacy", "monaco-notepad", ""))
	state := ds.loadMigrationState()
	assert.True(t, state.OldDataDeleted)
}

func TestExecuteMigration_DeleteOldFalseKeepsLegacyData(t *testing.T) {
	store := newMigrationMockDriveStore()
	store.addLegacyData(1, true)
	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	require.NoError(t, ds.executeMigration(false))
	assert.True(t, store.hasFile("legacy", "monaco-notepad", ""))
	state := ds.loadMigrationState()
	assert.False(t, state.OldDataDeleted)
}

func TestExecuteMigration_AppDataAlreadyHasDataSkipsCopyAndSavesState(t *testing.T) {
	store := newMigrationMockDriveStore()
	store.addLegacyData(2, true)
	store.addAppDataRoot(true)
	beforeCreateCalls := len(store.createCalls)

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	require.NoError(t, ds.executeMigration(false))
	state := ds.loadMigrationState()
	assert.True(t, state.Migrated)
	assert.Equal(t, beforeCreateCalls, len(store.createCalls), "copy should be skipped when appData already exists")
}

func TestDeleteOldDriveData_SuccessAndNoFolderNoop(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		store := newMigrationMockDriveStore()
		store.addLegacyData(1, true)
		ds, cleanup := newMigrationTestDriveService(t, store)
		defer cleanup()

		ds.deleteOldDriveData(store.newOps(false))
		assert.False(t, store.hasFile("legacy", "monaco-notepad", ""))
	})

	t.Run("noop", func(t *testing.T) {
		store := newMigrationMockDriveStore()
		ds, cleanup := newMigrationTestDriveService(t, store)
		defer cleanup()

		ds.deleteOldDriveData(store.newOps(false))
		assert.Empty(t, store.deleteCalls)
	})
}

func TestDeleteOldDriveData_DeleteErrorsDoNotPanicAndContinue(t *testing.T) {
	store := newMigrationMockDriveStore()
	rootID1 := store.addFile("legacy", "monaco-notepad", "", "application/vnd.google-apps.folder", nil)
	rootID2 := store.addFile("legacy", "monaco-notepad", "", "application/vnd.google-apps.folder", nil)
	store.deleteErrByID[rootID1] = fmt.Errorf("delete failed")

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	assert.NotPanics(t, func() {
		ds.deleteOldDriveData(store.newOps(false))
	})
	assert.True(t, store.hasFile("legacy", "monaco-notepad", ""), "at least one folder remains after delete failure")
	assert.False(t, func() bool {
		store.mu.RLock()
		defer store.mu.RUnlock()
		f, ok := store.files[rootID2]
		return ok && !f.trashed
	}())
}

func TestOnConnected_AppDataOnlyNoLegacyAutoUpdatesLocalMigrationState(t *testing.T) {
	store := newMigrationMockDriveStore()
	// レガシーなし、appDataのみ → 別デバイスで移行+削除済み
	appRootID, _ := store.addAppDataRoot(true)
	require.NotEmpty(t, appRootID)

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	require.NoError(t, ds.onConnected())
	assert.True(t, ds.isMigrated())
	assert.True(t, store.hasFile("appData", "monaco-notepad", ""), "appData should be preserved")
}

func TestOnConnected_AppDataAndLegacyWithMarkerAcceptsAppData(t *testing.T) {
	store := newMigrationMockDriveStore()
	store.addLegacyData(2, true)
	appRootID, appNotesID := store.addAppDataRoot(true)
	store.addMigrationCompleteMarker(appRootID)
	store.addFile("appData", "note-new.json", appNotesID, "application/json", []byte(`{"id":"new"}`))

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	require.NoError(t, ds.onConnected())
	assert.True(t, ds.isMigrated())
	assert.True(t, store.hasFile("appData", "note-new.json", appNotesID), "post-migration data should be preserved")
}

func TestOnConnected_AppDataAndLegacyWithoutMarkerCleansUpAndShowsDialog(t *testing.T) {
	store := newMigrationMockDriveStore()
	store.addLegacyData(2, true)
	store.addAppDataRoot(true)

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	ds.migrationChoiceChan <- "migrate_keep"
	require.NoError(t, ds.onConnected())

	assert.True(t, ds.isMigrated())
	assert.True(t, store.hasFile("legacy", "monaco-notepad", ""), "legacy data preserved with migrate_keep")

	newAppRootID := store.findFolderID("appData", "monaco-notepad", "appDataFolder")
	require.NotEmpty(t, newAppRootID, "new appData root should be created by re-migration")
	newNotesID := store.findFolderID("appData", "notes", newAppRootID)
	require.NotEmpty(t, newNotesID)
	assert.True(t, store.hasFile("appData", "note-1.json", newNotesID))
	assert.True(t, store.hasFile("appData", "note-2.json", newNotesID))
}

func TestOnConnected_InterruptedMigrationPartialDataCleansUpAndReMigrates(t *testing.T) {
	store := newMigrationMockDriveStore()
	store.addLegacyData(3, true)

	// 中断されたマイグレーションをシミュレート: appDataにフォルダ構造のみ（ノートなし）
	store.addFile("appData", "monaco-notepad", "", "application/vnd.google-apps.folder", nil)

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	ds.migrationChoiceChan <- "migrate_delete"
	require.NoError(t, ds.onConnected())

	assert.True(t, ds.isMigrated())
	state := ds.loadMigrationState()
	assert.True(t, state.OldDataDeleted)

	newAppRootID := store.findFolderID("appData", "monaco-notepad", "appDataFolder")
	require.NotEmpty(t, newAppRootID)
	newNotesID := store.findFolderID("appData", "notes", newAppRootID)
	require.NotEmpty(t, newNotesID)
	assert.True(t, store.hasFile("appData", "note-1.json", newNotesID))
	assert.True(t, store.hasFile("appData", "note-2.json", newNotesID))
	assert.True(t, store.hasFile("appData", "note-3.json", newNotesID))
}

func TestOnConnected_InterruptedMigrationSkipChoiceUsesLegacy(t *testing.T) {
	store := newMigrationMockDriveStore()
	store.addLegacyData(1, true)
	store.addFile("appData", "monaco-notepad", "", "application/vnd.google-apps.folder", nil)

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	ds.migrationChoiceChan <- "skip"
	require.NoError(t, ds.onConnected())

	assert.False(t, ds.isMigrated())
}

func TestExecuteMigration_WritesCompleteMarkerToAppDataFolder(t *testing.T) {
	store := newMigrationMockDriveStore()
	store.addLegacyData(1, true)

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	require.NoError(t, ds.executeMigration(false))

	appRootID := store.findFolderID("appData", "monaco-notepad", "appDataFolder")
	require.NotEmpty(t, appRootID)
	assert.True(t, store.hasFile("appData", migrationCompleteMarkerName, appRootID))
}

func TestCheckMigrationCompleteMarker_TrueWhenMarkerExists(t *testing.T) {
	store := newMigrationMockDriveStore()
	appRootID, _ := store.addAppDataRoot(false)
	store.addMigrationCompleteMarker(appRootID)

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	assert.True(t, ds.checkMigrationCompleteMarker(store.newOps(true)))
}

func TestCheckMigrationCompleteMarker_FalseWhenNoMarker(t *testing.T) {
	store := newMigrationMockDriveStore()
	store.addAppDataRoot(false)

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	assert.False(t, ds.checkMigrationCompleteMarker(store.newOps(true)))
}

func TestCheckMigrationCompleteMarker_FalseWhenNoFolder(t *testing.T) {
	store := newMigrationMockDriveStore()
	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	assert.False(t, ds.checkMigrationCompleteMarker(store.newOps(true)))
}

func TestCleanupAppDataFolder_DeletesFolderAndContents(t *testing.T) {
	store := newMigrationMockDriveStore()
	appRootID, appNotesID := store.addAppDataRoot(true)
	store.addFile("appData", "note-1.json", appNotesID, "application/json", []byte(`{}`))

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	ds.cleanupAppDataFolder(store.newOps(true))
	assert.False(t, store.hasFile("appData", "monaco-notepad", ""), "root folder should be deleted")
	_ = appRootID
}

func TestCleanupAppDataFolder_NoFolderIsNoop(t *testing.T) {
	store := newMigrationMockDriveStore()
	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	assert.NotPanics(t, func() {
		ds.cleanupAppDataFolder(store.newOps(true))
	})
}

func TestOnConnected_SkipChoiceContinuesLegacyModeWithoutSavingMigrationState(t *testing.T) {
	store := newMigrationMockDriveStore()
	store.addLegacyData(1, true)

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	ds.migrationChoiceChan <- "skip"
	require.NoError(t, ds.onConnected())
	assert.False(t, ds.isMigrated())
	_, err := os.Stat(filepath.Join(ds.appDataDir, migrationStateFileName))
	assert.Error(t, err)
	assert.True(t, os.IsNotExist(err))
}

func TestOnConnected_MigrationChoiceTimeoutFallsBackToLegacyMode(t *testing.T) {
	store := newMigrationMockDriveStore()
	store.addLegacyData(1, true)

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()
	ds.migrationChoiceWait = 0

	require.NoError(t, ds.onConnected())
	assert.False(t, ds.isMigrated())
	_, err := os.Stat(filepath.Join(ds.appDataDir, migrationStateFileName))
	assert.Error(t, err)
	assert.True(t, os.IsNotExist(err))
}

func TestOnConnected_MigrateKeepChoiceCopiesDataAndKeepsLegacyData(t *testing.T) {
	store := newMigrationMockDriveStore()
	store.addLegacyData(2, true)

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	ds.migrationChoiceChan <- "migrate_keep"
	require.NoError(t, ds.onConnected())

	state := ds.loadMigrationState()
	assert.True(t, state.Migrated)
	assert.False(t, state.OldDataDeleted)

	appRootID := store.findFolderID("appData", "monaco-notepad", "appDataFolder")
	require.NotEmpty(t, appRootID)
	assert.True(t, store.hasFile("appData", "noteList_v2.json", appRootID))
	assert.True(t, store.hasFile("legacy", "monaco-notepad", ""))
}

func TestOnConnected_MigrateDeleteChoiceDeletesLegacyData(t *testing.T) {
	store := newMigrationMockDriveStore()
	store.addLegacyData(2, true)

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	ds.migrationChoiceChan <- "migrate_delete"
	require.NoError(t, ds.onConnected())

	state := ds.loadMigrationState()
	assert.True(t, state.Migrated)
	assert.True(t, state.OldDataDeleted)
	assert.False(t, store.hasFile("legacy", "monaco-notepad", ""))
}

func TestOnConnected_MigrationReauthFailureFallsBackToLegacyMode(t *testing.T) {
	store := newMigrationMockDriveStore()
	store.addLegacyData(1, true)
	store.setListError("appData", "trashed=false", fmt.Errorf("insufficientPermissions"))

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	ds.migrationChoiceChan <- "migrate_keep"
	require.NoError(t, ds.onConnected())

	assert.False(t, ds.isMigrated())
	assert.True(t, store.hasFile("legacy", "monaco-notepad", ""))
	assert.False(t, store.hasFile("appData", "monaco-notepad", "appDataFolder"))

	_, err := os.Stat(filepath.Join(ds.appDataDir, migrationStateFileName))
	assert.Error(t, err)
	assert.True(t, os.IsNotExist(err))
}

func TestCheckAppDataFolderCanCreate_ReturnsFalseOnScopeError(t *testing.T) {
	store := newMigrationMockDriveStore()
	store.listErrByContains["trashed=false"] = fmt.Errorf("insufficientPermissions")

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	assert.False(t, ds.checkAppDataFolderCanCreate(store.newOps(true)))
}

func TestCheckAppDataFolderCanCreate_ReturnsTrueWhenAccessible(t *testing.T) {
	store := newMigrationMockDriveStore()
	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	assert.True(t, ds.checkAppDataFolderCanCreate(store.newOps(true)))
}

func TestOnConnected_MigrateKeep_CleansUpOrphansBeforeMigration(t *testing.T) {
	store := newMigrationMockDriveStore()
	rootID, notesID := store.addLegacyData(0, true)

	existingNote := &Note{
		ID: "existing-1", Title: "Existing", Content: "same content",
		Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339),
	}
	existingData, _ := json.Marshal(existingNote)
	store.addFile("legacy", "existing-1.json", notesID, "application/json", existingData)

	duplicateConflict := &Note{
		ID: "dup-conflict", Title: "Existing - conflict copy",
		Content: "same content", Language: "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	dupData, _ := json.Marshal(duplicateConflict)
	dupFileID := store.addFile("legacy", "dup-conflict.json", notesID, "application/json", dupData)

	uniqueConflict := &Note{
		ID: "unique-conflict", Title: "Existing - conflict copy 2",
		Content: "unique content", Language: "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	uniqueData, _ := json.Marshal(uniqueConflict)
	store.addFile("legacy", "unique-conflict.json", notesID, "application/json", uniqueData)

	noteList := &NoteList{
		Version: CurrentVersion,
		Notes: []NoteMetadata{{
			ID: "existing-1", Title: "Existing",
			Language: "plaintext", ModifiedTime: existingNote.ModifiedTime,
			ContentHash: computeContentHash(existingNote),
		}},
	}
	noteListData, _ := json.Marshal(noteList)
	_ = rootID
	store.mu.Lock()
	for _, f := range store.files {
		if f.name == "noteList_v2.json" && f.space == "legacy" {
			f.content = noteListData
			break
		}
	}
	store.mu.Unlock()

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	require.NoError(t, ds.noteService.SaveNote(existingNote))

	ds.migrationChoiceChan <- "migrate_keep"
	require.NoError(t, ds.onConnected())

	assert.True(t, ds.isMigrated())

	store.mu.RLock()
	dupFile, dupExists := store.files[dupFileID]
	store.mu.RUnlock()
	assert.True(t, !dupExists || dupFile.trashed, "duplicate conflict copy should be deleted before migration")

	appNotesID := store.findFolderID("appData", "notes", "")
	if appNotesID == "" {
		appRootID := store.findFolderID("appData", "monaco-notepad", "appDataFolder")
		require.NotEmpty(t, appRootID)
		appNotesID = store.findFolderID("appData", "notes", appRootID)
	}
	require.NotEmpty(t, appNotesID)

	assert.False(t, store.hasFile("appData", "dup-conflict.json", appNotesID),
		"duplicate conflict copy should not be migrated to appDataFolder")
}

func TestCleanupLegacyOrphans_UpdatesDriveNoteListAfterRecovery(t *testing.T) {
	store := newMigrationMockDriveStore()
	_, notesID := store.addLegacyData(0, true)

	existingNote := &Note{
		ID: "existing-1", Title: "Existing", Content: "existing content",
		Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339),
	}
	existingData, _ := json.Marshal(existingNote)
	store.addFile("legacy", "existing-1.json", notesID, "application/json", existingData)

	orphanNote := &Note{
		ID: "orphan-1", Title: "Orphan Note", Content: "orphan content",
		Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339),
	}
	orphanData, _ := json.Marshal(orphanNote)
	store.addFile("legacy", "orphan-1.json", notesID, "application/json", orphanData)

	noteList := &NoteList{
		Version: CurrentVersion,
		Notes: []NoteMetadata{{
			ID: "existing-1", Title: "Existing",
			Language: "plaintext", ModifiedTime: existingNote.ModifiedTime,
			ContentHash: computeContentHash(existingNote),
		}},
	}
	noteListData, _ := json.Marshal(noteList)
	store.mu.Lock()
	for _, f := range store.files {
		if f.name == "noteList_v2.json" && f.space == "legacy" {
			f.content = noteListData
			break
		}
	}
	store.mu.Unlock()

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	require.NoError(t, ds.noteService.SaveNote(existingNote))

	legacyOps := store.newOps(false)
	ds.cleanupLegacyOrphansBeforeMigration(legacyOps)

	require.Len(t, ds.noteService.noteList.Notes, 1, "local noteList should NOT be modified")
	assert.Equal(t, "existing-1", ds.noteService.noteList.Notes[0].ID)

	var driveNoteListContent []byte
	store.mu.RLock()
	for _, f := range store.files {
		if f.name == "noteList_v2.json" && f.space == "legacy" && !f.trashed {
			driveNoteListContent = append([]byte(nil), f.content...)
			break
		}
	}
	store.mu.RUnlock()
	require.NotNil(t, driveNoteListContent, "Drive noteList_v2.json should exist")

	var driveNoteList NoteList
	require.NoError(t, json.Unmarshal(driveNoteListContent, &driveNoteList))
	assert.Len(t, driveNoteList.Notes, 2, "Drive noteList should contain the recovered orphan")

	driveNoteIDs := make(map[string]bool)
	for _, n := range driveNoteList.Notes {
		driveNoteIDs[n.ID] = true
	}
	assert.True(t, driveNoteIDs["existing-1"], "Drive noteList should contain existing note")
	assert.True(t, driveNoteIDs["orphan-1"], "Drive noteList should contain recovered orphan")

	hasRecoveryFolder := false
	for _, f := range driveNoteList.Folders {
		if f.Name == RecoveryFolderName {
			hasRecoveryFolder = true
			for _, n := range driveNoteList.Notes {
				if n.ID == "orphan-1" {
					assert.Equal(t, f.ID, n.FolderID, "orphan should be in recovery folder")
				}
			}
			break
		}
	}
	assert.True(t, hasRecoveryFolder, "Drive noteList should have recovery folder")
}

func TestCleanupLegacyOrphans_NoRecovery_DoesNotUpdateDriveNoteList(t *testing.T) {
	store := newMigrationMockDriveStore()
	_, notesID := store.addLegacyData(0, true)

	existingNote := &Note{
		ID: "existing-1", Title: "Existing", Content: "content",
		Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339),
	}
	existingData, _ := json.Marshal(existingNote)
	store.addFile("legacy", "existing-1.json", notesID, "application/json", existingData)

	noteList := &NoteList{
		Version: CurrentVersion,
		Notes: []NoteMetadata{{
			ID: "existing-1", Title: "Existing",
			Language: "plaintext", ModifiedTime: existingNote.ModifiedTime,
			ContentHash: computeContentHash(existingNote),
		}},
	}
	noteListData, _ := json.Marshal(noteList)
	store.mu.Lock()
	var originalNoteListFileID string
	for _, f := range store.files {
		if f.name == "noteList_v2.json" && f.space == "legacy" {
			f.content = noteListData
			originalNoteListFileID = f.id
			break
		}
	}
	store.mu.Unlock()

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	require.NoError(t, ds.noteService.SaveNote(existingNote))

	legacyOps := store.newOps(false)
	ds.cleanupLegacyOrphansBeforeMigration(legacyOps)

	store.mu.RLock()
	f := store.files[originalNoteListFileID]
	store.mu.RUnlock()

	var driveNoteList NoteList
	require.NoError(t, json.Unmarshal(f.content, &driveNoteList))
	assert.Len(t, driveNoteList.Notes, 1, "Drive noteList should not be modified when no orphans recovered")
}

func TestCleanupLegacyOrphans_DoesNotSaveOrphanFilesLocally(t *testing.T) {
	store := newMigrationMockDriveStore()
	_, notesID := store.addLegacyData(0, true)

	existingNote := &Note{
		ID: "existing-1", Title: "Existing", Content: "existing content",
		Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339),
	}
	existingData, _ := json.Marshal(existingNote)
	store.addFile("legacy", "existing-1.json", notesID, "application/json", existingData)

	orphanNote := &Note{
		ID: "orphan-local-check", Title: "Orphan Local Check", Content: "orphan content",
		Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339),
	}
	orphanData, _ := json.Marshal(orphanNote)
	store.addFile("legacy", "orphan-local-check.json", notesID, "application/json", orphanData)

	noteList := &NoteList{
		Version: CurrentVersion,
		Notes: []NoteMetadata{{
			ID: "existing-1", Title: "Existing",
			Language: "plaintext", ModifiedTime: existingNote.ModifiedTime,
			ContentHash: computeContentHash(existingNote),
		}},
	}
	noteListData, _ := json.Marshal(noteList)
	store.mu.Lock()
	for _, f := range store.files {
		if f.name == "noteList_v2.json" && f.space == "legacy" {
			f.content = noteListData
			break
		}
	}
	store.mu.Unlock()

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	require.NoError(t, ds.noteService.SaveNote(existingNote))

	legacyOps := store.newOps(false)
	ds.cleanupLegacyOrphansBeforeMigration(legacyOps)

	_, err := ds.noteService.LoadNote("orphan-local-check")
	assert.Error(t, err, "orphan note file should NOT exist locally")
}

func TestCleanupLegacyOrphans_ConflictCopyDedup_DeletesFromDrive(t *testing.T) {
	store := newMigrationMockDriveStore()
	_, notesID := store.addLegacyData(0, true)

	existingNote := &Note{
		ID: "existing-1", Title: "Existing", Content: "same content",
		Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339),
	}
	existingData, _ := json.Marshal(existingNote)
	store.addFile("legacy", "existing-1.json", notesID, "application/json", existingData)

	dupConflict := &Note{
		ID: "dup-conflict-1", Title: "Existing (conflict copy 2026-01-01)",
		Content: "same content", Language: "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	dupData, _ := json.Marshal(dupConflict)
	dupFileID := store.addFile("legacy", "dup-conflict-1.json", notesID, "application/json", dupData)

	uniqueConflict := &Note{
		ID: "unique-conflict-1", Title: "Existing (conflict copy 2026-01-02)",
		Content: "unique content", Language: "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	uniqueData, _ := json.Marshal(uniqueConflict)
	store.addFile("legacy", "unique-conflict-1.json", notesID, "application/json", uniqueData)

	noteList := &NoteList{
		Version: CurrentVersion,
		Notes: []NoteMetadata{{
			ID: "existing-1", Title: "Existing",
			Language: "plaintext", ModifiedTime: existingNote.ModifiedTime,
			ContentHash: computeContentHash(existingNote),
		}},
	}
	noteListData, _ := json.Marshal(noteList)
	store.mu.Lock()
	for _, f := range store.files {
		if f.name == "noteList_v2.json" && f.space == "legacy" {
			f.content = noteListData
			break
		}
	}
	store.mu.Unlock()

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	require.NoError(t, ds.noteService.SaveNote(existingNote))

	legacyOps := store.newOps(false)
	ds.cleanupLegacyOrphansBeforeMigration(legacyOps)

	require.Len(t, ds.noteService.noteList.Notes, 1, "local noteList should NOT be modified")

	store.mu.RLock()
	dupFile, dupExists := store.files[dupFileID]
	store.mu.RUnlock()
	assert.True(t, !dupExists || dupFile.trashed, "duplicate conflict copy should be deleted from Drive")

	var driveNoteListContent []byte
	store.mu.RLock()
	for _, f := range store.files {
		if f.name == "noteList_v2.json" && f.space == "legacy" && !f.trashed {
			driveNoteListContent = append([]byte(nil), f.content...)
			break
		}
	}
	store.mu.RUnlock()

	var driveNoteList NoteList
	require.NoError(t, json.Unmarshal(driveNoteListContent, &driveNoteList))
	assert.Len(t, driveNoteList.Notes, 2, "cloud noteList should have existing + unique conflict")

	driveNoteIDs := make(map[string]bool)
	for _, n := range driveNoteList.Notes {
		driveNoteIDs[n.ID] = true
	}
	assert.True(t, driveNoteIDs["existing-1"])
	assert.True(t, driveNoteIDs["unique-conflict-1"], "unique conflict copy should be in cloud noteList")
	assert.False(t, driveNoteIDs["dup-conflict-1"], "duplicate conflict copy should NOT be in cloud noteList")
}

func TestCleanupLegacyOrphans_ReusesExistingRecoveryFolder(t *testing.T) {
	store := newMigrationMockDriveStore()
	_, notesID := store.addLegacyData(0, true)

	existingNote := &Note{
		ID: "existing-1", Title: "Existing", Content: "content",
		Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339),
	}
	existingData, _ := json.Marshal(existingNote)
	store.addFile("legacy", "existing-1.json", notesID, "application/json", existingData)

	orphan1 := &Note{
		ID: "orphan-1", Title: "Orphan 1", Content: "o1",
		Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339),
	}
	orphan1Data, _ := json.Marshal(orphan1)
	store.addFile("legacy", "orphan-1.json", notesID, "application/json", orphan1Data)

	orphan2 := &Note{
		ID: "orphan-2", Title: "Orphan 2", Content: "o2",
		Language: "plaintext", ModifiedTime: time.Now().Format(time.RFC3339),
	}
	orphan2Data, _ := json.Marshal(orphan2)
	store.addFile("legacy", "orphan-2.json", notesID, "application/json", orphan2Data)

	existingFolderID := "recovery-folder-existing"
	noteList := &NoteList{
		Version: CurrentVersion,
		Notes: []NoteMetadata{{
			ID: "existing-1", Title: "Existing",
			Language: "plaintext", ModifiedTime: existingNote.ModifiedTime,
			ContentHash: computeContentHash(existingNote),
		}},
		Folders: []Folder{{ID: existingFolderID, Name: RecoveryFolderName}},
	}
	noteListData, _ := json.Marshal(noteList)
	store.mu.Lock()
	for _, f := range store.files {
		if f.name == "noteList_v2.json" && f.space == "legacy" {
			f.content = noteListData
			break
		}
	}
	store.mu.Unlock()

	ds, cleanup := newMigrationTestDriveService(t, store)
	defer cleanup()

	require.NoError(t, ds.noteService.SaveNote(existingNote))

	legacyOps := store.newOps(false)
	ds.cleanupLegacyOrphansBeforeMigration(legacyOps)

	var driveNoteListContent []byte
	store.mu.RLock()
	for _, f := range store.files {
		if f.name == "noteList_v2.json" && f.space == "legacy" && !f.trashed {
			driveNoteListContent = append([]byte(nil), f.content...)
			break
		}
	}
	store.mu.RUnlock()

	var driveNoteList NoteList
	require.NoError(t, json.Unmarshal(driveNoteListContent, &driveNoteList))

	folderCount := 0
	for _, f := range driveNoteList.Folders {
		if f.Name == RecoveryFolderName {
			folderCount++
			assert.Equal(t, existingFolderID, f.ID, "should reuse existing recovery folder ID")
		}
	}
	assert.Equal(t, 1, folderCount, "should have exactly one recovery folder")

	for _, n := range driveNoteList.Notes {
		if n.ID == "orphan-1" || n.ID == "orphan-2" {
			assert.Equal(t, existingFolderID, n.FolderID, "orphan should be placed in existing recovery folder")
		}
	}
}
