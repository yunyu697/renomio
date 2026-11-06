import { usePreview } from '../hooks/usePreview';
import { useTranslation } from '../i18n';
import { useApp } from '../store';
import { Icon } from './Icon';

export function StatusBar() {
  const { t } = useTranslation();
  const env = useApp((s) => s.env);
  const isDemo = useApp((s) => s.isDemo);
  const entries = useApp((s) => s.entries);
  const rules = useApp((s) => s.rules);
  const applying = useApp((s) => s.applying);
  const applyProgress = useApp((s) => s.applyProgress);
  const scanning = useApp((s) => s.scanning);
  const preview = usePreview();
  const conflicts = preview.counts.conflict;

  const osLabel = { windows: 'Windows', macos: 'macOS', linux: 'Linux' }[env.os];
  const sizeSensitive = env.caseSensitive ? t('status.caseSensitive') : t('status.caseInsensitive');

  return (
    <div className="statusbar">
      <span>
        {scanning
          ? t('status.scanning')
          : applying
            ? applyProgress
              ? `${t('status.applying', { done: applyProgress.done, total: applyProgress.total })}${applyProgress.current ? ` · ${applyProgress.current}` : ''}`
              : t('status.executing')
            : conflicts ? t('action.conflicts', { count: conflicts }) : t('status.ready')}
      </span>
      <span className="sep" />
      <span>{entries.length ? t('status.objects', { count: entries.length }) : t('status.noFiles')}</span>
      <span className="sep" />
      <span>{t('status.ruleOrder', { order: rules.length ? rules.map((r, i) => (r.enabled ? i + 1 : '–')).join(' → ') : t('title.none') })}</span>
      <div className="right">
        {isDemo && <span style={{ color: 'var(--warn)' }}>{t('status.demo')}</span>}
        <span>{osLabel} · {sizeSensitive}</span>
        <span className="sep" />
        <span title={env.dataDir}><Icon name="shield" size={12} /> {t('status.local')}</span>
        <span className="sep" />
        <span>v{__APP_VERSION__}</span>
      </div>
    </div>
  );
}
