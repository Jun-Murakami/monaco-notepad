import { Directory, File } from 'expo-file-system';

/**
 * 原子的なファイル書き込み（tempfile → rename）。
 * デスクトップ版の sync_state.go saveLocked() と同等の耐障害性を確保する。
 *
 * 新 File API: create/write/delete/move は同期。async を維持しているのは
 * 呼び出し側 API の後方互換のため（I/O 自体は新 API ではブロッキング）。
 */
export async function writeAtomic(
	path: string,
	content: string,
): Promise<void> {
	const tmpPath = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const tmp = new File(tmpPath);
	tmp.create({ intermediates: true, overwrite: true });
	tmp.write(content);
	try {
		const dst = new File(path);
		if (dst.exists) dst.delete();
		tmp.move(dst);
	} catch (e) {
		if (tmp.exists) tmp.delete();
		throw e;
	}
}

export async function readString(path: string): Promise<string | null> {
	const f = new File(path);
	if (!f.exists) return null;
	return f.text();
}

export async function ensureDir(path: string): Promise<void> {
	const d = new Directory(path);
	if (!d.exists) d.create({ intermediates: true, idempotent: true });
}

export async function deleteIfExists(path: string): Promise<void> {
	const f = new File(path);
	if (f.exists) f.delete();
}
