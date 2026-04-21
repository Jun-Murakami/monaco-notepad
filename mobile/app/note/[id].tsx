import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Appbar, Menu, SegmentedButtons, useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { SyncStatusBar } from '@/components/SyncStatusBar';
import { SyntaxHighlightView } from '@/components/SyntaxHighlightView';
import { driveService } from '@/services/sync/driveService';
import { useNotesStore } from '@/stores/notesStore';
import type { Note } from '@/services/sync/types';

type Mode = 'view' | 'edit';

const LANGUAGES = [
	'plaintext',
	'markdown',
	'typescript',
	'javascript',
	'python',
	'go',
	'rust',
	'bash',
	'json',
	'yaml',
	'html',
	'css',
];

export default function NoteEditorScreen() {
	const { t } = useTranslation();
	const theme = useTheme();
	const router = useRouter();
	const { id } = useLocalSearchParams<{ id: string }>();

	const [note, setNote] = useState<Note | null>(null);
	const [mode, setMode] = useState<Mode>('view');
	const [langMenuOpen, setLangMenuOpen] = useState(false);
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const latestNoteRef = useRef<Note | null>(null);

	const reload = useCallback(async () => {
		if (!id) return;
		const loaded = await useNotesStore.getState().getNote(id);
		setNote(loaded);
		latestNoteRef.current = loaded;
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
			<View style={styles.container}>
				<Appbar.Header>
					<Appbar.BackAction onPress={() => router.back()} />
					<Appbar.Content title="" />
				</Appbar.Header>
			</View>
		);
	}

	const handleDelete = async () => {
		await driveService.deleteNoteAndSync(note.id);
		router.back();
	};

	const handleArchive = () => {
		const next = { ...note, archived: !note.archived, modifiedTime: new Date().toISOString() };
		scheduleSave(next);
	};

	return (
		<View style={styles.container}>
			<Appbar.Header>
				<Appbar.BackAction onPress={() => router.back()} />
				<Appbar.Content title={note.title || t('editor.titlePlaceholder')} />
				<Menu
					visible={langMenuOpen}
					onDismiss={() => setLangMenuOpen(false)}
					anchor={
						<Appbar.Action icon="code-tags" onPress={() => setLangMenuOpen(true)} />
					}
				>
					{LANGUAGES.map((lang) => (
						<Menu.Item
							key={lang}
							title={lang}
							onPress={() => {
								setLangMenuOpen(false);
								scheduleSave({ ...note, language: lang, modifiedTime: new Date().toISOString() });
							}}
							trailingIcon={note.language === lang ? 'check' : undefined}
						/>
					))}
				</Menu>
				<Appbar.Action
					icon={note.archived ? 'archive-off' : 'archive'}
					onPress={handleArchive}
				/>
				<Appbar.Action icon="trash-can" onPress={handleDelete} />
			</Appbar.Header>
			<SyncStatusBar />
			<View style={styles.modeBar}>
				<SegmentedButtons
					value={mode}
					onValueChange={(v) => setMode(v as Mode)}
					buttons={[
						{ value: 'view', label: t('editor.view'), icon: 'eye' },
						{ value: 'edit', label: t('editor.edit'), icon: 'pencil' },
					]}
				/>
			</View>
			<TextInput
				style={[styles.titleInput, { color: theme.colors.onBackground }]}
				placeholder={t('editor.titlePlaceholder')}
				placeholderTextColor={theme.colors.onSurfaceVariant}
				value={note.title}
				onChangeText={(title) =>
					scheduleSave({
						...note,
						title,
						modifiedTime: new Date().toISOString(),
					})
				}
			/>
			{mode === 'view' ? (
				<ScrollView style={styles.viewer}>
					<SyntaxHighlightView content={note.content} language={note.language} />
				</ScrollView>
			) : (
				<TextInput
					style={[styles.editor, { color: theme.colors.onBackground }]}
					placeholder={t('editor.contentPlaceholder')}
					placeholderTextColor={theme.colors.onSurfaceVariant}
					multiline
					value={note.content}
					onChangeText={(content) =>
						scheduleSave({
							...note,
							content,
							contentHeader: content.slice(0, 100).replace(/\n/g, ' '),
							modifiedTime: new Date().toISOString(),
						})
					}
				/>
			)}
		</View>
	);
}

const monoFamily = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

const styles = StyleSheet.create({
	container: { flex: 1 },
	modeBar: { padding: 8 },
	titleInput: {
		fontSize: 20,
		fontWeight: '600',
		paddingHorizontal: 16,
		paddingVertical: 8,
	},
	viewer: {
		flex: 1,
	},
	editor: {
		flex: 1,
		padding: 16,
		textAlignVertical: 'top',
		fontFamily: monoFamily,
		fontSize: 14,
	},
});
