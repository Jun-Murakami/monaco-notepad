import * as FileSystem from 'expo-file-system';

/**
 * 原子的なファイル書き込み（tempfile → rename）。
 * デスクトップ版の sync_state.go saveLocked() と同等の耐障害性を確保する。
 */
export async function writeAtomic(path: string, content: string): Promise<void> {
	const tmpPath = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	await FileSystem.writeAsStringAsync(tmpPath, content, {
		encoding: FileSystem.EncodingType.UTF8,
	});
	// expo-file-system には rename API がないため、移動で代替する。
	try {
		// 既存ファイルがあれば削除してから移動（rename 相当）。
		const info = await FileSystem.getInfoAsync(path);
		if (info.exists) {
			await FileSystem.deleteAsync(path, { idempotent: true });
		}
		await FileSystem.moveAsync({ from: tmpPath, to: path });
	} catch (e) {
		// 失敗時は tmp を掃除
		await FileSystem.deleteAsync(tmpPath, { idempotent: true }).catch(() => {});
		throw e;
	}
}

export async function readString(path: string): Promise<string | null> {
	const info = await FileSystem.getInfoAsync(path);
	if (!info.exists) return null;
	return FileSystem.readAsStringAsync(path, {
		encoding: FileSystem.EncodingType.UTF8,
	});
}

export async function ensureDir(path: string): Promise<void> {
	const info = await FileSystem.getInfoAsync(path);
	if (!info.exists) {
		await FileSystem.makeDirectoryAsync(path, { intermediates: true });
	}
}

export async function deleteIfExists(path: string): Promise<void> {
	const info = await FileSystem.getInfoAsync(path);
	if (info.exists) {
		await FileSystem.deleteAsync(path, { idempotent: true });
	}
}
