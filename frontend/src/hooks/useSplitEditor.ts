import { useCallback, useRef, useState } from 'react';
import type { EditorPane, FileNote, Note } from '../types';

const STORAGE_KEY = 'splitEditorState';

interface SplitEditorStorage {
	isSplit: boolean;
	isMarkdownPreview: boolean;
	leftNoteId: string | null;
	leftIsFile: boolean;
	rightNoteId: string | null;
	rightIsFile: boolean;
}

const loadSavedState = (): SplitEditorStorage | null => {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		return JSON.parse(raw);
	} catch {
		return null;
	}
};

const savedState = loadSavedState();

interface UseSplitEditorProps {
	currentNote: Note | null;
	currentFileNote: FileNote | null;
	setCurrentNote: (note: Note | null) => void;
	setCurrentFileNote: (note: FileNote | null) => void;
}

export const useSplitEditor = ({
	currentNote,
	currentFileNote,
	setCurrentNote,
	setCurrentFileNote,
}: UseSplitEditorProps) => {
	const [isSplit, setIsSplit] = useState(savedState?.isSplit ?? false);
	const [isMarkdownPreview, setIsMarkdownPreview] = useState(savedState?.isMarkdownPreview ?? false);
	const [focusedPane, setFocusedPane] = useState<EditorPane>('left');
	const focusedPaneRef = useRef<EditorPane>('left');

	const [leftNote, setLeftNote] = useState<Note | null>(null);
	const [leftFileNote, setLeftFileNote] = useState<FileNote | null>(null);
	const [rightNote, setRightNote] = useState<Note | null>(null);
	const [rightFileNote, setRightFileNote] = useState<FileNote | null>(null);

	const updateFocusedPane = useCallback((pane: EditorPane) => {
		focusedPaneRef.current = pane;
		setFocusedPane(pane);
	}, []);

	const isSplitRef = useRef(isSplit);
	isSplitRef.current = isSplit;
	const isMarkdownPreviewRef = useRef(isMarkdownPreview);
	isMarkdownPreviewRef.current = isMarkdownPreview;

	const leftNoteRef = useRef<Note | null>(null);
	const leftFileNoteRef = useRef<FileNote | null>(null);
	const rightNoteRef = useRef<Note | null>(null);
	const rightFileNoteRef = useRef<FileNote | null>(null);
	leftNoteRef.current = leftNote;
	leftFileNoteRef.current = leftFileNote;
	rightNoteRef.current = rightNote;
	rightFileNoteRef.current = rightFileNote;

	// refから現在の状態を読み取ってlocalStorageに保存（ハンドラから直接呼び出す）
	const saveSplitState = useCallback(() => {
		const state: SplitEditorStorage = {
			isSplit: isSplitRef.current,
			isMarkdownPreview: isMarkdownPreviewRef.current,
			leftNoteId: leftNoteRef.current?.id ?? leftFileNoteRef.current?.id ?? null,
			leftIsFile: leftFileNoteRef.current !== null,
			rightNoteId: rightNoteRef.current?.id ?? rightFileNoteRef.current?.id ?? null,
			rightIsFile: rightFileNoteRef.current !== null,
		};
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	}, []);

	const handleFocusPane = useCallback((pane: EditorPane) => {
		updateFocusedPane(pane);
		if (!isSplitRef.current) return;
		if (pane === 'left') {
			setCurrentNote(leftNote);
			setCurrentFileNote(leftFileNote);
		} else {
			setCurrentNote(rightNote);
			setCurrentFileNote(rightFileNote);
		}
	}, [updateFocusedPane, leftNote, leftFileNote, rightNote, rightFileNote, setCurrentNote, setCurrentFileNote]);

	const toggleSplit = useCallback((rightPaneNote?: Note | FileNote) => {
		const wasSplit = isSplitRef.current;
		setIsMarkdownPreview(false);
		isMarkdownPreviewRef.current = false;

		if (!wasSplit) {
			setLeftNote(currentNote);
			setLeftFileNote(currentFileNote);
			leftNoteRef.current = currentNote;
			leftFileNoteRef.current = currentFileNote;
			if (rightPaneNote) {
				const isFile = 'filePath' in rightPaneNote;
				if (isFile) {
					setRightFileNote(rightPaneNote as FileNote);
					rightFileNoteRef.current = rightPaneNote as FileNote;
					rightNoteRef.current = null;
				} else {
					setRightNote(rightPaneNote as Note);
					rightNoteRef.current = rightPaneNote as Note;
					rightFileNoteRef.current = null;
				}
			}
			updateFocusedPane('left');
			setIsSplit(true);
			isSplitRef.current = true;
		} else {
			setCurrentNote(leftNote);
			setCurrentFileNote(leftFileNote);
			setRightNote(null);
			setRightFileNote(null);
			setLeftNote(null);
			setLeftFileNote(null);
			rightNoteRef.current = null;
			rightFileNoteRef.current = null;
			leftNoteRef.current = null;
			leftFileNoteRef.current = null;
			updateFocusedPane('left');
			setIsSplit(false);
			isSplitRef.current = false;
		}
		saveSplitState();
	}, [updateFocusedPane, currentNote, currentFileNote, leftNote, leftFileNote, setCurrentNote, setCurrentFileNote, saveSplitState]);

	const toggleMarkdownPreview = useCallback(() => {
		if (isSplitRef.current) {
			setCurrentNote(leftNote);
			setCurrentFileNote(leftFileNote);
			setRightNote(null);
			setRightFileNote(null);
			setLeftNote(null);
			setLeftFileNote(null);
			rightNoteRef.current = null;
			rightFileNoteRef.current = null;
			leftNoteRef.current = null;
			leftFileNoteRef.current = null;
			setIsSplit(false);
			isSplitRef.current = false;
		}
		const newMdPreview = !isMarkdownPreviewRef.current;
		setIsMarkdownPreview(newMdPreview);
		isMarkdownPreviewRef.current = newMdPreview;
		updateFocusedPane('left');
		saveSplitState();
	}, [leftNote, leftFileNote, setCurrentNote, setCurrentFileNote, updateFocusedPane, saveSplitState]);

	const handleSelectNoteForPane = useCallback(
		async (note: Note | FileNote) => {
			const isFile = 'filePath' in note;
			const pane = focusedPaneRef.current;

			const otherNoteId = pane === 'left'
				? (rightNoteRef.current?.id ?? rightFileNoteRef.current?.id)
				: (leftNoteRef.current?.id ?? leftFileNoteRef.current?.id);
			if (otherNoteId === note.id) {
				updateFocusedPane(pane === 'left' ? 'right' : 'left');
				setCurrentNote(isFile ? null : note as Note);
				setCurrentFileNote(isFile ? note as FileNote : null);
				return;
			}

			if (pane === 'left') {
				if (isFile) {
					setLeftFileNote(note as FileNote);
					setLeftNote(null);
					leftFileNoteRef.current = note as FileNote;
					leftNoteRef.current = null;
					setCurrentFileNote(note as FileNote);
					setCurrentNote(null);
				} else {
					setLeftNote(note as Note);
					setLeftFileNote(null);
					leftNoteRef.current = note as Note;
					leftFileNoteRef.current = null;
					setCurrentNote(note as Note);
					setCurrentFileNote(null);
				}
			} else {
				if (isFile) {
					setRightFileNote(note as FileNote);
					setRightNote(null);
					rightFileNoteRef.current = note as FileNote;
					rightNoteRef.current = null;
					setCurrentFileNote(note as FileNote);
					setCurrentNote(null);
				} else {
					setRightNote(note as Note);
					setRightFileNote(null);
					rightNoteRef.current = note as Note;
					rightFileNoteRef.current = null;
					setCurrentNote(note as Note);
					setCurrentFileNote(null);
				}
			}
			saveSplitState();
		},
		[setCurrentNote, setCurrentFileNote, updateFocusedPane, saveSplitState],
	);

	// 左ペインのノートコンテンツ変更
	const handleLeftNoteContentChange = useCallback(
		(newContent: string) => {
			setLeftNote((prev) => {
				if (!prev) return prev;
				return { ...prev, content: newContent, modifiedTime: new Date().toISOString() };
			});
		},
		[],
	);

	// 右ペインのノートコンテンツ変更
	const handleRightNoteContentChange = useCallback(
		(newContent: string) => {
			setRightNote((prev) => {
				if (!prev) return prev;
				return { ...prev, content: newContent, modifiedTime: new Date().toISOString() };
			});
		},
		[],
	);

	// 左ペインのファイルノートコンテンツ変更
	const handleLeftFileNoteContentChange = useCallback(
		(newContent: string) => {
			setLeftFileNote((prev) => {
				if (!prev) return prev;
				return { ...prev, content: newContent };
			});
		},
		[],
	);

	// 右ペインのファイルノートコンテンツ変更
	const handleRightFileNoteContentChange = useCallback(
		(newContent: string) => {
			setRightFileNote((prev) => {
				if (!prev) return prev;
				return { ...prev, content: newContent };
			});
		},
		[],
	);

	const activeNote = focusedPane === 'left' ? leftNote : rightNote;
	const activeFileNote = focusedPane === 'left' ? leftFileNote : rightFileNote;

	// 右ペインのノートID（セカンダリ選択表示用）
	const secondarySelectedNoteId = isSplit ? (rightNote?.id ?? rightFileNote?.id ?? undefined) : undefined;

	const restorePaneNotes = useCallback((notes: Note[], fileNotes: FileNote[]) => {
		if (!savedState) return;
		const { isSplit: wasSplit, isMarkdownPreview: wasMdPreview, leftNoteId, leftIsFile, rightNoteId, rightIsFile } = savedState;
		if (!wasSplit && !wasMdPreview) return;

		const findNote = (id: string | null, isFile: boolean): Note | FileNote | null => {
			if (!id) return null;
			if (isFile) return fileNotes.find((f) => f.id === id) ?? null;
			return notes.find((n) => n.id === id && !n.archived) ?? null;
		};

		const left = findNote(leftNoteId, leftIsFile);
		const right = findNote(rightNoteId, rightIsFile);

		if (wasSplit && left) {
			if ('filePath' in left) {
				setLeftFileNote(left as FileNote);
				setCurrentFileNote(left as FileNote);
				setCurrentNote(null);
			} else {
				setLeftNote(left as Note);
				setCurrentNote(left as Note);
				setCurrentFileNote(null);
			}
			if (right) {
				if ('filePath' in right) {
					setRightFileNote(right as FileNote);
				} else {
					setRightNote(right as Note);
				}
			}
		} else if (wasMdPreview) {
			// no-op: currentNote is already set by useInitialize
		}
	}, [setCurrentNote, setCurrentFileNote]);

	return {
		isSplit,
		isMarkdownPreview,
		toggleSplit,
		toggleMarkdownPreview,
		focusedPane,
		updateFocusedPane,
		handleFocusPane,
		leftNote,
		setLeftNote,
		leftFileNote,
		setLeftFileNote,
		rightNote,
		setRightNote,
		rightFileNote,
		setRightFileNote,
		activeNote,
		activeFileNote,
		handleSelectNoteForPane,
		handleLeftNoteContentChange,
		handleRightNoteContentChange,
		handleLeftFileNoteContentChange,
		handleRightFileNoteContentChange,
		secondarySelectedNoteId,
		restorePaneNotes,
		saveSplitState,
	};
};
