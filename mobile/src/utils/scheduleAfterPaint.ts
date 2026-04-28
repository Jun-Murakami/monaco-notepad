/**
 * 描画フレーム完了後に task を実行する。RAF を二重に挟むことで「次の paint が
 * 終わった後」のタイミングまで遅延し、その後 setTimeout(0) でマイクロタスク
 * 順序を更に押し下げる。Optimistic UI の「画面更新は即時、永続化は後」を
 * 安全に分離するためのヘルパ。
 */
export function scheduleAfterPaint(task: () => void): void {
	if (typeof requestAnimationFrame === 'function') {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				setTimeout(task, 0);
			});
		});
		return;
	}
	setTimeout(task, 0);
}
