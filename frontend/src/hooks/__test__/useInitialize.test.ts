import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ListNotes,
	LoadFileNotes,
	NotifyFrontendReady,
} from '../../../wailsjs/go/backend/App';
import * as runtime from '../../../wailsjs/runtime';
import type { FileNote, Note } from '../../types';
import { useInitialize } from '../useInitialize';

// Vitestのモック型定義
type MockFunction = {
	mockResolvedValue: (value: unknown) => void;
	mockRejectedValue: (error: Error) => void;
	mockImplementation: (
		fn: (event: string, callback: () => void) => () => void,
	) => void;
	mock: {
		calls: unknown[][];
	};
};

// Monaco Editorのモック
vi.mock('../../lib/monaco', () => ({
	getSupportedLanguages: vi.fn().mockReturnValue([
		{ id: 'plaintext', extensions: ['.txt'], aliases: ['Plain Text'] },
		{ id: 'javascript', extensions: ['.js'], aliases: ['JavaScript'] },
	]),
}));

// モックの設定を修正
vi.mock('../../../wailsjs/go/backend/App', () => ({
	ListNotes: vi.fn(),
	NotifyFrontendReady: vi.fn(),
	LoadFileNotes: vi.fn(),
}));

vi.mock('../../../wailsjs/runtime', () => ({
	EventsOn: vi.fn(), // mockReturnValueを削除
	EventsOff: vi.fn(),
	Environment: vi.fn(),
}));

// テスト用のモックデータ
const mockNote: Note = {
	id: '1',
	title: 'Test Note',
	content: 'Test Content',
	contentHeader: null,
	language: 'plaintext',
	modifiedTime: new Date().toISOString(),
	archived: false,
};

const mockFileNote: FileNote = {
	id: '2',
	filePath: '/path/to/file.txt',
	fileName: 'file.txt',
	content: 'File Content',
	originalContent: 'File Content',
	language: 'plaintext',
	modifiedTime: new Date().toISOString(),
};

let isInitialized: boolean;
vi.mock('../useInitialize', async () => {
	const actual =
		await vi.importActual<typeof import('../useInitialize')>(
			'../useInitialize',
		);
	return {
		...actual,
		get isInitialized() {
			return isInitialized;
		},
		set isInitialized(value: boolean) {
			isInitialized = value;
		},
	};
});

