import { useEffect, useState } from 'react';

/**
 * リストが空のとき empty placeholder を表示するか判定する hook。
 *
 * `isEmpty` が true になっても **すぐに** 真を返さず、`delayMs` 経過後にようやく
 * 真を返す。途中で `isEmpty` が false に戻れば真にしない。これにより、
 * 同期/状態更新の途中で一瞬リストが空になる「empty placeholder のチラつき」を
 * 防ぐ。`isEmpty` が false なら即座に false。
 *
 * - 起動直後は即座に (delay 0 で) 判定するため `delayMs=0` 相当扱い。
 * - 一度 true になった後 false に戻ると、また `delayMs` 経過しないと
 *   true に戻らない。
 */
export function useDeferredEmpty(isEmpty: boolean, delayMs = 250): boolean {
	const [show, setShow] = useState(isEmpty);
	useEffect(() => {
		if (!isEmpty) {
			setShow(false);
			return;
		}
		const timer = setTimeout(() => setShow(true), delayMs);
		return () => clearTimeout(timer);
	}, [isEmpty, delayMs]);
	return show;
}
