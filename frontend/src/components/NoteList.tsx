import {
	Archive,
	ChevronRight,
	Close,
	Delete,
	DriveFileRenameOutline,
	ExpandMore,
	Folder as FolderIcon,
	FolderOpen,
	Save,
	SimCardDownload,
} from '@mui/icons-material';
import {
	alpha,
	Box,
	IconButton,
	InputBase,
	List,
	ListItemButton,
	Menu,
	MenuItem,
	Tooltip,
	Typography,
	useTheme,
} from '@mui/material';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SaveFileNotes, UpdateNoteOrder } from '../../wailsjs/go/backend/App';
import type { FileNote, Folder, Note, TopLevelItem } from '../types';
import dayjs from '../utils/dayjs';
import { NotePreviewPopper } from './NotePreviewPopper';

const DRAG_START_DISTANCE = 6;
const INDICATOR_SIDE_INSET = 8;
const INDICATOR_FOLDER_INDENT = 12;
const DRAG_CLICK_SUPPRESS_MS = 250;

const detectTargetPane = (x: number, y: number): 'left' | 'right' | null => {
	const elements = document.elementsFromPoint(x, y);
	for (const el of elements) {
		const paneEl = (el as HTMLElement).closest('[data-pane]');
		if (paneEl) {
			return paneEl.getAttribute('data-pane') as 'left' | 'right';
		}
	}
	return null;
};

const getNoteTitle = (note: Note | FileNote): { text: string; isFallback: boolean } => {
	if ('filePath' in note) {
		return { text: note.fileName, isFallback: false };
	}

	if (note.title.trim()) return { text: note.title, isFallback: false };
	if (note.syncing) return { text: 'Loading...', isFallback: true };

	if (note.archived && note.contentHeader) {
		return {
			text: note.contentHeader.replace(/\r\n|\n|\r/g, ' ').slice(0, 30),
			isFallback: true,
		};
	}

	const content = note.content?.trim() || '';
	if (!content) return { text: 'New Note', isFallback: true };

	const firstNonEmptyLine = content.split('\n').find((line) => line.trim().length > 0);
	if (!firstNonEmptyLine) return { text: 'New Note', isFallback: true };

	return {
		text: content.replace(/\r\n|\n|\r/g, ' ').slice(0, 30),
		isFallback: true,
	};
};

const isFileNote = (note: Note | FileNote): note is FileNote => 'filePath' in note;

const toTopLevelRowID = (item: TopLevelItem): string => `${item.type}:${item.id}`;

const parseTopLevelRowID = (id: string): TopLevelItem | null => {
	const split = id.indexOf(':');
	if (split === -1) return null;
	const type = id.slice(0, split);
	if (type !== 'note' && type !== 'folder') return null;
	return {
		type,
		id: id.slice(split + 1),
	};
};

const insertAt = <T,>(items: T[], item: T, index: number): T[] => {
	const safe = Math.max(0, Math.min(index, items.length));
	return [...items.slice(0, safe), item, ...items.slice(safe)];
};

const moveByInsertIndex = <T,>(items: T[], from: number, insertIndexBeforeRemoval: number): T[] => {
	if (from < 0 || from >= items.length) return items;
	let insertIndex = insertIndexBeforeRemoval;
	if (insertIndex > from) {
		insertIndex -= 1;
	}
	const clone = [...items];
	const [picked] = clone.splice(from, 1);
	if (picked === undefined) return items;
	const safe = Math.max(0, Math.min(insertIndex, clone.length));
	clone.splice(safe, 0, picked);
	return clone;
};

const normalizeTopLevelOrder = (
	order: TopLevelItem[],
	activeNotes: Note[],
	folders: Folder[],
	isTopLevelNote: (note: Note) => boolean,
): TopLevelItem[] => {
	const topLevelNoteIDs = new Set(activeNotes.filter(isTopLevelNote).map((note) => note.id));
	const folderIDs = new Set(folders.map((folder) => folder.id));

	const result: TopLevelItem[] = [];
	const seen = new Set<string>();

	for (const item of order) {
		const key = `${item.type}:${item.id}`;
		if (seen.has(key)) continue;

		if (item.type === 'note' && topLevelNoteIDs.has(item.id)) {
			result.push(item);
			seen.add(key);
		}
		if (item.type === 'folder' && folderIDs.has(item.id)) {
			result.push(item);
			seen.add(key);
		}
	}

	for (const folder of folders) {
		const key = `folder:${folder.id}`;
		if (!seen.has(key)) {
			result.push({ type: 'folder', id: folder.id });
			seen.add(key);
		}
	}

	for (const note of activeNotes) {
		if (!isTopLevelNote(note)) continue;
		const key = `note:${note.id}`;
		if (!seen.has(key)) {
			result.push({ type: 'note', id: note.id });
			seen.add(key);
		}
	}

	return result;
};

const getGlobalInsertIndexForFolderPosition = (
	notesWithout: Note[],
	folderId: string,
	posInFolder: number,
	fallbackIndex: number,
): number => {
	const positions: number[] = [];
	for (let i = 0; i < notesWithout.length; i += 1) {
		if (notesWithout[i]?.folderId === folderId) {
			positions.push(i);
		}
	}

	if (positions.length === 0) {
		return Math.max(0, Math.min(fallbackIndex, notesWithout.length));
	}
	if (posInFolder <= 0) return positions[0] ?? 0;
	if (posInFolder >= positions.length) {
		return (positions[positions.length - 1] ?? notesWithout.length - 1) + 1;
	}
	return positions[posInFolder] ?? notesWithout.length;
};

const getGlobalInsertIndexForTopLevelPosition = (
	notesWithout: Note[],
	orderWithoutMovedNote: TopLevelItem[],
	topLevelInsertIndex: number,
): number => {
	const safe = Math.max(0, Math.min(topLevelInsertIndex, orderWithoutMovedNote.length));
	for (let i = safe; i < orderWithoutMovedNote.length; i += 1) {
		const item = orderWithoutMovedNote[i];
		if (!item) continue;

		if (item.type === 'note') {
			const idx = notesWithout.findIndex((n) => n.id === item.id);
			if (idx !== -1) return idx;
			continue;
		}

		const firstInFolder = notesWithout.findIndex((n) => n.folderId === item.id);
		if (firstInFolder !== -1) return firstInFolder;
	}

	return notesWithout.length;
};

