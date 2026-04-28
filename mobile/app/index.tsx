import { useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type GestureResponderEvent, StyleSheet, View } from 'react-native';
import {
	Appbar,
	Button,
	Dialog,
	Divider,
	Portal,
	Text,
	TextInput,
	useTheme,
} from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
	FolderContextMenu,
	type FolderMenuItem,
} from '@/components/FolderContextMenu';
import {
	ManualDragNoteList,
	type ManualReorderEvent,
} from '@/components/ManualDragNoteList';
import { SearchAppbar } from '@/components/SearchAppbar';
import { SyncStatusBar } from '@/components/SyncStatusBar';
import { useDeferredEmpty } from '@/hooks/useDeferredEmpty';
import { useNoteSearch } from '@/hooks/useNoteSearch';
import { noteService } from '@/services/notes/noteService';
import { driveService } from '@/services/sync/driveService';
import { syncStateManager } from '@/services/sync/syncState';
import { useAuthStore } from '@/stores/authStore';
import { useNotesStore } from '@/stores/notesStore';
import {
	applyDropIntent,
	type FlatRow,
	flattenNoteList,
} from '@/utils/flatTree';
import { optimisticToggleNoteArchived } from '@/utils/noteListOptimistic';
import { scheduleAfterPaint } from '@/utils/scheduleAfterPaint';
import { filterRowsBySearch } from '@/utils/searchFilter';
import { uuidv4 } from '@/utils/uuid';

