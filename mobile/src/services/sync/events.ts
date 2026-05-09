/**
 * 軽量なイベントバス。デスクトップ版の Wails EventsEmit 相当の役割を、
 * 同期レイヤー内部/UI 間通知のために提供する。
 */

type Handler<T> = (payload: T) => void;

export class EventEmitter<Events extends object> {
	private handlers: Partial<{
		[K in keyof Events]: Set<Handler<Events[K]>>;
	}> = {};

	on<K extends keyof Events>(
		event: K,
		handler: Handler<Events[K]>,
	): () => void {
		let set = this.handlers[event];
		if (!set) {
			set = new Set();
			this.handlers[event] = set;
		}
		set.add(handler);
		return () => {
			set?.delete(handler);
		};
	}

	off<K extends keyof Events>(event: K, handler: Handler<Events[K]>): void {
		this.handlers[event]?.delete(handler);
	}

	emit<K extends keyof Events>(event: K, payload: Events[K]): void {
		const set = this.handlers[event];
		if (!set) return;
		for (const handler of set) {
			try {
				handler(payload);
			} catch (e) {
				console.error(`[EventEmitter] handler for ${String(event)} threw:`, e);
			}
		}
	}
}

import type { MessageCodeValue, SyncPhase, SyncStatus } from './types';

/**
 * 「Drive 接続が切れたまま気付かない」事故を防ぐための再ログイン要求イベント。
 * デスクトップ版の `drive:reauth-required` (Wails event) と完全に同じセマンティクス。
 *
 * - "invalid_grant"   : refresh_token 失効/取り消し → 再ログイン必須
 * - "startup_failed"  : 起動時の保存トークン再接続失敗 (ネットワーク等の場合も含む)
 * - "polling_failed"  : ポーリング中の再接続が連続失敗 (AuthService 側の閾値)
 *
 * 同じオフラインセッション中の重複発火は authService 内部のフラグで抑止する。
 */
export type DriveReauthReason =
	| 'invalid_grant'
	| 'startup_failed'
	| 'polling_failed';

export interface SyncEvents {
	'drive:status': { status: SyncStatus };
	'drive:connected': undefined;
	'drive:disconnected': undefined;
	'drive:reconnected': undefined;
	'drive:reauth-required': { reason: DriveReauthReason; detail?: string };
	'notes:reload': undefined;
	'notes:updated': { noteId: string };
	'integrity:issues': { count: number };
	'sync:message': { code: MessageCodeValue; args?: Record<string, unknown> };
	'sync:error': { error: Error };
	/** 長時間操作の進捗。`current === total` または `total === 0` でクリア。 */
	'sync:progress': { current: number; total: number };
	/**
	 * 同期中の phase 通知。`status` が示す大枠の中で、UI が「何中なのか」を
	 * より具体的に出すため。`null` で phase 表示クリア。
	 */
	'sync:phase': { phase: SyncPhase };
}

export const syncEvents = new EventEmitter<SyncEvents>();
