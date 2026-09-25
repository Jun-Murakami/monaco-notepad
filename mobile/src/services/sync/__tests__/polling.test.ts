import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appSettings } from '@/services/settings/appSettings';
import { writeAtomic } from '@/services/storage/atomicFile';
import { CHANGE_PAGE_TOKEN_PATH } from '@/services/storage/paths';
import { __setNetState } from '@/test/mocks/netinfo';
import { __setAppState } from '@/test/mocks/reactNative';
import type { DriveClient } from '../driveClient';
import { PollingService, type SyncRunner } from '../polling';

/**
 * PollingService の「いつ同期を走らせるか」の回帰テスト。
 *
 * - Changes API が変化なしを返しても、未送信のローカル変更 / 未完了の初回同期があれば同期する
 * - foreground 復帰・kick では強制的に同期する
 * - モバイル回線で同期しない設定なら何もしない
 */

function makeFakeClient(opts?: {
	listChanges?: (
		token: string,
	) => Promise<{ changes: unknown[]; newStartPageToken?: string }>;
}) {
	return {
		getStartPageToken: vi.fn(async () => 'tok-start'),
		listChanges: vi.fn(
			opts?.listChanges ??
				(async (_token: string) => ({
					changes: [],
					newStartPageToken: 'tok-after',
				})),
		),
	} as unknown as DriveClient;
}

function makeRunner(pending: { value: boolean }) {
	return {
		sync: vi.fn(async () => {
			pending.value = false;
		}),
		hasPendingWork: vi.fn(async () => pending.value),
	} satisfies SyncRunner;
}

async function seedPageToken(token: string): Promise<void> {
	await writeAtomic(CHANGE_PAGE_TOKEN_PATH, JSON.stringify({ token }));
}

describe('PollingService: 同期を走らせる条件', () => {
	beforeEach(async () => {
		__setNetState({ isConnected: true, type: 'wifi' });
		__setAppState('active');
		await appSettings.update({ syncOnCellular: true });
	});

	afterEach(async () => {
		__setNetState({ isConnected: true, type: 'wifi' });
		__setAppState('active');
		await appSettings.update({ syncOnCellular: true });
	});

	it('クラウド変化なしでも、未送信の変更 / 未完了の初回同期があれば同期する', async () => {
		await seedPageToken('tok-existing');
		const client = makeFakeClient();
		const runner = makeRunner({ value: true });

		const polling = new PollingService(client, runner);
		await polling.start();
		await vi.waitFor(() => expect(runner.sync).toHaveBeenCalled(), {
			timeout: 1000,
		});
		await polling.stop();

		expect(client.listChanges).toHaveBeenCalled();
	});

	it('クラウド変化なし・未送信の変更なしなら同期しない', async () => {
		await seedPageToken('tok-existing');
		const client = makeFakeClient();
		const runner = makeRunner({ value: false });

		const polling = new PollingService(client, runner);
		await polling.start();
		await vi.waitFor(() => expect(client.listChanges).toHaveBeenCalled(), {
			timeout: 1000,
		});
		await polling.stop();

		expect(runner.sync).not.toHaveBeenCalled();
	});

	it('Changes API に変化があれば同期する', async () => {
		await seedPageToken('tok-existing');
		const client = makeFakeClient({
			listChanges: async () => ({
				changes: [{ fileId: 'x' }],
				newStartPageToken: 'tok-after',
			}),
		});
		const runner = makeRunner({ value: false });

		const polling = new PollingService(client, runner);
		await polling.start();
		await vi.waitFor(() => expect(runner.sync).toHaveBeenCalled(), {
			timeout: 1000,
		});
		await polling.stop();
	});

	it('background → active 復帰時は変化なしでも同期する', async () => {
		await seedPageToken('tok-existing');
		const client = makeFakeClient();
		const runner = makeRunner({ value: false });

		const polling = new PollingService(client, runner);
		await polling.start();
		await vi.waitFor(() => expect(client.listChanges).toHaveBeenCalled(), {
			timeout: 1000,
		});
		runner.sync.mockClear();

		__setAppState('background');
		await new Promise((resolve) => setTimeout(resolve, 50));
		__setAppState('active');

		await vi.waitFor(() => expect(runner.sync).toHaveBeenCalled(), {
			timeout: 1000,
		});
		await polling.stop();
	});

	it('kickDebounced は連続呼び出しを 1 回の同期にまとめる', async () => {
		await seedPageToken('tok-existing');
		const client = makeFakeClient();
		const runner = makeRunner({ value: false });

		const polling = new PollingService(client, runner);
		await polling.start();
		await vi.waitFor(() => expect(client.listChanges).toHaveBeenCalled(), {
			timeout: 1000,
		});
		runner.sync.mockClear();

		polling.kickDebounced(30);
		polling.kickDebounced(30);
		polling.kickDebounced(30);
		await vi.waitFor(() => expect(runner.sync).toHaveBeenCalledTimes(1), {
			timeout: 1000,
		});
		await new Promise((resolve) => setTimeout(resolve, 80));
		await polling.stop();

		expect(runner.sync).toHaveBeenCalledTimes(1);
	});

	it('syncOnCellular=false かつ cellular 接続なら同期しない', async () => {
		await appSettings.update({ syncOnCellular: false });
		__setNetState({ isConnected: true, type: 'cellular' });
		const client = makeFakeClient();
		const runner = makeRunner({ value: true });

		const polling = new PollingService(client, runner);
		await polling.start();
		await new Promise((resolve) => setTimeout(resolve, 100));
		await polling.stop();

		expect(client.getStartPageToken).not.toHaveBeenCalled();
		expect(runner.sync).not.toHaveBeenCalled();
	});
});
