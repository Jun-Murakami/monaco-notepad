package backend

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// 競合バックアップ: 同期でクラウド側が勝った / クラウド側で削除されたとき、上書き・削除する直前の
// ローカル版を appDataDir/cloud_conflict_backups/ に保存する（最大 100 件）。

const (
	cloudWinBackupDirName       = "cloud_conflict_backups"
	maxCloudWinBackupFiles      = 100
	cloudBackupFilePrefixWins   = "cloud_wins_"
	cloudBackupFilePrefixDelete = "cloud_delete_"
)

type cloudWinBackupRecord struct {
	Reason            string        `json:"reason"`
	BackupCreatedAt   string        `json:"backupCreatedAt"`
	NoteID            string        `json:"noteId"`
	LocalModifiedTime string        `json:"localModifiedTime"`
	CloudModifiedTime string        `json:"cloudModifiedTime"`
	LocalNote         *Note         `json:"localNote"`
	CloudNote         *Note         `json:"cloudNote"`
	CloudMetadata     *NoteMetadata `json:"cloudMetadata,omitempty"`
}

// isConflictBackupEnabled は設定（settings.json の enableConflictBackup）を読む。未設定なら有効。
func isConflictBackupEnabled(appDataDir string) bool {
	data, err := os.ReadFile(filepath.Join(appDataDir, "settings.json"))
	if err != nil {
		return true
	}
	var payload struct {
		EnableConflictBackup *bool `json:"enableConflictBackup"`
	}
	if err := json.Unmarshal(data, &payload); err != nil || payload.EnableConflictBackup == nil {
		return true
	}
	return *payload.EnableConflictBackup
}

// backupConflictLocalNote は同期エンジンのバックアップ要求（kind: "cloud_wins" / "cloud_delete"）を保存する。
func backupConflictLocalNote(appDataDir, kind string, local *Note, cloud *Note) error {
	if local == nil {
		return fmt.Errorf("local note is nil")
	}
	record := cloudWinBackupRecord{
		BackupCreatedAt:   time.Now().UTC().Format(time.RFC3339Nano),
		NoteID:            local.ID,
		LocalModifiedTime: local.ModifiedTime,
		LocalNote:         local,
	}
	prefix := cloudBackupFilePrefixDelete
	if kind == "cloud_wins" {
		prefix = cloudBackupFilePrefixWins
		record.Reason = "cloud-wins-conflict"
		record.CloudNote = cloud
		if cloud != nil {
			record.CloudModifiedTime = cloud.ModifiedTime
		}
	} else {
		record.Reason = "cloud-delete"
	}
	_, err := writeCloudConflictBackup(appDataDir, record, prefix)
	return err
}

func writeCloudConflictBackup(appDataDir string, record cloudWinBackupRecord, filePrefix string) (string, error) {
	if record.NoteID == "" {
		return "", fmt.Errorf("note id is empty")
	}
	if strings.TrimSpace(appDataDir) == "" {
		return "", fmt.Errorf("app data dir is empty")
	}

	backupDir := filepath.Join(appDataDir, cloudWinBackupDirName)
	if err := os.MkdirAll(backupDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create backup directory: %w", err)
	}

	data, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return "", fmt.Errorf("failed to marshal backup record: %w", err)
	}

	fileName := fmt.Sprintf("%s%s_%s.json", filePrefix, time.Now().UTC().Format("20060102T150405.000000000Z"), record.NoteID)
	backupPath := filepath.Join(backupDir, fileName)
	tmpPath := backupPath + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return "", fmt.Errorf("failed to write backup temp file: %w", err)
	}
	if err := os.Rename(tmpPath, backupPath); err != nil {
		_ = os.Remove(tmpPath)
		return "", fmt.Errorf("failed to finalize backup file: %w", err)
	}

	if err := pruneCloudConflictBackups(backupDir, maxCloudWinBackupFiles); err != nil {
		return backupPath, fmt.Errorf("failed to prune backup files: %w", err)
	}
	return backupPath, nil
}

type backupFileInfo struct {
	path    string
	name    string
	modTime time.Time
}

