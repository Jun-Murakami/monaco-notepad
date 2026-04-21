import { Paths } from 'expo-file-system';

/**
 * アプリのローカルストレージパス定義。
 * デスクトップ版の appDataDir に相当するのは Expo の Paths.document。
 */

function ensureSlash(uri: string): string {
	return uri.endsWith('/') ? uri : `${uri}/`;
}

export const APP_DATA_DIR = `${ensureSlash(Paths.document.uri)}monaco-notepad/`;
export const NOTES_DIR = `${APP_DATA_DIR}notes/`;
export const CONFLICT_BACKUP_DIR = `${APP_DATA_DIR}cloud_conflict_backups/`;

export const NOTE_LIST_PATH = `${APP_DATA_DIR}noteList.json`;
export const SYNC_STATE_PATH = `${APP_DATA_DIR}sync_state.json`;
export const CHANGE_PAGE_TOKEN_PATH = `${APP_DATA_DIR}change_page_token.json`;
export const SETTINGS_PATH = `${APP_DATA_DIR}settings.json`;
export const OP_QUEUE_PATH = `${APP_DATA_DIR}op_queue.json`;

export function noteFilePath(noteId: string): string {
	return `${NOTES_DIR}${noteId}.json`;
}
