/** 执行后逐条失败清单：按原因分组、标明具体文件，并提供「以管理员重启 / 跳过该项」。 */
import { baseName } from '../lib/format';
import { explainFailure, hasAdminFixable, isInProgramFiles, summarizeFailures } from '../lib/permission';
import { useTranslation } from '../i18n';
import { useApp } from '../store';
import { Icon } from './Icon';

export function FailureDialog() {
  const { t } = useTranslation();
  const report = useApp((s) => s.failureReport);
  const close = useApp((s) => s.closeFailureReport);
  const acknowledge = useApp((s) => s.acknowledgeFailure);
  const relaunch = useApp((s) => s.relaunchElevated);
  const privilege = useApp((s) => s.privilege);

  if (!report) return null;

  const summary = summarizeFailures(report.items);
  const adminFixable = hasAdminFixable(report.items);
  const elevated = privilege?.elevated ?? false;
  const inProgramFiles = isInProgramFiles(privilege?.installDir ?? '');

  return (
    <div className="modal-mask" onClick={close} data-testid="failure-dialog">
      <div className="dialog dialog-wide" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h4>
            <Icon name="alert" size={16} style={{ color: 'var(--warn)' }} />
            {t('failure.title')}
          </h4>
          <p>
            {t('failure.sub', { done: report.done, total: report.total, count: report.items.length })}
          </p>
        </div>
        <div className="dialog-body">
          <div className="failure-summary" data-testid="failure-summary">
            {summary.map((group) => (
              <span className="failure-chip" key={group.code} data-code={group.code}>
                {group.title} <b>{group.count}</b>
              </span>
            ))}
          </div>

          {(adminFixable || inProgramFiles) && (
            <div className="policy-hint danger" data-testid="failure-admin-hint">
              <Icon name="info" size={13} />
              {elevated
                ? t('failure.elevatedTip')
                : inProgramFiles
                  ? t('failure.programFilesTip')
                  : t('failure.permissionTip')}
            </div>
          )}

          <div className="mini-table failure-table">
            <div className="mini-row head">
              <span>{t('failure.file')}</span><span>{t('failure.reason')}</span><span>{t('failure.action')}</span><span />
            </div>
            {report.items.map((item) => {
              const info = explainFailure(item.code, item.reason);
              return (
                <div className="mini-row" key={item.id} data-testid="failure-item" data-code={info.code}>
                  <span className="n old" title={item.source}>{baseName(item.source)}</span>
                  <span className="mini-status" style={{ color: 'var(--danger)' }}>{info.title}</span>
                  <span className="failure-tip" title={item.reason}>{info.detail}</span>
                  <span>
                    <button
                      className="btn btn-ghost"
                      type="button"
                      data-testid="failure-skip"
                      onClick={() => acknowledge(item.id)}
                    >
                      {t('failure.skip')}
                    </button>
                  </span>
                </div>
              );
            })}
            {!report.items.length && <div className="mini-empty">{t('failure.empty')}</div>}
          </div>
        </div>
        <div className="dialog-foot">
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            {t('failure.footer')}
          </span>
          <div className="right">
            {adminFixable && !elevated && (
              <button
                className="btn btn-soft"
                type="button"
                data-testid="failure-relaunch"
                onClick={() => void relaunch()}
              >
                <Icon name="shield" />{t('failure.relaunch')}
              </button>
            )}
            <button className="btn btn-primary" type="button" onClick={close}>{t('common.close')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
