import { useEffect, useRef, useState } from 'react';
import { displayBinding } from '../lib/shortcuts';
import { useTranslation } from '../i18n';
import { useApp } from '../store';
import { ExportMenu } from './ExportMenu';
import { Icon } from './Icon';

/** 搜索框的 flex 基值（.search 的 flex-basis），量自然宽度时按它算，避免被收缩后的实测值误导 */
const SEARCH_BASIS = 260;

export function Toolbar() {
  const { t } = useTranslation();
  const barRef = useRef<HTMLDivElement | null>(null);
  const [fold, setFold] = useState(false);
  const chooseFiles = useApp((s) => s.chooseFiles);
  const chooseFolder = useApp((s) => s.chooseFolder);
  const undoLast = useApp((s) => s.undoLast);
  const undoBusy = useApp((s) => s.undoBusy);
  const applying = useApp((s) => s.applying);
  const openDrawer = useApp((s) => s.openDrawer);
  const showToast = useApp((s) => s.showToast);
  const search = useApp((s) => s.search);
  const setSearch = useApp((s) => s.setSearch);
  const openPlanExport = useApp((s) => s.openPlanExport);
  const openPlanImport = useApp((s) => s.openPlanImport);
  const openShortcuts = useApp((s) => s.openShortcuts);
  const shortcuts = useApp((s) => s.settings.shortcuts);
  const entries = useApp((s) => s.entries);
  const manualOrder = useApp((s) => s.manualOrder);
  const orderUndo = useApp((s) => s.orderUndo);
  const restoreAddedOrder = useApp((s) => s.restoreAddedOrder);
  const undoRestoreOrder = useApp((s) => s.undoRestoreOrder);
  // 恢复依赖加入时留下的序号：旧会话没有序号，或没手动排过序时保持置灰
  const canRestore = manualOrder && entries.some((e) => e.addedSeq != null);
  const undoing = !!orderUndo;

  /**
   * 图标折叠（SPEC §1.19）：工具栏只保留一行，宽度不足时把按钮标签降级成图标，
   * 不靠折行、不靠压缩按钮高度与内边距腾空间。切换点＝「标签版自然宽度刚好超过可用宽度」那一档。
   */
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const measure = () => {
      // 先临时按「标签版」量一次自然宽度：折叠态下按钮已变窄，直接量会低估，导致折叠/展开来回抖
      const folded = el.dataset.fold === 'icons';
      if (folded) el.dataset.fold = 'full';
      const cs = getComputedStyle(el);
      const gap = parseFloat(cs.columnGap) || 0;
      const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const kids = [...el.children] as HTMLElement[];
      const width = kids.reduce((sum, kid) => {
        if (kid.classList.contains('toolbar-spacer')) return sum;
        if (kid.classList.contains('search')) return sum + SEARCH_BASIS;
        return sum + kid.getBoundingClientRect().width;
      }, 0);
      const natural = width + gap * Math.max(0, kids.length - 1) + pad;
      if (folded) el.dataset.fold = 'icons';
      // 切换点精确到 1px：刚好放不下标签版才折叠，早一档不折、晚一档就折
      setFold(natural > el.clientWidth + 0.5);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [t]);

  return (
    <div className="toolbar" ref={barRef} data-fold={fold ? 'icons' : 'full'}>
      <button className="btn btn-primary" type="button" data-testid="add-files" onClick={() => void chooseFiles()}>
        <Icon name="file-plus" /><span className="btn-label">{t('toolbar.addFiles')}</span>
      </button>
      <button className="btn btn-soft" type="button" data-testid="add-folder" onClick={() => void chooseFolder()}>
        <Icon name="folder-plus" /><span className="btn-label">{t('toolbar.addFolder')}</span>
      </button>
      <span className="divider" />
      <button
        className="btn btn-ghost"
        type="button"
        title={t('toolbar.planImportHint')}
        data-testid="plan-import"
        onClick={() => void openPlanImport()}
      >
        <Icon name="import" /><span className="btn-label">{t('toolbar.planImport')}</span>
      </button>
      <button
        className="btn btn-ghost"
        type="button"
        title={t('toolbar.planExportHint')}
        data-testid="plan-export"
        onClick={openPlanExport}
      >
        <Icon name="save" /><span className="btn-label">{t('toolbar.planExport')}</span>
      </button>
      <span className="divider" />
      <button
        className="btn btn-ghost"
        type="button"
        title={t('toolbar.undoHint')}
        data-testid="toolbar-undo"
        disabled={undoBusy || applying}
        onClick={() => void undoLast()}
      >
        <Icon name="undo" /><span className="btn-label">{t('toolbar.undo')}</span>
        <span className="kbd">{displayBinding(shortcuts.undo)}</span>
      </button>
      <button
        className="btn btn-ghost"
        type="button"
        title={undoing ? t('toolbar.undoRestoreHint') : t('toolbar.restoreOrderHint')}
        data-testid="restore-order"
        disabled={!undoing && !canRestore}
        onClick={() => (undoing ? undoRestoreOrder() : restoreAddedOrder())}
      >
        <Icon name={undoing ? 'undo' : 'sort'} /><span className="btn-label">{undoing ? t('toolbar.undoRestore') : t('toolbar.restoreOrder')}</span>
      </button>
      <button
        className="btn btn-icon"
        type="button"
        title={t('toolbar.refreshHint')}
        onClick={() => {
          window.dispatchEvent(new CustomEvent('rename:refresh'));
          showToast('info', t('toolbar.refreshed'));
        }}
      >
        <Icon name="refresh" />
      </button>
      <ExportMenu />
      <div className="toolbar-spacer" />
      <label className="search">
        <Icon name="search" size={14} />
        <input
          id="global-search"
          type="text"
          placeholder={t('toolbar.search')}
          aria-label={t('toolbar.searchAria')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="kbd">{displayBinding(shortcuts.search)}</span>
      </label>
      <button
        className="btn btn-icon"
        type="button"
        title={t('toolbar.filterHint')}
        onClick={() => {
          const el = document.getElementById('include-pattern');
          el?.focus();
        }}
      >
        <Icon name="filter" />
      </button>
      <button
        className="btn btn-icon"
        type="button"
        title={t('toolbar.helpHint')}
        data-testid="open-shortcuts"
        onClick={openShortcuts}
      >
        <Icon name="help" />
      </button>
      <button
        className="btn btn-icon"
        type="button"
        title={t('toolbar.settings')}
        data-testid="open-settings"
        onClick={() => openDrawer('settings')}
      >
        <Icon name="settings" />
      </button>
    </div>
  );
}
