import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePreview } from '../hooks/usePreview';
import { buildCsv, csvFileName } from '../lib/csv';
import { buildHtml, buildTsv, buildXlsx, exportFileName } from '../lib/export';
import { useTranslation } from '../i18n';
import { useApp } from '../store';
import { Icon } from './Icon';

type Format = 'csv' | 'xlsx' | 'html' | 'tsv';

const FORMATS: Format[] = ['csv', 'xlsx', 'html', 'tsv'];

const LABELS: Record<Format, string> = {
  csv: 'toolbar.exportCsv',
  xlsx: 'toolbar.exportXlsx',
  html: 'toolbar.exportHtml',
  tsv: 'toolbar.exportTsv',
};

/** 导出菜单：CSV / Excel(.xlsx) / HTML / TSV，内容都是当前预览列表的四个列。 */
export function ExportMenu() {
  const { t } = useTranslation();
  const preview = usePreview();
  const showToast = useApp((s) => s.showToast);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => setPos(null);

  const open = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({ top: rect.bottom + 6, left: Math.max(8, rect.left) });
  };

  useLayoutEffect(() => {
    if (!pos) return;
    const el = menuRef.current;
    if (!el) return;
    const width = el.offsetWidth;
    const left = Math.max(8, Math.min(pos.left, window.innerWidth - width - 8));
    const below = window.innerHeight - pos.top - 8;
    const top = el.offsetHeight <= below ? pos.top : Math.max(8, pos.top - el.offsetHeight - 44);
    if (top !== pos.top || left !== pos.left) setPos({ top, left });
  }, [pos]);

  useEffect(() => {
    if (!pos) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onResize = () => close();
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
    };
  }, [pos]);

  const run = async (format: Format) => {
    close();
    const rows = preview.rows;
    if (!rows.length) {
      showToast('info', t('toolbar.emptyCsv'));
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const { saveBinaryFile, saveTextFile } = await import('../lib/bridge');
      let res;
      if (format === 'csv') {
        res = await saveTextFile(csvFileName(), buildCsv(rows, t), [
          { name: t('toolbar.csvFilter'), extensions: ['csv'] },
        ]);
      } else if (format === 'tsv') {
        res = await saveTextFile(exportFileName('tsv'), buildTsv(rows, t), [
          { name: t('toolbar.tsvFilter'), extensions: ['tsv'] },
        ]);
      } else if (format === 'html') {
        res = await saveTextFile(exportFileName('html'), buildHtml(rows, t), [
          { name: t('toolbar.htmlFilter'), extensions: ['html'] },
        ]);
      } else {
        res = await saveBinaryFile(
          exportFileName('xlsx'),
          buildXlsx(rows, t),
          [{ name: t('toolbar.xlsxFilter'), extensions: ['xlsx'] }],
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
      }
      if (res.canceled) return;
      if (!res.ok) {
        showToast('error', t('toolbar.exportFailed', { message: res.error ?? '' }));
        return;
      }
      showToast(
        'success',
        res.backup
          ? t('toolbar.exportDoneBackup', { count: rows.length, path: res.path ?? '', backup: res.backup })
          : t('toolbar.exportDone', { count: rows.length, path: res.path ?? '' }),
      );
    } catch (err) {
      showToast('error', t('toolbar.exportFailed', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        className="btn btn-icon"
        type="button"
        title={t('toolbar.exportHint')}
        data-testid="export-menu"
        aria-haspopup="menu"
        aria-expanded={!!pos}
        disabled={busy}
        onClick={() => (pos ? close() : open())}
      >
        <Icon name="save" />
      </button>
      {pos &&
        createPortal(
          <div
            ref={menuRef}
            className="layout-pop"
            role="menu"
            aria-label={t('toolbar.export')}
            data-testid="export-pop"
            style={{ top: pos.top, left: pos.left }}
          >
            {FORMATS.map((format) => (
              <button
                key={format}
                type="button"
                role="menuitem"
                className="layout-item"
                data-testid={`export-${format}`}
                onClick={() => void run(format)}
              >
                <Icon name="save" size={12} />
                <span>{t(LABELS[format])}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
