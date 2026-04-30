import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type GestureResponderEvent, StyleSheet, View } from 'react-native';
import {
	ActivityIndicator,
	Appbar,
	Button,
	Dialog,
	Divider,
	Portal,
	Text,
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
import { useNotesStore } from '@/stores/notesStore';
import {
	applyDropIntent,
	type FlatRow,
	flattenNoteList,
} from '@/utils/flatTree';
import {
	optimisticDeleteNote,
	optimisticToggleNoteArchived,
} from '@/utils/noteListOptimistic';
import { scheduleAfterPaint } from '@/utils/scheduleAfterPaint';
import { filterRowsBySearch } from '@/utils/searchFilter';

export default function ArchiveListScreen() {
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const insets = useSafeAreaInsets();
	const noteList = useNotesStore((s) => s.noteList);

	// archived 表示分のみ。folder children は collapsed の場合でも mount したままにし、
	// 開閉のたびに gesture handler が作り直されないようにする (active 画面と同じ理由)。
	const rawRows = useMemo<FlatRow[]>(
		() =>
			flattenNoteList(noteList, {
				archived: true,
				includeCollapsedChildren: true,
			}),
		[noteList],
	);

	// 全文検索 (active 画面と index は共有)。
	const search = useNoteSearch(noteList.notes);
	const rows = useMemo<FlatRow[]>(
		() => filterRowsBySearch(rawRows, search.matchingIds),
		[rawRows, search.matchingIds],
	);

	const archivedNoteCount = useMemo(
		() => noteList.notes.filter((n) => n.archived).length,
		[noteList.notes],
	);

	// 空リスト placeholder の表示は遅延させ、アップロード/同期途中の
	// 一瞬の空配列でチラつかないようにする。
	const showEmpty = useDeferredEmpty(rows.length === 0);

	// 重い ManualDragNoteList の mount を **画面遷移アニメーションが終わってから**
	// に遅延させる。アーカイブボタンを押した瞬間に Appbar + spinner だけの軽い
	// ページにすぐ遷移し、しばらくしてリスト本体が現れる流れにする。
	// RN 0.79+ で deprecated になった InteractionManager の代わりに
	// requestIdleCallback (timeout 付き) を使う。アイドル時に発火し、
	// 来なくても timeout で必ず呼ばれる。
	const [contentReady, setContentReady] = useState(false);
	useEffect(() => {
		const ric = (
			globalThis as {
				requestIdleCallback?: (
					cb: () => void,
					opts?: { timeout: number },
				) => number;
				cancelIdleCallback?: (handle: number) => void;
			}
		).requestIdleCallback;
		const cic = (globalThis as { cancelIdleCallback?: (h: number) => void })
			.cancelIdleCallback;
		if (ric && cic) {
			const handle = ric(() => setContentReady(true), { timeout: 500 });
			return () => cic(handle);
		}
		const timer = setTimeout(() => setContentReady(true), 250);
		return () => clearTimeout(timer);
	}, []);

	const optimisticRevisionRef = useRef(0);

	const [folderMenu, setFolderMenu] = useState<{
		anchor: { x: number; y: number };
		folderId: string;
	} | null>(null);
	const [deleteFolderDialog, setDeleteFolderDialog] = useState<{
		folderId: string;
		name: string;
		count: number;
	} | null>(null);

	// ----- ハンドラ -----

	const handleNoteOpen = useCallback(
		(id: string) => router.push(`/note/${id}`),
		[router],
	);

	const applyOptimisticNoteList = useCallback((list: typeof noteList) => {
		const revision = optimisticRevisionRef.current + 1;
		optimisticRevisionRef.current = revision;
		useNotesStore.setState({ noteList: list });
		scheduleAfterPaint(() => {
			if (revision === optimisticRevisionRef.current) {
				// 同期 pull 並行で upsertMetadata したエントリを保持する
				noteService.replaceNoteListInMemory(list, { preserveExtras: true });
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
						await noteService.replaceNoteList(list, { preserveExtras: true });
						if (revision !== optimisticRevisionRef.current) return;
						await syncStateManager.markDirty();
						driveService.kickSync();
					} catch (error) {
						console.error('[ArchiveListScreen] list persistence failed', error);
					}
				})();
			});
		},
		[],
	);

	const handleToggleFolder = useCallback(
		(folderId: string) => {
			// baseline は noteService から取る (pull 中の Zustand は notes=[] のまま停滞しうる)
			const current = noteService.getNoteList();
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
			// baseline は noteService から取る (pull 中の Zustand は notes=[] のまま停滞しうる)
			const current = noteService.getNoteList();
			const { list } = applyDropIntent(
				current,
				dragRows,
				fromIndex,
				dropIntent,
				{
					archived: true,
				},
			);
			const revision = applyOptimisticNoteList(list);
			persistOptimisticListInBackground(list, revision);
		},
		[applyOptimisticNoteList, persistOptimisticListInBackground],
	);

	const handleRestore = useCallback(async (noteId: string) => {
		// 楽観的更新: 即時にアーカイブビューから消す (active へ移動)
		const current = useNotesStore.getState().noteList;
		useNotesStore.setState({
			noteList: optimisticToggleNoteArchived(current, noteId, false),
		});
		try {
			await noteService.setNoteArchived(noteId, false);
			await syncStateManager.markNoteDirty(noteId);
		} catch (e) {
			console.warn('[restore] failed', e);
			await useNotesStore.getState().reload();
			return;
		}
		await useNotesStore.getState().reload();
		driveService.kickSync();
	}, []);

	const handleDelete = useCallback(async (noteId: string) => {
		// 楽観的更新: 即時に一覧から消す
		const current = useNotesStore.getState().noteList;
		useNotesStore.setState({
			noteList: optimisticDeleteNote(current, noteId),
		});
		try {
			await driveService.deleteNoteAndSync(noteId);
		} catch (e) {
			console.warn('[delete] failed', e);
			await useNotesStore.getState().reload();
			return;
		}
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

	const handleRestoreFolder = useCallback(async (folderId: string) => {
		await driveService.restoreFolderAndSync(folderId);
		await useNotesStore.getState().reload();
		driveService.kickSync();
	}, []);

	const deleteFolderNow = useCallback(async (folderId: string) => {
		await driveService.deleteFolderAndSync(folderId);
		await useNotesStore.getState().reload();
		driveService.kickSync();
	}, []);

	const handleDeleteFolderConfirm = useCallback(async () => {
		if (!deleteFolderDialog) return;
		const { folderId } = deleteFolderDialog;
		setDeleteFolderDialog(null);
		await deleteFolderNow(folderId);
	}, [deleteFolderDialog, deleteFolderNow]);

	// archive 画面のフォルダメニュー: フォルダ復元 + フォルダ削除
	const folderMenuItems = useMemo<FolderMenuItem[]>(() => {
		if (!folderMenu) return [];
		const folder = noteList.folders.find((f) => f.id === folderMenu.folderId);
		if (!folder) return [];
		return [
			{
				icon: 'archive-arrow-up',
				label: t('noteList.restoreFolder'),
				onPress: () => {
					handleRestoreFolder(folder.id);
				},
			},
			{
				icon: 'trash-can',
				label: t('noteList.deleteFolder'),
				onPress: () => {
					const count = noteList.notes.filter(
						(n) => n.folderId === folder.id,
					).length;
					if (count === 0) {
						void deleteFolderNow(folder.id);
						return;
					}
					setDeleteFolderDialog({
						folderId: folder.id,
						name: folder.name,
						count,
					});
				},
			},
		];
	}, [
		deleteFolderNow,
		folderMenu,
		handleRestoreFolder,
		noteList.folders,
		noteList.notes,
		t,
	]);

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
				<Appbar.Header mode="small">
					<Appbar.BackAction onPress={() => router.back()} />
					<Appbar.Content title={t('noteList.archiveListTitle')} />
					<Appbar.Action
						icon="magnify"
						onPress={search.open}
						accessibilityLabel={t('search.placeholder')}
					/>
				</Appbar.Header>
			)}
			<SyncStatusBar />
			<Divider style={{ backgroundColor: divider }} />
			{!contentReady ? (
				<View style={styles.loading}>
					<ActivityIndicator />
				</View>
			) : showEmpty ? (
				<View style={styles.empty}>
					<Text variant="bodyMedium">{t('noteList.archiveEmpty')}</Text>
				</View>
			) : (
				<ManualDragNoteList
					rows={rows}
					backgroundColor={theme.colors.background}
					folderHeaderBg={folderHeaderBg}
					folderChildBg={folderChildBg}
					indicatorColor={theme.colors.primary}
					onRestore={handleRestore}
					onDelete={handleDelete}
					onFolderMorePress={handleFolderMorePress}
					onNoteOpen={handleNoteOpen}
					onReorder={handleReorder}
					onToggleFolder={handleToggleFolder}
					disableDrag={search.active}
				/>
			)}

			{/* ボトムバー: アーカイブ件数のみ表示。新規作成・遷移は active 側のみ。 */}
			<Divider style={{ backgroundColor: divider }} />
			<View
				style={[
					styles.bottomBar,
					{
						backgroundColor: theme.colors.surface,
						paddingBottom: 12 + insets.bottom,
					},
				]}
			>
				<Text
					variant="bodyMedium"
					style={{ color: theme.colors.onSurfaceVariant }}
				>
					{t('noteList.archiveCount', { count: archivedNoteCount })}
				</Text>
			</View>

			{/* フォルダヘッダのドットメニュー */}
			<FolderContextMenu
				visible={folderMenu !== null}
				anchor={folderMenu?.anchor ?? null}
				onDismiss={() => setFolderMenu(null)}
				items={folderMenuItems}
			/>

			<Portal>
				{/* フォルダ削除確認ダイアログ */}
				<Dialog
					visible={deleteFolderDialog !== null}
					onDismiss={() => setDeleteFolderDialog(null)}
				>
					<Dialog.Title>{t('noteList.deleteFolder')}</Dialog.Title>
					<Dialog.Content>
						<Text variant="bodyMedium">
							{deleteFolderDialog
								? deleteFolderDialog.count > 0
									? t('noteList.deleteFolderConfirm', {
											name: deleteFolderDialog.name,
											count: deleteFolderDialog.count,
										})
									: t('noteList.deleteFolderConfirmEmpty', {
											name: deleteFolderDialog.name,
										})
								: ''}
						</Text>
					</Dialog.Content>
					<Dialog.Actions>
						<Button onPress={() => setDeleteFolderDialog(null)}>
							{t('noteList.cancel')}
						</Button>
						<Button
							textColor={theme.colors.error}
							onPress={handleDeleteFolderConfirm}
						>
							{t('noteList.delete')}
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
	loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
	bottomBar: {
		flexDirection: 'row',
		alignItems: 'center',
		justifyContent: 'center',
		paddingHorizontal: 16,
		paddingTop: 8,
		// paddingBottom はインライン側で `12 + insets.bottom` を当てる
	},
});
