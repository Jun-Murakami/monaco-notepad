import { Box } from '@mui/material';

import { Editor } from './Editor';
import { PaneHeader } from './PaneHeader';

import type { editor } from 'monaco-editor';
import type { LanguageInfo } from '../lib/monaco';
import type { FileNote, Note } from '../types';

interface EditorPaneProps {
  paneId: 'left' | 'right';
  note: Note | null;
  fileNote: FileNote | null;
  languages: LanguageInfo[];
  editorInstanceRef: React.RefObject<editor.IStandaloneCodeEditor | null>;
  platform: string;
  // PaneHeader
  isSplit: boolean;
  paneColor: 'primary' | 'secondary';
  paneLabel?: string;
  dimmed: boolean;
  onActivatePane?: () => void;
  onTitleChange: (title: string) => void;
  onLanguageChange: (language: string) => void;
  // Editor
  onChange: (value: string) => void;
  searchKeyword?: string;
  searchMatchIndexInNote?: number;
  onFocus: () => void;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onClose: () => void;
  onSelectNext: () => Promise<void>;
  onSelectPrevious: () => Promise<void>;
  canSelectAdjacent?: boolean;
  onOpenFind?: () => void;
  onOpenReplace?: () => void;
  onOpenFindInAll?: () => void;
}

export const EditorPane: React.FC<EditorPaneProps> = ({
  paneId,
  note,
  fileNote,
  languages,
  editorInstanceRef,
  platform,
  isSplit,
  paneColor,
  paneLabel,
  dimmed,
  onActivatePane,
  onTitleChange,
  onLanguageChange,
  onChange,
  searchKeyword,
  searchMatchIndexInNote,
  onFocus,
  onNew,
  onOpen,
  onSave,
  onClose,
  onSelectNext,
  onSelectPrevious,
  canSelectAdjacent,
  onOpenFind,
  onOpenReplace,
  onOpenFindInAll,
}) => {
  return (
    <Box
      data-pane={paneId}
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        '--wails-drop-target': 'drop',
        '&.wails-drop-target-active::after': {
          content: '""',
          position: 'absolute',
          inset: 0,
          backgroundColor: (theme) =>
            theme.palette.mode === 'dark'
              ? 'rgba(255, 255, 255, 0.08)'
              : 'rgba(0, 0, 0, 0.08)',
          pointerEvents: 'none',
          zIndex: 5,
        },
      }}
    >
      <PaneHeader
        note={fileNote || note}
        languages={languages}
        onActivatePane={onActivatePane}
        onTitleChange={onTitleChange}
        onLanguageChange={onLanguageChange}
        onFocusEditor={() => editorInstanceRef.current?.focus()}
        isSplit={isSplit}
        paneColor={paneColor}
        paneLabel={paneLabel}
        dimmed={dimmed}
        onSelectPrevious={() => {
          void onSelectPrevious();
        }}
        onSelectNext={() => {
          void onSelectNext();
        }}
        canSelectAdjacent={canSelectAdjacent}
        onClose={onClose}
        platform={platform}
      />
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <Editor
          paneId={paneId}
          editorInstanceRef={editorInstanceRef}
          onChange={onChange}
          platform={platform}
          currentNote={note || fileNote}
          searchKeyword={searchKeyword}
          searchMatchIndexInNote={searchMatchIndexInNote}
          onFocus={onFocus}
          onNew={onNew}
          onOpen={onOpen}
          onSave={onSave}
          onClose={onClose}
          onSelectNext={onSelectNext}
          onSelectPrevious={onSelectPrevious}
          onOpenFind={onOpenFind}
          onOpenReplace={onOpenReplace}
          onOpenFindInAll={onOpenFindInAll}
        />
      </Box>
    </Box>
  );
};
