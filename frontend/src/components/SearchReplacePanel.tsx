import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Close,
  FindReplace,
  KeyboardArrowDown,
  KeyboardArrowUp,
  Redo,
  Search,
  Undo,
} from '@mui/icons-material';
import {
  alpha,
  Box,
  Button,
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
  canUndo: boolean;
  canRedo: boolean;
  focusToken: number;
  // サイドバーの既存ノートリスト用に、絞り込み件数を右側バッジに出す
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
  onUndo: () => void;
  onRedo: () => void;
}

const toggleReplaceMode = (mode: SearchPanelMode): SearchPanelMode =>
  mode === 'replace' ? 'find' : 'replace';

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
  canUndo,
  canRedo,
  focusToken,
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
  onUndo,
  onRedo,
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
  // 現在ノートのヒット番号を主に見せ、横断ヒット総数を副次表示
  const matchBadge =
    currentMatches.length > 0
      ? `${currentMatchIndex + 1}/${currentMatches.length}`
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
        '& .app-search-match': {
          backgroundColor: 'rgba(255, 193, 7, 0.30)',
          border: '1px solid rgba(255, 193, 7, 0.45)',
          borderRadius: '2px',
          boxSizing: 'border-box',
        },
        '& .app-search-match-current': {
          backgroundColor: 'rgba(255, 112, 67, 0.45)',
          border: '1px solid rgba(255, 112, 67, 0.80)',
          borderRadius: '2px',
          boxSizing: 'border-box',
        },
      }}
    >
      {/* 検索行 */}
      <Box
        sx={{
          px: 1,
          py: 0.5,
          display: 'flex',
          alignItems: 'center',
          gap: 0.25,
        }}
      >
        <InputBase
          inputRef={findInputRef}
          value={query}
          onChange={(e) => onSetQuery(e.target.value)}
          onKeyDown={handleFindKeyDown}
          placeholder={t('search.placeholder')}
          size="small"
          sx={{
            flexGrow: 1,
            fontSize: '0.8rem',
            border: 1,
            borderColor: patternError ? 'error.main' : 'divider',
            borderRadius: 1,
            '& .MuiInputBase-input': {
              py: 0.5,
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
              <Search sx={{ fontSize: 16, color: 'text.secondary' }} />
            </InputAdornment>
          }
          endAdornment={
            hasQuery ? (
              <InputAdornment position="end" sx={{ mr: 0.25 }}>
                <Box
                  component="span"
                  sx={{
                    fontSize: '0.7rem',
                    color: patternError ? 'error.main' : 'text.secondary',
                    whiteSpace: 'nowrap',
                    minWidth: 36,
                    textAlign: 'center',
                  }}
                >
                  {patternError
                    ? t('searchReplace.invalidPattern')
                    : matchBadge}
                </Box>
                <IconButton
                  size="small"
                  onClick={onFindPrevious}
                  disabled={currentMatches.length === 0}
                  sx={{ p: 0.25 }}
                >
                  <KeyboardArrowUp sx={{ fontSize: 16 }} />
                </IconButton>
                <IconButton
                  size="small"
                  onClick={onFindNext}
                  disabled={currentMatches.length === 0}
                  sx={{ p: 0.25 }}
                >
                  <KeyboardArrowDown sx={{ fontSize: 16 }} />
                </IconButton>
                <IconButton size="small" onClick={onClear} sx={{ p: 0.25 }}>
                  <Close sx={{ fontSize: 14 }} />
                </IconButton>
              </InputAdornment>
            ) : null
          }
        />
      </Box>

      {/* オプショントグル行 */}
      <Box
        sx={{
          px: 1,
          pb: 0.5,
          display: 'flex',
          alignItems: 'center',
          gap: 0.25,
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
        <Tooltip arrow title={t('searchReplace.undo')}>
          <span>
            <IconButton
              size="small"
              onClick={onUndo}
              disabled={!canUndo}
              sx={{ p: 0.25 }}
            >
              <Undo sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip arrow title={t('searchReplace.redo')}>
          <span>
            <IconButton
              size="small"
              onClick={onRedo}
              disabled={!canRedo}
              sx={{ p: 0.25 }}
            >
              <Redo sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      {/* 置換行 */}
      {replaceOn && (
        <Box
          sx={{
            px: 1,
            pb: 0.5,
            display: 'flex',
            alignItems: 'center',
            gap: 0.25,
          }}
        >
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
              flexGrow: 1,
              fontSize: '0.8rem',
              border: 1,
              borderColor: 'divider',
              borderRadius: 1,
              '& .MuiInputBase-input': {
                py: 0.5,
                px: 0.5,
                fontFamily: useRegex ? 'monospace' : undefined,
                '&::placeholder': {
                  fontFamily: (theme) => theme.typography.fontFamily,
                },
              },
            }}
          />
          <Tooltip arrow title={t('searchReplace.replaceOne')}>
            <span>
              <IconButton
                size="small"
                onClick={onReplaceCurrent}
                disabled={currentMatches.length === 0 || !!patternError}
                sx={{ p: 0.25 }}
              >
                <FindReplace sx={{ fontSize: 16 }} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip arrow title={t('searchReplace.replaceAllInCurrent')}>
            <span>
              <IconButton
                size="small"
                onClick={onReplaceAllInCurrent}
                disabled={currentMatches.length === 0 || !!patternError}
                sx={{ p: 0.25, px: 0.5 }}
              >
                <Typography
                  component="span"
                  sx={{ fontSize: '0.7rem', fontWeight: 'bold' }}
                >
                  {t('searchReplace.all')}
                </Typography>
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      )}

      {/* ノート横断結果ツリー（常時表示、SimpleBar でスタイル統一） */}
      {crossNoteResults.length > 0 && (
        <Box
          sx={{
            borderTop: 1,
            borderColor: 'divider',
            fontSize: '0.75rem',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          {replaceOn && crossNoteResults.length > 0 && (
            <Box
              sx={{
                px: 1,
                py: 0.5,
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                borderBottom: 1,
                borderColor: 'divider',
                backgroundColor: 'action.hover',
              }}
            >
              <Typography
                component="span"
                sx={{ fontSize: '0.7rem', color: 'text.secondary' }}
              >
                {t('searchReplace.crossNoteSummary', {
                  matchCount: totalAllMatches,
                  noteCount: crossNoteResults.length,
                })}
              </Typography>
              <Box sx={{ flexGrow: 1 }} />
              <Tooltip arrow title={t('searchReplace.replaceAllInAll')}>
                <span>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={onReplaceAllInAllNotes}
                    disabled={!!patternError}
                    sx={{
                      py: 0,
                      px: 0.75,
                      minWidth: 0,
                      fontSize: '0.7rem',
                      lineHeight: 1.6,
                      textTransform: 'none',
                    }}
                  >
                    {t('searchReplace.replaceAllInAllShort')}
                  </Button>
                </span>
              </Tooltip>
            </Box>
          )}
          <SimpleBar style={{ maxHeight: 240 }}>
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

// 汎用小さなトグルボタン
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
        py: 0,
        px: 0.75,
        fontSize: '0.7rem',
        fontWeight: 'bold',
        minWidth: 24,
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

// 結果ツリーの各ノートブロック
const CrossNoteGroup: React.FC<{
  group: NoteMatchGroup;
  onJump: (indexInNote: number) => void;
}> = ({ group, onJump }) => {
  const { t } = useTranslation();
  return (
    <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
      <Box
        sx={{
          px: 1,
          py: 0.5,
          fontWeight: 'bold',
          backgroundColor: 'action.hover',
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
                backgroundColor: 'rgba(255, 193, 7, 0.30)',
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
