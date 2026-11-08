import { useState } from 'react';
import { useApp } from '../store';
import { useTranslation } from '../i18n';
import { exifClear, exifInventory, metaRestoreBackup } from '../lib/bridge';
import type { ExifClearResultDto, ExifInventoryDto, ExifClearScopesDto, ExifGroupDto } from '../lib/types';
import { baseName } from '../lib/format';
import { Icon } from './Icon';

const EMPTY_SCOPES: ExifClearScopesDto = { gps: false, camera: false, time: false, thumbnail: false, all: false };

/** 图片信息 → EXIF 清除：预览（实际存在项）→ 备份 → 分组清除 → 回读校验 → 可还原。 */
export function ExifClearPanel({ paths }: { paths: string[] }) {
  const { t } = useTranslation();
  const showToast = useApp((s) => s.showToast);
  const refresh = useApp((s) => s.refreshEntriesFromDisk);
  const [scopes, setScopes] = useState<ExifClearScopesDto>(EMPTY_SCOPES);
  const [clearXmp, setClearXmp] = useState(false);
  const [cleanLevel, setCleanLevel] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [inventories, setInventories] = useState<ExifInventoryDto[] | null>(null);
  const [previewed, setPreviewed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<ExifClearResultDto[] | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  const anyScope = scopes.gps || scopes.camera || scopes.time || scopes.thumbnail || scopes.all;

  const toggle = (id: keyof ExifClearScopesDto, on: boolean) => {
    setPreviewed(false);
    setResults(null);
    if (id === 'all') {
      setScopes(on ? { ...EMPTY_SCOPES, all: true } : EMPTY_SCOPES);
      return;
    }
    setScopes((prev) => ({ ...prev, [id]: on, all: false }));
  };

  const preview = async () => {
    setPreviewing(true);
    setResults(null);
    try {
      const list = await Promise.all(paths.map((path) => exifInventory(path)));
      setInventories(list);
      setPreviewed(true);
      setCleanLevel(list.some((item) => item.groups.length > 0));
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  };

  const apply = async () => {
    if (!previewed) {
      showToast('info', t('exif.needPreview'));
      return;
    }
    setApplying(true);
    try {
      const out = await exifClear(
        paths.map((path) => ({ path, scopes, clearXmp, backup: true })),
      );
      setResults(out);
      const ok = out.filter((r) => r.ok).length;
      showToast(
        ok === out.length ? 'success' : ok ? 'warn' : 'error',
        t('exif.applyDone', { ok, failed: out.length - ok }),
      );
      void refresh(out.filter((r) => r.ok).map((r) => r.path));
      // 清除后立即重读预览，证明范围确实消失
      const again = await Promise.all(paths.map((path) => exifInventory(path).catch(() => null)));
      setInventories(again.filter(Boolean) as ExifInventoryDto[]);
      setPreviewed(true);
      const left = again.some((item) => item && item.groups.some((g) => selectedGroup(g, scopes)));
      if (!left) setCleanLevel(true);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  };

  const restore = async (item: ExifClearResultDto) => {
    if (!item.backup) return;
    setRestoring(item.path);
    try {
      await metaRestoreBackup(item.backup, item.path);
      showToast('success', t('exif.restored', { name: baseName(item.path) }));
      void refresh([item.path]);
      const again = await exifInventory(item.path).catch(() => null);
      if (again) setInventories((prev) => (prev ? prev.map((x) => (x.path === item.path ? again : x)) : prev));
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div className="exif-panel" data-testid="exif-panel">
      <div className="meta-edit-hint page-note" data-testid="exif-note">
        <Icon name="info" size={13} />{t('exif.note')}
      </div>

      <div className="exif-scopes" data-testid="exif-scopes">
        {(['gps', 'camera', 'time', 'thumbnail', 'all'] as const).map((id) => (
          <label className={`exif-scope${scopes.all && id !== 'all' ? ' muted' : ''}`} key={id}>
            <input
              type="checkbox"
              checked={scopes[id]}
              disabled={scopes.all && id !== 'all'}
              data-testid={`exif-scope-${id}`}
              onChange={(e) => toggle(id, e.target.checked)}
            />
            <span>{t(`exif.scope.${id}`)}</span>
          </label>
        ))}
        <label className="exif-scope exif-xmp" title={t('exif.xmpHint')}>
          <input
            type="checkbox"
            checked={clearXmp}
            data-testid="exif-xmp"
            onChange={(e) => {
              setClearXmp(e.target.checked);
              setPreviewed(false);
            }}
          />
          <span>{t('exif.clearXmp')}</span>
        </label>
      </div>

      <div className="exif-protect" data-testid="exif-protect">
        <Icon name="shield" size={13} />
        <span>{t('exif.protect')}</span>
      </div>

      <div className="exif-actions">
        <button className="btn btn-ghost" type="button" data-testid="exif-preview" disabled={previewing} onClick={() => void preview()}>
          <Icon name="search" size={13} />{previewing ? t('exif.previewing') : t('exif.preview')}
        </button>
        <button
          className="btn btn-primary"
          type="button"
          data-testid="exif-apply"
          disabled={applying || !previewed || !anyScope}
          onClick={() => void apply()}
        >
          <Icon name="ban" size={13} />{applying ? t('exif.applying') : t('exif.apply')}
        </button>
        {cleanLevel && <span className="exif-clean-note" data-testid="exif-clean-note">{t('exif.cleanNow')}</span>}
      </div>

      {inventories && (
        <div className="exif-inventory" data-testid="exif-inventory">
          {inventories.map((item, index) => {
            const removing = item.groups.filter((g) => selectedGroup(g, scopes));
            return (
              <div className="exif-file" key={item.path} data-testid={`exif-file-${index}`}>
                <div className="exif-file-head">
                  <Icon name={item.hasExif ? 'image' : 'info'} size={13} />
                  <strong>{baseName(item.path)}</strong>
                  <span className="meta-format">{item.format}</span>
                  {item.orientation > 0 && (
                    <span className="exif-badge" data-testid={`exif-orientation-${index}`}>
                      Orientation={item.orientation} · {t('exif.keep')}
                    </span>
                  )}
                  {item.hasIcc && (
                    <span className="exif-badge" data-testid={`exif-icc-${index}`}>{t('exif.iccKeep')}</span>
                  )}
                  {item.hasXmp && (
                    <span className={`exif-badge ${clearXmp ? 'warn' : ''}`} data-testid={`exif-xmp-badge-${index}`}>
                      {clearXmp ? t('exif.xmpWillClean') : t('exif.xmpKeep')}
                    </span>
                  )}
                </div>
                {item.groups.length === 0 && (
                  <div className="exif-line">{t('exif.noItems')}</div>
                )}
                {item.groups.length > 0 && (
                  <div className="exif-groups">
                    {item.groups.map((group) => (
                      <div className={`exif-group${selectedGroup(group, scopes) ? ' removing' : ''}`} key={group.id} data-testid={`exif-group-${index}-${group.id}`}>
                        <span className="exif-group-name">{group.label}</span>
                        <span className="exif-group-items">{group.items.join(' / ')}</span>
                        <span className="exif-group-state">
                          {selectedGroup(group, scopes) ? t('exif.willRemove') : t('exif.willKeep')}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {removing.length > 0 && (
                  <div className="exif-line exif-remove-line" data-testid={`exif-remove-${index}`}>
                    {t('exif.removeList')}：{removing.map((g) => `${g.label}（${g.items.join('、')}）`).join('；')}
                  </div>
                )}
                {item.warnings.map((w) => (
                  <div className="exif-line muted" key={w}>{w}</div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {results && (
        <div className="exif-results" data-testid="exif-results">
          <div className="meta-results-head">{t('exif.resultTitle')}</div>
          {results.map((item, index) => (
            <div
              className={`exif-result ${item.ok ? 'ok' : 'bad'}`}
              key={item.path}
              data-testid={`exif-result-${index}`}
            >
              <div className="meta-result-line">
                <Icon name={item.ok ? 'check' : 'alert'} size={12} />
                <strong>{baseName(item.path)}</strong>
                <span className="meta-format">{item.format}</span>
                <span className="meta-result-state">
                  {item.ok ? t('exif.resultOk') : t('exif.resultFail')}
                </span>
                {item.ok && item.verified && <span className="meta-verified">{t('meta.verified')}</span>}
                {item.backup && (
                  <button
                    className="mini"
                    type="button"
                    disabled={restoring === item.path}
                    data-testid={`exif-restore-${index}`}
                    onClick={() => void restore(item)}
                  >
                    <Icon name="undo" size={12} />
                    {restoring === item.path ? t('meta.restoring') : t('meta.restore')}
                  </button>
                )}
              </div>
              {item.error && <div className="meta-result-msg">{item.error}</div>}
              {item.ok && (
                <div className="meta-result-msg" data-testid={`exif-result-meta-${index}`}>
                  {t('exif.resultMeta', {
                    before: item.orientationBefore || '—',
                    after: item.orientationAfter || '—',
                    icc: item.iccAfter ? t('exif.iccKeepShort') : t('exif.iccNone'),
                    pixels:
                      item.pixelsUnchanged === null
                        ? t('exif.pixelTiff')
                        : item.pixelsUnchanged
                          ? t('exif.pixelSame')
                          : t('exif.pixelChanged'),
                  })}
                </div>
              )}
              {item.warnings.map((w) => (
                <div className="meta-result-msg" key={w}>{w}</div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function selectedGroup(group: ExifGroupDto, scopes: ExifClearScopesDto): boolean {
  if (scopes.all) return true;
  return Boolean(scopes[group.id as 'gps' | 'camera' | 'time' | 'thumbnail']);
}
