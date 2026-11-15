import { useEffect, useState } from 'react';
import { formatSize } from '../lib/format';
import { saveTextFile } from '../lib/bridge';
import { buildCsv } from '../lib/csv';
import { useTranslation } from '../i18n';
import type { ConflictPolicy } from '../lib/types';
import { useApp } from '../store';
import { usePreview } from '../hooks/usePreview';
import { useVisibleRows } from '../hooks/useVisibleRows';
import { Icon } from './Icon';

const POLICY_KEY: Record<ConflictPolicy, { label: string; hint: string }> = {
  skip: { label: 'policy.skip', hint: 'policy.skipHint' },
  suffix: { label: 'policy.suffix', hint: 'policy.suffixHint' },
  overwrite: { label: 'policy.overwrite', hint: 'policy.overwriteHint' },
};

const PHASE_KEY: Record<string, string> = {
  prepare: 'phase.prepare',
  stage: 'phase.stage',
  apply: 'phase.apply',
  done: 'phase.done',
  cancelled: 'phase.cancelled',
};

export function PreviewDialog() {
  const { t } = useTranslation();
  const open = useApp((s) => s.previewOpen);
  const closePreview = useApp((s) => s.closePreview);
  const applyRows = useApp((s) => s.applyRows);
  const applying = useApp((s) => s.applying);
  const applyProgress = useApp((s) => s.applyProgress);
  const cancelApply = useApp((s) => s.cancelApply);
  const isDemo = useApp((s) => s.isDemo);
  const showToast = useApp((s) => s.showToast);
  const savedPolicy = useApp((s) => s.applyPolicy);
  const setApplyPolicy = useApp((s) => s.setApplyPolicy);
  const [policy, setPolicy] = useState<ConflictPolicy>(savedPolicy);
  const preview = usePreview();
  const visible = useVisibleRows();
  const [cursor, setCursor] = useState(0);

  /** 预览列表与主列表同一份「可见顺序」：排序后这里也跟着变。 */
  const rows = visible.filter(
    (r) => r.entry.selected && r.newName !== r.entry.name && r.status !== 'off',
  );
  const cursorIndex = rows.length ? Math.min(cursor, rows.length - 1) : -1;

  useEffect(() => {
    if (!open || cursorIndex < 0) return;
    document
      .querySelector<HTMLElement>(`[data-preview-index="${cursorIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, cursorIndex]);

  if (!open) return null;

  const readonlyCount = preview.rows.filter((r) => r.entry.selected && r.entry.readonly).length;
  const progressPercent = (() => {
    if (!applyProgress) return 0;
    if (applyProgress.phase === 'done') return 100;
    const ratio = applyProgress.total ? applyProgress.done / applyProgress.total : 0;
    if (applyProgress.phase === 'stage') return Math.round(ratio * 45);
    if (applyProgress.phase === 'apply') return Math.round(45 + ratio * 55);
    return Math.round(ratio * 100);
  })();

  const exportList = async () => {
    const summary = t('preview.exportSummary', {
      total: preview.counts.total,
      conflict: preview.counts.conflict,
      invalid: preview.counts.invalid,
      warn: preview.counts.warn,
    });
    // 松手即算完，这里直接取当前结果
    const source = preview.rows;
    const content = `\ufeff${summary}\r\n${buildCsv(source, t).replace(/^\ufeff/, '')}`;
    const res = await saveTextFile(
      t('preview.exportFileName'),
      content,
      [{ name: 'CSV', extensions: ['csv'] }],
    );
    if (res.canceled) return;
    showToast(
      res.ok ? 'success' : 'error',
      res.ok ? t('preview.exported', { path: res.path ?? '' }) : t('preview.exportFailed', { message: res.error ?? '' }),
    );
  };

  return (
    <div className="modal-mask" onClick={closePreview}>
      <div className="dialog dialog-wide" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h4><Icon name="alert" size={16} style={{ color: 'var(--ds-color-warn)' }} />{t('preview.title')}</h4>
          <p>
            {t('preview.sub', {
              total: preview.counts.total,
              rows: preview.rows.length ? t('preview.readyRows', { count: rows.length }) : t('preview.noChange'),
              dir: preview.rows[0]?.entry.parent ?? '—',
            })}
            {isDemo && t('preview.demoNote')}
          </p>
          <div className="preview-nav">
            <button
              className="btn btn-ghost"
              type="button"
              data-testid="preview-prev"
              disabled={cursorIndex <= 0}
              onClick={() => setCursor(Math.max(0, cursorIndex - 1))}
            >
              <Icon name="chevron-up" size={11} />{t('preview.prev')}
            </button>
            <span data-testid="preview-pos">
              {t('preview.position', { index: cursorIndex + 1, count: rows.length })}
            </span>
            <button
              className="btn btn-ghost"
              type="button"
              data-testid="preview-next"
              disabled={cursorIndex < 0 || cursorIndex >= rows.length - 1}
              onClick={() => setCursor(Math.min(rows.length - 1, cursorIndex + 1))}
            >
              {t('preview.next')}<Icon name="chevron-down" size={11} />
            </button>
          </div>
        </div>
        <div className="dialog-body">
          <div className="metrics">
            <div className="metric ok"><div className="v">{preview.counts.ready}</div><div className="l">{t('preview.ready')}</div></div>
            <div className="metric bad"><div className="v">{preview.counts.conflict}</div><div className="l">{t('preview.conflict')}</div></div>
            <div className="metric warn"><div className="v">{preview.counts.warn}</div><div className="l">{t('preview.warn')}</div></div>
            <div className="metric"><div className="v">{preview.counts.invalid}</div><div className="l">{t('preview.invalid')}</div></div>
          </div>

          <div className="policy-row">
            <span className="policy-label">{t('preview.policy')}</span>
            <span className="seg-ctrl">
              {(['skip', 'suffix', 'overwrite'] as ConflictPolicy[]).map((p) => (
                <span key={p} className={policy === p ? 'on' : ''} data-testid={`policy-${p}`} onClick={() => { setPolicy(p); setApplyPolicy(p); }}>
                  {t(POLICY_KEY[p].label)}
                </span>
              ))}
            </span>
            {readonlyCount > 0 && <span className="policy-note">{t('preview.readonly', { count: readonlyCount })}</span>}
          </div>
          <div className={`policy-hint ${policy === 'overwrite' ? 'danger' : ''}`}>
            <Icon name="info" size={13} />{t(POLICY_KEY[policy].hint)}
          </div>

          <div className="mini-table preview-table">
            <div className="mini-row head"><span>{t('preview.currentName')}</span><span>{t('preview.newName')}</span><span>{t('preview.status')}</span></div>
            {rows.length === 0 && <div className="mini-empty">{t('preview.empty')}</div>}
            {rows.map((row, rowIndex) => (
              <div
                className={`mini-row ${rowIndex === cursorIndex ? 'current' : ''} ${row.status === 'conflict' || row.status === 'invalid' || row.pathTooLong ? 'bad' : ''}`}
                key={row.entry.id}
                data-testid="preview-row"
                data-preview-index={rowIndex}
                data-path-too-long={row.pathTooLong ? '1' : '0'}
              >
                <span className="n old" title={row.entry.path}>{row.entry.name}</span>
                <span className="n new" title={row.reasons.join('; ')}>{row.newName}</span>
                <span
                  className="mini-status"
                  style={{
                    color: row.status === 'conflict' || row.status === 'invalid' || row.pathTooLong
                      ? 'var(--ds-color-danger)'
                      : row.status === 'warn' ? 'var(--ds-color-warn)' : 'var(--ds-color-success)',
                  }}
                >
                  {row.status === 'conflict' ? row.reasons[0] ?? t('preview.conflict')
                    : row.status === 'invalid' ? row.reasons[0] ?? t('preview.invalid')
                      : row.pathTooLong ? row.reasons[0] ?? t('preview.pathTooLong')
                        : row.status === 'warn' ? row.reasons[0] ?? t('preview.warn')
                          : row.entry.isDir ? t('preview.folder') : formatSize(row.entry.size)}
                </span>
              </div>
            ))}
          </div>
        </div>
        {applying && (
          <div className="apply-progress" data-testid="apply-progress">
            <div className="apply-progress-top">
              <span className="phase" data-testid="apply-progress-phase">
                {t(PHASE_KEY[applyProgress?.phase ?? 'prepare'] ?? 'phase.prepare')}
              </span>
              <b data-testid="apply-progress-count">
                {applyProgress?.done ?? 0}/{applyProgress?.total ?? 0}
              </b>
              <span className="current" data-testid="apply-progress-name" title={applyProgress?.current ?? ''}>
                {applyProgress?.current || '—'}
              </span>
              <button className="btn btn-ghost" type="button" data-testid="apply-cancel" onClick={() => void cancelApply()}>
                {t('preview.cancel')}
              </button>
            </div>
            <div className="progress-bar"><span style={{ width: `${progressPercent}%` }} /></div>
          </div>
        )}
        <div className="dialog-foot">
          <span style={{ fontSize: 11.5, color: 'var(--ds-color-text-2)' }} data-testid="preview-summary">
            {t('preview.summary', {
              total: preview.counts.total,
              conflict: preview.counts.conflict,
              invalid: preview.counts.invalid,
            })}
          </span>
          <div className="right">
            <button className="btn btn-ghost" type="button" data-testid="preview-export" onClick={() => void exportList()}>
              <Icon name="save" />{t('preview.export')}
            </button>
            <button className="btn btn-ghost" type="button" onClick={closePreview}>{t('preview.cancel')}</button>
            <button
              className="btn btn-primary"
              type="button"
              data-testid="preview-confirm"
              disabled={applying || !rows.length}
              onClick={() => void applyRows(preview.rows, policy)}
            >
              <Icon name="play" />{applying ? t('preview.executing') : isDemo ? t('preview.demoExec') : t('preview.confirm')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
