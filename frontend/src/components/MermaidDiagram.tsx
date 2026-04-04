import { Box, IconButton, Paper, Typography } from '@mui/material';
import { RestartAlt, ZoomIn, ZoomOut } from '@mui/icons-material';
import mermaid from 'mermaid';
import { useCallback, useEffect, useRef, useState } from 'react';

const initMermaid = (isDark: boolean) => {
  mermaid.initialize({
    startOnLoad: false,
    theme: isDark ? 'dark' : 'default',
    securityLevel: 'strict',
  });
};

interface MermaidDiagramProps {
  code: string;
  isDark: boolean;
}

let renderCounter = 0;

export const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ code, isDark }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGElement | null>(null);
  const initialFit = useRef({ zoom: 1, x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [error, setError] = useState<string | null>(null);

  const applyTransform = useCallback(() => {
    if (svgRef.current) {
      svgRef.current.style.transform = `translate(${position.x}px, ${position.y}px) scale(${zoom})`;
    }
  }, [position.x, position.y, zoom]);

  /** コンテナサイズに合わせて図全体が収まるズーム・位置を計算 */
  const calcFit = useCallback((svgEl: SVGElement) => {
    const container = containerRef.current;
    if (!container) return { zoom: 1, x: 0, y: 0 };

    const cw = container.clientWidth;
    const ch = container.clientHeight;
    // SVG の実サイズを取得（viewBox or width/height 属性）
    const bbox = (svgEl as SVGSVGElement).getBBox();
    const sw = bbox.width || svgEl.clientWidth || cw;
    const sh = bbox.height || svgEl.clientHeight || ch;

    const padding = 16; // 上下左右の余白
    const availW = cw - padding * 2;
    const availH = ch - padding * 2;

    const fitZoom = Math.min(availW / sw, availH / sh, 1); // 1 を超えない（拡大しない）
    const fitX = (cw - sw * fitZoom) / 2;
    const fitY = (ch - sh * fitZoom) / 2;

    return { zoom: fitZoom, x: fitX, y: fitY };
  }, []);

  // code または isDark が変わったときだけ再レンダリング
  useEffect(() => {
    if (!outputRef.current || !code) return;
    let cancelled = false;

    initMermaid(isDark);
    const uniqueId = `mermaid-${++renderCounter}`;

    (async () => {
      try {
        const { svg } = await mermaid.render(uniqueId, code);
        if (cancelled || !outputRef.current) return;
        setError(null);
        outputRef.current.innerHTML = svg;

        const svgElement = outputRef.current.querySelector('svg');
        if (svgElement) {
          svgRef.current = svgElement;
          svgElement.style.transformOrigin = 'top left';
          svgElement.style.transition = 'transform 0.2s ease';

          // 図全体がコンテナに収まるようフィット
          const fit = calcFit(svgElement);
          initialFit.current = fit;
          setZoom(fit.zoom);
          setPosition({ x: fit.x, y: fit.y });
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Invalid mermaid syntax');
        if (outputRef.current) {
          outputRef.current.innerHTML = '';
        }
      }
    })();

    return () => { cancelled = true; };
  }, [code, isDark, calcFit]);

  useEffect(() => {
    applyTransform();
  }, [applyTransform]);

  const handleZoomIn = () => setZoom((prev) => Math.min(prev * 1.2, 5));
  const handleZoomOut = () => setZoom((prev) => Math.max(prev / 1.2, 0.1));
  const handleReset = () => {
    const fit = initialFit.current;
    setZoom(fit.zoom);
    setPosition({ x: fit.x, y: fit.y });
  };

  // ネイティブ wheel イベントを { passive: false } で登録し、親スクロールを確実に防止
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      setZoom((prev) => Math.max(0.1, Math.min(5, prev * delta)));
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
      if (svgRef.current) {
        svgRef.current.style.transition = 'none';
      }
    },
    [position.x, position.y],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isDragging) {
        requestAnimationFrame(() => {
          setPosition({
            x: e.clientX - dragStart.x,
            y: e.clientY - dragStart.y,
          });
        });
      }
    },
    [isDragging, dragStart.x, dragStart.y],
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    if (svgRef.current) {
      svgRef.current.style.transition = 'transform 0.2s ease';
    }
  }, []);

  return (
    <Box
      sx={{
        position: 'relative',
        width: '100%',
        height: 500,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 2,
        overflow: 'hidden',
        backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.9)',
        my: 1.5,
      }}
    >
      {/* Toolbar */}
      <Paper
        elevation={2}
        sx={{
          position: 'absolute',
          top: 8,
          left: 8,
          zIndex: 10,
          display: 'flex',
          gap: 0.25,
          p: 0.25,
          borderRadius: 1,
        }}
      >
        <IconButton size="small" onClick={handleZoomIn} title="Zoom In">
          <ZoomIn fontSize="small" />
        </IconButton>
        <IconButton size="small" onClick={handleZoomOut} title="Zoom Out">
          <ZoomOut fontSize="small" />
        </IconButton>
        <IconButton size="small" onClick={handleReset} title="Reset">
          <RestartAlt fontSize="small" />
        </IconButton>
      </Paper>

      {/* Zoom Meter */}
      <Paper
        elevation={2}
        sx={{
          position: 'absolute',
          top: 8,
          right: 8,
          zIndex: 10,
          px: 1,
          py: 0.5,
          borderRadius: 1,
        }}
      >
        <Typography variant="caption">{Math.round(zoom * 100)}%</Typography>
      </Paper>

      {/* Diagram Area */}
      <Box
        ref={containerRef}
        sx={{
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          cursor: isDragging ? 'grabbing' : 'grab',
          userSelect: 'none',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {error ? (
          <Box sx={{ p: 2, color: 'error.main' }}>
            <Typography variant="body2">Mermaid Error: {error}</Typography>
          </Box>
        ) : (
          <Box ref={outputRef} sx={{ width: '100%', height: '100%' }} />
        )}
      </Box>

      {/* Manual */}
      <Box
        sx={{
          position: 'absolute',
          bottom: 8,
          left: 8,
          zIndex: 10,
          backgroundColor: 'rgba(0,0,0,0.6)',
          color: '#fff',
          fontSize: 11,
          px: 1,
          py: 0.5,
          borderRadius: 1,
          pointerEvents: 'none',
        }}
      >
        Wheel: Zoom | Drag: Move
      </Box>
    </Box>
  );
};
