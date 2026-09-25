import { NoteService } from '@/services/notes/noteService';
import { DriveClient } from '@/services/sync/driveClient';
import { ensureDriveLayout } from '@/services/sync/driveLayout';
import { DriveSyncService } from '@/services/sync/driveSyncService';
import { SyncOrchestrator } from '@/services/sync/orchestrator';
import { recoverCloudOrphans } from '@/services/sync/orphanRecovery';
import { SyncStateManager } from '@/services/sync/syncState';
import type { Note, NoteList } from '@/services/sync/types';
import type { FakeDrive } from './fakeDrive';

/**
 * シナリオテスト用のモバイル端末ファサード。
 *
 * UI (app/index.tsx の新規作成、app/note/[id].tsx の編集/離脱時 flush、
 * driveService.saveNoteAndSync) と同じ手順で同期レイヤーを操作する。
 * シナリオテストはこのファサードだけを使い、同期エンジンの内部 API に依存しない。
 */
export class MobileDevice {
	readonly notes = new NoteService();
	readonly state = new SyncStateManager();
	private orchestrator: SyncOrchestrator | null = null;
	private driveSync: DriveSyncService | null = null;

	constructor(
		private readonly drive: FakeDrive,
		readonly deviceId = 'mobile',
	) {}

	async boot(): Promise<void> {
		await this.state.load();
		await this.notes.load();
	}

	/** driveService.connect() 相当: レイアウト解決 → クラウド孤立復元。 */
	async connect(): Promise<void> {
		const client = new DriveClient(async () => this.deviceId);
		const layout = await ensureDriveLayout(client);
		this.driveSync = new DriveSyncService(client, layout);
		this.orchestrator = new SyncOrchestrator(
			this.driveSync,
			this.notes,
			this.state,
			{ enableConflictBackup: true },
		);
		await this.driveSync.listNoteFiles();
		await recoverCloudOrphans(this.driveSync, this.notes);
	}

	/** ポーリング 1 サイクル相当の同期。 */
	async sync(): Promise<void> {
		if (!this.orchestrator) throw new Error('not connected');
		await this.orchestrator.syncNotes();
	}

	/** 新規作成ボタン (index.tsx handleCreate) → エディタで本文入力 → 保存。 */
	async createNote(input: {
		id: string;
		title: string;
		content: string;
		language?: string;
	}): Promise<Note> {
		const created: Note = {
			id: input.id,
			title: '',
			content: '',
			contentHeader: '',
			language: input.language ?? 'markdown',
			modifiedTime: this.drive.now(),
			archived: false,
			folderId: '',
		};
		await this.notes.saveNote(created, { prependToOrder: true });
		await this.state.markNoteDirty(created.id);
		return this.editNote(input.id, { title: input.title, content: input.content });
	}

	/** エディタでの編集 → debounce 後の saveNoteAndSync。 */
	async editNote(
		id: string,
		patch: Partial<Pick<Note, 'title' | 'content' | 'language' | 'archived'>>,
	): Promise<Note> {
		const current = await this.notes.readNote(id);
		if (!current) throw new Error(`note ${id} not found on mobile`);
		const meta = this.notes.getNoteList().notes.find((n) => n.id === id);
		const next: Note = {
			...current,
			...patch,
			folderId: meta?.folderId ?? current.folderId,
			modifiedTime: this.drive.now(),
		};
		await this.saveNoteAndSync(next);
		return next;
	}

	/** ノートを開いて何も変えずに閉じる（エディタ unmount 時の flush）。 */
	async openAndClose(id: string): Promise<void> {
		const current = await this.notes.readNote(id);
		if (!current) throw new Error(`note ${id} not found on mobile`);
		await this.saveNoteAndSync(current);
	}

	/** オフライン編集（保存はするが Drive へは送らない）。 */
	async editNoteOffline(
		id: string,
		patch: Partial<Pick<Note, 'title' | 'content'>>,
	): Promise<void> {
		const current = await this.notes.readNote(id);
		if (!current) throw new Error(`note ${id} not found on mobile`);
		const meta = this.notes.getNoteList().notes.find((n) => n.id === id);
		await this.notes.saveNote({
			...current,
			...patch,
			folderId: meta?.folderId ?? current.folderId,
			modifiedTime: this.drive.now(),
		});
		await this.state.markNoteDirty(id);
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

	private async saveNoteAndSync(note: Note): Promise<void> {
		await this.notes.saveNote(note);
		await this.state.markNoteDirty(note.id);
		if (this.orchestrator) {
			await this.orchestrator.saveNoteAndUpdateList(note);
		}
	}
}
