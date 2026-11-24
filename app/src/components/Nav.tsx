import { useState } from 'react';
import { useApp } from '../store';
import { useTranslation } from '../i18n';
import { Icon, type IconName } from './Icon';
import type { ListTab } from '../lib/types';

interface NavEntry {
  id: string;
  label: string;
  icon: IconName;
  count?: number;
  active?: boolean;
  /** 功能说明（入口行为），作为悬停提示 */
  hint?: string;
  action?: () => void;
}

/**
 * 左侧导航只剩一组「文件」：工作台视图与三类记录。
 * 六类改文件的动作全部由底部检查器的分段承担，侧栏不再重复一遍。
 */
export function Nav({
  onNavigate,
  narrow,
  expanded,
  onToggle,
}: {
  onNavigate?: () => void;
  /** 窄窗：默认收成一列常驻图标（高亮当前栏目），可原位展开 */
  narrow?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const { t } = useTranslation();
  const batches = useApp((s) => s.batches);
  const listTab = useApp((s) => s.listTab);
  const setListTab = useApp((s) => s.setListTab);
  const openDrawer = useApp((s) => s.openDrawer);
  const openPlans = useApp((s) => s.openPlans);
  const openSnapshots = useApp((s) => s.openSnapshots);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const go = (action: () => void) => () => {
    action();
    onNavigate?.();
  };

  const view = (tab: ListTab): NavEntry => ({
    id: 'rename',
    label: t('nav.rename'),
    icon: 'file',
    active: listTab === tab,
    hint: t('nav.renameHint'),
    action: go(() => setListTab(tab)),
  });

  const groups: Array<{ id: string; label: string; items: NavEntry[] }> = [
    {
      id: 'files',
      label: t('nav.filesGroup'),
      items: [
        view('rename'),
        {
          id: 'history', label: t('nav.history'), icon: 'history', count: batches.length,
          hint: t('nav.historyHint'), action: go(() => openDrawer('history')),
        },
        {
          id: 'snapshot', label: t('nav.snapshot'), icon: 'history',
          hint: t('nav.snapshotHint'), action: go(() => void openSnapshots()),
        },
        {
          id: 'plan', label: t('nav.plan'), icon: 'save',
          hint: t('nav.planHint'), action: go(openPlans),
        },
      ],
    },
  ];

  const collapsedItems = narrow && !expanded;

  return (
    <aside className={`nav${narrow ? ' rail' : ''}`}>
      {narrow && (
        <button
          className="nav-rail-toggle"
          type="button"
          data-testid="nav-rail-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? t('nav.collapse') : t('nav.expand')}
          title={expanded ? t('nav.collapse') : t('nav.expand')}
          onClick={onToggle}
        >
          <Icon name={expanded ? 'x' : 'menu'} />
        </button>
      )}
      {groups.map((group) => {
        const isCollapsed = Boolean(collapsed[group.id]) && !collapsedItems;
        return (
          <div className="nav-group" key={group.id}>
            <div
              className="nav-label"
              role="button"
              tabIndex={0}
              aria-expanded={!isCollapsed}
              title={group.label}
              data-testid={`nav-group-${group.id}`}
              onClick={() => setCollapsed((prev) => ({ ...prev, [group.id]: !isCollapsed }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setCollapsed((prev) => ({ ...prev, [group.id]: !isCollapsed }));
              }}
            >
              <span>{group.label}</span>
              <span className={`chev${isCollapsed ? ' down' : ''}`}>▾</span>
            </div>
            <div
              className={`nav-items${isCollapsed ? ' collapsed' : ''}`}
              data-testid={`nav-items-${group.id}`}
            >
              <div className="nav-items-inner" inert={isCollapsed}>
                {group.items.map((item) => (
                  <div
                    key={item.id}
                    className={`nav-item${item.active ? ' active' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={item.action ?? (() => undefined)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') item.action?.();
                    }}
                    title={item.hint ?? item.label}
                    aria-current={item.active ? 'true' : undefined}
                    data-testid={`nav-${item.id}`}
                  >
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                    {item.count !== undefined && <span className="count">{item.count}</span>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}
      {/* 「设置」下沉到工具栏「更多」菜单：HIG 不建议把关键入口压在侧栏底部 */}
    </aside>
  );
}
