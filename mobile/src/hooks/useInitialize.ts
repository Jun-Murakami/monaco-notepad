import { useEffect, useState } from 'react';
import { applySavedLanguage } from '@/i18n';
import { authService } from '@/services/auth/authService';
import { driveService } from '@/services/sync/driveService';
import { syncStateManager } from '@/services/sync/syncState';
import { useAuthStore } from '@/stores/authStore';
import { useNotesStore } from '@/stores/notesStore';
// syncStore はモジュール読み込み時に syncEvents の購読を登録する。
// Drive 初期化中に emit される接続成功イベントを取りこぼさないよう、
// 画面表示前の初期化フック側で必ず先に読み込んでおく。
import '@/stores/syncStore';

/**
 * アプリ起動時にサービス層を初期化する。
 *
 * ★ 起動高速化のための原則:
 *   - ready=true までの critical path には**ネットワーク I/O を含めない**
 *     (Drive API は 1〜数秒かかり、ユーザー体感を著しく悪化させる)。
 *   - 互いに独立な load() は Promise.all で並列化する。
 *   - 重い後処理 (Drive 接続 / 孤立ノート復元) は ready=true 後に
 *     fire-and-forget で実行し、進捗は syncEvents で UI に伝える。
 *
 * これにより、5 秒前後かかっていた起動が 1 秒以下を目標になる。
 */
export function useInitialize(): { ready: boolean; error: Error | null } {
	const [ready, setReady] = useState(false);
	const [error, setError] = useState<Error | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				// i18n は他の処理と独立だが、UI 言語が決まらないうちに ready させたくない
				// ため最初に await する (~10ms と軽量)。
				await applySavedLanguage();

				// 互いに独立な load() を並列化。最遅の 1 件 (typically authService の
				// SecureStore 往復 ~300ms) で律速される。
				await Promise.all([
					useNotesStore.getState().loadAll(),
					syncStateManager.load(),
					authService.load(),
				]);

				// load 群が完了した状態で driveService.initialize() を呼ぶ。
				// 内部の load() は loaded フラグで no-op、operationQueue.init と
				// listener 登録だけ実行される。Drive API は呼ばれない。
				await driveService.initialize();
				if (cancelled) return;

				useAuthStore.setState({
					signedIn: authService.isSignedIn(),
					initializing: false,
				});
				setReady(true);

				// ready=true 後に Drive 接続と孤立復元を裏で実行。
				// 進捗は drive:status / drive:reauth-required イベントで UI に伝わる。
				driveService.startBackgroundWork();
			} catch (e) {
				if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	return { ready, error };
}
