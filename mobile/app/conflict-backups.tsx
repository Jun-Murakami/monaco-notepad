import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import {
	Appbar,
	Button,
	Card,
	Chip,
	Dialog,
	Divider,
	List,
	Portal,
	Text,
	useTheme,
} from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { noteService } from '@/services/notes/noteService';
import {
	deleteAllConflictBackups,
	deleteConflictBackup,
	type ConflictBackupEntry,
	listConflictBackups,
} from '@/services/sync/conflictBackup';
import { driveService } from '@/services/sync/driveService';
import { syncStateManager } from '@/services/sync/syncState';
import type { Note } from '@/services/sync/types';
import { useNotesStore } from '@/stores/notesStore';
import { generateContentHeader } from '@/services/notes/noteService';
import { uuidv4 } from '@/utils/uuid';

export default function ConflictBackupsScreen() {
	const { t, i18n } = useTranslation();
	const router = useRouter();
	const theme = useTheme();
	const insets = useSafeAreaInsets();
	const [entries, setEntries] = useState<ConflictBackupEntry[]>([]);
	const [selected, setSelected] = useState<ConflictBackupEntry | null>(null);
	const [busy, setBusy] = useState(false);

	const formatter = useMemo(
		() =>
			new Intl.DateTimeFormat(i18n.language, {
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
			}),
		[i18n.language],
	);

	const reload = useCallback(async () => {
		setEntries(await listConflictBackups());
	}, []);

	useFocusEffect(
		useCallback(() => {
			void reload();
		}, [reload]),
	);

	const confirmDanger = useCallback(
		(title: string, message: string): Promise<boolean> =>
			new Promise((resolve) => {
				Alert.alert(title, message, [
					{
						text: t('settings.cancel'),
						style: 'cancel',
						onPress: () => resolve(false),
					},
					{
						text: t('settings.delete'),
						style: 'destructive',
						onPress: () => resolve(true),
					},
				]);
			}),
		[t],
	);

	const restoreSelected = async () => {
		if (!selected) return;
		setBusy(true);
		try {
			const now = new Date().toISOString();
			const restored: Note = {
				...selected.note,
				id: uuidv4(),
				title: selected.note.title
					? t('conflictBackups.restoredTitle', { title: selected.note.title })
					: t('conflictBackups.restoredUntitled'),
				contentHeader: generateContentHeader(selected.note.content),
				modifiedTime: now,
				archived: false,
				folderId: '',
			};
			await noteService.saveNote(restored, { prependToOrder: true });
			await syncStateManager.markNoteDirty(restored.id);
			await useNotesStore.getState().reload();
			driveService.kickSync();
			setSelected(null);
			router.replace(`/note/${restored.id}`);
		} finally {
			setBusy(false);
		}
	};

	const deleteSelected = async () => {
		if (!selected) return;
		const confirmed = await confirmDanger(
			t('conflictBackups.deleteTitle'),
			t('conflictBackups.deleteMessage'),
		);
		if (!confirmed) return;
		await deleteConflictBackup(selected.filename);
		setSelected(null);
		await reload();
	};

	const deleteAll = async () => {
		if (entries.length === 0) return;
		const confirmed = await confirmDanger(
			t('conflictBackups.deleteAllTitle'),
			t('conflictBackups.deleteAllMessage'),
		);
		if (!confirmed) return;
		await deleteAllConflictBackups();
		await reload();
	};

	return (
		<View style={styles.container}>
			<Appbar.Header>
				<Appbar.BackAction onPress={() => router.back()} />
				<Appbar.Content title={t('conflictBackups.title')} />
				<Appbar.Action
					icon="delete-sweep-outline"
					onPress={deleteAll}
					disabled={entries.length === 0}
					accessibilityLabel={t('conflictBackups.deleteAll')}
				/>
			</Appbar.Header>
			<ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
				{entries.length === 0 ? (
					<View style={styles.empty}>
						<Text variant="bodyMedium">{t('conflictBackups.empty')}</Text>
					</View>
				) : (
					entries.map((entry) => (
						<Card
							key={entry.id}
							mode="outlined"
							style={styles.card}
							onPress={() => setSelected(entry)}
						>
							<Card.Title
								title={entry.note.title || t('noteList.emptyNote')}
								subtitle={formatter.format(new Date(entry.createdAt))}
								left={(props) => (
									<List.Icon
										{...props}
										icon={
											entry.kind === 'cloud_delete'
												? 'cloud-remove-outline'
												: 'cloud-sync-outline'
										}
									/>
								)}
							/>
							<Card.Content>
								<Chip compact style={styles.chip}>
									{t(`conflictBackups.kind_${entry.kind}`)}
								</Chip>
								<Text
									variant="bodySmall"
									numberOfLines={3}
									style={{ color: theme.colors.onSurfaceVariant }}
								>
									{entry.note.contentHeader ||
										entry.note.content ||
										t('conflictBackups.noPreview')}
								</Text>
							</Card.Content>
						</Card>
					))
				)}
			</ScrollView>
			<Portal>
				<Dialog visible={selected !== null} onDismiss={() => setSelected(null)}>
					<Dialog.Title>
						{selected?.note.title || t('noteList.emptyNote')}
					</Dialog.Title>
					<Dialog.Content>
						{selected && (
							<>
								<Chip compact style={styles.chip}>
									{t(`conflictBackups.kind_${selected.kind}`)}
								</Chip>
								<Text variant="bodySmall" style={styles.detailMeta}>
									{formatter.format(new Date(selected.createdAt))}
								</Text>
								<Divider style={styles.detailDivider} />
								<ScrollView style={styles.previewBox}>
									<Text variant="bodyMedium">
										{selected.note.content || t('conflictBackups.noPreview')}
									</Text>
								</ScrollView>
							</>
						)}
					</Dialog.Content>
					<Dialog.Actions>
						<Button onPress={deleteSelected} disabled={busy}>
							{t('conflictBackups.delete')}
						</Button>
						<Button onPress={restoreSelected} loading={busy} disabled={busy}>
							{t('conflictBackups.restore')}
						</Button>
					</Dialog.Actions>
				</Dialog>
			</Portal>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1 },
	empty: {
		padding: 24,
		alignItems: 'center',
	},
	card: {
		marginHorizontal: 12,
		marginTop: 12,
	},
	chip: {
		alignSelf: 'flex-start',
		marginBottom: 8,
	},
	detailMeta: {
		marginBottom: 8,
	},
	detailDivider: {
		marginBottom: 8,
	},
	previewBox: {
		maxHeight: 320,
	},
});
