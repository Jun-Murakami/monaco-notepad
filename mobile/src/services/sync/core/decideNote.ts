/**
 * ノート単位の同期判定（docs/sync-engine-v3.md §6）。純粋関数。
 *
 * - `downloaded` を与えない呼び出しがフェーズ1。判定にリモート本文が必要なら `download` を返す。
 * - ダウンロード後、`downloaded` を与えて再度呼ぶのがフェーズ2（`download` は返さない）。
 *
 * Go 版 backend/sync_core.go の decideNote と完全一致させること（共有ベクターで検証）。
 */

import {
	knownSkippedVersions,
	skippedVersionsContain,
	type VersionRange,
} from './skippedVersions';

export interface DecideNoteInput {
	/** ローカルに存在する（本体ファイルが読める）場合の状態。 */
	local?: { hash: string; modifiedTime: string };
	/** ユーザー操作で削除が記録されている（deletedNoteIDs）。 */
	localDeleted: boolean;
	/**
	 * 前回同期時点の状態。md5 / fileId / version（Drive の版番号）は移行直後などで欠けうる。
	 */
	base?: { hash: string; md5?: string; fileId?: string; version?: number };
	/** Drive に本体ファイルがある場合の md5 / ファイル ID / 版番号（一覧で分かる値）。 */
	remote?: { md5: string; fileId?: string; version?: number };
	/**
	 * フェーズ2でのみ与えるダウンロード結果。parentVersion は書いた端末が置き換えた Drive の版番号
	 * （= その端末が見ていた版。旧クライアントの書き込みには無い）。
	 */
	downloaded?: {
		hash: string;
		modifiedTime: string;
		parentVersion?: number;
		/** 本体の syncSkipped（履歴の中で見ずに上書きされた版番号の範囲）。 */
		skipped?: VersionRange[];
	};
}

export type NoteDecision =
	| { kind: 'none' }
	| { kind: 'download' }
	/** backupRemote: 真の競合でローカルが勝った。負けたリモートの版を勝った端末に残す。 */
	| { kind: 'upload'; backupRemote?: boolean }
	| { kind: 'applyRemote'; backupLocal: boolean }
	| { kind: 'deleteLocal'; backupLocal: boolean }
	| { kind: 'deleteRemote' }
	| { kind: 'forget' };

export function decideNote(input: DecideNoteInput): NoteDecision {
	const { local, localDeleted, base, remote, downloaded } = input;

	if (!local) {
		if (localDeleted) {
			if (!remote) return { kind: 'forget' };
			if (!base) return { kind: 'deleteRemote' };
			if (base.md5 && remote.md5 === base.md5) return { kind: 'deleteRemote' };
			if (!downloaded) return { kind: 'download' };
			// 編集は削除に勝つ（P4）: 相手が編集していたら削除を取り消して復元する
			return downloaded.hash === base.hash
				? { kind: 'deleteRemote' }
				: { kind: 'applyRemote', backupLocal: false };
		}
		if (remote) {
			return downloaded
				? { kind: 'applyRemote', backupLocal: false }
				: { kind: 'download' };
		}
		return { kind: 'forget' };
	}

	if (!remote) {
		// 新規 or ローカル編集あり → 編集は削除に勝つ
		if (!base || local.hash !== base.hash) return { kind: 'upload' };
		return { kind: 'deleteLocal', backupLocal: true };
	}

	if (base?.md5 && remote.md5 === base.md5) {
		return local.hash === base.hash ? { kind: 'none' } : { kind: 'upload' };
	}

	if (!downloaded) return { kind: 'download' };
	if (downloaded.hash === local.hash) return { kind: 'none' };

	const localChanged = !base || local.hash !== base.hash;
	if (!localChanged) {
		// ファイルが作り直されている = 一度削除され、編集が勝って復元された（P4）。削除より後の出来事なので
		// 時刻にかかわらず取り込む。手元の版は削除されたもので、他端末でのリモート削除と同じく残しておく。
		if (base?.fileId && remote.fileId && base.fileId !== remote.fileId) {
			return { kind: 'applyRemote', backupLocal: true };
		}
		// 同じファイルなのに手元（未変更）よりリモートの方が古い = 別端末が古い判断で上書きした
		// （ノート本体の lost update）。最新の版（手元）を送り直し、上書きしてきた版は残す
		// （その端末のユーザーは手元の版を見ずに編集したので、黙って捨てない）。
		if (isModifiedTimeAfter(local.modifiedTime, downloaded.modifiedTime)) {
			return { kind: 'upload', backupRemote: true };
		}
		// リモートの方が新しい = 通常は更新として取り込むだけ。ただし手元の版が、リモートの版の履歴の中で
		// 見ずに上書きされていれば（同期の入れ違い。何段重なっていても syncSkipped に残る）、手元の版も残す。
		// 勝敗は変えず（新しい方が勝つ）、バックアップを増やすだけに使う。
		const seen = base?.version ?? 0;
		const skipped = knownSkippedVersions(
			downloaded.skipped ?? [],
			downloaded.parentVersion ?? 0,
			remote.version ?? 0,
		);
		return {
			kind: 'applyRemote',
			backupLocal: seen > 0 && skippedVersionsContain(skipped, seen),
		};
	}
	// md5 だけ変わって中身は base のまま（別端末の再シリアライズ）→ ローカルの変更を送る
	if (base && downloaded.hash === base.hash) return { kind: 'upload' };
	return isModifiedTimeAfter(local.modifiedTime, downloaded.modifiedTime)
		? { kind: 'upload', backupRemote: true }
		: { kind: 'applyRemote', backupLocal: true };
}

/**
 * a が b より新しいか。両方 RFC3339 として解析できれば時刻で比較し、
 * できなければ文字列比較にフォールバックする。同時刻は false（= リモート勝ち）。
 */
export function isModifiedTimeAfter(a: string, b: string): boolean {
	const ta = parseRfc3339(a);
	const tb = parseRfc3339(b);
	if (ta !== null && tb !== null) return ta > tb;
	return a > b;
}

// Go の time.Parse(time.RFC3339, ...) が受け付ける形に揃える（T / Z は大文字のみ）
const RFC3339 =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function parseRfc3339(value: string): number | null {
	if (!RFC3339.test(value)) return null;
	const t = Date.parse(value);
	return Number.isNaN(t) ? null : t;
}
