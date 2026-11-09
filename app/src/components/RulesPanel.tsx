import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { usePreview } from '../hooks/usePreview';
import { analyzeConflicts, conflictsOfRule } from '../lib/conflicts';
import { RULE_TYPES } from '../lib/ruleDefaults';
import { ruleError, ruleSummary } from '../lib/rules';
import { useTranslation } from '../i18n';
import type { ConflictKind, RuleConflict, RuleType } from '../lib/types';
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
 * 规则链模块：单栏纵向排列，每条规则可折叠展开（状态随设置持久化）；
 * 支持拖拽、上移/下移按钮与 Alt+方向键三种排序方式，顺序持久化；
 * 顶部汇总规则与路径筛选模式之间的冲突，点击可跳转到对应条目。
 */
export function RulesPanel() {
  const { t } = useTranslation();
  const rules = useApp((s) => s.rules);
  const openRuleId = useApp((s) => s.openRuleId);
  const ruleUi = useApp((s) => s.settings.ruleUi);
  const includePattern = useApp((s) => s.includePattern);
  const excludePattern = useApp((s) => s.excludePattern);
  const setOpenRule = useApp((s) => s.setOpenRule);
  const setRuleExpanded = useApp((s) => s.setRuleExpanded);
  const setRulesCollapsed = useApp((s) => s.setRulesCollapsed);
  const hashProgress = useApp((s) => s.hashProgress);
  const cancelLoadFileFacts = useApp((s) => s.cancelLoadFileFacts);
  const addRule = useApp((s) => s.addRule);
  const updateRule = useApp((s) => s.updateRule);
  const deleteRule = useApp((s) => s.deleteRule);
  const moveRule = useApp((s) => s.moveRule);
  const moveRuleTo = useApp((s) => s.moveRuleTo);
  const toggleRule = useApp((s) => s.toggleRule);
  const clearRules = useApp((s) => s.clearRules);
  const ruleMenuOpen = useApp((s) => s.ruleMenuOpen);
  const preview = usePreview();
  const collapsed = ruleUi.collapsed;
  const dragIndex = useRef<number | null>(null);
  const dragOver = useRef<number | null>(null);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const [activeItem, setActiveItem] = useState(0);

  const conflicts = useMemo(
    () => analyzeConflicts(rules, includePattern, excludePattern),
    [rules, includePattern, excludePattern],
  );

  const tryKindLabel = useCallback((kind: ConflictKind): string => {
    switch (kind) {
      case 'include-exclude':
        return t('conflict.includeExclude');
      case 'path-overlap':
        return t('conflict.pathOverlap');
      case 'action-contradiction':
        return t('conflict.action');
      case 'shadowed':
        return t('conflict.shadowed');
      case 'regex-overlap':
        return t('conflict.regex');
      default:
        return kind;
    }
  }, [t]);

  const setMenu = useCallback((open: boolean) => {
    useApp.setState({ ruleMenuOpen: open });
    if (!open) setMenuPos(null);
  }, []);

  const selectedIndex = rules.findIndex((r) => r.id === openRuleId);
  /** 单栏下同时只展开一条：展开项记在设置里，重启后仍保留 */
  const expandedId = ruleUi.expanded[0] ?? null;

  useEffect(() => {
    if (!rules.length) return;
    if (selectedIndex < 0) setOpenRule(rules[0].id);
  }, [rules, selectedIndex, setOpenRule]);

  const toggleOpen = (id: string) => {
    if (expandedId === id) {
      setRuleExpanded(id, false);
      return;
    }
    setOpenRule(id);
    setRuleExpanded(id, true);
  };

  const jumpToConflict = (conflict: RuleConflict) => {
    if (conflict.ruleIds.length > 0) {
      const id = conflict.ruleIds[0];
      setOpenRule(id);
      setRuleExpanded(id, true);
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-rule-id="${id}"]`);
        el?.scrollIntoView({ block: 'nearest' });
        el?.focus({ preventScroll: true });
      });
      return;
    }
    const input = document.querySelector<HTMLInputElement>('[data-testid="include-pattern"]');
    input?.focus();
    input?.select();
  };

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
          <button className="btn-icon" type="button" data-testid="expand-rules" title={t('rules.expand')} onClick={() => setRulesCollapsed(false)}>
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
            <button className="btn-icon" type="button" data-testid="clear-rules" title={t('rules.clear')} onClick={clearRules}>
              <Icon name="trash" size={14} />
            </button>
          )}
          <button className="btn-icon" type="button" data-testid="collapse-rules" title={t('rules.collapse')} onClick={() => setRulesCollapsed(true)}>
            <Icon name="chevron-right" size={14} />
          </button>
        </div>
      </div>

      <div className="rules-body">
        {conflicts.length > 0 && (
          <div className="conflict-panel" data-testid="rule-conflicts" role="region" aria-label={t('conflict.title')}>
            <div className="conflict-head">
              <Icon name="alert" size={13} />
              <b>{t('conflict.summary', { count: conflicts.length })}</b>
              <span className="conflict-note">{t('conflict.hint')}</span>
            </div>
            <div className="conflict-list">
              {conflicts.slice(0, 4).map((conflict) => (
                <button
                  key={conflict.key}
                  type="button"
                  className="conflict-item"
                  data-testid="conflict-item"
                  data-conflict-kinds={conflict.kinds.join(',')}
                  onClick={() => jumpToConflict(conflict)}
                >
                  <span className="conflict-kinds">
                    {conflict.kinds.map((kind) => (
                      <span key={kind} className={`conflict-kind ${kind}`}>{tryKindLabel(kind)}</span>
                    ))}
                  </span>
                  <span className="conflict-detail" title={conflict.detail}>{conflict.detail}</span>
                </button>
              ))}
              {conflicts.length > 4 && (
                <span className="conflict-more" data-testid="conflict-more">
                  {t('conflict.more', { count: conflicts.length - 4 })}
                </span>
              )}
            </div>
          </div>
        )}

        {hashProgress && (
          <div className="hash-progress" data-testid="hash-progress">
            <span>
              {t('hash.progress', { done: hashProgress.done, total: hashProgress.total })}
            </span>
            <div className="hash-bar">
              <span style={{ width: `${Math.round((hashProgress.done / Math.max(1, hashProgress.total)) * 100)}%` }} />
            </div>
            <button type="button" onClick={() => void cancelLoadFileFacts()}>{t('hash.cancel')}</button>
          </div>
        )}

        <div className="rule-list" data-testid="rule-list">
          {rules.length === 0 && (
            <div className="rules-empty">
              <Icon name="bolt" size={22} />
              <p>{t('rules.empty')}</p>
            </div>
          )}

          {rules.map((rule, index) => {
            const active = openRuleId === rule.id;
            const open = expandedId === rule.id;
            const error = ruleError(rule);
            const hits = conflictsOfRule(conflicts, rule.id);
            const kinds = Array.from(new Set(hits.flatMap((hit) => hit.kinds)));
            return (
              <div
                key={rule.id}
                ref={(el) => { rowRefs.current[index] = el; }}
                className={`rule-card ${rule.enabled ? 'on' : ''} ${active ? 'active' : ''} ${open ? 'open' : ''}`}
                data-testid="rule-card"
                data-rule-id={rule.id}
                data-rule-type={rule.type}
                data-conflict={hits.length > 0 ? kinds.join(',') : undefined}
                data-drag-over={dragOver.current === index ? 'true' : undefined}
                role="button"
                tabIndex={0}
                aria-expanded={open}
                aria-pressed={active}
                onClick={() => toggleOpen(rule.id)}
                onKeyDown={(e) => {
                  // 只有卡片本身获得焦点时才响应快捷键；规则编辑区里的 input 冒泡上来的空格/回车要正常输入
                  if (e.target !== e.currentTarget) return;
                  const next = Math.min(rules.length - 1, index + 1);
                  const prev = Math.max(0, index - 1);
                  if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                    e.preventDefault();
                    const target = e.key === 'ArrowDown' ? next : prev;
                    moveRule(rule.id, e.key === 'ArrowDown' ? 1 : -1);
                    requestAnimationFrame(() => focusRow(target));
                    return;
                  }
                  if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(next); setOpenRule(rules[next].id); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(prev); setOpenRule(rules[prev].id); }
                  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOpen(rule.id); }
                }}
                onDragStart={() => { dragIndex.current = index; }}
                onDragEnd={() => { dragIndex.current = null; dragOver.current = null; }}
                onDragOver={(e) => { e.preventDefault(); dragOver.current = index; }}
                onDragLeave={() => { if (dragOver.current === index) dragOver.current = null; }}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = dragIndex.current;
                  dragOver.current = null;
                  if (from === null || from === index) return;
                  const dragged = rules[from];
                  if (!dragged) return;
                  moveRuleTo(dragged.id, index);
                  requestAnimationFrame(() => focusRow(index));
                }}
              >
                <div className="rule-row">
                  <span
                    className="drag"
                    title={t('rules.drag')}
                    draggable
                    onDragStart={(e) => { e.dataTransfer?.setData('text/plain', rule.id); dragIndex.current = index; }}
                    onDragEnd={() => { dragIndex.current = null; dragOver.current = null; }}
                  >
                    <i /><i /><i />
                  </span>
                  <span className="rule-num">{index + 1}</span>
                  <span className="rule-title" title={t(`ruleType.${rule.type}`)}>{t(`ruleType.${rule.type}`)}</span>
                  {hits.length > 0 && (
                    <span
                      className="rule-badge-conflict"
                      data-testid="rule-conflict-badge"
                      title={kinds.map((kind) => tryKindLabel(kind)).join(' / ')}
                    >
                      <Icon name="alert" size={11} />
                      <span>{hits.length}</span>
                    </span>
                  )}
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
                  <button
                    className="btn-icon rule-chevron"
                    type="button"
                    data-testid="rule-toggle"
                    title={open ? t('rules.collapseCard') : t('rules.expandCard')}
                    aria-expanded={open}
                    onClick={(e) => { e.stopPropagation(); toggleOpen(rule.id); }}
                  >
                    <Icon name="chevron-right" size={13} style={{ transform: open ? 'rotate(90deg)' : undefined }} />
                  </button>
                </div>

                {open && (
                  <div className="rule-detail" data-testid="rule-detail" onClick={(e) => e.stopPropagation()}>
                    <div className="rule-detail-scroll">
                      <div className="sum">
                        <span>{ruleSummary(rule)}</span>
                        {error && <span className="sum-err">{error}</span>}
                      </div>
                      {hits.length > 0 && (
                        <div className="rule-conflict-note" data-testid="rule-conflict-note">
                          <Icon name="alert" size={12} />
                          <span>{kinds.map((kind) => tryKindLabel(kind)).join(' / ')}</span>
                        </div>
                      )}
                      <RuleEditor rule={rule} patch={(patch) => updateRule(rule.id, patch)} />
                    </div>
                    <div className="rule-foot">
                      <button className="btn btn-danger-soft" type="button" data-testid="rule-delete" onClick={() => deleteRule(rule.id)}>
                        <Icon name="trash" size={12} />{t('rules.delete')}
                      </button>
                      <span className="rule-foot-hint">{t('rules.live')}</span>
                    </div>
                  </div>
                )}
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
            className="rules-shortcut"
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