interface NoteListProps {
	notes: Note[] | FileNote[];
	currentNote: Note | FileNote | null;
	onNoteSelect: (note: Note | FileNote) => Promise<void>;
	onArchive?: (noteId: string) => Promise<void>;
	onConvertToNote?: (fileNote: FileNote) => Promise<void>;
	onSaveFile?: (fileNote: FileNote) => Promise<void>;
	onReorder?: (notes: Note[] | FileNote[]) => void;
	isFileMode?: boolean;
	onCloseFile?: (note: FileNote) => Promise<void>;
	isFileModified?: (fileId: string) => boolean;
	platform: string;
	folders?: Folder[];
	collapsedFolders?: Set<string>;
	onToggleFolderCollapse?: (folderId: string) => void;
	onRenameFolder?: (id: string, name: string) => void;
	onDeleteFolder?: (id: string) => void;
	onMoveNoteToFolder?: (noteID: string, folderID: string) => void;
	editingFolderId?: string | null;
	onEditingFolderDone?: () => void;
	topLevelOrder?: TopLevelItem[];
	onUpdateTopLevelOrder?: (order: TopLevelItem[]) => void;
	onArchiveFolder?: (folderId: string) => Promise<void>;
	secondarySelectedNoteId?: string;
	onOpenInPane?: (note: Note | FileNote, pane: 'left' | 'right') => void;
	canSplit?: boolean;
}

interface NoteItemProps {
	note: Note | FileNote;
	currentNote: Note | FileNote | null;
	onNoteSelect: (note: Note | FileNote) => Promise<void>;
	onArchive?: (noteId: string) => Promise<void>;
	onConvertToNote?: (fileNote: FileNote) => Promise<void>;
	onSaveFile?: (fileNote: FileNote) => Promise<void>;
	getNoteTitle: (note: Note | FileNote) => {
		text: string;
		isFallback: boolean;
	};
	isFileMode?: boolean;
	onCloseFile?: (note: FileNote) => Promise<void>;
	isFileModified?: (fileId: string) => boolean;
	platform: string;
	secondarySelectedNoteId?: string;
	onOpenInPane?: (note: Note | FileNote, pane: 'left' | 'right') => void;
	canSplit?: boolean;
	isDragging?: boolean;
}

const NoteItem: React.FC<NoteItemProps> = memo(
	({
		note,
		currentNote,
		onNoteSelect,
		onArchive,
		onConvertToNote,
		onSaveFile,
		getNoteTitle,
		isFileMode,
		onCloseFile,
		isFileModified,
		platform,
		secondarySelectedNoteId,
		onOpenInPane,
		canSplit,
		isDragging,
	}) => {
		const theme = useTheme();
		const cmdKey = platform === 'darwin' ? 'Cmd' : 'Ctrl';
		const noteTitle = getNoteTitle(note);
		const [contextMenu, setContextMenu] = useState<{ mouseX: number; mouseY: number } | null>(null);
		const syncing = !isFileNote(note) && !!note.syncing;

		const handleContextMenu = (event: React.MouseEvent) => {
			if (syncing) return;
			event.preventDefault();
			event.stopPropagation();
			setContextMenu(contextMenu === null ? { mouseX: event.clientX + 2, mouseY: event.clientY - 6 } : null);
		};

		return (
			<NotePreviewPopper
				content={'content' in note ? (note.content ?? undefined) : undefined}
				anchorX={242}
				disabled={contextMenu !== null || syncing || !!isDragging}
			>
				<Box
					sx={{
						position: 'relative',
						'&:hover .action-button': { opacity: syncing ? 0 : 1 },
					}}
				>
					<ListItemButton
						selected={!syncing && currentNote?.id === note.id}
						disabled={syncing}
						onClick={async () => {
							if (!syncing && currentNote?.id !== note.id) {
								await onNoteSelect(note);
							}
						}}
						onContextMenu={handleContextMenu}
						sx={{
							display: 'flex',
							flexDirection: 'column',
							alignItems: 'flex-start',
							pt: 0.5,
							pb: 0.25,
							px: 1.5,
							...(theme.palette.mode === 'light' && {
								'&.Mui-selected': {
									backgroundColor: alpha(theme.palette.primary.main, 0.16),
								},
								'&.Mui-selected:hover': {
									backgroundColor: alpha(theme.palette.primary.main, 0.24),
								},
							}),
							...(currentNote?.id !== note.id &&
								note.id === secondarySelectedNoteId && {
									backgroundColor: alpha(theme.palette.secondary.main, 0.16),
									'&:hover': {
										backgroundColor: alpha(theme.palette.secondary.main, 0.24),
									},
								}),
						}}
					>
						<Typography
							noWrap
							variant='body2'
							sx={{
								width: '100%',
								fontStyle: isFileModified?.(note.id) || noteTitle.isFallback ? 'italic' : 'normal',
								opacity: noteTitle.isFallback ? 0.6 : 1,
							}}
						>
							{isFileModified?.(note.id) && (
								<DriveFileRenameOutline
									sx={{
										mb: -0.5,
										mr: 0.5,
										width: 18,
										height: 18,
										color: 'text.secondary',
									}}
								/>
							)}
							{noteTitle.text}
						</Typography>
						<Typography
							variant='caption'
							sx={{
								color: theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.20)' : 'rgba(0, 0, 0, 0.20)',
								width: '100%',
								textAlign: 'right',
							}}
						>
							{dayjs(note.modifiedTime).format('L _ HH:mm:ss')}
						</Typography>
					</ListItemButton>
					{isFileMode ? (
						<>
							<Tooltip title={`Save (${cmdKey} + S)`} arrow placement='bottom'>
								<span style={{ position: 'absolute', right: 72, top: 8 }}>
									<IconButton
										data-no-drag='true'
										className='action-button'
										disabled={!isFileModified?.(note.id) || (isFileNote(note) && note.filePath === '')}
										onPointerDown={(e) => e.stopPropagation()}
										onClick={async (e) => {
											e.stopPropagation();
											if (isFileNote(note) && isFileModified?.(note.id) && onSaveFile) {
												await onSaveFile(note);
											}
										}}
										sx={{
											opacity: 0,
											transition: 'opacity 0.2s',
											width: 26,
											height: 26,
											backgroundColor: 'background.default',
											'&:hover': {
												backgroundColor: 'success.main',
												color: 'text.primary',
											},
										}}
									>
										<Save sx={{ width: 18, height: 18 }} />
									</IconButton>
								</span>
							</Tooltip>
							<Tooltip title='Convert to Note' arrow placement='bottom'>
								<span style={{ position: 'absolute', right: 40, top: 8 }}>
									<IconButton
										data-no-drag='true'
										className='action-button'
										onPointerDown={(e) => e.stopPropagation()}
										onClick={async (e) => {
											e.stopPropagation();
											if (isFileNote(note) && onConvertToNote) {
												await onConvertToNote(note);
											}
										}}
										sx={{
											opacity: 0,
											transition: 'opacity 0.2s',
											width: 26,
											height: 26,
											backgroundColor: 'background.default',
											'&:hover': {
												backgroundColor: 'primary.main',
												color: 'text.primary',
											},
										}}
									>
										<SimCardDownload sx={{ width: 18, height: 18 }} />
									</IconButton>
								</span>
							</Tooltip>
							<Tooltip title={`Close (${cmdKey} + W)`} arrow placement='bottom'>
								<span style={{ position: 'absolute', right: 8, top: 8 }}>
									<IconButton
										data-no-drag='true'
										className='action-button'
										onPointerDown={(e) => e.stopPropagation()}
										onClick={async (e) => {
											e.stopPropagation();
											if (isFileNote(note) && onCloseFile) {
												await onCloseFile(note);
											}
										}}
										sx={{
											opacity: 0,
											transition: 'opacity 0.2s',
											width: 26,
											height: 26,
											backgroundColor: 'background.default',
											'&:hover': {
												backgroundColor: 'error.main',
												color: 'text.primary',
											},
										}}
									>
										<Close sx={{ width: 18, height: 18 }} />
									</IconButton>
								</span>
							</Tooltip>
						</>
					) : (
						onArchive && (
							<Tooltip title={`Archive (${cmdKey} + W)`} arrow placement='bottom'>
								<span style={{ position: 'absolute', right: 8, top: 8 }}>
									<IconButton
										data-no-drag='true'
										className='action-button'
										aria-label={`Archive (${cmdKey} + W)`}
										onPointerDown={(e) => e.stopPropagation()}
										onClick={async (e) => {
											e.stopPropagation();
											await onArchive(note.id);
										}}
										sx={{
											opacity: 0,
											transition: 'opacity 0.2s',
											width: 26,
											height: 26,
											backgroundColor: 'background.default',
											'&:hover': {
												backgroundColor: 'primary.main',
												color: 'text.primary',
											},
										}}
									>
										<Archive sx={{ width: 18, height: 18 }} />
									</IconButton>
								</span>
							</Tooltip>
						)
					)}
					<Menu
						open={contextMenu !== null}
						onClose={() => setContextMenu(null)}
						anchorReference='anchorPosition'
						anchorPosition={contextMenu !== null ? { top: contextMenu.mouseY, left: contextMenu.mouseX } : undefined}
						sx={{ zIndex: 1400 }}
						slotProps={{ paper: { sx: { minWidth: 0 } } }}
					>
						<MenuItem
							dense
							disabled={!canSplit}
							onClick={() => {
								onOpenInPane?.(note, 'left');
								setContextMenu(null);
							}}
							sx={{ py: 0.25, fontSize: '0.75rem' }}
						>
							<Typography variant='caption' color='text.secondary' sx={{ mr: 0.5 }}>
								Open in
							</Typography>
							<Typography variant='caption' sx={{ fontWeight: 'bold', color: 'primary.main' }}>
								1: Left Pane
							</Typography>
						</MenuItem>
						<MenuItem
							dense
							disabled={!canSplit}
							onClick={() => {
								onOpenInPane?.(note, 'right');
								setContextMenu(null);
							}}
							sx={{ py: 0.25, fontSize: '0.75rem' }}
						>
							<Typography variant='caption' color='text.secondary' sx={{ mr: 0.5 }}>
								Open in
							</Typography>
							<Typography variant='caption' sx={{ fontWeight: 'bold', color: 'secondary.main' }}>
								2: Right Pane
							</Typography>
						</MenuItem>
					</Menu>
				</Box>
			</NotePreviewPopper>
		);
	},
);

