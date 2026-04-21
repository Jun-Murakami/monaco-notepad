import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriveClient } from '../driveClient';
import { AuthError, RetryableError } from '../retry';

interface MockCall {
	url: string;
	init: RequestInit & { baseUrl?: string };
}

describe('DriveClient', () => {
	const calls: MockCall[] = [];
	let fetchMock: ReturnType<typeof vi.fn>;
	let client: DriveClient;

	beforeEach(() => {
		calls.length = 0;
		fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, init: init ?? {} });
			return makeResponse({ files: [], ok: true });
		});
		vi.stubGlobal('fetch', fetchMock);
		client = new DriveClient(async () => 'token-xyz');
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('Authorization ヘッダに token を付ける', async () => {
		await client.getFileMetadata('fid');
		expect(calls.length).toBe(1);
		const headers = new Headers(calls[0].init.headers);
		expect(headers.get('Authorization')).toBe('Bearer token-xyz');
	});

	it('listFiles は spaces=appDataFolder を付けて呼ぶ', async () => {
		fetchMock.mockResolvedValueOnce(
			makeResponse({ files: [{ id: 'f1', name: 'x.json' }] }),
		);
		const files = await client.listFiles("'parent' in parents and trashed=false");
		expect(files).toEqual([{ id: 'f1', name: 'x.json' }]);
		expect(calls[0].url).toContain('spaces=appDataFolder');
	});

	it('downloadText は alt=media を使う', async () => {
		fetchMock.mockResolvedValueOnce(makeTextResponse('body'));
		const text = await client.downloadText('fid-1');
		expect(text).toBe('body');
		expect(calls[0].url).toContain('/files/fid-1?alt=media');
	});

	it('createFile は multipart でアップロード、appDataFolder を parent に追加', async () => {
		fetchMock.mockResolvedValueOnce(makeResponse({ id: 'new', name: 'a.json' }));
		const f = await client.createFile('a.json', null, '{"x":1}');
		expect(f).toEqual({ id: 'new', name: 'a.json' });
		expect(calls[0].init.baseUrl).toMatch(/upload/);
		const body = String(calls[0].init.body);
		expect(body).toContain('application/json');
		expect(body).toContain('"parents":["appDataFolder"]');
	});

	it('createFile に parents を指定したらそちらを使う', async () => {
		fetchMock.mockResolvedValueOnce(makeResponse({ id: 'new', name: 'a.json' }));
		await client.createFile('a.json', ['pid-1'], '{}');
		const body = String(calls[0].init.body);
		expect(body).toContain('"parents":["pid-1"]');
	});

	it('updateFile は PATCH', async () => {
		fetchMock.mockResolvedValueOnce(makeResponse({ id: 'fid', name: 'a.json' }));
		await client.updateFile('fid', 'new');
		expect(calls[0].init.method).toBe('PATCH');
		expect(String(calls[0].init.body)).toBe('new');
	});

	it('deleteFile は DELETE を送る', async () => {
		fetchMock.mockResolvedValueOnce(makeResponse({}));
		await client.deleteFile('fid');
		expect(calls[0].init.method).toBe('DELETE');
		expect(calls[0].url).toContain('/files/fid');
	});

	it('401 は AuthError を投げる', async () => {
		fetchMock.mockResolvedValueOnce(makeResponse({}, 401));
		await expect(client.getFileMetadata('fid')).rejects.toBeInstanceOf(AuthError);
	});

	it('403 も AuthError を投げる（スコープ不足）', async () => {
		fetchMock.mockResolvedValueOnce(makeResponse({}, 403));
		await expect(client.getFileMetadata('fid')).rejects.toBeInstanceOf(AuthError);
	});

	it('429 / 5xx は RetryableError を投げる', async () => {
		fetchMock.mockResolvedValueOnce(makeResponse({}, 429));
		await expect(client.getFileMetadata('fid')).rejects.toBeInstanceOf(RetryableError);
		fetchMock.mockResolvedValueOnce(makeResponse({}, 503));
		await expect(client.getFileMetadata('fid')).rejects.toBeInstanceOf(RetryableError);
	});

	it('listChanges は pageToken を渡し、nextPageToken が無くなるまで繰り返す', async () => {
		fetchMock
			.mockResolvedValueOnce(
				makeResponse({
					changes: [{ fileId: 'a' }],
					nextPageToken: 'page2',
					newStartPageToken: 'new-start',
				}),
			)
			.mockResolvedValueOnce(
				makeResponse({ changes: [{ fileId: 'b' }], newStartPageToken: 'new-start-final' }),
			);
		const result = await client.listChanges('start');
		expect(result.changes.length).toBe(2);
		expect(result.newStartPageToken).toBe('new-start-final');
		expect(calls.length).toBe(2);
		expect(calls[0].url).toContain('pageToken=start');
		expect(calls[1].url).toContain('pageToken=page2');
	});

	it('getStartPageToken は startPageToken を返す', async () => {
		fetchMock.mockResolvedValueOnce(makeResponse({ startPageToken: 'start-1' }));
		const t = await client.getStartPageToken();
		expect(t).toBe('start-1');
	});
});

function makeResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

function makeTextResponse(body: string, status = 200): Response {
	return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}
