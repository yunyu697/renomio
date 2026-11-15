/**
 * 框选（marquee）：只在列表空白处按下才开始，命中行按矩形相交实时计算。
 * 与行拖拽互斥：行上的按下由行自己处理并阻止冒泡。
 */
import { useCallback, useRef, useState } from 'react';

export interface MarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Options {
  containerRef: React.RefObject<HTMLElement | null>;
  onSelect: (ids: string[], additive: boolean) => void;
  onClear: () => void;
}

const THRESHOLD = 3;

export function useMarquee({ containerRef, onSelect, onClear }: Options) {
  const [rect, setRect] = useState<MarqueeRect | null>(null);
  const session = useRef<{ x: number; y: number; active: boolean; shift: boolean } | null>(null);
  const optsRef = useRef({ containerRef, onSelect, onClear });
  optsRef.current = { containerRef, onSelect, onClear };

  const cleanup = useCallback(() => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    session.current = null;
    setRect(null);
    document.body.classList.remove('marquee-active');
  }, []);

  const hits = useCallback((from: { x: number; y: number }, to: { x: number; y: number }) => {
    const el = optsRef.current.containerRef.current;
    if (!el) return [];
    const left = Math.min(from.x, to.x);
    const right = Math.max(from.x, to.x);
    const top = Math.min(from.y, to.y);
    const bottom = Math.max(from.y, to.y);
    const ids: string[] = [];
    for (const row of el.querySelectorAll<HTMLElement>('.trow[data-id]')) {
      const box = row.getBoundingClientRect();
      if (box.right < left || box.left > right || box.bottom < top || box.top > bottom) continue;
      const id = row.dataset.id;
      if (id) ids.push(id);
    }
    return ids;
  }, []);

  const onMove = useCallback(
    (event: PointerEvent) => {
      const s = session.current;
      if (!s) return;
      const dx = Math.abs(event.clientX - s.x);
      const dy = Math.abs(event.clientY - s.y);
      if (!s.active && dx < THRESHOLD && dy < THRESHOLD) return;
      if (!s.active) {
        s.active = true;
        document.body.classList.add('marquee-active');
      }
      event.preventDefault();
      setRect({
        left: Math.min(s.x, event.clientX),
        top: Math.min(s.y, event.clientY),
        width: dx,
        height: dy,
      });
      optsRef.current.onSelect(hits({ x: s.x, y: s.y }, { x: event.clientX, y: event.clientY }), s.shift);
    },
    [hits],
  );

  const onUp = useCallback(() => {
    const s = session.current;
    const active = s?.active ?? false;
    const shift = s?.shift ?? false;
    cleanup();
    if (!active && !shift) optsRef.current.onClear();
  }, [cleanup]);

  const onCancel = useCallback(() => cleanup(), [cleanup]);

  const onKey = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !session.current) return;
      event.preventDefault();
      event.stopPropagation();
      cleanup();
    },
    [cleanup],
  );

  const begin = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      if (target.closest('.trow') || target.closest('.thead')) return;
      cleanup();
      session.current = { x: event.clientX, y: event.clientY, active: false, shift: event.shiftKey };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey, true);
    },
    [cleanup, onMove, onUp, onCancel, onKey],
  );

  return { rect, begin, active: !!rect };
}
