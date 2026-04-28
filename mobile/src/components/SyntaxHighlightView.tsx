import { type ReactNode, useCallback, useMemo, useRef } from 'react';
import {
	type GestureResponderEvent,
	Platform,
	Pressable,
	type StyleProp,
	StyleSheet,
	Text,
	type TextStyle,
	View,
} from 'react-native';
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
	/** 閲覧行をタップした時、本文の論理行・論理行内の桁を返す。 */
	onPressPosition?: (position: SyntaxHighlightPressPosition) => void;
}

export interface SyntaxHighlightPressPosition {
	lineIndex: number;
	column: number;
	visualY: number;
}

interface HighlightNode {
	type?: string;
	value?: string;
	properties?: {
		className?: string[];
	};
	children?: HighlightNode[];
}

type HighlightStyleSheet = Record<
	string,
	Record<string, string | number | undefined> | undefined
>;

interface LogicalLineLayout {
	y: number;
	textX: number;
	textWidth: number;
	charWidth: number;
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
	onPressPosition,
}: Props) {
	const theme = useTheme();
	const hljsStyle = theme.dark ? atomOneDark : atomOneLight;
	const dim = theme.colors.outline;
	const fg = theme.colors.onSurface;
	const lineLayoutsRef = useRef<Record<number, LogicalLineLayout>>({});
	const logicalLines = useMemo(() => buildLogicalLines(content), [content]);

	// fontSize に応じて行高 / 行番号サイズも追従させる。
	const lineHeight = Math.round(fontSize * 1.55);
	const dynamicStyles = useMemo(() => {
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
			tokenText: {
				fontFamily: MONO,
				fontSize,
				lineHeight,
				includeFontPadding: false,
			},
		});
	}, [fontSize, lineHeight]);

	const handleLinePress = useCallback(
		(lineIndex: number, event: GestureResponderEvent) => {
			if (!onPressPosition) return;
			const layout = lineLayoutsRef.current[lineIndex];
			const logicalLine = logicalLines[lineIndex] ?? '';
			const charWidth = Math.max(1, layout?.charWidth ?? fontSize * 0.6);
			const textWidth = Math.max(charWidth, layout?.textWidth ?? charWidth);
			const charsPerVisualLine = Math.max(1, Math.floor(textWidth / charWidth));
			const locationXInText = Math.max(
				0,
				event.nativeEvent.locationX - (layout?.textX ?? 0),
			);
			const visualLineIndex = Math.max(
				0,
				Math.floor(event.nativeEvent.locationY / lineHeight),
			);
			const columnInVisualLine = Math.round(locationXInText / charWidth);

			onPressPosition({
				lineIndex,
				// ピック結果は必ず「論理行 + 論理行内 column」に正規化する。
				// 折り返しは visualLineIndex と 1 行あたり文字数から column を作るだけで、
				// RN の onTextLayout が返す折り返し文字列長は offset には使わない。
				column: clamp(
					visualLineIndex * charsPerVisualLine + columnInVisualLine,
					0,
					logicalLine.length,
				),
				visualY: (layout?.y ?? 0) + visualLineIndex * lineHeight,
			});
		},
		[fontSize, lineHeight, logicalLines, onPressPosition],
	);

	const renderer = useCallback(
		// biome-ignore lint/suspicious/noExplicitAny: renderer の型は any
		({ rows, stylesheet }: { rows: any[]; stylesheet: any }): ReactNode => {
			const digits = String(rows.length).length;
			return (
				<View>
					{rows.map((row, idx) => (
						<Pressable
							// biome-ignore lint/suspicious/noArrayIndexKey: 行 index は安定
							key={idx}
							style={styles.line}
							onLayout={(event) => {
								const prev = lineLayoutsRef.current[idx];
								lineLayoutsRef.current[idx] = {
									y: event.nativeEvent.layout.y,
									textX: prev?.textX ?? 0,
									textWidth: prev?.textWidth ?? 0,
									charWidth: prev?.charWidth ?? fontSize * 0.6,
								};
							}}
							onPress={(event) => handleLinePress(idx, event)}
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
								onLayout={(event) => {
									const prev = lineLayoutsRef.current[idx];
									lineLayoutsRef.current[idx] = {
										y: prev?.y ?? 0,
										textX: event.nativeEvent.layout.x,
										textWidth: event.nativeEvent.layout.width,
										charWidth: prev?.charWidth ?? fontSize * 0.6,
									};
								}}
								onTextLayout={(event) => {
									const prev = lineLayoutsRef.current[idx];
									const measured = event.nativeEvent.lines.find(
										(line) => line.text.length > 0 && line.width > 0,
									);
									lineLayoutsRef.current[idx] = {
										y: prev?.y ?? 0,
										textX: prev?.textX ?? 0,
										textWidth: prev?.textWidth ?? 0,
										// 等幅フォント前提で、実描画から 1 文字幅だけを補正する。
										// 折り返し後の文字列長は使わず、論理行内 column だけを返す。
										charWidth: measured
											? measured.width / measured.text.length
											: (prev?.charWidth ?? fontSize * 0.6),
									};
								}}
							>
								{renderTokens(
									(row.children ?? []) as HighlightNode[],
									stylesheet as HighlightStyleSheet,
									dynamicStyles.tokenText,
								)}
							</Text>
						</Pressable>
					))}
				</View>
			);
		},
		[dim, fg, dynamicStyles, handleLinePress, fontSize],
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

function renderTokens(
	nodes: HighlightNode[],
	stylesheet: HighlightStyleSheet,
	tokenTextStyle: StyleProp<TextStyle>,
): ReactNode[] {
	return nodes.map((node, i) => {
		if (node.type === 'text') {
			// react-syntax-highlighter は各 row の末尾に '\n' を含めることがある。
			// ここでは row 境界がすでに改行を表すため、token 内に残った改行はすべて不要。
			// iOS では入れ子 Text 内の改行が行ブロック自体の高さを押し広げることがある。
			const value = node.value ?? '';
			return value.replace(/[\r\n]+/g, '');
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
				style={[tokenTextStyle, rnStyle]}
			>
				{renderTokens(node.children ?? [], stylesheet, tokenTextStyle)}
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

function buildLogicalLines(content: string): string[] {
	if (content.length === 0) return [''];

	const lines: string[] = [];
	let start = 0;
	for (let i = 0; i < content.length; i++) {
		if (content[i] !== '\n') continue;
		const end = i > start && content[i - 1] === '\r' ? i - 1 : i;
		lines.push(content.slice(start, end));
		start = i + 1;
	}
	const end =
		content.length > start && content[content.length - 1] === '\r'
			? content.length - 1
			: content.length;
	lines.push(content.slice(start, end));
	return lines;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
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
		marginVertical: 0,
		paddingVertical: 0,
	},
});
