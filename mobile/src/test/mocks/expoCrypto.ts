/**
 * expo-crypto を Node.js の webcrypto / crypto で代替するモック。
 * テストで computeContentHash などが実際に動くようにする。
 */
import { createHash, randomBytes } from 'node:crypto';

export const CryptoDigestAlgorithm = {
	SHA256: 'sha256',
	SHA1: 'sha1',
	MD5: 'md5',
} as const;

export const CryptoEncoding = {
	HEX: 'hex',
	BASE64: 'base64',
} as const;

export async function digestStringAsync(
	algorithm: string,
	data: string,
	options?: { encoding?: string },
): Promise<string> {
	const h = createHash(algorithm);
	h.update(data, 'utf8');
	const enc = (options?.encoding ?? 'hex') as 'hex' | 'base64';
	return h.digest(enc);
}

export function getRandomBytes(length: number): Uint8Array {
	return new Uint8Array(randomBytes(length));
}

export async function getRandomBytesAsync(length: number): Promise<Uint8Array> {
	return getRandomBytes(length);
}

export default {
	CryptoDigestAlgorithm,
	CryptoEncoding,
	digestStringAsync,
	getRandomBytes,
	getRandomBytesAsync,
};