interface FolderHeaderProps {
	folder: Folder;
	isCollapsed: boolean;
	onToggle: () => void;
	onRename: (name: string) => void;
	onDelete: () => void;
	onArchive: () => void;
	isEmpty: boolean;
	noteCount: number;
	autoEdit?: boolean;
	onAutoEditDone?: () => void;
}

const FolderHeader: React.FC<FolderHeaderProps> = ({
	folder,
	isCollapsed,
	onToggle,
	onRename,
	onDelete,
	onArchive,
	isEmpty,
	noteCount,
	autoEdit,
	onAutoEditDone,
}) => {
	const [isEditing, setIsEditing] = useState(false);
	const [editValue, setEditValue] = useState(folder.name);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!autoEdit) return;
		setEditValue(folder.name);
		setIsEditing(true);
		setTimeout(() => inputRef.current?.select(), 0);
		onAutoEditDone?.();
	}, [autoEdit, folder.name, onAutoEditDone]);

	const startEdit = () => {
		setEditValue(folder.name);
		setIsEditing(true);
		setTimeout(() => inputRef.current?.select(), 0);
	};

	const finishEdit = () => {
		setIsEditing(false);
		const trimmed = editValue.trim();
		if (trimmed && trimmed !== folder.name) {
			onRename(trimmed);
		}
	};

	return (
		<Box
			onClick={isEditing ? undefined : onToggle}
			sx={{
				height: 28,
				display: 'flex',
				alignItems: 'center',
				px: 0.5,
				backgroundColor: 'action.disabledBackground',
				borderRadius: isCollapsed ? '4px' : '4px 4px 0 0',
				cursor: 'pointer',
				'&:hover .folder-action': { opacity: 1 },
			}}
		>
			<IconButton
				data-no-drag='true'
				size='small'
				onClick={(e) => {
					e.stopPropagation();
					onToggle();
				}}
				onPointerDown={(e) => e.stopPropagation()}
				sx={{
					p: 0.25,
					'&:hover': {
						backgroundColor: 'action.hover',
						color: 'text.primary',
					},
				}}
			>
				{isCollapsed ? (
					<ChevronRight sx={{ width: 16, height: 16, color: 'text.secondary' }} />
				) : (
					<ExpandMore sx={{ width: 16, height: 16, color: 'text.secondary' }} />
				)}
			</IconButton>
			{isCollapsed ? (
				<FolderIcon sx={{ width: 16, height: 16, color: 'text.secondary', mr: 0.5 }} />
			) : (
				<FolderOpen sx={{ width: 16, height: 16, color: 'text.secondary', mr: 0.5 }} />
			)}
			{isEditing ? (
				<InputBase
					data-no-drag='true'
					inputRef={inputRef}
					value={editValue}
					onChange={(e) => setEditValue(e.target.value)}
					onBlur={finishEdit}
					onKeyDown={(e) => {
						e.stopPropagation();
						if (e.key === 'Enter') finishEdit();
						if (e.key === 'Escape') setIsEditing(false);
					}}
					onPointerDown={(e) => e.stopPropagation()}
					autoFocus
					sx={{
						flex: 1,
						fontSize: '0.875rem',
						color: 'text.secondary',
						'& input': { py: 0, px: 0.5 },
					}}
				/>
			) : (
				<Typography
					variant='body2'
					color='text.secondary'
					noWrap
					sx={{ flex: 1, cursor: 'pointer', userSelect: 'none' }}
					onDoubleClick={(e) => {
						e.stopPropagation();
						startEdit();
					}}
				>
					{folder.name}
				</Typography>
			)}
			<Typography variant='caption' color='text.disabled' sx={{ mx: 0.5 }}>
				{noteCount}
			</Typography>
			{!isEditing && (
				<>
					<Tooltip title='Rename' arrow>
						<IconButton
							data-no-drag='true'
							className='folder-action'
							size='small'
							onClick={(e) => {
								e.stopPropagation();
								startEdit();
							}}
							onPointerDown={(e) => e.stopPropagation()}
							sx={{
								opacity: 0,
								transition: 'opacity 0.2s',
								p: 0.25,
								mx: 1,
								'&:hover': {
									backgroundColor: 'primary.main',
									color: 'text.primary',
									'& .MuiSvgIcon-root': { color: 'text.primary' },
								},
							}}
						>
							<DriveFileRenameOutline sx={{ fontSize: 18, color: 'text.secondary' }} />
						</IconButton>
					</Tooltip>
					{isEmpty ? (
						<Tooltip title='Delete' arrow>
							<IconButton
								data-no-drag='true'
								className='folder-action'
								size='small'
								onClick={(e) => {
									e.stopPropagation();
									onDelete();
								}}
								onPointerDown={(e) => e.stopPropagation()}
								sx={{
									opacity: 0,
									transition: 'opacity 0.2s',
									p: 0.25,
									'&:hover': {
										backgroundColor: 'error.main',
										color: 'text.primary',
										'& .MuiSvgIcon-root': { color: 'text.primary' },
									},
								}}
							>
								<Delete sx={{ fontSize: 18, color: 'text.secondary' }} />
							</IconButton>
						</Tooltip>
					) : (
						<Tooltip title='Archive' arrow>
							<IconButton
								data-no-drag='true'
								className='folder-action'
								size='small'
								onClick={(e) => {
									e.stopPropagation();
									onArchive();
								}}
								onPointerDown={(e) => e.stopPropagation()}
								sx={{
									opacity: 0,
									transition: 'opacity 0.2s',
									p: 0.25,
									'&:hover': {
										backgroundColor: 'primary.main',
										color: 'text.primary',
										'& .MuiSvgIcon-root': { color: 'text.primary' },
									},
								}}
							>
								<Archive sx={{ fontSize: 18, color: 'text.secondary' }} />
							</IconButton>
						</Tooltip>
					)}
				</>
			)}
		</Box>
	);
};

