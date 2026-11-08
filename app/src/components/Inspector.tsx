import { useMemo } from 'react';
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
 * 右侧检查器：属性 / 元数据 / 时间 / 归类 / EXIF / 编码共用一块停靠面板。
 * 目标直接取列表勾选（同一份选择源），因此规则链、预览、动作栏始终可见；
 * 头部常驻「作用于 N 个文件」，避免出现「以为改的是这几行」。
 */
export function Inspector() {
  const { t } = useTranslation();
  const entries = useApp((s) => s.entries);
  const mode = useApp((s) => s.inspector.mode);
  const closeInspector = useApp((s) => s.closeInspector);
  const setInspectorMode = useApp((s) => s.setInspectorMode);

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
    <aside id="inspector-panel" className="inspector" data-testid="inspector" data-mode={mode} aria-label={t('inspector.title')}>
      <header className="inspector-head">
        <Icon name="grid" size={16} />
        <div className="inspector-title">
          <h3>{t('inspector.title')}</h3>
          <p className="inspector-scope" data-testid="inspector-scope">
            {t('inspector.scope', { count: targets.length })}
          </p>
        </div>
        <button
          className="btn-icon"
          type="button"
          data-testid="inspector-close"
          title={t('inspector.close')}
          aria-label={t('inspector.close')}
          onClick={closeInspector}
        >
          <Icon name="x" size={14} />
        </button>
      </header>

      <div className="inspector-tabs" role="tablist" aria-label={t('inspector.title')}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={mode === tab.id}
            className={`mini inspector-tab${mode === tab.id ? ' on' : ''}`}
            data-testid={`inspector-tab-${tab.id}`}
            onClick={() => setInspectorMode(tab.id)}
          >
            <Icon name={tab.icon} size={12} />
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      <div className="inspector-body">
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
    </aside>
  );
}
