import {
	memo,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
	type GestureResponderEvent,
	type LayoutChangeEvent,
	type NativeScrollEvent,
	type NativeSyntheticEvent,
	Platform,
	ScrollView,
	StyleSheet,
	View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useTheme } from 'react-native-paper';
import Reanimated, {
	runOnJS,
	type SharedValue,
	useAnimatedStyle,
	useSharedValue,
	withTiming,
} from 'react-native-reanimated';
import { FolderListItem } from '@/components/FolderListItem';
import { NoteListItem } from '@/components/NoteListItem';
import {
	type SwipeAction,
	SwipeableNoteRow,
} from '@/components/SwipeableNoteRow';
import type { DropIntent, FlatRow } from '@/utils/flatTree';

// 指タッチ → drag 開始までのホールド時間。短すぎると ScrollView のスクロール意図と
// 競合し、ちょっと触っただけで drag が始まってしまう。スクロール / タップ /
// スワイプ (= ReanimatedSwipeable) との取り違いをなるべく無くしたいので、
// 700ms でしっかりホールドさせる。
const DRAG_LONG_PRESS_MS = 500;
const AUTOSCROLL_EDGE_PX = 56;
const AUTOSCROLL_STEP_PX = 18;
const DROP_INDICATOR_HEIGHT = 3;
// フォルダ末尾境界では、画面左端からの固定しきい値ではなく「その境界へ到達した時の
// contentX」を基準にする。固定しきい値 (以前は約 170px) にすると、左側のインデント
// 領域で内側に入れたい操作まで outside 扱いになり、画面 1/3 付近まで右へ入れないと
// inside が維持できない。
// - 境界へ入った瞬間は inside (= フォルダ末尾子) として扱う。
// - inside 中に到達した最右 X を peak として保持し、そこから左へ戻ったら outside。
// - outside 後は peak まで右へ戻したら inside に復帰する。
// 少量の grace は、Android 実機での指・センサーの 1〜数 px 揺れを意図判定から外すため。
const FOLDER_BOUNDARY_RETREAT_GRACE_PX = 6;
const INDICATOR_INSET = 8;
const INDENT_INDICATOR_OFFSET = 40;
const GROUP_TRAILING_SPACE_PX = 8;
const ROW_KIND_TOP_LEVEL_NOTE = 0;
const ROW_KIND_FOLDER_HEADER = 1;
const ROW_KIND_FOLDER_CHILD = 2;

const noopNotePress = (_id: string) => {};
const noopFolderToggle = (_id: string) => {};
const noopFolderMorePress = (_e: GestureResponderEvent, _id: string) => {};

export interface ManualReorderEvent {
	fromIndex: number;
	fromItem: FlatRow;
	rows: FlatRow[];
	dropIntent: DropIntent;
	isExternalDrag: false;
}

interface RowLayout {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface RowMetric extends RowLayout {
	index: number;
	kind: number;
	inGroupEnd: boolean;
}

interface DropTarget {
	folderId: string;
	indicatorContentY: number;
	indicatorIndented: boolean;
	intent: DropIntent;
	key: string;
	slot: number;
}

function clamp(value: number, min: number, max: number) {
	return Math.max(min, Math.min(max, value));
}

/**
 * 2 つの FlatRow が「描画上同等」かを判定する。`note` / `folder` フィールドは
 * notesById / folderById の参照なので reference 比較で OK。残りは primitive。
 *
 * row 配列は noteList が変わるたびに新規生成されるが、要素の中身が変わっていなければ
 * これで True になる → 行コンテンツの再レンダリングをスキップできる。
 */
function flatRowsEqual(a: FlatRow, b: FlatRow): boolean {
	if (a === b) return true;
	if (a.kind !== b.kind || a.id !== b.id) return false;
	if (a.kind === 'folder-header' && b.kind === 'folder-header') {
		return (
			a.folder === b.folder &&
			a.noteCount === b.noteCount &&
			a.collapsed === b.collapsed &&
			a.inGroupEnd === b.inGroupEnd
		);
	}
	if (a.kind === 'folder-child' && b.kind === 'folder-child') {
		return (
			a.note === b.note &&
			a.folderId === b.folderId &&
			a.inGroupEnd === b.inGroupEnd &&
			(a.parentCollapsed ?? false) === (b.parentCollapsed ?? false)
		);
	}
	if (a.kind === 'topLevel-note' && b.kind === 'topLevel-note') {
		return a.note === b.note;
	}
	return false;
}

function getSlotFromY(
	rows: FlatRow[],
	layouts: Map<string, RowLayout>,
	dragInsertionY: number,
	excludeFolderChildrenOf: string | null = null,
) {
	let slot = rows.length;
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		const layout = layouts.get(row.key);
		if (!layout) continue;
		if (layout.height <= 0) continue;
		// drag 中だけ折り畳んだフォルダの子は、まだ layout が更新されていない
		// 1〜2 フレームの間も「無いもの」として扱う。
		if (
			excludeFolderChildrenOf &&
			row.kind === 'folder-child' &&
			row.folderId === excludeFolderChildrenOf
		) {
			continue;
		}
		if (dragInsertionY <= layout.y + layout.height / 2) {
			slot = i;
			break;
		}
	}
	return clamp(slot, 0, rows.length);
}

function getIndicatorContentY(
	rows: FlatRow[],
	layouts: Map<string, RowLayout>,
	slot: number,
) {
	if (rows.length === 0) return 0;
	if (slot <= 0) {
		return layouts.get(rows[0].key)?.y ?? 0;
	}
	if (slot >= rows.length) {
		const last = rows[rows.length - 1];
		const layout = layouts.get(last.key);
		return layout ? layout.y + layout.height : 0;
	}
	return layouts.get(rows[slot].key)?.y ?? 0;
}

function getFolderEndIndicatorContentY(
	rows: FlatRow[],
	layouts: Map<string, RowLayout>,
	folderId: string,
) {
	const endSlot = getFolderEndSlot(rows, folderId);
	const previousRow = rows[endSlot - 1];
	if (!previousRow) return getIndicatorContentY(rows, layouts, endSlot);

	const layout = layouts.get(previousRow.key);
	if (!layout) return getIndicatorContentY(rows, layouts, endSlot);

	// folder-child の最終行は下余白を持つので、線は余白の下ではなく
	// フォルダ本体の終端にくっつける。
	const trailingSpace =
		previousRow.kind === 'folder-child' && previousRow.inGroupEnd
			? GROUP_TRAILING_SPACE_PX
			: 0;
	return layout.y + layout.height - trailingSpace;
}

