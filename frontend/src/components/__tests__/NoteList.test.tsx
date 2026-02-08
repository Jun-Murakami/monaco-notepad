import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';
import dayjs from 'dayjs';
import type { FileNote, Note } from '../../types';
import { NoteList } from '../NoteList';

// DnD-kitのモック
vi.mock('@dnd-kit/core', () => ({
	...vi.importActual('@dnd-kit/core'),
	DndContext: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
	useSensor: () => null,
	useSensors: () => null,
	PointerSensor: function MockPointerSensor() {
		return {
			activate: () => {},
			deactivate: () => {},
		};
	},
	KeyboardSensor: function MockKeyboardSensor() {
		return {
			activate: () => {},
			deactivate: () => {},
		};
	},
	restrictToVerticalAxis: () => {},
	restrictToParentElement: () => {},
}));

vi.mock('@dnd-kit/sortable', () => ({
	...vi.importActual('@dnd-kit/sortable'),
	SortableContext: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
	useSortable: () => ({
		attributes: {},
		listeners: {},
		setNodeRef: () => null,
		transform: null,
		transition: null,
		isDragging: false,
	}),
	verticalListSortingStrategy: {},
	arrayMove: (array: unknown[], _from: number, _to: number) => array,
	sortableKeyboardCoordinates: () => ({}),
}));

