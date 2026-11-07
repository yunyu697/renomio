import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../i18n';
import { metaCapabilities, metaEdit, metaRead, metaRestoreBackup, pickCoverImage, revealPath } from '../lib/bridge';
import type {
  MetaCapabilityDto, MetaEditResultDto, MetaFieldId, MetaSnapshotDto,
} from '../lib/types';
import { baseName } from '../lib/format';
import { useApp } from '../store';
import { Icon } from './Icon';

/** 可编辑字段的固定展示顺序；是否出现由「文件格式支持」决定。 */
const FIELD_ORDER: MetaFieldId[] = [
  'title', 'description', 'keywords', 'author', 'copyright', 'software', 'takenAt',
  'headline', 'bylineTitle', 'credit', 'source',
  // 图片：机型/地点/坐标统一写 XMP，不改 EXIF 的 0x0110 与 GPS IFD
  'model', 'city', 'location', 'latitude', 'longitude',
  'artist', 'albumArtist', 'album', 'year', 'track', 'genre', 'comment', 'lyrics',
  'subject', 'lastModifiedBy', 'category',
];

interface MetaEditorBodyProps {
  paths: string[];
  /** 页面级提示（例如「写入 XMP，不修改 EXIF 结构」） */
  note?: string;
  onApplied?: (results: MetaEditResultDto[]) => void;
}

/**
 * 元数据编辑器主体：读取现有值 → 逐字段勾选/清空 → 备份写入 → 回读结果 → 可还原。
 * 对话框与侧栏功能页共用同一份实现。
 */
