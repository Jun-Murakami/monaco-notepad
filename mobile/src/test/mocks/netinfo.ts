/** @react-native-community/netinfo のテスト用スタブ。 */

export type NetInfoState = {
	isConnected: boolean;
	type?: string;
};

type Listener = (state: NetInfoState) => void;

let current: NetInfoState = { isConnected: true, type: 'wifi' };
const listeners = new Set<Listener>();

function addEventListener(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

async function fetch(): Promise<NetInfoState> {
	return current;
}

/** テスト用: 接続状態を切り替える。 */
export function __setNetState(state: NetInfoState): void {
	current = state;
	for (const l of listeners) l(state);
}

const api = { addEventListener, fetch };
export default api;
export { addEventListener, fetch };
