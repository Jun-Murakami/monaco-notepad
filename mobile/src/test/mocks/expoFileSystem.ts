/**
 * expo-file-system (SDK 55+ の新 File/Directory/Paths API) の in-memory モック。
 *
 * 実機 API との差異:
 * - uri は "file://" プレフィックス無し (/mem/...)
 * - 書き込み系は同期 (.write / .create / .delete) ─ 実 API と同じ
 * - 非同期は .text() / .base64() / .bytes() のみ
 */

type Entry = { kind: 'dir' } | { kind: 'file'; content: string };

const store = new Map<string, Entry>();

export function resetFileSystem(): void {
	store.clear();
}

/** テスト検証用: store の中身を覗く。 */
export function dumpFileSystem(): Record<string, Entry> {
	const obj: Record<string, Entry> = {};
	for (const [k, v] of store) obj[k] = v;
	return obj;
}

function normalize(uri: string): string {
	// 末尾スラッシュを落とす。"/mem" と "/mem/" を同一視。
	return uri.replace(/\/+$/, '');
}

function joinUris(parts: ReadonlyArray<string | File | Directory>): string {
	if (parts.length === 0) return '';
	const strs = parts.map((p) => (typeof p === 'string' ? p : p.uri));
	return strs.reduce((acc, cur) => {
		if (!acc) return cur;
		if (acc.endsWith('/')) return `${acc}${cur.replace(/^\//, '')}`;
		return `${acc}/${cur.replace(/^\//, '')}`;
	}, '');
}

function ensureParents(path: string): void {
	const parent = path.slice(0, path.lastIndexOf('/'));
	if (!parent) return;
	const parts = parent.split('/').filter(Boolean);
	let cur = '';
	for (const part of parts) {
		cur = `${cur}/${part}`;
		const e = store.get(cur);
		if (!e) store.set(cur, { kind: 'dir' });
	}
}

export enum EncodingType {
	UTF8 = 'utf8',
	Base64 = 'base64',
}

export class File {
	uri: string;

	constructor(...uris: (string | File | Directory)[]) {
		this.uri = joinUris(uris);
	}

	get exists(): boolean {
		const e = store.get(normalize(this.uri));
		return !!e && e.kind === 'file';
	}

	get name(): string {
		const p = normalize(this.uri);
		const idx = p.lastIndexOf('/');
		return idx >= 0 ? p.slice(idx + 1) : p;
	}

	create(opts?: { intermediates?: boolean; overwrite?: boolean }): void {
		const p = normalize(this.uri);
		const existing = store.get(p);
		if (existing && existing.kind === 'file' && !opts?.overwrite) {
			throw new Error(`File already exists: ${p}`);
		}
		if (opts?.intermediates) ensureParents(p);
		store.set(p, { kind: 'file', content: '' });
	}

	async text(): Promise<string> {
		const e = store.get(normalize(this.uri));
		if (!e || e.kind !== 'file') throw new Error(`No such file: ${this.uri}`);
		return e.content;
	}

	write(content: string): void {
		const p = normalize(this.uri);
		ensureParents(p);
		store.set(p, { kind: 'file', content });
	}

	delete(): void {
		const p = normalize(this.uri);
		if (!store.has(p)) throw new Error(`No such file: ${p}`);
		store.delete(p);
	}

	move(destination: Directory | File): void {
		const src = normalize(this.uri);
		const e = store.get(src);
		if (!e || e.kind !== 'file') throw new Error(`No such file: ${src}`);
		// Directory を渡された場合は元ファイル名を保持して配下に移動。
		const dstUri =
			destination instanceof Directory
				? joinUris([destination, this.name])
				: destination.uri;
		const dst = normalize(dstUri);
		store.delete(src);
		store.set(dst, e);
		// 実 API 同様、呼び出した File インスタンスの uri を更新する。
		this.uri = dstUri;
	}
}

export class Directory {
	uri: string;

	constructor(...uris: (string | File | Directory)[]) {
		this.uri = joinUris(uris);
	}

	get exists(): boolean {
		const e = store.get(normalize(this.uri));
		return !!e && e.kind === 'dir';
	}

	get name(): string {
		const p = normalize(this.uri);
		const idx = p.lastIndexOf('/');
		return idx >= 0 ? p.slice(idx + 1) : p;
	}

	create(opts?: {
		intermediates?: boolean;
		idempotent?: boolean;
		overwrite?: boolean;
	}): void {
		const p = normalize(this.uri);
		if (store.has(p)) {
			if (opts?.idempotent) return;
			if (!opts?.overwrite) throw new Error(`Directory already exists: ${p}`);
		}
		if (opts?.intermediates) {
			const parts = p.split('/').filter(Boolean);
			let cur = '';
			for (const part of parts) {
				cur = `${cur}/${part}`;
				if (!store.has(cur)) store.set(cur, { kind: 'dir' });
			}
		} else {
			store.set(p, { kind: 'dir' });
		}
	}

	delete(): void {
		const p = normalize(this.uri);
		if (!store.has(p)) throw new Error(`No such directory: ${p}`);
		for (const key of Array.from(store.keys())) {
			if (key === p || key.startsWith(`${p}/`)) store.delete(key);
		}
	}

	list(): (Directory | File)[] {
		const p = normalize(this.uri);
		const prefix = `${p}/`;
		const base = this.uri.endsWith('/') ? this.uri : `${this.uri}/`;
		const out: (Directory | File)[] = [];
		for (const [key, val] of store) {
			if (!key.startsWith(prefix)) continue;
			const rest = key.slice(prefix.length);
			if (!rest || rest.includes('/')) continue;
			const full = `${base}${rest}`;
			out.push(val.kind === 'dir' ? new Directory(full) : new File(full));
		}
		return out;
	}
}

// biome-ignore lint/complexity/noStaticOnlyClass: expo-file-system の Paths API に合わせているため class 形を維持
export class Paths {
	static get document(): Directory {
		return new Directory('/mem/');
	}
	static get cache(): Directory {
		return new Directory('/mem-cache/');
	}
}
