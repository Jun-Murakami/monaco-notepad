package backend

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 競合バックアップ管理機能のテスト

func writeTestBackup(t *testing.T, dir string, prefix string, ts time.Time, noteID string, record cloudWinBackupRecord) string {
	t.Helper()
	require.NoError(t, os.MkdirAll(dir, 0755))
	if record.NoteID == "" {
		record.NoteID = noteID
	}
	if record.BackupCreatedAt == "" {
		record.BackupCreatedAt = ts.UTC().Format(time.RFC3339Nano)
	}
	data, err := json.MarshalIndent(record, "", "  ")
	require.NoError(t, err)

	name := fmt.Sprintf("%s%s_%s.json", prefix, ts.UTC().Format("20060102T150405.000000000Z"), noteID)
	require.NoError(t, os.WriteFile(filepath.Join(dir, name), data, 0644))
	return name
}

func TestListCloudConflictBackups_EmptyDir(t *testing.T) {
	tempDir := t.TempDir()
	backupDir := filepath.Join(tempDir, cloudWinBackupDirName)

	// ディレクトリ未作成 → 空配列
	got, err := listCloudConflictBackups(backupDir)
	assert.NoError(t, err)
	assert.Empty(t, got)

	// 空ディレクトリ → 空配列
	require.NoError(t, os.MkdirAll(backupDir, 0755))
	got, err = listCloudConflictBackups(backupDir)
	assert.NoError(t, err)
	assert.Empty(t, got)
}

func TestListCloudConflictBackups_SortedNewestFirst(t *testing.T) {
	tempDir := t.TempDir()
	backupDir := filepath.Join(tempDir, cloudWinBackupDirName)

	older := time.Date(2025, 1, 1, 10, 0, 0, 0, time.UTC)
	newer := time.Date(2025, 6, 1, 10, 0, 0, 0, time.UTC)
	middle := time.Date(2025, 3, 1, 10, 0, 0, 0, time.UTC)

	writeTestBackup(t, backupDir, cloudBackupFilePrefixWins, older, "note-old", cloudWinBackupRecord{
		LocalNote: &Note{ID: "note-old", Title: "Old", Content: "old content", Language: "plaintext"},
	})
	writeTestBackup(t, backupDir, cloudBackupFilePrefixDelete, newer, "note-new", cloudWinBackupRecord{
		LocalNote: &Note{ID: "note-new", Title: "New", Content: "new content", Language: "go"},
	})
	writeTestBackup(t, backupDir, cloudBackupFilePrefixWins, middle, "note-mid", cloudWinBackupRecord{
		LocalNote: &Note{ID: "note-mid", Title: "Mid", Content: "mid content", Language: "javascript"},
	})

	got, err := listCloudConflictBackups(backupDir)
	require.NoError(t, err)
	require.Len(t, got, 3)

	// 新しい順
	assert.Equal(t, "note-new", got[0].Note.ID)
	assert.Equal(t, "cloud_delete", got[0].Kind)
	assert.Equal(t, "note-mid", got[1].Note.ID)
	assert.Equal(t, "cloud_wins", got[1].Kind)
	assert.Equal(t, "note-old", got[2].Note.ID)
	assert.Equal(t, "cloud_wins", got[2].Kind)

	// kind 等のフィールドが正しく入る
	assert.Equal(t, got[0].Filename, got[0].ID)
	assert.NotEmpty(t, got[0].CreatedAt)
}

func TestListCloudConflictBackups_SkipsInvalidFiles(t *testing.T) {
	tempDir := t.TempDir()
	backupDir := filepath.Join(tempDir, cloudWinBackupDirName)
	require.NoError(t, os.MkdirAll(backupDir, 0755))

	// 1) prefix が一致するが本文が壊れている
	require.NoError(t, os.WriteFile(
		filepath.Join(backupDir, cloudBackupFilePrefixWins+"20250101T120000.000000000Z_brokenid.json"),
		[]byte("{not json"), 0644))

	// 2) prefix が一致しない無関係ファイル
	require.NoError(t, os.WriteFile(
		filepath.Join(backupDir, "random.json"),
		[]byte("{}"), 0644))

	// 3) サブディレクトリ
	require.NoError(t, os.MkdirAll(filepath.Join(backupDir, "subdir"), 0755))

	// 4) LocalNote が nil なバックアップは無視
	writeTestBackup(t, backupDir, cloudBackupFilePrefixDelete, time.Now(), "no-local", cloudWinBackupRecord{})

	// 5) 正常なバックアップ
	writeTestBackup(t, backupDir, cloudBackupFilePrefixWins, time.Now(), "valid-id", cloudWinBackupRecord{
		LocalNote: &Note{ID: "valid-id", Content: "ok"},
	})

	got, err := listCloudConflictBackups(backupDir)
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "valid-id", got[0].Note.ID)
}

func TestDeleteCloudConflictBackup(t *testing.T) {
	tempDir := t.TempDir()
	backupDir := filepath.Join(tempDir, cloudWinBackupDirName)

	name := writeTestBackup(t, backupDir, cloudBackupFilePrefixWins, time.Now(), "target", cloudWinBackupRecord{
		LocalNote: &Note{ID: "target", Content: "x"},
	})

	require.NoError(t, deleteCloudConflictBackup(backupDir, name))
	_, err := os.Stat(filepath.Join(backupDir, name))
	assert.True(t, os.IsNotExist(err))

	// 二度目: 存在しない場合もエラーにならない (冪等)
	assert.NoError(t, deleteCloudConflictBackup(backupDir, name))
}

