/**
 * Drive REST 呼び出しのリトライラッパ。
 * デスクトップ版 drive_sync_service.go の withRetry と同等の挙動。
 */

export interface RetryOptions {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
	signal?: AbortSignal;
}

export class RetryableError extends Error {
	readonly retryable = true;
	constructor(message: string, readonly cause?: unknown) {
		super(message);
	}
}

export class AuthError extends Error {
	readonly authError = true;
	constructor(message: string) {
		super(message);
	}
}

export async function withRetry<T>(
	fn: () => Promise<T>,
	label: string,
	opts: RetryOptions,
): Promise<T> {
	let delay = opts.baseDelayMs;
	let lastErr: unknown;
	for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
		if (opts.signal?.aborted) {
			throw new Error(`${label}: aborted`);
		}
		try {
			return await fn();
		} catch (e) {
			lastErr = e;
			if (!isRetryable(e) || attempt === opts.maxAttempts) {
				throw e;
			}
			await sleep(Math.min(delay, opts.maxDelayMs));
			delay = Math.min(delay * 2, opts.maxDelayMs);
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(`${label}: unknown error`);
}

function isRetryable(err: unknown): boolean {
	if (err instanceof AuthError) return false;
	if (err instanceof RetryableError) return true;
	if (err instanceof Error) {
		const msg = err.message.toLowerCase();
		if (msg.includes('network') || msg.includes('timeout') || msg.includes('fetch')) {
			return true;
		}
	}
	// HTTP エラー (status を持つ場合)
	const status = (err as { status?: number } | null)?.status;
	if (typeof status === 'number') {
		if (status === 429 || status >= 500) return true;
		return false;
	}
	return false;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** デフォルトのリトライ設定（デスクトップ版と一致）。 */
export const RETRY_DEFAULTS: RetryOptions = {
	maxAttempts: 3,
	baseDelayMs: 2000,
	maxDelayMs: 30000,
};
export const RETRY_DOWNLOAD: RetryOptions = {
	maxAttempts: 5,
	baseDelayMs: 2000,
	maxDelayMs: 30000,
};
export const RETRY_UPLOAD: RetryOptions = {
	maxAttempts: 4,
	baseDelayMs: 2000,
	maxDelayMs: 20000,
};
export const RETRY_LIST: RetryOptions = {
	maxAttempts: 4,
	baseDelayMs: 1000,
	maxDelayMs: 15000,
};
