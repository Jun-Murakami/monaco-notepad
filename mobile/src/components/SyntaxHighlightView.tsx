import type { ThemedToken } from '@shikijs/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	type GestureResponderEvent,
	Platform,
	Pressable,
	StyleSheet,
	Text,
	View,
} from 'react-native';
import { useTheme } from 'react-native-paper';
import {
	ensureLanguage,
	getHighlighter,
	SHIKI_THEME_DARK,
	SHIKI_THEME_LIGHT,
} from '@/lib/syntaxHighlight/highlighter';
import { toShikiLanguage } from '@/lib/syntaxHighlight/languageMap';

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

interface LogicalLineLayout {
	y: number;
	textX: number;
	textWidth: number;
	charWidth: number;
}

// Shiki の FontStyle bitmask（@shikijs/vscode-textmate より）。
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;
const FONT_STYLE_STRIKETHROUGH = 8;

/**
 * 閲覧モード専用のシンタックスハイライト。
 *
 * ハイライト本体は Shiki (TextMate grammar + dark-plus/light-plus テーマ) を使い、
 * VSCode/Monaco と同等の色付けを得る。Native engine の初期化と grammar の
 * ロードは非同期なので、初回は素のテキストで描画してロード完了後に再描画する。
 *
 * 左に行番号カラム、右に本文カラムの 2 カラム構成。本文が wrap した時は
 * 行番号を先頭行のみ表示して、続きは本文カラムでインデントされたまま継続する
 * （Monaco の gutter + wrap と同じ体験）。
 */
export function SyntaxHighlightView({
	content,
	language,
	fontSize = 13,
	onPressPosition,
}: Props) {
	const theme = useTheme();
	const dim = theme.colors.outline;
	const fg = theme.colors.onSurface;
	const lineLayoutsRef = useRef<Record<number, LogicalLineLayout>>({});
	const logicalLines = useMemo(() => buildLogicalLines(content), [content]);
	const tokens = useShikiTokens(content, language, theme.dark);

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

	const digits = String(Math.max(1, logicalLines.length)).length;

	// tokens が未ロード or 取得失敗時は素のテキストで描画。
	// 行配列の長さと logicalLines の長さは一致させる。tokens 側が短ければ
	// 余り行は素のテキストでフォールバック。
	const rows: ThemedToken[][] = useMemo(() => {
		if (tokens && tokens.length > 0) {
			return logicalLines.map(
				(line, idx): ThemedToken[] =>
					tokens[idx] ?? [{ content: line, color: undefined, offset: 0 }],
			);
		}
		return logicalLines.map((line): ThemedToken[] => [
			{ content: line, color: undefined, offset: 0 },
		]);
	}, [tokens, logicalLines]);

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
						{row.length === 0 ? (
							// 空行は ' ' を入れないと Pressable のヒット領域がゼロになる。
							<Text style={dynamicStyles.tokenText}> </Text>
						) : (
							row.map((token, ti) => (
								<Text
									// biome-ignore lint/suspicious/noArrayIndexKey: token 順は安定
									key={ti}
									style={[dynamicStyles.tokenText, tokenStyle(token, fg)]}
								>
									{stripNewlines(token.content)}
								</Text>
							))
						)}
					</Text>
				</Pressable>
			))}
		</View>
	);
}

/**
 * Shiki で content をトークナイズする hook。
 *
 * 言語ロード中・失敗時は null を返す（呼び出し側はプレーンテキストで描画）。
 * 入力が変わるたびに最新の結果だけを反映するよう ref で世代管理する。
 */
function useShikiTokens(
	content: string,
	monacoLanguage: string,
	isDark: boolean,
): ThemedToken[][] | null {
	const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
	const generationRef = useRef(0);

	useEffect(() => {
		const generation = ++generationRef.current;
		const shikiLang = toShikiLanguage(monacoLanguage);
		const themeName = isDark ? SHIKI_THEME_DARK : SHIKI_THEME_LIGHT;

		(async () => {
			try {
				const highlighter = await getHighlighter();
				await ensureLanguage(shikiLang);
				if (generation !== generationRef.current) return;
				const result = highlighter.codeToTokensBase(content, {
					lang: shikiLang,
					theme: themeName,
				});
				if (generation !== generationRef.current) return;
				setTokens(result);
			} catch {
				// Native engine 不在 等。プレーンテキスト表示に倒す。
				if (generation !== generationRef.current) return;
				setTokens(null);
			}
		})();
	}, [content, monacoLanguage, isDark]);

	return tokens;
}

function tokenStyle(token: ThemedToken, fallbackColor: string) {
	const fs = token.fontStyle ?? 0;
	const decorations: ('underline' | 'line-through')[] = [];
	if (fs & FONT_STYLE_UNDERLINE) decorations.push('underline');
	if (fs & FONT_STYLE_STRIKETHROUGH) decorations.push('line-through');
	return {
		color: token.color ?? fallbackColor,
		fontStyle:
			fs & FONT_STYLE_ITALIC ? ('italic' as const) : ('normal' as const),
		fontWeight: fs & FONT_STYLE_BOLD ? ('700' as const) : undefined,
		textDecorationLine:
			decorations.length === 0
				? undefined
				: (decorations.join(' ') as
						| 'underline'
						| 'line-through'
						| 'underline line-through'),
	};
}

/**
 * Shiki の token.content には行末 '\n' が含まれることがある。
 * row 境界が既に改行を表すため、token 内に残る改行は不要。
 * iOS では入れ子 Text 内の改行が行ブロックの高さを押し広げてしまう。
 */
function stripNewlines(value: string): string {
	return value.replace(/[\r\n]+/g, '');
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
