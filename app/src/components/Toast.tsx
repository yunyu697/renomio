import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n';
import { useApp } from '../store';
import { Icon, type IconName } from './Icon';

const ICON: Record<string, IconName> = {
  info: 'info', success: 'check', warn: 'alert', error: 'ban',
};

/** 检查器是列表下方的底部抽屉：它展开时提示条要抬到它上面，不许压住抽屉右下角（§1.17） */
function useDockLift(active: boolean) {
  const [lift, setLift] = useState(0);
  useEffect(() => {
    if (!active) {
      setLift(0);
      return undefined;
    }
    const measure = () => {
      const dock = document.querySelector('[data-testid="inspector"]');
      if (!dock) {
        setLift(0);
        return;
      }
      const box = dock.getBoundingClientRect();
      // 检查器贴着窗口底部时，按「窗口高 − 检查器顶边 + 缝隙」抬升；收起成 36px 头部时自然落回原位
      setLift(Math.max(0, Math.round(window.innerHeight - box.top + 12)));
    };
    measure();
    const dock = document.querySelector('[data-testid="inspector"]');
    const ro = dock && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (dock) ro?.observe(dock);
    // 提示条存活期间检查器可能挂载 / 收起 / 切换分段，都重新量一次
    const mo = new MutationObserver(measure);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-collapsed', 'data-mode'] });
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [active]);
  return lift;
}

export function Toast() {
  const { t } = useTranslation();
  const toast = useApp((s) => s.toast);
  const dismissToast = useApp((s) => s.dismissToast);
  const drawer = useApp((s) => s.drawer);
  const lift = useDockLift(Boolean(toast));
  if (!toast) return null;
  return (
    <div
      className="toast-host"
      role="status"
      aria-live="polite"
      data-drawer={drawer ? '1' : '0'}
      style={lift ? { bottom: `${lift}px` } : undefined}
    >
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
