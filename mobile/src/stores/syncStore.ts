import { create } from 'zustand';
import { syncEvents } from '@/services/sync/events';
import type { SyncStatus } from '@/services/sync/types';

interface SyncStoreState {
	status: SyncStatus;
	connected: boolean;
	lastMessage: string | null;
}

export const useSyncStore = create<SyncStoreState>(() => ({
	status: 'offline',
	connected: false,
	lastMessage: null,
}));

syncEvents.on('drive:status', ({ status }) => {
	useSyncStore.setState({ status });
});

syncEvents.on('drive:connected', () => {
	useSyncStore.setState({ connected: true, status: 'idle' });
});

syncEvents.on('drive:disconnected', () => {
	useSyncStore.setState({ connected: false, status: 'offline' });
});

syncEvents.on('drive:reconnected', () => {
	useSyncStore.setState({ connected: true, status: 'idle' });
});

syncEvents.on('sync:message', ({ code, args }) => {
	useSyncStore.setState({ lastMessage: args ? `${code}: ${JSON.stringify(args)}` : code });
});

syncEvents.on('sync:error', ({ error }) => {
	useSyncStore.setState({ status: 'error', lastMessage: error.message });
});
