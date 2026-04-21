/**
 * react-native のテスト用最小スタブ。
 * 同期レイヤーが必要とするのは AppState と Platform のみ。
 */

type AppStateStatus = 'active' | 'background' | 'inactive' | 'unknown';

type Listener = (state: AppStateStatus) => void;

const listeners = new Set<Listener>();
let current: AppStateStatus = 'active';

export const AppState = {
	get currentState(): AppStateStatus {
		return current;
	},
	addEventListener(_event: 'change', listener: Listener) {
		listeners.add(listener);
		return {
			remove() {
				listeners.delete(listener);
			},
		};
	},
};

/** テスト用: AppState を切り替える。 */
export function __setAppState(state: AppStateStatus): void {
	current = state;
	for (const l of listeners) l(state);
}

export const Platform = {
	OS: 'ios' as 'ios' | 'android' | 'web',
	select: <T>(opts: { ios?: T; android?: T; default?: T }): T | undefined =>
		opts.ios ?? opts.default,
};

export default { AppState, Platform };
