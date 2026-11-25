import { useMemo, type KeyboardEvent } from 'react';
import { parentPath } from '../lib/format';
import { useTranslation } from '../i18n';
import { useApp } from '../store';
import { Icon } from './Icon';
import { LayoutSwitch } from './LayoutSwitch';

export function PathBar() {
  const { t } = useTranslation();
  const entries = useApp((s) => s.entries);
  const includePattern = useApp((s) => s.includePattern);
  const excludePattern = useApp((s) => s.excludePattern);
  const setIncludePattern = useApp((s) => s.setIncludePattern);
  const setExcludePattern = useApp((s) => s.setExcludePattern);
  const recursive = useApp((s) => s.recursive);
  const setRecursive = useApp((s) => s.setRecursive);
  const includeDirs = useApp((s) => s.includeDirs);
  const setIncludeDirs = useApp((s) => s.setIncludeDirs);
  const includeHidden = useApp((s) => s.includeHidden);
  const setIncludeHidden = useApp((s) => s.setIncludeHidden);
  const applyCurrentFilter = useApp((s) => s.applyCurrentFilter);
  const hasPattern = Boolean(includePattern.trim() || excludePattern.trim());

  const rootLabel = useMemo(() => {
    if (!entries.length) return t('path.none');
    const parents = new Map<string, number>();
    for (const entry of entries) parents.set(entry.parent, (parents.get(entry.parent) ?? 0) + 1);
    const top = Array.from(parents.entries()).sort((a, b) => b[1] - a[1])[0];
    const full = parentPath(top[0]);
    return top[1] === entries.length && full
      ? `${top[0]} (${top[1]})`
      : t('path.locations', { path: parentPath(top[0]) || top[0], count: parents.size });
  }, [entries, t]);

  /** 筛选输入框的键盘约定：Enter 执行筛选，Esc 清空当前框（不回退已填条件）。 */
  const keyInFilter = (event: KeyboardEvent<HTMLInputElement>, clear: () => void) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyCurrentFilter();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      clear();
    }
  };

  return (
    <div className="pathbar">
      <span className="path" title={rootLabel}>
        <Icon name="folder" size={14} style={{ color: 'var(--ds-color-accent)' }} />
        {rootLabel}
      </span>
      <span className={`chip ${includePattern ? 'chip-accent' : 'chip-ghost'}`}>
        {t('path.keep')}
        <input
          id="include-pattern"
          className="chip-input"
          value={includePattern}
          placeholder="*.jpg;*.png"
          aria-label={t('path.keepAria')}
          data-testid="include-pattern"
          onChange={(e) => setIncludePattern(e.target.value)}
          onKeyDown={(e) => keyInFilter(e, () => setIncludePattern(''))}
        />
        {includePattern && (
          <span className="x" onClick={() => setIncludePattern('')} role="button" aria-label={t('path.clearKeep')}>×</span>
        )}
      </span>
      <span className={`chip ${excludePattern ? 'chip-warn' : 'chip-ghost'}`}>
        {t('path.exclude')}
        <input
          className="chip-input"
          value={excludePattern}
          placeholder="*副本*"
          aria-label={t('path.excludeAria')}
          data-testid="exclude-pattern"
          onChange={(e) => setExcludePattern(e.target.value)}
          onKeyDown={(e) => keyInFilter(e, () => setExcludePattern(''))}
        />
        {excludePattern && (
          <span className="x" onClick={() => setExcludePattern('')} role="button" aria-label={t('path.clearExclude')}>×</span>
        )}
      </span>
      {/* 执行筛选只在填了条件时出现，就贴在条件旁边；Enter 同效，Esc 清空当前输入框 */}
      {hasPattern && (
        <button
          type="button"
          className="chip chip-accent chip-action"
          data-testid="filter-apply"
          title={t('path.applyFilterHint')}
          aria-label={t('path.applyFilter')}
          onClick={applyCurrentFilter}
        >
          <Icon name="filter" size={12} />
          {t('path.applyFilter')}
        </button>
      )}
      <div className="right">
        <LayoutSwitch />
        <span className="switch-row" title={t('path.recursiveHint')}>
          <span className="lbl">{t('path.recursive')}</span>
          <span
            className={`switch ${recursive ? 'on' : ''}`}
            role="switch"
            aria-checked={recursive}
            onClick={() => setRecursive(!recursive)}
          />
        </span>
        <span className="switch-row" title={t('path.dirsHint')}>
          <span className="lbl">{t('path.dirs')}</span>
          <span
            className={`switch ${includeDirs ? 'on' : ''}`}
            role="switch"
            aria-checked={includeDirs}
            onClick={() => setIncludeDirs(!includeDirs)}
          />
        </span>
        <span className="switch-row" title={t('path.hiddenHint')}>
          <span className="lbl">{t('path.hidden')}</span>
          <span
            className={`switch ${includeHidden ? 'on' : ''}`}
            role="switch"
            aria-checked={includeHidden}
            data-testid="switch-hidden"
            onClick={() => setIncludeHidden(!includeHidden)}
          />
        </span>
      </div>
    </div>
  );
}
