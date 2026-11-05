import { isDesktop } from '../lib/bridge';
import { PRODUCT_NAME } from '../lib/branding';
import { useTranslation } from '../i18n';
import { useApp } from '../store';
import { Icon } from './Icon';

async function windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void> {
  if (!isDesktop) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  if (action === 'minimize') await win.minimize();
  else if (action === 'maximize') await win.toggleMaximize();
  else await win.close();
}

export function Titlebar() {
  const { t } = useTranslation();
  const rules = useApp((s) => s.rules);
  const isDemo = useApp((s) => s.isDemo);
  const os = useApp((s) => s.env.os);
  const theme = useApp((s) => s.settings.theme);
  const setTheme = useApp((s) => s.setTheme);
  const showToast = useApp((s) => s.showToast);

  const act = (action: 'minimize' | 'maximize' | 'close') => () => {
    if (!isDesktop) {
      showToast('info', t('title.demoNoWindow'));
      return;
    }
    // 不吞异常：权限缺失、平台不支持等情况要显式提示，否则表现为“点了没反应”
    windowAction(action).catch((err: unknown) => {
      const text = err instanceof Error ? err.message : String(err);
      console.error(`window.action.failed ${action}`, err);
      showToast('error', t('title.failed', { action, message: text }));
    });
  };

  return (
    <div className="titlebar" data-tauri-drag-region>
      <span className="tb-mark"><Icon name="mark" size={13} /></span>
      <span className="tb-title" data-tauri-drag-region>{PRODUCT_NAME}</span>
      <span className="tb-crumb" data-tauri-drag-region>
        <span style={{ color: 'var(--muted-2)' }}>›</span>
        <span className="pill-scheme">
          <Icon name="layers" size={11} />
          {t('title.rules')} {rules.length ? t('title.rulesCount', { count: rules.length }) : t('title.none')}
        </span>
        <span style={{ color: 'var(--muted-2)' }}>{t('title.previewOnly')}</span>
      </span>
      <div className="tb-spacer" data-tauri-drag-region />
      {isDemo && (
        <span className="chip chip-warn" style={{ height: 23, fontSize: 11 }}>
          {t('title.demoChip')}
        </span>
      )}
      <span className="chip" style={{ height: 23, fontSize: 11 }}>
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--success)' }} />
        {t('title.localChip')}
      </span>
      <button
        className="btn-icon"
        type="button"
        title={theme === 'light' ? t('title.themeDark') : t('title.themeLight')}
        style={{ width: 28, height: 24, marginLeft: 4 }}
        onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
      >
        {theme === 'light' ? '◐' : '☀'}
      </button>
      {os !== 'macos' && (
        <div className="win-controls" style={{ marginLeft: 4 }}>
          <span title={t('title.minimize')} data-testid="win-min" onClick={act('minimize')}>
            <Icon name="minus" size={12} />
          </span>
          <span title={t('title.maximize')} data-testid="win-max" onClick={act('maximize')}>
            <Icon name="maximize" size={12} />
          </span>
          <span className="close" title={t('title.close')} data-testid="win-close" onClick={act('close')}>
            <Icon name="x" size={12} />
          </span>
        </div>
      )}
    </div>
  );
}
