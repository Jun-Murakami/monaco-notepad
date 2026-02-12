package migration

import (
	"os"
	"path/filepath"
)

func RunIfNeeded(appDataDir string, notesDir string) error {
	localV2Path := filepath.Join(filepath.Dir(notesDir), "noteList_v2.json")

	if _, err := os.Stat(localV2Path); err == nil {
		return nil
	}

	localV1Path := filepath.Join(filepath.Dir(notesDir), "noteList.json")
	if _, err := os.Stat(localV1Path); os.IsNotExist(err) {
		return nil
	}

	return migrateV1ToV2(localV1Path, localV2Path)
}
