import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	Dimensions,
	Keyboard,
	type NativeSyntheticEvent,
	Platform,
	Pressable,
	Text as RNText,
	ScrollView,
	StyleSheet,
	TextInput,
	type TextInputContentSizeChangeEventData,
	View,
} from 'react-native';
import {
	Appbar,
	Icon,
	TextInput as PaperTextInput,
	SegmentedButtons,
	Snackbar,
	Text,
	useTheme,
} from 'react-native-paper';
import Animated, {
	useAnimatedStyle,
	useSharedValue,
	withTiming,
} from 'react-native-reanimated';
import { LanguagePicker } from '@/components/LanguagePicker';
import { SyncStatusBar } from '@/components/SyncStatusBar';
import {
	type SyntaxHighlightPressPosition,
	SyntaxHighlightView,
} from '@/components/SyntaxHighlightView';
import { SUPPORTED_MONACO_IDS } from '@/lib/syntaxHighlight/languageMap';
import {
	getTextInputCaretRect,
	scrollTextInputCaretToVisibleCenter,
	suppressTextInputAutoScroll,
} from '@/native/caretPosition';
import { generateContentHeader } from '@/services/notes/noteService';
import { appSettings } from '@/services/settings/appSettings';
import { driveService } from '@/services/sync/driveService';
import type { Note } from '@/services/sync/types';
import { useNotesStore } from '@/stores/notesStore';

type Mode = 'view' | 'edit';
type EditorSelection = { start: number; end: number };
interface EditorScrollMeasurement {
	text: string;
	animated: boolean;
	nonce: number;
}

/**
 * モバイルで選択可能な言語リスト。Monaco の全言語のうち Shiki がハイライト
 * 可能なものだけをピッカーに出す。デスクトップで未対応 ID が選ばれている
 * ノートを開いた場合は `menuLanguages` で先頭に差し込んで保持する（その場合は
 * SyntaxHighlightView 側で plaintext フォールバック描画）。
 */
const LANGUAGES = SUPPORTED_MONACO_IDS;

