import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('lib/monaco language registration', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('基本言語contributionを読み込み、Markdownをサポート言語に含めること', async () => {
		let basicContributionLoaded = false;

		vi.unmock('../monaco');

		vi.doMock('monaco-editor', () => ({
			editor: {
				defineTheme: vi.fn(),
				onDidCreateEditor: vi.fn(() => ({ dispose: vi.fn() })),
			},
			languages: {
				getLanguages: vi.fn(() =>
					basicContributionLoaded
						? [
								{ id: 'plaintext', aliases: ['Plain Text'] },
								{ id: 'markdown', aliases: ['Markdown'] },
							]
						: [{ id: 'plaintext', aliases: ['Plain Text'] }],
				),
			},
			Uri: {
				parse: vi.fn((uri: string) => uri),
			},
		}));

		vi.doMock(
			'monaco-editor/esm/vs/features/unicodeHighlighter/register.js',
			() => ({}),
		);
		vi.doMock(
			'monaco-editor/esm/vs/basic-languages/monaco.contribution.js',
			() => {
				basicContributionLoaded = true;
				return {};
			},
		);
		vi.doMock('monaco-editor/esm/vs/editor/editor.worker?worker', () => ({
			default: class MockWorker {},
		}));
		vi.doMock('monaco-editor/esm/vs/language/json/json.worker?worker', () => ({
			default: class MockWorker {},
		}));
		vi.doMock('monaco-editor/esm/vs/language/css/css.worker?worker', () => ({
			default: class MockWorker {},
		}));
		vi.doMock('monaco-editor/esm/vs/language/html/html.worker?worker', () => ({
			default: class MockWorker {},
		}));
		vi.doMock(
			'monaco-editor/esm/vs/language/typescript/ts.worker?worker',
			() => ({
				default: class MockWorker {},
			}),
		);
		vi.doMock(
			'monaco-editor/esm/vs/language/typescript/monaco.contribution.js',
			() => ({
				javascriptDefaults: {
					setDiagnosticsOptions: vi.fn(),
				},
				typescriptDefaults: {
					setDiagnosticsOptions: vi.fn(),
					setCompilerOptions: vi.fn(),
					setEagerModelSync: vi.fn(),
				},
				ScriptTarget: {
					Latest: 99,
				},
				ModuleResolutionKind: {
					NodeJs: 2,
				},
				ModuleKind: {
					CommonJS: 1,
				},
				JsxEmit: {
					React: 2,
				},
			}),
		);

		const monacoLib = await import('../monaco');
		const languages = monacoLib.getSupportedLanguages();

		expect(languages.map((lang) => lang.id)).toContain('markdown');
	});
});
