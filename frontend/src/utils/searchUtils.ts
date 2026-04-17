// 検索・置換のための純粋ヘルパ群。
// Monaco 非依存。ネイティブ RegExp のみ使用。

export interface SearchOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
}

export interface SearchMatch {
  start: number; // 対象文字列内の開始オフセット（UTF-16 コードユニット基準）
  end: number; // 終了オフセット（exclusive）
  matchText: string; // ヒット本文
  groups: string[]; // キャプチャグループ（[0] は全体一致）
}

// 正規表現メタ文字を安全化
const escapeRegExp = (src: string): string =>
  src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// オプションから RegExp を生成。失敗時は null を返す。
export const compileSearchRegex = (options: SearchOptions): RegExp | null => {
  const { query, caseSensitive, wholeWord, useRegex } = options;
  if (!query) return null;

  let source = useRegex ? query : escapeRegExp(query);
  if (wholeWord) {
    source = `\\b(?:${source})\\b`;
  }

  const flags = `g${caseSensitive ? '' : 'i'}`;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
};

// パターンの妥当性のみ判定（UI のエラー表示用）
export const isValidSearchPattern = (options: SearchOptions): boolean => {
  if (!options.query) return true; // 空クエリはエラーではない
  return compileSearchRegex(options) !== null;
};

// 対象テキスト内の全ヒットを列挙。
// 0長マッチ（例: `^`, `(?=...)`）の無限ループを防ぐため lastIndex を強制前進。
export const findAllMatches = (
  text: string,
  options: SearchOptions,
  limit = 10000,
): SearchMatch[] => {
  const re = compileSearchRegex(options);
  if (!re) return [];

  const result: SearchMatch[] = [];
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    const start = m.index;
    const end = start + m[0].length;
    result.push({
      start,
      end,
      matchText: m[0],
      groups: m.slice(0) as string[],
    });
    if (result.length >= limit) break;
    if (m[0].length === 0) {
      re.lastIndex += 1;
    }
    m = re.exec(text);
  }
  return result;
};

// 後方参照 ($1, $2, $&, $$) を解決して置換文字列を生成。
// ネイティブ String.replace と整合的。
export const expandReplacement = (
  match: SearchMatch,
  template: string,
): string => {
  return template.replace(/\$(\$|&|\d{1,2})/g, (_, token: string) => {
    if (token === '$') return '$';
    if (token === '&') return match.groups[0] ?? '';
    const idx = Number.parseInt(token, 10);
    if (Number.isNaN(idx)) return _;
    return match.groups[idx] ?? '';
  });
};

// 指定範囲内のヒットだけに絞り込む（選択範囲内検索用）
export const filterMatchesInRange = (
  matches: SearchMatch[],
  rangeStart: number,
  rangeEnd: number,
): SearchMatch[] => {
  return matches.filter((m) => m.start >= rangeStart && m.end <= rangeEnd);
};

// オフセットを (行, 列) に変換（1-based、Monaco と同じ方式）
export const offsetToLineColumn = (
  text: string,
  offset: number,
): { line: number; column: number } => {
  let line = 1;
  let column = 1;
  const limit = Math.min(offset, text.length);
  for (let i = 0; i < limit; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
};

// 該当オフセットを含む行全体を抽出（検索結果プレビュー用）
export const extractLineAt = (
  text: string,
  offset: number,
): {
  line: number;
  column: number;
  lineText: string;
  matchOffsetInLine: number;
} => {
  const { line, column } = offsetToLineColumn(text, offset);
  let lineStart = offset;
  while (lineStart > 0 && text.charCodeAt(lineStart - 1) !== 10) {
    lineStart -= 1;
  }
  let lineEnd = offset;
  while (lineEnd < text.length && text.charCodeAt(lineEnd) !== 10) {
    lineEnd += 1;
  }
  return {
    line,
    column,
    lineText: text.slice(lineStart, lineEnd),
    matchOffsetInLine: offset - lineStart,
  };
};

// 置換プランを編集リストに展開。
// 左から右へ適用していくときにオフセットがずれないよう、
// 呼び出し側は逆順で適用する（後ろから）前提。
export interface PlannedEdit {
  start: number;
  end: number;
  original: string;
  replacement: string;
}

export const buildReplacementEdits = (
  matches: SearchMatch[],
  replacementTemplate: string,
  useRegex: boolean,
): PlannedEdit[] => {
  return matches.map((m) => ({
    start: m.start,
    end: m.end,
    original: m.matchText,
    replacement: useRegex
      ? expandReplacement(m, replacementTemplate)
      : replacementTemplate,
  }));
};

// 編集リストを適用した後の文字列を生成（副作用なし）。
// edits は互いに重ならない前提。start の昇順にソートしてから適用。
export const applyEditsToString = (
  text: string,
  edits: PlannedEdit[],
): string => {
  if (edits.length === 0) return text;
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let cursor = 0;
  for (const e of sorted) {
    if (e.start < cursor) {
      // 重複がある場合はスキップ（呼び出し側のバグ）
      continue;
    }
    parts.push(text.slice(cursor, e.start));
    parts.push(e.replacement);
    cursor = e.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
};
