package migration

import "time"

type v1NoteList struct {
	Version               string           `json:"version"`
	Notes                 []v1NoteMetadata `json:"notes"`
	Folders               []v1Folder       `json:"folders,omitempty"`
	TopLevelOrder         []v1TopLevelItem `json:"topLevelOrder,omitempty"`
	ArchivedTopLevelOrder []v1TopLevelItem `json:"archivedTopLevelOrder,omitempty"`
	CollapsedFolderIDs    []string         `json:"collapsedFolderIDs,omitempty"`
	LastSync              time.Time        `json:"lastSync"`
	LastSyncClientID      string           `json:"lastSyncClientId,omitempty"`
}

type v1NoteMetadata struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	ContentHeader string `json:"contentHeader"`
	Language      string `json:"language"`
	ModifiedTime  string `json:"modifiedTime"`
	Archived      bool   `json:"archived"`
	ContentHash   string `json:"contentHash"`
	Order         int    `json:"order"`
	FolderID      string `json:"folderId,omitempty"`
}

type v1Folder struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Archived bool   `json:"archived,omitempty"`
}

type v1TopLevelItem struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}
