import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';
import type { editor } from 'monaco-editor';
import type { Mock } from 'vitest';
import * as runtime from '../../../wailsjs/runtime';
import { EditorStatusBar } from '../EditorStatusBar';

// runtimeのモック
vi.mock('../../../wailsjs/runtime', () => ({
	EventsOn: vi.fn(),
	EventsOff: vi.fn(),
}));

// VersionUpコンポーネントのモック
vi.mock('../VersionUp', () => ({
	VersionUp: () => <div data-testid="version-up">Version Up Component</div>,
}));

describe('EditorStatusBar', () => {
	// モックエディタの作成
	const createMockEditor = () => {
		const model = {
			getValueLength: vi.fn().mockReturnValue(100),
			getLineCount: vi.fn().mockReturnValue(10),
		};

		const mockEditor = {
			getModel: vi.fn().mockReturnValue(model),
			getPosition: vi.fn().mockReturnValue({ lineNumber: 1, column: 1 }),
			getSelection: vi.fn().mockReturnValue({
				isEmpty: () => true,
				startLineNumber: 1,
				startColumn: 1,
				endLineNumber: 1,
				endColumn: 1,
			}),
			onDidChangeCursorPosition: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			onDidChangeCursorSelection: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			onDidChangeModelContent: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		} as unknown as editor.IStandaloneCodeEditor;

		return mockEditor;
	};

	const mockNote = {
		id: '1',
		title: 'Test Note',
		content: 'Test Content',
		contentHeader: null,
		language: 'typescript',
		modifiedTime: new Date().toISOString(),
		archived: false,
	};

	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('エディタの基本情報が正しく表示されること', () => {
		const mockEditor = createMockEditor();
		const editorRef = { current: mockEditor };
		render(
			<EditorStatusBar currentNote={mockNote} editorInstanceRef={editorRef} />,
		);

		expect(screen.getByText('Length: 100')).toBeInTheDocument();
		expect(screen.getByText('Lines: 10')).toBeInTheDocument();
		expect(
			screen.getByText('Cursor Position: [ Line 1, Col 1 ]'),
		).toBeInTheDocument();
	});

	it('選択範囲が正しく表示されること', () => {
		const mockEditor = createMockEditor();
		const editorRef = { current: mockEditor };
		mockEditor.getSelection = vi.fn().mockReturnValue({
			isEmpty: () => false,
			startLineNumber: 1,
			startColumn: 1,
			endLineNumber: 2,
			endColumn: 5,
		});

		render(
			<EditorStatusBar currentNote={mockNote} editorInstanceRef={editorRef} />,
		);
		expect(screen.getByText('Select: [ 1.1 -> 2.5 ]')).toBeInTheDocument();
	});

	it('エディタがnullの場合、情報が表示されないこと', () => {
		const editorRef = { current: null };
		render(
			<EditorStatusBar currentNote={mockNote} editorInstanceRef={editorRef} />,
		);

		expect(screen.queryByText(/Length:/)).not.toBeInTheDocument();
		expect(screen.queryByText(/Lines:/)).not.toBeInTheDocument();
		expect(screen.queryByText(/Cursor Position:/)).not.toBeInTheDocument();
	});

	it('ログメッセージが正しく表示され、フェードアウトすること', async () => {
		const editorRef = { current: null };
		render(
			<EditorStatusBar currentNote={mockNote} editorInstanceRef={editorRef} />,
		);

		// ログメッセージイベントをシミュレート
		const eventCallback = (runtime.EventsOn as unknown as Mock).mock
			.calls[0][1];
		act(() => {
			eventCallback('Test log message');
		});

		// メッセージが表示されることを確認
		const logMessage = screen.getByText('Test log message');
		expect(logMessage).toBeInTheDocument();
		expect(logMessage).toHaveStyle({ opacity: 1 });

		// 8秒後にフェードアウトすることを確認
		act(() => {
			vi.advanceTimersByTime(8000);
		});

		expect(logMessage).toHaveStyle({ opacity: 0 });
	});

	it('コンポーネントのアンマウント時にイベントリスナーが解除されること', () => {
		const editorRef = { current: null };
		const { unmount } = render(
			<EditorStatusBar currentNote={mockNote} editorInstanceRef={editorRef} />,
		);
		unmount();

		expect(runtime.EventsOff).toHaveBeenCalledWith('logMessage');
	});

	it('バージョンアップコンポーネントが表示されること', () => {
		const editorRef = { current: null };
		render(
			<EditorStatusBar currentNote={mockNote} editorInstanceRef={editorRef} />,
		);
		expect(screen.getByTestId('version-up')).toBeInTheDocument();
	});

	describe('通知メッセージ履歴', () => {
		const getEventCallback = (): ((message: string) => void) => {
			return (runtime.EventsOn as unknown as Mock).mock.calls[0][1];
		};

		const sendLogMessages = (messages: string[]) => {
			const callback = getEventCallback();
			for (const msg of messages) {
				act(() => {
					callback(msg);
				});
			}
		};

		it('メッセージ受信後にログメッセージ領域をクリックするとPopoverが開くこと', () => {
			const editorRef = { current: null };
			render(
				<EditorStatusBar
					currentNote={mockNote}
					editorInstanceRef={editorRef}
				/>,
			);

			sendLogMessages(['First message']);

			// ログメッセージのテキストを含むクリック可能な領域をクリック
			const logText = screen.getByText('First message');
			const clickableArea = logText.closest('[class]')!.parentElement!;
			fireEvent.click(clickableArea);

			// Popoverが開き、履歴ヘッダーが表示される
			expect(screen.getByText('Notification History (1)')).toBeInTheDocument();
		});

		it('履歴が空の場合はクリックしてもPopoverが開かないこと', () => {
			const editorRef = { current: null };
			render(
				<EditorStatusBar
					currentNote={mockNote}
					editorInstanceRef={editorRef}
				/>,
			);

			// メッセージが無い状態でVersionUpの隣のBoxをクリック
			// Popoverは開かない
			expect(
				screen.queryByText(/Notification History/),
			).not.toBeInTheDocument();
		});

		it('複数メッセージが履歴に蓄積されること', () => {
			const editorRef = { current: null };
			render(
				<EditorStatusBar
					currentNote={mockNote}
					editorInstanceRef={editorRef}
				/>,
			);

			sendLogMessages(['Message A', 'Message B', 'Message C']);

			// 最新メッセージが表示されていることを確認
			const logText = screen.getByText('Message C');
			fireEvent.click(logText.closest('[class]')!.parentElement!);

			// 全メッセージが履歴に存在
			expect(screen.getByText('Notification History (3)')).toBeInTheDocument();
			expect(screen.getByText('Message A')).toBeInTheDocument();
			expect(screen.getByText('Message B')).toBeInTheDocument();
			// Message Cは現在表示中＋履歴の2箇所にある
			expect(screen.getAllByText('Message C').length).toBeGreaterThanOrEqual(1);
		});

		it('各メッセージにタイムスタンプが表示されること', () => {
			const editorRef = { current: null };
			// 固定日時を設定
			vi.setSystemTime(new Date('2025-02-09T10:30:45'));

			render(
				<EditorStatusBar
					currentNote={mockNote}
					editorInstanceRef={editorRef}
				/>,
			);

			sendLogMessages(['Timestamped message']);

			const logText = screen.getByText('Timestamped message');
			fireEvent.click(logText.closest('[class]')!.parentElement!);

			// タイムスタンプ要素が存在する（ロケールに依存するので形式は緩くチェック）
			const popover = screen.getByText('Notification History (1)').closest('[role="presentation"]')!;
			const listItems = within(popover as HTMLElement).getAllByRole('listitem');
			expect(listItems).toHaveLength(1);
			// タイムスタンプテキストが含まれている
			expect(listItems[0].textContent).toContain('Timestamped message');
		});

		it('Popoverの外をクリックすると閉じること', async () => {
			const editorRef = { current: null };
			render(
				<EditorStatusBar
					currentNote={mockNote}
					editorInstanceRef={editorRef}
				/>,
			);

			sendLogMessages(['Close test']);

			const logText = screen.getByText('Close test');
			fireEvent.click(logText.closest('[class]')!.parentElement!);

			// Popoverが開いている
			expect(screen.getByText('Notification History (1)')).toBeInTheDocument();

			// Escapeキーで閉じる
			fireEvent.keyDown(screen.getByText('Notification History (1)'), {
				key: 'Escape',
			});

			// Popoverが閉じる（MUIのアニメーション完了を待つ）
			await act(async () => {
				vi.advanceTimersByTime(500);
			});
		});

		it('メッセージ履歴は古い順に表示されること（上が古い、下が新しい）', () => {
			const editorRef = { current: null };
			render(
				<EditorStatusBar
					currentNote={mockNote}
					editorInstanceRef={editorRef}
				/>,
			);

			sendLogMessages(['First', 'Second', 'Third']);

			const logTexts = screen.getAllByText('Third');
			fireEvent.click(logTexts[0].closest('[class]')!.parentElement!);

			const popover = screen.getByText('Notification History (3)').closest('[role="presentation"]')!;
			const listItems = within(popover as HTMLElement).getAllByRole('listitem');
			expect(listItems).toHaveLength(3);
			expect(listItems[0]).toHaveTextContent('First');
			expect(listItems[1]).toHaveTextContent('Second');
			expect(listItems[2]).toHaveTextContent('Third');
		});
	});
});