export default function NoteListScreen() {
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const insets = useSafeAreaInsets();
	const noteList = useNotesStore((s) => s.noteList);
	const signedIn = useAuthStore((s) => s.signedIn);

	// 折り畳まれたフォルダの子も **mount したまま** にし、`hidden` プロップで非表示にする。
	// 開閉のたびに unmount/mount すると `ReanimatedSwipeable` の native gesture handler が
	// 大量に作り直され、Android 側で system-UI ANR を引き起こすため。
	const rawRows = useMemo<FlatRow[]>(
		() => flattenNoteList(noteList, { includeCollapsedChildren: true }),
		[noteList],
	);

	// 全文検索 (本文ファイル含む)。debounce 込み。matchingIds が null の間は
	// フィルタなし、Set が入ったら絞り込み。
	const search = useNoteSearch(noteList.notes);
	const rows = useMemo<FlatRow[]>(
		() => filterRowsBySearch(rawRows, search.matchingIds),
		[rawRows, search.matchingIds],
	);

	// active 表示分のノート件数（ボトムバーに表示）
	const activeNoteCount = useMemo(
		() => noteList.notes.filter((n) => !n.archived).length,
		[noteList.notes],
	);

	// 空リスト placeholder の表示は少し遅延させ、同期/状態更新の途中で
	// 一瞬空配列になるケース（フォルダごとアーカイブ実行直後等）の
	// チラつきを抑える。
	const showEmpty = useDeferredEmpty(rows.length === 0);

	const optimisticRevisionRef = useRef(0);
	const pendingFolderBodyNoteIdsRef = useRef<Set<string>>(new Set());

	// フォルダヘッダのドットメニュー state
	const [folderMenu, setFolderMenu] = useState<{
		anchor: { x: number; y: number };
		folderId: string;
	} | null>(null);

	// 新規フォルダ / リネーム / アーカイブ確認 dialog state
	const [createFolderDialog, setCreateFolderDialog] = useState(false);
	const [renameFolderDialog, setRenameFolderDialog] = useState<{
		folderId: string;
	} | null>(null);
	const [archiveFolderDialog, setArchiveFolderDialog] = useState<{
		folderId: string;
		name: string;
		count: number;
	} | null>(null);
	const [folderNameInput, setFolderNameInput] = useState('');

	// ----- ハンドラ -----

	const handleNoteOpen = useCallback(
		(id: string) => router.push(`/note/${id}`),
		[router],
	);

	// アーカイブ画面遷移のクリック中の二重発火を抑制する。
	// expo-router の push を連打すると、画面が 2 回 push されて戻る時に 2 回戻る
	// 必要が生じ混乱する。500ms の窓で 1 回までに絞る。
	const archiveNavInFlightRef = useRef(false);
	const handleArchivePress = useCallback(() => {
		if (archiveNavInFlightRef.current) return;
		archiveNavInFlightRef.current = true;
		router.push('/archive');
		setTimeout(() => {
			archiveNavInFlightRef.current = false;
		}, 500);
	}, [router]);

	const handleCreate = useCallback(async () => {
		const id = uuidv4();
		const now = new Date().toISOString();
		// 新規作成のみリスト先頭に挿入。`saveNote` のデフォルト (push) は維持し、
		// 既存ノートの再保存や同期経路で順序が崩れないようにオプション指定する。
		await noteService.saveNote(
			{
				id,
				title: '',
				content: '',
				contentHeader: '',
				language: 'plaintext',
				modifiedTime: now,
				archived: false,
				folderId: '',
			},
			{ prependToOrder: true },
		);
		await syncStateManager.markNoteDirty(id);
		await useNotesStore.getState().reload();
		router.push(`/note/${id}`);
	}, [router]);

	const applyOptimisticNoteList = useCallback((list: typeof noteList) => {
		const revision = optimisticRevisionRef.current + 1;
		optimisticRevisionRef.current = revision;
		useNotesStore.setState({ noteList: list });
		scheduleAfterPaint(() => {
			if (revision === optimisticRevisionRef.current) {
				noteService.replaceNoteListInMemory(list);
			}
		});
		return revision;
	}, []);

	const persistOptimisticListInBackground = useCallback(
		(list: ReturnType<typeof noteService.getNoteList>, revision: number) => {
			scheduleAfterPaint(() => {
				void (async () => {
					try {
						if (revision !== optimisticRevisionRef.current) return;
						await noteService.replaceNoteList(list);

						// クロスフォルダ移動: 本文ファイル側にも新 folderId を書き戻す。
						// 古い遅延保存がスキップされても、ID は最新保存へ持ち越す。
						const pendingNoteIds = [...pendingFolderBodyNoteIdsRef.current];
						for (const noteId of pendingNoteIds) {
							const note = await noteService.readNote(noteId);
							const newMeta = list.notes.find((n) => n.id === noteId);
							if (note && newMeta && note.folderId !== newMeta.folderId) {
								note.folderId = newMeta.folderId;
								await noteService.saveNote(note);
							}
						}

						if (revision !== optimisticRevisionRef.current) return;
						for (const noteId of pendingNoteIds) {
							await syncStateManager.markNoteDirty(noteId);
						}
						// 並び替えだけ (folderId 変化なし) でも noteList は変わるので markDirty 必須
						await syncStateManager.markDirty();
						for (const noteId of pendingNoteIds) {
							pendingFolderBodyNoteIdsRef.current.delete(noteId);
						}
						driveService.kickSync();
					} catch (error) {
						console.error('[NoteListScreen] list persistence failed', error);
					}
				})();
			});
		},
		[],
	);

	const handleToggleFolder = useCallback(
		(folderId: string) => {
			const current = useNotesStore.getState().noteList;
			const collapsed = new Set(current.collapsedFolderIds);
			if (collapsed.has(folderId)) {
				collapsed.delete(folderId);
			} else {
				collapsed.add(folderId);
			}
			const next = {
				...current,
				collapsedFolderIds: [...collapsed],
			};
			const revision = applyOptimisticNoteList(next);
			persistOptimisticListInBackground(next, revision);
		},
		[applyOptimisticNoteList, persistOptimisticListInBackground],
	);

	const handleReorder = useCallback(
		({ rows: dragRows, fromIndex, dropIntent }: ManualReorderEvent) => {
			const current = useNotesStore.getState().noteList;
			const { list, movedNoteIds } = applyDropIntent(
				current,
				dragRows,
				fromIndex,
				dropIntent,
			);

			for (const noteId of movedNoteIds) {
				pendingFolderBodyNoteIdsRef.current.add(noteId);
			}
			const revision = applyOptimisticNoteList(list);
			persistOptimisticListInBackground(list, revision);
		},
		[applyOptimisticNoteList, persistOptimisticListInBackground],
	);

	const handleArchive = useCallback(async (noteId: string) => {
		// 1. UI から即時に消す (楽観的更新)。スワイプボタンを押した瞬間に
		//    行が unmount されるので、close アニメ待ちのラグが見えない。
		const current = useNotesStore.getState().noteList;
		useNotesStore.setState({
			noteList: optimisticToggleNoteArchived(current, noteId, true),
		});
		// 2. 実 IO とサーバ同期はバックグラウンドで進める。
		try {
			await noteService.setNoteArchived(noteId, true);
			await syncStateManager.markNoteDirty(noteId);
		} catch (e) {
			console.warn('[archive] failed', e);
			// 失敗時はサービスの真の状態に戻す
			await useNotesStore.getState().reload();
			return;
		}
		// 3. サービスの真の状態と整合 (contentHash 等の細部を反映)
		await useNotesStore.getState().reload();
		driveService.kickSync();
	}, []);

	const handleFolderMorePress = useCallback(
		(e: GestureResponderEvent, folderId: string) => {
			setFolderMenu({
				anchor: { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY },
				folderId,
			});
		},
		[],
	);

	const handleRenameFolderConfirm = useCallback(async () => {
		if (!renameFolderDialog) return;
		const name = folderNameInput.trim();
		if (!name) {
			setRenameFolderDialog(null);
			setFolderNameInput('');
			return;
		}
		await noteService.renameFolder(renameFolderDialog.folderId, name);
		await syncStateManager.markDirty();
		await useNotesStore.getState().reload();
		setRenameFolderDialog(null);
		setFolderNameInput('');
		driveService.kickSync();
	}, [renameFolderDialog, folderNameInput]);

	const handleArchiveFolderConfirm = useCallback(async () => {
		if (!archiveFolderDialog) return;
		const { folderId } = archiveFolderDialog;
		// dialog は即時クローズして UI のレスポンスを上げる。
		// 実 IO とリスト更新はその裏で進む。
		setArchiveFolderDialog(null);
		const archivedNoteIds = await noteService.archiveFolder(folderId);
		for (const noteId of archivedNoteIds) {
			await syncStateManager.markNoteDirty(noteId);
		}
		await syncStateManager.markDirty();
		await useNotesStore.getState().reload();
		driveService.kickSync();
	}, [archiveFolderDialog]);

	const handleCreateFolder = useCallback(async () => {
		const name = folderNameInput.trim();
		if (!name) {
			setCreateFolderDialog(false);
			setFolderNameInput('');
			return;
		}
		await noteService.createFolder(name);
		await syncStateManager.markDirty();
		await useNotesStore.getState().reload();
		setCreateFolderDialog(false);
		setFolderNameInput('');
		driveService.kickSync();
	}, [folderNameInput]);

	// active 画面のフォルダメニュー: リネーム + フォルダごとアーカイブ
	const folderMenuItems = useMemo<FolderMenuItem[]>(() => {
		if (!folderMenu) return [];
		const folder = noteList.folders.find((f) => f.id === folderMenu.folderId);
		if (!folder) return [];
		return [
			{
				icon: 'pencil',
				label: t('noteList.renameFolder'),
				onPress: () => {
					setFolderNameInput(folder.name);
					setRenameFolderDialog({ folderId: folder.id });
				},
			},
			{
				icon: 'archive-arrow-down',
				label: t('noteList.archiveFolder'),
				onPress: () => {
					const count = noteList.notes.filter(
						(n) => n.folderId === folder.id && !n.archived,
					).length;
					setArchiveFolderDialog({
						folderId: folder.id,
						name: folder.name,
						count,
					});
				},
			},
		];
	}, [folderMenu, noteList.folders, noteList.notes, t]);

	const folderHeaderBg = theme.colors.surfaceVariant;
	const folderChildBg = theme.colors.elevation.level1;
	const divider = theme.colors.outline;

	return (
		<View
			style={[styles.container, { backgroundColor: theme.colors.background }]}
		>
			{search.active ? (
				<SearchAppbar
					value={search.query}
					onChangeText={search.setQuery}
					onClose={search.close}
					indexing={search.isIndexing}
				/>
			) : (
				<Appbar.Header>
					<Appbar.Content title={t('app.title')} />
					<Appbar.Action
						icon="folder-plus"
						onPress={() => {
							setFolderNameInput('');
							setCreateFolderDialog(true);
						}}
						accessibilityLabel={t('noteList.newFolder')}
					/>
					<Appbar.Action
						icon="magnify"
						onPress={search.open}
						accessibilityLabel={t('search.placeholder')}
					/>
					{!signedIn && (
						<Appbar.Action
							icon="login"
							onPress={() => router.push('/signin')}
						/>
					)}
					<Appbar.Action icon="cog" onPress={() => router.push('/settings')} />
				</Appbar.Header>
			)}
			<SyncStatusBar />
			<Divider style={{ backgroundColor: divider }} />
			{showEmpty ? (
				<View style={styles.empty}>
					<Text variant="bodyMedium">{t('noteList.empty')}</Text>
				</View>
			) : (
				<ManualDragNoteList
					rows={rows}
					backgroundColor={theme.colors.background}
					folderHeaderBg={folderHeaderBg}
					folderChildBg={folderChildBg}
					indicatorColor={theme.colors.primary}
					onArchive={handleArchive}
					onFolderMorePress={handleFolderMorePress}
					onNoteOpen={handleNoteOpen}
					onReorder={handleReorder}
					onToggleFolder={handleToggleFolder}
					disableDrag={search.active}
				/>
			)}

			{/* ボトムバー: ノート件数 / アーカイブ画面遷移 / 新規ノート作成。
			    端末の角丸領域に詰まって見えないよう、内側ボックスで等間隔に並べた上で
			    中央寄せする。 */}
			<Divider style={{ backgroundColor: divider }} />
			<View
				style={[
					styles.bottomBar,
					{
						backgroundColor: theme.colors.surface,
						// Android のジェスチャーバーや iOS のホームインジケータと
						// ボタンが密着しないよう、safe-area inset 分の下余白を確保。
						paddingBottom: 12 + insets.bottom,
					},
				]}
			>
				{/* ノート件数と新規ノートを左右の flex:1 セルに配置する。
				    アーカイブボタンは絶対配置の overlay に置き、bar と同じ padding を
				    overlay 自身に付けることで「bar の content area 中央」に
				    縦横ともに正確に揃える。Paper Button の内部 padding 差や side item の
				    幅違いに影響されない。 */}
				<View style={styles.bottomBarLeft}>
					<Text
						variant="bodyMedium"
						style={{ color: theme.colors.onSurfaceVariant }}
					>
						{t('noteList.noteCount', { count: activeNoteCount })}
					</Text>
				</View>
				<View style={styles.bottomBarRight}>
					<Button
						mode="contained-tonal"
						icon="plus"
						onPress={handleCreate}
						compact
					>
						{t('noteList.newNote')}
					</Button>
				</View>
				<View
					style={[
						styles.bottomBarCenterOverlay,
						{ paddingBottom: 12 + insets.bottom },
					]}
					pointerEvents="box-none"
				>
					<Button
						mode="text"
						icon="archive"
						onPress={handleArchivePress}
						compact
					>
						{t('noteList.archiveListTitle')}
					</Button>
				</View>
			</View>

			{/* フォルダヘッダのドットメニュー */}
			<FolderContextMenu
				visible={folderMenu !== null}
				anchor={folderMenu?.anchor ?? null}
				onDismiss={() => setFolderMenu(null)}
				items={folderMenuItems}
			/>

			<Portal>
				{/* 新規フォルダダイアログ */}
				<Dialog
					visible={createFolderDialog}
					onDismiss={() => setCreateFolderDialog(false)}
				>
					<Dialog.Title>{t('noteList.newFolder')}</Dialog.Title>
					<Dialog.Content>
						<TextInput
							autoFocus
							mode="outlined"
							label={t('noteList.newFolderPrompt')}
							value={folderNameInput}
							onChangeText={setFolderNameInput}
							onSubmitEditing={handleCreateFolder}
						/>
					</Dialog.Content>
					<Dialog.Actions>
						<Button onPress={() => setCreateFolderDialog(false)}>
							{t('noteList.cancel')}
						</Button>
						<Button onPress={handleCreateFolder}>{t('noteList.ok')}</Button>
					</Dialog.Actions>
				</Dialog>

				{/* フォルダ名変更ダイアログ */}
				<Dialog
					visible={renameFolderDialog !== null}
					onDismiss={() => setRenameFolderDialog(null)}
				>
					<Dialog.Title>{t('noteList.renameFolder')}</Dialog.Title>
					<Dialog.Content>
						<TextInput
							autoFocus
							mode="outlined"
							label={t('noteList.newFolderPrompt')}
							value={folderNameInput}
							onChangeText={setFolderNameInput}
							onSubmitEditing={handleRenameFolderConfirm}
						/>
					</Dialog.Content>
					<Dialog.Actions>
						<Button onPress={() => setRenameFolderDialog(null)}>
							{t('noteList.cancel')}
						</Button>
						<Button onPress={handleRenameFolderConfirm}>
							{t('noteList.ok')}
						</Button>
					</Dialog.Actions>
				</Dialog>

				{/* フォルダごとアーカイブ確認ダイアログ */}
				<Dialog
					visible={archiveFolderDialog !== null}
					onDismiss={() => setArchiveFolderDialog(null)}
				>
					<Dialog.Title>{t('noteList.archiveFolder')}</Dialog.Title>
					<Dialog.Content>
						<Text variant="bodyMedium">
							{archiveFolderDialog
								? archiveFolderDialog.count > 0
									? t('noteList.archiveFolderConfirm', {
											name: archiveFolderDialog.name,
											count: archiveFolderDialog.count,
										})
									: t('noteList.archiveFolderConfirmEmpty', {
											name: archiveFolderDialog.name,
										})
								: ''}
						</Text>
					</Dialog.Content>
					<Dialog.Actions>
						<Button onPress={() => setArchiveFolderDialog(null)}>
							{t('noteList.cancel')}
						</Button>
						<Button onPress={handleArchiveFolderConfirm}>
							{t('noteList.archive_action')}
						</Button>
					</Dialog.Actions>
				</Dialog>
			</Portal>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1 },
	empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
	bottomBar: {
		flexDirection: 'row',
		alignItems: 'center',
		paddingHorizontal: 16,
		paddingTop: 8,
		// paddingBottom はインライン側で `12 + insets.bottom` を当てる
	},
	bottomBarLeft: {
		// 左セル: ノート件数を外側 (画面左寄り) に寄せて、中央のアーカイブと
		// かぶらないだけのスペースを確保する。
		flex: 1,
		alignItems: 'flex-start',
	},
	bottomBarRight: {
		// 右セル: 新規ノートボタンを外側 (画面右寄り) に。pill 背景があるため
		// flex-start で中央寄りに置くと中央のアーカイブと重なってしまう。
		flex: 1,
		alignItems: 'flex-end',
	},
	bottomBarCenterOverlay: {
		// 物理中央 (横) + content area 中央 (縦) に archive を置くための overlay。
		// 親の padding 領域と同じ padding を overlay 自身に持たせ、内側で
		// alignItems/justifyContent center するので、結果として bar の
		// content area の正中央に乗る。pointerEvents="box-none" で、archive
		// ボタン以外の領域へのタップは下の side セルへ透過させる。
		position: 'absolute',
		top: 0,
		bottom: 0,
		left: 0,
		right: 0,
		paddingTop: 8,
		paddingHorizontal: 16,
		// paddingBottom はインライン側で `12 + insets.bottom` を当てる
		alignItems: 'center',
		justifyContent: 'center',
	},
});
