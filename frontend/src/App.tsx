import {
	Box,
	Button,
	CssBaseline,
	Divider,
	ThemeProvider,
	Typography,
} from '@mui/material';
import type { editor } from 'monaco-editor';
import { useCallback, useMemo, useRef, useState } from 'react';
import SimpleBar from 'simplebar-react';
import { AppBar } from './components/AppBar';
import { ArchivedNoteList } from './components/ArchivedNoteList';
import { Editor } from './components/Editor';
import { EditorStatusBar } from './components/EditorStatusBar';
import { MessageDialog } from './components/MessageDialog';
import { NoteList } from './components/NoteList';
import { NoteSearchBox } from './components/NoteSearchBox';
import { SettingsDialog } from './components/SettingsDialog';
import { useEditorSettings } from './hooks/useEditorSettings';
import { useFileNotes } from './hooks/useFileNotes';
import { useFileOperations } from './hooks/useFileOperations';
import { useInitialize } from './hooks/useInitialize';
import { useMessageDialog } from './hooks/useMessageDialog';
import { useNoteSelecter } from './hooks/useNoteSelecter';
import { useNotes } from './hooks/useNotes';
import { darkTheme, lightTheme } from './lib/theme';
import type { FileNote, Note } from './types';
import 'simplebar-react/dist/simplebar.min.css';
import { Inventory } from '@mui/icons-material';

