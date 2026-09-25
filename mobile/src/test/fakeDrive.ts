import { createHash } from 'node:crypto';

/**
 * Google Drive REST v3 (appDataFolder) の忠実な in-memory 実装。
 *
 * - `fetch` ハンドラとして動くので、本番の DriveClient / DriveSyncService をそのまま通せる
 *   (URL 組み立て・fields 指定・multipart・エラーコード→例外の変換までテスト対象になる)。
 * - fileId / md5Checksum (実バイトの md5) / version / modifiedTime (論理時計) /
 *   Changes フィード / 同名ファイルの重複 を Drive と同じ意味論で持つ。
 * - Authorization: Bearer <deviceId> を端末 ID として扱い、端末ごとの割り込みフックと
 *   障害注入ができる。レースを「実時間の運」ではなく決定的に再現するための仕組み。
 */

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface FakeFile {
	id: string;
	name: string;
	mimeType: string;
	parents: string[];
	content: string;
	md5Checksum: string;
	version: number;
	createdTime: string;
	modifiedTime: string;
	trashed: boolean;
}

export type FakeOp =
	| 'files.list'
	| 'files.get'
	| 'files.download'
	| 'files.create'
	| 'files.update'
	| 'files.delete'
	| 'changes.getStartPageToken'
	| 'changes.list';

export interface FakeRequestInfo {
	op: FakeOp;
	deviceId: string;
	fileId?: string;
	/** create 時のファイル名、または fileId から引いたファイル名。 */
	fileName?: string;
	query?: string;
}

interface FailureRule {
	match: (req: FakeRequestInfo) => boolean;
	status: number;
	remaining: number;
}

interface HookRule {
	match: (req: FakeRequestInfo) => boolean;
	run: (req: FakeRequestInfo) => Promise<void> | void;
	remaining: number;
}

interface ChangeEntry {
	fileId: string;
	removed: boolean;
}

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const EPOCH = Date.parse('2026-01-01T00:00:00.000Z');

export class FakeDrive {
	readonly files = new Map<string, FakeFile>();
	/** 実行されたリクエストの記録（検証・デバッグ用）。 */
	readonly requests: FakeRequestInfo[] = [];
	/**
	 * ノート本体（<id>.json、noteList を除く）の履歴。書き込まれた版と、そのノートのファイルが
	 * Drive から 1 つも無くなった時点（= 削除）を順に記録する。シミュレーションの検証に使う。
	 */
	readonly noteHistory: Array<{
		kind: 'upload' | 'gone';
		name: string;
		content?: string;
		/** 書き込んだ端末（fetch 経由の場合）。 */
		deviceId?: string;
	}> = [];
	/** 処理中のリクエストの端末 ID（モデル操作の記録に使う）。 */
	private currentDevice: string | undefined;
	private changes: ChangeEntry[] = [];
	private idSeq = 0;
	private clockMs = EPOCH;
	private failures: FailureRule[] = [];
	private hooks: HookRule[] = [];

	// ---- 論理時計 ----

	/** 論理時計の現在時刻。呼ぶたびに 1ms 進むので、端末をまたいでも時刻が重ならない。 */
	now(): string {
		this.clockMs += 1;
		return new Date(this.clockMs).toISOString();
	}

	/** 変更系操作ごとに 1 秒進める。modifiedTime が常に単調増加になる。 */
	private tick(): string {
		this.clockMs += 1000;
		return this.now();
	}

	// ---- モデル操作（ピア端末やテストの初期化から直接使う） ----

	createFile(
		name: string,
		parents: string[],
		content: string,
		mimeType = 'application/json',
	): FakeFile {
		const ts = this.tick();
		const file: FakeFile = {
			id: `fid-${++this.idSeq}`,
			name,
			mimeType,
			parents: parents.length > 0 ? [...parents] : ['appDataFolder'],
			content,
			md5Checksum: md5(content),
			version: 1,
			createdTime: ts,
			modifiedTime: ts,
			trashed: false,
		};
		this.files.set(file.id, file);
		this.changes.push({ fileId: file.id, removed: false });
		if (isNoteFileName(name))
			this.noteHistory.push({
				kind: 'upload',
				name,
				content,
				deviceId: this.currentDevice,
			});
		return { ...file };
	}

