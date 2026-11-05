import { useTranslation } from '../i18n';
import { useApp } from '../store';
import { Icon } from './Icon';

/** 只读元数据弹窗：任何字段都只展示，不提供写入入口。 */
export function MetadataDialog() {
  const { t } = useTranslation();
  const metadata = useApp((s) => s.metadata);
  const close = useApp((s) => s.closeMetadata);
  if (!metadata.open) return null;

  const kindKey: Record<string, string> = {
    image: 'meta.image',
    audio: 'meta.audio',
    document: 'meta.document',
    other: 'meta.other',
  };

  return (
    <div className="modal-mask" onClick={close}>
      <div className="dialog dialog-meta" data-testid="metadata-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h4>
            <Icon name="info" size={16} style={{ color: 'var(--accent)' }} />
            {t('meta.title')}
            <span className="readonly-chip"><Icon name="lock" size={11} />{t('meta.readonly')}</span>
          </h4>
          <p>{metadata.name} · {metadata.path}</p>
        </div>
        <div className="dialog-body">
          {metadata.loading && <div className="meta-loading">{t('meta.loading')}</div>}
          {!metadata.loading && metadata.error && (
            <div className="meta-error" data-testid="metadata-error">
              <Icon name="alert" size={14} />{metadata.error}
            </div>
          )}
          {!metadata.loading && metadata.info && (
            <>
              <div className="meta-head">
                <span className="meta-kind">{t(kindKey[metadata.info.kind] ?? 'meta.other')}</span>
                <span className="meta-format">{metadata.info.format}</span>
              </div>
              <div className="meta-grid">
                {metadata.info.fields.map((field) => (
                  <div className="meta-row" key={field.label}>
                    <span className="meta-label">{field.label}</span>
                    <span className="meta-value" title={field.value}>{field.value}</span>
                  </div>
                ))}
                {!metadata.info.fields.length && <div className="meta-empty">{t('meta.empty')}</div>}
              </div>
              {metadata.info.warnings.length > 0 && (
                <div className="meta-warnings">
                  {metadata.info.warnings.map((warning) => (
                    <div className="meta-warning" key={warning}>
                      <Icon name="alert" size={12} />{warning}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <div className="dialog-foot">
          <span className="foot-note">{t('meta.footer')}</span>
          <div className="right">
            <button className="btn btn-primary" type="button" onClick={close}>{t('common.close')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
