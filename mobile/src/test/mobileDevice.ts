import { NoteService } from '@/services/notes/noteService';
import { storagePaths } from '@/services/storage/paths';
import { DriveClient } from '@/services/sync/driveClient';
import { DriveGateway, type RetryPolicy } from '@/services/sync/driveGateway';
import {
	createNoteLocally,
	deleteNoteLocally,
	saveNoteLocally,
} from '@/services/sync/localActions';
import { SyncBaseStore } from '@/services/sync/syncBase';
import { SyncEngine, type SyncReport } from '@/services/sync/syncEngine';
import { SyncStateManager } from '@/services/sync/syncState';
import type { ConflictBackupKind, Note, NoteList } from '@/services/sync/types';
import type { FakeDrive } from './fakeDrive';

/** テストでは待たずに即失敗させ、エンジン側の「次サイクルで再試行」を検証する。 */
export const NO_RETRY: RetryPolicy = {
	list: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
	download: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
	upload: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
	other: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
};

/**
 * シナリオテスト用のモバイル端末ファサード。
 *
 * UI (app/index.tsx の新規作成、app/note/[id].tsx の編集/離脱時 flush、driveService の保存経路)
 * と同じ手順（localActions）でローカルを操作し、アプリと同様に保存後に同期を走らせる。
 * 端末ごとに別のストレージを持つので、複数台を 1 プロセスで動かせる。
 * シナリオテストはこのファサードだけを使い、同期エンジンの内部 API に依存しない。
 */
export class MobileDevice {
	readonly notes: NoteService;
	readonly state: SyncStateManager;
	readonly baseStore: SyncBaseStore;
	readonly backups: Array<{ kind: ConflictBackupKind; note: Note }> = [];
	lastReport: SyncReport | null = null;
	private engine: SyncEngine | null = null;

	constructor(
		private readonly drive: FakeDrive,
		readonly deviceId = 'mobile',
	) {
		const paths = storagePaths(`/mem/devices/${deviceId}/monaco-notepad/`);
		this.notes = new NoteService(paths);
		this.state = new SyncStateManager(paths.syncStatePath);
		this.baseStore = new SyncBaseStore(paths.syncBasePath);
	}

	async boot(): Promise<void> {
		await this.state.load();
		await this.notes.load();
	}

	/** driveService.connect() 相当（起動時の孤立ファイル取り込み + エンジン構築）。 */
	async connect(): Promise<void> {
		await this.notes.adoptOrphanNotes();
		const client = new DriveClient(async () => this.deviceId);
		this.engine = new SyncEngine(
			new DriveGateway(client, NO_RETRY),
			this.notes,
			this.state,
			this.baseStore,
			{
				backup: async (kind, note) => {
					this.backups.push({ kind, note });
				},
			},
		);
	}

	/** ポーリング 1 サイクル相当の同期。 */
	async sync(): Promise<SyncReport> {
		if (!this.engine) throw new Error('not connected');
		this.lastReport = await this.engine.sync();
		return this.lastReport;
	}

	/** 同期が必要な状態か（ポーリングのゲート）。 */
	async hasPendingWork(): Promise<boolean> {
		if (!this.engine) throw new Error('not connected');
		return this.engine.hasPendingWork();
	}

	/** 新規作成ボタン (index.tsx handleCreate) → エディタで本文入力 → 保存 → 同期。 */
	async createNote(input: {
		id: string;
		title: string;
		content: string;
		language?: string;
	}): Promise<Note> {
		const note = await this.createNoteOffline(input);
		if (this.engine) await this.sync();
		return note;
	}

	/** 新規作成（オフライン: 保存はするが同期しない）。 */
	async createNoteOffline(input: {
		id: string;
		title: string;
		content: string;
		language?: string;
	}): Promise<Note> {
		await createNoteLocally(this.notes, this.state, {
			id: input.id,
			title: '',
			content: '',
			contentHeader: '',
			language: input.language ?? 'markdown',
			modifiedTime: this.drive.now(),
			archived: false,
			folderId: '',
		});
		return this.editNoteOffline(input.id, {
			title: input.title,
			content: input.content,
		});
	}

