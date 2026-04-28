import { create } from 'zustand';
import { syncEvents } from '@/services/sync/events';
import type { SyncPhase, SyncStatus } from '@/services/sync/types';

interface SyncProgress {
	current: number;
	total: number;
}

interface SyncStoreState {
	status: SyncStatus;
	connected: boolean;
	lastMessage: string | null;
	progress: SyncProgress | null;
	/** status の中での具体的な phase。null = phase 情報なし (status のみ表示)。 */
	phase: SyncPhase;
}

export const useSyncStore = create<SyncStoreState>(() => ({
	status: 'offline',
	connected: false,
	lastMessage: null,
	progress: null,
	phase: null,
}));

syncEvents.on('drive:status', ({ status }) => {
	// idle / offline / error に戻ったら phase もクリアする (古い phase が
	// 残ったまま「同期済み」と一緒に表示されるのを防ぐ)。
	if (status === 'idle' || status === 'offline' || status === 'error') {
		useSyncStore.setState({ status, phase: null, progress: null });
	} else {
		useSyncStore.setState({ status });
	}
});

syncEvents.on('drive:connected', () => {
	useSyncStore.setState({ connected: true, status: 'idle', phase: null });
});

syncEvents.on('drive:disconnected', () => {
	useSyncStore.setState({
		connected: false,
		status: 'offline',
		phase: null,
		progress: null,
	});
});

syncEvents.on('drive:reconnected', () => {
	useSyncStore.setState({ connected: true, status: 'idle', phase: null });
});

syncEvents.on('sync:phase', ({ phase }) => {
	useSyncStore.setState({ phase });
});

syncEvents.on('sync:message', ({ code, args }) => {
	useSyncStore.setState({
		lastMessage: args ? `${code}: ${JSON.stringify(args)}` : code,
	});
});

syncEvents.on('sync:error', ({ error }) => {
	useSyncStore.setState({ status: 'error', lastMessage: error.message });
});

syncEvents.on('sync:progress', ({ current, total }) => {
	if (total === 0 || current >= total) {
		useSyncStore.setState({ progress: null });
	} else {
		useSyncStore.setState({ progress: { current, total } });
	}
});
