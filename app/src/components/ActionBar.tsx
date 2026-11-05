import { usePreview } from '../hooks/usePreview';
import { useTranslation } from '../i18n';
import { useApp } from '../store';
import { Icon } from './Icon';

export function ActionBar() {
  const { t } = useTranslation();
  const entries = useApp((s) => s.entries);
  const openPreview = useApp((s) => s.openPreview);
  const undoLast = useApp((s) => s.undoLast);
  const applying = useApp((s) => s.applying);
  const undoBusy = useApp((s) => s.undoBusy);
  const batches = useApp((s) => s.batches);
  const readonlySkip = useApp((s) => s.settings.readonlySkip);
  const preview = usePreview();

  const selected = entries.filter((e) => e.selected).length;
  const canUndo = batches.some((b) => b.state === 'completed' || b.state === 'partial' || b.state === 'pending');
  const skippedReadonly = readonlySkip
    ? preview.rows.filter((r) => r.entry.selected && r.entry.readonly).length
    : 0;
  const actionable = preview.counts.ready + preview.counts.warn + preview.counts.conflict;

  return (
    <div className="actionbar">
      <div className="selection">
        {t('action.selected', { selected, total: entries.length })}
      </div>
      {preview.counts.conflict > 0 ? (
        <div className="conflict-chip">
          <Icon name="alert" size={14} />
          {t('action.conflicts', { count: preview.counts.conflict })}
        </div>
      ) : preview.counts.warn > 0 ? (
        <span className="chip chip-warn" style={{ height: 26 }}>
          <Icon name="alert" size={13} />{t('action.warn', { count: preview.counts.warn })}
        </span>
      ) : null}
      {skippedReadonly > 0 && (
        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t('action.readonlySkip', { count: skippedReadonly })}</span>
      )}
      <div className="spacer" />
      <div className="btns">
        <button className="btn btn-outline" type="button" data-testid="action-preview" onClick={openPreview} disabled={!entries.length}>
          <Icon name="eye" />{t('action.preview')}
        </button>
        <button className="btn btn-soft" type="button" data-testid="action-undo" onClick={() => void undoLast()} disabled={!canUndo || undoBusy || applying}>
          <Icon name="undo" />{t('action.undo')} <span className="kbd">Ctrl Z</span>
        </button>
        <button
          className="btn btn-primary"
          type="button"
          data-testid="action-apply"
          onClick={openPreview}
          disabled={!entries.length || !actionable || applying}
          title={actionable ? t('action.applyHint') : t('action.applyDisabled')}
        >
          <Icon name="play" />{t('action.apply')} <span className="kbd" style={{ background: 'rgba(255,255,255,.16)', borderColor: 'rgba(255,255,255,.25)', color: '#fff' }}>Ctrl ⏎</span>
        </button>
      </div>
    </div>
  );
}
