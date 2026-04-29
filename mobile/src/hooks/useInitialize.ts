import { useEffect, useState } from 'react';
import { applySavedLanguage } from '@/i18n';
import { authService } from '@/services/auth/authService';
import { driveService } from '@/services/sync/driveService';
import { useAuthStore } from '@/stores/authStore';
import { useNotesStore } from '@/stores/notesStore';
// syncStore はモジュール読み込み時に syncEvents の購読を登録する。
// Drive 初期化中に emit される接続成功イベントを取りこぼさないよう、
// 画面表示前の初期化フック側で必ず先に読み込んでおく。
import '@/stores/syncStore';

/**
 * アプリ起動時にサービス層を初期化する。
 * - NoteService / SyncStateManager / AuthService を load
 * - 操作キュー起動
 * - サインイン済みなら Drive 接続 + ポーリング開始
 */
export function useInitialize(): { ready: boolean; error: Error | null } {
	const [ready, setReady] = useState(false);
	const [error, setError] = useState<Error | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				await applySavedLanguage();
				await useNotesStore.getState().loadAll();
				await driveService.initialize();
				if (cancelled) return;
				useAuthStore.setState({
					signedIn: authService.isSignedIn(),
					initializing: false,
				});
				setReady(true);
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
