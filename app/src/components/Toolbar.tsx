import { usePreview } from '../hooks/usePreview';
import { buildCsv, csvFileName } from '../lib/csv';
import { useTranslation } from '../i18n';
import { useApp } from '../store';
import { Icon } from './Icon';

export function Toolbar() {
  const { t } = useTranslation();
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
  const preview = usePreview();

  const exportCsv = async () => {
    if (!preview.rows.length) {
      showToast('info', t('toolbar.emptyCsv'));
      return;
    }
    try {
      const { saveTextFile } = await import('../lib/bridge');
      const res = await saveTextFile(csvFileName(), buildCsv(preview.rows, t), [
        { name: t('toolbar.csvFilter'), extensions: ['csv'] },
      ]);
      if (res.canceled) return;
      if (!res.ok) {
        showToast('error', t('toolbar.csvFailed', { message: res.error ?? t('common.unknownError') }));
        return;
      }
      showToast(
        'success',
        res.backup
          ? t('toolbar.csvExportedBackup', { count: preview.rows.length, path: res.backup })
          : t('toolbar.csvExported', { count: preview.rows.length, path: res.path ?? '' }),
      );
    } catch (err) {
      showToast('error', t('toolbar.csvFailed', { message: err instanceof Error ? err.message : String(err) }));
    }
  };

  return (
    <div className="toolbar">
      <button className="btn btn-primary" type="button" data-testid="add-files" onClick={() => void chooseFiles()}>
        <Icon name="file-plus" />{t('toolbar.addFiles')}
      </button>
      <button className="btn btn-soft" type="button" data-testid="add-folder" onClick={() => void chooseFolder()}>
        <Icon name="folder-plus" />{t('toolbar.addFolder')}
      </button>
      <span className="divider" />
      <button
        className="btn btn-ghost"
        type="button"
        title={t('toolbar.planImportHint')}
        data-testid="plan-import"
        onClick={() => void openPlanImport()}
      >
        <Icon name="import" />{t('toolbar.planImport')}
      </button>
      <button
        className="btn btn-ghost"
        type="button"
        title={t('toolbar.planExportHint')}
        data-testid="plan-export"
        onClick={openPlanExport}
      >
        <Icon name="save" />{t('toolbar.planExport')}
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
        <Icon name="undo" />{t('toolbar.undo')} <span className="kbd">Ctrl Z</span>
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
      <button
        className="btn btn-icon"
        type="button"
        title={t('toolbar.csvHint')}
        data-testid="csv-export"
        onClick={() => void exportCsv()}
      >
        <Icon name="save" />
      </button>
      <div style={{ flex: 1 }} />
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
        <span className="kbd">Ctrl K</span>
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
        onClick={() => showToast('info', t('toolbar.helpToast'))}
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
