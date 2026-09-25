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
	Dirty               bool              `json:"dirty"`
	LastSyncedDriveTs   string            `json:"lastSyncedDriveTs"`
	DirtyNoteIDs        map[string]bool   `json:"dirtyNoteIDs"`
	DeletedNoteIDs      map[string]bool   `json:"deletedNoteIDs"`
	DeletedFolderIDs    map[string]bool   `json:"deletedFolderIDs"`
	LastSyncedNoteHash  map[string]string `json:"lastSyncedNoteHash"`
	FullReuploadPending bool              `json:"fullReuploadPending"`

	mu       sync.Mutex `json:"-"`
	filePath string     `json:"-"`
	revision uint64     `json:"-"`
}

func NewSyncState(appDataDir string) *SyncState {
	return &SyncState{
		Dirty:               false,
		LastSyncedDriveTs:   "",
		DirtyNoteIDs:        make(map[string]bool),
		DeletedNoteIDs:      make(map[string]bool),
		DeletedFolderIDs:    make(map[string]bool),
		LastSyncedNoteHash:  make(map[string]string),
		FullReuploadPending: false,
		filePath:            filepath.Join(appDataDir, "sync_state.json"),
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
	s.DeletedFolderIDs = loaded.DeletedFolderIDs
	s.LastSyncedNoteHash = loaded.LastSyncedNoteHash
	s.FullReuploadPending = loaded.FullReuploadPending
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

func (s *SyncState) MarkFolderDeleted(folderID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.revision++
	s.Dirty = true
	s.ensureMapsLocked()
	s.DeletedFolderIDs[folderID] = true
	_ = s.saveLocked()
}

// IsDirty は同期しないと解消しないローカル変更（ヒント or 未処理の削除意図）があるか。
func (s *SyncState) IsDirty() bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.Dirty || len(s.DeletedNoteIDs) > 0
}

// LegacyNoteHashes は v2 が記録していた「前回同期時の本文 hash」（v3 の base が無い移行直後だけ使う）。
func (s *SyncState) LegacyNoteHashes() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make(map[string]string, len(s.LastSyncedNoteHash))
	for k, v := range s.LastSyncedNoteHash {
		out[k] = v
	}
	return out
}

// CompleteSync は同期エンジン v3 のサイクル終了時の後始末（docs/sync-engine-v3.md §4）。
//   - resolvedDeletions: 処理が確定した削除意図（リモート削除済み / 取り消し）は個別に消す。
//   - succeeded: 失敗なく終わったか。失敗があれば Dirty を立て、すぐ再同期させる。
//   - 成功かつ revision が同期開始時から変わっていなければ（= 同期中にユーザー操作が無い）、
//     ヒント系（Dirty / DirtyNoteIDs / DeletedFolderIDs）をクリアする。
//
// v2 の同期記録（LastSyncedNoteHash / LastSyncedDriveTs / FullReuploadPending）は v3 では使わないので消す。
// 戻り値: ヒント系をクリアしたか。
func (s *SyncState) CompleteSync(snapshotRevision uint64, resolvedDeletions []string, succeeded bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.ensureMapsLocked()
	for _, id := range resolvedDeletions {
		delete(s.DeletedNoteIDs, id)
	}
	cleared := succeeded && s.revision == snapshotRevision
	if cleared {
		s.Dirty = false
		s.DirtyNoteIDs = make(map[string]bool)
		s.DeletedFolderIDs = make(map[string]bool)
	} else if !succeeded {
		s.Dirty = true
	}
	s.LastSyncedNoteHash = make(map[string]string)
	s.LastSyncedDriveTs = ""
	s.FullReuploadPending = false
	_ = s.saveLocked()
	return cleared
}

// GetDirtySnapshotWithRevision は dirty スナップショットと同時に revision を返す
func (s *SyncState) GetDirtySnapshotWithRevision() (dirtyNoteIDs map[string]bool, deletedNoteIDs map[string]bool, deletedFolderIDs map[string]bool, lastSyncedNoteHash map[string]string, revision uint64) {
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
	deletedFolderIDs = make(map[string]bool, len(s.DeletedFolderIDs))
	for id := range s.DeletedFolderIDs {
		deletedFolderIDs[id] = true
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
	s.DeletedFolderIDs = make(map[string]bool)
	s.LastSyncedNoteHash = make(map[string]string)
	s.FullReuploadPending = false
}

func (s *SyncState) ensureMapsLocked() {
	if s.DirtyNoteIDs == nil {
		s.DirtyNoteIDs = make(map[string]bool)
	}
	if s.DeletedNoteIDs == nil {
		s.DeletedNoteIDs = make(map[string]bool)
	}
	if s.DeletedFolderIDs == nil {
		s.DeletedFolderIDs = make(map[string]bool)
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