	/** エディタでの編集 → debounce 後の保存 → 同期。 */
	async editNote(
		id: string,
		patch: Partial<Pick<Note, 'title' | 'content' | 'language' | 'archived'>>,
	): Promise<Note> {
		const next = await this.editNoteOffline(id, patch);
		if (this.engine) await this.sync();
		return next;
	}

	/** ノートを開いて何も変えずに閉じる（エディタ unmount 時の flush → 同期）。 */
	async openAndClose(id: string): Promise<void> {
		const current = await this.notes.readNote(id);
		if (!current) throw new Error(`note ${id} not found on ${this.deviceId}`);
		await saveNoteLocally(this.notes, this.state, current);
		if (this.engine) await this.sync();
	}

	/** オフライン編集（保存はするが同期しない）。 */
	async editNoteOffline(
		id: string,
		patch: Partial<Pick<Note, 'title' | 'content' | 'language' | 'archived'>>,
	): Promise<Note> {
		const current = await this.notes.readNote(id);
		if (!current) throw new Error(`note ${id} not found on ${this.deviceId}`);
		const next: Note = { ...current, ...patch, modifiedTime: this.drive.now() };
		await saveNoteLocally(this.notes, this.state, next);
		return next;
	}

	async deleteNoteOffline(id: string): Promise<void> {
		await deleteNoteLocally(this.notes, this.state, id);
	}

	/** 並び替え（ドラッグ）: トップレベル順を置き換える。 */
	async reorderTopLevel(order: NoteList['topLevelOrder']): Promise<void> {
		const list = this.notes.getNoteList();
		list.topLevelOrder = order;
		await this.notes.replaceNoteList(list, { preserveExtras: true });
		await this.state.markDirty();
	}

	/** ノートをフォルダへ移動（長押し → フォルダ選択）。 */
	async moveNoteToFolder(noteId: string, folderId: string): Promise<void> {
		const list = this.notes.getNoteList();
		const meta = list.notes.find((n) => n.id === noteId);
		if (!meta) throw new Error(`note ${noteId} not found on ${this.deviceId}`);
		meta.folderId = folderId;
		list.topLevelOrder = list.topLevelOrder.filter(
			(i) => !(i.type === 'note' && i.id === noteId),
		);
		if (!folderId) list.topLevelOrder.unshift({ type: 'note', id: noteId });
		await this.notes.replaceNoteList(list, { preserveExtras: true });
		await this.state.markNoteDirty(noteId);
		await this.state.markDirty();
	}

	async createFolder(name: string): Promise<string> {
		const folder = await this.notes.createFolder(name);
		await this.state.markDirty();
		return folder.id;
	}

	/**
	 * アーカイブ / 復元（UI と同じ setNoteArchived）。本番は端末の時計で modifiedTime を入れるが、
	 * テストでは「最新の編集が勝つ」を検証できるよう論理時計で打ち直す。
	 */
	async setArchived(id: string, archived: boolean): Promise<Note> {
		await this.notes.setNoteArchived(id, archived);
		const note = await this.notes.readNote(id);
		if (!note) throw new Error(`note ${id} not found on ${this.deviceId}`);
		const stamped = { ...note, modifiedTime: this.drive.now() };
		await saveNoteLocally(this.notes, this.state, stamped);
		return stamped;
	}

	list(): NoteList {
		return this.notes.getNoteList();
	}

	async readNote(id: string): Promise<Note | null> {
		return this.notes.readNote(id);
	}

	/** トップレベル表示順（ノート ID のみ）。 */
	topLevelNoteIds(): string[] {
		return this.list()
			.topLevelOrder.filter((i) => i.type === 'note')
			.map((i) => i.id);
	}

	folderOf(noteId: string): string | undefined {
		return this.list().notes.find((n) => n.id === noteId)?.folderId;
	}

	folderNamed(name: string): string | undefined {
		return this.list().folders.find((f) => f.name === name)?.id;
	}
}
