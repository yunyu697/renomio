import { useMemo, useState } from 'react';
import { useTranslation } from '../i18n';
import type { InspectorMode } from '../lib/types';
import { useApp } from '../store';
import { Icon, type IconName } from './Icon';
import { MetaEditorBody } from './MetaEditDialog';
import { AttrBody, MoveBody, TimeBody } from './OpsBodies';
import { ExifClearPanel } from './ExifClearPanel';
import { TextEncodingBody } from './TextEncodingBody';
import { matchesKind } from '../lib/fileKind';

const TABS: Array<{ id: InspectorMode; labelKey: string; icon: IconName }> = [
  { id: 'attrs', labelKey: 'inspector.tab.attrs', icon: 'eye' },
  { id: 'meta', labelKey: 'inspector.tab.meta', icon: 'tag' },
  { id: 'time', labelKey: 'inspector.tab.time', icon: 'clock' },
  { id: 'organize', labelKey: 'inspector.tab.organize', icon: 'folder' },
  { id: 'exif', labelKey: 'inspector.tab.exif', icon: 'ban' },
  { id: 'encoding', labelKey: 'inspector.tab.encoding', icon: 'text' },
];

/**
 * 检查器：贴在列表下方的底部抽屉（收起时只剩一条 36px 的头部）。
 * 六个段落横向分段，纵向高度固定、内容自身滚动 —— 右栏只留给规则链，
 * 因此表格宽度不再被检查器挤占，选中行与检查器常常同屏。
 */
export function Inspector() {
  const { t } = useTranslation();
  const entries = useApp((s) => s.entries);
  const mode = useApp((s) => s.inspector.mode);
  const closeInspector = useApp((s) => s.closeInspector);
  const setInspectorMode = useApp((s) => s.setInspectorMode);
  const [collapsed, setCollapsed] = useState(false);

  // 保持引用稳定，避免勾选变化之外的渲染触发面板内部重复读取
  const targets = useMemo(() => entries.filter((e) => e.selected && !e.isDir), [entries]);
  const imageTargets = useMemo(() => targets.filter((e) => matchesKind('image', e)), [targets]);
  const textTargets = useMemo(() => targets.filter((e) => matchesKind('text', e)), [targets]);

  const applicable = mode === 'exif' ? imageTargets : mode === 'encoding' ? textTargets : targets;
  const emptyMessage =
    targets.length === 0
      ? t('inspector.empty')
      : !applicable.length
        ? mode === 'exif'
          ? t('inspector.exifEmpty', { count: targets.length })
          : t('inspector.encodingEmpty', { count: targets.length })
        : null;

  return (
    <section
      id="inspector-panel"
      className="inspector inspector-drawer"
      data-testid="inspector"
      data-mode={mode}
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label={t('inspector.title')}
    >
      <header className="dw-head">
        <span className="dw-tag">
          <Icon name="grid" size={13} />
          {t('inspector.title')}
        </span>
        {targets.length > 0 && (
          <span className="dw-subject" title={targets[0].name}>
            {targets.length === 1 ? targets[0].name : `${targets[0].name} …`}
          </span>
        )}
        <span className="dw-scope" data-testid="inspector-scope">
          {t('inspector.scope', { count: targets.length })}
        </span>
        <div className="dw-seg" role="tablist" aria-label={t('inspector.title')}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              type="button"
              aria-selected={mode === tab.id}
              className={`dw-seg-item${mode === tab.id ? ' on' : ''}`}
              data-testid={`inspector-tab-${tab.id}`}
              title={t(tab.labelKey)}
              onClick={() => {
                setInspectorMode(tab.id);
                setCollapsed(false);
              }}
            >
              <Icon name={tab.icon} size={12} />
              {t(tab.labelKey)}
            </button>
          ))}
        </div>
        <button
          className="btn-icon dw-btn"
          type="button"
          data-testid="inspector-collapse"
          title={collapsed ? t('nav.expand') : t('nav.collapse')}
          aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((v) => !v)}
        >
          <Icon name={collapsed ? 'chevron-up' : 'chevron-down'} size={14} />
        </button>
        <button
          className="btn-icon dw-btn"
          type="button"
          data-testid="inspector-close"
          title={t('inspector.close')}
          aria-label={t('inspector.close')}
          onClick={closeInspector}
        >
          <Icon name="x" size={14} />
        </button>
      </header>

      {!collapsed && (
        <div className="dw-body">
          {emptyMessage ? (
            <div className="inspector-empty" data-testid="inspector-empty">
              <Icon name="info" size={22} />
              <p>{emptyMessage}</p>
            </div>
          ) : mode === 'attrs' ? (
            <AttrBody targets={targets} onClose={closeInspector} />
          ) : mode === 'meta' ? (
            <MetaEditorBody paths={targets.map((e) => e.path)} note={t('inspector.metaNote')} />
          ) : mode === 'time' ? (
            <TimeBody targets={targets} onClose={closeInspector} />
          ) : mode === 'exif' ? (
            <>
              <div className="meta-edit-hint page-note" data-testid="inspector-exif-note">
                <Icon name="info" size={13} />{t('inspector.exifNote')}
              </div>
              <ExifClearPanel paths={imageTargets.map((e) => e.path)} />
            </>
          ) : mode === 'encoding' ? (
            <>
              <div className="meta-edit-hint page-note" data-testid="inspector-encoding-note">
                <Icon name="info" size={13} />{t('inspector.encodingNote')}
              </div>
              <TextEncodingBody targets={textTargets} />
            </>
          ) : (
            <MoveBody targets={targets} onClose={closeInspector} />
          )}
        </div>
      )}
    </section>
  );
}