function getRowKindCode(row: FlatRow) {
	if (row.kind === 'folder-header') return ROW_KIND_FOLDER_HEADER;
	if (row.kind === 'folder-child') return ROW_KIND_FOLDER_CHILD;
	return ROW_KIND_TOP_LEVEL_NOTE;
}

function buildRowMetrics(
	rows: FlatRow[],
	layouts: Map<string, RowLayout>,
	excludeFolderChildrenOf: string | null = null,
): RowMetric[] {
	const metrics: RowMetric[] = [];
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		const layout = layouts.get(row.key);
		if (!layout) continue;
		if (layout.height <= 0) continue;
		// drag 中だけ折り畳んだフォルダの子は、layout 反映が遅れる短時間も含めて
		// 計測対象から外し、ドロップ位置の判定に紛れ込ませない。
		if (
			excludeFolderChildrenOf &&
			row.kind === 'folder-child' &&
			row.folderId === excludeFolderChildrenOf
		) {
			continue;
		}
		metrics.push({
			...layout,
			index,
			kind: getRowKindCode(row),
			inGroupEnd:
				(row.kind === 'folder-header' || row.kind === 'folder-child') &&
				row.inGroupEnd,
		});
	}
	return metrics;
}

function countTopLevelBeforeSlot(rows: FlatRow[], slot: number) {
	let count = 0;
	for (let i = 0; i < Math.min(slot, rows.length); i++) {
		if (rows[i].kind !== 'folder-child') count++;
	}
	return count;
}

function findFolderHeaderIndex(rows: FlatRow[], folderId: string) {
	return rows.findIndex(
		(row) => row.kind === 'folder-header' && row.id === folderId,
	);
}

function getFolderEndSlot(rows: FlatRow[], folderId: string) {
	const headerIndex = findFolderHeaderIndex(rows, folderId);
	if (headerIndex === -1) return rows.length;
	const header = rows[headerIndex];
	if (header?.kind === 'folder-header' && header.collapsed) {
		return headerIndex + 1;
	}
	let slot = headerIndex + 1;
	for (let i = headerIndex + 1; i < rows.length; i++) {
		const row = rows[i];
		if (row.kind !== 'folder-child' || row.folderId !== folderId) break;
		slot = i + 1;
	}
	return slot;
}

function getFolderChildIndexBeforeSlot(
	rows: FlatRow[],
	folderId: string,
	slot: number,
) {
	const headerIndex = findFolderHeaderIndex(rows, folderId);
	const header = rows[headerIndex];
	if (header?.kind === 'folder-header' && header.collapsed) {
		return header.noteCount;
	}

	let count = 0;
	for (let i = 0; i < Math.min(slot, rows.length); i++) {
		const row = rows[i];
		if (row.kind === 'folder-child' && row.folderId === folderId) count++;
	}
	return count;
}

function getCurrentDropIntent(
	rows: FlatRow[],
	index: number,
): DropIntent | null {
	const row = rows[index];
	if (!row) return null;
	if (row.kind === 'folder-child') {
		return {
			type: 'folder-child',
			folderId: row.folderId,
			index: getFolderChildIndexBeforeSlot(rows, row.folderId, index),
		};
	}
	return {
		type: 'top-level',
		index: countTopLevelBeforeSlot(rows, index),
	};
}

function isNoopDropIntent(
	rows: FlatRow[],
	fromIndex: number,
	intent: DropIntent,
) {
	const current = getCurrentDropIntent(rows, fromIndex);
	if (!current) return true;
	if (current.type !== intent.type) return false;
	if (current.type === 'folder-child') {
		if (
			intent.type !== 'folder-child' ||
			current.folderId !== intent.folderId
		) {
			return false;
		}
		return intent.index === current.index || intent.index === current.index + 1;
	}
	return (
		intent.type === 'top-level' &&
		(intent.index === current.index || intent.index === current.index + 1)
	);
}

function getIntentFolderId(intent: DropIntent) {
	return intent.type === 'folder-child' ? intent.folderId : '';
}

function getDropTargetKey(target: Pick<DropTarget, 'intent' | 'slot'>) {
	if (target.intent.type === 'folder-child') {
		return `folder:${target.intent.folderId}:${target.intent.index}:${target.slot}`;
	}
	return `top:${target.intent.index}:${target.slot}`;
}

function resolveDropTarget(
	rows: FlatRow[],
	layouts: Map<string, RowLayout>,
	activeIndex: number,
	slot: number,
	resolveBoundaryIndented: (
		folderId: string,
		rowKey: string,
		contentX: number,
	) => boolean,
	contentX: number,
): DropTarget | null {
	const moved = rows[activeIndex];
	if (!moved) return null;

	const safeSlot = clamp(slot, 0, rows.length);
	if (moved.kind === 'folder-header') {
		const target: DropTarget = {
			folderId: '',
			indicatorContentY: getIndicatorContentY(rows, layouts, safeSlot),
			indicatorIndented: false,
			intent: {
				type: 'top-level',
				index: countTopLevelBeforeSlot(rows, safeSlot),
			},
			key: '',
			slot: safeSlot,
		};
		target.key = getDropTargetKey(target);
		return target;
	}

	const prev = rows[safeSlot - 1];
	const next = rows[safeSlot];
	let intent: DropIntent;
	let visualSlot = safeSlot;
	let indicatorContentY = getIndicatorContentY(rows, layouts, safeSlot);
	let indicatorIndented = false;

	if (prev?.kind === 'folder-header') {
		const inside = resolveBoundaryIndented(prev.id, prev.key, contentX);
		visualSlot = getFolderEndSlot(rows, prev.id);
		indicatorContentY = getFolderEndIndicatorContentY(rows, layouts, prev.id);
		if (inside) {
			intent = {
				type: 'folder-child',
				folderId: prev.id,
				index: prev.noteCount,
			};
			indicatorIndented = true;
		} else {
			intent = {
				type: 'top-level',
				index: countTopLevelBeforeSlot(rows, safeSlot),
			};
		}
	} else if (prev?.kind === 'folder-child' && prev.inGroupEnd) {
		const inside = resolveBoundaryIndented(prev.folderId, prev.key, contentX);
		indicatorContentY = getFolderEndIndicatorContentY(
			rows,
			layouts,
			prev.folderId,
		);
		if (inside) {
			intent = {
				type: 'folder-child',
				folderId: prev.folderId,
				index: getFolderChildIndexBeforeSlot(rows, prev.folderId, safeSlot),
			};
			indicatorIndented = true;
		} else {
			intent = {
				type: 'top-level',
				index: countTopLevelBeforeSlot(rows, safeSlot),
			};
		}
	} else if (next?.kind === 'folder-child') {
		intent = {
			type: 'folder-child',
			folderId: next.folderId,
			index: getFolderChildIndexBeforeSlot(rows, next.folderId, safeSlot),
		};
		indicatorIndented = true;
	} else {
		intent = {
			type: 'top-level',
			index: countTopLevelBeforeSlot(rows, safeSlot),
		};
	}

	const target: DropTarget = {
		folderId: getIntentFolderId(intent),
		indicatorContentY,
		indicatorIndented,
		intent,
		key: '',
		slot: visualSlot,
	};
	target.key = getDropTargetKey(target);
	return target;
}

