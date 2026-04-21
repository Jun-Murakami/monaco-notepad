/**
 * expo-file-system の in-memory モック。
 * writeAtomic が tempfile→rename を使うので move/delete も正しく実装する。
 */

export const documentDirectory = '/mem/';
export const cacheDirectory = '/mem-cache/';

export const EncodingType = {
	UTF8: 'utf8',
	Base64: 'base64',
} as const;

type FileEntry = { kind: 'file'; content: string };
type DirEntry = { kind: 'dir' };
type Entry = FileEntry | DirEntry;

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

function normalize(path: string): string {
	return path.replace(/\/+$/, '');
}

function parent(path: string): string {
	const p = normalize(path);
	const idx = p.lastIndexOf('/');
	return idx <= 0 ? '/' : p.slice(0, idx);
}

export async function getInfoAsync(
	path: string,
): Promise<{ exists: boolean; isDirectory: boolean; uri: string }> {
	const p = normalize(path);
	const e = store.get(p);
	if (!e) return { exists: false, isDirectory: false, uri: path };
	return { exists: true, isDirectory: e.kind === 'dir', uri: path };
}

export async function makeDirectoryAsync(
	path: string,
	opts?: { intermediates?: boolean },
): Promise<void> {
	const p = normalize(path);
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

export async function writeAsStringAsync(
	path: string,
	content: string,
	_opts?: { encoding?: string },
): Promise<void> {
	const p = normalize(path);
	// 親ディレクトリ存在確認 (ゆるい)。作る。
	const pa = parent(p);
	if (pa !== '/' && !store.has(pa)) store.set(pa, { kind: 'dir' });
	store.set(p, { kind: 'file', content });
}

export async function readAsStringAsync(
	path: string,
	_opts?: { encoding?: string },
): Promise<string> {
	const e = store.get(normalize(path));
	if (!e || e.kind !== 'file') throw new Error(`No such file: ${path}`);
	return e.content;
}

export async function deleteAsync(
	path: string,
	opts?: { idempotent?: boolean },
): Promise<void> {
	const p = normalize(path);
	if (!store.has(p)) {
		if (opts?.idempotent) return;
		throw new Error(`No such path: ${path}`);
	}
	for (const key of Array.from(store.keys())) {
		if (key === p || key.startsWith(`${p}/`)) store.delete(key);
	}
}

export async function moveAsync({ from, to }: { from: string; to: string }): Promise<void> {
	const src = normalize(from);
	const dst = normalize(to);
	const e = store.get(src);
	if (!e) throw new Error(`No such path: ${from}`);
	store.delete(src);
	store.set(dst, e);
}

export async function readDirectoryAsync(path: string): Promise<string[]> {
	const p = normalize(path);
	const prefix = `${p}/`;
	const out: string[] = [];
	for (const key of store.keys()) {
		if (key.startsWith(prefix)) {
			const rest = key.slice(prefix.length);
			if (!rest.includes('/')) out.push(rest);
		}
	}
	return out;
}

export default {
	documentDirectory,
	cacheDirectory,
	EncodingType,
	getInfoAsync,
	makeDirectoryAsync,
	writeAsStringAsync,
	readAsStringAsync,
	deleteAsync,
	moveAsync,
	readDirectoryAsync,
};
