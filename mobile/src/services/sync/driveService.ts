import { authService } from '../auth/authService';
import { noteService } from '../notes/noteService';
import { DriveClient } from './driveClient';
import { ensureDriveLayout } from './driveLayout';
import { DriveSyncService } from './driveSyncService';
import { syncEvents } from './events';
import { operationQueue } from './operationQueue';
import { SyncOrchestrator } from './orchestrator';
import { recoverCloudOrphans, recoverLocalOrphans } from './orphanRecovery';
import { PollingService } from './polling';
import { syncStateManager } from './syncState';
import type { Note } from './types';

/**
 * Drive 関連の全サービスを束ねるライフサイクルオーナ。
 * デスクトップ版 drive_service.go のエントリポイント相当。
 *
 * UI からはこのクラス経由で操作する（initialize/signIn/signOut/saveNote/kickSync）。
 */
class DriveService {
	private client: DriveClient | null = null;
	private driveSync: DriveSyncService | null = null;
	private orchestrator: SyncOrchestrator | null = null;
	private polling: PollingService | null = null;
	private initialized = false;

	async initialize(): Promise<void> {
		if (this.initialized) return;
		await syncStateManager.load();
		await noteService.load();
		await authService.load();

		// 操作キューの永続分を再開
		await operationQueue.init(async (item) => {
			// 初期段階では Drive サービス未接続だと失敗させてリスケさせる
			if (!this.driveSync || !this.orchestrator) {
				throw new Error('Drive not connected');
			}
			await this.executeQueuedOp(item.opType, item.mapKey, item.payload);
		});
		await operationQueue.start();

		// ローカル孤立復元は接続前でも実行可能
		await recoverLocalOrphans(noteService);

		if (authService.isSignedIn()) {
			await this.connect();
		}
		this.initialized = true;
	}

	async signIn(): Promise<void> {
		await authService.signIn();
		await this.connect();
	}

	async signOut(): Promise<void> {
		await this.polling?.stop();
		this.polling = null;
		this.orchestrator = null;
		this.driveSync = null;
		this.client = null;
		await authService.signOut();
		await syncStateManager.reset();
		syncEvents.emit('drive:disconnected', undefined);
	}

	/** UI 操作用: ノート保存トリガー。markDirty → push。 */
	async saveNoteAndSync(note: Note): Promise<void> {
		await noteService.saveNote(note);
		await syncStateManager.markNoteDirty(note.id);
		if (this.orchestrator) {
			try {
				await this.orchestrator.saveNoteAndUpdateList(note);
			} catch (e) {
				// 失敗はキューに残して後で再試行させる
				await operationQueue.enqueue('UPDATE', `note:${note.id}`, { noteId: note.id });
			}
		} else {
			// オフライン: キューに入れて後で実行
			await operationQueue.enqueue('UPDATE', `note:${note.id}`, { noteId: note.id });
		}
	}

	async deleteNoteAndSync(noteId: string): Promise<void> {
		await noteService.deleteNote(noteId);
		await syncStateManager.markNoteDeleted(noteId);
		await operationQueue.enqueue('DELETE', `note:${noteId}`, { noteId });
	}

	async kickSync(): Promise<void> {
		this.polling?.kick();
	}

	private async connect(): Promise<void> {
		this.client = new DriveClient(() => authService.getAccessToken());
		const layout = await ensureDriveLayout(this.client);
		this.driveSync = new DriveSyncService(this.client, layout);
		this.orchestrator = new SyncOrchestrator(this.driveSync, noteService, syncStateManager);

		// クラウド孤立復元（noteList 取得後）
		await this.driveSync.listNoteFiles();
		await recoverCloudOrphans(this.driveSync, noteService);

		this.polling = new PollingService(this.client, this.driveSync, this.orchestrator);
		await this.polling.start();
		operationQueue.wake();
		syncEvents.emit('drive:connected', undefined);
	}

	private async executeQueuedOp(
		opType: string,
		_mapKey: string,
		payload: unknown,
	): Promise<void> {
		if (!this.driveSync || !this.orchestrator) throw new Error('Drive not connected');
		const p = (payload ?? {}) as { noteId?: string };
		switch (opType) {
			case 'UPDATE':
			case 'CREATE': {
				if (!p.noteId) return;
				const note = await noteService.readNote(p.noteId);
				if (!note) return;
				await this.orchestrator.saveNoteAndUpdateList(note);
				return;
			}
			case 'DELETE': {
				if (!p.noteId) return;
				await this.driveSync.deleteNote(p.noteId);
				await syncStateManager.forgetNoteHash(p.noteId);
				return;
			}
			default:
				return;
		}
	}
}

export const driveService = new DriveService();
