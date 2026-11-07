import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../i18n';
import type { LayoutView } from '../lib/types';
import { useApp } from '../store';
import { Icon } from './Icon';

const VIEWS: LayoutView[] = ['files-left', 'rules-left', 'files-top', 'rules-top', 'compact'];

/**
 * 预设布局切换：文件在左 / 规则在左 / 上下两种 / 紧凑单列。
 * 选择与「高级」开关随设置持久化；菜单用 portal 渲染，任何视图下都不会被裁切。
 */
export function LayoutSwitch() {
  const { t } = useTranslation();
  const layout = useApp((s) => s.settings.layout);
  const setLayout = useApp((s) => s.setLayout);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

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
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
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

  return (
    <div className="layout-switch">
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-ghost layout-trigger"
        data-testid="layout-switch"
        aria-haspopup="menu"
        aria-expanded={!!pos}
        title={t('layout.title')}
        onClick={() => (pos ? close() : open())}
      >
        <Icon name="grid" size={13} />
        <span>{t(`layout.${layout.view}`)}</span>
      </button>
      {pos && createPortal(
        <div
          ref={menuRef}
          className="layout-pop"
          role="menu"
          aria-label={t('layout.title')}
          data-testid="layout-menu"
          style={{ top: pos.top, left: pos.left }}
        >
          {VIEWS.map((view) => (
            <button
              key={view}
              type="button"
              role="menuitemradio"
              aria-checked={layout.view === view}
              className={`layout-item ${layout.view === view ? 'active' : ''}`}
              data-testid={`layout-option-${view}`}
              onClick={() => { setLayout({ view }); close(); }}
            >
              <Icon name={view === 'compact' ? 'minus' : 'grid'} size={12} />
              <span>{t(`layout.${view}`)}</span>
              {layout.view === view && <Icon name="check" size={12} />}
            </button>
          ))}
          <div className="layout-sep" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={layout.advanced}
            className={`layout-item ${layout.advanced ? 'active' : ''}`}
            data-testid="layout-advanced"
            onClick={() => setLayout({ advanced: !layout.advanced })}
          >
            <span className={`checkbox ${layout.advanced ? 'on' : ''}`} aria-hidden="true" />
            <span>{t('layout.advanced')}</span>
            {layout.advanced && <Icon name="check" size={12} />}
          </button>
          <div className="layout-hint">{t('layout.advancedHint')}</div>
        </div>,
        document.body,
      )}
    </div>
  );
}
