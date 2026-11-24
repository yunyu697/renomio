import { usePreview } from '../hooks/usePreview';
import { useTranslation } from '../i18n';
import { useApp } from '../store';
import { Icon } from './Icon';

/**
 * 底部执行条（合并了原状态栏）。
 * HIG：底栏只放「与当前选中内容直接相关」的少量信息，其余（平台、数据目录、版本号）属于设置/关于。
 * 因此这里只保留：选中计数 · 当前批次状态 · 冲突提示 · 三个与选中项直接相关的动作。
 */
export function ActionBar() {
  const { t } = useTranslation();
  const entries = useApp((s) => s.entries);
  const openPreview = useApp((s) => s.openPreview);
  const undoLast = useApp((s) => s.undoLast);
  const applying = useApp((s) => s.applying);
  const applyProgress = useApp((s) => s.applyProgress);
  const scanning = useApp((s) => s.scanning);
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

  const statusText = scanning
    ? t('status.scanning')
    : applying
      ? applyProgress
        ? `${t('status.applying', { done: applyProgress.done, total: applyProgress.total })}${applyProgress.current ? ` · ${applyProgress.current}` : ''}`
        : t('status.executing')
      : t('status.ready');

  return (
    <div className="actionbar">
      <div className="selection">
        <span data-testid="status-selected">{t('status.selected', { count: selected })}</span>
        <span className="sep" />
        <span className="state">{statusText}</span>
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
        <span style={{ fontSize: 11.5, color: 'var(--ds-color-text-2)' }}>{t('action.readonlySkip', { count: skippedReadonly })}</span>
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