interface ManualDragNoteListProps {
	rows: FlatRow[];
	backgroundColor: string;
	folderHeaderBg: string;
	folderChildBg: string;
	indicatorColor: string;
	/** active 画面で渡す: 行の左スワイプにアーカイブアクションを足す。 */
	onArchive?: (noteId: string) => void;
	/** archive 画面で渡す: 行の左スワイプに復元アクションを足す。 */
	onRestore?: (noteId: string) => void;
	/** archive 画面で渡す: 行の左スワイプに削除アクションを足す。 */
	onDelete?: (noteId: string) => void;
	/** フォルダヘッダ右端のドット押下。null を渡すとドットが消える。 */
	onFolderMorePress?: (e: GestureResponderEvent, folderId: string) => void;
	onNoteOpen: (noteId: string) => void;
	onReorder: (event: ManualReorderEvent) => void;
	onToggleFolder: (folderId: string) => void;
	/** 検索結果表示中など、リストが部分集合の時に DnD を抑止する。
	 *  long-press → drag が発火しないので、フィルタ済みの並びを維持できる。 */
	disableDrag?: boolean;
}

interface DragState {
	activeIndex: number;
	item: FlatRow;
	folderId: string;
}

export function ManualDragNoteList({
	rows,
	backgroundColor,
	folderHeaderBg,
	folderChildBg,
	indicatorColor,
	onArchive,
	onRestore,
	onDelete,
	onFolderMorePress,
	onNoteOpen,
	onReorder,
	onToggleFolder,
	disableDrag = false,
}: ManualDragNoteListProps) {
	const { t } = useTranslation();
	const theme = useTheme();
	const scrollRef = useRef<ScrollView>(null);
	const viewportRef = useRef<View>(null);
	const rowsRef = useRef(rows);
	const rowLayoutsRef = useRef(new Map<string, RowLayout>());
	const scrollOffsetRef = useRef(0);
	const contentHeightRef = useRef(0);
	const viewportHeightRef = useRef(0);
	const viewportPageXRef = useRef(0);
	const viewportPageYRef = useRef(0);
	const activeIndexRef = useRef<number | null>(null);
	const latestPointerRef = useRef<{ x: number; y: number } | null>(null);
	const autoscrollFrameRef = useRef<number | null>(null);
	const autoscrollTickRef = useRef<() => void>(() => {});
	const dropIntentRef = useRef<DropIntent | null>(null);
	const dropTargetKeyRef = useRef('');
	const boundaryFolderIdRef = useRef<string | null>(null);
	const boundaryRowKeyRef = useRef<string | null>(null);
	const boundaryIndentedRef = useRef(false);
	// inside 状態に入ってから一度でも到達した最右の contentX を記録する。
	// このリードに対して左方向に戻った時点で「外に出したがっている」と判定する。
	const boundaryReachedMaxXRef = useRef(0);
	const grabOffsetYRef = useRef(0);
	const dragRowsRef = useRef<FlatRow[]>([]);
	const [dragState, setDragState] = useState<DragState | null>(null);
	// drag 中だけ「展開フォルダを一時的に折り畳む」ためのフラグ。
	// noteList 側の collapsedFolderIds は変更せず、純粋に視覚 + 計測上の制御。
	// drag 中身が後ろの行を押し下げて「置いて行かれる」ように見える現象を抑え、
	// ヘッダだけの単位でドロップ位置を選べるようにする。
	const autoCollapsedFolderIdRef = useRef<string | null>(null);
	const [autoCollapsedFolderId, setAutoCollapsedFolderId] = useState<
		string | null
	>(null);
	const overlayTop = useSharedValue(0);
	const indicatorIndent = useSharedValue(0);
	const indicatorTop = useSharedValue(0);
	const indicatorVisible = useSharedValue(0);
	const jsMoveFrame = useSharedValue(0);
	const rowMetrics = useSharedValue<RowMetric[]>([]);
	const scrollOffset = useSharedValue(0);
	const visualBoundaryIndented = useSharedValue(0);
	const visualBoundarySlot = useSharedValue(-1);
	// inside 状態で到達した最右 contentX (worklet 側)。JS 側 boundaryReachedMaxXRef と同義。
	const visualBoundaryReachedMaxX = useSharedValue(0);
	const viewportPageX = useSharedValue(0);
	const viewportPageY = useSharedValue(0);
	const viewportHeight = useSharedValue(0);
	const grabOffsetY = useSharedValue(0);
	const activeIndexSV = useSharedValue(-1);
	const targetSlotSV = useSharedValue(-1);
	const activeHeightSV = useSharedValue(0);

	rowsRef.current = rows;

	const overlayStyle = useAnimatedStyle(() => ({
		transform: [{ translateY: overlayTop.value }],
	}));

	const indicatorStyle = useAnimatedStyle(() => ({
		left: INDICATOR_INSET + indicatorIndent.value,
		opacity: indicatorVisible.value,
		transform: [{ translateY: indicatorTop.value }],
	}));

	const handleViewportLayout = useCallback(
		(event: LayoutChangeEvent) => {
			viewportHeightRef.current = event.nativeEvent.layout.height;
			viewportHeight.value = event.nativeEvent.layout.height;
			requestAnimationFrame(() => {
				viewportRef.current?.measureInWindow((x, y) => {
					viewportPageXRef.current = x;
					viewportPageYRef.current = y;
					viewportPageX.value = x;
					viewportPageY.value = y;
				});
			});
		},
		[viewportHeight, viewportPageX, viewportPageY],
	);

	const handleScroll = useCallback(
		(event: NativeSyntheticEvent<NativeScrollEvent>) => {
			const y = event.nativeEvent.contentOffset.y;
			scrollOffsetRef.current = y;
			scrollOffset.value = y;
		},
		[scrollOffset],
	);

	const handleRowLayout = useCallback(
		(key: string, event: LayoutChangeEvent) => {
			const { x, y, width, height } = event.nativeEvent.layout;
			rowLayoutsRef.current.set(key, { x, y, width, height });
			rowMetrics.value = buildRowMetrics(
				rowsRef.current,
				rowLayoutsRef.current,
				autoCollapsedFolderIdRef.current,
			);
		},
		[rowMetrics],
	);

	const scrollByEdge = useCallback(
		(viewportY: number) => {
			const maxOffset = Math.max(
				0,
				contentHeightRef.current - viewportHeightRef.current,
			);
			let nextOffset = scrollOffsetRef.current;
			if (viewportY < AUTOSCROLL_EDGE_PX) {
				nextOffset = Math.max(0, nextOffset - AUTOSCROLL_STEP_PX);
			} else if (viewportY > viewportHeightRef.current - AUTOSCROLL_EDGE_PX) {
				nextOffset = Math.min(maxOffset, nextOffset + AUTOSCROLL_STEP_PX);
			}
			if (nextOffset !== scrollOffsetRef.current) {
				scrollOffsetRef.current = nextOffset;
				scrollOffset.value = nextOffset;
				scrollRef.current?.scrollTo({ y: nextOffset, animated: false });
				return true;
			}
			return false;
		},
		[scrollOffset],
	);

	const canAutoscrollAtPointer = useCallback((absoluteY: number) => {
		const viewportY = absoluteY - viewportPageYRef.current;
		const maxOffset = Math.max(
			0,
			contentHeightRef.current - viewportHeightRef.current,
		);
		if (viewportY < AUTOSCROLL_EDGE_PX) {
			return scrollOffsetRef.current > 0;
		}
		if (viewportY > viewportHeightRef.current - AUTOSCROLL_EDGE_PX) {
			return scrollOffsetRef.current < maxOffset;
		}
		return false;
	}, []);

	const stopAutoscrollLoop = useCallback(() => {
		if (autoscrollFrameRef.current !== null) {
			cancelAnimationFrame(autoscrollFrameRef.current);
			autoscrollFrameRef.current = null;
		}
	}, []);

	const startAutoscrollLoop = useCallback(() => {
		if (autoscrollFrameRef.current !== null) return;
		const pointer = latestPointerRef.current;
		if (!pointer || activeIndexRef.current === null) return;
		if (!canAutoscrollAtPointer(pointer.y)) return;
		autoscrollFrameRef.current = requestAnimationFrame(() => {
			autoscrollTickRef.current();
		});
	}, [canAutoscrollAtPointer]);

	const resolveBoundaryIndented = useCallback(
		(folderId: string, rowKey: string, contentX: number) => {
			const activeBoundaryChanged =
				boundaryFolderIdRef.current !== folderId ||
				boundaryRowKeyRef.current !== rowKey;
			if (activeBoundaryChanged) {
				boundaryFolderIdRef.current = folderId;
				boundaryRowKeyRef.current = rowKey;
				// 境界到達時の X を基準にする。画面左端からの固定しきい値を使うと、
				// 左側で慎重に操作した時ほど inside に入れなくなるため。
				boundaryIndentedRef.current = true;
				boundaryReachedMaxXRef.current = contentX;
				return boundaryIndentedRef.current;
			}

			if (boundaryIndentedRef.current) {
				// 右へ入れ込んだ分だけ peak を更新する。以後はこの peak から左に
				// 戻した量だけを「外へ出したい」意図として見る。
				if (contentX > boundaryReachedMaxXRef.current) {
					boundaryReachedMaxXRef.current = contentX;
				}
				if (
					contentX <
					boundaryReachedMaxXRef.current - FOLDER_BOUNDARY_RETREAT_GRACE_PX
				) {
					boundaryIndentedRef.current = false;
				}
			} else if (
				contentX >
				boundaryReachedMaxXRef.current + FOLDER_BOUNDARY_RETREAT_GRACE_PX
			) {
				// outside → inside: 固定しきい値ではなく、いったん外へ出た時の peak を
				// 右へ戻し直したことを復帰意図として扱う。
				boundaryIndentedRef.current = true;
				boundaryReachedMaxXRef.current = contentX;
			}
			return boundaryIndentedRef.current;
		},
		[],
	);

	const updateTargetFromPointer = useCallback(
		(absoluteX: number, absoluteY: number) => {
			const activeIndex = activeIndexRef.current;
			if (activeIndex === null) return;
			const rowsAtDragStart = dragRowsRef.current;
			const activeRow = rowsAtDragStart[activeIndex];
			const activeLayout = activeRow
				? rowLayoutsRef.current.get(activeRow.key)
				: undefined;
			if (!activeLayout) return;

			const viewportY = absoluteY - viewportPageYRef.current;
			scrollByEdge(viewportY);

			const dragInsertionY =
				viewportY - grabOffsetYRef.current + scrollOffsetRef.current;
			const slot = getSlotFromY(
				rowsAtDragStart,
				rowLayoutsRef.current,
				dragInsertionY,
				autoCollapsedFolderIdRef.current,
			);
			const target = resolveDropTarget(
				rowsAtDragStart,
				rowLayoutsRef.current,
				activeIndex,
				slot,
				resolveBoundaryIndented,
				absoluteX - viewportPageXRef.current,
			);
			if (!target) return;

			dropIntentRef.current = target.intent;
			targetSlotSV.value = target.slot;
			const indicatorVisualY =
				target.slot > activeIndex
					? target.indicatorContentY - activeLayout.height
					: target.indicatorContentY;
			// JS 側の連続自動スクロール中は worklet の onUpdate が走らないため、
			// ここでもインジケーター位置を更新する。リスト viewport 内へ clamp し、
			// AppBar / 下部バー領域に線がはみ出さないようにする。
			indicatorTop.value = clamp(
				indicatorVisualY - scrollOffsetRef.current,
				0,
				Math.max(0, viewportHeightRef.current - DROP_INDICATOR_HEIGHT),
			);
			indicatorIndent.value = target.indicatorIndented
				? INDENT_INDICATOR_OFFSET
				: 0;
			indicatorVisible.value = 1;

			if (target.key === dropTargetKeyRef.current) return;
			dropTargetKeyRef.current = target.key;
			setDragState((state) =>
				state ? { ...state, folderId: target.folderId } : state,
			);
		},
		[
			indicatorIndent,
			indicatorTop,
			indicatorVisible,
			resolveBoundaryIndented,
			scrollByEdge,
			targetSlotSV,
		],
	);

	autoscrollTickRef.current = () => {
		autoscrollFrameRef.current = null;
		const pointer = latestPointerRef.current;
		if (!pointer || activeIndexRef.current === null) return;
		if (!canAutoscrollAtPointer(pointer.y)) return;
		// 指がリスト端の外または端付近で止まっていても、前回 pointer を使って
		// 毎フレーム drop target を更新する。これで「ぐりぐり動かさないと
		// スクロールが続かない」状態を避ける。
		updateTargetFromPointer(pointer.x, pointer.y);
		startAutoscrollLoop();
	};

	useEffect(() => stopAutoscrollLoop, [stopAutoscrollLoop]);

	const handleGestureStart = useCallback(
		(
			index: number,
			absoluteX: number,
			absoluteY: number,
			localX: number,
			localY: number,
		) => {
			const item = rowsRef.current[index];
			if (!item) return;
			const layout = rowLayoutsRef.current.get(item.key);
			if (!layout) return;

			// 展開済みフォルダのヘッダを drag するときは、drag 中だけ中身を視覚的に
			// 折り畳む。中身が後ろに残って「置いて行かれる」現象を防ぎ、ヘッダ単位で
			// 素早くドロップ位置まで運べるようにする。drag 終了時に元へ戻す。
			if (
				item.kind === 'folder-header' &&
				!item.collapsed &&
				item.noteCount > 0
			) {
				autoCollapsedFolderIdRef.current = item.id;
				setAutoCollapsedFolderId(item.id);
			} else {
				autoCollapsedFolderIdRef.current = null;
				setAutoCollapsedFolderId(null);
			}

			latestPointerRef.current = { x: absoluteX, y: absoluteY };
			dragRowsRef.current = rowsRef.current;
			activeIndexRef.current = index;
			dropIntentRef.current = getCurrentDropIntent(rowsRef.current, index);
			dropTargetKeyRef.current = '';
			boundaryFolderIdRef.current = null;
			boundaryRowKeyRef.current = null;
			boundaryIndentedRef.current = false;
			boundaryReachedMaxXRef.current = 0;
			grabOffsetYRef.current = localY;
			jsMoveFrame.value = 0;
			rowMetrics.value = buildRowMetrics(
				rowsRef.current,
				rowLayoutsRef.current,
				autoCollapsedFolderIdRef.current,
			);
			scrollOffset.value = scrollOffsetRef.current;
			visualBoundaryIndented.value = 0;
			visualBoundarySlot.value = -1;
			visualBoundaryReachedMaxX.value = 0;
			viewportPageXRef.current = absoluteX - localX - layout.x;
			viewportPageYRef.current =
				absoluteY - localY - layout.y + scrollOffsetRef.current;
			viewportPageX.value = viewportPageXRef.current;
			viewportPageY.value = viewportPageYRef.current;
			overlayTop.value = absoluteY - viewportPageYRef.current - localY;
			grabOffsetY.value = localY;
			activeIndexSV.value = index;
			targetSlotSV.value = index;
			activeHeightSV.value = layout.height;
			indicatorTop.value = clamp(
				layout.y - scrollOffsetRef.current,
				0,
				Math.max(0, viewportHeightRef.current - DROP_INDICATOR_HEIGHT),
			);
			indicatorIndent.value =
				item.kind === 'folder-child' ? INDENT_INDICATOR_OFFSET : 0;
			indicatorVisible.value = 1;
			setDragState({
				activeIndex: index,
				item,
				folderId: item.kind === 'folder-child' ? item.folderId : '',
			});
			updateTargetFromPointer(absoluteX, absoluteY);
			startAutoscrollLoop();
		},
		[
			activeHeightSV,
			activeIndexSV,
			grabOffsetY,
			indicatorIndent,
			indicatorTop,
			indicatorVisible,
			jsMoveFrame,
			overlayTop,
			rowMetrics,
			scrollOffset,
			startAutoscrollLoop,
			targetSlotSV,
			updateTargetFromPointer,
			visualBoundaryIndented,
			visualBoundaryReachedMaxX,
			visualBoundarySlot,
			viewportPageX,
			viewportPageY,
		],
	);

	const handleGestureMove = useCallback(
		(absoluteX: number, absoluteY: number) => {
			latestPointerRef.current = { x: absoluteX, y: absoluteY };
			updateTargetFromPointer(absoluteX, absoluteY);
			startAutoscrollLoop();
		},
		[startAutoscrollLoop, updateTargetFromPointer],
	);

	const handleGestureEnd = useCallback(
		(commit: boolean, absoluteX?: number, absoluteY?: number) => {
			stopAutoscrollLoop();
			const activeIndex = activeIndexRef.current;
			if (activeIndex === null) return;
			if (
				commit &&
				typeof absoluteX === 'number' &&
				typeof absoluteY === 'number'
			) {
				latestPointerRef.current = { x: absoluteX, y: absoluteY };
				updateTargetFromPointer(absoluteX, absoluteY);
			}
			const dropIntent = dropIntentRef.current;
			const dragRows = dragRowsRef.current;
			const fromItem = dragRows[activeIndex];
			const resetDrag = () => {
				activeIndexSV.value = -1;
				targetSlotSV.value = -1;
				activeHeightSV.value = 0;
				indicatorVisible.value = 0;
				setDragState(null);
				// auto-collapse はここで一緒に解除する。commit 経路なら
				// requestAnimationFrame 越しなので、親の state 更新で folder が
				// 新位置に並んだ後に展開状態へ戻り、中身が旧位置にチラ見えするのを防ぐ。
				if (autoCollapsedFolderIdRef.current !== null) {
					autoCollapsedFolderIdRef.current = null;
					setAutoCollapsedFolderId(null);
				}
			};
			if (
				commit &&
				fromItem &&
				dropIntent &&
				!isNoopDropIntent(dragRows, activeIndex, dropIntent)
			) {
				onReorder({
					dropIntent,
					fromIndex: activeIndex,
					fromItem,
					rows: dragRows,
					isExternalDrag: false,
				});
				requestAnimationFrame(resetDrag);
			} else {
				resetDrag();
			}
			activeIndexRef.current = null;
			dropIntentRef.current = null;
			dropTargetKeyRef.current = '';
			boundaryFolderIdRef.current = null;
			boundaryRowKeyRef.current = null;
			latestPointerRef.current = null;
			dragRowsRef.current = [];
		},
		[
			activeHeightSV,
			activeIndexSV,
			indicatorVisible,
			onReorder,
			stopAutoscrollLoop,
			targetSlotSV,
			updateTargetFromPointer,
		],
	);

	// 各ノートに付ける swipe アクションは、画面（active / archive）ごとに
	// 異なる handler が渡される。renderRowContent 内で動的に組み立てる。
	const buildNoteSwipeActions = useCallback(
		(noteId: string): SwipeAction[] => {
			const actions: SwipeAction[] = [];
			if (onRestore) {
				actions.push({
					icon: 'archive-arrow-up',
					label: t('noteList.restore'),
					onPress: () => onRestore(noteId),
					background: theme.colors.tertiary,
					foreground: theme.colors.onTertiary,
				});
			}
			if (onArchive) {
				actions.push({
					icon: 'archive-arrow-down',
					label: t('noteList.archive_action'),
					onPress: () => onArchive(noteId),
					background: theme.colors.tertiary,
					foreground: theme.colors.onTertiary,
				});
			}
			if (onDelete) {
				actions.push({
					icon: 'trash-can',
					label: t('noteList.delete'),
					onPress: () => onDelete(noteId),
					background: theme.colors.error,
					foreground: theme.colors.onError,
				});
			}
			return actions;
		},
		[onArchive, onRestore, onDelete, t, theme.colors],
	);

	const renderRowContent = useCallback(
		(item: FlatRow, overlayFolderId?: string) => {
			if (item.kind === 'topLevel-note') {
				const inFolder =
					overlayFolderId !== undefined && overlayFolderId !== '';
				return (
					<SwipeableNoteRow
						actions={buildNoteSwipeActions(item.id)}
						disabled={overlayFolderId !== undefined}
					>
						<View
							style={[
								{ backgroundColor: inFolder ? folderChildBg : backgroundColor },
								inFolder && styles.groupSide,
							]}
						>
							<NoteListItem
								metadata={item.note}
								onPress={
									overlayFolderId === undefined ? onNoteOpen : noopNotePress
								}
								indented={inFolder}
							/>
						</View>
					</SwipeableNoteRow>
				);
			}

			if (item.kind === 'folder-header') {
				return (
					<View
						style={[
							{ backgroundColor: folderHeaderBg },
							styles.groupSide,
							styles.groupTop,
							item.inGroupEnd && styles.groupBottom,
						]}
					>
						<FolderListItem
							folder={item.folder}
							noteCount={item.noteCount}
							collapsed={item.collapsed}
							onToggle={
								overlayFolderId === undefined
									? onToggleFolder
									: noopFolderToggle
							}
							onMorePress={
								overlayFolderId === undefined
									? onFolderMorePress
									: noopFolderMorePress
							}
						/>
					</View>
				);
			}

			const inFolder =
				overlayFolderId !== undefined ? overlayFolderId !== '' : true;
			return (
				<View
					style={[
						{ backgroundColor: inFolder ? folderChildBg : backgroundColor },
						inFolder && styles.groupSide,
						item.inGroupEnd && overlayFolderId === undefined
							? styles.groupTrailingSpace
							: undefined,
					]}
				>
					<SwipeableNoteRow
						actions={buildNoteSwipeActions(item.id)}
						disabled={overlayFolderId !== undefined}
					>
						<NoteListItem
							metadata={item.note}
							onPress={
								overlayFolderId === undefined ? onNoteOpen : noopNotePress
							}
							indented={inFolder}
						/>
					</SwipeableNoteRow>
				</View>
			);
		},
		[
			backgroundColor,
			buildNoteSwipeActions,
			folderChildBg,
			folderHeaderBg,
			onFolderMorePress,
			onNoteOpen,
			onToggleFolder,
		],
	);

	// 行コンテンツのキャッシュ。row.key で引き、`flatRowsEqual` で行データが
	// 不変だったら前回の React 要素ツリーを使い回す。これにより `DraggableRow` の
	// `children` プロップが reference equality で安定し、`React.memo` で
	// 該当行以外の再レンダリングをスキップできる。
	const rowContentCacheRef = useRef(
		new Map<string, { row: FlatRow; node: ReactNode }>(),
	);
	const rendererRef = useRef(renderRowContent);
	const rowContents = useMemo(() => {
		const cache = rowContentCacheRef.current;
		if (rendererRef.current !== renderRowContent) {
			cache.clear();
			rendererRef.current = renderRowContent;
		}
		const used = new Set<string>();
		const result: ReactNode[] = [];
		for (const row of rows) {
			used.add(row.key);
			const cached = cache.get(row.key);
			if (cached && flatRowsEqual(cached.row, row)) {
				result.push(cached.node);
				continue;
			}
			const node = renderRowContent(row);
			cache.set(row.key, { row, node });
			result.push(node);
		}
		for (const key of cache.keys()) {
			if (!used.has(key)) cache.delete(key);
		}
		return result;
	}, [rows, renderRowContent]);

	const renderRows = () =>
		rows.map((item, index) => {
			const hidden =
				item.kind === 'folder-child' &&
				(!!item.parentCollapsed ||
					(autoCollapsedFolderId !== null &&
						item.folderId === autoCollapsedFolderId));
			return (
				<DraggableRow
					key={item.key}
					itemKey={item.key}
					index={index}
					onLayout={handleRowLayout}
					onGestureStart={handleGestureStart}
					onGestureMove={handleGestureMove}
					onGestureEnd={handleGestureEnd}
					overlayTop={overlayTop}
					viewportPageX={viewportPageX}
					viewportPageY={viewportPageY}
					viewportHeight={viewportHeight}
					grabOffsetY={grabOffsetY}
					activeIndex={activeIndexSV}
					targetSlot={targetSlotSV}
					activeHeight={activeHeightSV}
					indicatorIndent={indicatorIndent}
					indicatorTop={indicatorTop}
					indicatorVisible={indicatorVisible}
					jsMoveFrame={jsMoveFrame}
					rowMetrics={rowMetrics}
					scrollOffset={scrollOffset}
					visualBoundaryIndented={visualBoundaryIndented}
					visualBoundarySlot={visualBoundarySlot}
					visualBoundaryReachedMaxX={visualBoundaryReachedMaxX}
					hidden={hidden}
					disableDrag={disableDrag}
				>
					{rowContents[index]}
				</DraggableRow>
			);
		});

	return (
		<View
			ref={viewportRef}
			style={styles.listViewport}
			onLayout={handleViewportLayout}
		>
			<ScrollView
				ref={scrollRef}
				scrollEnabled={dragState === null}
				onScroll={handleScroll}
				scrollEventThrottle={16}
				contentContainerStyle={styles.listContent}
				onContentSizeChange={(_width, height) => {
					contentHeightRef.current = height;
				}}
			>
				{renderRows()}
			</ScrollView>
			<Reanimated.View
				pointerEvents="none"
				style={[
					styles.dropIndicator,
					{ backgroundColor: indicatorColor },
					indicatorStyle,
				]}
			/>
			{dragState && (
				<Reanimated.View
					pointerEvents="none"
					style={[styles.dragOverlay, overlayStyle]}
				>
					{renderRowContent(
						// drag 中の自動折り畳みに合わせて、overlay 上のヘッダも
						// 折り畳み状態 (chevron / folder icon / 下角 rounded) で見せる。
						autoCollapsedFolderId !== null &&
							dragState.item.kind === 'folder-header' &&
							dragState.item.id === autoCollapsedFolderId
							? {
									...dragState.item,
									collapsed: true,
									inGroupEnd: true,
								}
							: dragState.item,
						dragState.folderId,
					)}
				</Reanimated.View>
			)}
		</View>
	);
}

