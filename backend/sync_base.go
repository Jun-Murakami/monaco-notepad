package backend

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// syncBaseNote はノートごとの「前回同期時の本文 hash と Drive 本体の md5 / ファイル ID」。
// md5 / ファイル ID は v2 からの移行直後などで欠けうる。ファイル ID が変わっていれば、
// ノートは一度削除されて作り直されている。
type syncBaseNote struct {
	Hash   string `json:"hash"`
	Md5    string `json:"md5,omitempty"`
	FileID string `json:"fileId,omitempty"`
}

// SyncBase は最後に同期が確定した時点の状態（docs/sync-engine-v3.md §4, sync_base.json）。
// 3-way マージの base と、ノートごとの base を持つ。
// Drive（アカウント）に紐づくので、RootFolderID / NoteListFileID が現在と違えば無効。
type SyncBase struct {
	Version        int                     `json:"version"`
	RootFolderID   string                  `json:"rootFolderId"`
	NoteListFileID string                  `json:"noteListFileId"`
	NoteListMd5    string                  `json:"noteListMd5"`
	NoteList       *NoteList               `json:"noteList"`
	Notes          map[string]syncBaseNote `json:"notes"`
}

const syncBaseVersion = 1

func emptySyncBase(rootFolderID string) *SyncBase {
	return &SyncBase{
		Version:      syncBaseVersion,
		RootFolderID: rootFolderID,
		Notes:        map[string]syncBaseNote{},
	}
}

// clone は Notes マップを複製したコピーを返す（NoteList は読み取り専用として共有する）。
func (b *SyncBase) clone() *SyncBase {
	cp := *b
	cp.Notes = make(map[string]syncBaseNote, len(b.Notes))
	for k, v := range b.Notes {
		cp.Notes[k] = v
	}
	return &cp
}

type syncBaseStore struct {
	path string
}

func newSyncBaseStore(appDataDir string) *syncBaseStore {
	return &syncBaseStore{path: filepath.Join(appDataDir, "sync_base.json")}
}

// Load は保存済みの base を返す。無い / 壊れている / 版が違う場合は nil。
func (s *syncBaseStore) Load() *SyncBase {
	data, err := os.ReadFile(s.path)
	if err != nil {
		return nil
	}
	var base SyncBase
	if err := json.Unmarshal(data, &base); err != nil || base.Version != syncBaseVersion {
		return nil
	}
	if base.Notes == nil {
		base.Notes = map[string]syncBaseNote{}
	}
	return &base
}

func (s *syncBaseStore) Save(base *SyncBase) error {
	data, err := json.Marshal(base)
	if err != nil {
		return fmt.Errorf("failed to marshal sync base: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0755); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return fmt.Errorf("failed to write sync base: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("failed to replace sync base: %w", err)
	}
	return nil
}

func (s *syncBaseStore) Clear() error {
	if err := os.Remove(s.path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