	updateFile(fileId: string, content: string): FakeFile {
		const file = this.files.get(fileId);
		if (!file) throw new FakeHttpError(404, `File not found: ${fileId}.`);
		file.content = content;
		file.md5Checksum = md5(content);
		file.version += 1;
		file.modifiedTime = this.tick();
		this.changes.push({ fileId, removed: false });
		if (isNoteFileName(file.name))
			this.noteHistory.push({
				kind: 'upload',
				name: file.name,
				content,
				deviceId: this.currentDevice,
			});
		return { ...file };
	}

	deleteFile(fileId: string): void {
		const file = this.files.get(fileId);
		if (!file) throw new FakeHttpError(404, `File not found: ${fileId}.`);
		this.files.delete(fileId);
		this.tick();
		this.changes.push({ fileId, removed: true });
		if (
			isNoteFileName(file.name) &&
			![...this.files.values()].some((f) => f.name === file.name)
		) {
			this.noteHistory.push({ kind: 'gone', name: file.name });
		}
		// フォルダ削除時は配下も消える（Drive の挙動）
		if (file.mimeType === FOLDER_MIME) {
			for (const child of [...this.files.values()]) {
				if (child.parents.includes(fileId)) this.deleteFile(child.id);
			}
		}
	}

	getFile(fileId: string): FakeFile | undefined {
		const f = this.files.get(fileId);
		return f ? { ...f } : undefined;
	}

	list(query: string): FakeFile[] {
		const predicate = parseQuery(query);
		return [...this.files.values()]
			.filter(predicate)
			.sort((a, b) => a.createdTime.localeCompare(b.createdTime))
			.map((f) => ({ ...f }));
	}

	/** name と親フォルダ名のパスで 1 ファイルを引く（テストの検証用ヘルパー）。 */
	findByName(name: string, parentId?: string): FakeFile | undefined {
		return [...this.files.values()].find(
			(f) =>
				f.name === name &&
				(parentId === undefined || f.parents.includes(parentId)),
		);
	}

	startPageToken(): string {
		return String(this.changes.length + 1);
	}

	// ---- 障害注入・割り込み ----

	/** 条件に一致するリクエストを `times` 回だけ指定ステータスで失敗させる。 */
	failWhen(
		match: (req: FakeRequestInfo) => boolean,
		status = 500,
		times = 1,
	): void {
		this.failures.push({ match, status, remaining: times });
	}

	/**
	 * 条件に一致するリクエストの「処理直前」に run を実行する（既定 1 回）。
	 * 他端末の操作を任意のタイミングへ差し込み、レースを決定的に再現するために使う。
	 */
	beforeRequest(
		match: (req: FakeRequestInfo) => boolean,
		run: (req: FakeRequestInfo) => Promise<void> | void,
		times = 1,
	): void {
		this.hooks.push({ match, run, remaining: times });
	}

	clearInterceptors(): void {
		this.failures = [];
		this.hooks = [];
	}

	// ---- fetch ハンドラ ----

