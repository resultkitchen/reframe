import { useEffect, useRef, type ReactNode } from 'react';
import { useUi } from '../store';

interface Props {
  left: ReactNode;
  right: ReactNode;
}

/**
 * Two-column layout with a draggable splitter between left + right.
 *
 *   ┌──────────────┬──┬──────────────┐
 *   │   left       │░│   right       │
 *   │  (findings)  │░│ (preview…)    │
 *   └──────────────┴──┴──────────────┘
 *
 * On narrow viewports (< 900px) the splitter hides and the columns stack
 * vertically — the per-panel collapse toggles in store handle the rest.
 */
export function ResizableLayout({ left, right }: Props) {
  const { ui, dispatch } = useUi();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      // The splitter is rightmost in the left column, so leftWidth = mouseX - rect.left.
      const next = e.clientX - rect.left;
      dispatch({ type: 'setLeftWidth', value: next });
    }
    function onUp() {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dispatch]);

  const startDrag = () => {
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div
      ref={containerRef}
      className="rf-split"
      style={{ ['--rf-col-left' as string]: `${ui.leftWidth}px` }}
    >
      <div className="rf-split-left">{left}</div>
      <div
        className="rf-split-handle"
        onMouseDown={startDrag}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize left column"
      />
      <div className="rf-split-right">{right}</div>
    </div>
  );
}
