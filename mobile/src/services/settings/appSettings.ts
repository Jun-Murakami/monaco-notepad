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
export type ThemePref = 'auto' | 'light' | 'dark';

/** ノート詳細ページ (本文ビュー / エディタ) の文字サイズ。px 単位。 */
export const EDITOR_FONT_SIZES = [12, 14, 16, 18, 20] as const;
export type EditorFontSize = (typeof EDITOR_FONT_SIZES)[number];

export interface AppSettings {
	language: LanguagePref;
	theme: ThemePref;
	syncOnCellular: boolean;
	conflictBackup: boolean;
	editorFontSize: EditorFontSize;
}

const DEFAULT_SETTINGS: AppSettings = {
	language: 'auto',
	theme: 'auto',
	syncOnCellular: true,
	conflictBackup: true,
	editorFontSize: 14,
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
		const previous = this.state;
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
		// useAppTheme などは起動直後、settings.json の非同期 load より先に
		// DEFAULT_SETTINGS を snapshot して購読を始める。load 後に通知しないと、
		// 設定画面は dark を表示しているのに PaperProvider だけ auto/light のまま
		// 取り残されるため、永続化済み設定を読み込んだタイミングでも通知する。
		if (!settingsEqual(previous, this.state)) {
			this.emit();
		}
	}

	snapshot(): Readonly<AppSettings> {
		return { ...this.state };
	}

	async update(patch: Partial<AppSettings>): Promise<void> {
		this.state = { ...this.state, ...patch };
		await writeAtomic(SETTINGS_PATH, JSON.stringify(this.state, null, 2));
		this.emit();
	}

	/** 端末データ削除後に、設定も初期値へ戻す（ファイルは再作成しない）。 */
	resetInMemory(): void {
		this.state = { ...DEFAULT_SETTINGS };
		this.loaded = true;
		this.emit();
	}

	private emit(): void {
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

function settingsEqual(a: AppSettings, b: AppSettings): boolean {
	return (
		a.language === b.language &&
		a.theme === b.theme &&
		a.syncOnCellular === b.syncOnCellular &&
		a.conflictBackup === b.conflictBackup &&
		a.editorFontSize === b.editorFontSize
	);
}
