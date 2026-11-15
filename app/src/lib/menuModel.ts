/**
 * 右键菜单模型：只描述「列表语义」的动作，不涉及磁盘操作。
 * 文案里不出现「删除文件 / 移动到回收站」之类会让用户误以为动了磁盘的词。
 */
import { t } from '../i18n';
import type { SortState } from './order';
import type { MenuItem } from '../components/ContextMenu';

export interface MenuState {
  multi: boolean;
  anyOverride: boolean;
  canPaste: boolean;
  density: 'comfortable' | 'compact';
  sort: SortState;
}

export interface MenuActions {
  open: () => void;
  reveal: () => void;
  rename: () => void;
  revertName: () => void;
  copy: () => void;
  cut: () => void;
  paste: () => void;
  remove: () => void;
  details: () => void;
  selectAll: () => void;
  deselect: () => void;
  refresh: () => void;
  sortBy: (key: 'name' | 'modified' | 'size') => void;
  sortManual: () => void;
  setDensity: (density: 'comfortable' | 'compact') => void;
}

function sortLabel(key: 'name' | 'modified' | 'size', sort: SortState): string {
  const base = t(`menu.sort${key[0].toUpperCase()}${key.slice(1)}`);
  if (sort.key !== key) return base;
  return `${base} ${sort.dir === 1 ? '↑' : '↓'}`;
}

export function rowMenuItems(state: MenuState): MenuItem[] {
  return [
    { id: 'open', label: t('menu.open'), icon: 'play' },
    { id: 'reveal', label: t('menu.reveal'), icon: 'folder', separator: true },
    { id: 'rename', label: t('menu.rename'), icon: 'tag', disabled: state.multi },
    {
      id: 'revert-name',
      label: t('menu.revertName'),
      icon: 'undo',
      disabled: !state.anyOverride,
    },
    { id: 'copy', label: t('menu.copy'), icon: 'save', separator: true },
    { id: 'cut', label: t('menu.cut'), icon: 'minus' },
    { id: 'paste', label: t('menu.paste'), icon: 'import', disabled: !state.canPaste },
    { id: 'remove', label: t('menu.remove'), icon: 'ban', separator: true },
    { id: 'details', label: t('menu.properties'), icon: 'info', separator: true },
  ];
}

export function blankMenuItems(state: MenuState): MenuItem[] {
  return [
    { id: 'select-all', label: t('menu.selectAll'), icon: 'check' },
    { id: 'deselect', label: t('menu.deselect'), icon: 'ban' },
    { id: 'paste', label: t('menu.paste'), icon: 'import', disabled: !state.canPaste, separator: true },
    {
      id: 'sort',
      label: t('menu.sort'),
      icon: 'sort',
      separator: true,
      children: [
        { id: 'sort-name', label: sortLabel('name', state.sort), checked: state.sort.key === 'name' },
        { id: 'sort-modified', label: sortLabel('modified', state.sort), checked: state.sort.key === 'modified' },
        { id: 'sort-size', label: sortLabel('size', state.sort), checked: state.sort.key === 'size' },
        { id: 'sort-none', label: t('menu.sortManual'), checked: state.sort.key === 'none', separator: true },
      ],
    },
    {
      id: 'density',
      label: t('menu.density'),
      icon: 'grid',
      children: [
        {
          id: 'density-comfortable',
          label: t('menu.densityComfortable'),
          checked: state.density === 'comfortable',
        },
        { id: 'density-compact', label: t('menu.densityCompact'), checked: state.density === 'compact' },
      ],
    },
    { id: 'refresh', label: t('menu.refresh'), icon: 'refresh', separator: true },
  ];
}

/** 把菜单点击分派成动作；MainPane 只负责传入真实能力。 */
export function dispatchMenu(id: string, actions: MenuActions): void {
  switch (id) {
    case 'open':
      actions.open();
      return;
    case 'reveal':
      actions.reveal();
      return;
    case 'rename':
      actions.rename();
      return;
    case 'revert-name':
      actions.revertName();
      return;
    case 'copy':
      actions.copy();
      return;
    case 'cut':
      actions.cut();
      return;
    case 'paste':
      actions.paste();
      return;
    case 'remove':
      actions.remove();
      return;
    case 'details':
      actions.details();
      return;
    case 'select-all':
      actions.selectAll();
      return;
    case 'deselect':
      actions.deselect();
      return;
    case 'refresh':
      actions.refresh();
      return;
    case 'sort-name':
      actions.sortBy('name');
      return;
    case 'sort-modified':
      actions.sortBy('modified');
      return;
    case 'sort-size':
      actions.sortBy('size');
      return;
    case 'sort-none':
      actions.sortManual();
      return;
    case 'density-comfortable':
      actions.setDensity('comfortable');
      return;
    case 'density-compact':
      actions.setDensity('compact');
      return;
    default:
      return;
  }
}