export function MetaEditorBody({ paths, note, onApplied }: MetaEditorBodyProps) {
  const { t } = useTranslation();
  const refresh = useApp((s) => s.refreshEntriesFromDisk);
  const showToast = useApp((s) => s.showToast);
  const isDemo = useApp((s) => s.isDemo);

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [snaps, setSnaps] = useState<MetaSnapshotDto[]>([]);
  const [selected, setSelected] = useState<MetaFieldId[]>([]);
  const [values, setValues] = useState<Partial<Record<MetaFieldId, string>>>({});
  const [cleared, setCleared] = useState<MetaFieldId[]>([]);
  const [coverPath, setCoverPath] = useState<string | null>(null);
  const [clearCover, setClearCover] = useState(false);
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<MetaEditResultDto[] | null>(null);
  const [caps, setCaps] = useState<MetaCapabilityDto[] | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const key = paths.join('\n');

  useEffect(() => {
    if (!paths.length) return;
    let alive = true;
    setLoading(true);
    setLoadError(null);
    setResults(null);
    setCoverPath(null);
    setClearCover(false);
    setSelected([]);
    void Promise.allSettled(paths.map((path) => metaRead(path))).then((settled) => {
      if (!alive) return;
      const ok: MetaSnapshotDto[] = [];
      const errors: { path: string; error: string }[] = [];
      settled.forEach((item, index) => {
        if (item.status === 'fulfilled') ok.push(item.value);
        else {
          errors.push({
            path: paths[index],
            error: item.reason instanceof Error ? item.reason.message : String(item.reason),
          });
        }
      });
      setSnaps(ok);
      setLoadError(errors.length ? errors.map((e) => `${baseName(e.path)}：${e.error}`).join('；') : null);
      const nextValues: Partial<Record<MetaFieldId, string>> = {};
      for (const field of FIELD_ORDER) {
        const shared = ok.every((snap) => (snap.fields[field] ?? '') === (ok[0].fields[field] ?? ''));
        nextValues[field] = shared ? ok[0].fields[field] ?? '' : '';
      }
      setValues(nextValues);
      setLoading(false);
    });
    void metaCapabilities().then((list) => {
      if (alive) setCaps(list);
    }).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [key]);

  const fields = useMemo(() => {
    const union = new Set<MetaFieldId>();
    for (const snap of snaps) {
      for (const id of snap.supportedFields) {
        if (id !== 'cover' && FIELD_ORDER.includes(id as MetaFieldId)) union.add(id as MetaFieldId);
      }
    }
    const out = FIELD_ORDER.filter((id) => union.has(id));
    // 音频不展示图片专属的 XMP 字段，避免误导
    return out.filter((id) => {
      const imageOnly = ['model', 'city', 'location', 'latitude', 'longitude'].includes(id);
      if (!imageOnly) return true;
      return snaps.every((s) => s.kind === 'image');
    });
  }, [snaps]);

  const writable = snaps.filter((s) => s.writable);
  const unsupported = snaps.filter((s) => !s.writable);
  const allAudio = snaps.length > 0 && snaps.every((s) => s.kind === 'audio');
  const coverSupported = allAudio && snaps.every((s) => s.supportedFields.includes('cover'));
  const first = snaps[0] ?? null;

  const toggleField = (id: MetaFieldId, checked: boolean) => {
    setSelected((prev) => (checked ? [...prev, id] : prev.filter((x) => x !== id)));
    if (!checked) {
      setCleared((prev) => prev.filter((x) => x !== id));
      setValues((prev) => ({ ...prev, [id]: '' }));
    }
  };

  const setValue = (id: MetaFieldId, value: string) => {
    setValues((prev) => ({ ...prev, [id]: value }));
    if (cleared.includes(id)) setCleared((prev) => prev.filter((x) => x !== id));
  };

  const toggleClear = (id: MetaFieldId) => {
    const on = !cleared.includes(id);
    setCleared((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)));
    if (on) {
      setSelected((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setValues((prev) => ({ ...prev, [id]: '' }));
    }
  };

  const apply = async () => {
    if (writable.length > 0 && !selected.length && !clearCover && !coverPath) {
      showToast('info', t('meta.applyNoField'));
      return;
    }
    setApplying(true);
    setResults(null);
    try {
      const payload: Record<string, string> = {};
      for (const id of selected) payload[id] = cleared.includes(id) ? '' : values[id] ?? '';
      const requests = snaps.map((snap) => ({
        path: snap.path,
        fields: payload,
        coverPath: coverSupported && coverPath ? coverPath : undefined,
        clearCover: coverSupported && clearCover ? true : undefined,
        backup: true,
      }));
      const out = await metaEdit(requests);
      setResults(out);
      const ok = out.filter((r) => r.ok).length;
      const failed = out.length - ok;
      if (!failed) {
        showToast('success', t('meta.applyAllOk', { ok }));
      } else {
        showToast(ok ? 'warn' : 'error', t('meta.applyDone', { ok, failed }));
      }
      void refresh(out.filter((r) => r.ok).map((r) => r.path));
      onApplied?.(out);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  };

  const restore = async (item: MetaEditResultDto) => {
    if (!item.backup) return;
    setRestoring(item.path);
    try {
      await metaRestoreBackup(item.backup, item.path);
      showToast('success', t('meta.restored', { name: baseName(item.path) }));
      void refresh([item.path]);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setRestoring(null);
    }
  };

  return (
    <>
      {note && (
        <div className="meta-edit-hint page-note" data-testid="meta-page-note">
          <Icon name="info" size={13} />{note}
        </div>
      )}
      {loading && <div className="meta-loading">{t('meta.loading')}</div>}

      {!loading && unsupported.length > 0 && (
        <div className="meta-unsupported" data-testid="meta-unsupported">
          <Icon name="ban" size={13} />
          <div>
            {unsupported.map((snap) => (
              <div key={snap.path}>
                <strong>{baseName(snap.path)}</strong>（{snap.format}）：{snap.unsupportedReason ?? t('meta.unsupportedTarget')}
              </div>
            ))}
          </div>
        </div>
      )}
      {loadError && !loading && (
        <div className="meta-error"><Icon name="alert" size={14} />{loadError}</div>
      )}

      {!loading && fields.length > 0 && (
        <>
          <div className="meta-edit-hint">
            <Icon name="info" size={13} />{t('meta.editSubtitle')}
          </div>
          <div className="meta-edit-grid" data-testid="meta-fields">
            {fields.map((id) => {
              const shared = snaps.every((s) => s.supportedFields.includes(id));
              const on = selected.includes(id);
              const clearing = cleared.includes(id);
              const placeholder = shared ? '' : t('meta.skippedKind');
              return (
                <div className={`meta-edit-row ${shared ? '' : 'disabled'}`} key={id}>
                  <label className="meta-edit-pick" title={shared ? undefined : t('meta.skippedKind')}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={!shared}
                      data-testid={`meta-field-${id}-check`}
                      onChange={(e) => toggleField(id, e.target.checked)}
                    />
                    <span>{t(`meta.field.${id}`)}</span>
                  </label>
                  {id === 'lyrics' ? (
                    <textarea
                      className="input meta-edit-input meta-edit-textarea"
                      rows={4}
                      value={clearing ? '' : values[id] ?? ''}
                      disabled={!shared || !on || clearing}
                      placeholder={placeholder}
                      data-testid={`meta-field-${id}-input`}
                      onChange={(e) => setValue(id, e.target.value)}
                    />
                  ) : (
                    <input
                      className="input meta-edit-input"
                      type="text"
                      value={clearing ? '' : values[id] ?? ''}
                      disabled={!shared || !on || clearing}
                      placeholder={placeholder}
                      data-testid={`meta-field-${id}-input`}
                      onChange={(e) => setValue(id, e.target.value)}
                    />
                  )}
                  <button
                    className={`mini ${clearing ? 'on' : ''}`}
                    type="button"
                    disabled={!shared}
                    data-testid={`meta-field-${id}-clear`}
                    onClick={() => toggleClear(id)}
                    title={t('meta.clearField')}
                  >
                    <Icon name="ban" size={12} />{t('meta.clearField')}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      {!loading && fields.length === 0 && writable.length > 0 && (
        <div className="meta-empty">{t('meta.empty')}</div>
      )}

      {coverSupported && (
        <div className="meta-cover-row" data-testid="meta-cover">
          <span className="meta-label">{t('meta.field.cover')}</span>
          <span className="meta-value">
            {first?.cover?.present
              ? `${first.cover.mime} · ${first.cover.width}×${first.cover.height} · ${first.cover.bytes} B`
              : t('meta.coverNone')}
            {coverPath ? ` → ${baseName(coverPath)}` : ''}
            {clearCover ? ' → ' + t('meta.coverRemove') : ''}
          </span>
          <button
            className="mini"
            type="button"
            disabled={isDemo}
            data-testid="meta-cover-pick"
            onClick={() => {
              void pickCoverImage().then((path) => {
                if (path) {
                  setCoverPath(path);
                  setClearCover(false);
                }
              });
            }}
          >
            <Icon name="image" size={12} />{t('meta.coverPick')}
          </button>
          <button
            className={`mini ${clearCover ? 'on' : ''}`}
            type="button"
            data-testid="meta-cover-remove"
            onClick={() => {
              setClearCover((v) => !v);
              setCoverPath(null);
            }}
          >
            <Icon name="ban" size={12} />{t('meta.coverRemove')}
          </button>
          <span className="meta-cover-note">{t('meta.coverNote')}</span>
        </div>
      )}

      {results && (
        <div className="meta-results" data-testid="meta-results">
          <div className="meta-results-head">{t('meta.resultTitle')}</div>
          {results.map((item, index) => (
            <div
              className={`meta-result ${item.ok ? 'ok' : 'bad'}`}
              key={item.path}
              data-testid={`meta-result-${index}`}
            >
              <div className="meta-result-line">
                <Icon name={item.ok ? 'check' : 'alert'} size={12} />
                <strong>{baseName(item.path)}</strong>
                <span className="meta-format">{item.format || '—'}</span>
                <span className="meta-result-state">
                  {item.ok ? t('meta.resultOk') : t('meta.resultFail')}
                </span>
                {item.ok && item.verified && <span className="meta-verified">{t('meta.verified')}</span>}
                {item.backup && (
                  <button
                    className="mini"
                    type="button"
                    disabled={restoring === item.path}
                    data-testid={`meta-restore-${index}`}
                    onClick={() => void restore(item)}
                  >
                    {restoring === item.path ? t('meta.restoring') : t('meta.restore')}
                  </button>
                )}
              </div>
              {item.error && <div className="meta-result-msg">{item.error}</div>}
              {item.ok && (
                <div className="meta-result-msg">
                  {item.written.length > 0 && `写入：${item.written.join(', ')}`}
                  {item.cleared.length > 0 && ` · 清空：${item.cleared.join(', ')}`}
                  {item.ignored.length > 0 && ` · 忽略：${item.ignored.join(', ')}`}
                </div>
              )}
              <div className="meta-result-msg">
                {t('meta.backupPath')}：
                {item.backup ? (
                  <button
                    className="linkish"
                    type="button"
                    onClick={() => void revealPath(item.backup as string).catch(() => undefined)}
                  >
                    {item.backup}
                  </button>
                ) : (
                  t('meta.noBackup')
                )}
              </div>
              {item.warnings.map((w) => (
                <div className="meta-result-msg" key={w}>{w}</div>
              ))}
            </div>
          ))}
        </div>
      )}

      {caps && (
        <details className="meta-caps" data-testid="meta-caps">
          <summary>{t('meta.capabilities')}</summary>
          <div className="meta-cap-list">
            {caps.map((cap) => (
              <div className={`meta-cap ${cap.write ? 'ok' : 'no'}`} key={`${cap.kind}-${cap.format}`}>
                <span className="meta-cap-format">{cap.format}</span>
                <span className="meta-cap-state">
                  {cap.write ? t('meta.capWritable') : t('meta.capReadonly')}
                </span>
                {cap.notes && <span className="meta-cap-note">{cap.notes}</span>}
              </div>
            ))}
          </div>
        </details>
      )}

      <div className="meta-editor-actions">
        <span className="foot-note">{t('meta.backupHint')}</span>
        <div className="right">
          <button
            className="btn btn-primary"
            type="button"
            data-testid="meta-apply"
            disabled={applying || loading || !snaps.length}
            onClick={() => void apply()}
          >
            <Icon name="save" size={13} />
            {applying ? t('meta.applying') : t('meta.apply')}
          </button>
        </div>
      </div>
    </>
  );
}

/** 对话框外壳：保留原有入口（列表页签的「编辑元数据」按钮）。 */
export function MetaEditDialog() {
  const { t } = useTranslation();
  const editor = useApp((s) => s.metaEditor);
  const close = useApp((s) => s.closeMetaEditor);
  const isDemo = useApp((s) => s.isDemo);
  if (!editor.open) return null;
  return (
    <div className="modal-mask" onClick={close}>
      <div
        className="dialog dialog-meta-edit"
        data-testid="meta-edit-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <h4>
            <Icon name="tag" size={16} style={{ color: 'var(--accent)' }} />
            {t('meta.editTitle')}
            {isDemo && <span className="readonly-chip"><Icon name="lock" size={11} />{t('title.demoChip')}</span>}
          </h4>
          <p>
            {editor.paths.length > 1
              ? `${editor.paths.length} × ${t('meta.editTitle')}`
              : `${baseName(editor.paths[0] ?? '')} · ${editor.paths[0] ?? ''}`}
          </p>
        </div>
        <div className="dialog-body">
          <MetaEditorBody paths={editor.paths} />
        </div>
        <div className="dialog-foot">
          <span className="foot-note">{t('meta.backupHint')}</span>
          <div className="right">
            <button className="btn btn-ghost" type="button" data-testid="meta-close" onClick={close}>
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
