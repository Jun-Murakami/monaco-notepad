import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, StyleSheet, View } from 'react-native';
import { AnimatedFAB, Appbar, Divider, Text } from 'react-native-paper';
import { FolderListItem } from '@/components/FolderListItem';
import { NoteListItem } from '@/components/NoteListItem';
import { SyncStatusBar } from '@/components/SyncStatusBar';
import { noteService } from '@/services/notes/noteService';
import { syncStateManager } from '@/services/sync/syncState';
import type { Folder, NoteMetadata } from '@/services/sync/types';
import { useAuthStore } from '@/stores/authStore';
import { useNotesStore } from '@/stores/notesStore';
import { uuidv4 } from '@/utils/uuid';

type Row =
	| { kind: 'note'; note: NoteMetadata; indent: boolean }
	| {
			kind: 'folder';
			folder: Folder;
			noteCount: number;
			collapsed: boolean;
	  };

export default function NoteListScreen() {
	const { t } = useTranslation();
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
		const collapsed = new Set(noteList.collapsedFolderIds);

		const out: Row[] = [];
		for (const item of noteList.topLevelOrder) {
			if (item.type === 'note') {
				const note = notesById.get(item.id);
				if (!note || note.archived) continue;
				// 安全側: topLevelOrder にあっても folderId が残っていれば folder 側で出す
				if (note.folderId) continue;
				out.push({ kind: 'note', note, indent: false });
			} else if (item.type === 'folder') {
				const folder = folderById.get(item.id);
				if (!folder || folder.archived) continue;
				const children = notesByFolderId.get(folder.id) ?? [];
				const isCollapsed = collapsed.has(folder.id);
				out.push({
					kind: 'folder',
					folder,
					noteCount: children.length,
					collapsed: isCollapsed,
				});
				if (!isCollapsed) {
					for (const child of children) {
						out.push({ kind: 'note', note: child, indent: true });
					}
				}
			}
		}

		// topLevelOrder に現れていない note をフォールバックで末尾に出す（データ破損からの保険）
		const seen = new Set(
			out.flatMap((r) => (r.kind === 'note' ? [r.note.id] : [])),
		);
		const orderedFolderIds = new Set(
			out.flatMap((r) => (r.kind === 'folder' ? [r.folder.id] : [])),
		);
		for (const n of noteList.notes) {
			if (n.archived) continue;
			if (seen.has(n.id)) continue;
			if (n.folderId && orderedFolderIds.has(n.folderId)) continue; // すでにフォルダ配下で出す
			out.push({ kind: 'note', note: n, indent: false });
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

	return (
		<View style={styles.container}>
			<Appbar.Header>
				<Appbar.Content title={t('app.title')} />
				{signedIn ? (
					<Appbar.Action icon="cog" onPress={() => router.push('/settings')} />
				) : (
					<Appbar.Action icon="login" onPress={() => router.push('/signin')} />
				)}
			</Appbar.Header>
			<SyncStatusBar />
			<Divider />
			{rows.length === 0 ? (
				<View style={styles.empty}>
					<Text variant="bodyMedium">{t('noteList.empty')}</Text>
				</View>
			) : (
				<FlatList
					data={rows}
					keyExtractor={(row) =>
						row.kind === 'folder' ? `f:${row.folder.id}` : `n:${row.note.id}`
					}
					renderItem={({ item }) => {
						if (item.kind === 'folder') {
							return (
								<FolderListItem
									folder={item.folder}
									noteCount={item.noteCount}
									collapsed={item.collapsed}
									onToggle={handleToggleFolder}
								/>
							);
						}
						return (
							<View style={item.indent ? styles.indent : undefined}>
								<NoteListItem
									metadata={item.note}
									onPress={(id) => router.push(`/note/${id}`)}
								/>
							</View>
						);
					}}
					ItemSeparatorComponent={() => <Divider />}
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

const styles = StyleSheet.create({
	container: { flex: 1 },
	empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
	fab: { position: 'absolute', right: 16, bottom: 16 },
	indent: { paddingLeft: 24 },
});
