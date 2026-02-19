package backend

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/api/drive/v3"
)

// driveStorageMigration はappDataFolderマイグレーションの状態を管理する構造体
type driveStorageMigration struct {
	Migrated       bool   `json:"migrated"`
	MigratedAt     string `json:"migratedAt,omitempty"`
	OldDataDeleted bool   `json:"oldDataDeleted,omitempty"`
}

const migrationStateFileName = "drive_storage_migration.json"
const migrationCompleteMarkerName = "migration_complete.json"

// loadMigrationState はマイグレーション状態を読み込む
func (s *driveService) loadMigrationState() *driveStorageMigration {
	path := filepath.Join(s.appDataDir, migrationStateFileName)
	data, err := os.ReadFile(path)
	if err != nil {
		return &driveStorageMigration{}
	}
	var state driveStorageMigration
	if err := json.Unmarshal(data, &state); err != nil {
		return &driveStorageMigration{}
	}
	return &state
}

// saveMigrationState はマイグレーション状態を保存する
func (s *driveService) saveMigrationState(state *driveStorageMigration) error {
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal migration state: %w", err)
	}
	path := filepath.Join(s.appDataDir, migrationStateFileName)
	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write migration state: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("failed to replace migration state: %w", err)
	}
	return nil
}

// isMigrated はappDataFolderへの移行が完了しているか返す
func (s *driveService) isMigrated() bool {
	return s.loadMigrationState().Migrated
}

// checkOldDriveFoldersExist は通常Drive空間に旧monaco-notepadフォルダが存在するかチェックする
func (s *driveService) checkOldDriveFoldersExist(legacyOps DriveOperations) bool {
	folders, err := legacyOps.ListFiles(
		"name='monaco-notepad' and mimeType='application/vnd.google-apps.folder' and trashed=false")
	if err != nil {
		s.logger.Console("Failed to check old Drive folders: %v", err)
		return false
	}
	return len(folders) > 0
}

// checkAppDataFolderExists はappDataFolder内にmonaco-notepadフォルダが存在するかチェックする
func (s *driveService) checkAppDataFolderExists(appDataOps DriveOperations) bool {
	folders, err := appDataOps.ListFiles(
		"name='monaco-notepad' and mimeType='application/vnd.google-apps.folder' and trashed=false")
	if err != nil {
		s.logger.Console("Failed to check appDataFolder: %v", err)
		return false
	}
	return len(folders) > 0
}

// checkMigrationCompleteMarker はappDataFolder内のマイグレーション完了マーカーを確認する
func (s *driveService) checkMigrationCompleteMarker(appDataOps DriveOperations) bool {
	folders, err := appDataOps.ListFiles(
		"name='monaco-notepad' and mimeType='application/vnd.google-apps.folder' and trashed=false")
	if err != nil || len(folders) == 0 {
		return false
	}
	markers, err := appDataOps.ListFiles(
		fmt.Sprintf("name='%s' and '%s' in parents and trashed=false", migrationCompleteMarkerName, folders[0].Id))
	if err != nil || len(markers) == 0 {
		return false
	}
	return true
}

// writeMigrationCompleteMarker はappDataFolderにマイグレーション完了マーカーを書き込む
func (s *driveService) writeMigrationCompleteMarker(appDataOps DriveOperations, rootID string) error {
	content, _ := json.Marshal(map[string]string{
		"completedAt": time.Now().UTC().Format(time.RFC3339),
	})
	_, err := appDataOps.CreateFile(migrationCompleteMarkerName, content, rootID, "application/json")
	return err
}

// checkAppDataFolderCanCreate はappDataFolder空間にアクセスできるかテストする
func (s *driveService) checkAppDataFolderCanCreate(appDataOps DriveOperations) bool {
	_, err := appDataOps.ListFiles("trashed=false")
	return err == nil
}

