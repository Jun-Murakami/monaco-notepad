import { Box, useTheme } from '@mui/material';
import type { editor } from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

const DEBOUNCE_MS = 300;

interface MarkdownPreviewProps {
  editorInstanceRef: React.RefObject<editor.IStandaloneCodeEditor | null>;
}

export const MarkdownPreview: React.FC<MarkdownPreviewProps> = ({
  editorInstanceRef,
}) => {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const [content, setContent] = useState(
    () => editorInstanceRef.current?.getValue() ?? '',
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const editor = editorInstanceRef.current;
    if (!editor) return;

    const updateNow = () => setContent(editor.getValue());
    updateNow();

    const modelDisposable = editor.onDidChangeModel(() => {
      updateNow();
    });

    const contentDisposable = editor.onDidChangeModelContent(() => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(updateNow, DEBOUNCE_MS);
    });

    return () => {
      modelDisposable.dispose();
      contentDisposable.dispose();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [editorInstanceRef]);

  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        overflow: 'auto',
        p: 3,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 14,
        lineHeight: 1.7,
        color: 'text.primary',
        '& h1': {
          fontSize: '1.8em',
          fontWeight: 700,
          borderBottom: '1px solid',
          borderColor: 'divider',
          pb: 0.5,
          mb: 2,
          mt: 3,
        },
        '& h2': {
          fontSize: '1.5em',
          fontWeight: 600,
          borderBottom: '1px solid',
          borderColor: 'divider',
          pb: 0.5,
          mb: 2,
          mt: 3,
        },
        '& h3': { fontSize: '1.25em', fontWeight: 600, mb: 1.5, mt: 2.5 },
        '& h4': { fontSize: '1.1em', fontWeight: 600, mb: 1, mt: 2 },
        '& p': { mb: 1.5 },
        '& a': {
          color: 'primary.main',
          textDecoration: 'none',
          '&:hover': { textDecoration: 'underline' },
        },
        '& ul, & ol': { pl: 3, mb: 1.5 },
        '& li': { mb: 0.5 },
        '& blockquote': {
          borderLeft: '4px solid',
          borderColor: 'divider',
          pl: 2,
          ml: 0,
          color: 'text.secondary',
          fontStyle: 'italic',
        },
        '& code': {
          fontFamily: 'Consolas, Monaco, "Courier New", monospace',
          fontSize: '0.9em',
          backgroundColor: isDark
            ? 'rgba(255,255,255,0.08)'
            : 'rgba(0,0,0,0.06)',
          borderRadius: '4px',
          px: 0.75,
          py: 0.25,
        },
        '& pre': {
          backgroundColor: isDark
            ? 'rgba(255,255,255,0.06)'
            : 'rgba(0,0,0,0.04)',
          borderRadius: '6px',
          p: 2,
          mb: 1.5,
          overflow: 'auto',
          '& code': {
            backgroundColor: 'transparent',
            p: 0,
            borderRadius: 0,
          },
        },
        '& table': {
          borderCollapse: 'collapse',
          width: '100%',
          mb: 1.5,
        },
        '& th, & td': {
          border: '1px solid',
          borderColor: 'divider',
          px: 1.5,
          py: 0.75,
          textAlign: 'left',
        },
        '& th': {
          fontWeight: 600,
          backgroundColor: isDark
            ? 'rgba(255,255,255,0.04)'
            : 'rgba(0,0,0,0.03)',
        },
        '& hr': {
          border: 'none',
          borderTop: '1px solid',
          borderColor: 'divider',
          my: 2,
        },
        '& img': {
          maxWidth: '100%',
          borderRadius: '4px',
        },
        '& input[type="checkbox"]': {
          mr: 0.75,
        },
        '&::-webkit-scrollbar': {
          width: '8px',
          height: '8px',
        },
        '&::-webkit-scrollbar-track': {
          background: 'transparent',
        },
        '&::-webkit-scrollbar-thumb': {
          backgroundColor: 'rgba(128, 128, 128, 0.5)',
          borderRadius: '4px',
        },
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeHighlight]}
      >
        {content}
      </ReactMarkdown>
    </Box>
  );
};
