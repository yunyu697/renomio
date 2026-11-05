/** 提权状态提示：UIPI 拖放限制（已提权时）与提权取消/失败说明。 */
import { useTranslation } from '../i18n';
import { useApp } from '../store';
import { Icon } from './Icon';

export function ElevationNotice() {
  const { t } = useTranslation();
  const uipiNotice = useApp((s) => s.uipiNotice);
  const elevationMessage = useApp((s) => s.elevationMessage);
  const privilege = useApp((s) => s.privilege);
  const dismissUipiNotice = useApp((s) => s.dismissUipiNotice);
  const dismissElevationMessage = useApp((s) => s.dismissElevationMessage);

  if (!uipiNotice && !elevationMessage) return null;

  return (
    <>
      {uipiNotice && (
        <div className="notice-strip" data-testid="uipi-notice">
          <Icon name="alert" size={13} />
          <span>
            {t('elev.uipi', { dir: privilege?.installDir || '—' })}
          </span>
          <button className="btn btn-ghost" type="button" data-testid="uipi-dismiss" onClick={dismissUipiNotice}>
            {t('elev.gotIt')}
          </button>
        </div>
      )}
      {elevationMessage && (
        <div className="notice-strip warn" data-testid="elevation-message">
          <Icon name="info" size={13} />
          <span>{elevationMessage}</span>
          <button className="btn btn-ghost" type="button" onClick={dismissElevationMessage}>
            {t('elev.close')}
          </button>
        </div>
      )}
    </>
  );
}
