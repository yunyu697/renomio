import { useEffect, useMemo, useRef, useState, useCallback, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { usePreview } from '../hooks/usePreview';
import { formatSize, formatTime } from '../lib/format';
import { fileKind } from '../lib/rules';
import { useTranslation } from '../i18n';
import type { ColumnKey, PreviewRow, RowStatus } from '../lib/types';
import { useApp, type StatusFilter } from '../store';
import { Icon, type IconName } from './Icon';
import { ListTabs, ListView } from './ListView';

interface ColumnDef {
  key: ColumnKey;
  defaultCss: string;
}

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
const COLUMN_MIN: Record<ColumnKey, number> = { name: 120, location: 100, size: 58, modified: 78, newName: 100, status: 72 };
/** 未设置自定义宽度时的弹性模板：文本列走 fr，数值/时间列定宽。 */
const COLUMN_FLEX: Record<ColumnKey, string> = {
  name: 'minmax(0, 1.5fr)',
  location: 'minmax(0, .9fr)',
  size: '62px',
  modified: '92px',
  newName: 'minmax(0, 1.3fr)',
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

type SortKey = 'none' | 'name' | 'modified' | 'size';

/** 表头高度 / 行高（与 app.css 的 .thead、.trow 一致），用于虚拟滚动定位。 */
const THEAD_H = 34;
const ROW_H = 43;
/** 超过该行数才启用虚拟滚动：小列表保持全量渲染，避免改变既有行为。 */
const VIRTUAL_THRESHOLD = 200;
/** 视窗外多渲染的行数，减少快速滚动时的空白。 */
const OVERSCAN = 8;

function matchesFilter(row: PreviewRow, filter: StatusFilter, query: string): boolean {
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

export function MainPane() {
  const { t } = useTranslation();
  const entries = useApp((s) => s.entries);
  const search = useApp((s) => s.search);
  const listTab = useApp((s) => s.listTab);
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
  const manualOrder = useApp((s) => s.manualOrder);
  const duplicates = useApp((s) => s.duplicates);
  const dupBusy = useApp((s) => s.dupBusy);
  const scanDuplicates = useApp((s) => s.scanDuplicates);
  const dedupeDuplicates = useApp((s) => s.dedupeDuplicates);
  const clearDuplicates = useApp((s) => s.clearDuplicates);
  const preview = usePreview();
  const [sortKey, setSortKey] = useState<SortKey>('none');
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [colMenuOpen, setColMenuOpen] = useState(false);
  const [dragWidths, setDragWidths] = useState<Partial<Record<ColumnKey, number>>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
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
      if (compact && key === 'name') return 'minmax(0, 2.4fr)';
      if (compact && key === 'newName') return 'minmax(0, 1fr)';
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

  const rows = useMemo(() => {
    const list = preview.rows.filter((row) => matchesFilter(row, statusFilter, search));
    if (sortKey !== 'none') {
      list.sort((a, b) => {
        if (sortKey === 'name') return a.entry.name.localeCompare(b.entry.name, 'zh-CN') * sortDir;
        if (sortKey === 'modified') return (a.entry.modified - b.entry.modified) * sortDir;
        return (a.entry.size - b.entry.size) * sortDir;
      });
    }
    return list;
  }, [preview.rows, statusFilter, search, sortKey, sortDir]);

  const selectedCount = entries.filter((e) => e.selected).length;
  const allOn = entries.length > 0 && selectedCount === entries.length;

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

  const startDrag = (id: string) => {
    setDragId(id);
    setDropAt(null);
  };

  const finishDrop = (targetId: string) => {
    if (dragId && dragId !== targetId) moveEntryTo(dragId, entryIndexOf(targetId));
    setDragId(null);
    setDropAt(null);
  };

  const toggleManual = (id: string, delta: number) => {
    if (sortKey !== 'none') {
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
  }, [virtual, listTab, entries.length]);

  /** 可见窗口 = 滚动位置换算的行号区间（表头 sticky，占位从表头下方算起）。 */
  const firstVisible = virtual
    ? Math.max(0, Math.floor((view.top - THEAD_H) / ROW_H) - OVERSCAN)
    : 0;
  const lastVisible = virtual
    ? Math.min(rows.length, Math.ceil((view.top - THEAD_H + view.height) / ROW_H) + OVERSCAN)
    : rows.length;
  const visibleRows = virtual ? rows.slice(firstVisible, lastVisible) : rows;
  const padTop = firstVisible * ROW_H;
  const padBottom = (rows.length - lastVisible) * ROW_H;

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(1);
    }
  };

  if (listTab !== 'rename') {
    return (
      <section className="main">
        <ListTabs />
        <ListView tab={listTab} />
      </section>
    );
  }

  if (!entries.length) {
    return (
      <section className="main">
        <ListTabs />
        <div className="empty-state">
          <div className="empty-mark"><Icon name="folder-plus" size={30} /></div>
          <h3>{t('main.emptyTitle')}</h3>
          <p>{t('main.emptyDesc')}</p>
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
          <div className="empty-hint">
            {isDemo ? t('main.demoHint') : t('main.dragHint')}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="main">
      <ListTabs />
      <div className="list-tools">
        <span className={`mini ${statusFilter === 'all' ? 'on' : ''}`} onClick={() => setStatusFilter('all')}>
          {t('main.all')} <span style={{ fontFamily: 'var(--mono)' }}>{preview.counts.total}</span>
        </span>
        <span className={`mini ${statusFilter === 'conflict' ? 'on' : ''}`} onClick={() => setStatusFilter('conflict')}>
          {t('main.conflict')}
          <span style={{ color: preview.counts.conflict ? 'var(--danger)' : 'var(--muted)', fontWeight: 600 }}>
            {preview.counts.conflict}
          </span>
        </span>
        <span className={`mini ${statusFilter === 'warn' ? 'on' : ''}`} onClick={() => setStatusFilter('warn')}>
          {t('main.warn')} <span>{preview.counts.warn}</span>
        </span>
        <span className={`mini ${statusFilter === 'changed' ? 'on' : ''}`} onClick={() => setStatusFilter('changed')}>
          {t('main.changed')} <span>{preview.counts.ready + preview.counts.warn + preview.counts.conflict}</span>
        </span>
        <span className={`mini ${statusFilter === 'checked' ? 'on' : ''}`} onClick={() => setStatusFilter('checked')}>
          {t('main.checked')} <span>{selectedCount}</span>
        </span>
        <div className="right">
          <span
            className="mini"
            data-testid="exec-order-note"
            title={t('main.execOrderHint')}
          >
            <Icon name="info" />{t('main.execOrder')}
          </span>
          {manualOrder && (
            <span className="mini on" data-testid="manual-order-chip" title={t('list.orderHint')}>
              <Icon name="drag" />{t('list.manualOrder')}
            </span>
          )}
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
          <span className="mini" data-testid="dup-scan" onClick={() => {
            if (dupBusy) return;
            void scanDuplicates().then(() => {
              const report = useApp.getState().duplicates;
              if (!report?.groups.length) showToast('info', t('dup.none'));
            }).catch(() => undefined);
          }} title={t('dup.subtitle')}>
            <Icon name="layers" />{dupBusy ? t('dup.busy') : t('dup.scan')}
          </span>
          <span className="mini" onClick={() => window.dispatchEvent(new CustomEvent('rename:refresh'))} title={t('main.refreshHint')}>
            <Icon name="refresh" />{t('main.refresh')}
          </span>
          <div className="col-wrap">
            <span
              className={`mini ${colMenuOpen ? 'on' : ''}`}
              title={t('main.columnsHint')}
              data-testid="col-settings"
              onClick={() => setColMenuOpen((open) => !open)}
            >
              <Icon name="sort" />{t('main.columns')}
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
                <div className="col-hint">{t('main.widthHint')}</div>
              </div>
            )}
          </div>
          <span className="mini" onClick={removeSelected} title={t('main.removeHint')}>
            <Icon name="minus" />{t('main.removeSelected')}
          </span>
          <span className="mini" onClick={clearAll} title={t('main.clearHint')}>
            <Icon name="trash" />{t('main.clear')}
          </span>
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
        className="table"
        role="table"
        data-testid="file-table"
        data-total={rows.length}
        data-virtual={virtual ? '1' : '0'}
        data-listw={listWidth}
        data-shown={shownKeys.length}
        data-compact={compact ? '1' : '0'}
        ref={observeTable}
        onScroll={(event) => {
          if (!virtual) return;
          const el = event.currentTarget;
          setView((prev) =>
            prev.top === el.scrollTop && prev.height === el.clientHeight
              ? prev
              : { top: el.scrollTop, height: el.clientHeight },
          );
        }}
        style={{ ['--cols' as string]: cols } as CSSProperties}
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
              {t('column.name')} <Icon name={sortKey === 'name' ? (sortDir === -1 ? 'chevron-up' : 'chevron-down') : 'sort'} size={11} />
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
              {t('column.modified')} <Icon name={sortKey === 'modified' ? (sortDir === -1 ? 'chevron-up' : 'chevron-down') : 'sort'} size={11} />
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

        {padTop > 0 && <div className="row-pad" style={{ height: padTop }} aria-hidden="true" />}

        {visibleRows.map((row) => {
          const kind = fileKind(row.entry.name, row.entry.isDir);
          const changed = row.newName !== row.entry.name;
          const entryIdx = entryIndexOf(row.entry.id);
          const isDupName = !row.entry.isDir
            && (duplicateNames.get(row.entry.name.toLocaleLowerCase()) ?? 0) > 1;
          const sorted = sortKey !== 'none';
          return (
            <div
              className={`trow ${row.entry.selected ? 'selected' : ''} ${row.status === 'conflict' || row.status === 'invalid' ? 'conflict' : ''} ${row.status === 'warn' ? 'warnrow' : ''} ${row.status === 'unchanged' ? 'unchanged' : ''} ${dragId === row.entry.id ? 'dragging-row' : ''} ${dropAt === entryIdx ? 'drop-target' : ''}`}
              key={row.entry.id}
              role="row"
              title={row.reasons.length ? row.reasons.join(' · ') : row.entry.path}
              onDragOver={(event) => {
                if (!dragId || sorted) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDropAt(entryIdx);
              }}
              onDragLeave={() => {
                if (dropAt === entryIdx) setDropAt(null);
              }}
              onDrop={(event) => {
                if (!dragId || sorted) return;
                event.preventDefault();
                finishDrop(row.entry.id);
              }}
              onDoubleClick={() => {
                if (isDemo) return;
                void import('../lib/bridge').then(({ revealPath }) => revealPath(row.entry.path).catch(() => undefined));
              }}
            >
              <div className="cell drag-cell">
                <span
                  className={`drag-handle ${sorted ? 'disabled' : ''}`}
                  draggable={!sorted}
                  data-testid={`row-handle-${entryIdx}`}
                  title={sorted ? t('main.execOrderHint') : t('list.dragHint')}
                  onDragStart={(event) => {
                    if (sorted) {
                      event.preventDefault();
                      return;
                    }
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', row.entry.id);
                    startDrag(row.entry.id);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setDropAt(null);
                  }}
                >
                  <Icon name="drag" size={10} />
                </span>
                <span
                  className={`checkbox ${row.entry.selected ? 'on' : ''}`}
                  role="checkbox"
                  aria-checked={row.entry.selected}
                  onClick={() => toggleSelect(row.entry.id)}
                >
                  {row.entry.selected && <Icon name="check" size={10} />}
                </span>
              </div>
              <div className="cell name-cell">
                <span className={`file-ico ${kind}`}><Icon name={ICON_BY_KIND[kind] ?? 'file'} /></span>
                <span className="txt">{row.entry.name}</span>
                {isDupName && (
                  <span className="dup-name-badge" data-testid={`dup-name-${entryIdx}`} title={t('list.duplicateName')}>
                    {t('list.duplicateName')}
                  </span>
                )}
                {row.entry.readonly && <Icon name="lock" size={11} style={{ color: 'var(--muted-2)' }} />}
                {!row.entry.isDir && (
                  <button
                    className="row-meta"
                    type="button"
                    title={t('main.metadataHint')}
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
                <div className="cell mono"><span className="txt" style={{ color: 'var(--muted)' }}>{row.entry.parent}</span></div>
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
                    <span className="new-name"><span className="seg" style={{ color: 'var(--muted)' }}>{row.newName}</span></span>
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
            </div>
          );
        })}

        {padBottom > 0 && <div className="row-pad" style={{ height: padBottom }} aria-hidden="true" />}

        {!rows.length && (
          <div className="no-rows">{t('main.noRows')}</div>
        )}
      </div>
    </section>
  );
}
