import { useMemo } from 'react';
import { useApp } from '../store';
import { useTranslation } from '../i18n';
import { PageShell, usePageTargets } from './FeaturePage';
import { AttrBody, MoveBody, TimeBody } from './OpsDialog';

/** 页内目标就是本次操作的对象；归类预览等逻辑仍按 selected 过滤，这里统一标记。 */
function useOpsTargets(kind: 'any') {
  const { panel, targets, files } = usePageTargets(kind);
  const opsTargets = useMemo(
    () => targets.map((t) => (t.selected ? t : { ...t, selected: true })),
    [targets],
  );
  return { panel, targets: opsTargets, files };
}

export function AttrsPage() {
  const { t } = useTranslation();
  const { panel, targets } = useOpsTargets('any');
  const closePage = useApp((s) => s.closePage);
  return (
    <PageShell
      page="attrs"
      icon="grid"
      title={t('nav.attrs')}
      subtitle={t('page.attrsSubtitle')}
    >
      {panel}
      {targets.length > 0 && (
        <div className="page-editor" data-testid="attrs-editor">
          <AttrBody targets={targets} onClose={closePage} />
        </div>
      )}
    </PageShell>
  );
}

export function TimesPage() {
  const { t } = useTranslation();
  const { panel, targets } = useOpsTargets('any');
  const closePage = useApp((s) => s.closePage);
  return (
    <PageShell
      page="times"
      icon="clock"
      title={t('nav.times')}
      subtitle={t('page.timesSubtitle')}
    >
      {panel}
      {targets.length > 0 && (
        <div className="page-editor" data-testid="times-editor">
          <TimeBody targets={targets} onClose={closePage} />
        </div>
      )}
    </PageShell>
  );
}

export function OrganizePage() {
  const { t } = useTranslation();
  const { panel, targets } = useOpsTargets('any');
  const closePage = useApp((s) => s.closePage);
  return (
    <PageShell
      page="organize"
      icon="folder"
      title={t('nav.organize')}
      subtitle={t('page.organizeSubtitle')}
    >
      {panel}
      {targets.length > 0 && (
        <div className="page-editor" data-testid="organize-editor">
          <MoveBody targets={targets} onClose={closePage} />
        </div>
      )}
    </PageShell>
  );
}
