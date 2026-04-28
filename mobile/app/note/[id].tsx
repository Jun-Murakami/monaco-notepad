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
import { SyntaxHighlightView } from '@/components/SyntaxHighlightView';
import { MONACO_LANGUAGE_IDS } from '@/constants/monacoLanguages';
import { generateContentHeader } from '@/services/notes/noteService';
import { appSettings } from '@/services/settings/appSettings';
import { driveService } from '@/services/sync/driveService';
import type { Note } from '@/services/sync/types';
import { useNotesStore } from '@/stores/notesStore';

type Mode = 'view' | 'edit';

/**
 * モバイルで選択可能な言語リスト。デスクトップ版 Monaco と同じ ID 体系。
 * `MONACO_LANGUAGE_IDS` は basic-languages に基づく。
 *
 * 現在のノートの language がこのリストに無い場合（将来 Monaco に新言語が追加されて
 * リスト更新前に作られたノート等）でも、`menuLanguages` で先頭に差し込んで保持する。
 */
const LANGUAGES = MONACO_LANGUAGE_IDS;

export default function NoteEditorScreen() {
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const { id } = useLocalSearchParams<{ id: string }>();

	const [note, setNote] = useState<Note | null>(null);
	// 初回ロードが終わったかどうかのフラグ（読み込み中 vs 見つからない の区別用）
	const [loadAttempted, setLoadAttempted] = useState(false);
	const [mode, setMode] = useState<Mode>('view');
	const [langMenuOpen, setLangMenuOpen] = useState(false);
	const [snackbarVisible, setSnackbarVisible] = useState(false);
	// edit モード + キーボード表示中は同期ステータスバーとタイトル欄を畳んで
	// 作業領域を最大化する。Keyboard リスナと連動。
	const [keyboardVisible, setKeyboardVisible] = useState(false);
	// 編集モード突入直後だけカーソルを (0,0) に固定する。これで multiline TextInput
	// が「カーソル位置を表示するために末尾までスクロール」してしまうのを防ぎ、
	// 編集開始時にノート本文の **先頭** から見える。ユーザーがタップしてカーソルを
	// 動かしたら controlled 状態を解除して自由に編集可能に戻す。
	const [editorSelection, setEditorSelection] = useState<
		{ start: number; end: number } | undefined
	>(undefined);
	// 設定画面で変えられる本文フォントサイズ。view (SyntaxHighlightView) と
	// edit (TextInput) の両方に同じ値を使う。
	const [editorFontSize, setEditorFontSize] = useState<number>(
		() => appSettings.snapshot().editorFontSize,
	);
	// Android の multiline TextInput 内蔵スクロールは、通常の ScrollView ほど
	// 慣性スクロールが自然に効かない。外側 ScrollView にスクロールを任せるため、
	// TextInput 自体は本文の contentSize まで縦に伸ばす。
	const [editorContentHeight, setEditorContentHeight] = useState(0);
	const [editorViewportHeight, setEditorViewportHeight] = useState(0);
	useEffect(() => {
		return appSettings.subscribe((s) => setEditorFontSize(s.editorFontSize));
	}, []);
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const latestNoteRef = useRef<Note | null>(null);

	// 編集モードに切り替わるたびに、初回カーソル位置を先頭に固定する。
	useEffect(() => {
		if (mode === 'edit') {
			setEditorSelection({ start: 0, end: 0 });
		} else {
			setEditorSelection(undefined);
		}
	}, [mode]);

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
			keyboardHeight.value = withTiming(fromBottom, {
				duration: e.duration ?? 250,
			});
			setKeyboardVisible(true);
		});
		const hideSub = Keyboard.addListener(hideEv, (e) => {
			keyboardHeight.value = withTiming(0, {
				duration: e.duration ?? 250,
			});
			setKeyboardVisible(false);
		});
		return () => {
			showSub.remove();
			hideSub.remove();
		};
	}, [keyboardHeight]);
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
			setMode('edit');
		}
	}, [id]);

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
				<Appbar.Header>
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

	return (
		<View
			style={[styles.container, { backgroundColor: theme.colors.background }]}
		>
			<Appbar.Header>
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
			    本文の作業領域を最大化する。キーボードを閉じれば再表示される。 */}
			{!(mode === 'edit' && keyboardVisible) && (
				<>
					<SyncStatusBar />
					<PaperTextInput
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
					<Pressable onPress={() => setMode('edit')}>
						<SyntaxHighlightView
							content={note.content}
							language={note.language}
							fontSize={editorFontSize}
						/>
					</Pressable>
				</ScrollView>
			) : (
				<Animated.View
					style={[styles.editorWrapper, editorWrapperStyle]}
					onLayout={(event) =>
						setEditorViewportHeight(event.nativeEvent.layout.height)
					}
				>
					<ScrollView
						style={styles.editorScroller}
						contentContainerStyle={styles.editorScrollContent}
						keyboardShouldPersistTaps="handled"
					>
						<TextInput
							style={[
								styles.editor,
								{
									color: theme.colors.onBackground,
									fontSize: editorFontSize,
									height: Math.max(editorContentHeight, editorViewportHeight),
									lineHeight: Math.round(editorFontSize * 1.55),
								},
							]}
							placeholder={t('editor.contentPlaceholder')}
							placeholderTextColor={theme.colors.onSurfaceVariant}
							multiline
							scrollEnabled={false}
							value={note.content}
							selection={editorSelection}
							onContentSizeChange={handleEditorContentSizeChange}
							onSelectionChange={(e) => {
								// (0,0) でない位置にカーソルが動いたら controlled 解除。
								// 初回 render で (0,0) を当てた直後の onSelectionChange は
								// (0,0) で来るので無視され、ユーザーがタップした瞬間に解放される。
								const s = e.nativeEvent.selection;
								if (editorSelection && (s.start !== 0 || s.end !== 0)) {
									setEditorSelection(undefined);
								}
							}}
							onChangeText={(content) =>
								scheduleSave({
									...note,
									content,
									contentHeader: generateContentHeader(content),
									modifiedTime: new Date().toISOString(),
								})
							}
						/>
					</ScrollView>
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
		paddingTop: 4,
		paddingRight: 16,
		paddingLeft: 8,
		// フロートトグルの下にコンテンツが隠れないよう下余白を確保
		paddingBottom: FLOATING_BAR_CLEARANCE,
	},
	editor: {
		paddingHorizontal: 16,
		paddingTop: 4,
		paddingBottom: 4,
		textAlignVertical: 'top',
		fontFamily: monoFamily,
		fontSize: 14,
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
