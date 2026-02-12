import { Box, Paper, Popper, Typography } from '@mui/material';
import { useCallback, useMemo, useRef, useState } from 'react';

interface NotePreviewPopperProps {
  content: string | undefined;
  anchorX?: number;
  disabled?: boolean;
  children: React.ReactNode;
}

export const NotePreviewPopper: React.FC<NotePreviewPopperProps> = ({
  content,
  anchorX,
  disabled,
  children,
}) => {
  // ドラッグ中など disabled 時は DOM ラッパーごとバイパスして children だけ返す
  if (disabled) return <>{children}</>;

  return (
    <NotePreviewPopperInner content={content} anchorX={anchorX}>
      {children}
    </NotePreviewPopperInner>
  );
};

const NotePreviewPopperInner: React.FC<
  Omit<NotePreviewPopperProps, 'disabled'>
> = ({ content, anchorX, children }) => {
  const [open, setOpen] = useState(false);
  const hoverTimerRef = useRef<number | null>(null);
  const mouseYRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const virtualAnchorRef = useRef<{ getBoundingClientRect: () => DOMRect }>({
    getBoundingClientRect: () => new DOMRect(0, 0, 0, 0),
  });

  const getAnchorX = useCallback(() => {
    if (anchorX !== undefined) return anchorX;
    return containerRef.current?.getBoundingClientRect().right ?? 0;
  }, [anchorX]);

  const handleMouseEnter = useCallback(() => {
    hoverTimerRef.current = window.setTimeout(() => {
      const x = getAnchorX();
      virtualAnchorRef.current = {
        getBoundingClientRect: () => new DOMRect(x, mouseYRef.current, 0, 0),
      };
      setOpen(true);
    }, 0);
  }, [getAnchorX]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      mouseYRef.current = e.clientY;
      if (open) {
        const x = getAnchorX();
        virtualAnchorRef.current = {
          getBoundingClientRect: () => new DOMRect(x, e.clientY, 0, 0),
        };
      }
    },
    [open, getAnchorX],
  );

  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setOpen(false);
  }, []);

  const previewLines = useMemo(() => {
    if (!content) return null;
    return content
      .split(/\r\n|\n|\r/)
      .slice(0, 10)
      .join('\n');
  }, [content]);

  return (
    <Box
      ref={containerRef}
      onMouseEnter={handleMouseEnter}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {open && previewLines && (
        <Popper
          open
          anchorEl={virtualAnchorRef.current as unknown as HTMLElement}
          placement="right-start"
          modifiers={[
            { name: 'offset', options: { offset: [0, 4] } },
            {
              name: 'preventOverflow',
              options: { boundary: 'window', padding: 2 },
            },
          ]}
          sx={{ zIndex: 1300, pointerEvents: 'none', maxWidth: 400 }}
        >
          <Paper
            elevation={8}
            sx={{
              maxWidth: 400,
              maxHeight: 240,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <Box sx={{ px: 1.5, pt: 1, flex: '0 0 auto' }} />
            <Box
              sx={{
                px: 1.5,
                overflow: 'hidden',
                flex: '1 1 auto',
                minHeight: 0,
              }}
            >
              <Typography
                variant="caption"
                component="pre"
                sx={{
                  fontFamily: 'monospace',
                  fontSize: '0.75rem',
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  m: 0,
                  color: 'text.secondary',
                }}
              >
                {previewLines}
              </Typography>
            </Box>
            <Box sx={{ px: 1.5, pb: 1, flex: '0 0 auto' }} />
          </Paper>
        </Popper>
      )}
      {children}
    </Box>
  );
};