type DropZoneKind = 'top-note' | 'folder' | 'folder-note' | 'folder-tail' | 'list-end';

type DragEntity =
	| {
			type: 'note';
			noteId: string;
			sourceFolderId: string | null;
	  }
	| {
			type: 'folder';
			folderId: string;
	  };

type DropTarget =
	| {
			kind: 'top-row';
			rowID: string;
			insert: 'before' | 'after';
			indicatorTop: number;
			indicatorLeft: number;
	  }
	| {
			kind: 'folder-note';
			folderId: string;
			noteId: string;
			insert: 'before' | 'after';
			indicatorTop: number;
			indicatorLeft: number;
	  }
	| {
			kind: 'folder-tail';
			folderId: string;
			inside: boolean;
			indicatorTop: number;
			indicatorLeft: number;
	  }
	| {
			kind: 'list-end';
			indicatorTop: number;
			indicatorLeft: number;
	  };

type DraggingState = {
	entity: DragEntity;
	pointerX: number;
	pointerY: number;
	offsetX: number;
	offsetY: number;
	width: number;
	target: DropTarget | null;
};

type NoteDropIntent =
	| {
			type: 'folder';
			folderId: string;
			position: number;
	  }
	| {
			type: 'top-level';
			insertAt: number;
	  };

const DragGhost: React.FC<{
	dragging: DraggingState;
	note?: Note | FileNote;
	folder?: Folder;
	noteCount: number;
}> = ({ dragging, note, folder, noteCount }) => {
	if (note) {
		const title = getNoteTitle(note);
		return (
			<Box
				sx={{
					width: dragging.width,
					px: 1.5,
					py: 0.75,
					borderRadius: 1,
					border: '1px solid',
					borderColor: 'divider',
					backgroundColor: 'background.paper',
					boxShadow: 6,
				}}
			>
				<Typography noWrap variant='body2' sx={{ opacity: title.isFallback ? 0.7 : 1 }}>
					{title.text}
				</Typography>
				<Typography variant='caption' sx={{ opacity: 0.6 }}>
					{dayjs(note.modifiedTime).format('L _ HH:mm:ss')}
				</Typography>
			</Box>
		);
	}

	if (folder) {
		return (
			<Box
				sx={{
					width: dragging.width,
					height: 30,
					display: 'flex',
					alignItems: 'center',
					px: 1,
					borderRadius: 1,
					border: '1px solid',
					borderColor: 'divider',
					backgroundColor: 'action.disabledBackground',
					boxShadow: 6,
					gap: 0.5,
				}}
			>
				<FolderOpen sx={{ width: 16, height: 16, color: 'text.secondary' }} />
				<Typography noWrap variant='body2' sx={{ flex: 1, color: 'text.secondary' }}>
					{folder.name}
				</Typography>
				<Typography variant='caption' color='text.disabled'>
					{noteCount}
				</Typography>
			</Box>
		);
	}

	return null;
};

