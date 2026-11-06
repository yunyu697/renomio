import { useApp } from '../store';
import { useTranslation } from '../i18n';
import { Icon, type IconName } from './Icon';

interface NavEntry {
  id: string;
  label: string;
  icon: IconName;
  count?: number;
  /** 已实现的功能说明；为空表示纯导航 */
  hint?: string;
  action?: () => void;
}

/** 左侧只保留「查看/整理」导航；规则的增删改排全部在右侧规则链模块内完成，避免两套入口。 */
export function Nav() {
  const { t } = useTranslation();
  const batches = useApp((s) => s.batches);
  const openDrawer = useApp((s) => s.openDrawer);
  const openOps = useApp((s) => s.openOps);
  const setListTab = useApp((s) => s.setListTab);
  const openPlanExport = useApp((s) => s.openPlanExport);

  const groups: Array<{ label: string; items: NavEntry[] }> = [
    {
      label: t('nav.metaGroup'),
      items: [
        { id: 'music', label: t('nav.music'), icon: 'music', action: () => setListTab('music') },
        { id: 'image', label: t('nav.image'), icon: 'image', action: () => setListTab('photo') },
        { id: 'office', label: t('nav.office'), icon: 'doc', action: () => setListTab('office') },
        { id: 'text', label: t('nav.text'), icon: 'text', action: () => setListTab('text') },
      ],
    },
    {
      label: t('nav.opsGroup'),
      items: [
        { id: 'attrs', label: t('nav.attrs'), icon: 'grid', action: () => openOps('attrs') },
        { id: 'times', label: t('nav.times'), icon: 'clock', action: () => openOps('time') },
        { id: 'organize', label: t('nav.organize'), icon: 'folder', action: () => openOps('move') },
      ],
    },
  ];

  return (
    <aside className="nav">
      {groups.map((group) => (
        <div className="nav-group" key={group.label}>
          <div className="nav-label">{group.label}</div>
          {group.items.map((item) => (
            <div
              key={item.id}
              className="nav-item"
              onClick={item.action ?? (() => undefined)}
              title={item.hint ?? item.label}
              data-testid={`nav-${item.id}`}
            >
              <Icon name={item.icon} />
              {item.label}
              {item.count !== undefined && <span className="count">{item.count}</span>}
            </div>
          ))}
        </div>
      ))}
      <div className="nav-foot">
        <div className="nav-item" onClick={() => openDrawer('history')} data-testid="nav-history">
          <Icon name="history" />
          {t('nav.history')}
          {batches.length > 0 && <span className="count">{batches.length}</span>}
        </div>
        <div
          className="nav-item"
          onClick={openPlanExport}
          title={t('nav.planHint')}
          data-testid="nav-plan"
        >
          <Icon name="save" />
          {t('nav.plan')}
        </div>
        <div className="nav-item" onClick={() => openDrawer('settings')} data-testid="nav-settings">
          <Icon name="settings" />
          {t('nav.settings')}
        </div>
        <div className="nav-hint">{t('nav.hint')}</div>
      </div>
    </aside>
  );
}