func TestDeleteCloudConflictBackup_RejectsTraversal(t *testing.T) {
	tempDir := t.TempDir()
	backupDir := filepath.Join(tempDir, cloudWinBackupDirName)
	require.NoError(t, os.MkdirAll(backupDir, 0755))

	// 競合バックアップディレクトリの外にダミーファイルを置く
	outsidePath := filepath.Join(tempDir, "settings.json")
	require.NoError(t, os.WriteFile(outsidePath, []byte("{}"), 0644))

	cases := []string{
		"../settings.json",
		"..\\settings.json",
		"sub/cloud_wins_x.json",
		"cloud_wins_../escape.json",
		"random.txt",
		"",
	}
	for _, name := range cases {
		err := deleteCloudConflictBackup(backupDir, name)
		assert.Error(t, err, "should reject %q", name)
	}

	// 外のファイルは生きている
	_, err := os.Stat(outsidePath)
	assert.NoError(t, err)
}

func TestDeleteAllCloudConflictBackups(t *testing.T) {
	tempDir := t.TempDir()
	backupDir := filepath.Join(tempDir, cloudWinBackupDirName)
	require.NoError(t, os.MkdirAll(backupDir, 0755))

	for i := 0; i < 3; i++ {
		writeTestBackup(t, backupDir, cloudBackupFilePrefixWins, time.Now().Add(time.Duration(i)*time.Second), fmt.Sprintf("id-%d", i), cloudWinBackupRecord{
			LocalNote: &Note{ID: fmt.Sprintf("id-%d", i), Content: "x"},
		})
	}
	// 非バックアップファイルは残るべき
	otherFile := filepath.Join(backupDir, "other.json")
	require.NoError(t, os.WriteFile(otherFile, []byte("{}"), 0644))

	require.NoError(t, deleteAllCloudConflictBackups(backupDir))

	entries, err := os.ReadDir(backupDir)
	require.NoError(t, err)
	// other.json のみ残る
	require.Len(t, entries, 1)
	assert.Equal(t, "other.json", entries[0].Name())

	// ディレクトリが無い場合もエラーにならない
	require.NoError(t, os.RemoveAll(backupDir))
	assert.NoError(t, deleteAllCloudConflictBackups(backupDir))
}

func TestValidateCloudConflictBackupFilename(t *testing.T) {
	cases := map[string]bool{
		"cloud_wins_20250101T120000.000000000Z_abc.json":   true,
		"cloud_delete_20250101T120000.000000000Z_xyz.json": true,
		"cloud_wins_xyz.json":                              true, // prefix さえ合えば valid
		"":                                                 false,
		"random.json":                                      false,
		"cloud_wins_x.txt":                                 false,
		"../escape.json":                                   false,
		"../cloud_wins_x.json":                             false,
		"sub/cloud_wins_x.json":                            false,
	}
	for name, want := range cases {
		err := validateCloudConflictBackupFilename(name)
		if want {
			assert.NoError(t, err, "expected %q to be valid", name)
		} else {
			assert.Error(t, err, "expected %q to be invalid", name)
		}
	}
}

func TestConflictBackupKindFromName(t *testing.T) {
	assert.Equal(t, "cloud_wins", conflictBackupKindFromName("cloud_wins_x.json"))
	assert.Equal(t, "cloud_delete", conflictBackupKindFromName("cloud_delete_x.json"))
	assert.Equal(t, "", conflictBackupKindFromName("random.json"))
	assert.Equal(t, "", conflictBackupKindFromName("cloud_wins_x.txt"))
	assert.Equal(t, "", conflictBackupKindFromName(""))
}

func TestListCloudConflictBackups_FallsBackToFileMTimeWhenCreatedAtMissing(t *testing.T) {
	tempDir := t.TempDir()
	backupDir := filepath.Join(tempDir, cloudWinBackupDirName)
	require.NoError(t, os.MkdirAll(backupDir, 0755))

	// BackupCreatedAt を空にしたバックアップ
	rec := cloudWinBackupRecord{
		BackupCreatedAt: "",
		LocalNote:       &Note{ID: "noid", Content: "ok"},
	}
	data, err := json.Marshal(rec)
	require.NoError(t, err)

	name := cloudBackupFilePrefixWins + "20250101T120000.000000000Z_noid.json"
	path := filepath.Join(backupDir, name)
	require.NoError(t, os.WriteFile(path, data, 0644))

	// ファイル mtime を既知の時刻に上書き
	want := time.Date(2024, 8, 15, 12, 0, 0, 0, time.UTC)
	require.NoError(t, os.Chtimes(path, want, want))

	got, err := listCloudConflictBackups(backupDir)
	require.NoError(t, err)
	require.Len(t, got, 1)

	// CreatedAt が mtime にフォールバックされていること
	assert.True(t, strings.HasPrefix(got[0].CreatedAt, "2024-08-15"), "createdAt=%s", got[0].CreatedAt)
}