func pruneCloudConflictBackups(backupDir string, maxFiles int) error {
	if maxFiles <= 0 {
		return nil
	}
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	files := make([]backupFileInfo, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !isCloudConflictBackupFile(name) {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			continue
		}
		files = append(files, backupFileInfo{path: filepath.Join(backupDir, name), name: name, modTime: info.ModTime()})
	}
	if len(files) <= maxFiles {
		return nil
	}

	sort.Slice(files, func(i, j int) bool {
		if files[i].modTime.Equal(files[j].modTime) {
			return files[i].name < files[j].name
		}
		return files[i].modTime.Before(files[j].modTime)
	})
	for i := 0; i < len(files)-maxFiles; i++ {
		if err := os.Remove(files[i].path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func isCloudConflictBackupFile(name string) bool {
	if !strings.HasSuffix(name, ".json") {
		return false
	}
	return strings.HasPrefix(name, cloudBackupFilePrefixWins) || strings.HasPrefix(name, cloudBackupFilePrefixDelete)
}

// conflictBackupKindFromName はバックアップファイル名から kind を判定する
func conflictBackupKindFromName(name string) string {
	if !strings.HasSuffix(name, ".json") {
		return ""
	}
	if strings.HasPrefix(name, cloudBackupFilePrefixWins) {
		return "cloud_wins"
	}
	if strings.HasPrefix(name, cloudBackupFilePrefixDelete) {
		return "cloud_delete"
	}
	return ""
}

// validateCloudConflictBackupFilename はパストラバーサル等の不正なファイル名を弾く
func validateCloudConflictBackupFilename(name string) error {
	if name == "" {
		return fmt.Errorf("backup filename is empty")
	}
	if strings.ContainsAny(name, "/\\") || strings.Contains(name, "..") {
		return fmt.Errorf("invalid backup filename: %s", name)
	}
	if conflictBackupKindFromName(name) == "" {
		return fmt.Errorf("not a conflict backup file: %s", name)
	}
	return nil
}

// listCloudConflictBackups はバックアップディレクトリのエントリを新しい順に列挙する。
// 読み取り不能・パース不能なファイルはスキップして処理を継続する。
func listCloudConflictBackups(backupDir string) ([]ConflictBackupEntry, error) {
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []ConflictBackupEntry{}, nil
		}
		return nil, err
	}

	result := make([]ConflictBackupEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		kind := conflictBackupKindFromName(name)
		if kind == "" {
			continue
		}
		data, readErr := os.ReadFile(filepath.Join(backupDir, name))
		if readErr != nil {
			continue
		}
		var record cloudWinBackupRecord
		if err := json.Unmarshal(data, &record); err != nil || record.LocalNote == nil {
			continue
		}
		createdAt := record.BackupCreatedAt
		if createdAt == "" {
			// JSON に作成時刻が無い場合はファイルの mtime をフォールバックに使う
			if info, infoErr := entry.Info(); infoErr == nil {
				createdAt = info.ModTime().UTC().Format(time.RFC3339Nano)
			}
		}
		result = append(result, ConflictBackupEntry{ID: name, Filename: name, Kind: kind, CreatedAt: createdAt, Note: record.LocalNote})
	}

	sort.Slice(result, func(i, j int) bool {
		// 新しい順にソート。CreatedAt が同値の場合はファイル名で安定させる
		if result[i].CreatedAt == result[j].CreatedAt {
			return result[i].Filename > result[j].Filename
		}
		return result[i].CreatedAt > result[j].CreatedAt
	})
	return result, nil
}

// deleteCloudConflictBackup は指定された 1 件のバックアップを削除する
func deleteCloudConflictBackup(backupDir, filename string) error {
	if err := validateCloudConflictBackupFilename(filename); err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(backupDir, filename)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// deleteAllCloudConflictBackups はバックアップディレクトリ内の全バックアップファイルを削除する
// (ディレクトリ自体や非バックアップファイルは残す)
func deleteAllCloudConflictBackups(backupDir string) error {
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || !isCloudConflictBackupFile(entry.Name()) {
			continue
		}
		if err := os.Remove(filepath.Join(backupDir, entry.Name())); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}
