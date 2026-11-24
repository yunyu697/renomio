import { useEffect, useState } from 'react';
import { isDesktop } from '../lib/bridge';
import { PRODUCT_NAME } from '../lib/branding';
import { useTranslation } from '../i18n';
import { useApp } from '../store';
import { BrandMark } from './BrandMark';
import { Icon } from './Icon';

async function windowAction(action: 'minimize' | 'maximize' | 'close'): Promise<void> {
  if (!isDesktop) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  if (action === 'minimize') await win.minimize();
  else if (action === 'maximize') await win.toggleMaximize();
  else await win.close();
}

/**
 * 自绘标题栏（仅 Windows / Linux 使用）。
 * macOS 走系统原生标题栏（红绿灯、标题由系统绘制），再叠一层自绘条会重复窗口框架，
 * 正是 HIG「不要创建自定义窗口用户界面」反对的形态。
 *
 * 这一行只回答「这是哪个 App」：不放规则数量、预览模式、版本号这类状态——
 * 状态属于内容区（执行条 / 检查器），标题栏只做窗口身份与拖动。
 */
export function Titlebar() {
  const { t } = useTranslation();
  const os = useApp((s) => s.env.os);
  const theme = useApp((s) => s.settings.theme);
  const setTheme = useApp((s) => s.setTheme);
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    try {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => setSystemDark(media.matches);
      onChange();
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    } catch {
      return undefined;
    }
  }, []);
  const effective = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
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

  if (os === 'macos') return null;

  return (
    <div className="titlebar" data-tauri-drag-region>
      <BrandMark size={16} />
      <span className="tb-title" data-tauri-drag-region>{PRODUCT_NAME}</span>
      <div className="tb-spacer" data-tauri-drag-region />
      <button
        className="btn-icon tb-theme"
        type="button"
        title={effective === 'light' ? t('title.themeDark') : t('title.themeLight')}
        onClick={() => setTheme(effective === 'light' ? 'dark' : 'light')}
      >
        {effective === 'light' ? '◐' : '☀'}
      </button>
      {os === 'windows' && (
        <div className="win-controls">
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
