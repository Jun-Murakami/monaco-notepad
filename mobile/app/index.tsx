import { useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
	type GestureResponderEvent,
	Platform,
	StyleSheet,
	View,
} from 'react-native';
import DraggableFlatList, {
	type RenderItemParams,
	ScaleDecorator,
} from 'react-native-draggable-flatlist';
// Pressable は react-native-gesture-handler 製を使う。RN 標準の Pressable は
// RN responder system 経由で動くため、DraggableFlatList の <GestureDetector>
// 配下で onLongPress が握られない（または親 PanGesture と協調しない）ことがあり、
// DnD の起点 (drag()) が呼ばれず動かない。gh 製は内部的に Gesture.LongPress を
// 使うので、親の Gesture と協調する。
import { Pressable } from 'react-native-gesture-handler';
import {
	AnimatedFAB,
	Appbar,
	Button,
	Dialog,
	Divider,
	Portal,
	Text,
	TextInput,
	useTheme,
} from 'react-native-paper';
import { FolderListItem } from '@/components/FolderListItem';
import {
	type FolderPickerHandle,
	FolderPickerSheet,
} from '@/components/FolderPickerSheet';
import { NoteListItem } from '@/components/NoteListItem';
import {
	FolderContextMenu,
	NoteContextMenu,
} from '@/components/RowContextMenu';
import { SwipeableNoteRow } from '@/components/SwipeableNoteRow';
import { SyncStatusBar } from '@/components/SyncStatusBar';
import { noteService } from '@/services/notes/noteService';
import { driveService } from '@/services/sync/driveService';
import { syncStateManager } from '@/services/sync/syncState';
import { useAuthStore } from '@/stores/authStore';
import { useNotesStore } from '@/stores/notesStore';
import {
	applyReorder,
	type FlatRow,
	flattenNoteList,
	moveNoteToFolder,
} from '@/utils/flatTree';
import { uuidv4 } from '@/utils/uuid';