interface DraggableRowProps {
	itemKey: string;
	index: number;
	children: ReactNode;
	onLayout: (key: string, event: LayoutChangeEvent) => void;
	onGestureStart: (
		index: number,
		absoluteX: number,
		absoluteY: number,
		localX: number,
		localY: number,
	) => void;
	onGestureMove: (absoluteX: number, absoluteY: number) => void;
	onGestureEnd: (
		commit: boolean,
		absoluteX?: number,
		absoluteY?: number,
	) => void;
	overlayTop: SharedValue<number>;
	viewportPageX: SharedValue<number>;
	viewportPageY: SharedValue<number>;
	viewportHeight: SharedValue<number>;
	grabOffsetY: SharedValue<number>;
	activeIndex: SharedValue<number>;
	targetSlot: SharedValue<number>;
	activeHeight: SharedValue<number>;
	indicatorIndent: SharedValue<number>;
	indicatorTop: SharedValue<number>;
	indicatorVisible: SharedValue<number>;
	jsMoveFrame: SharedValue<number>;
	rowMetrics: SharedValue<RowMetric[]>;
	scrollOffset: SharedValue<number>;
	visualBoundaryIndented: SharedValue<number>;
	visualBoundarySlot: SharedValue<number>;
	visualBoundaryReachedMaxX: SharedValue<number>;
	hidden?: boolean;
	disableDrag?: boolean;
}

