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

export function Nav() {
  const { t } = useTranslation();
  const rules = useApp((s) => s.rules);
  const batches = useApp((s) => s.batches);
  const openDrawer = useApp((s) => s.openDrawer);
  const openOps = useApp((s) => s.openOps);
  const setListTab = useApp((s) => s.setListTab);
  const addRule = useApp((s) => s.addRule);
  const updateRule = useApp((s) => s.updateRule);
  const showToast = useApp((s) => s.showToast);
  const openPlanExport = useApp((s) => s.openPlanExport);

  /** 高级规则：直接插入一条正则替换规则，并在编辑器里默认勾选正则。 */
  const addAdvanced = () => {
    addRule('replace');
    const newest = useApp.getState().rules.at(-1);
    if (newest?.type === 'replace') updateRule(newest.id, { regex: true });
    showToast('info', t('nav.advancedToast'));
  };

  /** 特定文件类型：切到与当前列表最相关的类型页签。 */
  const openSpecific = () => {
    setListTab('photo');
    showToast('info', t('nav.specificToast'));
  };

  const groups: Array<{ label: string; items: NavEntry[] }> = [
    {
      label: t('nav.renameGroup'),
      items: [
        { id: 'basic', label: t('nav.basic'), icon: 'bolt', count: rules.filter((r) => r.enabled).length || undefined, action: () => setListTab('rename') },
        { id: 'advanced', label: t('nav.advanced'), icon: 'layers', action: addAdvanced },
        { id: 'ext', label: t('nav.ext'), icon: 'tag', action: () => addRule('ext') },
        { id: 'specific', label: t('nav.specific'), icon: 'file-plus', action: openSpecific },
      ],
    },
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
              className={`nav-item ${item.id === 'basic' ? 'active' : ''}`}
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
