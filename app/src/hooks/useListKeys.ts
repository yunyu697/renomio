/**
 * 列表键盘：方向键 / Home / End / 空格 / Enter / F2 / Delete / Ctrl+A / Esc。
 * 只在列表容器获得焦点时生效，处理过的键 stopPropagation，避免与全局快捷键抢。
 */
import { useCallback, useRef } from 'react';

interface Options {
  onMove: (delta: number, extend: boolean) => void;
  onEdge: (where: 'start' | 'end', extend: boolean) => void;
  onToggle: () => void;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  onSelectAll: () => void;
  onClear: () => void;
}

export function useListKeys(options: Options) {
  const optsRef = useRef(options);
  optsRef.current = options;

  return useCallback((event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    const o = optsRef.current;
    const mod = event.ctrlKey || event.metaKey;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };

    if ((event.key === 'a' || event.key === 'A') && mod) {
      handled();
      o.onSelectAll();
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        handled();
        o.onMove(1, event.shiftKey);
        return;
      case 'ArrowUp':
        handled();
        o.onMove(-1, event.shiftKey);
        return;
      case 'Home':
        handled();
        o.onEdge('start', event.shiftKey);
        return;
      case 'End':
        handled();
        o.onEdge('end', event.shiftKey);
        return;
      case ' ':
        handled();
        o.onToggle();
        return;
      case 'Enter':
        handled();
        o.onOpen();
        return;
      case 'F2':
        handled();
        o.onRename();
        return;
      case 'Delete':
        handled();
        o.onDelete();
        return;
      case 'Escape':
        handled();
        o.onClear();
        return;
      default:
        return;
    }
  }, []);
}
