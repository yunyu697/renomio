/**
 * 选择模型的纯函数部分：所有列表都按「当前可见顺序」的 id 数组传入。
 * 组件只负责把结果写回 store，锚点 / 焦点等状态集中在 useListSelection 里。
 */

export interface SelectionAnchor {
  anchor: string | null;
  focus: string | null;
}

export function withFocus(state: SelectionAnchor, focus: string | null): SelectionAnchor {
  return { anchor: state.anchor ?? focus, focus };
}

/** Ctrl 点击：切换单项；同时把锚点移到该项。 */
export function toggleId(selected: string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
}

/** Shift 点击：按锚点取可见顺序上的区间（含两端）。 */
export function rangeIds(ids: string[], anchor: string | null, target: string): string[] {
  if (!anchor) return [target];
  const from = ids.indexOf(anchor);
  const to = ids.indexOf(target);
  if (from < 0 || to < 0) return [target];
  const [start, end] = from <= to ? [from, to] : [to, from];
  return ids.slice(start, end + 1);
}

/** 方向键移动焦点；返回新的焦点 id（越界时停在端点上）。 */
export function stepFocus(ids: string[], focus: string | null, delta: number): string | null {
  if (!ids.length) return null;
  const at = focus ? ids.indexOf(focus) : -1;
  if (at < 0) return delta > 0 ? ids[0] : ids[ids.length - 1];
  const next = Math.max(0, Math.min(ids.length - 1, at + delta));
  return ids[next];
}

/** Home / End：跳到首尾。 */
export function edgeFocus(ids: string[], edge: 'start' | 'end'): string | null {
  if (!ids.length) return null;
  return edge === 'start' ? ids[0] : ids[ids.length - 1];
}

/** 焦点移动后的选择：不带 Shift 时只选焦点项，带 Shift 时扩展为锚点到焦点。 */
export function selectionForFocus(
  ids: string[],
  state: SelectionAnchor,
  focus: string,
  extend: boolean,
): { ids: string[]; anchor: string | null } {
  if (!extend) return { ids: [focus], anchor: focus };
  return { ids: rangeIds(ids, state.anchor ?? focus, focus), anchor: state.anchor ?? focus };
}

/** 拖拽块在可见顺序里的下标区间；用于把落点收敛到块外。 */
export function blockRange(ids: string[], moving: string[]): { start: number; end: number } | null {
  let start = Infinity;
  let end = -1;
  for (const id of moving) {
    const at = ids.indexOf(id);
    if (at < 0) continue;
    start = Math.min(start, at);
    end = Math.max(end, at);
  }
  if (end < 0) return null;
  return { start, end: end + 1 };
}