function DraggableRowImpl({
	itemKey,
	index,
	children,
	onLayout,
	onGestureStart,
	onGestureMove,
	onGestureEnd,
	overlayTop,
	viewportPageX,
	viewportPageY,
	viewportHeight,
	grabOffsetY,
	activeIndex,
	targetSlot,
	activeHeight,
	indicatorIndent,
	indicatorTop,
	indicatorVisible,
	jsMoveFrame,
	rowMetrics,
	scrollOffset,
	visualBoundaryIndented,
	visualBoundarySlot,
	visualBoundaryReachedMaxX,
	hidden = false,
	disableDrag = false,
}: DraggableRowProps) {
	const rowStyle = useAnimatedStyle(() => {
		const active = activeIndex.value;
		if (active < 0) {
			// ドラッグ終了時の戻りもアニメーションさせる (translateY 0 へ収束)
			return {
				opacity: 1,
				transform: [{ translateY: withTiming(0, { duration: 180 }) }],
			};
		}
		if (index === active) {
			return {
				opacity: 0,
				transform: [{ translateY: 0 }],
			};
		}

		const target = targetSlot.value;
		const height = activeHeight.value;
		let translateY = 0;
		if (target > active && index > active && index < target) {
			translateY = -height;
		} else if (target < active && index >= target && index < active) {
			translateY = height;
		}

		// targetSlot が変わると withTiming が新しい目標値へスムーズに補間する。
		// 同値再呼び出しは Reanimated 側で no-op なので毎フレーム再評価でも安全。
		return {
			opacity: 1,
			transform: [{ translateY: withTiming(translateY, { duration: 180 }) }],
		};
	}, [index]);

	const gesture = useMemo(
		() =>
			Gesture.Pan()
				.enabled(!disableDrag)
				.activateAfterLongPress(DRAG_LONG_PRESS_MS)
				.onStart((event) => {
					const metrics = rowMetrics.value;
					let activeMetric: RowMetric | null = null;
					for (let i = 0; i < metrics.length; i++) {
						if (metrics[i].index === index) {
							activeMetric = metrics[i];
							break;
						}
					}
					overlayTop.value = event.absoluteY - viewportPageY.value - event.y;
					grabOffsetY.value = event.y;
					activeIndex.value = index;
					targetSlot.value = index;
					jsMoveFrame.value = 0;
					visualBoundaryIndented.value = 0;
					visualBoundarySlot.value = -1;
					visualBoundaryReachedMaxX.value = 0;
					if (activeMetric) {
						activeHeight.value = activeMetric.height;
						indicatorTop.value = activeMetric.y - scrollOffset.value;
						indicatorIndent.value =
							activeMetric.kind === ROW_KIND_FOLDER_CHILD
								? INDENT_INDICATOR_OFFSET
								: 0;
					}
					indicatorVisible.value = 1;
					runOnJS(onGestureStart)(
						index,
						event.absoluteX,
						event.absoluteY,
						event.x,
						event.y,
					);
				})
				.onUpdate((event) => {
					overlayTop.value =
						event.absoluteY - viewportPageY.value - grabOffsetY.value;
					const metrics = rowMetrics.value;
					const insertionY = overlayTop.value + scrollOffset.value;
					let metricSlot = metrics.length;
					let slot = metrics.length;
					for (let i = 0; i < metrics.length; i++) {
						const metric = metrics[i];
						if (insertionY <= metric.y + metric.height / 2) {
							metricSlot = i;
							slot = metric.index;
							break;
						}
					}

					let indicatorContentY = 0;
					if (metrics.length > 0) {
						if (metricSlot <= 0) {
							indicatorContentY = metrics[0].y;
						} else if (metricSlot >= metrics.length) {
							const last = metrics[metrics.length - 1];
							indicatorContentY = last.y + last.height;
						} else {
							indicatorContentY = metrics[metricSlot].y;
						}
					}

					let visualSlot = slot;
					let indent = 0;
					const prev = metrics[metricSlot - 1];
					const next = metrics[metricSlot];
					if (
						prev &&
						(prev.kind === ROW_KIND_FOLDER_HEADER ||
							(prev.kind === ROW_KIND_FOLDER_CHILD && prev.inGroupEnd))
					) {
						const contentX = event.absoluteX - viewportPageX.value;
						if (visualBoundarySlot.value !== prev.index) {
							visualBoundarySlot.value = prev.index;
							// UI 表示も JS 側の dropIntent と同じく、境界到達時の
							// contentX を基準にする。固定しきい値に戻すと、見た目だけ
							// outside に引き戻されるように見えてしまう。
							visualBoundaryIndented.value = 1;
							visualBoundaryReachedMaxX.value = contentX;
						} else if (visualBoundaryIndented.value === 1) {
							if (contentX > visualBoundaryReachedMaxX.value) {
								visualBoundaryReachedMaxX.value = contentX;
							}
							if (
								contentX <
								visualBoundaryReachedMaxX.value -
									FOLDER_BOUNDARY_RETREAT_GRACE_PX
							) {
								visualBoundaryIndented.value = 0;
							}
						} else if (
							contentX >
							visualBoundaryReachedMaxX.value + FOLDER_BOUNDARY_RETREAT_GRACE_PX
						) {
							// outside → inside: 外へ出した後、到達済み peak まで右へ
							// 戻したら inside 復帰として扱う。
							visualBoundaryIndented.value = 1;
							visualBoundaryReachedMaxX.value = contentX;
						}

						let endMetric = prev;
						for (let i = metricSlot; i < metrics.length; i++) {
							const candidate = metrics[i];
							if (
								candidate.kind !== ROW_KIND_FOLDER_CHILD ||
								(prev.kind === ROW_KIND_FOLDER_CHILD && candidate.x !== prev.x)
							) {
								break;
							}
							endMetric = candidate;
							visualSlot = candidate.index + 1;
						}
						const trailingSpace =
							endMetric.kind === ROW_KIND_FOLDER_CHILD && endMetric.inGroupEnd
								? GROUP_TRAILING_SPACE_PX
								: 0;
						indicatorContentY = endMetric.y + endMetric.height - trailingSpace;
						if (visualBoundaryIndented.value === 1) {
							indent = INDENT_INDICATOR_OFFSET;
						}
					} else if (next?.kind === ROW_KIND_FOLDER_CHILD) {
						indent = INDENT_INDICATOR_OFFSET;
						visualBoundarySlot.value = -1;
						visualBoundaryIndented.value = 0;
					} else {
						visualBoundarySlot.value = -1;
						visualBoundaryIndented.value = 0;
					}

					targetSlot.value = visualSlot;
					const indicatorVisualY =
						visualSlot > activeIndex.value
							? indicatorContentY - activeHeight.value
							: indicatorContentY;
					indicatorTop.value = Math.max(
						0,
						Math.min(
							indicatorVisualY - scrollOffset.value,
							Math.max(0, viewportHeight.value - DROP_INDICATOR_HEIGHT),
						),
					);
					indicatorIndent.value = indent;
					indicatorVisible.value = 1;

					jsMoveFrame.value += 1;
					if (jsMoveFrame.value % 3 === 0) {
						runOnJS(onGestureMove)(event.absoluteX, event.absoluteY);
					}
				})
				.onFinalize((_event, success) => {
					runOnJS(onGestureEnd)(success, _event.absoluteX, _event.absoluteY);
				}),
		[
			activeHeight,
			activeIndex,
			disableDrag,
			grabOffsetY,
			indicatorIndent,
			indicatorTop,
			indicatorVisible,
			index,
			jsMoveFrame,
			onGestureEnd,
			onGestureMove,
			onGestureStart,
			overlayTop,
			rowMetrics,
			scrollOffset,
			targetSlot,
			visualBoundaryIndented,
			visualBoundarySlot,
			visualBoundaryReachedMaxX,
			viewportHeight,
			viewportPageX,
			viewportPageY,
		],
	);

	return (
		<GestureDetector gesture={gesture}>
			<Reanimated.View
				onLayout={(event) => onLayout(itemKey, event)}
				style={[rowStyle, hidden && styles.collapsedRow]}
				pointerEvents={hidden ? 'none' : 'auto'}
			>
				{children}
			</Reanimated.View>
		</GestureDetector>
	);
}

