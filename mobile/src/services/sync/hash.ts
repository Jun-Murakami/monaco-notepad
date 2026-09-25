import * as Crypto from 'expo-crypto';
import type { Note } from './types';

/**
 * ノートの内容ハッシュ。デスクトップ版 backend/domain.go の computeContentHash と一致。
 * 含める: id, title, content, language, archived
 * 除外: folderId（ローカルメタ）, modifiedTime（タイムスタンプ）
 */
export async function computeContentHash(note: Note): Promise<string> {
	const payload = `${note.id}\n${note.title}\n${note.content}\n${note.language}\n${note.archived}`;
	return Crypto.digestStringAsync(
		Crypto.CryptoDigestAlgorithm.SHA256,
		payload,
		{
			encoding: Crypto.CryptoEncoding.HEX,
		},
	);
}
