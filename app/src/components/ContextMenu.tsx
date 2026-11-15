/** 右键菜单：键盘可达、点外部关闭、贴边自动翻转。只负责渲染与导航，语义由调用方给。 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  disabled?: boolean;
  checked?: boolean;
  /** 在本项之前画一条分隔线 */
  separator?: boolean;
  children?: MenuItem[];
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onPick: (id: string) => void;
  onClose: () => void;
}

const EDGE = 4;
const SUB_WIDTH = 168;

export function ContextMenu({ x, y, items, onPick, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y, flipSub: false });
  const [active, setActive] = useState(-1);
  const [openSub, setOpenSub] = useState<string | null>(null);

  const sub = openSub ? items.find((item) => item.id === openSub)?.children ?? [] : [];
  const level = openSub ? sub : items;

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let left = x;
    let top = y;
    if (left + width > window.innerWidth - EDGE) left = Math.max(EDGE, x - width);
    if (top + height > window.innerHeight - EDGE) top = Math.max(EDGE, window.innerHeight - height - EDGE);
    const flipSub = left + width + SUB_WIDTH > window.innerWidth - EDGE;
    setPos((prev) =>
      prev.left === left && prev.top === top && prev.flipSub === flipSub ? prev : { left, top, flipSub },
    );
  }, [x, y]);

  useEffect(() => {
    const el = rootRef.current;
    el?.focus();
    const onDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onBlur = () => onClose();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, [onClose]);

  const move = useCallback(
    (delta: number) => {
      if (!level.length) return;
      setActive((current) => {
        let next = current;
        for (let step = 0; step < level.length; step += 1) {
          next = (next + delta + level.length) % level.length;
          if (!level[next].disabled) return next;
        }
        return current;
      });
    },
    [level],
  );

  const pick = useCallback(
    (item: MenuItem) => {
      if (item.disabled) return;
      if (item.children) {
        setOpenSub(item.id);
        setActive(0);
        return;
      }
      onPick(item.id);
      onClose();
    },
    [onPick, onClose],
  );

  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === 'ArrowRight') {
      const item = level[active];
      if (item?.children) {
        event.preventDefault();
        setOpenSub(item.id);
        setActive(0);
      }
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (openSub) {
        setOpenSub(null);
        setActive(items.findIndex((item) => item.id === openSub));
      } else {
        onClose();
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = level[active];
      if (item) pick(item);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const key = event.key.toLowerCase();
      const index = level.findIndex((item) => !item.disabled && item.label.toLowerCase().startsWith(key));
      if (index >= 0) setActive(index);
    }
  };

  const renderLevel = (list: MenuItem[], nested: boolean, activeIndex: number) => (
    <div className={`ctx-list ${nested ? 'nested' : ''}`} role="menu">
      {list.map((item, index) => (
        <div key={item.id}>
          {item.separator && <div className="ctx-sep" role="separator" />}
          <div
            className={`ctx-item ${item.disabled ? 'disabled' : ''} ${activeIndex === index ? 'on' : ''} ${item.children ? 'has-sub' : ''}`}
            role="menuitem"
            aria-disabled={item.disabled || undefined}
            data-menu-id={item.id}
            onPointerEnter={() => setActive(index)}
            onClick={() => pick(item)}
          >
            <span className="ctx-ico">{item.icon ? <Icon name={item.icon} size={12} /> : null}</span>
            <span className="ctx-label">{item.label}</span>
            {item.checked && <Icon name="check" size={11} />}
            {item.children && <span className="ctx-arrow">›</span>}
          </div>
        </div>
      ))}
    </div>
  );

  return createPortal(
    <div
      ref={rootRef}
      className={`ctx-menu ${pos.flipSub ? 'flip-sub' : ''}`}
      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
      role="menu"
      tabIndex={-1}
      data-testid="context-menu"
      onKeyDown={onKey}
      onContextMenu={(event) => event.preventDefault()}
    >
      {renderLevel(items, false, openSub ? -1 : active)}
      {openSub && (
        <div className="ctx-sub">
          {renderLevel(sub, true, active)}
        </div>
      )}
    </div>,
    document.body,
  );
}
