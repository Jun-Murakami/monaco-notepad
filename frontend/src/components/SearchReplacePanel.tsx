import { forwardRef, memo, useCallback, useEffect, useRef } from 'react';
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
  Autocomplete,
  Box,
  Button,
  FormControl,
  GlobalStyles,
  IconButton,
  InputAdornment,
  InputBase,
  ListItemButton,
  MenuItem,
  Select,
  ToggleButton,
  Tooltip,
  Typography,
} from '@mui/material';
import SimpleBar from 'simplebar-react';
import 'simplebar-react/dist/simplebar.min.css';

import { useCurrentNoteId } from '../stores/useCurrentNoteStore';
import { useSearchHistoryStore } from '../stores/useSearchHistoryStore';
import {
  type NoteMatchGroup,
  type SearchPanelMode,
  type SearchScope,
  usePatternError,
  useSearchReplaceStore,
} from '../stores/useSearchReplaceStore';
import { extractLineAt } from '../utils/searchUtils';

interface SearchReplacePanelProps {
  // サイドバー絞り込み件数（検索クエリが空のときバッジに表示）。
  // useNoteSearch の出力を直接渡す。
  sidebarMatchCount: number;
}

const toggleReplaceMode = (mode: SearchPanelMode): SearchPanelMode =>
  mode === 'replace' ? 'find' : 'replace';

// 検索ヒットの配色。Monaco 内のデコレーションとサイドバー結果ツリーで共通。
// 通常マッチは控えめな黄色、現在マッチは濃い黄色。いずれも境界線なし。
const HIT_BG = 'rgba(255, 213, 0, 0.3)';
const HIT_CURRENT_BG = 'rgba(255, 213, 0, 0.45)';

