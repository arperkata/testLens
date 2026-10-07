import React, { useEffect, useRef, useState } from 'react';

/**
 * Lightweight screenshot markup editor (canvas). Tools: rectangle, arrow, text, highlight,
 * freehand pen, pixelate (doubles as manual redaction). Undo per shape; export as PNG data URL.
 */
type Tool = 'rect' | 'arrow' | 'text' | 'highlight' | 'pen' | 'pixelate';
interface Shape {
  tool: Tool;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  points?: { x: number; y: number }[];
  text?: string;
  color: string;
}

const COLORS = ['#ff3b30', '#ff9500', '#ffd60a', '#34c759', '#0a84ff', '#ffffff', '#000000'];

export function MarkupEditor({ src, onSave, onCancel }: { src: string; onSave: (dataUrl: string) => void; onCancel: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>();
  const [tool, setTool] = useState<Tool>('rect');
  const [color, setColor] = useState(COLORS[0]!);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape>();
  const [textPrompt, setTextPrompt] = useState<{ x: number; y: number } | null>(null);
  const [textValue, setTextValue] = useState('');
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const c = canvasRef.current!;
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const maxW = c.parentElement?.clientWidth ?? 800;
      setScale(Math.min(1, maxW / img.naturalWidth));
      redraw([]);
    };
    img.src = src;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    redraw(draft ? [...shapes, draft] : shapes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, draft]);

  function redraw(all: Shape[]) {
    const c = canvasRef.current;
    const img = imgRef.current;
    if (!c || !img) return;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0);
    for (const s of all) drawShape(ctx, s, c);
  }

  function drawShape(ctx: CanvasRenderingContext2D, s: Shape, c: HTMLCanvasElement) {
    const lw = Math.max(3, Math.round(c.width / 400));
    ctx.save();
    ctx.lineWidth = lw;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const x = Math.min(s.x1, s.x2), y = Math.min(s.y1, s.y2), w = Math.abs(s.x2 - s.x1), h = Math.abs(s.y2 - s.y1);
    switch (s.tool) {
      case 'rect':
        ctx.shadowColor = 'rgba(0,0,0,.5)';
        ctx.shadowBlur = 4;
        ctx.strokeRect(x, y, w, h);
        break;
      case 'highlight':
        ctx.globalAlpha = 0.35;
        ctx.fillRect(x, y, w, h);
        break;
      case 'arrow': {
        const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
        const head = lw * 5;
        ctx.shadowColor = 'rgba(0,0,0,.5)';
        ctx.shadowBlur = 4;
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(s.x2, s.y2);
        ctx.lineTo(s.x2 - head * Math.cos(ang - Math.PI / 6), s.y2 - head * Math.sin(ang - Math.PI / 6));
        ctx.lineTo(s.x2 - head * Math.cos(ang + Math.PI / 6), s.y2 - head * Math.sin(ang + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'pen':
        if (s.points?.length) {
          ctx.shadowColor = 'rgba(0,0,0,.5)';
          ctx.shadowBlur = 3;
          ctx.beginPath();
          ctx.moveTo(s.points[0]!.x, s.points[0]!.y);
          for (const p of s.points) ctx.lineTo(p.x, p.y);
          ctx.stroke();
        }
        break;
      case 'text': {
        const size = Math.max(16, Math.round(c.width / 45));
        ctx.font = `bold ${size}px ui-sans-serif, system-ui, sans-serif`;
        const pad = 6;
        const m = ctx.measureText(s.text ?? '');
        ctx.fillStyle = 'rgba(0,0,0,.65)';
        ctx.fillRect(s.x1 - pad, s.y1 - size - pad, m.width + pad * 2, size + pad * 2);
        ctx.fillStyle = s.color;
        ctx.fillText(s.text ?? '', s.x1, s.y1);
        break;
      }
      case 'pixelate': {
        if (w < 2 || h < 2) break;
        const block = Math.max(8, Math.round(Math.max(w, h) / 12));
        const tmp = document.createElement('canvas');
        tmp.width = Math.max(1, Math.round(w / block));
        tmp.height = Math.max(1, Math.round(h / block));
        const tctx = tmp.getContext('2d')!;
        tctx.imageSmoothingEnabled = true;
        tctx.drawImage(imgRef.current!, x, y, w, h, 0, 0, tmp.width, tmp.height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h);
        break;
      }
    }
    ctx.restore();
  }

  const pos = (e: React.PointerEvent) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };

  const down = (e: React.PointerEvent) => {
    const p = pos(e);
    if (tool === 'text') {
      setTextPrompt(p);
      setTextValue('');
      return;
    }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDraft({ tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, points: tool === 'pen' ? [p] : undefined });
  };
  const move = (e: React.PointerEvent) => {
    if (!draft) return;
    const p = pos(e);
    setDraft({ ...draft, x2: p.x, y2: p.y, points: draft.points ? [...draft.points, p] : undefined });
  };
  const up = () => {
    if (!draft) return;
    const big = Math.abs(draft.x2 - draft.x1) > 3 || Math.abs(draft.y2 - draft.y1) > 3 || (draft.points?.length ?? 0) > 2;
    if (big) setShapes((s) => [...s, draft]);
    setDraft(undefined);
  };
  const commitText = () => {
    if (textPrompt && textValue.trim()) setShapes((s) => [...s, { tool: 'text', x1: textPrompt.x, y1: textPrompt.y, x2: textPrompt.x, y2: textPrompt.y, text: textValue.trim(), color }]);
    setTextPrompt(null);
  };
  const save = () => {
    redraw(shapes);
    onSave(canvasRef.current!.toDataURL('image/png'));
  };

  const tools: { id: Tool; label: string; title: string }[] = [
    { id: 'rect', label: '▭', title: 'Rectangle' },
    { id: 'arrow', label: '➚', title: 'Arrow' },
    { id: 'text', label: 'T', title: 'Text' },
    { id: 'highlight', label: '▮', title: 'Highlight' },
    { id: 'pen', label: '✎', title: 'Freehand' },
    { id: 'pixelate', label: '▦', title: 'Pixelate (hide sensitive data)' },
  ];

  return (
    <div className="card" style={{ padding: 8 }}>
      <div className="row between" style={{ marginBottom: 6 }}>
        <div className="row" style={{ gap: 4 }}>
          {tools.map((t) => (
            <button key={t.id} className={`small ${tool === t.id ? 'primary' : ''}`} title={t.title} onClick={() => setTool(t.id)} style={{ minWidth: 30 }}>
              {t.label}
            </button>
          ))}
          <span style={{ width: 8 }} />
          {COLORS.map((c) => (
            <button key={c} className="small" title={c} onClick={() => setColor(c)} style={{ width: 20, height: 20, padding: 0, background: c, border: color === c ? '2px solid var(--acc)' : '1px solid var(--line)', borderRadius: '50%' }} />
          ))}
        </div>
        <div className="row" style={{ gap: 4 }}>
          <button className="small" onClick={() => setShapes((s) => s.slice(0, -1))} disabled={!shapes.length} title="Undo">↶ Undo</button>
          <button className="small" onClick={() => setShapes([])} disabled={!shapes.length}>Clear</button>
          <button className="small" onClick={onCancel}>Cancel</button>
          <button className="small primary" onClick={save} disabled={!shapes.length}>Save markup</button>
        </div>
      </div>
      <div style={{ position: 'relative', lineHeight: 0 }}>
        <canvas ref={canvasRef} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} style={{ width: '100%', borderRadius: 6, border: '1px solid var(--line)', cursor: tool === 'text' ? 'text' : 'crosshair', touchAction: 'none' }} />
        {textPrompt && (
          <div style={{ position: 'absolute', left: `${(textPrompt.x / (canvasRef.current?.width ?? 1)) * 100}%`, top: `${(textPrompt.y / (canvasRef.current?.height ?? 1)) * 100}%`, transform: 'translateY(-100%)', lineHeight: 'normal' }}>
            <input
              autoFocus
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitText();
                if (e.key === 'Escape') setTextPrompt(null);
              }}
              onBlur={commitText}
              placeholder="Type, then Enter"
              style={{ width: 220 }}
            />
          </div>
        )}
      </div>
      <p className="muted" style={{ margin: '6px 0 0', fontSize: 11 }}>
        Draw on the screenshot: boxes and arrows to point at the problem, text for notes, pixelate to hide anything sensitive. Saving replaces the screenshot in this bug; the original stays available (unselected). Scale {Math.round(scale * 100)}%.
      </p>
    </div>
  );
}