function App() {
	// エディタ設定
	const {
		isSettingsOpen,
		setIsSettingsOpen,
		editorSettings,
		setEditorSettings,
		handleSettingsChange,
	} = useEditorSettings();

	// メッセージダイアログ
	const {
		isMessageDialogOpen,
		messageTitle,
		messageContent,
		showMessage,
		onResult,
		isTwoButton,
		primaryButtonText,
		secondaryButtonText,
	} = useMessageDialog();

	// ノート
	const {
		notes,
		setNotes,
		currentNote,
		setCurrentNote,
		showArchived,
		setShowArchived,
		handleNewNote,
		handleArchiveNote,
		handleSelectNote,
		handleUnarchiveNote,
		handleDeleteNote,
		handleDeleteAllArchivedNotes,
		handleTitleChange,
		handleLanguageChange,
		handleNoteContentChange,
	} = useNotes();

	// ファイルノート
	const {
		fileNotes,
		setFileNotes,
		currentFileNote,
		setCurrentFileNote,
		handleSelectFileNote,
		handleSaveFileNotes,
		handleFileNoteContentChange,
		handleCloseFile,
		isFileModified,
	} = useFileNotes({
		notes,
		setCurrentNote,
		handleNewNote,
		handleSelectNote,
		showMessage,
	});

	// ノート選択専用フック
	const {
		handleSelecAnyNote,
		handleSelectNextAnyNote,
		handleSelectPreviousAnyNote,
	} = useNoteSelecter({
		handleSelectNote,
		handleSelectFileNote,
		notes,
		fileNotes,
		currentNote,
		currentFileNote,
		setCurrentNote,
		setCurrentFileNote,
	});

	// ファイル操作
	const {
		handleOpenFile,
		handleSaveFile,
		handleSaveAsFile,
		handleConvertToNote,
	} = useFileOperations(
		notes,
		setNotes,
		currentNote,
		currentFileNote,
		fileNotes,
		setFileNotes,
		handleSelecAnyNote,
		showMessage,
		handleSaveFileNotes,
	);

	// 初期化
	const { languages, platform } = useInitialize(
		setNotes,
		setFileNotes,
		handleNewNote,
		handleSelecAnyNote,
		currentFileNote,
		setCurrentFileNote,
		handleSaveFile,
		handleOpenFile,
		handleCloseFile,
		isFileModified,
		currentNote,
		handleArchiveNote,
		handleSaveAsFile,
		handleSelectNextAnyNote,
		handleSelectPreviousAnyNote,
	);

	const STATUS_BAR_HEIGHT = platform === 'darwin' ? 83 : 57;

	const editorInstanceRef = useRef<editor.IStandaloneCodeEditor | null>(null);

	const [noteSearch, setNoteSearch] = useState('');
	const [searchMatchIndex, setSearchMatchIndex] = useState(0);

	const filteredNotes = useMemo(() => {
		if (!noteSearch) return notes;
		const q = noteSearch.toLowerCase();
		return notes.filter((note) => {
			if (note.archived) return false;
			return (
				note.title.toLowerCase().includes(q) ||
				(note.content?.toLowerCase().includes(q) ?? false)
			);
		});
	}, [notes, noteSearch]);

	const filteredFileNotes = useMemo(() => {
		if (!noteSearch) return fileNotes;
		const q = noteSearch.toLowerCase();
		return fileNotes.filter(
			(note) =>
				note.fileName.toLowerCase().includes(q) ||
				note.content.toLowerCase().includes(q),
		);
	}, [fileNotes, noteSearch]);

	const totalSearchMatches =
		filteredNotes.filter((n) => !n.archived).length + filteredFileNotes.length;

	const handleSearchChange = useCallback((value: string) => {
		setNoteSearch(value);
		setSearchMatchIndex(value ? 1 : 0);
	}, []);

	const handleSearchNavigate = useCallback(
		(direction: 'next' | 'prev') => {
			if (totalSearchMatches === 0) return;
			const allMatched = [
				...filteredFileNotes,
				...filteredNotes.filter((n) => !n.archived),
			];
			let newIndex = searchMatchIndex;
			if (direction === 'next') {
				newIndex =
					searchMatchIndex >= totalSearchMatches ? 1 : searchMatchIndex + 1;
			} else {
				newIndex =
					searchMatchIndex <= 1 ? totalSearchMatches : searchMatchIndex - 1;
			}
			setSearchMatchIndex(newIndex);
			const target = allMatched[newIndex - 1];
			if (target) handleSelecAnyNote(target);
		},
		[
			totalSearchMatches,
			searchMatchIndex,
			filteredFileNotes,
			filteredNotes,
			handleSelecAnyNote,
		],
	);

	return (
		<ThemeProvider theme={editorSettings.isDarkMode ? darkTheme : lightTheme}>
			<CssBaseline />
			<Box
				sx={{
					width: '100vw',
					height: '100vh',
					position: 'relative',
					// ドロップ対象エリアとして設定
					'.wails-drop-target-active': {
						backgroundColor: (theme) =>
							theme.palette.mode === 'dark'
								? 'rgba(255, 255, 255, 0.05)'
								: 'rgba(0, 0, 0, 0.05)',
					},
					'--wails-drop-target': 'drop',
				}}
				component="main"
			>
				{platform !== 'windows' && (
					<Box
						sx={{
							height: 26,
							width: '100vw',
							'--wails-draggable': 'drag',
							backgroundColor: editorSettings.isDarkMode
								? 'rgba(255, 255, 255, 0.2)'
								: 'action.disabledBackground',
						}}
					/>
				)}
				<AppBar
					currentNote={currentFileNote || currentNote}
					languages={languages}
					platform={platform}
					onTitleChange={handleTitleChange}
					onLanguageChange={handleLanguageChange}
					onSettings={() => setIsSettingsOpen(true)}
					onNew={handleNewNote}
					onOpen={handleOpenFile}
					onSave={handleSaveAsFile}
					showMessage={showMessage}
				/>
				<Divider />
				<Box
					aria-label="Note List"
					sx={{
						position: 'absolute',
						top: STATUS_BAR_HEIGHT,
						left: 0,
						borderRight: 1,
						borderColor: 'divider',
						width: 242,
						height: `calc(100% - ${STATUS_BAR_HEIGHT}px)`,
						display: 'flex',
						flexDirection: 'column',
						'& .simplebar-track.simplebar-vertical .simplebar-scrollbar:before':
							{
								backgroundColor: 'text.secondary',
							},
					}}
				>
					<Box sx={{ flex: '1 1 0', minHeight: 0, overflow: 'hidden' }}>
						<SimpleBar style={{ height: '100%' }}>
							{filteredFileNotes.length > 0 && (
								<>
									<Box
										sx={{
											height: 26,
											justifyContent: 'center',
											alignItems: 'center',
											display: 'flex',
											backgroundColor: 'action.disabledBackground',
										}}
									>
										<Typography variant="body2" color="text.secondary">
											Local files
										</Typography>
									</Box>
									<NoteList
										notes={noteSearch ? filteredFileNotes : fileNotes}
										currentNote={currentFileNote}
										onNoteSelect={handleSelecAnyNote}
										onConvertToNote={handleConvertToNote}
										onSaveFile={handleSaveFile}
										onReorder={async (newNotes) => {
											setFileNotes(newNotes as FileNote[]);
										}}
										isFileMode={true}
										onCloseFile={handleCloseFile}
										isFileModified={isFileModified}
										platform={platform}
									/>
								</>
							)}
							<Box
								sx={{
									height: 26,
									justifyContent: 'center',
									alignItems: 'center',
									display: 'flex',
									backgroundColor: 'action.disabledBackground',
								}}
							>
								<Typography variant="body2" color="text.secondary">
									Notes
								</Typography>
							</Box>
							<NoteList
								notes={noteSearch ? filteredNotes : notes}
								currentNote={currentNote}
								onNoteSelect={handleSelecAnyNote}
								onArchive={handleArchiveNote}
								onReorder={async (newNotes) => {
									setNotes(newNotes as Note[]);
								}}
								platform={platform}
							/>
						</SimpleBar>
					</Box>
					<NoteSearchBox
						value={noteSearch}
						onChange={handleSearchChange}
						onNext={() => handleSearchNavigate('next')}
						onPrevious={() => handleSearchNavigate('prev')}
						matchIndex={searchMatchIndex}
						matchCount={totalSearchMatches}
					/>
					<Button
						fullWidth
						disabled={notes.filter((note) => note.archived).length === 0}
						sx={{
							mt: 'auto',
							borderRadius: 0,
							borderTop: 1,
							borderColor: 'divider',
							zIndex: 1000,
							backgroundColor: 'background.paper',
							'&:hover': {
								backgroundColor: 'action.hover',
							},
						}}
						onClick={() => setShowArchived(true)}
						startIcon={<Inventory />}
					>
						Archives{' '}
						{notes.filter((note) => note.archived).length
							? `(${notes.filter((note) => note.archived).length})`
							: ''}
					</Button>
				</Box>

				<Box
					sx={{
						position: 'absolute',
						top: STATUS_BAR_HEIGHT,
						left: 242,
						width: 'calc(100% - 242px)',
						height: `calc(100% - ${STATUS_BAR_HEIGHT}px)`,
						display: 'flex',
						flexDirection: 'column',
					}}
				>
					{showArchived ? (
						<ArchivedNoteList
							notes={notes}
							onUnarchive={handleUnarchiveNote}
							onDelete={handleDeleteNote}
							onDeleteAll={handleDeleteAllArchivedNotes}
							onClose={() => setShowArchived(false)}
						/>
					) : (
						<Editor
							editorInstanceRef={editorInstanceRef}
							value={currentNote?.content || currentFileNote?.content || ''}
							onChange={
								currentNote
									? handleNoteContentChange
									: handleFileNoteContentChange
							}
							language={
								currentNote?.language ||
								currentFileNote?.language ||
								'plaintext'
							}
							settings={editorSettings}
							platform={platform}
							currentNote={currentNote || currentFileNote}
							onNew={handleNewNote}
							onOpen={handleOpenFile}
							onSave={async () => {
								if (currentFileNote && isFileModified(currentFileNote.id)) {
									await handleSaveFile(currentFileNote);
								}
							}}
							onClose={async () => {
								if (currentFileNote) {
									await handleCloseFile(currentFileNote);
								} else if (currentNote) {
									await handleArchiveNote(currentNote.id);
								}
							}}
							onSelectNext={handleSelectNextAnyNote}
							onSelectPrevious={handleSelectPreviousAnyNote}
						/>
					)}
					<EditorStatusBar
						currentNote={currentFileNote || currentNote}
						editorInstanceRef={editorInstanceRef}
					/>
				</Box>
			</Box>

			<SettingsDialog
				open={isSettingsOpen}
				settings={editorSettings}
				onClose={() => setIsSettingsOpen(false)}
				onChange={setEditorSettings}
				onSave={handleSettingsChange}
			/>
			<MessageDialog
				isOpen={isMessageDialogOpen}
				title={messageTitle}
				message={messageContent}
				isTwoButton={isTwoButton}
				primaryButtonText={primaryButtonText}
				secondaryButtonText={secondaryButtonText}
				onResult={onResult}
			/>
		</ThemeProvider>
	);
}

export default App;