export default function NoteEditorScreen() {
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const { id, initialFocus } = useLocalSearchParams<{
		id: string;
		initialFocus?: string;
	}>();

	const [note, setNote] = useState<Note | null>(null);
	// 初回ロードが終わったかどうかのフラグ（読み込み中 vs 見つからない の区別用）
	const [loadAttempted, setLoadAttempted] = useState(false);
	const [mode, setMode] = useState<Mode>('view');
	const [langMenuOpen, setLangMenuOpen] = useState(false);
	const [snackbarVisible, setSnackbarVisible] = useState(false);
	// edit モード + キーボード表示中は同期ステータスバーとタイトル欄を畳んで
	// 作業領域を最大化する。Keyboard リスナと連動。
	const [keyboardVisible, setKeyboardVisible] = useState(false);
	// タイトル欄に focus がある時はキーボード表示中でもタイトル欄を残す。
	// （畳むと unmount → focus 喪失 → キーボード閉じる、で編集できなくなるため）
	const [titleFocused, setTitleFocused] = useState(false);
	// 編集モード突入直後だけカーソルを (0,0) に固定する。これで multiline TextInput
	// が「カーソル位置を表示するために末尾までスクロール」してしまうのを防ぎ、
	// 編集開始時にノート本文の **先頭** から見える。閲覧モードの本文タップで
	// 入った場合は、閲覧表示が実レイアウトから返した行・桁を初回 selection に使う。
	// 初回 focus 後は controlled 状態を解除して、iOS の自動 scrollRangeToVisible と
	// 手動 contentOffset 補正が競合しないようにする。
	const [editorSelection, setEditorSelection] = useState<
		EditorSelection | undefined
	>(undefined);
	// 設定画面で変えられる本文フォントサイズ。view (SyntaxHighlightView) と
	// edit (TextInput) の両方に同じ値を使う。
	const [editorFontSize, setEditorFontSize] = useState<number>(
		() => appSettings.snapshot().editorFontSize,
	);
	const editorFontSizeRef = useRef(editorFontSize);
	const isIOS = Platform.OS === 'ios';
	// Android の multiline TextInput 内蔵スクロールは、通常の ScrollView ほど
	// 慣性スクロールが自然に効かない。外側 ScrollView にスクロールを任せるため、
	// TextInput 自体は本文の contentSize まで縦に伸ばす。
	// iOS は逆に、この構成だと削除/改行で contentSize が激しく変わった時に
	// TextInput のネイティブ描画領域と RN 側の高さ指定がズレ、途中行までしか
	// 表示・編集できないことがあるため、後段の render で内蔵スクロールに分岐する。
	const [editorContentHeight, setEditorContentHeight] = useState(0);
	const [editorViewportHeight, setEditorViewportHeight] = useState(0);
	const [editorTextWidth, setEditorTextWidth] = useState(0);
	const [editorScrollMeasurement, setEditorScrollMeasurement] =
		useState<EditorScrollMeasurement | null>(null);
	const editorViewportHeightRef = useRef(0);
	const editorInputHeightRef = useRef(0);
	const editorKeyboardInsetRef = useRef(0);
	useEffect(() => {
		return appSettings.subscribe((s) => setEditorFontSize(s.editorFontSize));
	}, []);
	useEffect(() => {
		editorFontSizeRef.current = editorFontSize;
	}, [editorFontSize]);
	useEffect(() => {
		editorViewportHeightRef.current = editorViewportHeight;
	}, [editorViewportHeight]);
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const latestNoteRef = useRef<Note | null>(null);
	const titleInputRef = useRef<{ focus: () => void } | null>(null);
	const editorRef = useRef<TextInput>(null);
	const androidEditorScrollerRef = useRef<ScrollView>(null);
	const pendingInitialSelectionRef = useRef<EditorSelection | null>(null);
	const pendingEditorCursorOffsetRef = useRef<number | null>(null);
	const lastEditorCursorOffsetRef = useRef<number | null>(null);
	const scrollMeasurementNonceRef = useRef(0);
	const keyboardSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const pendingFocusRef = useRef(false);
	const pendingTitleFocusRef = useRef(false);

	const getEditorVisibilityMetrics = useCallback(
		(lineHeight: number) => {
			const wrapperHeight = editorViewportHeightRef.current;
			const keyboardInset = editorKeyboardInsetRef.current;
			const wrapperVisibleHeight = Math.max(0, wrapperHeight - keyboardInset);
			const measuredInputHeight = editorInputHeightRef.current;
			const inputVisibleHeight =
				measuredInputHeight > 0 ? measuredInputHeight : wrapperVisibleHeight;
			const baseVisibleHeight = Math.max(
				lineHeight,
				Math.min(
					wrapperVisibleHeight || lineHeight,
					inputVisibleHeight || lineHeight,
				),
			);

			if (!isIOS) {
				return { visibleHeight: baseVisibleHeight, bottomInset: 0 };
			}

			const layoutConsumedKeyboardInset =
				measuredInputHeight > 0
					? Math.max(0, wrapperHeight - measuredInputHeight)
					: 0;
			const remainingKeyboardInset = Math.max(
				0,
				keyboardInset - layoutConsumedKeyboardInset,
			);

			return {
				// iOS は TextInput 自身の内部スクロールなので、キーボードだけでなく
				// キーボード上へ移動したフロート切替バーの占有分も中央寄せ範囲から外す。
				visibleHeight: Math.max(
					lineHeight,
					baseVisibleHeight - FLOATING_BAR_CLEARANCE,
				),
				// TextInput のレイアウトがキーボード分だけ縮んだ後は bar 分だけを
				// contentInset に残す。縮む前は未反映のキーボード分も inset に足して、
				// アニメーション中でも末尾付近へスクロールできる余地を確保する。
				bottomInset: remainingKeyboardInset + FLOATING_BAR_CLEARANCE,
			};
		},
		[isIOS],
	);

	const releaseInitialEditorSelection = useCallback(() => {
		setEditorSelection((current) => (current ? undefined : current));
	}, []);

	const applyEditorScroll = useCallback(
		async (cursorVisualY: number, caretHeight: number, animated: boolean) => {
			const lineHeight = Math.round(editorFontSizeRef.current * 1.55);
			const { visibleHeight } = getEditorVisibilityMetrics(lineHeight);
			const targetY = Math.max(
				0,
				cursorVisualY - visibleHeight / 2 + Math.max(caretHeight, lineHeight),
			);

			if (isIOS) {
				editorRef.current?.setNativeProps({
					contentOffset: { x: 0, y: targetY },
				});
			} else {
				androidEditorScrollerRef.current?.scrollTo({
					y: targetY,
					animated,
				});
			}
		},
		[getEditorVisibilityMetrics, isIOS],
	);

	const centerEditorAroundCursor = useCallback(
		async (cursorOffset: number, animated = false) => {
			const lineHeight = Math.round(editorFontSizeRef.current * 1.55);
			const { visibleHeight, bottomInset } =
				getEditorVisibilityMetrics(lineHeight);
			if (isIOS) {
				const applied = await scrollTextInputCaretToVisibleCenter(
					editorRef.current,
					cursorOffset,
					visibleHeight,
					bottomInset,
					animated,
				);
				if (applied) return;
			}

			const content = latestNoteRef.current?.content ?? '';
			const nativeRect = await getTextInputCaretRect(
				editorRef.current,
				cursorOffset,
			);
			if (nativeRect) {
				// ネイティブ側で TextInput 自身の Layout から caret rect を取得できる場合は、
				// 推定ではなく実キャレット位置をそのまま中央寄せに使う。
				applyEditorScroll(nativeRect.y, nativeRect.height, animated);
				return;
			}

			// Expo Go / prebuild 前など native module がない環境では、編集 TextInput と
			// 同じ幅・フォントの不可視 Text で caret 直前までを実レイアウトする。
			setEditorScrollMeasurement({
				text: buildCaretMeasurementText(content.slice(0, cursorOffset)),
				animated,
				nonce: scrollMeasurementNonceRef.current + 1,
			});
			scrollMeasurementNonceRef.current += 1;
		},
		[applyEditorScroll, getEditorVisibilityMetrics, isIOS],
	);

	const applyMeasuredEditorScroll = useCallback(
		(visualLineCount: number, animated: boolean) => {
			const lineHeight = Math.round(editorFontSizeRef.current * 1.55);
			applyEditorScroll(
				EDITOR_VERTICAL_PADDING_TOP +
					Math.max(0, visualLineCount - 1) * lineHeight,
				lineHeight,
				animated,
			);
		},
		[applyEditorScroll],
	);

	const focusEditorWithInitialSelection = useCallback(
		(initialSelection: EditorSelection, initialCursorOffset: number | null) => {
			lastEditorCursorOffsetRef.current = initialCursorOffset;
			pendingFocusRef.current = true;
			setEditorSelection(initialSelection);

			// 条件付き render で TextInput が mount された直後に focus する。
			// selection を先に state へ入れておくと、ソフトキーボード表示時に
			// 先頭や末尾へ飛ばず、閲覧モードでタップした位置から編集を始められる。
			requestAnimationFrame(async () => {
				if (!pendingFocusRef.current) return;
				if (isIOS) {
					// iOS: focus() 時に UIKit が scrollRangeToVisible を自動実行し、
					// キーボード未考慮の bounds.height で不正なスクロールを行う。
					// scrollEnabled を一時的に false にして抑制する。
					// scrollCaretToVisibleCenter が true に戻す。
					await suppressTextInputAutoScroll();
				}
				editorRef.current?.focus();
				if (initialCursorOffset !== null && !isIOS) {
					// Android: mount 直後に中央寄せする。keyboardDidShow 後に再補正。
					centerEditorAroundCursor(initialCursorOffset);
				}
				pendingFocusRef.current = false;
				if (!isIOS) {
					// Android: controlled selection を即座に解放する。
					requestAnimationFrame(releaseInitialEditorSelection);
				}
				// iOS: controlled selection の解放はキーボード表示後の effect まで遅延する。
				// 先に解放すると UIKit の scrollRangeToVisible が発火し、
				// キーボード高さを考慮しない位置へスクロールされてしまう。
			});
		},
		[centerEditorAroundCursor, isIOS, releaseInitialEditorSelection],
	);

	// 編集モードに切り替わるたびに、初回カーソル位置とフォーカスをまとめて適用する。
	useEffect(() => {
		if (mode === 'edit') {
			if (pendingTitleFocusRef.current) {
				pendingTitleFocusRef.current = false;
				pendingFocusRef.current = false;
				setEditorSelection(undefined);
				requestAnimationFrame(() => titleInputRef.current?.focus());
				return;
			}

			const initialSelection = pendingInitialSelectionRef.current ?? {
				start: 0,
				end: 0,
			};
			const initialCursorOffset = pendingEditorCursorOffsetRef.current;
			pendingInitialSelectionRef.current = null;
			pendingEditorCursorOffsetRef.current = null;
			focusEditorWithInitialSelection(initialSelection, initialCursorOffset);
		} else {
			pendingFocusRef.current = false;
			pendingTitleFocusRef.current = false;
			pendingInitialSelectionRef.current = null;
			pendingEditorCursorOffsetRef.current = null;
			lastEditorCursorOffsetRef.current = null;
			setEditorScrollMeasurement(null);
			setEditorSelection(undefined);
		}
	}, [focusEditorWithInitialSelection, mode]);

	useEffect(() => {
		if (mode !== 'edit' || !keyboardVisible) return;
		const cursorOffset = lastEditorCursorOffsetRef.current;
		if (cursorOffset === null) return;

		// キーボード表示開始時に一度中央へ寄せる。
		// Android は外側 ScrollView、iOS は TextInput の native contentOffset へ適用する。
		requestAnimationFrame(() => {
			centerEditorAroundCursor(cursorOffset, true);
			if (isIOS) {
				// iOS: キーボード考慮済みのスクロール適用後に controlled selection を解放する。
				// これより前に解放すると UIKit の scrollRangeToVisible が発火し、
				// キーボード高さ未考慮の位置へ戻されてしまう。
				requestAnimationFrame(releaseInitialEditorSelection);
			}
		});
	}, [
		centerEditorAroundCursor,
		isIOS,
		keyboardVisible,
		mode,
		releaseInitialEditorSelection,
	]);

	// キーボード追従の式は bar とエディタ wrapper でセットになっている。
	//   - bar: 通常時 `bottom: 32` から、キーボード上 8px (= 24px 縮める) まで上げる。
	//     `min(0, 24 - kh)` を translateY に当てると、kh = 0 なら 0、kh > 24 なら
	//     `24 - kh` (負値) で上昇する。
	//   - editor wrapper: bar 直下まで content を伸ばすため `max(0, kh - 24)` を
	//     paddingBottom に。kh = 0 なら 0 (= bar が常時 32 上にあるので余分な
	//     padding 不要)、kh > 24 なら kh - 24 で TextInput 領域をキーボード分縮める。
	//
	// `useAnimatedKeyboard` は新アーキ + edge-to-edge の Android 端末で閉じている
	// ときも非ゼロを返すケースがある。RN 標準の `Keyboard.addListener` で
	// 「閉じる/開く」を確実に検出し、`withTiming` でアニメーションさせる方式にする。
	const keyboardHeight = useSharedValue(0);
	useEffect(() => {
		const showEv =
			Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
		const hideEv =
			Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
		const showSub = Keyboard.addListener(showEv, (e) => {
			// edge-to-edge の Android では `e.endCoordinates.height` がキーボードの
			// 「app content area から見た高さ」 (nav bar 分含まず) を返すケースがある。
			// 物理 screen bottom からキーボード上端までの距離を得るため、
			// `screen.height - screenY` で計算しなおす。
			const screenHeight = Dimensions.get('screen').height;
			const fromBottom = Math.max(
				e.endCoordinates.height,
				screenHeight - e.endCoordinates.screenY,
			);
			editorKeyboardInsetRef.current = Math.max(0, fromBottom - 24);
			keyboardHeight.value = withTiming(fromBottom, {
				duration: e.duration ?? 250,
			});
			setKeyboardVisible(true);
			if (Platform.OS === 'ios') {
				if (keyboardSettleTimerRef.current) {
					clearTimeout(keyboardSettleTimerRef.current);
				}
				keyboardSettleTimerRef.current = setTimeout(
					() => {
						const cursorOffset = lastEditorCursorOffsetRef.current;
						if (cursorOffset === null) return;
						// iOS は keyboardWillShow 後に UIKit / TextInput 側の
						// selection 自動スクロールが走ることがある。アニメーション完了後に
						// native caret rect を取り直して、キーボード込みの可視領域へ再配置する。
						requestAnimationFrame(() =>
							centerEditorAroundCursor(cursorOffset, true),
						);
					},
					(e.duration ?? 250) + 150,
				);
			}
		});
		const hideSub = Keyboard.addListener(hideEv, (e) => {
			if (keyboardSettleTimerRef.current) {
				clearTimeout(keyboardSettleTimerRef.current);
				keyboardSettleTimerRef.current = null;
			}
			editorKeyboardInsetRef.current = 0;
			keyboardHeight.value = withTiming(0, {
				duration: e.duration ?? 250,
			});
			setKeyboardVisible(false);
		});
		return () => {
			if (keyboardSettleTimerRef.current) {
				clearTimeout(keyboardSettleTimerRef.current);
				keyboardSettleTimerRef.current = null;
			}
			showSub.remove();
			hideSub.remove();
		};
	}, [centerEditorAroundCursor, keyboardHeight]);
	const floatingBarStyle = useAnimatedStyle(() => ({
		transform: [{ translateY: Math.min(0, 24 - keyboardHeight.value) }],
	}));
	const editorWrapperStyle = useAnimatedStyle(() => ({
		paddingBottom: Math.max(0, keyboardHeight.value - 24),
	}));

	// 現在のノートの言語がリストに無ければ先頭に差し込む（デスクトップ由来の Monaco 専用言語を
	// 失わないようにするため。触らない限り language は変わらない）。
	const menuLanguages = useMemo<readonly string[]>(() => {
		const current = note?.language?.trim();
		if (!current) return LANGUAGES;
		// `LANGUAGES` は literal 型 readonly 配列なので、任意 string で includes するには
		// 一度 string 配列として扱う。
		if ((LANGUAGES as readonly string[]).includes(current)) return LANGUAGES;
		return [current, ...LANGUAGES];
	}, [note?.language]);

	const reload = useCallback(async () => {
		if (!id) return;
		const loaded = await useNotesStore.getState().getNote(id);
		setNote(loaded);
		latestNoteRef.current = loaded;
		setLoadAttempted(true);
		if (loaded && loaded.content.length === 0 && loaded.title.length === 0) {
			pendingTitleFocusRef.current = initialFocus === 'title';
			setMode('edit');
		}
	}, [id, initialFocus]);

	useEffect(() => {
		reload();
	}, [reload]);

	const scheduleSave = useCallback((next: Note) => {
		setNote(next);
		latestNoteRef.current = next;
		if (saveTimer.current) clearTimeout(saveTimer.current);
		saveTimer.current = setTimeout(() => {
			driveService.saveNoteAndSync(next).catch((e) => console.warn(e));
		}, 600);
	}, []);

	// 画面離脱時に pending 変更を flush する（デスクトップ版の beforeclose 相当）
	useEffect(
		() => () => {
			if (saveTimer.current) clearTimeout(saveTimer.current);
			const n = latestNoteRef.current;
			if (n) driveService.saveNoteAndSync(n).catch(() => {});
		},
		[],
	);

	if (!note) {
		return (
			<View
				style={[styles.container, { backgroundColor: theme.colors.background }]}
			>
				<Appbar.Header mode="small">
					<Appbar.BackAction onPress={() => router.back()} />
					<Appbar.Content title="" />
				</Appbar.Header>
				<View style={styles.loadingOrErrorBox}>
					<Text
						variant="bodyMedium"
						style={{ color: theme.colors.onSurfaceVariant }}
					>
						{loadAttempted ? t('editor.noteNotFound') : t('editor.loadingNote')}
					</Text>
				</View>
			</View>
		);
	}

	const handleDelete = async () => {
		await driveService.deleteNoteAndSync(note.id);
		router.back();
	};

	const handleArchive = () => {
		const next = {
			...note,
			archived: !note.archived,
			modifiedTime: new Date().toISOString(),
		};
		scheduleSave(next);
	};

	const handleCopyAll = async () => {
		if (!note) return;
		await Clipboard.setStringAsync(note.content ?? '');
		setSnackbarVisible(true);
	};
	const handleEditorContentSizeChange = (
		event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>,
	) => {
		setEditorContentHeight(event.nativeEvent.contentSize.height);
	};
	const handleEditorLayout = (width: number, height: number) => {
		editorInputHeightRef.current = height;
		const textWidth = Math.max(1, width - EDITOR_HORIZONTAL_PADDING * 2);
		setEditorTextWidth(textWidth);
		const cursorOffset = lastEditorCursorOffsetRef.current;
		if (mode === 'edit' && cursorOffset !== null) {
			// iOS: キーボード出現前のレイアウトイベントでスクロールすると、
			// 全画面高さで中央寄せされ、キーボードが出た後にキャレットが隠れてしまう。
			// キーボード高さが確定してからスクロールする。
			if (isIOS && editorKeyboardInsetRef.current === 0) return;
			// TextInput の実幅が取れたタイミングで、編集 Text と同じ幅の
			// 計測用 Text を再レイアウトし、実キャレット行に基づいてスクロールする。
			requestAnimationFrame(() => centerEditorAroundCursor(cursorOffset));
		}
	};
	const handleEditorSelectionChange = (e: {
		nativeEvent: { selection: { start: number; end: number } };
	}) => {
		// 初回 selection と違う位置へカーソルが動いたら controlled 解除。
		// 初回 render 直後の onSelectionChange は同じ selection で来るため無視し、
		// 以後のユーザー操作や IME 側の調整からは TextInput に任せる。
		const s = e.nativeEvent.selection;
		if (
			editorSelection &&
			(s.start !== editorSelection.start || s.end !== editorSelection.end)
		) {
			setEditorSelection(undefined);
		}
	};
	const handleViewerPressPosition = (
		position: SyntaxHighlightPressPosition,
	) => {
		const ranges = buildContentLineRanges(note.content);
		const range = ranges[Math.min(position.lineIndex, ranges.length - 1)];
		const offset = Math.min(range.end, range.start + position.column);
		pendingInitialSelectionRef.current = { start: offset, end: offset };
		pendingEditorCursorOffsetRef.current = offset;
		setMode('edit');
	};
	const handleContentChange = (content: string) => {
		scheduleSave({
			...note,
			content,
			contentHeader: generateContentHeader(content),
			modifiedTime: new Date().toISOString(),
		});
	};
	const handleTitleSubmitEditing = () => {
		focusEditorWithInitialSelection({ start: 0, end: 0 }, 0);
	};
	const editorBaseStyle = {
		color: theme.colors.onBackground,
		fontSize: editorFontSize,
		lineHeight: Math.round(editorFontSize * 1.55),
	};

	return (
		<View
			style={[styles.container, { backgroundColor: theme.colors.background }]}
		>
			<Appbar.Header mode="small">
				<Appbar.BackAction onPress={() => router.back()} />
				{/* タイトルは下のボディに表示するので AppBar 側は空の Content で
				    スペーサとして使い、右側にアクション類を寄せる。 */}
				<Appbar.Content title="" />
				<Pressable
					onPress={() => setLangMenuOpen(true)}
					android_ripple={{ color: theme.colors.surfaceVariant }}
					style={[
						styles.langButton,
						{ backgroundColor: theme.colors.surfaceVariant },
					]}
				>
					<Icon
						source="code-tags"
						size={16}
						color={theme.colors.onSurfaceVariant}
					/>
					<Text
						variant="labelMedium"
						style={[styles.langLabel, { color: theme.colors.onSurfaceVariant }]}
					>
						{note.language}
					</Text>
					<Icon
						source="menu-down"
						size={18}
						color={theme.colors.onSurfaceVariant}
					/>
				</Pressable>
				{mode === 'view' && (
					<Appbar.Action icon="content-copy" onPress={handleCopyAll} />
				)}
				<Appbar.Action
					icon={note.archived ? 'archive-off' : 'archive'}
					onPress={handleArchive}
				/>
				{/* 削除はアーカイブ済みノートからのみ可能。アーカイブ一覧から開いた
				    詳細ページでだけ表示される（active ノートはアーカイブを経由してから削除）。 */}
				{note.archived && (
					<Appbar.Action icon="trash-can" onPress={handleDelete} />
				)}
			</Appbar.Header>
			{/* edit モード + キーボード表示中は同期バーとタイトル欄を畳んで
			    本文の作業領域を最大化する。キーボードを閉じれば再表示される。
			    ただしタイトル欄自身に focus がある間は畳まない（タップ直後の
			    キーボード表示で unmount されると編集が成立しないため）。 */}
			{!(mode === 'edit' && keyboardVisible && !titleFocused) && (
				<>
					<SyncStatusBar />
					<PaperTextInput
						ref={(ref: { focus: () => void } | null) => {
							titleInputRef.current = ref;
						}}
						mode="outlined"
						label={t('editor.titleLabel')}
						placeholder={t('editor.titlePlaceholder')}
						value={note.title}
						onChangeText={(title) =>
							scheduleSave({
								...note,
								title,
								modifiedTime: new Date().toISOString(),
							})
						}
						onSubmitEditing={handleTitleSubmitEditing}
						onFocus={() => setTitleFocused(true)}
						onBlur={() => setTitleFocused(false)}
						returnKeyType="next"
						submitBehavior="submit"
						style={styles.titleInput}
						dense
						// label / アウトラインは theme.colors.onSurfaceVariant を使うが、
						// contrast を上げた本テーマだと濃すぎる。ここだけ outline（やや淡い色）に寄せる。
						theme={{
							colors: {
								onSurfaceVariant: theme.colors.outline,
							},
						}}
					/>
				</>
			)}
			{mode === 'view' ? (
				<ScrollView
					style={styles.viewer}
					contentContainerStyle={styles.viewerContent}
				>
					{/* タップで即編集モードへ。コピーは AppBar 右の content-copy ボタンから。 */}
					<SyntaxHighlightView
						content={note.content}
						language={note.language}
						fontSize={editorFontSize}
						onPressPosition={handleViewerPressPosition}
					/>
				</ScrollView>
			) : (
				<Animated.View
					style={[styles.editorWrapper, editorWrapperStyle]}
					onLayout={(event) =>
						setEditorViewportHeight(event.nativeEvent.layout.height)
					}
				>
					{editorScrollMeasurement && editorTextWidth > 0 && (
						<RNText
							key={editorScrollMeasurement.nonce}
							style={[
								styles.editorMeasureText,
								editorBaseStyle,
								{ width: editorTextWidth },
							]}
							onTextLayout={(event) => {
								applyMeasuredEditorScroll(
									event.nativeEvent.lines.length,
									editorScrollMeasurement.animated,
								);
								setEditorScrollMeasurement(null);
							}}
						>
							{editorScrollMeasurement.text}
						</RNText>
					)}
					{isIOS ? (
						<TextInput
							ref={editorRef}
							style={[styles.editor, styles.iosEditor, editorBaseStyle]}
							onLayout={(event) =>
								handleEditorLayout(
									event.nativeEvent.layout.width,
									event.nativeEvent.layout.height,
								)
							}
							placeholder={t('editor.contentPlaceholder')}
							placeholderTextColor={theme.colors.onSurfaceVariant}
							multiline
							// iOS は UITextView 相当の TextInput 内部スクロールが安定している。
							// 外側 ScrollView に高さ追従させると、改行/削除で contentSize が
							// 瞬間的に小さくなった時に描画領域が欠けることがある。
							scrollEnabled
							value={note.content}
							selection={editorSelection}
							onSelectionChange={handleEditorSelectionChange}
							onChangeText={handleContentChange}
						/>
					) : (
						<ScrollView
							ref={androidEditorScrollerRef}
							style={styles.editorScroller}
							contentContainerStyle={styles.editorScrollContent}
							keyboardShouldPersistTaps="handled"
						>
							<TextInput
								ref={editorRef}
								style={[
									styles.editor,
									editorBaseStyle,
									{
										height: Math.max(editorContentHeight, editorViewportHeight),
									},
								]}
								onLayout={(event) =>
									handleEditorLayout(
										event.nativeEvent.layout.width,
										event.nativeEvent.layout.height,
									)
								}
								placeholder={t('editor.contentPlaceholder')}
								placeholderTextColor={theme.colors.onSurfaceVariant}
								multiline
								scrollEnabled={false}
								value={note.content}
								selection={editorSelection}
								onContentSizeChange={handleEditorContentSizeChange}
								onSelectionChange={handleEditorSelectionChange}
								onChangeText={handleContentChange}
							/>
						</ScrollView>
					)}
				</Animated.View>
			)}
			<LanguagePicker
				visible={langMenuOpen}
				current={note.language}
				languages={menuLanguages}
				onSelect={(lang) => {
					setLangMenuOpen(false);
					scheduleSave({
						...note,
						language: lang,
						modifiedTime: new Date().toISOString(),
					});
				}}
				onDismiss={() => setLangMenuOpen(false)}
			/>
			<Animated.View
				style={[
					styles.floatingModeBar,
					{
						backgroundColor: theme.colors.background,
						shadowColor: '#000',
					},
					floatingBarStyle,
				]}
				pointerEvents="box-none"
			>
				<SegmentedButtons
					value={mode}
					onValueChange={(v) => {
						// 編集中 TextInput がフォーカス状態のまま unmount されると
						// Android が次の TextInput（= タイトル）にフォーカスを移してしまう。
						// 明示的に keyboard を dismiss してフォーカスを外す。
						Keyboard.dismiss();
						setMode(v as Mode);
					}}
					buttons={[
						{ value: 'view', label: t('editor.view'), icon: 'eye' },
						{
							value: 'edit',
							label: t('editor.edit'),
							icon: 'pencil',
							checkedColor: theme.colors.onPrimary,
							style:
								mode === 'edit'
									? { backgroundColor: theme.colors.primary }
									: undefined,
						},
					]}
				/>
			</Animated.View>
			<Snackbar
				visible={snackbarVisible}
				onDismiss={() => setSnackbarVisible(false)}
				duration={1500}
				// 下部は Android の「クリップボードに保存しました」OS UI と被るため上部に出す。
				// Paper Snackbar の wrapperStyle は absolute, bottom: 0 がデフォルトなので
				// bottom を unset + top を指定する。
				wrapperStyle={styles.snackbarWrapper}
			>
				{t('editor.copied')}
			</Snackbar>
		</View>
	);
}

