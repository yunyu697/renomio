import { useEffect, useRef, useState } from 'react';
import { displayBinding } from '../lib/shortcuts';
import { useTranslation } from '../i18n';
import { useApp } from '../store';
import { ExportMenu } from './ExportMenu';
import { Icon } from './Icon';
import { ToolbarMore } from './ToolbarMore';

export function Toolbar() {
  const { t } = useTranslation();
  const barRef = useRef<HTMLDivElement | null>(null);
  const [fold, setFold] = useState(false);
  const chooseFiles = useApp((s) => s.chooseFiles);
  const chooseFolder = useApp((s) => s.chooseFolder);
  const undoLast = useApp((s) => s.undoLast);
  const undoBusy = useApp((s) => s.undoBusy);
  const applying = useApp((s) => s.applying);
  const search = useApp((s) => s.search);
  const setSearch = useApp((s) => s.setSearch);
  const openPlanExport = useApp((s) => s.openPlanExport);
  const openPlanImport = useApp((s) => s.openPlanImport);
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
   * 不靠折行、不靠压缩按钮高度与内边距腾空间。
   *
   * 用法：先临时切回「标签版」，量这一次的自然宽度（nowrap 下 scrollWidth 即内容宽度），
   * 再按 clientWidth 判定。按分组容器宽度累加会漏掉组内间距，宽度一紧就会晚折一档。
   */
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const measure = () => {
      const folded = el.dataset.fold === 'icons';
      if (folded) el.dataset.fold = 'full';
      const natural = el.scrollWidth;
      if (folded) el.dataset.fold = 'icons';
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
      {/* 组 1：加入内容——工具栏里唯一的高频主操作 */}
      <div className="tb-group">
        <button className="btn btn-primary" type="button" data-testid="add-files" onClick={() => void chooseFiles()}>
          <Icon name="file-plus" /><span className="btn-label">{t('toolbar.addFiles')}</span>
        </button>
        <button className="btn btn-soft" type="button" data-testid="add-folder" onClick={() => void chooseFolder()}>
          <Icon name="folder-plus" /><span className="btn-label">{t('toolbar.addFolder')}</span>
        </button>
      </div>
      {/* 组 2：方案（成对进出，低频但明确） */}
      <div className="tb-group">
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
      </div>
      {/* 组 3：批次历史 */}
      <div className="tb-group">
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
      </div>
      {/* 组 4：读取与导出 */}
      <div className="tb-group">
        <button
          className="btn btn-icon"
          type="button"
          title={t('toolbar.refreshHint')}
          onClick={() => window.dispatchEvent(new CustomEvent('rename:refresh'))}
        >
          <Icon name="refresh" />
        </button>
        <ExportMenu />
      </div>
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
      <ToolbarMore />
    </div>
  );
}
