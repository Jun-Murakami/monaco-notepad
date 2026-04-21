import { ensureDir, readString, writeAtomic } from '../storage/atomicFile';
import { APP_DATA_DIR, SETTINGS_PATH } from '../storage/paths';

/**
 * アプリ全体の設定永続化。
 *
 * デスクトップ版 settings_service.go に相当。SyncStateManager / NoteService と同じく
 * atomicFile で永続化し、シングルトンとして使い回す。
 *
 * スキーマ追加時は必ず default を増やすこと（古い settings.json との前方互換を保つため）。
 */

export type LanguagePref = 'auto' | 'ja' | 'en';

export interface AppSettings {
	language: LanguagePref;
	syncOnCellular: boolean;
	conflictBackup: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
	language: 'auto',
	syncOnCellular: true,
	conflictBackup: true,
};

type Listener = (settings: AppSettings) => void;

class AppSettingsStore {
	private state: AppSettings = { ...DEFAULT_SETTINGS };
	private loaded = false;
	private listeners = new Set<Listener>();

	async load(): Promise<void> {
		if (this.loaded) return;
		await ensureDir(APP_DATA_DIR);
		const raw = await readString(SETTINGS_PATH);
		if (raw) {
			try {
				const parsed = JSON.parse(raw) as Partial<AppSettings>;
				this.state = { ...DEFAULT_SETTINGS, ...parsed };
			} catch (e) {
				console.warn(
					'[AppSettings] failed to parse settings.json, resetting',
					e,
				);
				this.state = { ...DEFAULT_SETTINGS };
			}
		}
		this.loaded = true;
	}

	snapshot(): Readonly<AppSettings> {
		return { ...this.state };
	}

	async update(patch: Partial<AppSettings>): Promise<void> {
		this.state = { ...this.state, ...patch };
		await writeAtomic(SETTINGS_PATH, JSON.stringify(this.state, null, 2));
		for (const l of this.listeners) {
			try {
				l(this.state);
			} catch (e) {
				console.warn('[AppSettings] listener failed:', e);
			}
		}
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

export const appSettings = new AppSettingsStore();
