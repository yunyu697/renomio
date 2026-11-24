import { useEffect, useMemo, useRef, useState, useCallback, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { usePreview } from '../hooks/usePreview';
import { useVisibleRows } from '../hooks/useVisibleRows';
import { useListSelection } from '../hooks/useListSelection';
import { useRowDrag } from '../hooks/useRowDrag';
import { useMarquee } from '../hooks/useMarquee';
import { useListKeys } from '../hooks/useListKeys';
import { formatSize, formatTime } from '../lib/format';
import { fileKind } from '../lib/rules';
import { useTranslation } from '../i18n';
import type { ColumnKey, PreviewRow, RowStatus } from '../lib/types';
import { useApp } from '../store';
import { nextSort, type StatusFilter } from '../lib/order';
import { rangeIds } from '../lib/selection';
import { blankMenuItems, dispatchMenu, rowMenuItems, type MenuActions } from '../lib/menuModel';
import { Icon, type IconName } from './Icon';
import { Inspector } from './Inspector';
import { ContextMenu } from './ContextMenu';

interface ColumnDef {
  key: ColumnKey;
  defaultCss: string;
}

/** 状态筛选：五项收成一个 24px 触发器 + 弹层，避免把五条 chip 摊在同一行（§1.16） */
const FILTER_OPTIONS: Array<{
  key: StatusFilter;
  labelKey: string;
  count: (counts: { total: number; conflict: number; warn: number; ready: number }, selected: number) => number;
}> = [
  { key: 'all', labelKey: 'main.all', count: (c) => c.total },
  { key: 'conflict', labelKey: 'main.conflict', count: (c) => c.conflict },
  { key: 'warn', labelKey: 'main.warn', count: (c) => c.warn },
  { key: 'changed', labelKey: 'main.changed', count: (c) => c.ready + c.warn + c.conflict },
  { key: 'checked', labelKey: 'main.checked', count: (_c, selected) => selected },
];

const COLUMN_DEFS: ColumnDef[] = [
  { key: 'name', defaultCss: 'minmax(168px, 1.15fr)' },
  { key: 'location', defaultCss: 'minmax(120px, .85fr)' },
  { key: 'size', defaultCss: '62px' },
  { key: 'modified', defaultCss: '92px' },
  { key: 'newName', defaultCss: 'minmax(168px, 1.15fr)' },
  { key: 'status', defaultCss: '96px' },
];

/** 窄窗时的列收敛顺序（越小越先保留）与最小可读宽度；name 永远保留。 */
const COLUMN_RANK: Record<ColumnKey, number> = { name: 0, newName: 1, status: 2, size: 3, modified: 4, location: 5 };
const COLUMN_MIN: Record<ColumnKey, number> = { name: 140, location: 100, size: 62, modified: 92, newName: 150, status: 96 };
/** 未设置自定义宽度时的弹性模板：文本列走 fr，数值/时间列定宽。下界与 COLUMN_MIN 一致，
    保证「列收敛」判定通过时网格不会再被挤到表头截断（SPEC §1.19 规则 3/4）。 */
const COLUMN_FLEX: Record<ColumnKey, string> = {
  name: 'minmax(140px, 1.5fr)',
  location: 'minmax(100px, .9fr)',
  size: '62px',
  modified: '92px',
  newName: 'minmax(150px, 1.3fr)',
  status: '96px',
};

const STATUS_CLASS: Record<RowStatus, string> = {
  ready: 's-pending',
  unchanged: 's-unchanged',
  conflict: 's-conflict',
  warn: 's-warn',
  invalid: 's-conflict',
  off: 's-skip',
};

const STATUS_KEY: Record<RowStatus, string> = {
  ready: 'row.ready',
  unchanged: 'row.unchanged',
  conflict: 'row.conflict',
  warn: 'row.warn',
  invalid: 'row.invalid',
  off: 'row.off',
};

const ICON_BY_KIND: Record<string, IconName> = {
  folder: 'folder',
  jpg: 'image',
  pdf: 'pdf',
  txt: 'text',
  music: 'music',
  video: 'video',
  doc: 'doc',
  file: 'file',
};

/** 表头高度（与 app.css 的 .thead = row-h-md 32 一致），用于虚拟滚动定位。 */
const THEAD_H = 32;
/** 行高只取设计系统阶梯值：舒适 = touch(44)，紧凑 = md(32)；43/36 不在阶梯里（§1.15） */
const ROW_H_COMFORTABLE = 44;
const ROW_H_COMPACT = 32;
/** 超过该行数才启用虚拟滚动：小列表保持全量渲染，避免改变既有行为。 */
const VIRTUAL_THRESHOLD = 200;
/** 视窗外多渲染的行数，减少快速滚动时的空白。 */
const OVERSCAN = 8;

export function MainPane() {
  const { t } = useTranslation();
  const entries = useApp((s) => s.entries);
  const statusFilter = useApp((s) => s.statusFilter);
  const setStatusFilter = useApp((s) => s.setStatusFilter);
  const toggleSelect = useApp((s) => s.toggleSelect);
  const toggleSelectAll = useApp((s) => s.toggleSelectAll);
  const removeSelected = useApp((s) => s.removeSelected);
  const clearAll = useApp((s) => s.clearAll);
  const chooseFiles = useApp((s) => s.chooseFiles);
  const chooseFolder = useApp((s) => s.chooseFolder);
  const isDemo = useApp((s) => s.isDemo);
  const showToast = useApp((s) => s.showToast);
  const columns = useApp((s) => s.settings.columns);
  const columnWidths = useApp((s) => s.settings.columnWidths);
  const updateSettings = useApp((s) => s.updateSettings);
  const openMetadata = useApp((s) => s.openMetadata);
  const openMetaEditor = useApp((s) => s.openMetaEditor);
  const moveEntryTo = useApp((s) => s.moveEntryTo);
  const moveEntriesTo = useApp((s) => s.moveEntriesTo);
  const setSelected = useApp((s) => s.setSelected);
  const manualOrder = useApp((s) => s.manualOrder);
  const nameOverrides = useApp((s) => s.nameOverrides);
  const setNameOverride = useApp((s) => s.setNameOverride);
  const clearNameOverride = useApp((s) => s.clearNameOverride);
  const clipboard = useApp((s) => s.clipboard);
  const copyEntries = useApp((s) => s.copyEntries);
  const cutEntries = useApp((s) => s.cutEntries);
  const pasteEntries = useApp((s) => s.pasteEntries);
  const listSort = useApp((s) => s.listSort);
  const setSort = useApp((s) => s.setSort);
  const resetSort = useApp((s) => s.resetSort);
  const density = useApp((s) => s.settings.listDensity ?? 'comfortable');
  const duplicates = useApp((s) => s.duplicates);
  const dupBusy = useApp((s) => s.dupBusy);
  const scanDuplicates = useApp((s) => s.scanDuplicates);
  const dedupeDuplicates = useApp((s) => s.dedupeDuplicates);
  const clearDuplicates = useApp((s) => s.clearDuplicates);
  const inspector = useApp((s) => s.inspector);
  const openInspector = useApp((s) => s.openInspector);
  const closeInspector = useApp((s) => s.closeInspector);
  const preview = usePreview();
  const rows = useVisibleRows();
  const rowH = density === 'compact' ? ROW_H_COMPACT : ROW_H_COMFORTABLE;
  const [colMenuOpen, setColMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  /** 清空列表要二次确认：这是唯一会让人「列表空了」的动作 */
  const [clearOpen, setClearOpen] = useState(false);
  const [dragWidths, setDragWidths] = useState<Partial<Record<ColumnKey, number>>>({});
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'row' | 'blank' } | null>(null);
  /** 列表可用宽度（随窗口/面板变化），用于窄窗收敛列。 */
  const [listWidth, setListWidth] = useState(0);

  const visibleColumns = COLUMN_DEFS.filter((c) => columns[c.key]);
  const widthOf = (key: ColumnKey) => dragWidths[key] ?? columnWidths[key];
  /** 按可用宽度收敛列：保留 name，优先保留 newName/status，次要列在窄窗隐藏，避免列被裁。 */
  const shownKeys = (() => {
    const all = visibleColumns.map((c) => c.key);
    if (!listWidth) return all;
    const keep: ColumnKey[] = [];
    let used = 34;
    for (const key of [...all].sort((a, b) => COLUMN_RANK[a] - COLUMN_RANK[b])) {
      const min = widthOf(key) || COLUMN_MIN[key];
      if (!keep.length || used + min <= listWidth) {
        keep.push(key);
        used += min;
      }
    }
    return all.filter((k) => keep.includes(k));
  })();
  const shown: Record<ColumnKey, boolean> = {
    name: shownKeys.includes('name'),
    location: shownKeys.includes('location'),
    size: shownKeys.includes('size'),
    modified: shownKeys.includes('modified'),
    newName: shownKeys.includes('newName'),
    status: shownKeys.includes('status'),
  };
  const compact = !!listWidth && shownKeys.length < visibleColumns.length;
  const cols = `34px ${shownKeys
    .map((key) => {
      const width = widthOf(key);
      const room = listWidth ? listWidth - 34 : 0;
      if (width && room >= Math.max(60, width)) return `minmax(0, ${Math.max(60, width)}px)`;
      if (compact && key === 'name') return 'minmax(140px, 2.4fr)';
      if (compact && key === 'newName') return 'minmax(150px, 1fr)';
      return COLUMN_FLEX[key];
    })
    .join(' ')}`;

  const toggleColumn = (key: ColumnKey) => {
    if (columns[key] && visibleColumns.length === 1) {
      showToast('info', t('main.keepOneColumn'));
      return;
    }
    updateSettings({ columns: { ...columns, [key]: !columns[key] } });
  };

  const beginResize = (key: ColumnKey, event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const header = event.currentTarget.parentElement as HTMLElement | null;
    if (!header) return;
    const startX = event.clientX;
    const startWidth = Math.max(60, Math.round(header.getBoundingClientRect().width));
    const move = (ev: MouseEvent) => {
      const width = Math.max(60, Math.round(startWidth + ev.clientX - startX));
      setDragWidths((prev) => ({ ...prev, [key]: width }));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setDragWidths((prev) => {
        const width = prev[key];
        if (width) updateSettings({ columnWidths: { ...columnWidths, [key]: width } });
        return {};
      });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const rowIds = useMemo(() => rows.map((row) => row.entry.id), [rows]);
  const selectedCount = entries.filter((e) => e.selected).length;
  const allOn = entries.length > 0 && selectedCount === entries.length;
  const selectedRows = rows.filter((row) => row.entry.selected);
  const selectedPaths = selectedRows.map((row) => row.entry.path);

  /** 同名（不同路径）标记：Windows 比较不区分大小写。 */
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      if (entry.isDir) continue;
      const key = entry.name.toLocaleLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [entries]);

  const entryIndexOf = (id: string) => entries.findIndex((e) => e.id === id);

  /** 在「当前可见行」内上移/下移：换算成 entries 下标后再调用 moveEntryTo。 */
  const moveVisible = (id: string, delta: number) => {
    const at = rows.findIndex((r) => r.entry.id === id);
    const neighbor = rows[at + delta];
    if (at < 0 || !neighbor) return;
    moveEntryTo(id, entryIndexOf(neighbor.entry.id));
  };

  const toggleManual = (id: string, delta: number) => {
    if (listSort.key !== 'none') {
      showToast('info', t('main.execOrderHint'));
      return;
    }
    moveVisible(id, delta);
  };

  const virtual = rows.length > VIRTUAL_THRESHOLD;
  const tableRef = useRef<HTMLDivElement>(null);
  const tableRoRef = useRef<ResizeObserver | null>(null);
  const [view, setView] = useState({ top: 0, height: 640 });

  /** 用回调 ref 观察列表宽度：列表在空态/页面切换时可能晚于挂载出现，effect 只跑一次会漏挂。 */
  const observeTable = useCallback((el: HTMLDivElement | null) => {
    tableRef.current = el;
    tableRoRef.current?.disconnect();
    tableRoRef.current = null;
    if (!el) return;
    const sync = () => setListWidth((prev) => (prev === el.clientWidth ? prev : el.clientWidth));
    sync();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    tableRoRef.current = observer;
  }, []);

  useEffect(() => {
    if (!virtual) return;
    const el = tableRef.current;
    if (!el) return;
    const sync = () => {
      const next = { top: el.scrollTop, height: el.clientHeight };
      setView((prev) => (prev.top === next.top && prev.height === next.height ? prev : next));
    };
    sync();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    observer?.observe(el);
    window.addEventListener('resize', sync);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, [virtual, entries.length]);

  /** 可见窗口 = 滚动位置换算的行号区间（表头 sticky，占位从表头下方算起）。 */
  const firstVisible = virtual
    ? Math.max(0, Math.floor((view.top - THEAD_H) / rowH) - OVERSCAN)
    : 0;
  const lastVisible = virtual
    ? Math.min(rows.length, Math.ceil((view.top - THEAD_H + view.height) / rowH) + OVERSCAN)
    : rows.length;
  const visibleRows = virtual ? rows.slice(firstVisible, lastVisible) : rows;
  const padTop = firstVisible * rowH;
  const padBottom = (rows.length - lastVisible) * rowH;

  const toggleSort = (key: 'name' | 'modified' | 'size') => setSort(nextSort(listSort, key));

  const selection = useListSelection(rowIds);
  const pressRef = useRef<string | null>(null);

  const reveal = useCallback(
    (path: string) => {
      if (isDemo) return;
      void import('../lib/bridge').then(({ revealPath }) => revealPath(path).catch(() => undefined));
    },
    [isDemo],
  );

  const startRename = useCallback(
    (row: PreviewRow) => {
      setRenaming({ id: row.entry.id, value: nameOverrides[row.entry.path] ?? row.entry.name });
    },
    [nameOverrides],
  );

  /** 行内快捷键：Space 勾选、F2 改名、Delete 移除选中；输入框 / 输入法组字期间一律放行。 */
  const onRowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, row: PreviewRow) => {
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === ' ') {
      event.preventDefault();
      toggleSelect(row.entry.id);
    } else if (event.key === 'F2') {
      event.preventDefault();
      startRename(row);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      if (!row.entry.selected) toggleSelect(row.entry.id);
      removeSelected();
    }
  };

  /** 落下：先把可见落点换算成真实插入位，再清掉视图排序回到手动顺序。 */
  const handleDrop = (ids: string[], slot: number) => {
    const beforeId = rows[slot]?.entry.id ?? null;
    const wasSorted = listSort.key !== 'none';
    const moved = moveEntriesTo(ids, beforeId);
    // 排序只是视图：一旦拖动落下就先回到手动顺序，落点按真实插入位生效
    if (wasSorted) resetSort();
    if (!moved.length) {
      if (wasSorted) showToast('info', t('list.sortCleared'));
      return;
    }
    if (wasSorted) {
      showToast('info', t('list.sortCleared'));
      return;
    }
    if (moved.length > 1) {
      showToast('info', t('list.blockMoved', { count: moved.length }));
      return;
    }
    const row = rows.find((item) => item.entry.id === moved[0]);
    showToast('info', t('toast.orderMoved', { name: row?.entry.name ?? '', index: entryIndexOf(moved[0]) + 1 }));
  };

  const dragApi = useRowDrag({
    containerRef: tableRef,
    rowIds,
    rowHeight: rowH,
    headHeight: THEAD_H,
    onDrop: handleDrop,
    onPlainClick: (id) => {
      if (pressRef.current !== id) return;
      pressRef.current = null;
      selection.only(id);
    },
  });

  const marqueeBase = useRef<string[]>([]);
  const marquee = useMarquee({
    containerRef: tableRef,
    onSelect: (ids, additive) => {
      if (!additive) {
        setSelected(ids);
        return;
      }
      setSelected([...new Set([...marqueeBase.current, ...ids])]);
    },
    onClear: selection.clear,
  });

  const beginMarquee = (event: React.PointerEvent) => {
    marqueeBase.current = rows.filter((row) => row.entry.selected).map((row) => row.entry.id);
    marquee.begin(event);
  };

  /** 行上按下：可能是一次点选，也可能进入拖拽；绝不能变成框选。 */
  const beginRowPress = (event: React.PointerEvent, row: PreviewRow) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    tableRef.current?.focus({ preventScroll: true });
    const id = row.entry.id;
    const selectedSet = new Set(selectedRows.map((item) => item.entry.id));
    let ids: string[];

    if (event.shiftKey) {
      const anchor = selection.anchorId;
      ids = anchor ? rangeIds(rowIds, anchor, id) : [id];
      selection.extendTo(id);
    } else if (event.ctrlKey || event.metaKey) {
      ids = row.entry.selected
        ? rowIds.filter((item) => item !== id && selectedSet.has(item))
        : rowIds.filter((item) => item === id || selectedSet.has(item));
      selection.toggle(id);
    } else if (!row.entry.selected) {
      selection.only(id);
      ids = [id];
    } else if (selectedCount > 1) {
      // 多选里按在已选中行上：先保留多选，等松手且没拖动再收敛
      selection.focus(id);
      ids = selectedRows.map((item) => item.entry.id);
      pressRef.current = id;
    } else {
      selection.focus(id);
      ids = [id];
    }
    dragApi.begin(event, id, ids.filter((item) => rowIds.includes(item)));
  };

  useEffect(() => {
    if (!selection.focusId) return;
    const table = tableRef.current;
    if (!table) return;
    const el = table.querySelector<HTMLElement>(`[data-id="${selection.focusId}"]`);
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
      return;
    }
    // 虚拟滚动下行可能还没渲染（Home/End、跨页跳转）：按索引直接算滚动位置
    const index = rowIds.indexOf(selection.focusId);
    if (index < 0) return;
    const top = THEAD_H + index * rowH;
    if (top < table.scrollTop + THEAD_H) table.scrollTop = Math.max(0, top - THEAD_H);
    else if (top + rowH > table.scrollTop + table.clientHeight) table.scrollTop = top + rowH - table.clientHeight;
  }, [selection.focusId, rowIds, rowH]);

  const focusedRow = rows.find((row) => row.entry.id === selection.focusId) ?? selectedRows[0] ?? null;

  const onListKeyDown = useListKeys({
    onMove: selection.move,
    onEdge: selection.edge,
    onToggle: () => {
      if (selection.focusId) toggleSelect(selection.focusId);
    },
    onOpen: () => {
      if (focusedRow) reveal(focusedRow.entry.path);
    },
    onRename: () => {
      if (focusedRow) startRename(focusedRow);
    },
    onDelete: removeSelected,
    onSelectAll: selection.selectAll,
    onClear: selection.clear,
  });

  const menuActions: MenuActions = {
    open: () => {
      if (focusedRow) reveal(focusedRow.entry.path);
    },
    reveal: () => {
      if (focusedRow) reveal(focusedRow.entry.path);
    },
    rename: () => {
      const row = selectedRows[0] ?? focusedRow;
      if (row) startRename(row);
    },
    revertName: () => {
      for (const row of selectedRows) clearNameOverride(row.entry.path);
    },
    copy: () => copyEntries(selectedPaths),
    cut: () => cutEntries(selectedPaths),
    paste: pasteEntries,
    remove: removeSelected,
    details: () => {
      if (selectedRows.length === 1) {
        void openMetadata(selectedRows[0].entry);
        return;
      }
      const targets = selectedRows.filter((row) => !row.entry.isDir).map((row) => row.entry.path);
      if (!targets.length) {
        showToast('info', t('toast.needChecked'));
        return;
      }
      openMetaEditor(targets);
    },
    selectAll: selection.selectAll,
    deselect: selection.clear,
    refresh: () => window.dispatchEvent(new CustomEvent('rename:refresh')),
    sortBy: (key) => setSort(nextSort(listSort, key)),
    sortManual: resetSort,
    setDensity: (value) => updateSettings({ listDensity: value }),
  };

  const menuState = {
    multi: selectedCount > 1,
    anyOverride: selectedRows.some((row) => row.entry.path in nameOverrides),
    canPaste: !!clipboard?.entries.length,
    density,
    sort: listSort,
  };
  const menuItems = menu
    ? menu.kind === 'row'
      ? rowMenuItems(menuState)
      : blankMenuItems(menuState)
    : [];

  const openRowMenu = (event: ReactMouseEvent, row: PreviewRow) => {
    event.preventDefault();
    event.stopPropagation();
    if (!row.entry.selected) selection.only(row.entry.id);
    else selection.focus(row.entry.id);
    setMenu({ x: event.clientX, y: event.clientY, kind: 'row' });
  };

  const commitRename = () => {
    if (!renaming) return;
    const row = rows.find((item) => item.entry.id === renaming.id);
    const value = renaming.value;
    setRenaming(null);
    if (row) setNameOverride(row.entry.path, value);
  };

  const selectedFiles = entries.filter((e) => e.selected && !e.isDir).length;

  /** 页头：一屏唯一的视觉重心（20px），右侧只放全局动作：清空列表、检查器开关（§1.16）。 */
  const pageHead = (
    <div className="page-head">
      <h1>{t('tabFull.rename')}</h1>
      <div className="page-actions">
        <div className="clear-wrap">
          <button
            className="btn btn-ghost clear-btn"
            type="button"
            data-testid="clear-all"
            disabled={!entries.length}
            aria-expanded={clearOpen}
            title={t('main.clearHint')}
            onClick={() => setClearOpen((open) => !open)}
          >
            <Icon name="trash" size={12} />{t('main.clear')}
          </button>
          {clearOpen && (
            <div className="popover clear-confirm" data-testid="clear-confirm">
              <p>{t('main.clearConfirm', { count: entries.length })}</p>
              <div className="clear-confirm-foot">
                <button className="btn btn-ghost clear-btn" type="button" data-testid="clear-cancel" onClick={() => setClearOpen(false)}>
                  {t('common.cancel')}
                </button>
                <button
                  className="btn btn-danger-soft clear-btn"
                  type="button"
                  data-testid="clear-ok"
                  onClick={() => { setClearOpen(false); clearAll(); }}
                >
                  {t('main.clear')}
                </button>
              </div>
            </div>
          )}
        </div>
        <button
          className={`mini${inspector.open ? ' on' : ''}`}
          type="button"
          data-testid="inspector-toggle"
          aria-expanded={inspector.open}
          aria-controls="inspector-panel"
          title={t('inspector.toggleHint')}
          onClick={() => (inspector.open ? closeInspector() : openInspector())}
        >
          <Icon name="grid" size={12} />
          {t('inspector.title')}
          <span className="num" data-testid="inspector-toggle-count">{selectedFiles}</span>
        </button>
      </div>
    </div>
  );

  if (!entries.length) {
    return (
      <section className="main">
        {pageHead}
        <div className="empty-state">
          <div className="empty-mark"><Icon name="folder-plus" size={30} /></div>
          <h3>{t('main.emptyTitle')}</h3>
          <div className="empty-actions">
            <button className="btn btn-primary" type="button" onClick={() => void chooseFiles()}>
              <Icon name="file-plus" />{t('toolbar.addFiles')}
            </button>
            <button className="btn btn-soft" type="button" onClick={() => void chooseFolder()}>
              <Icon name="folder-plus" />{t('toolbar.addFolder')}
            </button>
            {isDemo && (
              <button className="btn btn-ghost" type="button" onClick={() => showToast('info', t('main.demoLoaded'))}>
                {t('main.demoSample')}
              </button>
            )}
          </div>
        </div>
        {inspector.open && <Inspector />}
      </section>
    );
  }

  return (
    <section className="main">
      {pageHead}
      {/* 筛选 + 次级操作收成一条横带：只有行尾一条分隔线（§1.16） */}
      <div className="list-head">
        <div className="list-filters">
          <div className="filter-wrap">
            <button
              className={`mini filter-trigger${statusFilter === 'all' ? '' : ' on'}`}
              type="button"
              data-testid="status-filter"
              aria-expanded={filterOpen}
              onClick={() => setFilterOpen((open) => !open)}
            >
              {t(FILTER_OPTIONS.find((o) => o.key === statusFilter)!.labelKey)}
              <span className="num">{FILTER_OPTIONS.find((o) => o.key === statusFilter)!.count(preview.counts, selectedCount)}</span>
              <Icon name="chevron-down" size={12} />
            </button>
            {filterOpen && (
              <div className="popover filter-menu" data-testid="status-filter-menu">
                {FILTER_OPTIONS.map((option) => (
                  <button
                    key={option.key}
                    className={`mini filter-item${statusFilter === option.key ? ' on' : ''}`}
                    type="button"
                    data-testid={`status-filter-${option.key}`}
                    onClick={() => { setStatusFilter(option.key); setFilterOpen(false); }}
                  >
                    {t(option.labelKey)}
                    <span className="num">{option.count(preview.counts, selectedCount)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {manualOrder && (
            <span className="mini on" data-testid="manual-order-chip" title={t('list.orderHint')}>
              <Icon name="drag" />{t('list.manualOrder')}
            </span>
          )}
          {listSort.key !== 'none' && (
            <>
              <span className="mini on" data-testid="sort-chip" title={t('list.sortOnlyView')}>
                <Icon name="sort" />{t('list.viewSorted')}
              </span>
              <button className="mini" type="button" data-testid="sort-reset" title={t('menu.sortManual')} onClick={resetSort}>
                <Icon name="undo" />
              </button>
            </>
          )}
        </div>
        <div className="list-actions">
          <span className="mini" data-testid="edit-meta" onClick={() => {
            const targets = entries.filter((e) => !e.isDir && e.selected).map((e) => e.path);
            if (!targets.length) {
              showToast('info', t('toast.needChecked'));
              return;
            }
            openMetaEditor(targets);
          }} title={t('meta.editSubtitle')}>
            <Icon name="tag" />{t('meta.editAction')}
          </span>
          <div className="col-wrap">
            <span
              className={`mini icon-mini ${colMenuOpen ? 'on' : ''}`}
              title={t('main.columnsHint')}
              data-testid="col-settings"
              onClick={() => setColMenuOpen((open) => !open)}
            >
              <Icon name="sort" />
            </span>
            {colMenuOpen && (
              <div className="popover col-menu" data-testid="col-menu">
                {COLUMN_DEFS.map((def) => (
                  <label className="col-item" key={def.key}>
                    <input
                      type="checkbox"
                      checked={columns[def.key]}
                      data-testid={`col-toggle-${def.key}`}
                      onChange={() => toggleColumn(def.key)}
                    />
                    {t(`column.${def.key}`)}
                  </label>
                ))}
                <button
                  className="col-reset"
                  type="button"
                  onClick={() => updateSettings({ columnWidths: {} })}
                >
                  {t('main.resetWidths')}
                </button>
              </div>
            )}
          </div>
          <div className="more-wrap">
            <button
              className={`mini icon-mini ${moreOpen ? 'on' : ''}`}
              type="button"
              data-testid="more-actions"
              title={t('main.more')}
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((open) => !open)}
            >
              <Icon name="more" />
            </button>
            {moreOpen && (
              <div className="popover more-menu" data-testid="more-menu">
                <button className="mini" type="button" data-testid="dup-scan" onClick={() => {
                  setMoreOpen(false);
                  if (dupBusy) return;
                  void scanDuplicates().then(() => {
                    const report = useApp.getState().duplicates;
                    if (!report?.groups.length) showToast('info', t('dup.none'));
                  }).catch(() => undefined);
                }}>
                  <Icon name="layers" />{dupBusy ? t('dup.busy') : t('dup.scan')}
                </button>
                <button className="mini" type="button" data-testid="remove-selected" onClick={() => { setMoreOpen(false); removeSelected(); }}>
                  <Icon name="minus" />{t('main.removeSelected')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {duplicates && duplicates.groups.length > 0 && (
        <div className="dup-panel" data-testid="dup-panel">
          <div className="dup-head">
            <Icon name="layers" size={13} />
            <strong>{t('dup.title')}</strong>
            <span className="dup-sub">{t('dup.subtitle')}</span>
            <button className="mini" type="button" data-testid="dup-dedupe" onClick={dedupeDuplicates}>
              <Icon name="trash" size={12} />{t('dup.keepFirst')}
            </button>
            <button className="mini" type="button" data-testid="dup-close" onClick={clearDuplicates}>
              {t('dup.close')}
            </button>
          </div>
          {duplicates.groups.map((group, index) => (
            <div className="dup-group" key={`${group.hash}-${index}`} data-testid={`dup-group-${index}`}>
              <span className="dup-group-title">
                {t('dup.group', { index: index + 1, size: formatSize(group.size), count: group.paths.length })}
              </span>
              <ul>
                {group.paths.map((path) => (
                  <li key={path} title={path}>{path}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <div
        className={`table ${dragApi.drag ? 'dragging-rows' : ''}`}
        role="table"
        data-testid="file-table"
        data-total={rows.length}
        data-virtual={virtual ? '1' : '0'}
        data-listw={listWidth}
        data-shown={shownKeys.length}
        data-compact={compact ? '1' : '0'}
        data-sort={listSort.key}
        data-sort-dir={listSort.dir}
        data-density={density}
        tabIndex={0}
        ref={observeTable}
        onKeyDown={onListKeyDown}
        onPointerDown={beginMarquee}
        onContextMenu={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest('.thead') || target.closest('.trow')) return;
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, kind: 'blank' });
        }}
        onScroll={(event) => {
          if (!virtual) return;
          const el = event.currentTarget;
          setView((prev) =>
            prev.top === el.scrollTop && prev.height === el.clientHeight
              ? prev
              : { top: el.scrollTop, height: el.clientHeight },
          );
        }}
        style={{ ['--cols' as string]: cols, ['--row-h' as string]: `${rowH}px` } as CSSProperties}
      >
        <div className="thead" role="row">
          <div className="th">
            <span
              className={`checkbox ${allOn ? 'on' : selectedCount ? 'partial' : ''}`}
              role="checkbox"
              aria-checked={allOn}
              onClick={toggleSelectAll}
              title={t('main.selectAll')}
            >
              {allOn && <Icon name="check" size={10} />}
              {!allOn && selectedCount > 0 && <Icon name="minus" size={10} />}
            </span>
          </div>
          {shown.name && (
            <div className="th sortable resizable" onClick={() => toggleSort('name')}>
              {t('column.name')} <Icon name={listSort.key === 'name' ? (listSort.dir === -1 ? 'chevron-up' : 'chevron-down') : 'sort'} size={11} />
              <span className="col-grip" data-testid="col-grip-name" onMouseDown={(e) => beginResize('name', e)} />
            </div>
          )}
          {shown.location && (
            <div className="th resizable">
              {t('column.location')}<span className="col-grip" onMouseDown={(e) => beginResize('location', e)} />
            </div>
          )}
          {shown.size && (
            <div className="th resizable" style={{ justifyContent: 'flex-end' }} onClick={() => toggleSort('size')}>
              {t('column.size')}<span className="col-grip" onMouseDown={(e) => beginResize('size', e)} />
            </div>
          )}
          {shown.modified && (
            <div className="th sortable resizable" onClick={() => toggleSort('modified')}>
              {t('column.modified')} <Icon name={listSort.key === 'modified' ? (listSort.dir === -1 ? 'chevron-up' : 'chevron-down') : 'sort'} size={11} />
              <span className="col-grip" onMouseDown={(e) => beginResize('modified', e)} />
            </div>
          )}
          {shown.newName && (
            <div className="th resizable">
              {t('column.newName')}<span className="col-grip" onMouseDown={(e) => beginResize('newName', e)} />
            </div>
          )}
          {shown.status && (
            <div className="th resizable">
              {t('column.status')}<span className="col-grip" onMouseDown={(e) => beginResize('status', e)} />
            </div>
          )}
        </div>

        <div className="tbody" data-testid="file-tbody">
          {padTop > 0 && <div className="row-pad" style={{ height: padTop }} aria-hidden="true" />}

          {visibleRows.map((row) => {
            const kind = fileKind(row.entry.name, row.entry.isDir);
            const changed = row.newName !== row.entry.name;
            const entryIdx = entryIndexOf(row.entry.id);
            const isDupName = !row.entry.isDir
              && (duplicateNames.get(row.entry.name.toLocaleLowerCase()) ?? 0) > 1;
            const override = nameOverrides[row.entry.path];
            const isDragged = !!dragApi.drag && dragApi.drag.ids.includes(row.entry.id);
            return (
              <div
                className={`trow ${row.entry.selected ? 'selected' : ''} ${selection.focusId === row.entry.id ? 'focused' : ''} ${row.status === 'conflict' || row.status === 'invalid' ? 'conflict' : ''} ${row.status === 'warn' ? 'warnrow' : ''} ${row.status === 'unchanged' ? 'unchanged' : ''} ${isDragged ? 'dragging-row' : ''}`}
                key={row.entry.id}
                role="row"
                tabIndex={selection.focusId === row.entry.id ? 0 : -1}
                aria-keyshortcuts="Space F2 Delete"
                data-id={row.entry.id}
                data-index={entryIdx}
                title={row.reasons.length ? row.reasons.join(' · ') : row.entry.path}
                onKeyDown={(event) => onRowKeyDown(event, row)}
                onPointerDown={(event) => {
                  // 键盘快捷键要有焦点落点：按下即把焦点收到行上（输入框 / 勾选框自己会拦下）
                  event.currentTarget.focus({ preventScroll: true });
                  beginRowPress(event, row);
                }}
                onDoubleClick={() => {
                  if (Date.now() - dragApi.droppedAt.current < 300) return;
                  reveal(row.entry.path);
                }}
                onContextMenu={(event) => openRowMenu(event, row)}
              >
                <div className="cell drag-cell">
                  <span
                    className="drag-handle"
                    data-testid={`row-handle-${entryIdx}`}
                    title={t('list.dragHint')}
                  >
                    <Icon name="drag" size={10} />
                  </span>
                  <span
                    className={`checkbox ${row.entry.selected ? 'on' : ''}`}
                    role="checkbox"
                    aria-checked={row.entry.selected}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => toggleSelect(row.entry.id)}
                  >
                    {row.entry.selected && <Icon name="check" size={10} />}
                  </span>
                </div>
                <div className="cell name-cell">
                  <span className={`file-ico ${kind}`}><Icon name={ICON_BY_KIND[kind] ?? 'file'} /></span>
                  {renaming?.id === row.entry.id ? (
                    <input
                      className="rename-input"
                      data-testid={`rename-input-${entryIdx}`}
                      autoFocus
                      value={renaming.value}
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => setRenaming({ id: row.entry.id, value: event.target.value })}
                      onPointerDown={(event) => event.stopPropagation()}
                      onBlur={commitRename}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          commitRename();
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          setRenaming(null);
                        }
                      }}
                    />
                  ) : (
                    <span className="txt">{row.entry.name}</span>
                  )}
                  {override && (
                    <span className="custom-badge" data-testid={`custom-name-${entryIdx}`} title={t('list.customNameHint')}>
                      {t('list.customName')}
                    </span>
                  )}
                  {isDupName && (
                    <span className="dup-name-badge" data-testid={`dup-name-${entryIdx}`} title={t('list.duplicateName')}>
                      {t('list.duplicateName')}
                    </span>
                  )}
                  {row.entry.readonly && <Icon name="lock" size={11} style={{ color: 'var(--ds-color-text-muted)' }} />}
                  {!row.entry.isDir && (
                    <button
                      className="row-meta"
                      type="button"
                      title={t('main.metadataHint')}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        void openMetadata(row.entry);
                      }}
                    >
                      <Icon name="info" size={12} />
                      <span>{t('main.metadata')}</span>
                    </button>
                  )}
                  <span className="row-order">
                    <button
                      className="row-order-btn"
                      type="button"
                      data-testid={`row-up-${entryIdx}`}
                      title={t('list.moveUp')}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleManual(row.entry.id, -1);
                      }}
                    >
                      <Icon name="chevron-up" size={11} />
                    </button>
                    <button
                      className="row-order-btn"
                      type="button"
                      data-testid={`row-down-${entryIdx}`}
                      title={t('list.moveDown')}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleManual(row.entry.id, 1);
                      }}
                    >
                      <Icon name="chevron-down" size={11} />
                    </button>
                  </span>
                </div>
                {shown.location && (
                  <div className="cell mono"><span className="txt" style={{ color: 'var(--ds-color-text-2)' }}>{row.entry.parent}</span></div>
                )}
                {shown.size && (
                  <div className="cell right">
                    <span className="dims">{row.entry.isDir ? '—' : formatSize(row.entry.size)}</span>
                  </div>
                )}
                {shown.modified && (
                  <div className="cell"><span className="dims">{formatTime(row.entry.modified)}</span></div>
                )}
                {shown.newName && (
                  <div className="cell" style={{ display: 'block', overflow: 'hidden' }}>
                    {changed ? (
                      <span className="new-name" title={`${row.entry.name} → ${row.newName}`}>
                        {row.diff.prefix && <span className="seg">{row.diff.prefix}</span>}
                        {row.diff.added && <span className="add">{row.diff.added}</span>}
                        {row.diff.suffix && <span className="seg">{row.diff.suffix}</span>}
                      </span>
                    ) : (
                      <span className="new-name"><span className="seg" style={{ color: 'var(--ds-color-text-2)' }}>{row.newName}</span></span>
                    )}
                    {row.reasons.length > 0 &&
                      (row.status === 'conflict' || row.status === 'warn' || row.status === 'invalid') && (
                      <span className={`row-sub ${row.status === 'warn' ? 'warn' : ''}`}>{row.reasons[0]}</span>
                    )}
                  </div>
                )}
                {shown.status && (
                  <div className="cell">
                    <span className={`status ${STATUS_CLASS[row.status]}`}>
                      <i className="dot" />{t(STATUS_KEY[row.status])}
                    </span>
                  </div>
                )}
                {/* 行内快捷键提示：默认不占位，悬停 / 键盘聚焦时才浮出来 */}
                <span className="row-keys" aria-hidden="true">
                  <span className="kbd">Space</span>
                  <span className="kbd">F2</span>
                  <span className="kbd">Del</span>
                </span>
              </div>
            );
          })}

          {padBottom > 0 && <div className="row-pad" style={{ height: padBottom }} aria-hidden="true" />}

          {!rows.length && (
            <div className="no-rows">{t('main.noRows')}</div>
          )}

          {dragApi.drag && (
            <div
              className="drop-line"
              data-testid="drop-line"
              style={{ ['--drop-top' as string]: `${dragApi.drag.slot * rowH}px` } as CSSProperties}
            />
          )}
        </div>
      </div>

      {dragApi.drag && (
        <div
          className="drag-ghost"
          data-testid="drag-ghost"
          style={{
            ['--ghost-x' as string]: `${dragApi.drag.ghost.x}px`,
            ['--ghost-y' as string]: `${dragApi.drag.ghost.y}px`,
          } as CSSProperties}
        >
          <Icon name="drag" size={11} />
          {dragApi.drag.ghost.count > 1
            ? t('list.dragCount', { count: dragApi.drag.ghost.count })
            : t('list.dragOne')}
        </div>
      )}

      {marquee.rect && (
        <div
          className="marquee"
          data-testid="marquee"
          style={{
            ['--m-left' as string]: `${marquee.rect.left}px`,
            ['--m-top' as string]: `${marquee.rect.top}px`,
            ['--m-width' as string]: `${marquee.rect.width}px`,
            ['--m-height' as string]: `${marquee.rect.height}px`,
          } as CSSProperties}
        />
      )}

      {/* 检查器：从右坞改为压在列表下方的底部抽屉，横向铺满内容列，纵向不挤压表格宽度 */}
      {inspector.open && <Inspector />}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onPick={(id) => dispatchMenu(id, menuActions)}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  );
}
