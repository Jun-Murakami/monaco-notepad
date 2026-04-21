import { AuthError, RetryableError } from './retry';

/**
 * Google Drive REST API v3 低レベルクライアント。
 * appDataFolder スコープのみで動作する（space=appDataFolder を常に指定）。
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export interface DriveFile {
	id: string;
	name: string;
	mimeType?: string;
	modifiedTime?: string;
	parents?: string[];
	trashed?: boolean;
}

export interface ListChangesResult {
	changes: Array<{
		fileId?: string;
		removed?: boolean;
		file?: DriveFile;
	}>;
	newStartPageToken?: string;
	nextPageToken?: string;
}

export type TokenProvider = () => Promise<string>;

export class DriveClient {
	constructor(private readonly getToken: TokenProvider) {}

	private async request(
		path: string,
		init: RequestInit & { baseUrl?: string } = {},
		signal?: AbortSignal,
	): Promise<Response> {
		const token = await this.getToken();
		const url = (init.baseUrl ?? DRIVE_API) + path;
		const headers = new Headers(init.headers);
		headers.set('Authorization', `Bearer ${token}`);
		const res = await fetch(url, { ...init, headers, signal });
		if (res.status === 401 || res.status === 403) {
			throw new AuthError(`Drive auth error: ${res.status} ${await safeText(res)}`);
		}
		if (res.status === 429 || res.status >= 500) {
			throw new RetryableError(`Drive retryable error: ${res.status}`);
		}
		if (!res.ok) {
			const text = await safeText(res);
			const err = new Error(`Drive error ${res.status}: ${text}`) as Error & {
				status?: number;
			};
			err.status = res.status;
			throw err;
		}
		return res;
	}

	/** 指定 parent 配下のファイルを一覧。name と modifiedTime でソート。 */
	async listFiles(query: string, pageSize = 200): Promise<DriveFile[]> {
		const results: DriveFile[] = [];
		let pageToken: string | undefined;
		do {
			const params = new URLSearchParams({
				q: query,
				spaces: 'appDataFolder',
				fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, parents, trashed)',
				pageSize: String(pageSize),
			});
			if (pageToken) params.set('pageToken', pageToken);
			const res = await this.request(`/files?${params.toString()}`);
			const body = (await res.json()) as {
				files?: DriveFile[];
				nextPageToken?: string;
			};
			if (body.files) results.push(...body.files);
			pageToken = body.nextPageToken;
		} while (pageToken);
		return results;
	}

	/** 1ファイルのメタデータ取得。 */
	async getFileMetadata(fileId: string): Promise<DriveFile> {
		const params = new URLSearchParams({
			fields: 'id, name, mimeType, modifiedTime, parents, trashed',
			supportsAllDrives: 'false',
		});
		const res = await this.request(`/files/${fileId}?${params.toString()}`);
		return (await res.json()) as DriveFile;
	}

	/** ファイルのテキスト内容取得。 */
	async downloadText(fileId: string): Promise<string> {
		const res = await this.request(`/files/${fileId}?alt=media`);
		return res.text();
	}

	/** 新規ファイル作成（multipart）。 */
	async createFile(
		name: string,
		parents: string[] | null,
		content: string,
		mimeType = 'application/json',
	): Promise<DriveFile> {
		const metadata: Record<string, unknown> = { name, mimeType };
		if (parents && parents.length > 0) {
			metadata.parents = parents;
		} else {
			metadata.parents = ['appDataFolder'];
		}

		const boundary = `----MNBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
		const body =
			`--${boundary}\r\n` +
			`Content-Type: application/json; charset=UTF-8\r\n\r\n` +
			`${JSON.stringify(metadata)}\r\n` +
			`--${boundary}\r\n` +
			`Content-Type: ${mimeType}; charset=UTF-8\r\n\r\n` +
			`${content}\r\n` +
			`--${boundary}--`;

		const params = new URLSearchParams({
			uploadType: 'multipart',
			fields: 'id, name, mimeType, modifiedTime, parents, trashed',
		});

		const res = await this.request(
			`/files?${params.toString()}`,
			{
				method: 'POST',
				headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
				body,
				baseUrl: DRIVE_UPLOAD,
			},
		);
		return (await res.json()) as DriveFile;
	}

	/** 新規フォルダ作成。 */
	async createFolder(name: string, parents: string[] | null): Promise<DriveFile> {
		const metadata = {
			name,
			mimeType: 'application/vnd.google-apps.folder',
			parents: parents && parents.length > 0 ? parents : ['appDataFolder'],
		};
		const params = new URLSearchParams({
			fields: 'id, name, mimeType, modifiedTime, parents, trashed',
		});
		const res = await this.request(`/files?${params.toString()}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(metadata),
		});
		return (await res.json()) as DriveFile;
	}

	/** 既存ファイル更新。 */
	async updateFile(
		fileId: string,
		content: string,
		mimeType = 'application/json',
	): Promise<DriveFile> {
		const params = new URLSearchParams({
			uploadType: 'media',
			fields: 'id, name, mimeType, modifiedTime, parents, trashed',
		});
		const res = await this.request(
			`/files/${fileId}?${params.toString()}`,
			{
				method: 'PATCH',
				headers: { 'Content-Type': mimeType },
				body: content,
				baseUrl: DRIVE_UPLOAD,
			},
		);
		return (await res.json()) as DriveFile;
	}

	async deleteFile(fileId: string): Promise<void> {
		await this.request(`/files/${fileId}`, { method: 'DELETE' });
	}

	/** Changes API: 初期トークン取得。 */
	async getStartPageToken(): Promise<string> {
		const params = new URLSearchParams({ supportsAllDrives: 'false' });
		const res = await this.request(`/changes/startPageToken?${params.toString()}`);
		const body = (await res.json()) as { startPageToken: string };
		return body.startPageToken;
	}

	/** Changes API: 変更一覧取得。 */
	async listChanges(pageToken: string): Promise<ListChangesResult> {
		const aggregated: ListChangesResult = { changes: [] };
		let token: string | undefined = pageToken;
		while (token) {
			const params = new URLSearchParams({
				pageToken: token,
				spaces: 'appDataFolder',
				fields:
					'newStartPageToken, nextPageToken, changes(fileId, removed, file(id, name, mimeType, modifiedTime, parents, trashed))',
				includeRemoved: 'true',
				pageSize: '200',
			});
			const res = await this.request(`/changes?${params.toString()}`);
			const body = (await res.json()) as ListChangesResult;
			aggregated.changes.push(...body.changes);
			if (body.newStartPageToken) aggregated.newStartPageToken = body.newStartPageToken;
			token = body.nextPageToken;
		}
		return aggregated;
	}
}

async function safeText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return '';
	}
}
