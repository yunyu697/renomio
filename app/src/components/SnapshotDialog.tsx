import { useTranslation } from '../i18n';
import { useApp } from '../store';
import { Icon } from './Icon';

const REASON_KEYS: Record<string, string> = {
  'already-original': 'snapshot.reasonAlready',
  occupied: 'snapshot.reasonOccupied',
  missing: 'snapshot.reasonMissing',
  changed: 'snapshot.reasonChanged',
  'bad-path': 'snapshot.reasonBadPath',
};

function formatTime(ms: number, locale: string) {
  try {
    return new Date(ms).toLocaleString(locale);
  } catch {
    return new Date(ms).toISOString();
  }
}

/** 快照窗：生成（可选 SHA-256）、列表、还原预览与逐条结果。 */
export function SnapshotDialog() {
  const { t, locale } = useTranslation();
  const open = useApp((s) => s.snapshotOpen);
  const close = useApp((s) => s.closeSnapshots);
  const snapshots = useApp((s) => s.snapshots);
  const busy = useApp((s) => s.snapshotBusy);
  const withHash = useApp((s) => s.snapshotHash);
  const setWithHash = useApp((s) => s.setSnapshotHash);
  const progress = useApp((s) => s.snapshotProgress);
  const plan = useApp((s) => s.snapshotPlan);
  const planFor = useApp((s) => s.snapshotPlanFor);
  const result = useApp((s) => s.snapshotResult);
  const createNow = useApp((s) => s.createSnapshotNow);
  const cancelNow = useApp((s) => s.cancelSnapshotNow);
  const previewRestore = useApp((s) => s.previewSnapshotRestore);
  const confirmRestore = useApp((s) => s.confirmSnapshotRestore);
  const cancelPlan = useApp((s) => s.cancelSnapshotPlan);
  const removeItem = useApp((s) => s.deleteSnapshotItem);

  if (!open) return null;

  const restorable = (plan ?? []).filter((p) => p.action === 'restore').length;
  const planSkipped = (plan ?? []).length - restorable;
  const totalDone = result ? result.restored.length : 0;

  return (
    <div className="modal-mask" onClick={close}>
      <div className="dialog snapshot-dialog" data-testid="snapshot-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h4>
            <Icon name="history" size={16} style={{ color: 'var(--accent)' }} />
            {t('snapshot.title')}
          </h4>
          <p>{t('snapshot.subtitle')}</p>
        </div>

        <div className="dialog-body">
          <div className="snapshot-toolbar">
            <label className="check">
              <input
                type="checkbox"
                data-testid="snapshot-hash"
                checked={withHash}
                disabled={busy}
                onChange={(e) => setWithHash(e.target.checked)}
              />
              <span>{t('snapshot.hash')}</span>
            </label>
            <span className="snapshot-hint">{t('snapshot.hashHint')}</span>
            <button
              className="btn btn-primary"
              type="button"
              data-testid="snapshot-create"
              disabled={busy}
              onClick={() => void createNow()}
            >
              {t('snapshot.create')}
            </button>
          </div>

          {busy && (
            <div className="snapshot-progress" data-testid="snapshot-progress">
              <span className="snapshot-progress-text">
                {t('snapshot.progress', {
                  done: progress?.done ?? 0,
                  total: progress?.total ?? 0,
                })}
              </span>
              <span className="snapshot-progress-current" title={progress?.current ?? ''}>
                {progress?.current ?? ''}
              </span>
              <button className="btn btn-outline" type="button" data-testid="snapshot-cancel" onClick={() => void cancelNow()}>
                {t('snapshot.cancel')}
              </button>
            </div>
          )}

          {!snapshots.length && !plan && !result && (
            <div className="snapshot-empty" data-testid="snapshot-empty">
              {t('snapshot.empty')}
            </div>
          )}

          {snapshots.length > 0 && (
            <div className="snapshot-list">
              {snapshots.map((item) => (
                <div className="snapshot-item" key={item.id} data-testid={`snapshot-item-${item.id}`}>
                  <div className="snapshot-item-main">
                    <span className="snapshot-item-time">
                      <Icon name="clock" size={13} />
                      {formatTime(item.createdAt, locale)}
                    </span>
                    <span className="snapshot-item-meta">
                      {t('snapshot.entriesN', { count: item.entryCount })}
                      {' · '}
                      {item.hashed ? t('snapshot.hashedN', { count: item.hashed }) : t('snapshot.noHash')}
                      {item.skipped ? ' · ' + t('snapshot.skippedN', { count: item.skipped }) : ''}
                    </span>
                  </div>
                  <div className="snapshot-item-actions">
                    <button
                      className="btn btn-outline"
                      type="button"
                      data-testid={`snapshot-preview-${item.id}`}
                      disabled={busy}
                      onClick={() => void previewRestore(item.id)}
                    >
                      {t('snapshot.preview')}
                    </button>
                    <button
                      className="btn btn-ghost"
                      type="button"
                      data-testid={`snapshot-delete-${item.id}`}
                      disabled={busy}
                      onClick={() => void removeItem(item.id)}
                    >
                      <Icon name="trash" size={13} />
                      {t('snapshot.delete')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {plan && (
            <div className="snapshot-plan" data-testid="snapshot-plan">
              <div className="snapshot-section-head">
                <span>{t('snapshot.previewTitle', { count: restorable, skipped: planSkipped })}</span>
                <span className="snapshot-hint">{t('snapshot.previewHint')}</span>
              </div>
              <div className="snapshot-rows">
                {plan.map((row) => (
                  <div className={`snapshot-row ${row.action === 'skip' ? 'skip' : ''}`} key={row.id}>
                    <span className="snapshot-row-to" title={row.to}>
                      {row.to}
                    </span>
                    <span className="snapshot-arrow">→</span>
                    <span className="snapshot-row-from" title={row.from}>
                      {row.from}
                    </span>
                    <span className="snapshot-row-state">
                      {row.action === 'restore'
                        ? row.hashCheck
                          ? t('snapshot.stateRestoreHashed')
                          : t('snapshot.stateRestore')
                        : t(REASON_KEYS[row.reasonCode ?? ''] ?? 'snapshot.stateSkip')}
                    </span>
                  </div>
                ))}
              </div>
              <div className="snapshot-plan-actions">
                <button className="btn btn-outline" type="button" onClick={cancelPlan} disabled={busy}>
                  {t('common.cancel')}
                </button>
                <button
                  className="btn btn-primary"
                  type="button"
                  data-testid="snapshot-restore-confirm"
                  disabled={busy || restorable === 0}
                  onClick={() => void confirmRestore()}
                >
                  {t('snapshot.restore', { count: restorable })}
                </button>
              </div>
            </div>
          )}

          {result && (
            <div className="snapshot-result" data-testid="snapshot-result">
              <div className="snapshot-section-head">
                <span>
                  {t('snapshot.resultTitle', { restored: totalDone, skipped: result.skipped.length + result.failed.length })}
                </span>
                {result.batch && <span className="snapshot-hint">{t('snapshot.undoable', { id: result.batch.id })}</span>}
              </div>
              {result.batch && <div className="snapshot-hint">{t('snapshot.batchHint')}</div>}
              <div className="snapshot-rows">
                {result.restored.map((c) => (
                  <div className="snapshot-row" key={c.id}>
                    <span className="snapshot-row-to" title={c.from}>
                      {c.from}
                    </span>
                    <span className="snapshot-arrow">→</span>
                    <span className="snapshot-row-from" title={c.to}>
                      {c.to}
                    </span>
                    <span className="snapshot-row-state ok">{t('snapshot.stateDone')}</span>
                  </div>
                ))}
                {[...result.skipped, ...result.failed].map((c, index) => (
                  <div className="snapshot-row skip" key={`${c.id}-${index}`}>
                    <span className="snapshot-row-to" title={c.source}>
                      {c.source}
                    </span>
                    <span className="snapshot-row-state">{t('snapshot.stateSkipped', { reason: c.reason })}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="dialog-foot">
          <span className="snapshot-hint">{planFor ? t('snapshot.previewFoot') : t('snapshot.foot')}</span>
          <div className="right">
            <button className="btn btn-outline" type="button" data-testid="snapshot-close" onClick={close}>
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
