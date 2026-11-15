/** 列表「当前可见顺序」：筛选 + 视图排序。预览面板与主列表共用同一份顺序。 */
import { useMemo } from 'react';
import { useApp } from '../store';
import { usePreview } from './usePreview';
import { matchesFilter, orderRows } from '../lib/order';

export function useVisibleRows() {
  const preview = usePreview();
  const filter = useApp((s) => s.statusFilter);
  const search = useApp((s) => s.search);
  const sort = useApp((s) => s.listSort);
  return useMemo(
    () => orderRows(preview.rows.filter((row) => matchesFilter(row, filter, search)), sort),
    [preview.rows, filter, search, sort],
  );
}
