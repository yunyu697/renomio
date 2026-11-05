import { useApp } from '../store';
import { planSummary } from '../lib/plan';
import { RULE_TYPES } from '../lib/ruleDefaults';
import { useTranslation } from '../i18n';
import type { RuleType } from '../lib/types';
import { Icon } from './Icon';

/** 方案导入 / 导出的确认弹窗：导入时显式提示版本、校验与替换冲突。 */
export function PlanDialog() {
  const { t } = useTranslation();
  const dialog = useApp((s) => s.planDialog);
  const currentRules = useApp((s) => s.rules.length);
  const close = useApp((s) => s.closePlanDialog);
  const setPlanName = useApp((s) => s.setPlanName);
  const confirmExport = useApp((s) => s.confirmPlanExport);
  const confirmImport = useApp((s) => s.confirmPlanImport);
  if (!dialog) return null;

  const isExport = dialog.mode === 'export';
  return (
    <div className="modal-mask" onClick={close}>
      <div className="dialog dialog-plan" data-testid="plan-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h4>
            <Icon name={isExport ? 'save' : 'import'} size={16} style={{ color: 'var(--accent)' }} />
            {isExport ? t('plan.exportTitle') : t('plan.importTitle')}
          </h4>
          <p>
            {isExport ? t('plan.exportSub') : t('plan.importSub')}
          </p>
        </div>

        <div className="dialog-body">
          {isExport ? (
            <>
              <label className="field-label" htmlFor="plan-name">{t('plan.name')}</label>
              <input
                id="plan-name"
                className="input"
                data-testid="plan-name-input"
                value={dialog.name}
                maxLength={60}
                onChange={(e) => setPlanName(e.target.value)}
                placeholder={t('plan.namePlaceholder')}
              />
              <div className="plan-stats">
                {t('plan.stats', { count: dialog.count })}
              </div>
              <div className="plan-note">
                {t('plan.exportNote')}
              </div>
            </>
          ) : (
            <>
              <div className="plan-file" title={dialog.fileName}>
                <Icon name="doc" size={14} />{dialog.fileName}
              </div>
              {dialog.error ? (
                <div className="plan-error" data-testid="plan-error">
                  <Icon name="alert" size={14} />
                  <div>
                    <b>{t('plan.cannotImport')}</b>
                    <div>{dialog.error}</div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="plan-stats">
                    <span className={`plan-badge ${dialog.checksumOk ? 'ok' : 'warn'}`} data-testid="plan-checksum">
                      {dialog.checksumOk ? t('plan.checksumOk') : t('plan.checksumBad')}
                    </span>
                    <span className="plan-badge">v{dialog.version ?? 1}</span>
                    <span className="plan-badge">{t('plan.ruleCount', { count: dialog.rules.length })}</span>
                    <span className="plan-badge">「{dialog.name || t('plan.unnamed')}」</span>
                  </div>
                  {currentRules > 0 && (
                    <div className="plan-conflict" data-testid="plan-conflict">
                      <Icon name="alert" size={13} />
                      {t('plan.conflict', { count: currentRules })}
                    </div>
                  )}
                  {dialog.warnings.length > 0 && (
                    <div className="plan-warnings" data-testid="plan-warnings">
                      {dialog.warnings.map((warning) => (
                        <div className="plan-warning" key={warning}>
                          <Icon name="info" size={12} />{warning}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="plan-preview">
                    {dialog.rules.slice(0, 6).map((rule) => (
                      <div className="plan-rule" key={rule.id}>
                        <span className={`rule-dot ${rule.enabled ? 'on' : ''}`} />
                        <span className="plan-rule-type">
                          {RULE_TYPES.includes(rule.type as RuleType) ? t(`ruleType.${rule.type}`) : rule.type}
                        </span>
                        <span className="plan-rule-id">{rule.id}</span>
                      </div>
                    ))}
                    {dialog.rules.length > 6 && <div className="plan-more">{t('plan.more', { count: dialog.rules.length - 6 })}</div>}
                  </div>
                  <div className="plan-note">
                    {planSummary({
                      ok: true,
                      warnings: dialog.warnings,
                      name: dialog.name,
                      rules: dialog.rules,
                      version: dialog.version,
                      checksumOk: dialog.checksumOk,
                    })}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <div className="dialog-foot">
          <span className="foot-note">
            {isExport ? t('plan.exportFooter') : t('plan.importFooter')}
          </span>
          <div className="right">
            <button className="btn btn-ghost" type="button" onClick={close}>{t('common.cancel')}</button>
            {isExport ? (
              <button className="btn btn-primary" type="button" data-testid="plan-confirm" onClick={() => void confirmExport()}>
                <Icon name="save" />{t('plan.save')}
              </button>
            ) : (
              <button
                className="btn btn-primary"
                type="button"
                data-testid="plan-confirm"
                disabled={!!dialog.error}
                onClick={confirmImport}
              >
                <Icon name="import" />{currentRules > 0 ? t('plan.replaceImport') : t('plan.import')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
