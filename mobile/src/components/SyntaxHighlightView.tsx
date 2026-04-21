import { Platform, StyleSheet } from 'react-native';
import CodeHighlighter from 'react-native-code-highlighter';
import { useTheme } from 'react-native-paper';
import {
	atomOneDark,
	atomOneLight,
} from 'react-syntax-highlighter/dist/esm/styles/hljs';

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
	const hljsStyle = theme.dark ? atomOneDark : atomOneLight;
	return (
		<CodeHighlighter
			hljsStyle={hljsStyle}
			language={normalizeLang(language)}
			textStyle={styles.text}
			scrollViewProps={{ contentContainerStyle: styles.container }}
		>
			{content || ' '}
		</CodeHighlighter>
	);
}

const MONO =
	Platform.select({
		ios: 'Menlo',
		android: 'monospace',
		default: 'monospace',
	}) ?? 'monospace';

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
	container: {
		padding: 16,
		minWidth: '100%',
	},
	text: {
		fontFamily: MONO,
		fontSize: 14,
	},
});
