import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authService } from '@/services/auth/authService';
import { __setNetState } from '@/test/mocks/netinfo';
import { __setAppState } from '@/test/mocks/reactNative';
import { DriveService } from '../driveService';

/**
 * DriveService の自動 reconnect 機構の回帰テスト。
 *
 * 検証対象: connect 失敗状態 (signedIn だが orchestrator が nil) のとき、
 * AppState 復帰 / NetInfo オンライン復帰を検知して自動で reconnect が
 * 走ることの保証。接続済み状態では PollingService 側に処理を譲る (no-op)。
 */

describe('DriveService auto reconnect listeners', () => {
	let svc: DriveService;

	beforeEach(() => {
		__setAppState('active');
		__setNetState({ isConnected: true, type: 'wifi' });
		// 既定で signedIn (個別テストで上書き)。
		vi.spyOn(authService, 'isSignedIn').mockReturnValue(true);
		svc = new DriveService();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('AppState background→active で reconnect が呼ばれる (未接続時)', () => {
		const reconnectSpy = vi
			.spyOn(svc, 'reconnect')
			.mockResolvedValue(undefined);
		// biome-ignore lint/suspicious/noExplicitAny: private method を直接叩く
		(svc as any).installResumeListeners();

		__setAppState('background');
		expect(reconnectSpy).not.toHaveBeenCalled();

		__setAppState('active');
		expect(reconnectSpy).toHaveBeenCalledTimes(1);
	});

	it('AppState 復帰でも orchestrator がある (=接続済み) なら reconnect は呼ばれない', () => {
		const reconnectSpy = vi
			.spyOn(svc, 'reconnect')
			.mockResolvedValue(undefined);
		// biome-ignore lint/suspicious/noExplicitAny: private 状態を直接設定
		(svc as any).installResumeListeners();
		// 接続済み状態をシミュレート
		// biome-ignore lint/suspicious/noExplicitAny: private 状態を直接設定
		(svc as any).orchestrator = {} as unknown;

		__setAppState('background');
		__setAppState('active');

		expect(reconnectSpy).not.toHaveBeenCalled();
	});

	it('未サインインなら AppState 復帰しても reconnect は呼ばれない', () => {
		vi.spyOn(authService, 'isSignedIn').mockReturnValue(false);
		const reconnectSpy = vi
			.spyOn(svc, 'reconnect')
			.mockResolvedValue(undefined);
		// biome-ignore lint/suspicious/noExplicitAny: private method
		(svc as any).installResumeListeners();

		__setAppState('background');
		__setAppState('active');

		expect(reconnectSpy).not.toHaveBeenCalled();
	});

	it('NetInfo offline→online で reconnect が呼ばれる', () => {
		const reconnectSpy = vi
			.spyOn(svc, 'reconnect')
			.mockResolvedValue(undefined);
		// biome-ignore lint/suspicious/noExplicitAny: private method
		(svc as any).installResumeListeners();

		// 1 回目の fire は seed 専用 (lastNetConnected が null から確定値へ)。
		__setNetState({ isConnected: false });
		expect(reconnectSpy).not.toHaveBeenCalled();

		// false→true の遷移で trigger
		__setNetState({ isConnected: true });
		expect(reconnectSpy).toHaveBeenCalledTimes(1);
	});

	it('NetInfo の初回 fire (online) は seed 専用で reconnect を呼ばない', () => {
		const reconnectSpy = vi
			.spyOn(svc, 'reconnect')
			.mockResolvedValue(undefined);
		// biome-ignore lint/suspicious/noExplicitAny: private method
		(svc as any).installResumeListeners();

		// 起動直後の online seed では起動時 connect と二重発火しないよう trigger しない。
		__setNetState({ isConnected: true });
		expect(reconnectSpy).not.toHaveBeenCalled();
	});

	it('NetInfo online→offline は reconnect を呼ばない (悪化方向)', () => {
		const reconnectSpy = vi
			.spyOn(svc, 'reconnect')
			.mockResolvedValue(undefined);
		// biome-ignore lint/suspicious/noExplicitAny: private method
		(svc as any).installResumeListeners();

		__setNetState({ isConnected: true }); // seed
		__setNetState({ isConnected: false }); // 悪化

		expect(reconnectSpy).not.toHaveBeenCalled();
	});

	it('NetInfo 復帰でも orchestrator がある (=接続済み) なら reconnect は呼ばれない', () => {
		const reconnectSpy = vi
			.spyOn(svc, 'reconnect')
			.mockResolvedValue(undefined);
		// biome-ignore lint/suspicious/noExplicitAny: private state
		(svc as any).installResumeListeners();
		// biome-ignore lint/suspicious/noExplicitAny: private state
		(svc as any).orchestrator = {} as unknown;

		__setNetState({ isConnected: false });
		__setNetState({ isConnected: true });

		expect(reconnectSpy).not.toHaveBeenCalled();
	});
});

describe('DriveService.reconnect dedup', () => {
	let svc: DriveService;

	beforeEach(() => {
		__setAppState('active');
		__setNetState({ isConnected: true, type: 'wifi' });
		vi.spyOn(authService, 'isSignedIn').mockReturnValue(true);
		svc = new DriveService();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('並行 reconnect 呼び出しは 1 回の connect しか走らせない', async () => {
		// 内部の connect を遅延 Promise でモックして、並行呼び出しが
		// 同じ in-flight reconnectPromise を共有することを確認する。
		let resolveConnect: () => void = () => {};
		const connectPromise = new Promise<void>((r) => {
			resolveConnect = r;
		});
		const connectSpy = vi
			// biome-ignore lint/suspicious/noExplicitAny: private method spy
			.spyOn(svc as any, 'connect')
			.mockImplementation(() => connectPromise);

		const p1 = svc.reconnect();
		const p2 = svc.reconnect();
		const p3 = svc.reconnect();

		resolveConnect();
		await Promise.all([p1, p2, p3]);

		// 3 回呼んでも実際の connect は 1 回しか走らない
		expect(connectSpy).toHaveBeenCalledTimes(1);
	});

	it('NetInfo が offline を返すなら connect を試みず即終了する', async () => {
		__setNetState({ isConnected: false, type: 'none' });
		// biome-ignore lint/suspicious/noExplicitAny: private method spy
		const connectSpy = vi.spyOn(svc as any, 'connect');

		await svc.reconnect();

		expect(connectSpy).not.toHaveBeenCalled();
	});

	it('未サインインなら reconnect は no-op', async () => {
		vi.spyOn(authService, 'isSignedIn').mockReturnValue(false);
		// biome-ignore lint/suspicious/noExplicitAny: private method spy
		const connectSpy = vi.spyOn(svc as any, 'connect');

		await svc.reconnect();

		expect(connectSpy).not.toHaveBeenCalled();
	});

	it('既に接続済み (orchestrator あり) なら reconnect は no-op', async () => {
		// biome-ignore lint/suspicious/noExplicitAny: private state
		(svc as any).orchestrator = {} as unknown;
		// biome-ignore lint/suspicious/noExplicitAny: private method spy
		const connectSpy = vi.spyOn(svc as any, 'connect');

		await svc.reconnect();

		expect(connectSpy).not.toHaveBeenCalled();
	});
});
