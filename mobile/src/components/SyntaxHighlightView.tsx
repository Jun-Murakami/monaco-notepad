import { type ReactNode, useCallback, useMemo } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useTheme } from 'react-native-paper';
import SyntaxHighlighter from 'react-syntax-highlighter';
import {
	atomOneDark,
	atomOneLight,
} from 'react-syntax-highlighter/dist/esm/styles/hljs';

interface Props {
	content: string;
	language: string;
	/** 本文のフォントサイズ (px)。指定されないとき 13。 */
	fontSize?: number;
}

/**
 * 閲覧モード専用のシンタックスハイライト。
 *
 * 左に行番号カラム、右に本文カラムの 2 カラム構成。本文が wrap した時は
 * 行番号を先頭行のみ表示して、続きは本文カラムでインデントされたまま継続する
 * （Monaco の gutter + wrap と同じ体験）。
 *
 * 段落間（行 View 区切り）と wrap 行間は完全一致させるのが難しいため、
 * `lineHeight` を小さめにして全体をタイトにまとめる方針。
 */
export function SyntaxHighlightView({
	content,
	language,
	fontSize = 13,
}: Props) {
	const theme = useTheme();
	const hljsStyle = theme.dark ? atomOneDark : atomOneLight;
	const dim = theme.colors.outline;
	const fg = theme.colors.onSurface;

	// fontSize に応じて行高 / 行番号サイズも追従させる。
	const dynamicStyles = useMemo(() => {
		const lineHeight = Math.round(fontSize * 1.55);
		return StyleSheet.create({
			lineNumber: {
				paddingRight: 8,
				textAlign: 'right',
				fontFamily: MONO,
				fontSize: Math.max(10, fontSize - 1),
				lineHeight,
				includeFontPadding: false,
				textAlignVertical: 'top',
			},
			lineText: {
				flex: 1,
				fontFamily: MONO,
				fontSize,
				lineHeight,
				includeFontPadding: false,
				textAlignVertical: 'top',
			},
		});
	}, [fontSize]);

	const renderer = useCallback(
		// biome-ignore lint/suspicious/noExplicitAny: renderer の型は any
		({ rows, stylesheet }: { rows: any[]; stylesheet: any }): ReactNode => {
			const digits = String(rows.length).length;
			return (
				<View>
					{rows.map((row, idx) => (
						<View
							// biome-ignore lint/suspicious/noArrayIndexKey: 行 index は安定
							key={idx}
							style={styles.line}
						>
							<Text
								selectable={false}
								style={[
									dynamicStyles.lineNumber,
									{ color: dim, minWidth: digits * 8 + 12 },
								]}
							>
								{idx + 1}
							</Text>
							<Text
								selectable={false}
								style={[dynamicStyles.lineText, { color: fg }]}
							>
								{renderTokens(row.children ?? [], stylesheet)}
							</Text>
						</View>
					))}
				</View>
			);
		},
		[dim, fg, dynamicStyles],
	);

	return (
		<SyntaxHighlighter
			language={normalizeLang(language)}
			style={hljsStyle}
			// biome-ignore lint/suspicious/noExplicitAny: PreTag/CodeTag を View に差し替え
			PreTag={View as any}
			// biome-ignore lint/suspicious/noExplicitAny: 同上
			CodeTag={View as any}
			renderer={renderer}
		>
			{content || ' '}
		</SyntaxHighlighter>
	);
}

// biome-ignore lint/suspicious/noExplicitAny: AST ノード
function renderTokens(nodes: any[], stylesheet: any): ReactNode[] {
	return nodes.map((node, i) => {
		if (node.type === 'text') {
			// react-syntax-highlighter は各 row の末尾に '\n' を含めることがある。
			// 各 row を個別の Text として描画する我々にとっては不要（行末の余計な空行が
			// 描画され、行高さが倍になる）。除去する。
			const value: string = node.value;
			return value.replace(/\n+$/, '');
		}
		const classes: string[] = node.properties?.className ?? [];
		const merged: Record<string, string | number> = {};
		for (const cls of classes) {
			const styleObj = stylesheet?.[cls];
			if (styleObj) Object.assign(merged, styleObj);
		}
		const rnStyle = {
			color: typeof merged.color === 'string' ? merged.color : undefined,
			fontStyle:
				merged.fontStyle === 'italic'
					? ('italic' as const)
					: ('normal' as const),
			fontWeight:
				merged.fontWeight === 'bold' || merged.fontWeight === '700'
					? ('700' as const)
					: undefined,
		};
		return (
			<Text
				// biome-ignore lint/suspicious/noArrayIndexKey: 位置 index は安定
				key={i}
				style={rnStyle}
			>
				{renderTokens(node.children ?? [], stylesheet)}
			</Text>
		);
	});
}

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

const MONO =
	Platform.select({
		ios: 'Menlo',
		android: 'monospace',
		default: 'monospace',
	}) ?? 'monospace';

const styles = StyleSheet.create({
	line: {
		flexDirection: 'row',
		alignItems: 'flex-start',
	},
});