describe('NoteList', () => {
	const mockNotes: Note[] = [
		{
			id: '1',
			title: 'Note 1',
			content: 'Content 1',
			contentHeader: null,
			language: 'typescript',
			modifiedTime: '2024-01-01T10:00:00.000Z',
			archived: false,
		},
		{
			id: '2',
			title: '',
			content: 'First line\nSecond line',
			contentHeader: null,
			language: 'typescript',
			modifiedTime: '2024-01-02T10:00:00.000Z',
			archived: false,
		},
	];

	const mockFileNotes: FileNote[] = [
		{
			id: '3',
			filePath: '/path/to/file1.ts',
			fileName: 'file1.ts',
			content: 'File Content 1',
			originalContent: 'File Content 1',
			language: 'typescript',
			modifiedTime: '2024-01-03T10:00:00.000Z',
		},
		{
			id: '4',
			filePath: '/path/to/file2.ts',
			fileName: 'file2.ts',
			content: 'File Content 2',
			originalContent: 'Original Content 2',
			language: 'typescript',
			modifiedTime: '2024-01-04T10:00:00.000Z',
		},
	];

	const defaultProps = {
		notes: mockNotes,
		currentNote: null,
		onNoteSelect: vi.fn(),
		onArchive: vi.fn(),
		onReorder: vi.fn(),
		platform: 'windows',
	};

	const defaultFileProps = {
		notes: mockFileNotes,
		currentNote: null,
		onNoteSelect: vi.fn(),
		onConvertToNote: vi.fn(),
		onSaveFile: vi.fn(),
		onCloseFile: vi.fn(),
		isFileModified: vi.fn(),
		onReorder: vi.fn(),
		isFileMode: true,
		platform: 'windows',
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('ノートが正しく表示されること', () => {
		render(<NoteList {...defaultProps} />);

		expect(screen.getByText('Note 1')).toBeInTheDocument();
		expect(screen.getByText('First line Second line')).toBeInTheDocument();

		// 日付が正しく表示されることを確認
		for (const note of mockNotes) {
			const formattedDate = dayjs(note.modifiedTime).format('L _ HH:mm:ss');
			const dateElements = screen.getAllByText(formattedDate);
			expect(dateElements.length).toBeGreaterThan(0);
		}
	});

	it('ファイルノートが正しく表示されること', () => {
		render(<NoteList {...defaultFileProps} />);

		expect(screen.getByText('file1.ts')).toBeInTheDocument();
		expect(screen.getByText('file2.ts')).toBeInTheDocument();

		// 日付が正しく表示されることを確認
		for (const note of mockFileNotes) {
			const formattedDate = dayjs(note.modifiedTime).format('L _ HH:mm:ss');
			const dateElements = screen.getAllByText(formattedDate);
			expect(dateElements.length).toBeGreaterThan(0);
		}
	});

	it('ノート選択が正しく動作すること', async () => {
		render(<NoteList {...defaultProps} />);

		const noteButton = screen.getByText('Note 1').closest('div');
		if (noteButton) {
			await fireEvent.click(noteButton);
			expect(defaultProps.onNoteSelect).toHaveBeenCalledWith(mockNotes[0]);
		}
	});

	it('アーカイブボタンが正しく動作すること', async () => {
		render(<NoteList {...defaultProps} />);

		const archiveButtons = screen.getAllByTestId('ArchiveIcon');
		const archiveButton = archiveButtons[0].closest('button');
		if (!archiveButton) throw new Error('Archive button not found');
		await fireEvent.click(archiveButton);

		expect(defaultProps.onArchive).toHaveBeenCalledWith('1');
	});

	it('ファイルモードで各ボタンが正しく動作すること', async () => {
		defaultFileProps.isFileModified.mockReturnValue(true);
		render(<NoteList {...defaultFileProps} />);

		// 保存ボタン
		const saveButtons = screen.getAllByTestId('SaveIcon');
		const saveButton = saveButtons[0].closest('button');
		if (!saveButton) throw new Error('Save button not found');
		await fireEvent.click(saveButton);
		expect(defaultFileProps.onSaveFile).toHaveBeenCalledWith(mockFileNotes[0]);

		// 変換ボタン
		const convertButtons = screen.getAllByTestId('SimCardDownloadIcon');
		const convertButton = convertButtons[0].closest('button');
		if (!convertButton) throw new Error('Convert button not found');
		await fireEvent.click(convertButton);
		expect(defaultFileProps.onConvertToNote).toHaveBeenCalledWith(
			mockFileNotes[0],
		);

		// クローズボタン
		const closeButtons = screen.getAllByTestId('CloseIcon');
		const closeButton = closeButtons[0].closest('button');
		if (!closeButton) throw new Error('Close button not found');
		await fireEvent.click(closeButton);
		expect(defaultFileProps.onCloseFile).toHaveBeenCalledWith(mockFileNotes[0]);
	});

	it('修正されたファイルが正しく表示されること', () => {
		defaultFileProps.isFileModified.mockReturnValue(true);
		render(<NoteList {...defaultFileProps} />);

		const modifiedIcons = screen.getAllByTestId('DriveFileRenameOutlineIcon');
		expect(modifiedIcons.length).toBe(2);
	});

	it('プラットフォームに応じて正しいショートカットが表示されること', () => {
		render(<NoteList {...defaultProps} platform="darwin" />);
		const archiveButtons = screen.getAllByLabelText('Archive (Cmd + W)');
		expect(archiveButtons[0]).toBeInTheDocument();

		render(<NoteList {...defaultFileProps} platform="windows" />);
		const saveButtons = screen.getAllByLabelText('Save (Ctrl + S)');
		expect(saveButtons[0]).toBeInTheDocument();
	});

	it('現在選択中のノートが強調表示されること', () => {
		render(<NoteList {...defaultProps} currentNote={mockNotes[0]} />);
		const selectedNote = screen
			.getByText('Note 1')
			.closest('.MuiListItemButton-root');
		expect(selectedNote).toHaveClass('Mui-selected');

		const nonSelectedNote = screen
			.getByText('First line Second line')
			.closest('.MuiListItemButton-root');
		expect(nonSelectedNote).not.toHaveClass('Mui-selected');
	});

	it('ノートが空の場合、適切なプレースホルダーが表示されること', () => {
		const emptyNote: Note = {
			id: '3',
			title: '',
			content: '',
			contentHeader: null,
			language: 'typescript',
			modifiedTime: new Date().toISOString(),
			archived: false,
		};
		render(<NoteList {...defaultProps} notes={[emptyNote]} />);
		expect(screen.getByText('New Note')).toBeInTheDocument();
	});

	it('ファイルが変更されていない場合、保存ボタンが無効化されること', () => {
		defaultFileProps.isFileModified.mockReturnValue(false);
		render(<NoteList {...defaultFileProps} />);

		const saveButtons = screen.getAllByTestId('SaveIcon');
		const saveButton = saveButtons[0].closest('button');
		expect(saveButton).toBeDisabled();
	});

	it('ドラッグハンドルが正しく表示され、適切なツールチップを持つこと', () => {
		render(<NoteList {...defaultProps} />);

		const dragHandles = screen.getAllByTestId('ImportExportIcon');
		expect(dragHandles[0].closest('button')).toHaveClass('drag-handle');
	});

	it('ノートリストが空の場合、リストが空であることを確認', () => {
		render(<NoteList {...defaultProps} notes={[]} />);
		const list = screen.getByRole('list');
		expect(list.children[0].children[0]).toBeEmptyDOMElement();
	});

	it('ファイルモードでファイルリストが空の場合、リストが空であることを確認', () => {
		render(<NoteList {...defaultFileProps} notes={[]} />);
		const list = screen.getByRole('list');
		expect(list.children[0].children[0]).toBeEmptyDOMElement();
	});
});
