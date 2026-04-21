import { Platform, StyleSheet } from 'react-native';
import SyntaxHighlighter from 'react-native-syntax-highlighter';
import { useTheme } from 'react-native-paper';

// react-native-syntax-highlighter は react-syntax-highlighter のスタイルを受け取れる。
// 型定義が不完全なので require で読み込んで any として扱う。
// biome-ignore lint/suspicious/noExplicitAny: 動的 import
const hljsStyles = require('react-syntax-highlighter/dist/esm/styles/hljs') as any;

interface Props {
	content: string;
	language: string;
}

/**
 * 閲覧モード専用のシンタックスハイライト表示。
 * 編集モードでは TextInput にフォールバック（GitHub モバイルと同じ UX）。
 */
export function SyntaxHighlightView({ content, language }: Props) {
	const theme = useTheme();
	const style = theme.dark ? hljsStyles.atomOneDark : hljsStyles.atomOneLight;
	return (
		<SyntaxHighlighter
			language={normalizeLang(language)}
			highlighter="hljs"
			style={style}
			customStyle={styles.code}
			fontFamily={MONO}
			fontSize={14}
		>
			{content || ' '}
		</SyntaxHighlighter>
	);
}

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }) ?? 'monospace';

function normalizeLang(lang: string): string {
	const map: Record<string, string> = {
		plaintext: 'plaintext',
		'': 'plaintext',
		md: 'markdown',
		ts: 'typescript',
		tsx: 'typescript',
		js: 'javascript',
		jsx: 'javascript',
		py: 'python',
		sh: 'bash',
		yml: 'yaml',
	};
	return map[lang] ?? lang;
}

const styles = StyleSheet.create({
	code: {
		padding: 16,
		margin: 0,
	},
});
