import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, StyleSheet, View } from 'react-native';
import {
	AnimatedFAB,
	Appbar,
	Divider,
	Text,
	useTheme,
} from 'react-native-paper';
import { FolderListItem } from '@/components/FolderListItem';
import { NoteListItem } from '@/components/NoteListItem';
import { SyncStatusBar } from '@/components/SyncStatusBar';
import { noteService } from '@/services/notes/noteService';
import { syncStateManager } from '@/services/sync/syncState';
import type { Folder, NoteMetadata } from '@/services/sync/types';
import { useAuthStore } from '@/stores/authStore';
import { useNotesStore } from '@/stores/notesStore';
import { uuidv4 } from '@/utils/uuid';

/**
 * 一覧描画用のフラット row。
 * - `topLevel-note`: フォルダに属さない top-level ノート
 * - `folder-header`: フォルダの見出し
 * - `folder-child`: フォルダ配下のノート（インデント付き）
 *
 * `inGroupStart` / `inGroupEnd` は「カード風に囲む背景」の角丸位置を決めるための flag。
 */
type Row =
	| {
			kind: 'topLevel-note';
			key: string;
			note: NoteMetadata;
	  }
	| {
			kind: 'folder-header';
			key: string;
			folder: Folder;
			noteCount: number;
			collapsed: boolean;
			inGroupStart: true;
			inGroupEnd: boolean;
	  }
	| {
			kind: 'folder-child';
			key: string;
			note: NoteMetadata;
			inGroupStart: false;
			inGroupEnd: boolean;
	  };

export default function NoteListScreen() {
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const noteList = useNotesStore((s) => s.noteList);
	const signedIn = useAuthStore((s) => s.signedIn);

	const rows = useMemo<Row[]>(() => {
		const folderById = new Map(noteList.folders.map((f) => [f.id, f]));
		const notesByFolderId = new Map<string, NoteMetadata[]>();
		for (const n of noteList.notes) {
			if (n.archived) continue;
			if (!n.folderId) continue;
			const arr = notesByFolderId.get(n.folderId) ?? [];
			arr.push(n);
			notesByFolderId.set(n.folderId, arr);
		}
		const notesById = new Map(noteList.notes.map((n) => [n.id, n]));
		const collapsedSet = new Set(noteList.collapsedFolderIds);

		const out: Row[] = [];
		for (const item of noteList.topLevelOrder) {
			if (item.type === 'note') {
				const note = notesById.get(item.id);
				if (!note || note.archived) continue;
				if (note.folderId) continue; // folder 配下にあるなら top ではなく folder 側で出す
				out.push({
					kind: 'topLevel-note',
					key: `t:${note.id}`,
					note,
				});
			} else if (item.type === 'folder') {
				const folder = folderById.get(item.id);
				if (!folder || folder.archived) continue;
				const children = notesByFolderId.get(folder.id) ?? [];
				const isCollapsed = collapsedSet.has(folder.id);
				const headerIsEnd = isCollapsed || children.length === 0;
				out.push({
					kind: 'folder-header',
					key: `f:${folder.id}`,
					folder,
					noteCount: children.length,
					collapsed: isCollapsed,
					inGroupStart: true,
					inGroupEnd: headerIsEnd,
				});
				if (!isCollapsed) {
					children.forEach((child, idx) => {
						out.push({
							kind: 'folder-child',
							key: `c:${child.id}`,
							note: child,
							inGroupStart: false,
							inGroupEnd: idx === children.length - 1,
						});
					});
				}
			}
		}

		// topLevelOrder に現れていない note をフォールバックで末尾に出す（データ破損への保険）
		const seen = new Set(
			out.flatMap((r) => (r.kind === 'folder-header' ? [] : [r.note.id])),
		);
		const renderedFolderIds = new Set(
			out.flatMap((r) => (r.kind === 'folder-header' ? [r.folder.id] : [])),
		);
		for (const n of noteList.notes) {
			if (n.archived) continue;
			if (seen.has(n.id)) continue;
			if (n.folderId && renderedFolderIds.has(n.folderId)) continue;
			out.push({
				kind: 'topLevel-note',
				key: `t:${n.id}`,
				note: n,
			});
		}
		return out;
	}, [noteList]);

	const handleCreate = async () => {
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
	};

	const handleToggleFolder = async (folderId: string) => {
		const currentlyCollapsed = new Set(noteList.collapsedFolderIds).has(
			folderId,
		);
		await noteService.setFolderCollapsed(folderId, !currentlyCollapsed);
		await useNotesStore.getState().reload();
	};

	// フォルダ行の背景階調（デスクトップ版と同じ:「ヘッダ > 子 > 外側背景」の順に濃い）
	const folderHeaderBg = theme.colors.surfaceVariant;
	const folderChildBg = theme.colors.elevation.level1;
	const divider = theme.colors.outline;

	return (
		<View
			style={[styles.container, { backgroundColor: theme.colors.background }]}
		>
			<Appbar.Header>
				<Appbar.Content title={t('app.title')} />
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
				<FlatList
					data={rows}
					keyExtractor={(row) => row.key}
					contentContainerStyle={styles.listContent}
					ItemSeparatorComponent={({ leadingItem }) => {
						// React Native の ItemSeparatorComponent は trailingItem を渡さないため、
						// leading 側の情報だけで「次も同じグループか」を判定する。
						// folder-header/folder-child で inGroupEnd=false なら次は同じグループの folder-child。
						const l = leadingItem as Row | undefined;
						const sameGroup =
							l !== undefined &&
							(l.kind === 'folder-header' || l.kind === 'folder-child') &&
							!l.inGroupEnd;
						return (
							<View
								style={
									sameGroup
										? {
												height: StyleSheet.hairlineWidth,
												marginHorizontal: 12,
												backgroundColor: theme.colors.outlineVariant,
											}
										: {
												height: StyleSheet.hairlineWidth,
												backgroundColor: divider,
											}
								}
							/>
						);
					}}
					renderItem={({ item }) => {
						if (item.kind === 'topLevel-note') {
							return (
								<NoteListItem
									metadata={item.note}
									onPress={(id) => router.push(`/note/${id}`)}
								/>
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
										onToggle={handleToggleFolder}
									/>
								</View>
							);
						}
						// folder-child
						return (
							<View
								style={[
									{ backgroundColor: folderChildBg },
									styles.groupSide,
									item.inGroupEnd && styles.groupBottom,
								]}
							>
								<NoteListItem
									metadata={item.note}
									onPress={(id) => router.push(`/note/${id}`)}
									indented
								/>
							</View>
						);
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
		</View>
	);
}

const GROUP_RADIUS = 10;
const GROUP_MARGIN = 8;

const styles = StyleSheet.create({
	container: { flex: 1 },
	empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
	fab: { position: 'absolute', right: 16, bottom: 16 },
	listContent: { paddingBottom: 96 },
	groupSide: {
		marginHorizontal: GROUP_MARGIN,
		// 子の Pressable (ripple / pressed 背景) を角丸形状で clip する。
		// 付けないと押下時にコーナーが一瞬角ばって見える。
		overflow: 'hidden',
	},
	groupTop: {
		borderTopLeftRadius: GROUP_RADIUS,
		borderTopRightRadius: GROUP_RADIUS,
		marginTop: GROUP_MARGIN,
	},
	groupBottom: {
		borderBottomLeftRadius: GROUP_RADIUS,
		borderBottomRightRadius: GROUP_RADIUS,
		marginBottom: GROUP_MARGIN,
	},
});