describe('useInitialize', () => {
	// モック関数の準備
	const mockSetNotes = vi.fn();
	const mockSetFileNotes = vi.fn();
	const mockHandleNewNote = vi.fn();
	const mockHandleSelecAnyNote = vi.fn();
	const mockHandleSaveFile = vi.fn();
	const mockHandleOpenFile = vi.fn();
	const mockHandleCloseFile = vi.fn();
	const mockIsFileModified = vi.fn();
	const mockHandleArchiveNote = vi.fn();
	const mockHandleSaveAsFile = vi.fn();
	const mockHandleSelectNextAnyNote = vi.fn();
	const mockHandleSelectPreviousAnyNote = vi.fn();
	const mockSetCurrentFileNote = vi.fn();

	beforeEach(() => {
		console.log('beforeEach: テストの初期化を開始');
		vi.clearAllMocks();
		vi.useFakeTimers();
		isInitialized = false;

		// モックの実装を設定
		console.log('beforeEach: モックの設定を開始');
		(runtime.Environment as unknown as MockFunction).mockResolvedValue({
			platform: 'windows',
		});
		(ListNotes as unknown as MockFunction).mockResolvedValue([mockNote]);
		(LoadFileNotes as unknown as MockFunction).mockResolvedValue([
			mockFileNote,
		]);
		(NotifyFrontendReady as unknown as MockFunction).mockResolvedValue(
			undefined,
		);
		(runtime.EventsOn as unknown as MockFunction).mockImplementation(
			(event: string, _callback: () => void) => {
				console.log(`EventsOn called with event: ${event}`);
				return () => {
					console.log(`EventsOff called for event: ${event}`);
				};
			},
		);
		console.log('beforeEach: モックの設定完了');
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('初期化時に必要なデータを読み込むこと', async () => {
		const rendered = renderHook(() =>
			useInitialize(
				mockSetNotes,
				mockSetFileNotes,
				mockHandleNewNote,
				mockHandleSelecAnyNote,
				null,
				mockSetCurrentFileNote,
				mockHandleSaveFile,
				mockHandleOpenFile,
				mockHandleCloseFile,
				mockIsFileModified,
				null,
				mockHandleArchiveNote,
				mockHandleSaveAsFile,
				mockHandleSelectNextAnyNote,
				mockHandleSelectPreviousAnyNote,
			),
		);

		await act(async () => {
			await vi.runAllTimersAsync();
		});

		// プラットフォーム情報が取得されていること
		expect(runtime.Environment).toHaveBeenCalled();
		// ノートリストが読み込まれていること
		expect(ListNotes).toHaveBeenCalled();
		// ファイルノートリストが読み込まれていること
		expect(LoadFileNotes).toHaveBeenCalled();
		// ノートリストがセットされていること
		expect(mockSetNotes).toHaveBeenCalledWith([
			{
				...mockNote,
				modifiedTime: mockNote.modifiedTime.toString(),
			},
		]);
		// ファイルノートリストがセットされていること
		expect(mockSetFileNotes).toHaveBeenCalledWith([
			{
				...mockFileNote,
				modifiedTime: mockFileNote.modifiedTime.toString(),
			},
		]);
		// サポートされている言語一覧が取得されていること
		expect(rendered.result.current.languages).toEqual([
			{ id: 'plaintext', extensions: ['.txt'], aliases: ['Plain Text'] },
			{ id: 'javascript', extensions: ['.js'], aliases: ['JavaScript'] },
		]);
		// プラットフォーム情報が設定されていること
		expect(rendered.result.current.platform).toBe('windows');
	});

	it('バックエンド準備完了イベントを処理すること', async () => {
		console.log('テスト開始: バックエンド準備完了イベント');
		const _hook = renderHook(() =>
			useInitialize(
				mockSetNotes,
				mockSetFileNotes,
				mockHandleNewNote,
				mockHandleSelecAnyNote,
				null,
				mockSetCurrentFileNote,
				mockHandleSaveFile,
				mockHandleOpenFile,
				mockHandleCloseFile,
				mockIsFileModified,
				null,
				mockHandleArchiveNote,
				mockHandleSaveAsFile,
				mockHandleSelectNextAnyNote,
				mockHandleSelectPreviousAnyNote,
			),
		);
		console.log('フックのレンダリング完了');

		await act(async () => {
			await Promise.resolve();
			await vi.runAllTimersAsync();
			await Promise.resolve();
		});

		expect(NotifyFrontendReady).toHaveBeenCalled();
	});

	it('グローバルキーボードショートカットが機能すること', async () => {
		renderHook(() =>
			useInitialize(
				mockSetNotes,
				mockSetFileNotes,
				mockHandleNewNote,
				mockHandleSelecAnyNote,
				null,
				mockSetCurrentFileNote,
				mockHandleSaveFile,
				mockHandleOpenFile,
				mockHandleCloseFile,
				mockIsFileModified,
				null,
				mockHandleArchiveNote,
				mockHandleSaveAsFile,
				mockHandleSelectNextAnyNote,
				mockHandleSelectPreviousAnyNote,
			),
		);

		await act(async () => {
			await vi.runAllTimersAsync();
		});

		// 新規ノート作成 (Ctrl+N)
		const newNoteEvent = new KeyboardEvent('keydown', {
			key: 'n',
			ctrlKey: true,
		});
		window.dispatchEvent(newNoteEvent);
		await vi.runAllTimersAsync();

		expect(mockSetCurrentFileNote).toHaveBeenCalledWith(null);
		expect(mockHandleNewNote).toHaveBeenCalled();

		// ファイルを開く (Ctrl+O)
		const openFileEvent = new KeyboardEvent('keydown', {
			key: 'o',
			ctrlKey: true,
		});
		window.dispatchEvent(openFileEvent);
		await vi.runAllTimersAsync();

		expect(mockHandleOpenFile).toHaveBeenCalled();

		// 次のノートに移動 (Ctrl+Tab)
		const nextNoteEvent = new KeyboardEvent('keydown', {
			key: 'tab',
			ctrlKey: true,
		});
		window.dispatchEvent(nextNoteEvent);
		await vi.runAllTimersAsync();

		expect(mockHandleSelectNextAnyNote).toHaveBeenCalled();

		// 前のノートに移動 (Ctrl+Shift+Tab)
		const previousNoteEvent = new KeyboardEvent('keydown', {
			key: 'tab',
			ctrlKey: true,
			shiftKey: true,
		});
		window.dispatchEvent(previousNoteEvent);
		await vi.runAllTimersAsync();

		expect(mockHandleSelectPreviousAnyNote).toHaveBeenCalled();
	});

	it('ノートリストが空の場合に新規ノートを作成すること', async () => {
		console.log('テスト開始: 空のノートリスト');
		(ListNotes as unknown as MockFunction).mockResolvedValue(null);
		(LoadFileNotes as unknown as MockFunction).mockResolvedValue([]);

		const _hook = renderHook(() =>
			useInitialize(
				mockSetNotes,
				mockSetFileNotes,
				mockHandleNewNote,
				mockHandleSelecAnyNote,
				null,
				mockSetCurrentFileNote,
				mockHandleSaveFile,
				mockHandleOpenFile,
				mockHandleCloseFile,
				mockIsFileModified,
				null,
				mockHandleArchiveNote,
				mockHandleSaveAsFile,
				mockHandleSelectNextAnyNote,
				mockHandleSelectPreviousAnyNote,
			),
		);

		await act(async () => {
			await Promise.resolve();
			await vi.runAllTimersAsync();
			await Promise.resolve();
			await vi.runAllTimersAsync();
		});

		expect(mockSetNotes).toHaveBeenCalledWith([]);
		expect(mockHandleNewNote).toHaveBeenCalled();
	});

	it('エラー発生時に適切に処理すること', async () => {
		console.log('テスト開始: エラー処理');
		(ListNotes as unknown as MockFunction).mockRejectedValue(
			new Error('Failed to load notes'),
		);
		(LoadFileNotes as unknown as MockFunction).mockResolvedValue([]);

		const _hook = renderHook(() =>
			useInitialize(
				mockSetNotes,
				mockSetFileNotes,
				mockHandleNewNote,
				mockHandleSelecAnyNote,
				null,
				mockSetCurrentFileNote,
				mockHandleSaveFile,
				mockHandleOpenFile,
				mockHandleCloseFile,
				mockIsFileModified,
				null,
				mockHandleArchiveNote,
				mockHandleSaveAsFile,
				mockHandleSelectNextAnyNote,
				mockHandleSelectPreviousAnyNote,
			),
		);

		await act(async () => {
			await Promise.resolve();
			await vi.runAllTimersAsync();
			await Promise.resolve();
			await vi.runAllTimersAsync();
		});

		expect(mockSetNotes).toHaveBeenCalledWith([]);
		expect(mockHandleNewNote).toHaveBeenCalled();
	});
});