export default function NoteListScreen() {
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const noteList = useNotesStore((s) => s.noteList);
	const signedIn = useAuthStore((s) => s.signedIn);

	// ドラッグ中に「視覚的に」子要素を隠す対象 folder ID。
	// 重要: data 配列 (rows) は変更しない。data を mid-drag で変えると
	// react-native-draggable-flatlist が active state を失い、ドラッグが解除される。
	// よって rows は常に通常通り計算し、renderItem 側で folderId が一致する
	// folder-child だけ 0-height で描画して視覚的に隠す方式を取る。
	const [dragCollapseFolderId, setDragCollapseFolderId] = useState<
		string | null
	>(null);

	const rows = useMemo<FlatRow[]>(() => flattenNoteList(noteList), [noteList]);

	// 長押しメニューの state
	const [noteMenu, setNoteMenu] = useState<{
		anchor: { x: number; y: number };
		noteId: string;
		folderId: string;
	} | null>(null);
	const [folderMenu, setFolderMenu] = useState<{
		anchor: { x: number; y: number };
		folderId: string;
	} | null>(null);

	// ダイアログ state
	const [createFolderDialog, setCreateFolderDialog] = useState(false);
	const [renameFolderDialog, setRenameFolderDialog] = useState<{
		folderId: string;
		name: string;
	} | null>(null);
	const [deleteFolderDialog, setDeleteFolderDialog] = useState<string | null>(
		null,
	);
	const [folderNameInput, setFolderNameInput] = useState('');

	const folderPickerRef = useRef<FolderPickerHandle>(null);

	// ----- ハンドラ -----

	const handleNoteOpen = useCallback(
		(id: string) => router.push(`/note/${id}`),
		[router],
	);

	const handleToggleFolder = useCallback(
		async (folderId: string) => {
			const currentlyCollapsed = new Set(noteList.collapsedFolderIds).has(
				folderId,
			);
			await noteService.setFolderCollapsed(folderId, !currentlyCollapsed);
			await syncStateManager.markDirty();
			await useNotesStore.getState().reload();
			driveService.kickSync();
		},
		[noteList.collapsedFolderIds],
	);

	const handleCreate = useCallback(async () => {
		const id = uuidv4();
		const now = new Date().toISOString();
		await noteService.saveNote({
			id,
			title: '',
			content: '',
			contentHeader: '',
			language: 'plaintext',
			modifiedTime: now,
			archived: false,
			folderId: '',
		});
		await syncStateManager.markNoteDirty(id);
		await useNotesStore.getState().reload();
		router.push(`/note/${id}`);
	}, [router]);

	// rows を最新参照する用 (onDragBegin が頻繁な再生成を避けるため)。
	const rowsRef = useRef(rows);
	rowsRef.current = rows;

	const handleDragBegin = useCallback((index: number) => {
		const item = rowsRef.current[index];
		// 展開済みフォルダのヘッダをドラッグした場合のみ、ドラッグ中の強制折り畳みを発動。
		// 既に折り畳まれている場合・ノートをドラッグした場合は何もしない。
		if (item?.kind === 'folder-header' && !item.collapsed) {
			setDragCollapseFolderId(item.id);
		}
	}, []);

	const handleDragEnd = useCallback(async ({ data }: { data: FlatRow[] }) => {
		// 重要: setDragCollapseFolderId(null) を先頭で呼ぶと、replaceNoteList/reload が
		// 終わる前に「子要素が見える状態 + 古い順序」のレンダリングが走り、子が一瞬
		// 元の位置に「点滅」して見える。store を更新してから dragCollapseFolderId を
		// クリアすることで、新しい順序で子が現れるようにする。
		const current = noteService.getNoteList();
		const { list } = applyReorder(current, data);
		await noteService.replaceNoteList(list);
		// DnD は順序変更のみ。folderId は変えない方針（クロスフォルダ移動はメニュー経由）。
		await useNotesStore.getState().reload();
		setDragCollapseFolderId(null);
		// dirty 化 + 同期 kick はバックグラウンドで OK (UI 表示には影響しない)
		await syncStateManager.markDirty();
		driveService.kickSync();
	}, []);

	const handleArchive = useCallback(async (noteId: string) => {
		await noteService.setNoteArchived(noteId, true);
		await syncStateManager.markNoteDirty(noteId);
		await useNotesStore.getState().reload();
		driveService.kickSync();
	}, []);

	const handleNoteLongPress = useCallback(
		(e: GestureResponderEvent, noteId: string, folderId: string) => {
			setNoteMenu({
				anchor: { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY },
				noteId,
				folderId,
			});
		},
		[],
	);

	const handleFolderLongPress = useCallback(
		(e: GestureResponderEvent, folderId: string) => {
			setFolderMenu({
				anchor: { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY },
				folderId,
			});
		},
		[],
	);

	const handleMoveToFolder = useCallback(async () => {
		if (!noteMenu) return;
		const { noteId, folderId } = noteMenu;
		folderPickerRef.current?.open(folderId, async (target) => {
			const current = noteService.getNoteList();
			const next = moveNoteToFolder(current, noteId, target);
			await noteService.replaceNoteList(next);
			// 本文側にも folderId を書き戻す
			const note = await noteService.readNote(noteId);
			if (note) {
				note.folderId = target;
				await noteService.saveNote(note);
			}
			await syncStateManager.markNoteDirty(noteId);
			await useNotesStore.getState().reload();
			driveService.kickSync();
		});
	}, [noteMenu]);

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

	const handleDeleteFolderConfirm = useCallback(async () => {
		if (!deleteFolderDialog) return;
		await noteService.deleteFolder(deleteFolderDialog);
		await syncStateManager.markFolderDeleted(deleteFolderDialog);
		// 配下から繰り上がったノートも dirty 化（folderId が変わったので本文の再保存が必要）
		const current = noteService.getNoteList();
		for (const note of current.notes) {
			if (note.folderId === '') {
				const body = await noteService.readNote(note.id);
				if (body && body.folderId !== '') {
					body.folderId = '';
					await noteService.saveNote(body);
					await syncStateManager.markNoteDirty(note.id);
				}
			}
		}
		await useNotesStore.getState().reload();
		setDeleteFolderDialog(null);
		driveService.kickSync();
	}, [deleteFolderDialog]);

	// ----- 描画 -----

	const folderHeaderBg = theme.colors.surfaceVariant;
	const folderChildBg = theme.colors.elevation.level1;
	const divider = theme.colors.outline;

	const renderItem = useCallback(
		({ item, drag }: RenderItemParams<FlatRow>) => {
			if (item.kind === 'topLevel-note') {
				return (
					<ScaleDecorator activeScale={0.98}>
						<SwipeableNoteRow onArchive={() => handleArchive(item.id)}>
							<Pressable
								onLongPress={drag}
								delayLongPress={150}
								style={{ backgroundColor: theme.colors.background }}
							>
								<NoteListItem
									metadata={item.note}
									onPress={handleNoteOpen}
									onMorePress={(e, id) => handleNoteLongPress(e, id, '')}
								/>
							</Pressable>
						</SwipeableNoteRow>
					</ScaleDecorator>
				);
			}
			if (item.kind === 'folder-header') {
				// FolderListItem 内の chevron が toggle、本体はタッチ無反応にしたので、
				// 親 Pressable は onLongPress=drag のみ。これによりヘッダ本体のドラッグ
				// 判定が他のジェスチャと衝突せず短い delayLongPress で反応する。
				//
				// 折り畳み時 (inGroupEnd=true) は単体カードに見えるよう 4 角 rounded、
				// 展開時 (inGroupEnd=false) は children の上端と揃うよう TOP だけ rounded
				// に切替。chevron 側の press feedback / ripple を外した事で toggle 時の
				// 余分な再レンダが消え、style 切替を伴っても flicker は出なくなった。
				return (
					<ScaleDecorator activeScale={0.98}>
						<View
							style={[
								{ backgroundColor: folderHeaderBg },
								styles.groupSide,
								styles.groupTop,
								item.inGroupEnd && styles.groupBottom,
							]}
						>
							<Pressable onLongPress={drag} delayLongPress={150}>
								<FolderListItem
									folder={item.folder}
									noteCount={item.noteCount}
									collapsed={item.collapsed}
									onToggle={handleToggleFolder}
									onMorePress={handleFolderLongPress}
								/>
							</Pressable>
						</View>
					</ScaleDecorator>
				);
			}
			// folder-child
			// 親フォルダが drag 中の場合は 0-height で描画して視覚的に隠す。
			// data 配列を変えてしまうと drag state がリセットされてしまうので、
			// あくまで「描画上だけ」見えなくする。
			if (item.folderId === dragCollapseFolderId) {
				return <View style={styles.dragHidden} />;
			}
			// 注: 最下行でも `groupBottom` を当てない (= 角を丸くしない)。理由 2 つ:
			//  1. 展開時のヘッダ角チラつき防止。child の rounded-bottom と header の
			//     rounded-bottom が遷移中に入れ替わる時、style 更新と child mount/unmount
			//     のフレームずれで「一瞬 square」が見える。child 側を square 固定にすると
			//     最終状態が「ヘッダ rounded-top + 全体 square-bottom」で安定し片方向遷移に。
			//  2. drag 時に rounded-bottom が一緒に飛んできて視覚的に違和感がある。
			return (
				<ScaleDecorator activeScale={0.98}>
					<View
						style={[
							{ backgroundColor: folderChildBg },
							styles.groupSide,
							// 角は丸めないが、グループ下端の余白だけは保つ
							item.inGroupEnd && styles.groupTrailingSpace,
						]}
					>
						<SwipeableNoteRow onArchive={() => handleArchive(item.id)}>
							<Pressable onLongPress={drag} delayLongPress={150}>
								<NoteListItem
									metadata={item.note}
									onPress={handleNoteOpen}
									onMorePress={(e, id) =>
										handleNoteLongPress(e, id, item.folderId)
									}
									indented
								/>
							</Pressable>
						</SwipeableNoteRow>
					</View>
				</ScaleDecorator>
			);
		},
		[
			dragCollapseFolderId,
			folderHeaderBg,
			folderChildBg,
			handleArchive,
			handleFolderLongPress,
			handleNoteLongPress,
			handleNoteOpen,
			handleToggleFolder,
			theme.colors.background,
		],
	);

	return (
		<View
			style={[styles.container, { backgroundColor: theme.colors.background }]}
		>
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
				{signedIn ? (
					<Appbar.Action icon="cog" onPress={() => router.push('/settings')} />
				) : (
					<Appbar.Action icon="login" onPress={() => router.push('/signin')} />
				)}
			</Appbar.Header>
			<SyncStatusBar />
			<Divider style={{ backgroundColor: divider }} />
			{rows.length === 0 ? (
				<View style={styles.empty}>
					<Text variant="bodyMedium">{t('noteList.empty')}</Text>
				</View>
			) : (
				<DraggableFlatList
					data={rows}
					extraData={dragCollapseFolderId}
					keyExtractor={(row) => row.key}
					renderItem={renderItem}
					onDragBegin={handleDragBegin}
					onDragEnd={handleDragEnd}
					contentContainerStyle={styles.listContent}
					// drag 確定後は即追従させたいので 0px (デフォの 20px だと
					// long-press 後さらに 20px 動かさないと cell が動かず重く感じる)
					activationDistance={0}
					// drop 後の spring を硬めにして「指を離したのに位置確定が遅い」感を消す。
					// デフォ (damping:20, stiffness:100) だと settle まで ~500ms かかり、
					// その間 onDragEnd が発火しない = フォルダ子要素も復帰が遅れる。
					animationConfig={{
						damping: 30,
						mass: 0.2,
						stiffness: 400,
					}}
				/>
			)}
			<AnimatedFAB
				icon="plus"
				label={t('noteList.newNote')}
				extended={false}
				onPress={handleCreate}
				style={styles.fab}
				visible
				animateFrom="right"
				iconMode="static"
			/>

			{/* 長押しメニュー */}
			<NoteContextMenu
				visible={noteMenu !== null}
				anchor={noteMenu?.anchor ?? null}
				onDismiss={() => setNoteMenu(null)}
				onMoveToFolder={handleMoveToFolder}
				onArchive={() => {
					if (noteMenu) handleArchive(noteMenu.noteId);
				}}
			/>
			<FolderContextMenu
				visible={folderMenu !== null}
				anchor={folderMenu?.anchor ?? null}
				onDismiss={() => setFolderMenu(null)}
				onRename={() => {
					if (!folderMenu) return;
					const folder = noteList.folders.find(
						(f) => f.id === folderMenu.folderId,
					);
					if (!folder) return;
					setFolderNameInput(folder.name);
					setRenameFolderDialog({ folderId: folder.id, name: folder.name });
				}}
				onDelete={() => {
					if (folderMenu) setDeleteFolderDialog(folderMenu.folderId);
				}}
			/>

			{/* フォルダピッカー */}
			<FolderPickerSheet ref={folderPickerRef} folders={noteList.folders} />

			{/* 新規フォルダダイアログ */}
			<Portal>
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

				<Dialog
					visible={deleteFolderDialog !== null}
					onDismiss={() => setDeleteFolderDialog(null)}
				>
					<Dialog.Title>{t('noteList.deleteFolder')}</Dialog.Title>
					<Dialog.Content>
						<Text variant="bodyMedium">
							{t('noteList.deleteFolderConfirm')}
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
	listContent: {
		paddingBottom: Platform.select({ ios: 96, default: 80 }),
	},
	fab: { position: 'absolute', right: 16, bottom: 16 },
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
		marginBottom: 8,
	},
	// ドラッグ中のフォルダの子要素を視覚的に隠す。data には残るので index は維持。
	dragHidden: { height: 0, overflow: 'hidden' },
});
