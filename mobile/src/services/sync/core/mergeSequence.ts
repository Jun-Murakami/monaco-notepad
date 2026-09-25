/**
 * 順序の 3-way マージ（docs/sync-engine-v3.md §7.2）。
 *
 * - 結果はリモートの順序を土台にする（相手の並び替え・追加・削除を取り込む）。
 * - base にあってローカルに無いキーは、ローカルで除いた（削除 or 別の列へ移動）ので除く。
 * - LCS(base, local) に含まれないローカルのキーは「ローカルで追加・移動したもの」なので、
 *   ローカル上で手前にある最初のキー（結果に存在するもの）の直後へ入れ直す。無ければ先頭。
 * - base が null（移行直後など）のときは local ∩ remote（local の順）を base とみなす。
 *
 * Go 版 backend/sync_core.go の mergeSequence と完全一致させること（共有ベクターで検証）。
 */
export function mergeSequence(
	base: readonly string[] | null,
	local: readonly string[],
	remote: readonly string[],
): string[] {
	const localUnique = dedupe(local);
	const remoteUnique = dedupe(remote);
	const baseUnique =
		base === null
			? localUnique.filter((k) => remoteUnique.includes(k))
			: dedupe(base);

	const localSet = new Set(localUnique);
	const result = remoteUnique.filter(
		(k) => !(baseUnique.includes(k) && !localSet.has(k)),
	);

	const stable = new Set(lcs(baseUnique, localUnique));
	for (let j = 0; j < localUnique.length; j++) {
		const key = localUnique[j];
		if (stable.has(key)) continue;
		const existing = result.indexOf(key);
		if (existing >= 0) result.splice(existing, 1);
		let insertAt = 0;
		for (let p = j - 1; p >= 0; p--) {
			const anchor = result.indexOf(localUnique[p]);
			if (anchor >= 0) {
				insertAt = anchor + 1;
				break;
			}
		}
		result.splice(insertAt, 0, key);
	}
	return result;
}

function dedupe(keys: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const k of keys) {
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(k);
	}
	return out;
}

/** 決定的な LCS（接尾辞 DP、同長のときは base 側を進める）。 */
function lcs(a: readonly string[], b: readonly string[]): string[] {
	const n = a.length;
	const m = b.length;
	const table: number[][] = Array.from({ length: n + 1 }, () =>
		new Array<number>(m + 1).fill(0),
	);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i][j] =
				a[i] === b[j]
					? table[i + 1][j + 1] + 1
					: Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}
	const out: string[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push(a[i]);
			i++;
			j++;
		} else if (table[i + 1][j] >= table[i][j + 1]) {
			i++;
		} else {
			j++;
		}
	}
	return out;
}