// executeMigration はレガシーDrive空間からappDataFolderへデータを移行する
func (s *driveService) executeMigration(deleteOld bool) error {
	s.logger.InfoCode(MsgDriveMigrationStarting, nil)
	s.logger.NotifyDriveStatus(s.ctx, "syncing")

	legacyOps := s.newDriveOperations(false)
	appDataOps := s.newDriveOperations(true)

	// appDataFolderに既にデータがあるか確認（別デバイスで移行済み）
	if s.checkAppDataFolderExists(appDataOps) {
		s.logger.InfoCode(MsgDriveMigrationAlreadyDone, nil)
		if err := s.saveMigrationState(&driveStorageMigration{
			Migrated:       true,
			MigratedAt:     time.Now().UTC().Format(time.RFC3339),
			OldDataDeleted: deleteOld,
		}); err != nil {
			return fmt.Errorf("failed to save migration state: %w", err)
		}
		if deleteOld {
			s.deleteOldDriveData(legacyOps)
		}
		return nil
	}

	// レガシー空間のルートフォルダを検索
	rootFolders, err := legacyOps.ListFiles(
		"name='monaco-notepad' and mimeType='application/vnd.google-apps.folder' and trashed=false")
	if err != nil {
		return fmt.Errorf("failed to find legacy root folder: %w", err)
	}
	if len(rootFolders) == 0 {
		s.logger.Console("No legacy data found, treating as fresh install")
		return s.saveMigrationState(&driveStorageMigration{
			Migrated:   true,
			MigratedAt: time.Now().UTC().Format(time.RFC3339),
		})
	}
	oldRootID := rootFolders[0].Id

	// appDataFolderにフォルダ構造を作成
	newRootID, err := appDataOps.CreateFolder("monaco-notepad", "appDataFolder")
	if err != nil {
		return fmt.Errorf("failed to create appDataFolder root: %w", err)
	}
	newNotesID, err := appDataOps.CreateFolder("notes", newRootID)
	if err != nil {
		return fmt.Errorf("failed to create appDataFolder notes folder: %w", err)
	}

	// noteList_v2.json をコピー
	noteListFiles, err := legacyOps.ListFiles(
		fmt.Sprintf("name='noteList_v2.json' and '%s' in parents and trashed=false", oldRootID))
	if err != nil {
		return fmt.Errorf("failed to list noteList_v2.json: %w", err)
	}
	if len(noteListFiles) > 0 {
		s.logger.InfoCode(MsgDriveMigrationNoteList, nil)
		content, err := legacyOps.DownloadFile(noteListFiles[0].Id)
		if err != nil {
			return fmt.Errorf("failed to download noteList_v2.json: %w", err)
		}
		if _, err := appDataOps.CreateFile("noteList_v2.json", content, newRootID, "application/json"); err != nil {
			return fmt.Errorf("failed to copy noteList_v2.json: %w", err)
		}
	}

	// ノートファイルをコピー
	oldNotesFolders, err := legacyOps.ListFiles(
		fmt.Sprintf("name='notes' and '%s' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false", oldRootID))
	if err != nil {
		return fmt.Errorf("failed to list legacy notes folder: %w", err)
	}
	if len(oldNotesFolders) > 0 {
		oldNotesID := oldNotesFolders[0].Id
		noteFiles, err := legacyOps.ListFiles(
			fmt.Sprintf("'%s' in parents and trashed=false", oldNotesID))
		if err != nil {
			return fmt.Errorf("failed to list note files: %w", err)
		} else {
			copied := 0
			failed := 0
			total := len(noteFiles)
			for i, file := range noteFiles {
				s.logger.InfoCode(MsgDriveMigrationProgress, map[string]interface{}{"current": i + 1, "total": total})
				content, err := legacyOps.DownloadFile(file.Id)
				if err != nil {
					s.logger.Console("Warning: failed to download note %s: %v", file.Name, err)
					failed++
					continue
				}
				if _, err := appDataOps.CreateFile(file.Name, content, newNotesID, "application/json"); err != nil {
					s.logger.Console("Warning: failed to copy note %s: %v", file.Name, err)
					failed++
					continue
				}
				copied++
			}
			s.logger.InfoCode(MsgDriveMigrationCopied, map[string]interface{}{"count": copied})
			if len(noteFiles) > 0 && copied == 0 {
				return fmt.Errorf("failed to copy any note files")
			}
			if failed > 0 {
				return fmt.Errorf("failed to copy %d of %d note files", failed, len(noteFiles))
			}
		}
	}

	// Drive上にマイグレーション完了マーカーを書き込む（他デバイスからの判定用）
	if err := s.writeMigrationCompleteMarker(appDataOps, newRootID); err != nil {
		s.logger.Console("Warning: failed to write migration complete marker: %v", err)
	}

	// ローカルのマイグレーション状態を保存
	if err := s.saveMigrationState(&driveStorageMigration{
		Migrated:       true,
		MigratedAt:     time.Now().UTC().Format(time.RFC3339),
		OldDataDeleted: deleteOld,
	}); err != nil {
		return fmt.Errorf("failed to save migration state: %w", err)
	}

	// 旧データの削除（ユーザー選択時）
	if deleteOld {
		s.deleteOldDriveData(legacyOps)
	}

	s.logger.InfoCode(MsgDriveMigrationComplete, nil)
	return nil
}

