import { create } from 'zustand';
import { noteService } from '@/services/notes/noteService';
import { syncEvents } from '@/services/sync/events';
import type { Note, NoteList, NoteMetadata } from '@/services/sync/types';

interface NotesStoreState {
	noteList: NoteList;
	loading: boolean;
	loadAll: () => Promise<void>;
	reload: () => Promise<void>;
	getNote: (id: string) => Promise<Note | null>;
	getMetadata: (id: string) => NoteMetadata | null;
}

export const useNotesStore = create<NotesStoreState>((set, get) => ({
	noteList: {
		version: 'v2',
		notes: [],
		folders: [],
		topLevelOrder: [],
		archivedTopLevelOrder: [],
		collapsedFolderIds: [],
	},
	loading: true,

	loadAll: async () => {
		await noteService.load();
		set({ noteList: noteService.getNoteList(), loading: false });
	},

	reload: async () => {
		set({ noteList: noteService.getNoteList() });
	},

	getNote: (id: string) => noteService.readNote(id),

	getMetadata: (id: string) => get().noteList.notes.find((n) => n.id === id) ?? null,
}));

// 同期側からの reload 通知で自動更新
syncEvents.on('notes:reload', () => {
	useNotesStore.getState().reload();
});