const monoFamily = Platform.select({
	ios: 'Menlo',
	android: 'monospace',
	default: 'monospace',
});

// フロートトグルの自身の高さ (SegmentedButtons ~40) + 上下 padding (8*2) + 下余白 (16)
const FLOATING_BAR_CLEARANCE = 80;
const VIEWER_CONTENT_PADDING_TOP = 4;
const VIEWER_CONTENT_PADDING_RIGHT = 16;
const VIEWER_CONTENT_PADDING_LEFT = 8;
const EDITOR_HORIZONTAL_PADDING = 16;
const EDITOR_VERTICAL_PADDING_TOP = 4;

interface ContentLineRange {
	start: number;
	end: number;
	text: string;
}

function buildCaretMeasurementText(prefix: string): string {
	// 空文字や改行直後の caret も Text.onTextLayout で 1 行として測れるよう、
	// 視覚的な幅をほぼ持たないゼロ幅スペースを caret 位置に置く。
	return `${prefix}\u200b`;
}

function buildContentLineRanges(content: string): ContentLineRange[] {
	if (content.length === 0) {
		return [{ start: 0, end: 0, text: '' }];
	}

	const ranges: ContentLineRange[] = [];
	let start = 0;
	for (let i = 0; i < content.length; i++) {
		if (content[i] !== '\n') continue;
		const end = i > start && content[i - 1] === '\r' ? i - 1 : i;
		ranges.push({ start, end, text: content.slice(start, end) });
		start = i + 1;
	}
	const end =
		content.length > start && content[content.length - 1] === '\r'
			? content.length - 1
			: content.length;
	ranges.push({ start, end, text: content.slice(start, end) });
	return ranges;
}

