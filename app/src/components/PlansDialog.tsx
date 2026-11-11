import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store';
import { useTranslation } from '../i18n';
import { baseName } from '../lib/format';
import {
  deletePlan, loadRecentItems, loadSavedPlans, pushRecentDir, pushRecentPlan,
  removeRecentItem, savePlan, type RecentItem, type SavedPlan,
} from '../lib/plans';
import { Icon } from './Icon';

/**
 * 方案库：命名保存多套规则链；最近 10 条（方案与目录）持久化在一份本地记录里。
 * 载入方案会替换当前规则链并立即触发预览；载入目录等价于重新添加该文件夹。
 */
export function PlansDialog() {
  const { t } = useTranslation();
  const open = useApp((s) => s.plansOpen);
  const rules = useApp((s) => s.rules);
  const close = useApp((s) => s.closePlans);
  const loadSavedPlan = useApp((s) => s.loadSavedPlan);
  const addPaths = useApp((s) => s.addPaths);
  const showToast = useApp((s) => s.showToast);

  const [plans, setPlans] = useState<SavedPlan[]>([]);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setPlans(loadSavedPlans());
    setRecent(loadRecentItems());
    setName('');
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  if (!open) return null;

  const saveCurrent = () => {
    if (!rules.length) {
      showToast('info', t('plans.noRules'));
      return;
    }
    const trimmed = name.trim() || t('plan.defaultName');
    setPlans(savePlan(trimmed, rules));
    setRecent(pushRecentPlan(trimmed, rules));
    setName('');
    showToast('success', t('plans.saved', { name: trimmed, count: rules.length }));
  };

  const removePlan = (plan: SavedPlan) => {
    setPlans(deletePlan(plan.id));
    showToast('info', t('plans.deleted', { name: plan.name }));
  };

  const openRecent = (item: RecentItem) => {
    if (item.kind === 'plan') {
      loadSavedPlan(item.name, item.rules);
      return;
    }
    setRecent(pushRecentDir(item.path));
    close();
    void addPaths([item.path]);
  };

  const removeRecent = (item: RecentItem) => {
    setRecent(removeRecentItem(item.id));
    showToast('info', t('plans.deleted', { name: item.kind === 'plan' ? item.name : baseName(item.path) }));
  };

  return (
    <div className="modal-mask" onClick={close}>
      <div className="dialog dialog-plan" data-testid="plans-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h4>
            <Icon name="save" size={16} style={{ color: 'var(--accent)' }} />
            {t('plans.title')}
          </h4>
          <p>{t('plans.sub')}</p>
        </div>

        <div className="dialog-body">
          <label className="field-label" htmlFor="plans-name">{t('plans.name')}</label>
          <div className="plans-save">
            <input
              id="plans-name"
              ref={inputRef}
              className="input"
              data-testid="plans-name"
              value={name}
              maxLength={60}
              placeholder={t('plans.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveCurrent();
              }}
            />
            <button className="btn btn-primary" type="button" data-testid="plans-save" onClick={saveCurrent}>
              <Icon name="save" size={13} />{t('plans.save')}
            </button>
          </div>

          <div className="plans-section-title">{t('plans.savedList')}</div>
          <div className="plans-list" data-testid="plans-list">
            {plans.length === 0 && <div className="foot-note">{t('plans.emptySaved')}</div>}
            {plans.map((plan) => (
              <div className="plans-item" key={plan.id} data-testid="plans-item">
                <span className="plans-item-name" title={plan.name}>{plan.name}</span>
                <span className="plans-item-meta">{t('plans.ruleCount', { count: plan.rules.length })}</span>
                <button className="mini" type="button" data-testid="plans-load" onClick={() => loadSavedPlan(plan.name, plan.rules)}>
                  {t('plans.load')}
                </button>
                <button className="mini" type="button" data-testid="plans-delete" onClick={() => removePlan(plan)}>
                  {t('plans.delete')}
                </button>
              </div>
            ))}
          </div>

          <div className="plans-section-title">{t('plans.recentList')}</div>
          <div className="plans-list" data-testid="recent-list">
            {recent.length === 0 && <div className="foot-note">{t('plans.emptyRecent')}</div>}
            {recent.map((item) => (
              <div className="plans-item" key={item.id} data-testid="recent-item" data-recent-kind={item.kind}>
                <Icon name={item.kind === 'plan' ? 'save' : 'folder'} size={12} />
                <span className="plans-item-name" title={item.kind === 'plan' ? item.name : item.path}>
                  {item.kind === 'plan' ? item.name : baseName(item.path)}
                </span>
                <span className="plans-item-meta">
                  {item.kind === 'plan'
                    ? t('plans.ruleCount', { count: item.rules.length })
                    : t('plans.recentDir')}
                </span>
                <button className="mini" type="button" data-testid="recent-load" onClick={() => openRecent(item)}>
                  {t('plans.load')}
                </button>
                <button className="mini" type="button" data-testid="recent-delete" onClick={() => removeRecent(item)}>
                  {t('plans.delete')}
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="dialog-foot">
          <span className="foot-note">{t('plans.footer')}</span>
          <div className="right">
            <button className="btn btn-ghost" type="button" onClick={close}>{t('common.close')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