	readonly fetch = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url = new URL(typeof input === 'string' ? input : input.toString());
		const method = (init?.method ?? 'GET').toUpperCase();
		const headers = new Headers(init?.headers);
		const auth = headers.get('Authorization') ?? '';
		if (!auth.startsWith('Bearer ')) {
			return jsonResponse(401, errorBody(401, 'Login Required.'));
		}
		const deviceId = auth.slice('Bearer '.length);
		try {
			const route = this.route(method, url, init);
			const info: FakeRequestInfo = {
				op: route.op,
				deviceId,
				fileId: route.fileId,
				fileName:
					route.fileName ??
					(route.fileId ? this.files.get(route.fileId)?.name : undefined),
				query: route.query,
			};
			this.requests.push(info);
			for (const hook of this.hooks) {
				if (hook.remaining > 0 && hook.match(info)) {
					hook.remaining--;
					await hook.run(info);
				}
			}
			for (const rule of this.failures) {
				if (rule.remaining > 0 && rule.match(info)) {
					rule.remaining--;
					return jsonResponse(
						rule.status,
						errorBody(rule.status, 'Injected failure'),
					);
				}
			}
			this.currentDevice = deviceId;
			try {
				return route.handle();
			} finally {
				this.currentDevice = undefined;
			}
		} catch (e) {
			if (e instanceof FakeHttpError) {
				return jsonResponse(e.status, errorBody(e.status, e.message));
			}
			throw e;
		}
	};

	private route(
		method: string,
		url: URL,
		init?: RequestInit,
	): {
		op: FakeOp;
		fileId?: string;
		fileName?: string;
		query?: string;
		handle: () => Response;
	} {
		const full = url.origin + url.pathname;
		const params = url.searchParams;
		const fields = params.get('fields') ?? undefined;
		const filesBase = `${DRIVE_API}/files`;
		const uploadBase = `${DRIVE_UPLOAD}/files`;

		if (full === `${DRIVE_API}/changes/startPageToken` && method === 'GET') {
			return {
				op: 'changes.getStartPageToken',
				handle: () =>
					jsonResponse(200, { startPageToken: this.startPageToken() }),
			};
		}
		if (full === `${DRIVE_API}/changes` && method === 'GET') {
			return {
				op: 'changes.list',
				handle: () => {
					const token = Number(params.get('pageToken') ?? '1');
					const pageSize = Number(params.get('pageSize') ?? '100');
					const start = Math.max(0, token - 1);
					const slice = this.changes.slice(start, start + pageSize);
					const changes = slice.map((c) => {
						const file = this.files.get(c.fileId);
						return pickFields(
							{
								fileId: c.fileId,
								removed: c.removed || !file,
								file: file ? fileResource(file) : undefined,
							},
							fields,
							'changes',
						);
					});
					const next = start + slice.length;
					const body: Record<string, unknown> = { changes };
					if (next < this.changes.length) {
						body.nextPageToken = String(next + 1);
					} else {
						body.newStartPageToken = String(this.changes.length + 1);
					}
					return jsonResponse(200, body);
				},
			};
		}
		if (full === filesBase && method === 'GET') {
			const q = params.get('q') ?? '';
			return {
				op: 'files.list',
				query: q,
				handle: () => {
					const all = this.list(q);
					const pageSize = Number(params.get('pageSize') ?? '100');
					const offset = Number(params.get('pageToken') ?? '0');
					const page = all.slice(offset, offset + pageSize);
					const body: Record<string, unknown> = {
						files: page.map((f) =>
							pickFields(fileResource(f), fields, 'files'),
						),
					};
					if (offset + pageSize < all.length) {
						body.nextPageToken = String(offset + pageSize);
					}
					return jsonResponse(200, body);
				},
			};
		}
		if (full === filesBase && method === 'POST') {
			// メタデータのみの作成（フォルダ作成に使われる）
			const meta = JSON.parse(String(init?.body ?? '{}')) as {
				name: string;
				mimeType?: string;
				parents?: string[];
			};
			return {
				op: 'files.create',
				fileName: meta.name,
				handle: () => {
					const f = this.createFile(
						meta.name,
						meta.parents ?? [],
						'',
						meta.mimeType ?? 'application/octet-stream',
					);
					return jsonResponse(200, pickFields(fileResource(f), fields));
				},
			};
		}
		if (full === uploadBase && method === 'POST') {
			const contentType = new Headers(init?.headers).get('Content-Type') ?? '';
			const { metadata, content } = parseMultipart(
				contentType,
				String(init?.body ?? ''),
			);
			return {
				op: 'files.create',
				fileName: metadata.name,
				handle: () => {
					const f = this.createFile(
						metadata.name,
						metadata.parents ?? [],
						content,
						metadata.mimeType ?? 'application/json',
					);
					return jsonResponse(200, pickFields(fileResource(f), fields));
				},
			};
		}
		if (full.startsWith(`${uploadBase}/`) && method === 'PATCH') {
			const fileId = decodeURIComponent(full.slice(uploadBase.length + 1));
			return {
				op: 'files.update',
				fileId,
				handle: () => {
					const f = this.updateFile(fileId, String(init?.body ?? ''));
					return jsonResponse(200, pickFields(fileResource(f), fields));
				},
			};
		}
		if (full.startsWith(`${filesBase}/`)) {
			const fileId = decodeURIComponent(full.slice(filesBase.length + 1));
			if (method === 'DELETE') {
				return {
					op: 'files.delete',
					fileId,
					handle: () => {
						this.deleteFile(fileId);
						return new Response(null, { status: 204 });
					},
				};
			}
			if (method === 'GET' && params.get('alt') === 'media') {
				return {
					op: 'files.download',
					fileId,
					handle: () => {
						const f = this.files.get(fileId);
						if (!f) throw new FakeHttpError(404, `File not found: ${fileId}.`);
						return new Response(f.content, { status: 200 });
					},
				};
			}
			if (method === 'GET') {
				return {
					op: 'files.get',
					fileId,
					handle: () => {
						const f = this.files.get(fileId);
						if (!f) throw new FakeHttpError(404, `File not found: ${fileId}.`);
						return jsonResponse(200, pickFields(fileResource(f), fields));
					},
				};
			}
		}
		throw new Error(`FakeDrive: unsupported request ${method} ${url}`);
	}
}

