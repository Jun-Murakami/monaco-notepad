/**
 * 見ずに上書きされた Drive の版番号の範囲（docs/sync-engine-v3.md §6）。
 * デスクトップ版 backend/sync_core.go の同名関数と 1:1（sync-spec/vectors/skipped-versions.json で検証）。
 *
 * ノート本体の書き込みは、置き換えた版番号（syncParentVersion）と、履歴の中で見ずに上書きされた版番号の
 * 範囲（syncSkipped）を持つ。自分の版番号がこの範囲に入っていれば、その版は誰にも見られずに消えている。
 */

/** [from, to]（両端を含む）。 */
export type VersionRange = [number, number];

/** 本体に持たせる範囲の上限。超えたら番号の小さい（古い）方から捨てる。 */
export const MAX_SKIPPED_VERSION_RANGES = 32;

/** 不正な範囲を除き、昇順に並べて重なり・隣接をまとめ、上限を超えた古い範囲を捨てる。 */
export function normalizeSkippedVersions(
	ranges: readonly (readonly number[])[],
): VersionRange[] {
	const valid = ranges
		.filter(
			(r) =>
				r.length === 2 &&
				Number.isSafeInteger(r[0]) &&
				Number.isSafeInteger(r[1]) &&
				r[0] >= 1 &&
				r[0] <= r[1],
		)
		.map((r): VersionRange => [r[0], r[1]])
		.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const merged: VersionRange[] = [];
	for (const r of valid) {
		const last = merged[merged.length - 1];
		if (last && r[0] <= last[1] + 1) {
			last[1] = Math.max(last[1], r[1]);
		} else {
			merged.push([r[0], r[1]]);
		}
	}
	return merged.slice(-MAX_SKIPPED_VERSION_RANGES);
}

/**
 * ある版の「履歴の中で見ずに上書きされた版番号」: 本体の syncSkipped に、その版自身が見ずに上書きした
 * 範囲 (parentVersion, version)（両端を含まない）を加えたもの。parentVersion が 0（旧クライアントの書き込み）
 * なら加えない。version が 0（不明）なら上端を決められないので、parentVersion より後をすべて含める。
 */
export function knownSkippedVersions(
	skipped: readonly (readonly number[])[],
	parentVersion: number,
	version: number,
): VersionRange[] {
	const ranges: (readonly number[])[] = [...skipped];
	if (parentVersion > 0) {
		const upper = version > 0 ? version - 1 : Number.MAX_SAFE_INTEGER;
		if (upper >= parentVersion + 1) ranges.push([parentVersion + 1, upper]);
	}
	return normalizeSkippedVersions(ranges);
}

export function skippedVersionsContain(
	ranges: readonly (readonly number[])[],
	version: number,
): boolean {
	return ranges.some((r) => r[0] <= version && version <= r[1]);
}
