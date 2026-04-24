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
	s.DeletedFolderIDs = make(map[string]bool)
	s.LastSyncedDriveTs = driveTs
	s.LastSyncedNoteHash = make(map[string]string, len(noteHashes))
	for k, v := range noteHashes {
		s.LastSyncedNoteHash[k] = v
	}
}

// UpdateSyncedNoteHash は 1 ノートの「Drive 側に上がった状態」を即時に永続化する。
// 大量アップロード中にアプリが終了した場合、再起動後の pushLocalChanges で
// 「現在の hash == 永続化済 hash」のノートをスキップして再開できるようにする用途。
//
// revision はインクリメントしない（これは同期側の内部記録で、ユーザー編集ではないため、
// 進行中の ClearDirtyIfUnchanged の revision チェックを破壊してはならない）。
func (s *SyncState) UpdateSyncedNoteHash(noteID string, hash string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.ensureMapsLocked()
	s.LastSyncedNoteHash[noteID] = hash
	_ = s.saveLocked()
}

// UpdateSyncedState は ClearDirtyIfUnchanged が失敗した場合のフォールバック
// dirtyフラグは保持しつつ、完了した同期結果だけ反映し、次回の不要な resolveConflict を防ぐ
func (s *SyncState) UpdateSyncedState(driveTs string, noteHashes map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.LastSyncedDriveTs = driveTs
	s.LastSyncedNoteHash = make(map[string]string, len(noteHashes))
	for k, v := range noteHashes {
		s.LastSyncedNoteHash[k] = v
	}
	_ = s.saveLocked()
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

// MarkForFullReupload は Drive 上のデータ削除などで、全ノートを再アップロードする必要が
// あるときに呼び出す。dirty フラグ・DirtyNoteIDs を noteIDs で埋め、最後の同期状態を
// クリアしつつ FullReuploadPending を立てる。
// これにより次回の onConnected で ensureNoteList が Drive noteList を作らず、
// SyncNotes が pushLocalChanges 経路を通って全ノートを再アップロードできる。
func (s *SyncState) MarkForFullReupload(noteIDs []string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.revision++
	s.Dirty = true
	s.LastSyncedDriveTs = ""
	s.LastSyncedNoteHash = make(map[string]string)
	s.DeletedNoteIDs = make(map[string]bool)
	s.DeletedFolderIDs = make(map[string]bool)
	s.DirtyNoteIDs = make(map[string]bool, len(noteIDs))
	for _, id := range noteIDs {
		s.DirtyNoteIDs[id] = true
	}
	s.FullReuploadPending = true
	_ = s.saveLocked()
}

// ClearFullReupload は FullReuploadPending を落とす（pushLocalChanges 成功時に呼ぶ）。
func (s *SyncState) ClearFullReupload() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.FullReuploadPending {
		return
	}
	s.FullReuploadPending = false
	_ = s.saveLocked()
}

// IsFullReuploadPending は FullReuploadPending の現在値を返す。
func (s *SyncState) IsFullReuploadPending() bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.FullReuploadPending
}

// HasPendingUploads は未アップロードのローカル変更があるかを返す。
// (A) 明示的に FullReuploadPending が立っている、または (B) dirty=true かつ DirtyNoteIDs が非空。
// ensureNoteList 側で「Drive noteList を先に作るか、pushLocalChanges 経路に任せるか」の判定に使う。
func (s *SyncState) HasPendingUploads() bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.FullReuploadPending {
		return true
	}
	return s.Dirty && len(s.DirtyNoteIDs) > 0
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