export const NoteList: React.FC<NoteListProps> = ({
	notes,
	currentNote,
	onNoteSelect,
	onArchive,
	onConvertToNote,
	onSaveFile,
	onReorder,
	isFileMode,
	onCloseFile,
	isFileModified,
	platform,
	folders = [],
	collapsedFolders = new Set(),
	onToggleFolderCollapse,
	onRenameFolder,
	onDeleteFolder,
	onMoveNoteToFolder,
	editingFolderId,
	onEditingFolderDone,
	topLevelOrder = [],
	onUpdateTopLevelOrder,
	onArchiveFolder,
	secondarySelectedNoteId,
	onOpenInPane,
	canSplit,
}) => {
	const listRef = useRef<HTMLUListElement>(null);
	const lastDragEndAt = useRef(0);
	const [dragging, setDragging] = useState<DraggingState | null>(null);

	const activeNotes = useMemo(
		() => (isFileMode ? notes : (notes as Note[]).filter((note) => !note.archived)),
		[isFileMode, notes],
	);
	const archivedNotes = useMemo(
		() => (isFileMode ? [] : (notes as Note[]).filter((note) => note.archived)),
		[isFileMode, notes],
	);

	const hasFolders = !isFileMode && folders.length > 0;
	const folderIDSet = useMemo(() => new Set(folders.map((folder) => folder.id)), [folders]);

	const noteRecords = useMemo(() => (isFileMode ? [] : (activeNotes as Note[])), [isFileMode, activeNotes]);

	const isTopLevelNote = useCallback(
		(note: Note) => !note.folderId || !folderIDSet.has(note.folderId),
		[folderIDSet],
	);

	const normalizedTopLevel = useMemo(() => {
		if (!hasFolders) return [] as TopLevelItem[];
		return normalizeTopLevelOrder(topLevelOrder, noteRecords, folders, isTopLevelNote);
	}, [hasFolders, topLevelOrder, noteRecords, folders, isTopLevelNote]);

	const noteMap = useMemo(() => new Map(activeNotes.map((note) => [note.id, note])), [activeNotes]);
	const folderMap = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);

	const folderNotesByFolderID = useMemo(() => {
		const map = new Map<string, Note[]>();
		if (!hasFolders) return map;

		for (const folder of folders) {
			map.set(folder.id, []);
		}
		for (const note of noteRecords) {
			if (!note.folderId) continue;
			if (!folderIDSet.has(note.folderId)) continue;
			const bucket = map.get(note.folderId);
			if (bucket) {
				bucket.push(note);
			}
		}
		return map;
	}, [hasFolders, folders, noteRecords, folderIDSet]);

	const folderCountByID = useMemo(() => {
		const map = new Map<string, number>();
		for (const folder of folders) {
			map.set(folder.id, folderNotesByFolderID.get(folder.id)?.length ?? 0);
		}
		return map;
	}, [folders, folderNotesByFolderID]);

	const isDraggingAny = !!dragging;

	const renderNoteItem = useCallback(
		(note: Note | FileNote) => (
			<NoteItem
				note={note}
				currentNote={currentNote}
				onNoteSelect={onNoteSelect}
				onArchive={onArchive}
				onConvertToNote={onConvertToNote}
				onSaveFile={onSaveFile}
				getNoteTitle={getNoteTitle}
				isFileMode={isFileMode}
				onCloseFile={onCloseFile}
				isFileModified={isFileModified}
				platform={platform}
				secondarySelectedNoteId={secondarySelectedNoteId}
				onOpenInPane={onOpenInPane}
				canSplit={canSplit}
				isDragging={isDraggingAny}
			/>
		),
		[
			currentNote,
			onNoteSelect,
			onArchive,
			onConvertToNote,
			onSaveFile,
			isFileMode,
			onCloseFile,
			isFileModified,
			platform,
			secondarySelectedNoteId,
			onOpenInPane,
			canSplit,
			isDraggingAny,
		],
	);

	const isDraggedRow = useCallback(
		(noteId?: string, folderId?: string): boolean => {
			if (!dragging) return false;
			if (dragging.entity.type === 'note') {
				return noteId === dragging.entity.noteId;
			}
			if (dragging.entity.type === 'folder') {
				return folderId === dragging.entity.folderId;
			}
			return false;
		},
		[dragging],
	);

	const computeDropTarget = useCallback(
		(clientX: number, clientY: number): DropTarget | null => {
			const listEl = listRef.current;
			if (!listEl) return null;

			const listRect = listEl.getBoundingClientRect();
			const scrollTop = listEl.scrollTop;

			const zone = document
				.elementsFromPoint(clientX, clientY)
				.map((el) => (el as HTMLElement).closest<HTMLElement>('[data-drop-kind]'))
				.find((el): el is HTMLElement => !!el && listEl.contains(el));

			if (!zone) return null;

			const kind = zone.dataset.dropKind as DropZoneKind | undefined;
			if (!kind) return null;

			const rect = zone.getBoundingClientRect();
			const midY = rect.top + rect.height / 2;

			if (kind === 'top-note' || kind === 'folder') {
				const rowID = zone.dataset.rowId;
				if (!rowID) return null;
				const insert = clientY < midY ? 'before' : 'after';
				const indicatorY = insert === 'before' ? rect.top : rect.bottom;
				return {
					kind: 'top-row',
					rowID,
					insert,
					indicatorTop: indicatorY - listRect.top + scrollTop,
					indicatorLeft: INDICATOR_SIDE_INSET,
				};
			}

			if (kind === 'folder-note') {
				const folderId = zone.dataset.folderId;
				const noteId = zone.dataset.noteId;
				if (!folderId || !noteId) return null;
				const insert = clientY < midY ? 'before' : 'after';
				const indicatorY = insert === 'before' ? rect.top : rect.bottom;
				return {
					kind: 'folder-note',
					folderId,
					noteId,
					insert,
					indicatorTop: indicatorY - listRect.top + scrollTop,
					indicatorLeft: INDICATOR_SIDE_INSET + INDICATOR_FOLDER_INDENT,
				};
			}

			if (kind === 'folder-tail') {
				const folderId = zone.dataset.folderId;
				if (!folderId) return null;
				const inside = clientX > rect.left + rect.width / 2;
				return {
					kind: 'folder-tail',
					folderId,
					inside,
					indicatorTop: rect.top - listRect.top + scrollTop,
					indicatorLeft: inside ? INDICATOR_SIDE_INSET + INDICATOR_FOLDER_INDENT : INDICATOR_SIDE_INSET,
				};
			}

			if (kind === 'list-end') {
				return {
					kind: 'list-end',
					indicatorTop: rect.top - listRect.top + scrollTop,
					indicatorLeft: INDICATOR_SIDE_INSET,
				};
			}

			return null;
		},
		[],
	);

	const buildNoteDropIntent = useCallback(
		(entity: Extract<DragEntity, { type: 'note' }>, target: DropTarget): NoteDropIntent | null => {
			if (!hasFolders) {
				if (target.kind === 'top-row') {
					const parsed = parseTopLevelRowID(target.rowID);
					if (!parsed || parsed.type !== 'note') return null;
					const rowIndex = activeNotes.findIndex((n) => n.id === parsed.id);
					if (rowIndex === -1) return null;
					return {
						type: 'top-level',
						insertAt: target.insert === 'before' ? rowIndex : rowIndex + 1,
					};
				}
				if (target.kind === 'list-end') {
					return {
						type: 'top-level',
						insertAt: activeNotes.length,
					};
				}
				return null;
			}

			if (target.kind === 'folder-note') {
				const folderNotes = folderNotesByFolderID.get(target.folderId) ?? [];
				let position = folderNotes.findIndex((note) => note.id === target.noteId);
				if (position === -1) return null;
				if (target.insert === 'after') position += 1;

				if (entity.sourceFolderId === target.folderId) {
					const sourcePos = folderNotes.findIndex((note) => note.id === entity.noteId);
					if (sourcePos !== -1 && sourcePos < position) {
						position -= 1;
					}
				}

				return {
					type: 'folder',
					folderId: target.folderId,
					position,
				};
			}

			if (target.kind === 'folder-tail') {
				if (target.inside) {
					const folderNotes = folderNotesByFolderID.get(target.folderId) ?? [];
					let position = folderNotes.length;
					if (entity.sourceFolderId === target.folderId) {
						position = Math.max(0, position - 1);
					}
					return {
						type: 'folder',
						folderId: target.folderId,
						position,
					};
				}

				const folderIndex = normalizedTopLevel.findIndex((item) => item.type === 'folder' && item.id === target.folderId);
				return {
					type: 'top-level',
					insertAt: folderIndex === -1 ? normalizedTopLevel.length : folderIndex + 1,
				};
			}

			if (target.kind === 'top-row') {
				const rowIndex = normalizedTopLevel.findIndex((item) => toTopLevelRowID(item) === target.rowID);
				if (rowIndex === -1) return null;
				return {
					type: 'top-level',
					insertAt: target.insert === 'before' ? rowIndex : rowIndex + 1,
				};
			}

			if (target.kind === 'list-end') {
				return {
					type: 'top-level',
					insertAt: normalizedTopLevel.length,
				};
			}

			return null;
		},
		[activeNotes, hasFolders, folderNotesByFolderID, normalizedTopLevel],
	);

	const applyFlatReorder = useCallback(
		async (noteId: string, insertAtIndex: number) => {
			if (isFileMode) {
				const list = activeNotes as FileNote[];
				const from = list.findIndex((item) => item.id === noteId);
				if (from === -1) return;
				const moved = moveByInsertIndex(list, from, insertAtIndex);
				if (moved.every((item, idx) => item.id === list[idx]?.id)) {
					return;
				}

				onReorder?.(moved);
				await SaveFileNotes(moved);
				return;
			}

			const list = activeNotes as Note[];
			const from = list.findIndex((item) => item.id === noteId);
			if (from === -1) return;
			const moved = moveByInsertIndex(list, from, insertAtIndex);
			if (moved.every((item, idx) => item.id === list[idx]?.id)) {
				return;
			}

			onReorder?.([...moved, ...archivedNotes]);
			const newIndex = moved.findIndex((item) => item.id === noteId);
			if (newIndex !== -1) {
				try {
					await UpdateNoteOrder(noteId, newIndex);
				} catch (error) {
					console.error('Failed to update note order:', error);
				}
			}
		},
		[activeNotes, isFileMode, onReorder, archivedNotes],
	);

	const applyFolderNoteIntent = useCallback(
		async (noteId: string, intent: NoteDropIntent) => {
			const active = noteRecords;
			const moved = active.find((note) => note.id === noteId);
			if (!moved) return;

			const oldIndex = active.findIndex((note) => note.id === noteId);
			const without = active.filter((note) => note.id !== noteId);

			if (intent.type === 'folder') {
				const sameFolder = (moved.folderId ?? '') === intent.folderId;
				const insertIndex = getGlobalInsertIndexForFolderPosition(without, intent.folderId, intent.position, oldIndex);
				const movedNote: Note = sameFolder ? moved : { ...moved, folderId: intent.folderId };
				const reordered = insertAt(without, movedNote, insertIndex);

				onReorder?.([...reordered, ...archivedNotes]);
				if (!sameFolder) {
					onMoveNoteToFolder?.(noteId, intent.folderId);
					if (isTopLevelNote(moved)) {
						const nextOrder = normalizedTopLevel.filter((item) => !(item.type === 'note' && item.id === noteId));
						onUpdateTopLevelOrder?.(nextOrder);
					}
				}

				try {
					await UpdateNoteOrder(noteId, insertIndex);
				} catch (error) {
					console.error('Failed to update note order:', error);
				}
				return;
			}

			const orderWithout = normalizedTopLevel.filter((item) => !(item.type === 'note' && item.id === noteId));
			const safeTopLevelInsert = Math.max(0, Math.min(intent.insertAt, orderWithout.length));
			const nextOrder = insertAt<TopLevelItem>(orderWithout, { type: 'note', id: noteId }, safeTopLevelInsert);

			const insertIndex = getGlobalInsertIndexForTopLevelPosition(without, orderWithout, safeTopLevelInsert);
			const movedNote: Note = moved.folderId ? { ...moved, folderId: undefined } : moved;
			const reordered = insertAt(without, movedNote, insertIndex);

			onReorder?.([...reordered, ...archivedNotes]);
			onUpdateTopLevelOrder?.(nextOrder);
			if (moved.folderId) {
				onMoveNoteToFolder?.(noteId, '');
			}

			try {
				await UpdateNoteOrder(noteId, insertIndex);
			} catch (error) {
				console.error('Failed to update note order:', error);
			}
		},
		[
			noteRecords,
			onReorder,
			archivedNotes,
			onMoveNoteToFolder,
			onUpdateTopLevelOrder,
			normalizedTopLevel,
			isTopLevelNote,
		],
	);

	const applyFolderReorder = useCallback(
		(target: DropTarget, draggedFolderId: string) => {
			const currentOrder = normalizedTopLevel;
			const oldIndex = currentOrder.findIndex((item) => item.type === 'folder' && item.id === draggedFolderId);
			if (oldIndex === -1) return;

			let insertAtIndex: number | null = null;

			if (target.kind === 'top-row') {
				const overIndex = currentOrder.findIndex((item) => toTopLevelRowID(item) === target.rowID);
				if (overIndex !== -1) {
					insertAtIndex = target.insert === 'before' ? overIndex : overIndex + 1;
				}
			}
			if (target.kind === 'folder-note') {
				const overFolderIndex = currentOrder.findIndex((item) => item.type === 'folder' && item.id === target.folderId);
				if (overFolderIndex !== -1) {
					insertAtIndex = target.insert === 'before' ? overFolderIndex : overFolderIndex + 1;
				}
			}
			if (target.kind === 'folder-tail') {
				const overFolderIndex = currentOrder.findIndex((item) => item.type === 'folder' && item.id === target.folderId);
				if (overFolderIndex !== -1) {
					insertAtIndex = overFolderIndex + 1;
				}
			}
			if (target.kind === 'list-end') {
				insertAtIndex = currentOrder.length;
			}

			if (insertAtIndex === null) return;

			const without = currentOrder.filter((item) => !(item.type === 'folder' && item.id === draggedFolderId));
			const adjustedInsert = insertAtIndex > oldIndex ? insertAtIndex - 1 : insertAtIndex;
			const safe = Math.max(0, Math.min(adjustedInsert, without.length));
			const next = insertAt<TopLevelItem>(without, { type: 'folder', id: draggedFolderId }, safe);

			if (next.every((item, idx) => item.type === currentOrder[idx]?.type && item.id === currentOrder[idx]?.id)) {
				return;
			}
			onUpdateTopLevelOrder?.(next);
		},
		[normalizedTopLevel, onUpdateTopLevelOrder],
	);

	const commitDrop = useCallback(
		async (state: DraggingState) => {
			if (state.entity.type === 'note') {
				const pane = detectTargetPane(state.pointerX, state.pointerY);
				if (pane) {
					const note = noteMap.get(state.entity.noteId);
					if (note) {
						if (onOpenInPane) {
							onOpenInPane(note, pane);
						} else {
							await onNoteSelect(note);
						}
						return;
					}
				}
			}

			const target = state.target;
			if (!target) return;

			if (isFileMode) {
				if (state.entity.type !== 'note') return;
				const intent = buildNoteDropIntent(state.entity, target);
				if (!intent || intent.type !== 'top-level') return;
				await applyFlatReorder(state.entity.noteId, intent.insertAt);
				return;
			}

			if (!hasFolders) {
				if (state.entity.type !== 'note') return;
				const intent = buildNoteDropIntent(state.entity, target);
				if (!intent || intent.type !== 'top-level') return;
				await applyFlatReorder(state.entity.noteId, intent.insertAt);
				return;
			}

			if (state.entity.type === 'folder') {
				applyFolderReorder(target, state.entity.folderId);
				return;
			}

			const intent = buildNoteDropIntent(state.entity, target);
			if (!intent) return;
			await applyFolderNoteIntent(state.entity.noteId, intent);
		},
		[
			noteMap,
			onOpenInPane,
			onNoteSelect,
			isFileMode,
			hasFolders,
			buildNoteDropIntent,
			applyFlatReorder,
			applyFolderReorder,
			applyFolderNoteIntent,
		],
	);

	const handlePointerDownForEntity = useCallback(
		(event: React.PointerEvent<HTMLElement>, entity: DragEntity) => {
			if (event.button !== 0) return;
			const target = event.target as HTMLElement;
			if (target.closest('[data-no-drag="true"]')) return;

			const host = event.currentTarget;
			const rect = host.getBoundingClientRect();
			const startX = event.clientX;
			const startY = event.clientY;
			const offsetX = Math.max(0, Math.min(startX - rect.left, rect.width));
			const offsetY = Math.max(0, Math.min(startY - rect.top, rect.height));

			let currentDrag: DraggingState | null = null;
			let dragStarted = false;

			const cleanup = () => {
				document.removeEventListener('pointermove', handleMove);
				document.removeEventListener('pointerup', handleUp);
				document.removeEventListener('pointercancel', handleCancel);
			};

			const handleMove = (moveEvent: PointerEvent) => {
				const dx = moveEvent.clientX - startX;
				const dy = moveEvent.clientY - startY;

				if (!dragStarted) {
					if (Math.hypot(dx, dy) < DRAG_START_DISTANCE) {
						return;
					}
					dragStarted = true;
					const initialTarget = computeDropTarget(moveEvent.clientX, moveEvent.clientY);
					currentDrag = {
						entity,
						pointerX: moveEvent.clientX,
						pointerY: moveEvent.clientY,
						offsetX,
						offsetY,
						width: rect.width,
						target: initialTarget,
					};
					setDragging(currentDrag);
					moveEvent.preventDefault();
					return;
				}

				if (!currentDrag) return;
				const nextTarget = computeDropTarget(moveEvent.clientX, moveEvent.clientY);
				currentDrag = {
					...currentDrag,
					pointerX: moveEvent.clientX,
					pointerY: moveEvent.clientY,
					target: nextTarget,
				};
				setDragging(currentDrag);
				moveEvent.preventDefault();
			};

			const handleUp = () => {
				cleanup();
				if (!dragStarted || !currentDrag) return;
				setDragging(null);
				lastDragEndAt.current = Date.now();
				void commitDrop(currentDrag);
			};

			const handleCancel = () => {
				cleanup();
				if (!dragStarted) return;
				setDragging(null);
				lastDragEndAt.current = Date.now();
			};

			document.addEventListener('pointermove', handleMove);
			document.addEventListener('pointerup', handleUp);
			document.addEventListener('pointercancel', handleCancel);
		},
		[commitDrop, computeDropTarget],
	);

	useEffect(() => {
		if (!dragging) return;
		const style = document.createElement('style');
		style.textContent = '* { cursor: grabbing !important; user-select: none !important; }';
		document.head.appendChild(style);
		return () => {
			style.remove();
		};
	}, [dragging]);

	const dragGhostNote = useMemo(() => {
		if (!dragging || dragging.entity.type !== 'note') return undefined;
		return noteMap.get(dragging.entity.noteId);
	}, [dragging, noteMap]);

	const dragGhostFolder = useMemo(() => {
		if (!dragging || dragging.entity.type !== 'folder') return undefined;
		return folderMap.get(dragging.entity.folderId);
	}, [dragging, folderMap]);

	const dragGhostFolderCount = useMemo(() => {
		if (!dragGhostFolder) return 0;
		return folderCountByID.get(dragGhostFolder.id) ?? 0;
	}, [dragGhostFolder, folderCountByID]);

	const renderListEndDropZone = (
		<Box data-drop-kind='list-end' data-row-id='list-end' sx={{ height: 10, mx: 1 }} />
	);

	const listRows = useMemo(() => {
		if (!hasFolders) {
			return (activeNotes as (Note | FileNote)[]).map((note) => ({
				key: `note:${note.id}`,
				node: (
					<Box
						data-drop-kind='top-note'
						data-row-id={`note:${note.id}`}
						data-note-id={note.id}
						onPointerDown={(event) => {
							handlePointerDownForEntity(event, {
								type: 'note',
								noteId: note.id,
								sourceFolderId: null,
							});
						}}
						sx={{ mx: 1, opacity: isDraggedRow(note.id) ? 0.35 : 1 }}
					>
						{renderNoteItem(note)}
					</Box>
				),
			}));
		}

		const rows: Array<{ key: string; node: React.ReactNode }> = [];
		for (const item of normalizedTopLevel) {
			if (item.type === 'note') {
				const note = noteMap.get(item.id);
				if (!note || isFileNote(note)) continue;
				rows.push({
					key: `note:${note.id}`,
					node: (
						<Box
							data-drop-kind='top-note'
							data-row-id={`note:${note.id}`}
							data-note-id={note.id}
							onPointerDown={(event) => {
								handlePointerDownForEntity(event, {
									type: 'note',
									noteId: note.id,
									sourceFolderId: null,
								});
							}}
							sx={{ mx: 1, opacity: isDraggedRow(note.id) ? 0.35 : 1 }}
						>
							{renderNoteItem(note)}
						</Box>
					),
				});
				continue;
			}

			const folder = folderMap.get(item.id);
			if (!folder) continue;
			const folderNotes = folderNotesByFolderID.get(folder.id) ?? [];
			const collapsed = collapsedFolders.has(folder.id);

			rows.push({
				key: `folder:${folder.id}`,
				node: (
					<Box
						data-drop-kind='folder'
						data-row-id={`folder:${folder.id}`}
						data-folder-id={folder.id}
						onPointerDown={(event) => {
							handlePointerDownForEntity(event, {
								type: 'folder',
								folderId: folder.id,
							});
						}}
						sx={{
							mx: 1,
							opacity: isDraggedRow(undefined, folder.id) ? 0.35 : 1,
							border: '1px solid',
							borderColor: 'action.disabled',
							borderBottomWidth: collapsed ? 1 : 0,
							borderRadius: collapsed ? 1 : '4px 4px 0 0',
						}}
					>
						<FolderHeader
							folder={folder}
							isCollapsed={collapsed}
							onToggle={() => onToggleFolderCollapse?.(folder.id)}
							onRename={(name) => onRenameFolder?.(folder.id, name)}
							onDelete={() => onDeleteFolder?.(folder.id)}
							onArchive={() => onArchiveFolder?.(folder.id)}
							isEmpty={folderNotes.length === 0}
							noteCount={folderNotes.length}
							autoEdit={editingFolderId === folder.id}
							onAutoEditDone={onEditingFolderDone}
						/>
					</Box>
				),
			});

			if (!collapsed) {
				for (const note of folderNotes) {
					rows.push({
						key: `folder-note:${note.id}`,
						node: (
							<Box
								data-drop-kind='folder-note'
								data-row-id={`folder-note:${note.id}`}
								data-folder-id={folder.id}
								data-note-id={note.id}
								onPointerDown={(event) => {
									handlePointerDownForEntity(event, {
										type: 'note',
										noteId: note.id,
										sourceFolderId: folder.id,
									});
								}}
								sx={{
									mx: 1,
									opacity: isDraggedRow(note.id) ? 0.35 : 1,
									borderLeft: '1px solid',
									borderRight: '1px solid',
									borderColor: 'action.disabled',
								}}
							>
								<Box
									sx={(theme) => ({
										borderLeft: `${theme.spacing(1.5)} solid ${theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'}`,
										backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.06)',
									})}
								>
									{renderNoteItem(note)}
								</Box>
							</Box>
						),
					});
				}
			}

			rows.push({
				key: `folder-tail:${folder.id}`,
				node: (
					<Box
						data-drop-kind='folder-tail'
						data-row-id={`folder-tail:${folder.id}`}
						data-folder-id={folder.id}
						sx={{
							mx: 1,
							height: 8,
							...(collapsed
								? {}
								: {
									borderLeft: '1px solid',
									borderRight: '1px solid',
									borderBottom: '1px solid',
									borderColor: 'action.disabled',
									borderRadius: '0 0 4px 4px',
								}),
						}}
					/>
				),
			});
		}

		return rows;
	}, [
		hasFolders,
		activeNotes,
		handlePointerDownForEntity,
		isDraggedRow,
		renderNoteItem,
		normalizedTopLevel,
		noteMap,
		folderMap,
		folderNotesByFolderID,
		collapsedFolders,
		onToggleFolderCollapse,
		onRenameFolder,
		onDeleteFolder,
		onArchiveFolder,
		editingFolderId,
		onEditingFolderDone,
	]);

	const indicator = dragging?.target;

	return (
		<List
			ref={listRef}
			onClickCapture={(event) => {
				if (Date.now() - lastDragEndAt.current > DRAG_CLICK_SUPPRESS_MS) return;
				event.preventDefault();
				event.stopPropagation();
			}}
			sx={{
				flexGrow: 1,
				overflow: 'visible',
				position: 'relative',
				pb: 0.5,
			}}
		>
			{listRows.map((row) => (
				<Box key={row.key}>{row.node}</Box>
			))}
			{renderListEndDropZone}

			{indicator && (
				<Box
					sx={{
						position: 'absolute',
						top: indicator.indicatorTop,
						left: indicator.indicatorLeft,
						right: INDICATOR_SIDE_INSET,
						height: 2,
						bgcolor: 'primary.main',
						zIndex: 2,
						pointerEvents: 'none',
					}}
				/>
			)}

			{dragging &&
				createPortal(
					<div
						style={{
							position: 'fixed',
							left: dragging.pointerX - dragging.offsetX,
							top: dragging.pointerY - dragging.offsetY,
							zIndex: 10000,
							pointerEvents: 'none',
							opacity: 0.95,
						}}
					>
						<DragGhost
							dragging={dragging}
							note={dragGhostNote}
							folder={dragGhostFolder}
							noteCount={dragGhostFolderCount}
						/>
					</div>,
					document.body,
				)}
		</List>
	);
};
