import { memo, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Close,
  FindReplace,
  KeyboardArrowDown,
  KeyboardArrowUp,
  Search,
} from '@mui/icons-material';
import {
  alpha,
  Box,
  Button,
  GlobalStyles,
  IconButton,
  InputAdornment,
  InputBase,
  ToggleButton,
  Tooltip,
  Typography,
} from '@mui/material';
import SimpleBar from 'simplebar-react';
import 'simplebar-react/dist/simplebar.min.css';

import { extractLineAt } from '../utils/searchUtils';

import type {
  NoteMatchGroup,
  ReplaceResult,
  SearchPanelMode,
} from '../hooks/useSearchReplace';
import type { SearchMatch } from '../utils/searchUtils';

interface SearchReplacePanelProps {
  mode: SearchPanelMode;
  query: string;
  replacement: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  patternError: string | null;
  currentMatches: SearchMatch[];
  currentMatchIndex: number;
  crossNoteResults: NoteMatchGroup[];
  // 現在フォーカスされているノートの ID。カウンタのグローバル位置計算に使う。
  activeNoteId: string | null;
  focusToken: number;
  // 直近の置換実行結果。置換モードを閉じるまで表示を維持。
  replaceResult: ReplaceResult | null;
  // 検索クエリが空のとき、サイドバー絞り込み件数をバッジに表示
  sidebarMatchCount: number;
  onSetQuery: (v: string) => void;
  onSetReplacement: (v: string) => void;
  onToggleCaseSensitive: () => void;
  onToggleWholeWord: () => void;
  onToggleUseRegex: () => void;
  onSetMode: (m: SearchPanelMode) => void;
  onClear: () => void;
  onFindNext: () => void;
  onFindPrevious: () => void;
  onReplaceCurrent: () => void;
  onReplaceAllInCurrent: () => void;
  onReplaceAllInAllNotes: () => void;
  onJumpToNoteMatch: (noteId: string, indexInNote: number) => void;
  onSelectNote: (noteId: string) => Promise<void> | void;
}

const toggleReplaceMode = (mode: SearchPanelMode): SearchPanelMode =>
  mode === 'replace' ? 'find' : 'replace';

// 検索ヒットの配色。Monaco 内のデコレーションとサイドバー結果ツリーで共通。
// ライト/ダーク両方で視認しやすい濃さの黄色（＋枠線）を採用。
const HIT_BG = 'rgba(255, 213, 0, 0.28)';
const HIT_BORDER = 'rgba(214, 166, 0, 0.50)';
const HIT_CURRENT_BG = 'rgba(255, 140, 0, 0.32)';
const HIT_CURRENT_BORDER = 'rgba(230, 105, 0, 0.55)';

