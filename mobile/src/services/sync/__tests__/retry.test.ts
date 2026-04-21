import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, RetryableError, withRetry } from '../retry';

const OPTS = { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 100 };

describe('withRetry', () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	it('初回成功時は 1 回だけ呼ぶ', async () => {
		const fn = vi.fn().mockResolvedValue('ok');
		const result = await withRetry(fn, 'test', OPTS);
		expect(result).toBe('ok');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('retryable error ならリトライ、最終的に成功', async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new RetryableError('flaky1'))
			.mockRejectedValueOnce(new RetryableError('flaky2'))
			.mockResolvedValueOnce('finally');
		const result = await withRetry(fn, 'test', OPTS);
		expect(result).toBe('finally');
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it('AuthError は即時失敗、リトライしない', async () => {
		const fn = vi.fn().mockRejectedValue(new AuthError('401'));
		await expect(withRetry(fn, 'test', OPTS)).rejects.toThrow('401');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('HTTP 4xx (429 除く) もリトライしない', async () => {
		const err = Object.assign(new Error('http 400'), { status: 400 });
		const fn = vi.fn().mockRejectedValue(err);
		await expect(withRetry(fn, 'test', OPTS)).rejects.toThrow('http 400');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('HTTP 429 はリトライ', async () => {
		const err = Object.assign(new Error('throttled'), { status: 429 });
		const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce('ok');
		const result = await withRetry(fn, 'test', OPTS);
		expect(result).toBe('ok');
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it('HTTP 5xx はリトライ', async () => {
		const err = Object.assign(new Error('gateway'), { status: 502 });
		const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce('ok');
		await withRetry(fn, 'test', OPTS);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it('maxAttempts を超えたら最後の error を投げる', async () => {
		const fn = vi.fn().mockRejectedValue(new RetryableError('always'));
		await expect(
			withRetry(fn, 'test', { ...OPTS, maxAttempts: 3 }),
		).rejects.toThrow('always');
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it('network / timeout メッセージもリトライ対象', async () => {
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error('network request failed'))
			.mockRejectedValueOnce(new Error('request timeout'))
			.mockResolvedValueOnce('ok');
		await withRetry(fn, 'test', OPTS);
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it('backoff 指数的に伸びる (fake timers で検証)', async () => {
		vi.useFakeTimers();
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new RetryableError('e'))
			.mockRejectedValueOnce(new RetryableError('e'))
			.mockResolvedValueOnce('ok');
		const promise = withRetry(fn, 'test', {
			maxAttempts: 3,
			baseDelayMs: 10,
			maxDelayMs: 1000,
		});
		// Allow the first attempt to reject
		await vi.advanceTimersByTimeAsync(0);
		// First backoff: 10ms
		await vi.advanceTimersByTimeAsync(10);
		// Second backoff: 20ms
		await vi.advanceTimersByTimeAsync(20);
		const result = await promise;
		expect(result).toBe('ok');
		vi.useRealTimers();
	});
});
