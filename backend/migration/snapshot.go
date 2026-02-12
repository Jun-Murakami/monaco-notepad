package migration

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const snapshotDir = "migration_snapshots"

func saveSnapshot(v1Path string) error {
	dir := filepath.Join(filepath.Dir(v1Path), snapshotDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	data, err := os.ReadFile(v1Path)
	if err != nil {
		return err
	}

	timestamp := time.Now().Format("20060102_150405")
	snapshotPath := filepath.Join(dir, fmt.Sprintf("noteList_v1_%s.json", timestamp))
	return os.WriteFile(snapshotPath, data, 0o644)
}

func atomicWrite(path string, data []byte) error {
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}
