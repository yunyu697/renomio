/**
 * 列表「可见顺序」：筛选 + 视图排序。
 *
 * 排序只决定显示顺序，绝不改动 entries 的真实顺序（执行顺序、编号取号都按 entries 走）。
 * 预览面板、上一项/下一项、键盘焦点、框选命中都从这里取顺序，保证各处一致。
 */
import type { PreviewRow } from './types';

export type StatusFilter = 'all' | 'changed' | 'conflict' | 'warn' | 'checked';
export type SortKey = 'none' | 'name' | 'modified' | 'size';
export type SortDir = 1 | -1;

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

export const NO_SORT: SortState = { key: 'none', dir: 1 };

export function matchesFilter(row: PreviewRow, filter: StatusFilter, query: string): boolean {
  if (filter === 'changed' && !(row.entry.selected && row.newName !== row.entry.name)) return false;
  if (filter === 'conflict' && row.status !== 'conflict' && row.status !== 'invalid') return false;
  if (filter === 'warn' && row.status !== 'warn') return false;
  if (filter === 'checked' && !row.entry.selected) return false;
  if (query) {
    const q = query.toLowerCase();
    const haystack = `${row.entry.name}\n${row.entry.path}\n${row.newName}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

/** 返回新数组；`none` 时保持真实顺序（不复制排序）。 */
export function orderRows(rows: PreviewRow[], sort: SortState): PreviewRow[] {
  const list = [...rows];
  if (sort.key === 'none') return list;
  const dir = sort.dir;
  list.sort((a, b) => {
    if (sort.key === 'name') return a.entry.name.localeCompare(b.entry.name, 'zh-CN') * dir;
    if (sort.key === 'modified') return (a.entry.modified - b.entry.modified) * dir;
    return (a.entry.size - b.entry.size) * dir;
  });
  return list;
}

/** 点击列头 / 菜单项时的状态推进：同列再点切换方向，换列从升序开始。 */
export function nextSort(current: SortState, key: Exclude<SortKey, 'none'>): SortState {
  if (current.key === key) return { key, dir: current.dir === 1 ? -1 : 1 };
  return { key, dir: 1 };
}
