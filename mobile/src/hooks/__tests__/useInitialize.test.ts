import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('useInitialize startup subscriptions', () => {
	beforeEach(() => {
		// import 時の副作用（syncEvents の購読登録）を検証するため、
		// テストごとにモジュールキャッシュを捨てて起動直後と同じ順序に戻す。
		vi.resetModules();
	});

	it('Drive 初期化中の接続イベントを syncStore が取りこぼさない', async () => {
		const { syncEvents } = await import('@/services/sync/events');

		// 実アプリでは RootLayout が useInitialize を読み込んでから driveService.initialize()
		// が走り、その後に SyncStatusBar が描画される。ここで useInitialize の import だけで
		// syncStore の購読が先に登録されることを保証する。
		await import('../useInitialize');

		syncEvents.emit('drive:connected', undefined);

		const { useSyncStore } = await import('@/stores/syncStore');
		expect(useSyncStore.getState()).toMatchObject({
			connected: true,
			status: 'idle',
		});
	});
});
