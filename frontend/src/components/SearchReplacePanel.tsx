import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Close,
  FindReplace,
  KeyboardArrowDown,
  KeyboardArrowUp,
  Redo,
  Undo,
} from '@mui/icons-material';
import {
  Box,
  Collapse,
  IconButton,
  InputBase,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';

import { extractLineAt } from '../utils/searchUtils';

import type {
  NoteMatchGroup,
  SearchPanelMode,
} from '../hooks/useSearchReplace';
import type { SearchMatch } from '../utils/searchUtils';

interface SearchReplacePanelProps {
  isOpen: boolean;
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
  onSetQuery: (v: string) => void;
  onSetReplacement: (v: string) => void;
  onToggleCaseSensitive: () => void;
  onToggleWholeWord: () => void;
  onToggleUseRegex: () => void;
  onSetMode: (m: SearchPanelMode) => void;
  onClose: () => void;
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

export const SearchReplacePanel: React.FC<SearchReplacePanelProps> = ({
  isOpen,
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
  onSetQuery,
  onSetReplacement,
  onToggleCaseSensitive,
  onToggleWholeWord,
  onToggleUseRegex,
  onSetMode,
  onClose,
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

  const showReplace = mode === 'replace' || mode === 'replaceInAll';
  const isAll = mode === 'findInAll' || mode === 'replaceInAll';

  useEffect(() => {
    if (isOpen) {
      // 次のフレームで確実にフォーカス
      requestAnimationFrame(() => {
        findInputRef.current?.focus();
        findInputRef.current?.select();
      });
    }
  }, [isOpen]);

  const handleFindKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) onFindPrevious();
        else onFindNext();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [onFindNext, onFindPrevious, onClose],
  );

  const totalMatchCount = isAll
    ? crossNoteResults.reduce((s, g) => s + g.matches.length, 0)
    : currentMatches.length;
  const matchBadge = isAll
    ? `${totalMatchCount} in ${crossNoteResults.length}`
    : totalMatchCount > 0
      ? `${currentMatchIndex + 1}/${totalMatchCount}`
      : '0/0';

  const handleModeChange = useCallback(
    (_: unknown, value: SearchPanelMode | null) => {
      if (!value) return;
      onSetMode(value);
    },
    [onSetMode],
  );

  return (
    <Collapse in={isOpen} mountOnEnter unmountOnExit>
      <Box
        sx={{
          borderBottom: 1,
          borderColor: 'divider',
          backgroundColor: 'background.paper',
          p: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 0.5,
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
        // エディタ操作中にフォーカスが奪われないよう、パネル自体はマウスダウンで focus を保持
        onMouseDown={(e) => {
          // 入力系以外ではフォーカス奪取を抑止
          if (
            !(e.target instanceof HTMLInputElement) &&
            !(e.target instanceof HTMLButtonElement)
          ) {
            e.preventDefault();
          }
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={mode}
            onChange={handleModeChange}
            sx={{
              '& .MuiToggleButton-root': { py: 0, px: 1, fontSize: '0.72rem' },
            }}
          >
            <ToggleButton value="find">
              {t('searchReplace.mode.find')}
            </ToggleButton>
            <ToggleButton value="replace">
              {t('searchReplace.mode.replace')}
            </ToggleButton>
            <ToggleButton value="findInAll">
              {t('searchReplace.mode.findInAll')}
            </ToggleButton>
            <ToggleButton value="replaceInAll">
              {t('searchReplace.mode.replaceInAll')}
            </ToggleButton>
          </ToggleButtonGroup>

          <Box sx={{ flexGrow: 1 }} />

          <Tooltip title={t('searchReplace.undo')}>
            <span>
              <IconButton
                size="small"
                onClick={onUndo}
                disabled={!canUndo}
                sx={{ p: 0.25 }}
              >
                <Undo sx={{ fontSize: 18 }} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t('searchReplace.redo')}>
            <span>
              <IconButton
                size="small"
                onClick={onRedo}
                disabled={!canRedo}
                sx={{ p: 0.25 }}
              >
                <Redo sx={{ fontSize: 18 }} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t('dialog.close')}>
            <IconButton size="small" onClick={onClose} sx={{ p: 0.25 }}>
              <Close sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <InputBase
            inputRef={findInputRef}
            value={query}
            onChange={(e) => onSetQuery(e.target.value)}
            onKeyDown={handleFindKeyDown}
            placeholder={t('searchReplace.findPlaceholder')}
            size="small"
            sx={{
              flexGrow: 1,
              fontSize: '0.8rem',
              border: 1,
              borderColor: patternError ? 'error.main' : 'divider',
              borderRadius: 1,
              px: 0.5,
              py: 0.25,
              fontFamily: 'monospace',
            }}
          />
          <ToggleButton
            value="case"
            size="small"
            selected={caseSensitive}
            onChange={onToggleCaseSensitive}
            sx={{
              py: 0,
              px: 0.75,
              fontSize: '0.7rem',
              fontWeight: 'bold',
              minWidth: 28,
            }}
            title={t('searchReplace.caseMatch')}
          >
            Aa
          </ToggleButton>
          <ToggleButton
            value="word"
            size="small"
            selected={wholeWord}
            onChange={onToggleWholeWord}
            sx={{
              py: 0,
              px: 0.75,
              fontSize: '0.7rem',
              fontWeight: 'bold',
              minWidth: 28,
            }}
            title={t('searchReplace.wholeWord')}
          >
            ab
          </ToggleButton>
          <ToggleButton
            value="regex"
            size="small"
            selected={useRegex}
            onChange={onToggleUseRegex}
            sx={{
              py: 0,
              px: 0.75,
              fontSize: '0.7rem',
              fontWeight: 'bold',
              minWidth: 28,
            }}
            title={t('searchReplace.regex')}
          >
            .*
          </ToggleButton>

          <Box
            component="span"
            sx={{
              fontSize: '0.7rem',
              color: patternError ? 'error.main' : 'text.secondary',
              whiteSpace: 'nowrap',
              minWidth: 60,
              textAlign: 'center',
              px: 0.5,
            }}
          >
            {patternError ? t('searchReplace.invalidPattern') : matchBadge}
          </Box>

          {!isAll && (
            <>
              <Tooltip title={t('searchReplace.previous')}>
                <span>
                  <IconButton
                    size="small"
                    onClick={onFindPrevious}
                    disabled={currentMatches.length === 0}
                    sx={{ p: 0.25 }}
                  >
                    <KeyboardArrowUp sx={{ fontSize: 18 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title={t('searchReplace.next')}>
                <span>
                  <IconButton
                    size="small"
                    onClick={onFindNext}
                    disabled={currentMatches.length === 0}
                    sx={{ p: 0.25 }}
                  >
                    <KeyboardArrowDown sx={{ fontSize: 18 }} />
                  </IconButton>
                </span>
              </Tooltip>
            </>
          )}
        </Box>

        {showReplace && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <InputBase
              value={replacement}
              onChange={(e) => onSetReplacement(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  onClose();
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
                px: 0.5,
                py: 0.25,
                fontFamily: 'monospace',
              }}
            />
            {mode === 'replace' && (
              <>
                <Tooltip title={t('searchReplace.replaceOne')}>
                  <span>
                    <IconButton
                      size="small"
                      onClick={onReplaceCurrent}
                      disabled={currentMatches.length === 0 || !!patternError}
                      sx={{ p: 0.25 }}
                    >
                      <FindReplace sx={{ fontSize: 18 }} />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title={t('searchReplace.replaceAllInCurrent')}>
                  <span>
                    <IconButton
                      size="small"
                      onClick={onReplaceAllInCurrent}
                      disabled={currentMatches.length === 0 || !!patternError}
                      sx={{
                        p: 0.25,
                        fontSize: '0.7rem',
                        fontWeight: 'bold',
                      }}
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
              </>
            )}
            {mode === 'replaceInAll' && (
              <Tooltip title={t('searchReplace.replaceAllInAll')}>
                <span>
                  <IconButton
                    size="small"
                    onClick={onReplaceAllInAllNotes}
                    disabled={crossNoteResults.length === 0 || !!patternError}
                    sx={{ p: 0.25 }}
                  >
                    <Typography
                      component="span"
                      sx={{ fontSize: '0.7rem', fontWeight: 'bold' }}
                    >
                      {t('searchReplace.replaceAllInAll')}
                    </Typography>
                  </IconButton>
                </span>
              </Tooltip>
            )}
          </Box>
        )}

        {isAll && crossNoteResults.length > 0 && (
          <Box
            sx={{
              maxHeight: 260,
              overflowY: 'auto',
              border: 1,
              borderColor: 'divider',
              borderRadius: 1,
              mt: 0.5,
              fontSize: '0.75rem',
            }}
          >
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
          </Box>
        )}
      </Box>
    </Collapse>
  );
};

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
          sx={{ fontSize: '0.75rem', fontWeight: 'bold' }}
        >
          {group.noteTitle || t('notes.emptyNote')}
        </Typography>
        <Typography
          component="span"
          sx={{ fontSize: '0.7rem', color: 'text.secondary' }}
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