export const SearchReplacePanel: React.FC<SearchReplacePanelProps> = ({
  sidebarMatchCount,
}) => {
  const { t } = useTranslation();
  const findInputRef = useRef<HTMLInputElement>(null);

  // 状態はすべてストアから個別購読する（粒度を細かく取り、不要な再描画を抑える）
  const mode = useSearchReplaceStore((s) => s.mode);
  const query = useSearchReplaceStore((s) => s.query);
  const replacement = useSearchReplaceStore((s) => s.replacement);
  const caseSensitive = useSearchReplaceStore((s) => s.caseSensitive);
  const wholeWord = useSearchReplaceStore((s) => s.wholeWord);
  const useRegex = useSearchReplaceStore((s) => s.useRegex);
  const scope = useSearchReplaceStore((s) => s.scope);
  const patternError = usePatternError();
  const currentMatches = useSearchReplaceStore((s) => s.currentMatches);
  const currentMatchIndex = useSearchReplaceStore((s) => s.currentMatchIndex);
  const crossNoteResults = useSearchReplaceStore((s) => s.crossNoteResults);
  const focusToken = useSearchReplaceStore((s) => s.focusToken);
  const replaceResult = useSearchReplaceStore((s) => s.replaceResult);
  // activeNoteId はノート切替時の「現在ノート位置」表示に使う。
  // 非スプリットの簡易判定として currentNote の id をそのまま使う。
  const activeNoteId = useCurrentNoteId();

  // アクションも直接ストアから取得（参照は不変）。
  const onSetQuery = useSearchReplaceStore((s) => s.setQuery);
  const onSetReplacement = useSearchReplaceStore((s) => s.setReplacement);
  const onToggleCaseSensitive = () =>
    useSearchReplaceStore.getState().setCaseSensitive(!caseSensitive);
  const onToggleWholeWord = () =>
    useSearchReplaceStore.getState().setWholeWord(!wholeWord);
  const onToggleUseRegex = () =>
    useSearchReplaceStore.getState().setUseRegex(!useRegex);
  const onSetScope = useSearchReplaceStore((s) => s.setScope);
  const onSetMode = useSearchReplaceStore((s) => s.setMode);
  const onClear = useSearchReplaceStore((s) => s.clearQuery);
  const onFindNext = useSearchReplaceStore((s) => s.findNext);
  const onFindPrevious = useSearchReplaceStore((s) => s.findPrevious);
  const onReplaceCurrent = useSearchReplaceStore((s) => s.replaceCurrent);
  const onReplaceAllInCurrent = useSearchReplaceStore(
    (s) => s.replaceAllInCurrent,
  );
  const onReplaceAllInAllNotes = useSearchReplaceStore(
    (s) => s.replaceAllInAllNotes,
  );
  const onJumpToNoteMatch = useSearchReplaceStore((s) => s.jumpToNoteMatch);
  // クロスノート結果からの選択は、App.tsx 側で setContext({ onSelectNote }) されたものを使う
  const onSelectNote = (noteId: string) =>
    useSearchReplaceStore.getState().context.onSelectNote(noteId);

  // 検索履歴（最大50件、新しい順、ホバーで X を出して個別削除）
  const searchHistory = useSearchHistoryStore((s) => s.history);
  const addSearchHistory = useSearchHistoryStore((s) => s.add);
  const removeSearchHistory = useSearchHistoryStore((s) => s.remove);

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
        // 検索を実行したクエリのみ履歴に積む（無効パターンは積まない）
        if (query.trim() && !patternError) addSearchHistory(query);
        if (e.shiftKey) onFindPrevious();
        else onFindNext();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClear();
      }
    },
    [onFindNext, onFindPrevious, onClear, query, patternError, addSearchHistory],
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
  // インデックス表示のフォールバック順:
  // 1) クロスノート結果に現ノートが含まれる → グローバル位置
  // 2) 現ノートに matches がある（クロスノートに未反映 or スコープ外） → ローカル位置
  // 3) クロスノート結果あり / 現ノート 0 件 → 0/全件
  // 4) クエリあり、結果なし → 0
  // 5) クエリ無し → サイドバー件数
  const matchBadge =
    globalIndex >= 0
      ? `${globalIndex + 1}/${totalAllMatches}`
      : currentMatches.length > 0
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
      }}
    >
      {/* Monaco デコレーションはエディタ DOM 内に描画されるため、GlobalStyles で当てる。
       * 現在マッチの境界線はテーマの primary カラーを動的に参照する。 */}
      <GlobalStyles
        styles={{
          '.app-search-match': {
            backgroundColor: HIT_BG,
            borderRadius: '2px',
            boxSizing: 'border-box',
          },
          '.app-search-match-current': {
            backgroundColor: HIT_CURRENT_BG,
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
        {/* 検索 input + 履歴オートコンプリート。
         * - freeSolo: 候補にない文字列も自由に入力可
         * - openOnFocus: フォーカス時に履歴を表示
         * - 候補ホバーで X が出現し個別削除可能（履歴はストアで永続管理） */}
        <Autocomplete
          freeSolo
          disableClearable
          openOnFocus
          autoHighlight={false}
          options={searchHistory}
          inputValue={query}
          onInputChange={(_e, value) => {
            // 入力・履歴選択ともに query を反映
            if (value !== query) onSetQuery(value);
          }}
          onChange={(_e, value, reason) => {
            // 履歴をクリックして選択 → 先頭に詰め直し + 検索実行
            // Enter での確定 (createOption) は handleFindKeyDown 側で処理
            if (reason === 'selectOption' && typeof value === 'string') {
              addSearchHistory(value);
              onFindNext();
            }
          }}
          filterOptions={(opts, state) => {
            const q = state.inputValue.trim().toLowerCase();
            if (!q) return opts;
            return opts.filter((o) => o.toLowerCase().includes(q));
          }}
          size="small"
          fullWidth
          sx={{ width: '100%' }}
          slots={{
            // 履歴は SimpleBar でラップしてアプリ全体と同じスクロールバー意匠に揃える
            listbox: HistoryListbox,
          }}
          slotProps={{
            paper: {
              sx: { fontSize: '0.85rem' },
            },
            listbox: {
              sx: { py: 0 },
            },
          }}
          renderInput={(params) => (
            <InputBase
              ref={params.slotProps.input.ref}
              inputRef={findInputRef}
              inputProps={params.slotProps.htmlInput}
              onKeyDown={handleFindKeyDown}
              placeholder={t('search.placeholder')}
              fullWidth
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
                // VSCode 風に Aa / ab / .* のトグルを input 内右側に配置。
                // クエリがあるときのみ X (clear) も並ぶ。
                <InputAdornment
                  position="end"
                  sx={{ mr: 0.25, gap: 0.25, height: 'auto' }}
                >
                  <InlineOptionToggle
                    selected={caseSensitive}
                    onChange={onToggleCaseSensitive}
                    title={t('searchReplace.caseMatch')}
                    label="Aa"
                  />
                  <InlineOptionToggle
                    selected={wholeWord}
                    onChange={onToggleWholeWord}
                    title={t('searchReplace.wholeWord')}
                    label="ab"
                  />
                  <InlineOptionToggle
                    selected={useRegex}
                    onChange={onToggleUseRegex}
                    title={t('searchReplace.regex')}
                    label=".*"
                  />
                  {hasQuery && (
                    <IconButton
                      size="small"
                      onClick={onClear}
                      sx={{ p: 0.25, ml: 0.25 }}
                    >
                      <Close sx={{ fontSize: 16 }} />
                    </IconButton>
                  )}
                </InputAdornment>
              }
            />
          )}
          renderOption={(props, option) => {
            // React 19+: key は spread から外して明示的に渡す必要がある
            const { key, ...rest } = props as React.HTMLAttributes<HTMLLIElement> & {
              key?: React.Key;
            };
            // ListItemButton はコンテキスト要件なしで hover / focus / selected の
            // 背景色やカーソルがテーマから自動適用される (MenuItem は MenuList 内必須)。
            // Autocomplete が要求する `<li role="option">` のセマンティクスを保つため
            // component="li" で li にレンダリングする。
            return (
              <ListItemButton
                component="li"
                key={key ?? option}
                {...rest}
                disableRipple
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  fontSize: '0.85rem',
                  py: 0.5,
                  // ホバー時に削除ボタンをフェードイン
                  '&:hover .search-history-delete': { opacity: 1 },
                }}
              >
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontFamily: useRegex ? 'monospace' : undefined,
                  }}
                >
                  {option}
                </Box>
                <IconButton
                  className="search-history-delete"
                  size="small"
                  // mousedown を抑止することで input が blur せず popper が閉じない
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeSearchHistory(option);
                  }}
                  sx={{
                    opacity: 0,
                    transition: 'opacity 100ms ease',
                    p: 0.25,
                    flexShrink: 0,
                    ml: 'auto',
                  }}
                >
                  <Close sx={{ fontSize: 14 }} />
                </IconButton>
              </ListItemButton>
            );
          }}
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
                  disabled={
                    currentMatches.length === 0 && totalAllMatches === 0
                  }
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
                  disabled={
                    currentMatches.length === 0 && totalAllMatches === 0
                  }
                  sx={{ p: 0.5 }}
                >
                  <KeyboardArrowDown sx={{ fontSize: 18 }} />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        )}

        {/* 検索対象スコープ Select + 置換モード切替。
         * トグル群 (Aa/ab/.*) は入力欄内の endAdornment に移動済み。 */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
          }}
        >
          <FormControl size="small" sx={{ flex: 1, minWidth: 0 }}>
            <Select
              value={scope}
              onChange={(e) => onSetScope(e.target.value as SearchScope)}
              displayEmpty
              sx={{
                fontSize: '0.75rem',
                '& .MuiSelect-select': {
                  py: 0.5,
                  pl: 1,
                },
              }}
            >
              <MenuItem value="all" sx={{ fontSize: '0.8rem' }}>
                {t('searchReplace.scope.all')}
              </MenuItem>
              <MenuItem value="local" sx={{ fontSize: '0.8rem' }}>
                {t('searchReplace.scope.local')}
              </MenuItem>
              <MenuItem value="notes" sx={{ fontSize: '0.8rem' }}>
                {t('searchReplace.scope.notes')}
              </MenuItem>
            </Select>
          </FormControl>
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
       * クエリありかつパターンエラー無しの時に表示する。
       * ヒット 0 件のときは「検索結果はありません」メッセージを出す。
       * ============================================================ */}
      {hasQuery && !patternError && (
        <Box
          sx={{
            borderTop: 1,
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            pb: 1,
            backgroundColor: (theme) => alpha(theme.palette.primary.main, 0.05),
          }}
        >
          {crossNoteResults.length > 0 ? (
            <>
              {/* ヘッダ: 集計表示 */}
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
            </>
          ) : (
            <Box
              sx={{
                px: 1.25,
                py: 1.25,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Typography
                component="span"
                sx={{
                  fontSize: '0.8rem',
                  color: 'text.secondary',
                }}
              >
                {t('searchReplace.noResults')}
              </Typography>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};

// 検索履歴ドロップダウン用 listbox。
// SimpleBar 経由でスクロールバーをアプリ全体（サイドバー等）と同じ意匠に揃える。
// MUI Autocomplete のデフォルト listbox は `<ul>` で overflow:auto なので、
// 中の `<ul>` は overflow:visible にして外側 SimpleBar に高さ制限とスクロールを任せる。
// スクロールバーが各行の削除ボタン (X) と被らないよう右側 padding も付ける。
const HistoryListbox = forwardRef<
  HTMLUListElement,
  React.HTMLAttributes<HTMLElement>
>(function HistoryListbox({ children, style, ...other }, ref) {
  return (
    <Box
      sx={{
        // サイドバーと統一: スクロールバーつまみを text.secondary 色に
        '& .simplebar-track.simplebar-vertical .simplebar-scrollbar:before': {
          backgroundColor: 'text.secondary',
        },
      }}
    >
      <SimpleBar style={{ maxHeight: 160 }}>
        <ul
          ref={ref}
          {...other}
          style={{
            ...style,
            margin: 0,
            // 上下 8px はデフォルト相当、左右 12px は項目を左右両端から離して
            // 削除 X ボタンとスクロールバーが被るのを防ぐ
            padding: '8px 12px',
            listStyle: 'none',
            maxHeight: 'none',
            overflow: 'visible',
          }}
        >
          {children}
        </ul>
      </SimpleBar>
    </Box>
  );
});

// VSCode 風の検索入力欄内インライントグル (Aa / ab / .*)。
// onMouseDown を抑止することで input から focus を奪わない。
const InlineOptionToggle: React.FC<{
  selected: boolean;
  onChange: () => void;
  title: string;
  label: string;
}> = ({ selected, onChange, title, label }) => (
  <Tooltip arrow title={title}>
    <Box
      component="button"
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.preventDefault();
        onChange();
      }}
      sx={{
        appearance: 'none',
        border: 'none',
        cursor: 'pointer',
        width: 22,
        height: 22,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'inherit',
        fontSize: '0.7rem',
        fontWeight: 'bold',
        borderRadius: 1,
        color: selected ? 'primary.contrastText' : 'text.secondary',
        backgroundColor: selected ? 'primary.main' : 'transparent',
        transition: 'background-color 100ms ease, color 100ms ease',
        '&:hover': {
          backgroundColor: selected
            ? 'primary.dark'
            : (theme) =>
                alpha(
                  theme.palette.action.active,
                  theme.palette.action.hoverOpacity,
                ),
        },
      }}
    >
      {label}
    </Box>
  </Tooltip>
);

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
        // 長い行（SVG パス等）でも hit が確実に見えるよう、hit を中心にウィンドウ抽出する。
        // hit より前は最大 PREVIEW_BEFORE 文字、後ろは最大 PREVIEW_AFTER 文字を表示し、
        // 切り詰めた側に '…' を付ける。
        const PREVIEW_BEFORE = 10;
        const PREVIEW_AFTER = 200;
        const hitEnd = matchOffsetInLine + m.matchText.length;
        const displayStart = Math.max(0, matchOffsetInLine - PREVIEW_BEFORE);
        const displayEnd = Math.min(lineText.length, hitEnd + PREVIEW_AFTER);
        const prefixEllipsis = displayStart > 0 ? '…' : '';
        const suffixEllipsis = displayEnd < lineText.length ? '…' : '';
        const before = lineText.slice(displayStart, matchOffsetInLine);
        const hit = lineText.slice(matchOffsetInLine, hitEnd);
        const after = lineText.slice(hitEnd, displayEnd);
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
              {prefixEllipsis}
              {before}
            </Typography>
            <Typography
              component="span"
              sx={{
                fontSize: '0.75rem',
                fontFamily: 'monospace',
                backgroundColor: HIT_BG,
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
              {suffixEllipsis}
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
