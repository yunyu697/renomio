import { useState } from 'react';
import { useTranslation } from '../i18n';
import { PageShell, usePageTargets } from './FeaturePage';
import { MetaEditorBody } from './MetaEditDialog';
import { ExifClearPanel } from './ExifClearPanel';
import { Icon } from './Icon';

export function MusicPage() {
  const { t } = useTranslation();
  const { panel, targets } = usePageTargets('music');
  return (
    <PageShell
      page="music"
      icon="music"
      title={t('nav.music')}
      subtitle={t('page.musicSubtitle')}
    >
      {panel}
      {targets.length > 0 && (
        <div className="page-editor" data-testid="music-editor">
          <MetaEditorBody
            paths={targets.map((f) => f.path)}
            note={t('page.musicNote')}
          />
        </div>
      )}
    </PageShell>
  );
}

export function ImagePage() {
  const { t } = useTranslation();
  const { panel, targets } = usePageTargets('image');
  const [tab, setTab] = useState<'fields' | 'exif'>('fields');
  return (
    <PageShell
      page="image"
      icon="image"
      title={t('nav.image')}
      subtitle={t('page.imageSubtitle')}
      extra={
        <div className="page-tabs" role="tablist">
          <button
            className={`mini ${tab === 'fields' ? 'on' : ''}`}
            type="button"
            role="tab"
            aria-selected={tab === 'fields'}
            data-testid="image-tab-fields"
            onClick={() => setTab('fields')}
          >
            <Icon name="tag" size={12} />{t('page.imageTabFields')}
          </button>
          <button
            className={`mini ${tab === 'exif' ? 'on' : ''}`}
            type="button"
            role="tab"
            aria-selected={tab === 'exif'}
            data-testid="image-tab-exif"
            onClick={() => setTab('exif')}
          >
            <Icon name="ban" size={12} />{t('page.imageTabExif')}
          </button>
        </div>
      }
    >
      {panel}
      {targets.length > 0 && tab === 'fields' && (
        <div className="page-editor" data-testid="image-editor">
          <MetaEditorBody
            paths={targets.map((f) => f.path)}
            note={t('page.imageNote')}
          />
        </div>
      )}
      {targets.length > 0 && tab === 'exif' && (
        <div className="page-editor" data-testid="exif-editor">
          <ExifClearPanel paths={targets.map((f) => f.path)} />
        </div>
      )}
    </PageShell>
  );
}

export function OfficePage() {
  const { t } = useTranslation();
  const { panel, targets } = usePageTargets('office');
  return (
    <PageShell
      page="office"
      icon="doc"
      title={t('nav.office')}
      subtitle={t('page.officeSubtitle')}
    >
      {panel}
      {targets.length > 0 && (
        <div className="page-editor" data-testid="office-editor">
          <MetaEditorBody
            paths={targets.map((f) => f.path)}
            note={t('page.officeNote')}
          />
        </div>
      )}
    </PageShell>
  );
}