// cleanupAppDataFolder はappDataFolder内の不完全なデータを削除する（中断されたマイグレーションのリカバリー用）
func (s *driveService) cleanupAppDataFolder(appDataOps DriveOperations) {
	s.logger.InfoCode(MsgDriveMigrationCleaningUp, nil)
	folders, err := appDataOps.ListFiles(
		"name='monaco-notepad' and mimeType='application/vnd.google-apps.folder' and trashed=false")
	if err != nil || len(folders) == 0 {
		return
	}
	for _, folder := range folders {
		if err := appDataOps.DeleteFile(folder.Id); err != nil {
			s.logger.Console("Warning: failed to delete appDataFolder folder %s: %v", folder.Id, err)
		}
	}
	s.logger.InfoCode(MsgDriveMigrationCleanedUp, nil)
}

// cleanupLegacyOrphansBeforeMigration はマイグレーション前にレガシーDrive上の孤立ノートを解消する。
// ローカルnoteListは変更せず、レガシーのクラウドnoteListのみ更新する。
// マイグレーション後の初期同期（pullCloudChanges）で正規のルートでローカルに反映される。
func (s *driveService) cleanupLegacyOrphansBeforeMigration(legacyOps DriveOperations) {
	rootFolders, err := legacyOps.ListFiles(
		"name='monaco-notepad' and mimeType='application/vnd.google-apps.folder' and trashed=false")
	if err != nil || len(rootFolders) == 0 {
		return
	}
	oldRootID := rootFolders[0].Id

	notesFolders, err := legacyOps.ListFiles(
		fmt.Sprintf("name='notes' and '%s' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false", oldRootID))
	if err != nil || len(notesFolders) == 0 {
		return
	}

	files, err := legacyOps.ListFiles(
		fmt.Sprintf("'%s' in parents and trashed=false", notesFolders[0].Id))
	if err != nil {
		s.logger.Console("Pre-migration orphan cleanup: failed to list legacy notes: %v", err)
		return
	}

	// クラウドnoteListをダウンロード
	noteListFiles, err := legacyOps.ListFiles(
		fmt.Sprintf("name='noteList_v2.json' and '%s' in parents and trashed=false", oldRootID))
	if err != nil || len(noteListFiles) == 0 {
		s.logger.Console("Pre-migration orphan cleanup: no cloud noteList found, skipping")
		return
	}
	cloudData, err := legacyOps.DownloadFile(noteListFiles[0].Id)
	if err != nil {
		s.logger.Console("Pre-migration orphan cleanup: failed to download cloud noteList: %v", err)
		return
	}
	var cloudNoteList NoteList
	if err := json.Unmarshal(cloudData, &cloudNoteList); err != nil {
		s.logger.Console("Pre-migration orphan cleanup: failed to parse cloud noteList: %v", err)
		return
	}

	// 同一IDファイルの重複を解消（最新を残す）
	latestFiles := make(map[string]*drive.File)
	var deletedDuplicateCount int
	for _, file := range files {
		if !strings.HasSuffix(file.Name, ".json") {
			continue
		}
		noteID := strings.TrimSuffix(file.Name, ".json")
		if existing, ok := latestFiles[noteID]; ok {
			var older *drive.File
			if file.ModifiedTime > existing.ModifiedTime {
				older = existing
				latestFiles[noteID] = file
			} else {
				older = file
			}
			if err := legacyOps.DeleteFile(older.Id); err != nil {
				s.logger.Console("Failed to delete same-ID duplicate from Drive %s: %v", older.Name, err)
			} else {
				deletedDuplicateCount++
			}
		} else {
			latestFiles[noteID] = file
		}
	}

	// クラウドnoteListに存在しないファイルを孤立として検出
	cloudNoteIDSet := make(map[string]bool)
	for _, m := range cloudNoteList.Notes {
		cloudNoteIDSet[m.ID] = true
	}

	type orphanEntry struct {
		noteID string
		file   *drive.File
	}
	var orphans []orphanEntry
	for noteID, file := range latestFiles {
		if !cloudNoteIDSet[noteID] {
			orphans = append(orphans, orphanEntry{noteID, file})
		}
	}

	if len(orphans) == 0 {
		if deletedDuplicateCount > 0 {
			s.logger.Console("Pre-migration orphan cleanup: no orphans, %d duplicates removed", deletedDuplicateCount)
		}
		return
	}

	// 既存ノートの重複判定用ハッシュセット（ローカル + クラウド両方を対象）
	existingHashes := make(map[string]bool)
	for _, metadata := range s.noteService.noteList.Notes {
		note, err := s.noteService.LoadNote(metadata.ID)
		if err == nil {
			existingHashes[computeConflictCopyDedupHash(note)] = true
		}
	}

	// クラウドnoteListにリカバリフォルダを確保
	var recoveryFolderID string
	for _, f := range cloudNoteList.Folders {
		if f.Name == RecoveryFolderName {
			recoveryFolderID = f.ID
			break
		}
	}
	if recoveryFolderID == "" {
		recoveryFolderID = uuid.New().String()
		cloudNoteList.Folders = append(cloudNoteList.Folders, Folder{
			ID:   recoveryFolderID,
			Name: RecoveryFolderName,
		})
	}

	// 孤立ノートをクラウドnoteListにのみ追加（ローカルには反映しない）
	var recoveredCount int
	totalOrphans := len(orphans)
	for i, entry := range orphans {
		s.logger.InfoCode(MsgOrphanCloudRecoveryProgress, map[string]interface{}{
			"current": i + 1,
			"total":   totalOrphans,
		})

		content, err := legacyOps.DownloadFile(entry.file.Id)
		if err != nil {
			s.logger.Console("Failed to download orphan cloud note %s: %v", entry.noteID, err)
			continue
		}

		var note Note
		if err := json.Unmarshal(content, &note); err != nil {
			s.logger.Console("Skipped corrupted orphan cloud note %s: %v", entry.noteID, err)
			continue
		}
		note.ID = entry.noteID

		// conflict copy の重複判定
		if isConflictCopyTitle(note.Title) {
			hash := computeConflictCopyDedupHash(&note)
			if existingHashes[hash] {
				if err := legacyOps.DeleteFile(entry.file.Id); err != nil {
					s.logger.Console("Failed to delete duplicate conflict copy from Drive %s: %v", entry.noteID, err)
				} else {
					s.logger.Console("Deleted duplicate conflict copy from Drive: \"%s\" (%s)", note.Title, entry.noteID)
					deletedDuplicateCount++
				}
				continue
			}
			existingHashes[hash] = true
		}

		// クラウドnoteListにのみメタデータを追加
		cloudNoteList.Notes = append(cloudNoteList.Notes, NoteMetadata{
			ID:            note.ID,
			Title:         note.Title,
			ContentHeader: note.ContentHeader,
			Language:      note.Language,
			ModifiedTime:  note.ModifiedTime,
			ContentHash:   computeContentHash(&note),
			FolderID:      recoveryFolderID,
		})

		recoveredCount++
		s.logger.Console("Recovered orphan cloud note: \"%s\" (%s)", note.Title, entry.noteID)
	}

	if recoveredCount > 0 {
		s.logger.Console("Pre-migration orphan cleanup: recovered %d notes", recoveredCount)
		updatedData, err := json.Marshal(&cloudNoteList)
		if err != nil {
			s.logger.Console("Pre-migration: failed to marshal updated cloud noteList: %v", err)
			return
		}
		if err := legacyOps.UpdateFile(noteListFiles[0].Id, updatedData); err != nil {
			s.logger.Console("Pre-migration: failed to update cloud noteList: %v", err)
		} else {
			s.logger.Console("Pre-migration: updated cloud noteList with %d recovered orphans", recoveredCount)
		}
	}
}

// deleteOldDriveData はレガシーDrive空間の旧データを削除する
func (s *driveService) deleteOldDriveData(legacyOps DriveOperations) {
	s.logger.InfoCode(MsgDriveMigrationDeletingOld, nil)
	rootFolders, err := legacyOps.ListFiles(
		"name='monaco-notepad' and mimeType='application/vnd.google-apps.folder' and trashed=false")
	if err != nil || len(rootFolders) == 0 {
		return
	}
	for _, folder := range rootFolders {
		if err := legacyOps.DeleteFile(folder.Id); err != nil {
			s.logger.Console("Warning: failed to delete old folder %s: %v", folder.Id, err)
		}
	}
	s.logger.InfoCode(MsgDriveMigrationDeletedOld, nil)
}
