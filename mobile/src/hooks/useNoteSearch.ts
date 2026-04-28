import { useEffect, useMemo, useState } from 'react';
import { noteService } from '@/services/notes/noteService';
import type { NoteMetadata } from '@/services/sync/types';

/**
 * 全ノートの本文を含む全文検索インデックス。
 *
 * - module-level の Map で **メイン画面 / アーカイブ画面で共有**。
 *   ユーザーがどちらの画面で検索を開いても初回ビルド以降は再利用される。
 * - エントリは `{ noteId: { hash, lowercaseText } }`。`hash` はメタデータの
 *   `contentHash` をそのまま使い、本文に変更があれば ID 単位で再読込する。
 * - 削除されたノートは refresh 時に cache から落とす。
 */
interface IndexEntry {
	hash: string;
	text: string;
}

const sharedIndex = new Map<string, IndexEntry>();

/**
 * 単純な setTimeout ベースの debounce 値。`useDebounce` がプロジェクト内に
 * 無いので、検索専用にここで完結させる。
 */
function useDebounced<T>(value: T, delayMs: number): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const id = setTimeout(() => setDebounced(value), delayMs);
		return () => clearTimeout(id);
	}, [value, delayMs]);
	return debounced;
}

interface UseNoteSearchReturn {
	active: boolean;
	query: string;
	matchingIds: Set<string> | null;
	isIndexing: boolean;
	open: () => void;
	close: () => void;
	setQuery: (q: string) => void;
}

/**
 * 検索 UI 用の state + index 管理をまとめた hook。
 *
 * 戻り値の `matchingIds`:
 * - `null`: フィルタ無し (検索 inactive または query 空) → 全件表示
 * - `Set<string>`: 一致したノート ID 集合 → このセットでフィルタする
 *
 * @param notes 検索対象のメタデータ配列 (通常 `noteList.notes`)
 * @param debounceMs 入力 → 実行までのディレイ。既定 250ms。
 */
export function useNoteSearch(
	notes: NoteMetadata[],
	debounceMs = 250,
): UseNoteSearchReturn {
	const [active, setActive] = useState(false);
	const [query, setQuery] = useState('');
	const [isIndexing, setIsIndexing] = useState(false);
	// 検索 active のあいだに index が更新されたら matchingIds の useMemo を
	// 再評価させたいので、refresh 完了ごとに bump する版数。
	const [indexRevision, setIndexRevision] = useState(0);

	const debouncedQuery = useDebounced(query, debounceMs);

	// active の間だけ index を refresh する。本文ファイル読み込みは contentHash が
	// 一致しているノートはスキップするので、2 回目以降は変更ノートのみ。
	useEffect(() => {
		if (!active) return;
		let cancelled = false;
		setIsIndexing(true);
		(async () => {
			const currentIds = new Set(notes.map((n) => n.id));
			for (const id of [...sharedIndex.keys()]) {
				if (!currentIds.has(id)) sharedIndex.delete(id);
			}
			for (const meta of notes) {
				if (cancelled) return;
				const cached = sharedIndex.get(meta.id);
				if (cached && cached.hash === meta.contentHash) continue;
				try {
					const note = await noteService.readNote(meta.id);
					if (note && !cancelled) {
						const text = `${note.title}\n${note.content}`.toLowerCase();
						sharedIndex.set(meta.id, { hash: meta.contentHash, text });
					}
				} catch (e) {
					console.warn('[noteSearch] readNote failed', meta.id, e);
				}
			}
			if (!cancelled) {
				setIsIndexing(false);
				setIndexRevision((v) => v + 1);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [active, notes]);

	const matchingIds = useMemo<Set<string> | null>(() => {
		// `indexRevision` は本体では使わないが、index 更新時に useMemo を
		// 再評価させるためのトリガ。dep に入れる正当な意図を biome に伝える
		// ため明示的に参照しておく。
		void indexRevision;
		if (!active) return null;
		const q = debouncedQuery.trim().toLowerCase();
		if (!q) return null;
		const result = new Set<string>();
		for (const [id, entry] of sharedIndex) {
			if (entry.text.includes(q)) result.add(id);
		}
		return result;
	}, [active, debouncedQuery, indexRevision]);

	return {
		active,
		query,
		matchingIds,
		isIndexing,
		open: () => setActive(true),
		close: () => {
			setActive(false);
			setQuery('');
		},
		setQuery,
	};
}
