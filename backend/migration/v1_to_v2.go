package migration

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

type v2NoteList struct {
	Version               string           `json:"version"`
	Notes                 []v2NoteMetadata `json:"notes"`
	Folders               []v2Folder       `json:"folders,omitempty"`
	TopLevelOrder         []v2TopLevelItem `json:"topLevelOrder,omitempty"`
	ArchivedTopLevelOrder []v2TopLevelItem `json:"archivedTopLevelOrder,omitempty"`
	CollapsedFolderIDs    []string         `json:"collapsedFolderIDs,omitempty"`
}

type v2NoteMetadata struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	ContentHeader string `json:"contentHeader"`
	Language      string `json:"language"`
	ModifiedTime  string `json:"modifiedTime"`
	Archived      bool   `json:"archived"`
	ContentHash   string `json:"contentHash"`
	FolderID      string `json:"folderId,omitempty"`
}

type v2Folder struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Archived bool   `json:"archived,omitempty"`
}

type v2TopLevelItem struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

func migrateV1ToV2(v1Path, v2Path string) error {
	v1Data, err := os.ReadFile(v1Path)
	if err != nil {
		return fmt.Errorf("failed to read v1 noteList: %w", err)
	}
	var v1List v1NoteList
	if err := json.Unmarshal(v1Data, &v1List); err != nil {
		return fmt.Errorf("failed to parse v1 noteList: %w", err)
	}

	if err := saveSnapshot(v1Path); err != nil {
		return fmt.Errorf("failed to save snapshot: %w", err)
	}

	v2List := convertV1ToV2(&v1List)

	v2Data, err := json.MarshalIndent(v2List, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal v2 noteList: %w", err)
	}
	return atomicWrite(v2Path, v2Data)
}

func convertV1ToV2(v1 *v1NoteList) *v2NoteList {
	v2 := &v2NoteList{
		Version:            "2.0",
		Notes:              make([]v2NoteMetadata, 0, len(v1.Notes)),
		CollapsedFolderIDs: v1.CollapsedFolderIDs,
	}

	for _, f := range v1.Folders {
		v2.Folders = append(v2.Folders, v2Folder{ID: f.ID, Name: f.Name, Archived: f.Archived})
	}

	for _, item := range v1.TopLevelOrder {
		v2.TopLevelOrder = append(v2.TopLevelOrder, v2TopLevelItem{Type: item.Type, ID: item.ID})
	}
	for _, item := range v1.ArchivedTopLevelOrder {
		v2.ArchivedTopLevelOrder = append(v2.ArchivedTopLevelOrder, v2TopLevelItem{Type: item.Type, ID: item.ID})
	}

	sorted := make([]v1NoteMetadata, len(v1.Notes))
	copy(sorted, v1.Notes)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Order < sorted[j].Order })

	for _, n := range sorted {
		v2.Notes = append(v2.Notes, v2NoteMetadata{
			ID:            n.ID,
			Title:         n.Title,
			ContentHeader: n.ContentHeader,
			Language:      n.Language,
			ModifiedTime:  n.ModifiedTime,
			Archived:      n.Archived,
			ContentHash:   n.ContentHash,
			FolderID:      n.FolderID,
		})
	}

	return v2
}
