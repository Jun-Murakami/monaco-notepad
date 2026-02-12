package backend

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// SyncState はローカル端末の同期状態を管理する
// sync_state.json としてappDataDirに保存する（Driveにはアップロードしない）
type SyncState struct {
	Dirty              bool              `json:"dirty"`
	LastSyncedDriveTs  string            `json:"lastSyncedDriveTs"`
	DirtyNoteIDs       map[string]bool   `json:"dirtyNoteIDs"`
	DeletedNoteIDs     map[string]bool   `json:"deletedNoteIDs"`
	LastSyncedNoteHash map[string]string `json:"lastSyncedNoteHash"`

	mu       sync.Mutex `json:"-"`
	filePath string     `json:"-"`
	revision uint64     `json:"-"`
}

func NewSyncState(appDataDir string) *SyncState {
	return &SyncState{
		Dirty:              false,
		LastSyncedDriveTs:  "",
		DirtyNoteIDs:       make(map[string]bool),
		DeletedNoteIDs:     make(map[string]bool),
		LastSyncedNoteHash: make(map[string]string),
		filePath:           filepath.Join(appDataDir, "sync_state.json"),
	}
}

func (s *SyncState) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			s.resetLocked(false)
			return nil
		}
		return fmt.Errorf("failed to read sync state file: %w", err)
	}

	var loaded SyncState
	if err := json.Unmarshal(data, &loaded); err != nil {
		s.resetLocked(true)
		return nil
	}

	s.Dirty = loaded.Dirty
	s.LastSyncedDriveTs = loaded.LastSyncedDriveTs
	s.DirtyNoteIDs = loaded.DirtyNoteIDs
	s.DeletedNoteIDs = loaded.DeletedNoteIDs
	s.LastSyncedNoteHash = loaded.LastSyncedNoteHash
	s.ensureMapsLocked()

	return nil
}

func (s *SyncState) Save() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.saveLocked()
}

func (s *SyncState) MarkNoteDirty(noteID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.revision++
	s.Dirty = true
	s.ensureMapsLocked()
	s.DirtyNoteIDs[noteID] = true
	_ = s.saveLocked()
}

func (s *SyncState) MarkNoteDeleted(noteID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.revision++
	s.Dirty = true
	s.ensureMapsLocked()
	s.DeletedNoteIDs[noteID] = true
	delete(s.DirtyNoteIDs, noteID)
	_ = s.saveLocked()
}

func (s *SyncState) MarkDirty() {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.revision++
	s.Dirty = true
	_ = s.saveLocked()
}

func (s *SyncState) ClearDirty(driveTs string, noteHashes map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.revision++
	s.clearDirtyLocked(driveTs, noteHashes)
	_ = s.saveLocked()
}

// ClearDirtyIfUnchanged は、スナップショット取得後に状態更新が無い場合のみ dirty をクリアする
// 戻り値が false の場合は、同期中に新しい更新が入ったため dirty を保持して次回同期へ回す
func (s *SyncState) ClearDirtyIfUnchanged(snapshotRevision uint64, driveTs string, noteHashes map[string]string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.revision != snapshotRevision {
		return false
	}
	s.revision++
	s.clearDirtyLocked(driveTs, noteHashes)
	_ = s.saveLocked()
	return true
}

func (s *SyncState) clearDirtyLocked(driveTs string, noteHashes map[string]string) {
	s.Dirty = false
	s.DirtyNoteIDs = make(map[string]bool)
	s.DeletedNoteIDs = make(map[string]bool)
	s.LastSyncedDriveTs = driveTs
	s.LastSyncedNoteHash = make(map[string]string, len(noteHashes))
	for k, v := range noteHashes {
		s.LastSyncedNoteHash[k] = v
	}
}

func (s *SyncState) IsDirty() bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.Dirty
}

func (s *SyncState) GetDirtySnapshot() (dirtyNoteIDs map[string]bool, deletedNoteIDs map[string]bool, lastSyncedNoteHash map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	dirtyNoteIDs = make(map[string]bool, len(s.DirtyNoteIDs))
	for id := range s.DirtyNoteIDs {
		dirtyNoteIDs[id] = true
	}
	deletedNoteIDs = make(map[string]bool, len(s.DeletedNoteIDs))
	for id := range s.DeletedNoteIDs {
		deletedNoteIDs[id] = true
	}
	lastSyncedNoteHash = make(map[string]string, len(s.LastSyncedNoteHash))
	for k, v := range s.LastSyncedNoteHash {
		lastSyncedNoteHash[k] = v
	}

	return
}

// GetDirtySnapshotWithRevision は dirty スナップショットと同時に revision を返す
func (s *SyncState) GetDirtySnapshotWithRevision() (dirtyNoteIDs map[string]bool, deletedNoteIDs map[string]bool, lastSyncedNoteHash map[string]string, revision uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()

	dirtyNoteIDs = make(map[string]bool, len(s.DirtyNoteIDs))
	for id := range s.DirtyNoteIDs {
		dirtyNoteIDs[id] = true
	}
	deletedNoteIDs = make(map[string]bool, len(s.DeletedNoteIDs))
	for id := range s.DeletedNoteIDs {
		deletedNoteIDs[id] = true
	}
	lastSyncedNoteHash = make(map[string]string, len(s.LastSyncedNoteHash))
	for k, v := range s.LastSyncedNoteHash {
		lastSyncedNoteHash[k] = v
	}
	revision = s.revision

	return
}

func (s *SyncState) resetLocked(dirty bool) {
	s.Dirty = dirty
	s.LastSyncedDriveTs = ""
	s.DirtyNoteIDs = make(map[string]bool)
	s.DeletedNoteIDs = make(map[string]bool)
	s.LastSyncedNoteHash = make(map[string]string)
}

func (s *SyncState) ensureMapsLocked() {
	if s.DirtyNoteIDs == nil {
		s.DirtyNoteIDs = make(map[string]bool)
	}
	if s.DeletedNoteIDs == nil {
		s.DeletedNoteIDs = make(map[string]bool)
	}
	if s.LastSyncedNoteHash == nil {
		s.LastSyncedNoteHash = make(map[string]string)
	}
}

func (s *SyncState) saveLocked() error {
	s.ensureMapsLocked()

	if err := os.MkdirAll(filepath.Dir(s.filePath), 0755); err != nil {
		return fmt.Errorf("failed to create sync state directory: %w", err)
	}

	tmpPath := s.filePath + ".tmp"
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal sync state: %w", err)
	}

	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write temp sync state file: %w", err)
	}

	if err := os.Rename(tmpPath, s.filePath); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to replace sync state file: %w", err)
	}

	return nil
}