export const SearchReplacePanel: React.FC<SearchReplacePanelProps> = ({
  mode,
  query,
  replacement,
  caseSensitive,
  wholeWord,
  useRegex,
  patternError,
  currentMatches,
  currentMatchIndex,
  crossNoteResults,
  activeNoteId,
  focusToken,
  replaceResult,
  sidebarMatchCount,
  onSetQuery,
  onSetReplacement,
  onToggleCaseSensitive,
  onToggleWholeWord,
  onToggleUseRegex,
  onSetMode,
  onClear,
  onFindNext,
  onFindPrevious,
  onReplaceCurrent,
  onReplaceAllInCurrent,
  onReplaceAllInAllNotes,
  onJumpToNoteMatch,
  onSelectNote,
}) => {
  const { t } = useTranslation();
  const findInputRef = useRef<HTMLInputElement>(null);

  const replaceOn = mode === 'replace';

  // 外部フォーカス要求に反応
  useEffect(() => {
    if (focusToken === 0) return;
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, [focusToken]);

  const handleFindKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) onFindPrevious();
        else onFindNext();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClear();
      }
    },
    [onFindNext, onFindPrevious, onClear],
  );

  const totalAllMatches = crossNoteResults.reduce(
    (s, g) => s + g.matches.length,
    0,
  );
  // 全検索結果中のグローバル位置を算出。
  // 現ノートグループより前のヒット数 + 現ノート内のインデックス。
  let globalIndex = -1;
  if (currentMatches.length > 0 && activeNoteId) {
    let before = 0;
    for (const group of crossNoteResults) {
      if (group.noteId === activeNoteId) {
        globalIndex = before + currentMatchIndex;
        break;
      }
      before += group.matches.length;
    }
  }
  const matchBadge =
    globalIndex >= 0
      ? `${globalIndex + 1}/${totalAllMatches}`
      : totalAllMatches > 0
        ? `0/${totalAllMatches}`
        : query
          ? '0'
          : `${sidebarMatchCount}`;

  const toggleReplace = useCallback(() => {
    onSetMode(toggleReplaceMode(mode));
  }, [onSetMode, mode]);

  const hasQuery = query.length > 0;

  return (
    <Box
      sx={{
        borderBottom: 1,
        borderColor: 'divider',
        backgroundColor: 'background.paper',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Monaco デコレーションはエディタ DOM 内に描画されるため、GlobalStyles で当てる */}
      <GlobalStyles
        styles={{
          '.app-search-match': {
            backgroundColor: HIT_BG,
            border: `1px solid ${HIT_BORDER}`,
            borderRadius: '2px',
            boxSizing: 'border-box',
          },
          '.app-search-match-current': {
            backgroundColor: HIT_CURRENT_BG,
            border: `1px solid ${HIT_CURRENT_BORDER}`,
            borderRadius: '2px',
            boxSizing: 'border-box',
          },
        }}
      />

      {/* ============================================================
       * FIND セクション: 検索 input + マッチカウンタ + オプショントグル
       * ============================================================ */}
      <Box
        sx={{
          px: 1.25,
          pt: 1,
          pb: 0.75,
          display: 'flex',
          flexDirection: 'column',
          gap: 0.75,
        }}
      >
        {/* 検索 input (close ボタンのみ end adornment) */}
        <InputBase
          inputRef={findInputRef}
          value={query}
          onChange={(e) => onSetQuery(e.target.value)}
          onKeyDown={handleFindKeyDown}
          placeholder={t('search.placeholder')}
          size="small"
          sx={{
            fontSize: '0.85rem',
            border: 1,
            borderColor: patternError ? 'error.main' : 'divider',
            borderRadius: 1,
            '& .MuiInputBase-input': {
              py: 0.6,
              px: 0.5,
              fontFamily: useRegex ? 'monospace' : undefined,
              // プレースホルダは UI フォントに固定し、regex モード切替によるサイズ揺れを回避
              '&::placeholder': {
                fontFamily: (theme) => theme.typography.fontFamily,
              },
            },
          }}
          startAdornment={
            <InputAdornment position="start" sx={{ ml: 0.5, mr: 0 }}>
              <Search sx={{ fontSize: 18, color: 'text.secondary' }} />
            </InputAdornment>
          }
          endAdornment={
            hasQuery ? (
              <InputAdornment position="end" sx={{ mr: 0.25 }}>
                <IconButton size="small" onClick={onClear} sx={{ p: 0.5 }}>
                  <Close sx={{ fontSize: 16 }} />
                </IconButton>
              </InputAdornment>
            ) : null
          }
        />

        {/* マッチカウンタ + 前/次 ナビゲーション (検索クエリがある時のみ) */}
        {hasQuery && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              minHeight: 28,
            }}
          >
            <Typography
              component="span"
              sx={{
                fontSize: '0.8rem',
                fontWeight: 500,
                color: patternError ? 'error.main' : 'text.secondary',
                whiteSpace: 'nowrap',
              }}
            >
              {patternError ? t('searchReplace.invalidPattern') : matchBadge}
            </Typography>
            <Box sx={{ flexGrow: 1 }} />
            <Tooltip arrow title={t('searchReplace.previous')}>
              <span>
                <IconButton
                  size="small"
                  onClick={onFindPrevious}
                  disabled={currentMatches.length === 0}
                  sx={{ p: 0.5 }}
                >
                  <KeyboardArrowUp sx={{ fontSize: 18 }} />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip arrow title={t('searchReplace.next')}>
              <span>
                <IconButton
                  size="small"
                  onClick={onFindNext}
                  disabled={currentMatches.length === 0}
                  sx={{ p: 0.5 }}
                >
                  <KeyboardArrowDown sx={{ fontSize: 18 }} />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        )}

        {/* オプショントグル + 置換モード切替 */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            flexWrap: 'wrap',
          }}
        >
          <OptionToggle
            selected={caseSensitive}
            onChange={onToggleCaseSensitive}
            title={t('searchReplace.caseMatch')}
            label="Aa"
          />
          <OptionToggle
            selected={wholeWord}
            onChange={onToggleWholeWord}
            title={t('searchReplace.wholeWord')}
            label="ab"
          />
          <OptionToggle
            selected={useRegex}
            onChange={onToggleUseRegex}
            title={t('searchReplace.regex')}
            label=".*"
          />
          <Box sx={{ flexGrow: 1 }} />
          <OptionToggle
            selected={replaceOn}
            onChange={toggleReplace}
            title={t('searchReplace.toggleReplace')}
            label={t('searchReplace.mode.replace')}
          />
        </Box>
      </Box>

      {/* ============================================================
       * REPLACE セクション: 置換 input + 置換アクション + Undo/Redo
       * 置換モード ON のときのみ表示
       * ============================================================ */}
      {replaceOn && (
        <Box
          sx={{
            px: 1.25,
            py: 0.75,
            borderTop: 1,
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column',
            gap: 0.75,
          }}
        >
          {/* 置換 input */}
          <InputBase
            value={replacement}
            onChange={(e) => onSetReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onClear();
              }
            }}
            placeholder={t('searchReplace.replacePlaceholder')}
            size="small"
            sx={{
              fontSize: '0.85rem',
              border: 1,
              borderColor: 'divider',
              borderRadius: 1,
              '& .MuiInputBase-input': {
                py: 0.6,
                px: 0.5,
                fontFamily: useRegex ? 'monospace' : undefined,
                '&::placeholder': {
                  fontFamily: (theme) => theme.typography.fontFamily,
                },
              },
            }}
            startAdornment={
              <InputAdornment position="start" sx={{ ml: 0.5, mr: 0 }}>
                <FindReplace sx={{ fontSize: 18, color: 'text.secondary' }} />
              </InputAdornment>
            }
          />

          {/* 置換アクション行: 「置換」(現マッチ) + 「すべて置換」(現ノート全件) +
           * 「すべてのノートで置換」を 1 行に詰め込む。各ボタンはラベル長に応じた
           * 自然幅を取り、フォントはやや小さめに揃える。
           * Undo/Redo は Monaco モデルの組み込み履歴 (Ctrl+Z) に委ねるため設けない。
           * 実行前に `confirmReplaceAll*` で確認ダイアログを表示。 */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Tooltip arrow title={t('searchReplace.replaceOne')}>
              <span>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={onReplaceCurrent}
                  disabled={currentMatches.length === 0 || !!patternError}
                  sx={{
                    py: 0.25,
                    px: 0.75,
                    minWidth: 0,
                    fontSize: '0.68rem',
                    lineHeight: 1.5,
                    textTransform: 'none',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('searchReplace.replaceOne')}
                </Button>
              </span>
            </Tooltip>
            <Tooltip arrow title={t('searchReplace.replaceAllInCurrent')}>
              <span>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={onReplaceAllInCurrent}
                  disabled={currentMatches.length === 0 || !!patternError}
                  sx={{
                    py: 0.25,
                    px: 0.75,
                    minWidth: 0,
                    fontSize: '0.68rem',
                    lineHeight: 1.5,
                    textTransform: 'none',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('searchReplace.replaceAllInCurrentShort')}
                </Button>
              </span>
            </Tooltip>
            <Tooltip arrow title={t('searchReplace.replaceAllInAll')}>
              <span>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={onReplaceAllInAllNotes}
                  disabled={!!patternError || totalAllMatches === 0}
                  sx={{
                    py: 0.25,
                    px: 0.75,
                    minWidth: 0,
                    fontSize: '0.68rem',
                    lineHeight: 1.5,
                    textTransform: 'none',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('searchReplace.replaceAllInAllShort')}
                </Button>
              </span>
            </Tooltip>
          </Box>

          {/* 置換実行直後のフィードバック (4 秒で自動消去)。
           * 「すべてのノートで置換」ボタンの直下に表示。 */}
          {replaceResult && (
            <Typography
              key={replaceResult.token}
              component="div"
              sx={{
                fontSize: '0.7rem',
                color: 'success.main',
                fontWeight: 500,
                lineHeight: 1.4,
                px: 0.5,
              }}
            >
              {t(`searchReplace.feedback.${replaceResult.kind}`, {
                count: replaceResult.count,
              })}
            </Typography>
          )}
        </Box>
      )}

      {/* ============================================================
       * RESULTS セクション: 集計ヘッダ + ノート横断結果ツリー
       * ヒット 1 件以上のときのみ表示
       * 全体の背景はアイテム選択色 (薄プライマリー) で塗り、
       * 検索結果エリアであることを視覚的に区別する。
       * ============================================================ */}
      {crossNoteResults.length > 0 && (
        <Box
          sx={{
            borderTop: 1,
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            backgroundColor: (theme) => alpha(theme.palette.primary.main, 0.1),
          }}
        >
          {/* ヘッダ: 集計表示のみ
           * 全ノート一括置換ボタンは Replace セクション内に移動 */}
          <Box
            sx={{
              px: 1.25,
              py: 0.75,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <Typography
              component="span"
              sx={{
                fontSize: '0.75rem',
                fontWeight: 500,
                color: 'text.secondary',
              }}
            >
              {t('searchReplace.crossNoteSummary', {
                matchCount: totalAllMatches,
                noteCount: crossNoteResults.length,
              })}
            </Typography>
          </Box>
          <SimpleBar style={{ maxHeight: '50vh' }}>
            {crossNoteResults.map((group) => (
              <CrossNoteGroup
                key={group.noteId}
                group={group}
                onJump={async (idx) => {
                  await onSelectNote(group.noteId);
                  onJumpToNoteMatch(group.noteId, idx);
                }}
              />
            ))}
          </SimpleBar>
        </Box>
      )}
    </Box>
  );
};

// 汎用トグルボタン (オプション切替用)
const OptionToggle: React.FC<{
  selected: boolean;
  onChange: () => void;
  title: string;
  label: string;
}> = ({ selected, onChange, title, label }) => (
  <Tooltip arrow title={title}>
    <ToggleButton
      value="t"
      size="small"
      selected={selected}
      onChange={onChange}
      sx={{
        py: 0.25,
        px: 1,
        fontSize: '0.75rem',
        fontWeight: 'bold',
        minWidth: 30,
        height: 26,
        lineHeight: 1.4,
        textTransform: 'none',
        // 未選択時は MUI Button variant="outlined" color="primary" 相当
        border: 1,
        borderColor: 'primary.main',
        color: 'primary.main',
        '&:hover': {
          backgroundColor: (theme) =>
            alpha(
              theme.palette.primary.main,
              theme.palette.action.hoverOpacity,
            ),
          borderColor: 'primary.main',
        },
        // 選択時は MUI Button variant="contained" 相当（AppBar と統一）
        '&.Mui-selected': {
          backgroundColor: 'primary.main',
          color: 'primary.contrastText',
          borderColor: 'primary.main',
        },
        '&.Mui-selected:hover': {
          backgroundColor: 'primary.dark',
          borderColor: 'primary.dark',
        },
      }}
    >
      {label}
    </ToggleButton>
  </Tooltip>
);

// 結果ツリーの各ノートブロック。
// タイピング中の再レンダー連打で重くなるのを避けるため `memo` で囲み、
// `group` の reference 変化のみで再レンダー判定する (onJump の arrow は無視)。
// `crossNoteResults` は debounce 後に setState されるので、タイピング中は
// 各 group の reference 不変 → ツリー全体の再描画がスキップされる。
type CrossNoteGroupProps = {
  group: NoteMatchGroup;
  onJump: (indexInNote: number) => void;
};
const CrossNoteGroupImpl: React.FC<CrossNoteGroupProps> = ({
  group,
  onJump,
}) => {
  const { t } = useTranslation();
  return (
    <Box
      sx={{
        // サイドバーの「ローカルファイル」「ノート」見出しと同じく左右に余白を取る
        mx: 1,
        mt: 1,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          px: 1,
          py: 0.5,
          fontWeight: 'bold',
          backgroundColor: 'action.disabledBackground',
          borderBottom: 1,
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
        }}
      >
        <Typography
          component="span"
          sx={{
            fontSize: '0.75rem',
            fontWeight: 'bold',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flexGrow: 1,
            minWidth: 0,
          }}
        >
          {group.noteTitle || t('notes.emptyNote')}
        </Typography>
        <Typography
          component="span"
          sx={{
            fontSize: '0.7rem',
            color: 'text.secondary',
            flexShrink: 0,
          }}
        >
          {t('searchReplace.matchCount', { count: group.matches.length })}
        </Typography>
      </Box>
      {group.matches.map((m, idx) => {
        const { line, lineText, matchOffsetInLine } = extractLineAt(
          group.content,
          m.start,
        );
        const before = lineText.slice(0, matchOffsetInLine);
        const hit = lineText.slice(
          matchOffsetInLine,
          matchOffsetInLine + m.matchText.length,
        );
        const after = lineText.slice(matchOffsetInLine + m.matchText.length);
        return (
          <Box
            key={`${group.noteId}-${m.start}-${m.end}-${m.matchText}`}
            onClick={() => onJump(idx)}
            sx={{
              px: 1,
              py: 0.25,
              cursor: 'pointer',
              fontFamily: 'monospace',
              whiteSpace: 'pre',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              '&:hover': { backgroundColor: 'action.selected' },
            }}
          >
            <Typography
              component="span"
              sx={{
                fontSize: '0.7rem',
                color: 'text.secondary',
                mr: 1,
                fontFamily: 'monospace',
              }}
            >
              {line}:
            </Typography>
            <Typography
              component="span"
              sx={{ fontSize: '0.75rem', fontFamily: 'monospace' }}
            >
              {before}
            </Typography>
            <Typography
              component="span"
              sx={{
                fontSize: '0.75rem',
                fontFamily: 'monospace',
                backgroundColor: HIT_BG,
                border: `1px solid ${HIT_BORDER}`,
                borderRadius: '2px',
                fontWeight: 'bold',
              }}
            >
              {hit}
            </Typography>
            <Typography
              component="span"
              sx={{ fontSize: '0.75rem', fontFamily: 'monospace' }}
            >
              {after}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
};

// `group` の reference が同じなら再レンダーをスキップ。
// `onJump` は親で毎回新規 arrow が作られるが、ジャンプ先は group.noteId に
// 依存するだけで挙動が変わらないため比較対象から除外。
const CrossNoteGroup = memo(
  CrossNoteGroupImpl,
  (prev, next) => prev.group === next.group,
);
