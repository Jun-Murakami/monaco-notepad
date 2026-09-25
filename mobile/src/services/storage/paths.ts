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
export const SYNC_BASE_PATH = `${APP_DATA_DIR}sync_base.json`;
export const CHANGE_PAGE_TOKEN_PATH = `${APP_DATA_DIR}change_page_token.json`;
export const SETTINGS_PATH = `${APP_DATA_DIR}settings.json`;
/** 旧バージョンの操作キュー（v3 では使わない。サインアウト時の掃除用に残す）。 */
export const OP_QUEUE_PATH = `${APP_DATA_DIR}op_queue.json`;

/**
 * 端末ローカルの保存先一式。本番は既定値（APP_DATA_DIR 配下）を使い、
 * テストでは端末ごとに別ディレクトリを渡して複数端末を 1 プロセスで動かす。
 */
export interface StoragePaths {
	appDataDir: string;
	notesDir: string;
	noteListPath: string;
	syncStatePath: string;
	syncBasePath: string;
	conflictBackupDir: string;
}

export function storagePaths(appDataDir: string = APP_DATA_DIR): StoragePaths {
	const root = ensureSlash(appDataDir);
	return {
		appDataDir: root,
		notesDir: `${root}notes/`,
		noteListPath: `${root}noteList.json`,
		syncStatePath: `${root}sync_state.json`,
		syncBasePath: `${root}sync_base.json`,
		conflictBackupDir: `${root}cloud_conflict_backups/`,
	};
}

export const DEFAULT_STORAGE_PATHS = storagePaths();

/**
 * 同期データ由来のノートIDがファイルパス生成に安全か検証する。
 * パストラバーサル（"/", "\\", "..", 空, 特殊値, 制御文字）を含むIDを拒否する。
 * ローカル生成IDは UUID v4 (expo-crypto) なので、正当なIDがこの検証で弾かれることはない。
 * Drive 経由で同期されるノートの ID は別デバイスや侵害された Drive アカウントから
 * 改竄されうるため、ファイルパス生成前に必ず通すこと（デスクトップ版 isSafeNoteID と対応）。
 */
export function isSafeNoteId(id: string): boolean {
	if (!id || id === '.' || id === '..') return false;
	if (id.includes('/') || id.includes('\\') || id.includes('..')) return false;
	// NUL / 制御文字を含むIDを拒否する
	for (let i = 0; i < id.length; i++) {
		if (id.charCodeAt(i) < 0x20) return false;
	}
	return true;
}

export function noteFilePath(noteId: string, notesDir = NOTES_DIR): string {
	if (!isSafeNoteId(noteId)) {
		throw new Error(`unsafe note id rejected: ${JSON.stringify(noteId)}`);
	}
	return `${notesDir}${noteId}.json`;
}