const styles = StyleSheet.create({
	container: { flex: 1 },
	titleInput: {
		marginHorizontal: 12,
		marginTop: 8,
		marginBottom: 4,
	},
	editorWrapper: {
		flex: 1,
	},
	editorScroller: {
		flex: 1,
	},
	iosEditor: {
		flex: 1,
		// TextInput 内部スクロール時も、本文末尾がフロート切替バーの裏に
		// 潜らないように TextInput 側へ下余白を持たせる。
		paddingBottom: FLOATING_BAR_CLEARANCE,
	},
	editorScrollContent: {
		// TextInput 自体は scrollEnabled=false で縦に伸ばし、ScrollView に
		// フリング/慣性スクロールを担当させる。下余白はフロート切替バーに
		// 本文末尾が隠れないよう ScrollView 側へ持たせる。
		paddingBottom: FLOATING_BAR_CLEARANCE,
	},
	viewer: {
		flex: 1,
	},
	viewerContent: {
		// 行番号カラムの分だけ左は少なめの padding、右/上は通常
		paddingTop: VIEWER_CONTENT_PADDING_TOP,
		paddingRight: VIEWER_CONTENT_PADDING_RIGHT,
		paddingLeft: VIEWER_CONTENT_PADDING_LEFT,
		// フロートトグルの下にコンテンツが隠れないよう下余白を確保
		paddingBottom: FLOATING_BAR_CLEARANCE,
	},
	editor: {
		paddingHorizontal: EDITOR_HORIZONTAL_PADDING,
		paddingTop: EDITOR_VERTICAL_PADDING_TOP,
		paddingBottom: 4,
		textAlignVertical: 'top',
		fontFamily: monoFamily,
		fontSize: 14,
	},
	editorMeasureText: {
		position: 'absolute',
		left: -10000,
		top: 0,
		fontFamily: monoFamily,
		includeFontPadding: false,
		opacity: 0,
	},
	floatingModeBar: {
		position: 'absolute',
		left: 16,
		right: 16,
		bottom: 32,
		borderRadius: 24,
		elevation: 4,
		shadowOffset: { width: 0, height: 2 },
		shadowOpacity: 0.2,
		shadowRadius: 4,
	},
	langButton: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingHorizontal: 8,
		paddingVertical: 4,
		borderRadius: 14,
		marginRight: 4,
		gap: 4,
	},
	langLabel: {
		marginHorizontal: 2,
	},
	snackbarWrapper: {
		// Paper Snackbar のデフォルトは position: absolute, bottom: 0。
		// bottom を unset して top を指定することで、AppBar + SyncStatusBar +
		// タイトル入力欄より下（= 本文の直上付近）に表示する。
		// 概算: StatusBar(24) + AppBar(56) + SyncStatusBar(32) + TitleInput(~56) ≒ 168
		top: 180,
		bottom: undefined,
	},
	loadingOrErrorBox: {
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
		padding: 24,
	},
});
