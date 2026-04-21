import type { DriveClient } from './driveClient';
import { RETRY_LIST, withRetry } from './retry';
import {
	DRIVE_NOTES_FOLDER,
	DRIVE_NOTE_LIST_FILENAME,
	DRIVE_ROOT_FOLDER,
} from './types';

/**
 * appDataFolder 配下のフォルダ・ファイル構造を初期化し、ID をキャッシュする。
 *
 * appDataFolder/
 *   └── monaco-notepad/             (rootFolderId)
 *       ├── noteList_v2.json        (noteListFileId)
 *       └── notes/                  (notesFolderId)
 *           ├── <noteId>.json
 *           └── ...
 */

export interface DriveLayout {
	rootFolderId: string;
	notesFolderId: string;
	noteListFileId: string;
	noteListModifiedTime: string;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

async function findFolder(
	client: DriveClient,
	name: string,
	parentId: string,
): Promise<string | null> {
	const files = await withRetry(
		() =>
			client.listFiles(
				`name='${escapeQuery(name)}' and '${parentId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
				10,
			),
		'findFolder',
		RETRY_LIST,
	);
	return files[0]?.id ?? null;
}

async function findFile(
	client: DriveClient,
	name: string,
	parentId: string,
): Promise<{ id: string; modifiedTime: string } | null> {
	const files = await withRetry(
		() =>
			client.listFiles(
				`name='${escapeQuery(name)}' and '${parentId}' in parents and trashed=false`,
				10,
			),
		'findFile',
		RETRY_LIST,
	);
	const f = files[0];
	return f ? { id: f.id, modifiedTime: f.modifiedTime ?? '' } : null;
}

export async function ensureDriveLayout(client: DriveClient): Promise<DriveLayout> {
	let rootFolderId = await findFolder(client, DRIVE_ROOT_FOLDER, 'appDataFolder');
	if (!rootFolderId) {
		const f = await client.createFolder(DRIVE_ROOT_FOLDER, null);
		rootFolderId = f.id;
	}

	let notesFolderId = await findFolder(client, DRIVE_NOTES_FOLDER, rootFolderId);
	if (!notesFolderId) {
		const f = await client.createFolder(DRIVE_NOTES_FOLDER, [rootFolderId]);
		notesFolderId = f.id;
	}

	const existing = await findFile(client, DRIVE_NOTE_LIST_FILENAME, rootFolderId);
	let noteListFileId: string;
	let noteListModifiedTime: string;
	if (existing) {
		noteListFileId = existing.id;
		noteListModifiedTime = existing.modifiedTime;
	} else {
		const emptyList = JSON.stringify({
			version: 'v2',
			notes: [],
			folders: [],
			topLevelOrder: [],
			archivedTopLevelOrder: [],
			collapsedFolderIds: [],
		});
		const created = await client.createFile(
			DRIVE_NOTE_LIST_FILENAME,
			[rootFolderId],
			emptyList,
		);
		noteListFileId = created.id;
		noteListModifiedTime = created.modifiedTime ?? new Date().toISOString();
	}

	return { rootFolderId, notesFolderId, noteListFileId, noteListModifiedTime };
}

function escapeQuery(s: string): string {
	return s.replace(/'/g, "\\'");
}
