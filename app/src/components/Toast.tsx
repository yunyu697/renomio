import { useTranslation } from '../i18n';
import { useApp } from '../store';
import { Icon, type IconName } from './Icon';

const ICON: Record<string, IconName> = {
  info: 'info', success: 'check', warn: 'alert', error: 'ban',
};

export function Toast() {
  const { t } = useTranslation();
  const toast = useApp((s) => s.toast);
  const dismissToast = useApp((s) => s.dismissToast);
  if (!toast) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      <div className={`toast ${toast.kind}`} onClick={dismissToast} data-testid="toast">
        <Icon name={ICON[toast.kind] ?? 'info'} size={17} className="ic" />
        <div className="body" data-testid="toast-text">{toast.text}</div>
        <button className="toast-x" type="button" onClick={dismissToast} aria-label={t('common.close')}>
          <Icon name="x" size={12} />
        </button>
      </div>
    </div>
  );
}
