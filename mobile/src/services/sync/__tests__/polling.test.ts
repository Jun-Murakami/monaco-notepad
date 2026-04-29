import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appSettings } from '@/services/settings/appSettings';
import { writeAtomic } from '@/services/storage/atomicFile';
import { CHANGE_PAGE_TOKEN_PATH } from '@/services/storage/paths';
import { __setNetState } from '@/test/mocks/netinfo';
import { __setAppState } from '@/test/mocks/reactNative';
import type { DriveClient } from '../driveClient';
import type { DriveSyncService } from '../driveSyncService';
import type { SyncOrchestrator } from '../orchestrator';
import { PollingService } from '../polling';
import { SyncStateManager } from '../syncState';

/**
 * PollingService の resume 時挙動の回帰テスト。
 *
 * 主目的: Drive Changes API の伝播ラグで checkForChanges が false を返しても、
 * ローカルが dirty なら runSyncSafe を呼ぶ事の保証。
 * （これが無いと「途中 kill → 再起動 → 数分間 sync が動かず status は idle」になる）
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

function makeFakeDriveSync() {
	return {
		clearCache: vi.fn(),
	} as unknown as DriveSyncService;
}

async function seedPageToken(token: string): Promise<void> {
	await writeAtomic(CHANGE_PAGE_TOKEN_PATH, JSON.stringify({ token }));
}

describe('PollingService: local dirty triggers sync even when cloud unchanged', () => {
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

	it('cloud unchanged + localDirty=true なら runSyncSafe が呼ばれる (resume シナリオ)', async () => {
		// 永続済み pageToken を仕込み、初回 checkForChanges が listChanges を通り
		// changes=[] (cloud 未変化) を返すようにする。
		await seedPageToken('tok-existing');

		const client = makeFakeClient();
		const driveSync = makeFakeDriveSync();
		const state = new SyncStateManager();
		await state.load();
		// 前回 session で dirty を立てたまま終了した想定
		await state.markNoteDirty('a');

		const orchestrator = {
			syncNotes: vi.fn(async () => {
				// テスト内で dirty を消して無限ループを防ぐ
				const snap = await state.getDirtySnapshotWithRevision();
				await state.clearDirtyIfUnchanged(snap.revision, 'ts', {});
			}),
		} as unknown as SyncOrchestrator;

		const polling = new PollingService(client, driveSync, orchestrator, state);
		await polling.start();

		await vi.waitFor(
			() => {
				expect(orchestrator.syncNotes).toHaveBeenCalled();
			},
			{ timeout: 1000 },
		);

		await polling.stop();

		// listChanges が cloud unchanged (changes=[]) を返した状態で syncNotes が呼ばれた事
		expect(client.listChanges).toHaveBeenCalled();
		expect(orchestrator.syncNotes).toHaveBeenCalled();
	});

	it('cloud unchanged + localDirty=false + 既に sync 完了済み なら syncNotes は呼ばれず backoff', async () => {
		await seedPageToken('tok-existing');

		const client = makeFakeClient();
		const driveSync = makeFakeDriveSync();
		const state = new SyncStateManager();
		await state.load();
		// dirty なし、かつ「過去に少なくとも 1 度 sync を完了した」状態にする
		await state.updateSyncedState('2026-04-01T00:00:00Z', {});

		const orchestrator = {
			syncNotes: vi.fn(async () => {}),
		} as unknown as SyncOrchestrator;

		const polling = new PollingService(client, driveSync, orchestrator, state);
		await polling.start();

		await vi.waitFor(() => expect(client.listChanges).toHaveBeenCalled(), {
			timeout: 1000,
		});

		await polling.stop();

		// cloud unchanged & dirty=false & sync 経験あり なので syncNotes は呼ばれない
		expect(orchestrator.syncNotes).not.toHaveBeenCalled();
	});

	// ★ 実機再現: 初回 pull 中に kill → 再起動シナリオ。
	// pull は dirty を立てないため localDirty=false。Changes API も伝播ラグで false を返す。
	// neverSynced (= lastSyncedDriveTs が空) を判定軸にしないと sync が起動せず、
	// status は idle のまま放置される。
	it('cloud unchanged + localDirty=false でも lastSyncedDriveTs が空なら syncNotes が呼ばれる (初回 pull resume)', async () => {
		await seedPageToken('tok-existing');

		const client = makeFakeClient();
		const driveSync = makeFakeDriveSync();
		const state = new SyncStateManager();
		await state.load();
		// dirty 無し、updateSyncedState 未到達 (= 初回 sync が完了していない状態)

		const orchestrator = {
			syncNotes: vi.fn(async () => {
				// 完了したテイで lastSyncedDriveTs を埋め、無限ループを防ぐ
				await state.updateSyncedState('2026-04-01T00:00:00Z', {});
			}),
		} as unknown as SyncOrchestrator;

		const polling = new PollingService(client, driveSync, orchestrator, state);
		await polling.start();

		await vi.waitFor(
			() => {
				expect(orchestrator.syncNotes).toHaveBeenCalled();
			},
			{ timeout: 1000 },
		);

		await polling.stop();

		expect(client.listChanges).toHaveBeenCalled();
		expect(orchestrator.syncNotes).toHaveBeenCalled();
	});

	// ★ foreground 復帰時は Changes API の伝播ラグを待たずに強制 sync する。
	// background から active へ戻った瞬間に sync が呼ばれる事を保証する。
	it('background → active 復帰時は cloud unchanged + localDirty=false でも syncNotes が呼ばれる', async () => {
		await seedPageToken('tok-existing');

		const client = makeFakeClient();
		const driveSync = makeFakeDriveSync();
		const state = new SyncStateManager();
		await state.load();
		// dirty なし、sync 経験あり (= forceSync が無ければ syncNotes は呼ばれない条件)
		await state.updateSyncedState('2026-04-01T00:00:00Z', {});

		const orchestrator = {
			syncNotes: vi.fn(async () => {}),
		} as unknown as SyncOrchestrator;

		const polling = new PollingService(client, driveSync, orchestrator, state);
		await polling.start();

		// 初回サイクル (起動直後の即時 sync) を消化させてから
		// syncNotes 呼び出し回数をリセットし、background → active のみを観測する
		await vi.waitFor(() => expect(client.listChanges).toHaveBeenCalled(), {
			timeout: 1000,
		});
		(orchestrator.syncNotes as ReturnType<typeof vi.fn>).mockClear();

		__setAppState('background');
		// background 中はループが offline 待機に入る。少し待ってから active へ。
		await new Promise((resolve) => setTimeout(resolve, 50));
		__setAppState('active');

		await vi.waitFor(
			() => {
				expect(orchestrator.syncNotes).toHaveBeenCalled();
			},
			{ timeout: 1000 },
		);

		await polling.stop();
	});

	it('syncOnCellular=false かつ cellular 接続なら同期しない', async () => {
		await appSettings.update({ syncOnCellular: false });
		__setNetState({ isConnected: true, type: 'cellular' });

		const client = makeFakeClient();
		const driveSync = makeFakeDriveSync();
		const state = new SyncStateManager();
		await state.load();
		await state.markNoteDirty('a');

		const orchestrator = {
			syncNotes: vi.fn(async () => {}),
		} as unknown as SyncOrchestrator;

		const polling = new PollingService(client, driveSync, orchestrator, state);
		await polling.start();
		await new Promise((resolve) => setTimeout(resolve, 100));
		await polling.stop();

		expect(client.getStartPageToken).not.toHaveBeenCalled();
		expect(orchestrator.syncNotes).not.toHaveBeenCalled();
	});
});
