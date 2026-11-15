/**
 * 行拖拽：pointer events + 4px 阈值 + 插入指示 + 边缘自动滚动。
 * 行上没有 HTML5 draggable，整行都是拖动手柄；拖拽期间锁文本选中并改光标。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { blockRange } from '../lib/selection';
import { clampSlotOutsideBlock, edgeScrollSpeed, slotForPoint } from '../lib/drag';

export interface RowDragState {
  ids: string[];
  /** 可见顺序里的插入槽位 0..n */
  slot: number;
  ghost: { x: number; y: number; count: number };
}

interface Options {
  containerRef: React.RefObject<HTMLElement | null>;
  rowIds: string[];
  rowHeight: number;
  headHeight: number;
  onDrop: (ids: string[], slot: number) => void;
  /** 没有位移就松手：用于把多选收敛成点中的那一行 */
  onPlainClick?: (id: string) => void;
}

interface Session {
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  ids: string[];
  active: boolean;
  slot: number;
}

const THRESHOLD = 4;
const SCROLL_ZONE = 40;
const SCROLL_MAX = 18;

export function useRowDrag(options: Options) {
  const [drag, setDrag] = useState<RowDragState | null>(null);
  const optsRef = useRef(options);
  optsRef.current = options;
  const session = useRef<Session | null>(null);
  const raf = useRef(0);
  /** 上一次落下的时间戳：双击要忽略刚刚结束的拖拽 */
  const droppedAt = useRef(0);

  const compute = useCallback(() => {
    const s = session.current;
    const el = optsRef.current.containerRef.current;
    if (!s?.active || !el) return;
    const rect = el.getBoundingClientRect();
    const y = s.y - rect.top + el.scrollTop - optsRef.current.headHeight;
    let slot = slotForPoint(optsRef.current.rowIds.length, y, optsRef.current.rowHeight);
    const range = blockRange(optsRef.current.rowIds, s.ids);
    if (range) slot = clampSlotOutsideBlock(slot, range.start, range.end);
    s.slot = slot;
    setDrag({ ids: s.ids, slot, ghost: { x: s.x, y: s.y, count: s.ids.length } });
  }, []);

  const tick = useCallback(() => {
    const s = session.current;
    const el = optsRef.current.containerRef.current;
    if (!s?.active || !el) return;
    const rect = el.getBoundingClientRect();
    const fromTop = s.y - rect.top;
    const fromBottom = rect.bottom - s.y;
    let delta = 0;
    if (fromTop < SCROLL_ZONE) delta = -edgeScrollSpeed(fromTop, SCROLL_ZONE, SCROLL_MAX);
    else if (fromBottom < SCROLL_ZONE) delta = edgeScrollSpeed(fromBottom, SCROLL_ZONE, SCROLL_MAX);
    if (delta) {
      const before = el.scrollTop;
      el.scrollTop = before + delta;
      if (el.scrollTop !== before) compute();
    }
    raf.current = requestAnimationFrame(tick);
  }, [compute]);

  const cleanup = useCallback(() => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = 0;
    document.body.classList.remove('row-drag-active');
    session.current = null;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onMove = useCallback(
    (event: PointerEvent) => {
      const s = session.current;
      if (!s || event.pointerId !== s.pointerId) return;
      s.x = event.clientX;
      s.y = event.clientY;
      if (!s.active) {
        if (Math.hypot(s.x - s.startX, s.y - s.startY) < THRESHOLD) return;
        s.active = true;
        document.body.classList.add('row-drag-active');
        document.getSelection()?.removeAllRanges();
        raf.current = requestAnimationFrame(tick);
      }
      event.preventDefault();
      compute();
    },
    [compute, tick],
  );

  const onUp = useCallback(
    (event: PointerEvent) => {
      const s = session.current;
      if (!s || event.pointerId !== s.pointerId) return;
      const { ids, slot, active } = s;
      cleanup();
      setDrag(null);
      if (active) {
        droppedAt.current = Date.now();
        optsRef.current.onDrop(ids, slot);
      } else {
        optsRef.current.onPlainClick?.(ids[0]);
      }
    },
    [cleanup],
  );

  const onCancel = useCallback(() => {
    cleanup();
    setDrag(null);
  }, [cleanup]);

  const onKey = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !session.current) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    },
    [onCancel],
  );

  const begin = useCallback(
    (event: React.PointerEvent, id: string, ids: string[]) => {
      if (event.button !== 0 || !ids.length) return;
      cleanup();
      session.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        ids,
        active: false,
        slot: optsRef.current.rowIds.findIndex((rowId) => rowId === id),
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey, true);
    },
    [cleanup, onMove, onUp, onCancel, onKey],
  );

  useEffect(() => cleanup, [cleanup]);

  return { drag, begin, droppedAt };
}