// `children` ref は親側で `flatRowsEqual` ベースの cache により安定している。
// SharedValues / コールバックも全て stable なので、default shallow 比較で
// 該当行以外の再レンダリングをスキップできる。
const DraggableRow = memo(DraggableRowImpl);

const styles = StyleSheet.create({
	listViewport: {
		flex: 1,
	},
	listContent: {
		paddingBottom: Platform.select({ ios: 16, default: 16 }),
	},
	dragOverlay: {
		position: 'absolute',
		top: 0,
		left: 0,
		right: 0,
		zIndex: 20,
		elevation: 12,
		// ドラッグ中アイテムは半透明 → 下のリストの並びが透けて見えて、
		// 「これからどこに落とす」が直感的にわかる。
		opacity: 0.6,
	},
	dropIndicator: {
		position: 'absolute',
		top: 0,
		right: INDICATOR_INSET,
		height: 3,
		borderRadius: 2,
		zIndex: 18,
		elevation: 10,
	},
	collapsedRow: {
		height: 0,
		opacity: 0,
		overflow: 'hidden',
	},
	groupSide: {
		marginHorizontal: 8,
	},
	groupTop: {
		borderTopLeftRadius: 12,
		borderTopRightRadius: 12,
		marginTop: 8,
	},
	groupBottom: {
		borderBottomLeftRadius: 12,
		borderBottomRightRadius: 12,
		marginBottom: 8,
	},
	// folder-child 末尾用: 角は square のまま、下マージンだけ確保。
	groupTrailingSpace: {
		marginBottom: GROUP_TRAILING_SPACE_PX,
	},
});
