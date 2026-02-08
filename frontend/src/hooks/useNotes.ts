import { useCallback, useEffect, useRef, useState } from 'react';
import {
	DeleteNote,
	DestroyApp,
	ListNotes,
	LoadArchivedNote,
	SaveNote,
} from '../../wailsjs/go/backend/App';
import { backend } from '../../wailsjs/go/models';
import * as runtime from '../../wailsjs/runtime';
import type { Note } from '../types';

export const useNotes = () => {
	const [notes, setNotes] = useState<Note[]>([]);
	const [currentNote, setCurrentNote] = useState<Note | null>(null);
	const [showArchived, setShowArchived] = useState(false);
	const isNoteModified = useRef(false);
	const previousContent = useRef<string>('');
	const isClosing = useRef(false);
	const currentNoteRef = useRef<Note | null>(null);

	// currentNoteの変更を追跡 ------------------------------------------------------------
	useEffect(() => {
		currentNoteRef.current = currentNote;
	}, [currentNote]);

	// 初期ロードとイベントリスナーの設定 ------------------------------------------------------------
	// ノートの内容を比較する関数
	const isNoteChanged = useCallback(
		(oldNote: Note | null, newNote: Note | null): boolean => {
			if (!oldNote || !newNote) return true;
			return (
				oldNote.title !== newNote.title ||
				oldNote.content !== newNote.content ||
				oldNote.language !== newNote.language ||
				oldNote.archived !== newNote.archived ||
				oldNote.modifiedTime !== newNote.modifiedTime
			);
		},
		[],
	);

	// ノートリストの内容を比較する関数
	const isNoteListChanged = useCallback(
		(oldNotes: Note[], newNotes: Note[]): boolean => {
			if (oldNotes.length !== newNotes.length) return true;
			return oldNotes.some((oldNote, index) =>
				isNoteChanged(oldNote, newNotes[index]),
			);
		},
		[isNoteChanged],
	);

	// メインエフェクト
	useEffect(() => {
		// notes:reloadイベントのハンドラを登録
		runtime.EventsOn('notes:reload', async () => {
			const newNotes = await ListNotes();

			// ノートリストの内容を比較
			if (isNoteListChanged(notes, newNotes)) {
				setNotes(newNotes);
			}

			// 現在表示中のノートも更新
			if (currentNoteRef.current) {
				const updatedCurrentNote = newNotes.find(
					(note) => note.id === currentNoteRef.current?.id,
				);
				if (
					updatedCurrentNote &&
					isNoteChanged(currentNoteRef.current, updatedCurrentNote)
				) {
					setCurrentNote(updatedCurrentNote);
					previousContent.current = updatedCurrentNote.content || '';
					isNoteModified.current = false;
				}
			}
		});

		// 個別のノート更新イベントのハンドラを登録
		runtime.EventsOn('note:updated', async (noteId: string) => {
			// 更新されたノートを再読み込み
			const newNotes = await ListNotes();

			// ノートリストの内容を比較
			if (isNoteListChanged(notes, newNotes)) {
				setNotes(newNotes);
			}

			// 現在表示中のノートが更新された場合、その内容も更新
			if (currentNoteRef.current?.id === noteId) {
				const updatedNote = newNotes.find((note) => note.id === noteId);
				if (updatedNote && isNoteChanged(currentNoteRef.current, updatedNote)) {
					setCurrentNote(updatedNote);
					previousContent.current = updatedNote.content || '';
					isNoteModified.current = false;
				}
			}
		});

		// BeforeCloseイベントのリスナーを一度だけ設定
		const handleBeforeClose = async () => {
			if (isClosing.current) return;
			isClosing.current = true;

			try {
				const noteToSave = currentNoteRef.current;
				if (noteToSave?.id && isNoteModified.current) {
					await SaveNote(backend.Note.createFrom(noteToSave), 'update');
				}
			} catch (_error) {}
			DestroyApp();
		};

		runtime.EventsOn('app:beforeclose', handleBeforeClose);

		return () => {
			runtime.EventsOff('app:beforeclose');
			runtime.EventsOff('notes:reload');
			runtime.EventsOff('note:updated');
		};
	}, [isNoteChanged, isNoteListChanged, notes]);

	// 現在のノートを保存する ------------------------------------------------------------
	const saveCurrentNote = useCallback(async () => {
		if (!currentNote?.id || !isNoteModified.current) return;
		try {
			setNotes((prev) =>
				prev.map((note) => (note.id === currentNote.id ? currentNote : note)),
			);
			await SaveNote(backend.Note.createFrom(currentNote), 'update');
			isNoteModified.current = false;
		} catch (_error) {}
	}, [currentNote]);

	// 自動保存の処理 (デバウンスありSynchingSynching) ------------------------------------------------------------
	useEffect(() => {
		if (!currentNote) return;

		const debounce = setTimeout(() => {
			if (isNoteModified.current) {
				saveCurrentNote();
			}
		}, 3000); // 3秒ごとに自動保存

		return () => {
			clearTimeout(debounce);
		};
	}, [currentNote, saveCurrentNote]);

	// 新規ノート作成のロジックを関数として抽出 ------------------------------------------------------------
	const createNewNote = useCallback(async () => {
		const newNote: Note = {
			id: crypto.randomUUID(),
			title: '',
			content: '',
			contentHeader: null,
			language: currentNote?.language || 'plaintext',
			modifiedTime: new Date().toISOString(),
			archived: false,
		};
		setShowArchived(false);
		setNotes((prev) => [newNote, ...prev]);
		setCurrentNote(newNote);
		await SaveNote(backend.Note.createFrom(newNote), 'create');
		return newNote;
	}, [currentNote]);

	// 新規ノート作成 ------------------------------------------------------------
	const handleNewNote = useCallback(async () => {
		if (currentNote && isNoteModified.current) {
			await saveCurrentNote();
		}
		await createNewNote();
	}, [currentNote, saveCurrentNote, createNewNote]);

	// ノートをアーカイブする ------------------------------------------------------------
	const handleArchiveNote = useCallback(
		async (noteId: string) => {
			const note = notes.find((note) => note.id === noteId);
			if (!note) return;

			// コンテンツヘッダーを生成(最初の3行を200文字まで)
			const content = note.content || '';
			const contentHeader =
				content.match(/^.+$/gm)?.slice(0, 3).join('\n').slice(0, 200) || '';

			const archivedNote = {
				...note,
				archived: true,
				content: content,
				contentHeader,
			};

			setNotes((prev) => prev.map((n) => (n.id === noteId ? archivedNote : n)));
			await SaveNote(backend.Note.createFrom(archivedNote), 'update');

			// アーカイブされたノートを選択している場合は、アクティブなノートに切り替える
			if (currentNote?.id === noteId) {
				const activeNotes = notes.filter(
					(note) => !note.archived && note.id !== noteId,
				);
				if (activeNotes.length > 0) {
					setCurrentNote(activeNotes[0]);
				} else {
					await handleNewNote();
				}
			}
		},
		[currentNote, handleNewNote, notes],
	);

	// ノートを選択する ------------------------------------------------------------
	const handleSelectNote = useCallback(
		async (note: Note) => {
			// 現在のノートが変更されている場合は切り替える前に保存
			if (currentNote?.id && isNoteModified.current) {
				await saveCurrentNote();
			}
			// アーカイブページを閉じる
			setShowArchived(false);

			previousContent.current = note.content || '';
			setCurrentNote(note);
			isNoteModified.current = false;
		},
		[currentNote, saveCurrentNote],
	);

	// ノートをアーカイブ解除する ------------------------------------------------------------
	const handleUnarchiveNote = useCallback(
		async (noteId: string) => {
			const note = notes.find((note) => note.id === noteId);
			if (!note) return;

			// アーカイブされたノートのコンテンツを読み込む
			const loadedNote = await LoadArchivedNote(noteId);
			if (loadedNote) {
				const unarchivedNote = { ...loadedNote, archived: false };
				setNotes((prev) =>
					prev.map((note) => (note.id === noteId ? unarchivedNote : note)),
				);
				setCurrentNote(unarchivedNote);
				setShowArchived(false);
				await SaveNote(backend.Note.createFrom(unarchivedNote), 'update');
			}
		},
		[notes],
	);

	// ノートを削除する ------------------------------------------------------------
	const handleDeleteNote = useCallback(
		async (noteId: string) => {
			// 削除前の状態を確認
			const activeNotes = notes.filter((note) => !note.archived);
			const archivedNotes = notes.filter((note) => note.archived);
			const isLastNote =
				archivedNotes.length === 1 && archivedNotes[0].id === noteId;
			const hasOnlyOneActiveNote = activeNotes.length === 1;
			const hasNoActiveNotes = activeNotes.length === 0;

			// ノートの削除処理
			await DeleteNote(noteId);
			// ノートリストを更新
			setNotes((prev) => prev.filter((note) => note.id !== noteId));

			// アーカイブページでの処理
			if (showArchived) {
				if (isLastNote) {
					// 最後のアーカイブノートを削除する場合
					if (hasNoActiveNotes) {
						// アクティブなノートが1つもない場合、新規ノートを作成して遷移
						await createNewNote();
					} else if (hasOnlyOneActiveNote) {
						// アクティブなノートが1つだけある場合、そのノートに遷移
						setShowArchived(false);
						setCurrentNote(activeNotes[0]);
					}
					// アクティブなノートが2つ以上ある場合は何もしない（アーカイブページのまま）
				}
			}
		},
		[createNewNote, notes, showArchived],
	);

	// ノートをすべて削除する ------------------------------------------------------------
	const handleDeleteAllArchivedNotes = useCallback(async () => {
		const archivedNotes = notes.filter((note) => note.archived);

		// すべてのアーカイブされたノートを削除
		for (const note of archivedNotes) {
			await DeleteNote(note.id);
		}
		// ノートリストを更新
		setNotes((prev) => prev.filter((note) => !note.archived));

		// アクティブなノートがある場合はそのノートに遷移
		const activeNotes = notes.filter((note) => !note.archived);
		if (activeNotes.length > 0) {
			setCurrentNote(activeNotes[0]);
		} else {
			// アクティブなノートがない場合は新規ノートを作成
			await createNewNote();
		}
		setShowArchived(false);
	}, [createNewNote, notes]);

	// ノートのタイトル、言語、内容を変更する ------------------------------------------------------------
	const stateChanger = useCallback(
		(target: 'title' | 'language' | 'content') => {
			return (newState: string) => {
				setCurrentNote((prev) => {
					if (!prev) return prev;
					if (newState === previousContent.current) {
						return prev;
					}

					if (target === 'content') {
						previousContent.current = newState;
					}
					isNoteModified.current = true;
					const updated = {
						...prev,
						[target]: newState,
						modifiedTime: new Date().toISOString(),
					};

					if (target === 'title') {
						setNotes((prevNotes) =>
							prevNotes.map((n) =>
								n.id === prev.id ? { ...n, title: newState } : n,
							),
						);
					}

					return updated;
				});
			};
		},
		[],
	);

	// ノートのタイトルを変更する ------------------------------------------------------------
	const handleTitleChange = (newTitle: string) => {
		stateChanger('title')(newTitle);
	};

	// ノートの言語を変更する ------------------------------------------------------------
	const handleLanguageChange = (newLanguage: string) => {
		stateChanger('language')(newLanguage);
	};

	// ノートの内容を変更する ------------------------------------------------------------
	const handleNoteContentChange = (newContent: string) => {
		stateChanger('content')(newContent);
	};

	return {
		notes,
		setNotes,
		currentNote,
		setCurrentNote,
		showArchived,
		setShowArchived,
		saveCurrentNote,
		handleNewNote,
		handleArchiveNote,
		handleSelectNote,
		handleUnarchiveNote,
		handleDeleteNote,
		handleDeleteAllArchivedNotes,
		handleTitleChange,
		handleLanguageChange,
		handleNoteContentChange,
	};
};