export class FakeHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function isNoteFileName(name: string): boolean {
	return name.endsWith('.json') && name !== 'noteList_v2.json';
}

function md5(content: string): string {
	return createHash('md5').update(content, 'utf8').digest('hex');
}

function fileResource(f: FakeFile): Record<string, unknown> {
	return {
		kind: 'drive#file',
		id: f.id,
		name: f.name,
		mimeType: f.mimeType,
		parents: [...f.parents],
		md5Checksum: f.mimeType === FOLDER_MIME ? undefined : f.md5Checksum,
		version: String(f.version),
		createdTime: f.createdTime,
		modifiedTime: f.modifiedTime,
		trashed: f.trashed,
		size: String(Buffer.byteLength(f.content, 'utf8')),
	};
}

/**
 * Drive の `fields` パラメータを解釈し、要求されたフィールドだけ返す。
 * 本番コードが fields に入れ忘れた値をテストが「たまたま」読めてしまうのを防ぐ。
 * container: 'files' | 'changes' などリスト形式のとき、その要素に対する指定を使う。
 */
function pickFields(
	obj: Record<string, unknown>,
	fields: string | undefined,
	container?: string,
): Record<string, unknown> {
	if (!fields) {
		// 既定フィールド（Drive v3 の既定: kind, id, name, mimeType）
		return pick(obj, [
			'kind',
			'id',
			'name',
			'mimeType',
			'fileId',
			'removed',
			'file',
		]);
	}
	const spec = parseFieldSpec(fields);
	const target = container ? spec.get(container) : spec;
	if (!target || target === true) return obj;
	return applySpec(obj, target);
}

type FieldSpec = Map<string, FieldSpec | true>;

function applySpec(
	obj: Record<string, unknown>,
	spec: FieldSpec,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, sub] of spec) {
		const value = obj[key];
		if (value === undefined) continue;
		if (sub === true || typeof value !== 'object' || value === null) {
			out[key] = value;
		} else {
			out[key] = applySpec(value as Record<string, unknown>, sub);
		}
	}
	return out;
}

