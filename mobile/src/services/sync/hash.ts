import * as Crypto from 'expo-crypto';
import type { Note } from './types';

/**
 * ノートの内容ハッシュ。デスクトップ版 backend/domain.go の computeContentHash と一致。
 * 含める: id, title, content, language, archived
 * 除外: folderId（ローカルメタ）, modifiedTime（タイムスタンプ）
 */
export async function computeContentHash(note: Note): Promise<string> {
	const payload = `${note.id}\n${note.title}\n${note.content}\n${note.language}\n${note.archived}`;
	return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, payload, {
		encoding: Crypto.CryptoEncoding.HEX,
	});
}

/**
 * Conflict Copy の重複判定用ハッシュ。
 * 内容と言語のみで判定（id/title は意図的に無視）。
 */
export async function computeConflictCopyDedupHash(note: Note): Promise<string> {
	const payload = `${note.content}\n${note.language}`;
	return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, payload, {
		encoding: Crypto.CryptoEncoding.HEX,
	});
}

/** タイトルが "Conflict Copy of X" パターンか判定。 */
export function isConflictCopyTitle(title: string): boolean {
	return /^Conflict Copy of /i.test(title) || /^競合コピー:/.test(title);
}
