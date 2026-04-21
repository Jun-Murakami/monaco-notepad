/**
 * JavaScript はシングルスレッドだが、非同期処理が並行で走るため
 * クリティカルセクションの直列化には明示的なロックが必要。
 * デスクトップ版 Go の syncMu に相当。
 */
export class AsyncLock {
	private queue: Promise<void> = Promise.resolve();

	async run<T>(fn: () => Promise<T>): Promise<T> {
		let release: () => void = () => {};
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});

		const prev = this.queue;
		this.queue = prev.then(() => next);

		await prev;
		try {
			return await fn();
		} finally {
			release();
		}
	}
}
