package backend

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 共有仕様ベクター（sync-spec/vectors/*.json）の検証。
// 同じファイルをモバイル側（mobile/src/services/sync/core/__tests__/specVectors.test.ts）も読み、
// 両実装の出力一致を保証する。

func loadSpecVectors(t *testing.T, name string, v any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "sync-spec", "vectors", name))
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(data, v))
}

type vNoteMeta struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	ContentHeader string `json:"contentHeader"`
	Language      string `json:"language"`
	ModifiedTime  string `json:"modifiedTime"`
	Archived      bool   `json:"archived"`
	ContentHash   string `json:"contentHash"`
	FolderID      string `json:"folderId"`
}

type vFolder struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Archived bool   `json:"archived"`
}

type vNoteList struct {
	Notes                 []vNoteMeta `json:"notes"`
	Folders               []vFolder   `json:"folders"`
	TopLevelOrder         []string    `json:"topLevelOrder"`
	ArchivedTopLevelOrder []string    `json:"archivedTopLevelOrder"`
	CollapsedFolderIDs    []string    `json:"collapsedFolderIds"`
}

func (v vNoteMeta) toMeta() NoteMetadata {
	return NoteMetadata{ID: v.ID, Title: v.Title, ContentHeader: v.ContentHeader, Language: v.Language,
		ModifiedTime: v.ModifiedTime, Archived: v.Archived, ContentHash: v.ContentHash, FolderID: v.FolderID}
}

func vItem(key string) TopLevelItem {
	prefix, id, _ := strings.Cut(key, ":")
	if prefix == "f" {
		return TopLevelItem{Type: "folder", ID: id}
	}
	return TopLevelItem{Type: "note", ID: id}
}

func vItems(keys []string) []TopLevelItem {
	out := []TopLevelItem{}
	for _, k := range keys {
		out = append(out, vItem(k))
	}
	return out
}

func (v *vNoteList) toList() *NoteList {
	if v == nil {
		return nil
	}
	list := &NoteList{
		Version:               CurrentVersion,
		Notes:                 []NoteMetadata{},
		Folders:               []Folder{},
		TopLevelOrder:         vItems(v.TopLevelOrder),
		ArchivedTopLevelOrder: vItems(v.ArchivedTopLevelOrder),
		CollapsedFolderIDs:    append([]string{}, v.CollapsedFolderIDs...),
	}
	for _, n := range v.Notes {
		list.Notes = append(list.Notes, n.toMeta())
	}
	for _, f := range v.Folders {
		list.Folders = append(list.Folders, Folder{ID: f.ID, Name: f.Name, Archived: f.Archived})
	}
	return list
}

func TestSpecVectors_ContentHash(t *testing.T) {
	var file struct {
		Cases []struct {
			Name     string `json:"name"`
			Note     Note   `json:"note"`
			Expected string `json:"expected"`
		} `json:"cases"`
	}
	loadSpecVectors(t, "content-hash.json", &file)
	for _, c := range file.Cases {
		t.Run(c.Name, func(t *testing.T) {
			note := c.Note
			note.ContentHeader = "ignored"
			note.ModifiedTime = "2026-01-01T00:00:00Z"
			note.FolderID = "ignored"
			assert.Equal(t, c.Expected, computeContentHash(&note))
		})
	}
}

func TestSpecVectors_MergeSequence(t *testing.T) {
	var file struct {
		Cases []struct {
			Name     string    `json:"name"`
			Base     *[]string `json:"base"`
			Local    []string  `json:"local"`
			Remote   []string  `json:"remote"`
			Expected []string  `json:"expected"`
		} `json:"cases"`
	}
	loadSpecVectors(t, "merge-sequence.json", &file)
	for _, c := range file.Cases {
		t.Run(c.Name, func(t *testing.T) {
			var base []string
			if c.Base != nil {
				base = append([]string{}, (*c.Base)...)
			}
			got := mergeSequence(base, c.Base != nil, c.Local, c.Remote)
			assert.Equal(t, append([]string{}, c.Expected...), append([]string{}, got...))
		})
	}
}

func TestSpecVectors_SkippedVersions(t *testing.T) {
	var file struct {
		Normalize []struct {
			Name     string         `json:"name"`
			Input    []versionRange `json:"input"`
			Expected []versionRange `json:"expected"`
		} `json:"normalize"`
		Known []struct {
			Name          string         `json:"name"`
			Skipped       []versionRange `json:"skipped"`
			ParentVersion int64          `json:"parentVersion"`
			Version       int64          `json:"version"`
			Expected      []versionRange `json:"expected"`
		} `json:"known"`
		Contains []struct {
			Name     string         `json:"name"`
			Ranges   []versionRange `json:"ranges"`
			Version  int64          `json:"version"`
			Expected bool           `json:"expected"`
		} `json:"contains"`
	}
	loadSpecVectors(t, "skipped-versions.json", &file)
	for _, c := range file.Normalize {
		t.Run("normalize/"+c.Name, func(t *testing.T) {
			assert.Equal(t, append([]versionRange{}, c.Expected...), append([]versionRange{}, normalizeSkippedVersions(c.Input)...))
		})
	}
	for _, c := range file.Known {
		t.Run("known/"+c.Name, func(t *testing.T) {
			got := knownSkippedVersions(c.Skipped, c.ParentVersion, c.Version)
			assert.Equal(t, append([]versionRange{}, c.Expected...), append([]versionRange{}, got...))
		})
	}
	for _, c := range file.Contains {
		t.Run("contains/"+c.Name, func(t *testing.T) {
			assert.Equal(t, c.Expected, skippedVersionsContain(c.Ranges, c.Version))
		})
	}
}

func TestSpecVectors_DecideNote(t *testing.T) {
	var file struct {
		Cases []struct {
			Name     string          `json:"name"`
			Input    decideNoteInput `json:"input"`
			Expected struct {
				Kind         string `json:"kind"`
				BackupLocal  bool   `json:"backupLocal"`
				BackupRemote bool   `json:"backupRemote"`
				RecoverLocal bool   `json:"recoverLocal"`
			} `json:"expected"`
		} `json:"cases"`
	}
	loadSpecVectors(t, "decide-note.json", &file)
	for _, c := range file.Cases {
		t.Run(c.Name, func(t *testing.T) {
			d := decideNote(c.Input)
			assert.Equal(t, c.Expected.Kind, string(d.Kind))
			if d.Kind == decisionApplyRemote || d.Kind == decisionDeleteLocal {
				assert.Equal(t, c.Expected.BackupLocal, d.BackupLocal)
			}
			if d.Kind == decisionApplyRemote {
				assert.Equal(t, c.Expected.RecoverLocal, d.RecoverLocal)
			}
			if d.Kind == decisionUpload {
				assert.Equal(t, c.Expected.BackupRemote, d.BackupRemote)
			}
		})
	}
}

func TestSpecVectors_MergeNoteList(t *testing.T) {
	var file struct {
		Cases []struct {
			Name     string      `json:"name"`
			Base     *vNoteList  `json:"base"`
			Local    vNoteList   `json:"local"`
			Remote   *vNoteList  `json:"remote"`
			Notes    []vNoteMeta `json:"notes"`
			Expected vNoteList   `json:"expected"`
		} `json:"cases"`
	}
	loadSpecVectors(t, "merge-notelist.json", &file)
	for _, c := range file.Cases {
		t.Run(c.Name, func(t *testing.T) {
			finals := make([]NoteMetadata, 0, len(c.Notes))
			byID := map[string]NoteMetadata{}
			for _, n := range c.Notes {
				m := n.toMeta()
				m.FolderID = ""
				finals = append(finals, m)
				byID[m.ID] = m
			}
			got := mergeNoteList(mergeNoteListInput{
				Base:   c.Base.toList(),
				Local:  c.Local.toList(),
				Remote: c.Remote.toList(),
				Notes:  finals,
			})
			want := c.Expected.toList()
			want.Notes = []NoteMetadata{}
			for _, n := range c.Expected.Notes {
				final, ok := byID[n.ID]
				require.True(t, ok, "vector error: %s not in notes", n.ID)
				final.FolderID = n.FolderID
				want.Notes = append(want.Notes, final)
			}
			assert.Equal(t, want.Notes, got.Notes, "notes")
			assert.Equal(t, want.Folders, got.Folders, "folders")
			assert.Equal(t, want.TopLevelOrder, got.TopLevelOrder, "topLevelOrder")
			assert.Equal(t, want.ArchivedTopLevelOrder, got.ArchivedTopLevelOrder, "archivedTopLevelOrder")
			assert.Equal(t, want.CollapsedFolderIDs, got.CollapsedFolderIDs, "collapsedFolderIds")
		})
	}
}
