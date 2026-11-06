import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { usePreview } from '../hooks/usePreview';
import { RULE_TYPES } from '../lib/ruleDefaults';
import { ruleError, ruleSummary } from '../lib/rules';
import { useTranslation } from '../i18n';
import type { RuleType } from '../lib/types';
import { useApp } from '../store';
import { Icon } from './Icon';
import { RuleEditor } from './RuleEditor';

interface AddMenuItem {
  key: string;
  testId: string;
  label: string;
  desc: string;
  run: () => void;
}

type MenuPos = { top: number; left: number; width: number };

/**
 * 规则链模块：左侧规则条目列表 + 右侧选中规则的编辑器，新增/删除/排序/启停都在同一区域内完成。
 * 「添加规则」菜单用 portal + fixed 定位渲染到 body，避免被滚动容器或侧栏裁剪。
 */
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
  const preview = usePreview();
  const [collapsed, setCollapsed] = useState(false);
  const dragIndex = useRef<number | null>(null);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const [activeItem, setActiveItem] = useState(0);

  const setMenu = useCallback((open: boolean) => {
    useApp.setState({ ruleMenuOpen: open });
    if (!open) setMenuPos(null);
  }, []);

  /** 新增规则后自动选中，右侧编辑器直接可编辑。 */
  const selectedIndex = rules.findIndex((r) => r.id === openRuleId);
  const selected = selectedIndex >= 0 ? rules[selectedIndex] : null;

  useEffect(() => {
    if (!rules.length) return;
    if (selectedIndex < 0) setOpenRule(rules[0].id);
  }, [rules, selectedIndex, setOpenRule]);

  const addAdvanced = () => {
    addRule('replace');
    const newest = useApp.getState().rules.at(-1);
    if (newest?.type === 'replace') updateRule(newest.id, { regex: true });
  };

  const menuItems: AddMenuItem[] = RULE_TYPES.map((type: RuleType) => ({
    key: type,
    testId: `rule-type-${type}`,
    label: t(`ruleType.${type}`),
    desc: t(`ruleDesc.${type}`),
    run: () => addRule(type),
  }));
  menuItems.splice(1, 0, {
    key: 'advanced',
    testId: 'rule-type-advanced',
    label: t('nav.advanced'),
    desc: t('ruleDesc.replace'),
    run: addAdvanced,
  });

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(248, rect.width);
    // 先给一个临时位置，挂载后按真实高度上下翻转并夹到窗口内
    setMenuPos({ top: rect.bottom + 6, left: Math.max(8, rect.left), width });
    setActiveItem(0);
    setMenu(true);
  };

  useLayoutEffect(() => {
    if (!ruleMenuOpen) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    const el = menuRef.current;
    if (!rect || !el) return;
    const height = el.offsetHeight;
    const width = Math.max(248, rect.width);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const top = below >= Math.min(height, 320) || below >= above
      ? rect.bottom + 6
      : Math.max(8, rect.top - height - 6);
    setMenuPos({ top, left, width });
    // 菜单自身获得焦点，方向键/回车即可选择，无需先点一下菜单
    el.focus({ preventScroll: true });
  }, [ruleMenuOpen]);

  const closeMenu = (refocus: boolean) => {
    setMenu(false);
    if (refocus) triggerRef.current?.focus();
  };

  /** 点外部关闭；portal 里的菜单与触发按钮不算外部。 */
  useEffect(() => {
    if (!ruleMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      closeMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu(true);
      }
    };
    const onResize = () => closeMenu(false);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
    };
  }, [ruleMenuOpen]);

  const chooseItem = (item: AddMenuItem) => {
    item.run();
    closeMenu(true);
  };

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const count = menuItems.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveItem((i) => (e.key === 'ArrowDown' ? (i + 1) % count : (i - 1 + count) % count));
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const item = menuItems[activeItem];
      if (item) chooseItem(item);
      return;
    }
    if (e.key === 'Tab') closeMenu(false);
  };

  const focusRow = (index: number) => {
    rowRefs.current[index]?.focus();
  };

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
    <aside className="rules" data-testid="rules-module">
      <div className="panel-head">
        <div className="panel-title">{t('rules.title')} <span className="n">{rules.length}</span></div>
        <div className="right">
          <button
            ref={triggerRef}
            className="btn btn-soft rules-add"
            type="button"
            data-testid="add-rule"
            aria-haspopup="menu"
            aria-expanded={ruleMenuOpen}
            onClick={() => (ruleMenuOpen ? closeMenu(true) : openMenu())}
          >
            <Icon name="plus" size={13} />
            {t('rules.add')}
          </button>
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

      <div className="rules-body">
        <div className="rule-list" data-testid="rule-list">
          {rules.length === 0 && (
            <div className="rules-empty">
              <Icon name="bolt" size={22} />
              <p>{t('rules.empty')}</p>
            </div>
          )}

          {rules.map((rule, index) => {
            const active = openRuleId === rule.id;
            const error = ruleError(rule);
            return (
              <div
                key={rule.id}
                ref={(el) => { rowRefs.current[index] = el; }}
                className={`rule-card rule-row ${rule.enabled ? 'on' : ''} ${active ? 'active' : ''}`}
                data-testid="rule-card"
                data-rule-type={rule.type}
                role="button"
                tabIndex={0}
                aria-pressed={active}
                draggable
                onClick={() => setOpenRule(rule.id)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(Math.min(rules.length - 1, index + 1)); setOpenRule(rules[Math.min(rules.length - 1, index + 1)].id); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(Math.max(0, index - 1)); setOpenRule(rules[Math.max(0, index - 1)].id); }
                  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenRule(rule.id); }
                }}
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
                <span className="drag" title={t('rules.drag')}><i /><i /><i /></span>
                <span className="rule-num">{index + 1}</span>
                <span className="rule-title">{t(`ruleType.${rule.type}`)}</span>
                {error && <span className="rule-badge-err" title={error}>!</span>}
                <button
                  className="btn-icon rule-step"
                  type="button"
                  data-testid="rule-up"
                  title={t('rules.up')}
                  disabled={index === 0}
                  onClick={(e) => { e.stopPropagation(); moveRule(rule.id, -1); }}
                >
                  <Icon name="arrow-up" size={11} />
                </button>
                <button
                  className="btn-icon rule-step"
                  type="button"
                  data-testid="rule-down"
                  title={t('rules.down')}
                  disabled={index === rules.length - 1}
                  onClick={(e) => { e.stopPropagation(); moveRule(rule.id, 1); }}
                >
                  <Icon name="arrow-down" size={11} />
                </button>
                <span
                  className={`switch ${rule.enabled ? 'on' : ''}`}
                  role="switch"
                  aria-checked={rule.enabled}
                  title={rule.enabled ? t('rules.disable') : t('rules.enable')}
                  onClick={(e) => { e.stopPropagation(); toggleRule(rule.id); }}
                />
              </div>
            );
          })}

          <div
            className="add-rule"
            data-testid="add-rule-inline"
            onClick={() => (ruleMenuOpen ? closeMenu(true) : openMenu())}
          >
            <Icon name="plus" size={14} />
            {t('rules.add')}
          </div>
        </div>

        <div className="rule-detail" data-testid="rule-detail">
          {selected ? (
            <>
              <div className="rule-detail-head">
                <span className="rule-num">{selectedIndex + 1}</span>
                <b>{t(`ruleType.${selected.type}`)}</b>
                <span className={`switch ${selected.enabled ? 'on' : ''}`} role="switch" aria-checked={selected.enabled}
                  title={selected.enabled ? t('rules.disable') : t('rules.enable')}
                  onClick={() => toggleRule(selected.id)} />
              </div>
              <div className="rule-detail-scroll">
                <div className="sum">
                  <span>{ruleSummary(selected)}</span>
                  {ruleError(selected) && <span className="sum-err">{ruleError(selected)}</span>}
                </div>
                <RuleEditor rule={selected} patch={(patch) => updateRule(selected.id, patch)} />
              </div>
              <div className="rule-foot">
                <button className="btn btn-danger-soft" type="button" data-testid="rule-delete" onClick={() => deleteRule(selected.id)}>
                  <Icon name="trash" size={12} />{t('rules.delete')}
                </button>
                <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--muted-2)' }}>{t('rules.live')}</span>
              </div>
            </>
          ) : (
            <div className="rule-detail-empty">
              <Icon name="layers" size={22} />
              <p>{t('rules.selectHint')}</p>
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
            onClick={() => useApp.getState().showToast('info', t('rules.shortcutToast'))}
          >
            {t('rules.shortcut')}
          </span>
        </div>
      </div>

      {ruleMenuOpen && menuPos && createPortal(
        <div
          ref={menuRef}
          className="rule-menu-pop"
          role="menu"
          aria-label={t('rules.add')}
          tabIndex={-1}
          style={{ top: menuPos.top, left: menuPos.left, width: menuPos.width }}
          onKeyDown={onMenuKeyDown}
        >
          {menuItems.map((item, i) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={`rule-menu-item ${i === activeItem ? 'active' : ''}`}
              data-testid={item.testId}
              onMouseEnter={() => setActiveItem(i)}
              onClick={() => chooseItem(item)}
            >
              <span>{item.label}</span>
              <span className="rule-menu-desc">{item.desc}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </aside>
  );
}

function barWidth(total: number, part: number): number {
  if (!total) return 0;
  return Math.min(100, (part / total) * 100);
}
