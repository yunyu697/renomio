import { useRef, useState } from 'react';
import { usePreview } from '../hooks/usePreview';
import { RULE_TYPES } from '../lib/ruleDefaults';
import { ruleError, ruleSummary } from '../lib/rules';
import { useTranslation } from '../i18n';
import type { RuleType } from '../lib/types';
import { useApp } from '../store';
import { Icon } from './Icon';
import { RuleEditor } from './RuleEditor';

export function RulesPanel() {
  const { t } = useTranslation();
  const rules = useApp((s) => s.rules);
  const openRuleId = useApp((s) => s.openRuleId);
  const setOpenRule = useApp((s) => s.setOpenRule);
  const addRule = useApp((s) => s.addRule);
  const updateRule = useApp((s) => s.updateRule);
  const deleteRule = useApp((s) => s.deleteRule);
  const moveRule = useApp((s) => s.moveRule);
  const toggleRule = useApp((s) => s.toggleRule);
  const clearRules = useApp((s) => s.clearRules);
  const ruleMenuOpen = useApp((s) => s.ruleMenuOpen);
  const showToast = useApp((s) => s.showToast);
  const preview = usePreview();
  const [collapsed, setCollapsed] = useState(false);
  const dragIndex = useRef<number | null>(null);

  const setMenu = (open: boolean) => useApp.setState({ ruleMenuOpen: open });

  if (collapsed) {
    return (
      <aside className="rules collapsed">
        <div className="rules-rail">
          <button className="btn-icon" type="button" title={t('rules.expand')} onClick={() => setCollapsed(false)}>
            <Icon name="chevron-right" size={14} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <span className="rail-label">{t('rules.title')}</span>
          <span className="rail-count">{rules.length}</span>
          <span className="rail-stat">
            <b>{preview.counts.ready}</b>
            <span>{t('rules.executable')}</span>
          </span>
          {preview.counts.conflict > 0 && (
            <span className="rail-stat bad"><b>{preview.counts.conflict}</b><span>{t('rules.conflict')}</span></span>
          )}
        </div>
      </aside>
    );
  }

  return (
    <aside className="rules">
      <div className="panel-head">
        <div className="panel-title">{t('rules.title')} <span className="n">{rules.length}</span></div>
        <div className="right">
          {rules.length > 0 && (
            <button className="btn-icon" type="button" title={t('rules.clear')} onClick={clearRules}>
              <Icon name="trash" size={14} />
            </button>
          )}
          <button className="btn-icon" type="button" title={t('rules.collapse')} onClick={() => setCollapsed(true)}>
            <Icon name="chevron-right" size={14} />
          </button>
        </div>
      </div>

      <div className="rules-scroll">
        {rules.length === 0 && (
          <div className="rules-empty">
            <Icon name="bolt" size={22} />
            <p>{t('rules.empty')}</p>
          </div>
        )}

        {rules.map((rule, index) => {
          const open = openRuleId === rule.id;
          const error = ruleError(rule);
          return (
            <div
              key={rule.id}
              className={`rule-card ${rule.enabled ? 'on' : ''} ${open ? 'open' : ''} ${openRuleId === rule.id ? 'active' : ''}`}
              data-testid="rule-card"
              data-rule-type={rule.type}
              draggable
              onDragStart={() => { dragIndex.current = index; }}
              onDragEnd={() => { dragIndex.current = null; }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragIndex.current;
                if (from === null || from === index) return;
                moveRule(rule.id, index - from);
              }}
            >
              <div className="rule-head" onClick={() => setOpenRule(open ? null : rule.id)}>
                <span className="drag" title={t('rules.drag')}><i /><i /><i /></span>
                <span className="rule-num">{index + 1}</span>
                <span className="rule-title">{t(`ruleType.${rule.type}`)}</span>
                {error && <span className="rule-badge-err" title={error}>!</span>}
                <span
                  className={`switch ${rule.enabled ? 'on' : ''}`}
                  role="switch"
                  aria-checked={rule.enabled}
                  title={rule.enabled ? t('rules.disable') : t('rules.enable')}
                  onClick={(e) => { e.stopPropagation(); toggleRule(rule.id); }}
                />
                <span className="rule-chev">
                  <Icon name={open ? 'chevron-up' : 'chevron-down'} />
                </span>
              </div>

              <div className="sum">
                <span>{ruleSummary(rule)}</span>
                {error && <span className="sum-err">{error}</span>}
              </div>

              {open && <RuleEditor rule={rule} patch={(patch) => updateRule(rule.id, patch)} />}

              {open && (
                <div className="rule-foot">
                  <button className="btn btn-ghost" type="button" data-testid="rule-up" onClick={() => moveRule(rule.id, -1)} disabled={index === 0}>
                    <Icon name="arrow-up" size={12} />{t('rules.up')}
                  </button>
                  <button
                    className="btn btn-ghost"
                    type="button"
                    data-testid="rule-down"
                    onClick={() => moveRule(rule.id, 1)}
                    disabled={index === rules.length - 1}
                  >
                    <Icon name="arrow-down" size={12} />{t('rules.down')}
                  </button>
                  <button className="btn btn-danger-soft" type="button" onClick={() => deleteRule(rule.id)}>
                    <Icon name="trash" size={12} />{t('rules.delete')}
                  </button>
                  <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--muted-2)' }}>{t('rules.live')}</span>
                </div>
              )}
            </div>
          );
        })}

        <div style={{ position: 'relative' }}>
          <div className="add-rule" data-testid="add-rule" onClick={() => setMenu(!ruleMenuOpen)}>
            <Icon name="plus" size={14} />
            {t('rules.add')}
            <span className="kbd" style={{ marginLeft: 2 }}>{ruleMenuOpen ? '▲' : '▼'}</span>
          </div>
          {ruleMenuOpen && (
            <div className="rule-menu">
              {RULE_TYPES.map((type: RuleType) => (
                <div className="rule-menu-item" key={type} data-testid={`rule-type-${type}`} onClick={() => addRule(type)}>
                  <span>{t(`ruleType.${type}`)}</span>
                  <span className="rule-menu-desc">{t(`ruleDesc.${type}`)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rules-foot">
        <div className="stat-line">
          <b>{preview.counts.total}</b> {t('rules.objectsUnit')} ·
          <span className="ok">{preview.counts.ready + preview.counts.warn + preview.counts.conflict} {t('rules.executable')}</span> ·
          <span className="bad">{preview.counts.conflict} {t('rules.conflict')}</span>
        </div>
        <div className="bar">
          <span className="ok" style={{ width: `${barWidth(preview.counts.total, preview.counts.ready + preview.counts.warn + preview.counts.conflict)}%` }} />
          <span className="bad" style={{ width: `${barWidth(preview.counts.total, preview.counts.conflict)}%` }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="auto-preview"><span className="dot-live" />{t('rules.autoPreview')}</span>
          <span
            style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--muted-2)', cursor: 'pointer' }}
            onClick={() => showToast('info', t('rules.shortcutToast'))}
          >
            {t('rules.shortcut')}
          </span>
        </div>
      </div>
    </aside>
  );
}

function barWidth(total: number, part: number): number {
  if (!total) return 0;
  return Math.min(100, (part / total) * 100);
}
