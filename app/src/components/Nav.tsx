import { useState } from 'react';
import { useApp } from '../store';
import { useTranslation } from '../i18n';
import { Icon, type IconName } from './Icon';
import { tabCount } from './ListView';
import type { ListTab, PageId } from '../lib/types';

interface NavEntry {
  id: string;
  label: string;
  icon: IconName;
  count?: number;
  active?: boolean;
  /** 功能说明（页面标题/行为）；为空表示纯导航 */
  hint?: string;
  action?: () => void;
}

/** 左侧导航：元数据入口打开真实编辑器页，属性/时间/归类打开独立功能页。 */
export function Nav({ onNavigate, open }: { onNavigate?: () => void; open?: boolean }) {
  const { t } = useTranslation();
  const batches = useApp((s) => s.batches);
  const entries = useApp((s) => s.entries);
  const activePage = useApp((s) => s.activePage);
  const openPage = useApp((s) => s.openPage);
  const openDrawer = useApp((s) => s.openDrawer);
  const openPlanExport = useApp((s) => s.openPlanExport);
  const openSnapshots = useApp((s) => s.openSnapshots);
  const selected = entries.filter((e) => e.selected && !e.isDir).length;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const meta = (tab: ListTab, page: PageId) => ({
    count: tabCount(tab, entries),
    active: activePage === page,
    hint: t('nav.metaEditHint'),
    action: () => openPage(page),
  });

  const go = (action: () => void) => () => {
    action();
    onNavigate?.();
  };

  const groups: Array<{ id: string; label: string; items: NavEntry[] }> = [
    {
      id: 'meta',
      label: t('nav.metaGroup'),
      items: [
        { id: 'music', label: t('nav.music'), icon: 'music', ...meta('music', 'music') },
        { id: 'image', label: t('nav.image'), icon: 'image', ...meta('photo', 'image') },
        { id: 'office', label: t('nav.office'), icon: 'doc', ...meta('office', 'office') },
        { id: 'text', label: t('nav.text'), icon: 'text', ...meta('text', 'text') },
      ],
    },
    {
      id: 'ops',
      label: t('nav.opsGroup'),
      items: [
        {
          id: 'attrs', label: t('nav.attrs'), icon: 'grid', count: selected, active: activePage === 'attrs',
          hint: t('nav.opsAttrsHint'), action: go(() => openPage('attrs')),
        },
        {
          id: 'times', label: t('nav.times'), icon: 'clock', count: selected, active: activePage === 'times',
          hint: t('nav.opsTimesHint'), action: go(() => openPage('times')),
        },
        {
          id: 'organize', label: t('nav.organize'), icon: 'folder', count: selected, active: activePage === 'organize',
          hint: t('nav.opsMoveHint'), action: go(() => openPage('organize')),
        },
      ],
    },
  ];

  return (
    <aside className={`nav${open ? ' open' : ''}`}>
      {groups.map((group) => {
        const isCollapsed = Boolean(collapsed[group.id]);
        return (
          <div className="nav-group" key={group.id}>
            <div
              className="nav-label"
              role="button"
              tabIndex={0}
              aria-expanded={!isCollapsed}
              title={group.id === 'meta' ? t('nav.metaHint') : group.label}
              data-testid={`nav-group-${group.id}`}
              onClick={() => setCollapsed((prev) => ({ ...prev, [group.id]: !isCollapsed }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') setCollapsed((prev) => ({ ...prev, [group.id]: !isCollapsed }));
              }}
            >
              <span>{group.label}</span>
              <span className={`chev${isCollapsed ? ' down' : ''}`}>▾</span>
            </div>
            {!isCollapsed && group.items.map((item) => (
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
        );
      })}
      <div className="nav-foot">
        <div className="nav-item" role="button" tabIndex={0} onClick={go(() => openDrawer('history'))} data-testid="nav-history">
          <Icon name="history" />
          {t('nav.history')}
          {batches.length > 0 && <span className="count">{batches.length}</span>}
        </div>
        <div
          className="nav-item"
          role="button"
          tabIndex={0}
          onClick={go(openPlanExport)}
          title={t('nav.planHint')}
          data-testid="nav-plan"
        >
          <Icon name="save" />
          {t('nav.plan')}
        </div>
        <div
          className="nav-item"
          role="button"
          tabIndex={0}
          onClick={go(() => void openSnapshots())}
          title={t('nav.snapshotHint')}
          data-testid="nav-snapshot"
        >
          <Icon name="history" />
          {t('nav.snapshot')}
        </div>
        <div className="nav-item" role="button" tabIndex={0} onClick={go(() => openDrawer('settings'))} data-testid="nav-settings">
          <Icon name="settings" />
          {t('nav.settings')}
        </div>
        <div className="nav-hint">{t('nav.hint')}</div>
      </div>
    </aside>
  );
}