function parseFieldSpec(fields: string): FieldSpec {
	let i = 0;
	const parseList = (): FieldSpec => {
		const spec: FieldSpec = new Map();
		let name = '';
		const flush = () => {
			const n = name.trim();
			if (n) spec.set(n, true);
			name = '';
		};
		while (i < fields.length) {
			const ch = fields[i];
			if (ch === '(') {
				i++;
				const n = name.trim();
				name = '';
				spec.set(n, parseList());
			} else if (ch === ')') {
				i++;
				flush();
				return spec;
			} else if (ch === ',') {
				i++;
				flush();
			} else {
				name += ch;
				i++;
			}
		}
		flush();
		return spec;
	};
	return parseList();
}

function pick(
	obj: Record<string, unknown>,
	keys: string[],
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
	return out;
}

/** 本番コードが使うクエリ形だけを受け付ける。未知の句は例外にしてテストで気付けるようにする。 */
function parseQuery(query: string): (f: FakeFile) => boolean {
	const clauses = splitAnd(query.trim());
	const preds: Array<(f: FakeFile) => boolean> = [];
	for (const raw of clauses) {
		const c = raw.trim();
		if (c === '') continue;
		let m = /^name\s*=\s*'((?:[^'\\]|\\.)*)'$/.exec(c);
		if (m) {
			const v = unescapeQuery(m[1]);
			preds.push((f) => f.name === v);
			continue;
		}
		m = /^'((?:[^'\\]|\\.)*)'\s+in\s+parents$/.exec(c);
		if (m) {
			const v = unescapeQuery(m[1]);
			preds.push((f) => f.parents.includes(v));
			continue;
		}
		m = /^mimeType\s*(!?=)\s*'((?:[^'\\]|\\.)*)'$/.exec(c);
		if (m) {
			const neg = m[1] === '!=';
			const v = unescapeQuery(m[2]);
			preds.push((f) => (f.mimeType === v) !== neg);
			continue;
		}
		m = /^trashed\s*=\s*(true|false)$/.exec(c);
		if (m) {
			const v = m[1] === 'true';
			preds.push((f) => f.trashed === v);
			continue;
		}
		throw new Error(`FakeDrive: unsupported query clause: ${c}`);
	}
	return (f) => preds.every((p) => p(f));
}

function splitAnd(query: string): string[] {
	const parts: string[] = [];
	let current = '';
	let inQuote = false;
	for (let i = 0; i < query.length; i++) {
		const ch = query[i];
		if (ch === '\\' && inQuote) {
			current += ch + (query[i + 1] ?? '');
			i++;
			continue;
		}
		if (ch === "'") inQuote = !inQuote;
		if (!inQuote && query.slice(i, i + 5).toLowerCase() === ' and ') {
			parts.push(current);
			current = '';
			i += 4;
			continue;
		}
		current += ch;
	}
	parts.push(current);
	return parts;
}

function unescapeQuery(v: string): string {
	return v.replace(/\\(.)/g, '$1');
}

function parseMultipart(
	contentType: string,
	body: string,
): {
	metadata: { name: string; mimeType?: string; parents?: string[] };
	content: string;
} {
	const m = /boundary=([^;]+)/.exec(contentType);
	if (!m) throw new Error('FakeDrive: multipart boundary missing');
	const boundary = m[1];
	const parts = body
		.split(`--${boundary}`)
		.map((p) => p)
		.filter((p) => p.trim() !== '' && p.trim() !== '--');
	const bodies = parts.map((p) => {
		const sep = p.indexOf('\r\n\r\n');
		const payload = p.slice(sep + 4);
		return payload.endsWith('\r\n') ? payload.slice(0, -2) : payload;
	});
	if (bodies.length < 2) throw new Error('FakeDrive: multipart parts missing');
	return { metadata: JSON.parse(bodies[0]), content: bodies[1] };
}

function errorBody(status: number, message: string) {
	return {
		error: {
			code: status,
			message,
			errors: [{ message, domain: 'global', reason: reasonOf(status) }],
		},
	};
}

function reasonOf(status: number): string {
	if (status === 404) return 'notFound';
	if (status === 401) return 'authError';
	if (status === 403) return 'forbidden';
	if (status === 429) return 'rateLimitExceeded';
	return 'backendError';
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}
