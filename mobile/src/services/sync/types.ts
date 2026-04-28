/**
 * 同期レイヤーの型定義。
 * デスクトップ版 backend/domain.go のデータモデルと互換性を保つ。
 */

/** ノート（メモリ上の完全表現）。Drive 上の個別 JSON ファイルはこの構造。 */
export interface Note {
	id: string;
	title: string;
	content: string;
	contentHeader: string;
	language: string;
	modifiedTime: string; // RFC3339
	archived: boolean;
	folderId: string; // 空文字 = トップレベル
	syncing?: boolean; // 一時フラグ（永続化しない）
}

/** noteList_v2.json に載せる軽量メタデータ（Content を持たない）。 */
export interface NoteMetadata {
	id: string;
	title: string;
	contentHeader: string;
	language: string;
	modifiedTime: string;
	archived: boolean;
	contentHash: string;
	folderId: string;
}

export interface Folder {
	id: string;
	name: string;
	archived: boolean;
}

export type TopLevelItemType = 'note' | 'folder';

export interface TopLevelItem {
	type: TopLevelItemType;
	id: string;
}

/** noteList_v2.json のスキーマ。 */
export interface NoteList {
	version: 'v2';
	notes: NoteMetadata[];
	folders: Folder[];
	topLevelOrder: TopLevelItem[];
	archivedTopLevelOrder: TopLevelItem[];
	collapsedFolderIds: string[];
}

/** sync_state.json のスキーマ。ローカル専用、Drive には上げない。 */
export interface SyncStateSnapshot {
	dirty: boolean;
	lastSyncedDriveTs: string;
	dirtyNoteIds: Record<string, true>;
	deletedNoteIds: Record<string, true>;
	deletedFolderIds: Record<string, true>;
	lastSyncedNoteHash: Record<string, string>;
}

/**
 * 初期状態サンプル。必ず deep copy（ネスト Record を再生成）してから
 * ミュータブルに扱うこと。直接 `{ ...EMPTY_SYNC_STATE }` すると内部の
 * dirtyNoteIds 等が共有参照になり壊れる。
 */
export const EMPTY_SYNC_STATE: Readonly<SyncStateSnapshot> = Object.freeze({
	dirty: false,
	lastSyncedDriveTs: '',
	dirtyNoteIds: Object.freeze({}) as Record<string, true>,
	deletedNoteIds: Object.freeze({}) as Record<string, true>,
	deletedFolderIds: Object.freeze({}) as Record<string, true>,
	lastSyncedNoteHash: Object.freeze({}) as Record<string, string>,
});

export const EMPTY_NOTE_LIST: NoteList = {
	version: 'v2',
	notes: [],
	folders: [],
	topLevelOrder: [],
	archivedTopLevelOrder: [],
	collapsedFolderIds: [],
};

/** 復元先の固定フォルダ名（デスクトップ版と一致）。 */
export const ORPHAN_FOLDER_NAME = '不明ノート';

/** Drive 上のファイル名規約。 */
export const DRIVE_ROOT_FOLDER = 'monaco-notepad';
export const DRIVE_NOTES_FOLDER = 'notes';
export const DRIVE_NOTE_LIST_FILENAME = 'noteList_v2.json';
export const DRIVE_MIGRATION_MARKER = 'migration_complete.json';

/** OAuth2 スコープ（appDataFolder のみ）。 */
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.appdata'];

/** デスクトップ版と同名の MessageCode。frontend の i18n キーと対応する。 */
export const MessageCode = {
	DriveSyncFirstPush: 'drive.sync.firstPush',
	DriveSyncPushLocal: 'drive.sync.pushLocalChanges',
	DriveSyncPullCloud: 'drive.sync.pullCloudChanges',
	DriveSyncConflict: 'drive.sync.conflictDetected',
	DriveSyncUploadNote: 'drive.sync.uploadNote',
	DriveSyncDeleteNote: 'drive.sync.deleteNote',
	DriveSyncDownloadNote: 'drive.sync.downloadNote',
	DriveConflictKeepLocal: 'drive.conflict.keepLocal',
	DriveConflictKeepCloud: 'drive.conflict.keepCloud',
	OrphanLocalRecoveryDone: 'orphan.localRecoveryDone',
	OrphanCloudRecoveryDone: 'orphan.cloudRecoveryDone',
} as const;

export type MessageCodeValue = (typeof MessageCode)[keyof typeof MessageCode];

/** 同期ステート（状態マシン）。 */
export type SyncStatus =
	| 'idle'
	| 'pushing'
	| 'pulling'
	| 'merging'
	| 'resolving'
	| 'offline'
	| 'error';

/**
 * 同期中の細かい phase。`status` が `pulling`/`pushing`/`resolving` の間に
 * 何が起きているかをユーザーに伝えるために UI が表示する。
 *
 * - `preparing`         : Drive 接続準備 (ensureDriveLayout / orphan 復元)
 * - `fetching-notelist` : noteList_v2.json ダウンロード中 (single request, 進捗なし)
 * - `downloading-notes` : 個別ノート本文ダウンロード中 (`sync:progress` で進捗)
 * - `uploading-notes`   : 個別ノート本文アップロード中 (`sync:progress` で進捗)
 * - `merging`           : noteList 統合・書き戻し
 */
export type SyncPhase =
	| 'preparing'
	| 'fetching-notelist'
	| 'downloading-notes'
	| 'uploading-notes'
	| 'merging'
	| null;

/** 競合バックアップの種類。 */
export type ConflictBackupKind = 'cloud_wins' | 'cloud_delete';

/** 同期中に参照するクラウド側のノートリスト取得結果。 */
export interface CloudNoteListFetch {
	noteList: NoteList;
	modifiedTime: string;
	fileId: string;
}

/** Drive 上のファイル最小情報。 */
export interface DriveFileRef {
	id: string;
	name: string;
	modifiedTime: string;
	parents?: string[];
	trashed?: boolean;
}
