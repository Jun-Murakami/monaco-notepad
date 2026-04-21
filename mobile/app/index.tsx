import { useRouter } from 'expo-router';
import { FlatList, StyleSheet, View } from 'react-native';
import { AnimatedFAB, Appbar, Divider, Text } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { NoteListItem } from '@/components/NoteListItem';
import { SyncStatusBar } from '@/components/SyncStatusBar';
import { useNotesStore } from '@/stores/notesStore';
import { useAuthStore } from '@/stores/authStore';
import { noteService } from '@/services/notes/noteService';
import { uuidv4 } from '@/utils/uuid';

export default function NoteListScreen() {
	const { t } = useTranslation();
	const router = useRouter();
	const noteList = useNotesStore((s) => s.noteList);
	const signedIn = useAuthStore((s) => s.signedIn);

	const activeNotes = noteList.notes.filter((n) => !n.archived);

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
		await useNotesStore.getState().reload();
		router.push(`/note/${id}`);
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
			{activeNotes.length === 0 ? (
				<View style={styles.empty}>
					<Text variant="bodyMedium">{t('noteList.empty')}</Text>
				</View>
			) : (
				<FlatList
					data={activeNotes}
					keyExtractor={(item) => item.id}
					renderItem={({ item }) => (
						<NoteListItem metadata={item} onPress={(id) => router.push(`/note/${id}`)} />
					)}
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
});
