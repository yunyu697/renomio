/**
 * 选择模型：锚点 / 焦点集中在这里，写回 store 的 selected 标记。
 * 所有列表都按「当前可见顺序」传入，排序后 Shift 范围、方向键都跟着新顺序走。
 */
import { useCallback, useRef, useState } from 'react';
import { useApp } from '../store';
import { edgeFocus, rangeIds, selectionForFocus, stepFocus } from '../lib/selection';

interface Cursor {
  anchor: string | null;
  focus: string | null;
}

export function useListSelection(visibleIds: string[]) {
  const setSelected = useApp((s) => s.setSelected);
  const [cursor, setCursor] = useState<Cursor>({ anchor: null, focus: null });
  const cursorRef = useRef<Cursor>(cursor);
  const idsRef = useRef(visibleIds);
  idsRef.current = visibleIds;

  const commit = useCallback((next: Cursor) => {
    cursorRef.current = next;
    setCursor(next);
  }, []);

  const only = useCallback(
    (id: string) => {
      setSelected([id]);
      commit({ anchor: id, focus: id });
    },
    [setSelected, commit],
  );

  const toggle = useCallback(
    (id: string) => {
      setSelected([id], 'toggle');
      commit({ anchor: id, focus: id });
    },
    [setSelected, commit],
  );

  const extendTo = useCallback(
    (id: string) => {
      const current = cursorRef.current;
      setSelected(rangeIds(idsRef.current, current.anchor, id));
      commit({ anchor: current.anchor ?? id, focus: id });
    },
    [setSelected, commit],
  );

  const move = useCallback(
    (delta: number, extend: boolean) => {
      const current = cursorRef.current;
      const next = stepFocus(idsRef.current, current.focus, delta);
      if (!next) return;
      const picked = selectionForFocus(idsRef.current, current, next, extend);
      setSelected(picked.ids);
      commit({ anchor: picked.anchor, focus: next });
    },
    [setSelected, commit],
  );

  const edge = useCallback(
    (where: 'start' | 'end', extend: boolean) => {
      const current = cursorRef.current;
      const next = edgeFocus(idsRef.current, where);
      if (!next) return;
      const picked = selectionForFocus(idsRef.current, current, next, extend);
      setSelected(picked.ids);
      commit({ anchor: picked.anchor, focus: next });
    },
    [setSelected, commit],
  );

  const focus = useCallback(
    (id: string) => {
      const current = cursorRef.current;
      commit({ anchor: current.anchor ?? id, focus: id });
    },
    [commit],
  );

  const selectAll = useCallback(() => {
    const ids = idsRef.current;
    if (!ids.length) return;
    setSelected(ids);
    commit({ anchor: ids[0], focus: ids[0] });
  }, [setSelected, commit]);

  const clear = useCallback(() => {
    setSelected([]);
    commit({ anchor: null, focus: null });
  }, [setSelected, commit]);

  return {
    focusId: cursor.focus,
    anchorId: cursor.anchor,
    only,
    toggle,
    extendTo,
    move,
    edge,
    focus,
    selectAll,
    clear,
  };
}
