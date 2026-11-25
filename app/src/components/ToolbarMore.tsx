import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../i18n';
import { useApp } from '../store';
import { Icon } from './Icon';

/**
 * 工具栏末尾的「更多」菜单。
 * HIG：低频命令不进工具栏，收进「更多」；变宽变窄时只由系统/本品做溢出，不额外造一条工具栏。
 * 这里承接「筛选跳转」「快捷键帮助」「设置」三件低频事。
 */
export function ToolbarMore() {
  const { t } = useTranslation();
  const openDrawer = useApp((s) => s.openDrawer);
  const openShortcuts = useApp((s) => s.openShortcuts);
  const openCommands = useApp((s) => s.openCommands);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const close = () => setPos(null);

  const open = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // 靠右对齐：菜单右缘贴住触发按钮，避免在窄窗里冲出屏幕
    setPos({ top: rect.bottom + 6, left: Math.max(8, rect.right - 208) });
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
    <div className="tb-more">
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-icon"
        data-testid="toolbar-more"
        aria-haspopup="menu"
        aria-expanded={!!pos}
        title={t('toolbar.more')}
        onClick={() => (pos ? close() : open())}
      >
        <Icon name="more" />
      </button>
      {pos && createPortal(
        <div
          ref={menuRef}
          className="pop-menu"
          role="menu"
          aria-label={t('toolbar.more')}
          data-testid="toolbar-more-menu"
          style={{ top: pos.top, left: pos.left }}
        >
          <button
            type="button"
            role="menuitem"
            className="pop-item"
            data-testid="open-commands"
            onClick={() => { close(); openCommands(); }}
          >
            <Icon name="bolt" size={14} />
            <span>{t('toolbar.commands')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="pop-item"
            data-testid="open-shortcuts"
            onClick={() => { close(); openShortcuts(); }}
          >
            <Icon name="help" size={14} />
            <span>{t('toolbar.shortcuts')}</span>
          </button>
          <div className="pop-sep" />
          <button
            type="button"
            role="menuitem"
            className="pop-item"
            data-testid="open-settings"
            onClick={() => { close(); openDrawer('settings'); }}
          >
            <Icon name="settings" size={14} />
            <span>{t('toolbar.settings')}</span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
