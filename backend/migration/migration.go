package migration

import (
	"os"
	"path/filepath"
)

func RunIfNeeded(appDataDir string, notesDir string) (bool, error) {
	localV2Path := filepath.Join(filepath.Dir(notesDir), "noteList_v2.json")

	if _, err := os.Stat(localV2Path); err == nil {
		return false, nil
	}

	localV1Path := filepath.Join(filepath.Dir(notesDir), "noteList.json")
	if _, err := os.Stat(localV1Path); os.IsNotExist(err) {
		return false, nil
	}

	if err := migrateV1ToV2(localV1Path, localV2Path); err != nil {
		return false, err
	}
	return true, nil
}
