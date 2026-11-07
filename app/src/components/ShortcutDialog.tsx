import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n';
import {
  bindingFromEvent,
  displayBinding,
  DEFAULT_SHORTCUTS,
  SHORTCUT_IDS,
  type ShortcutId,
} from '../lib/shortcuts';
import { useApp } from '../store';
import { Icon } from './Icon';

/** 键位窗：列出全部全局快捷键，点「更改」后按下新组合即可录制。 */
export function ShortcutDialog() {
  const { t } = useTranslation();
  const open = useApp((s) => s.shortcutOpen);
  const close = useApp((s) => s.closeShortcuts);
  const shortcuts = useApp((s) => s.settings.shortcuts);
  const setShortcut = useApp((s) => s.setShortcut);
  const resetShortcuts = useApp((s) => s.resetShortcuts);
  const showToast = useApp((s) => s.showToast);
  const [recording, setRecording] = useState<ShortcutId | null>(null);

  useEffect(() => {
    if (!open) setRecording(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey) return;
      e.stopPropagation();
      if (recording) setRecording(null);
      else close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, recording, close]);

  useEffect(() => {
    if (!open || !recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(null);
        return;
      }
      const binding = bindingFromEvent(e);
      if (!binding) return;
      if (!binding.includes('+')) {
        showToast('warn', t('shortcuts.needModifier'));
        return;
      }
      // 冲突时不退出录制，便于直接重按
      if (setShortcut(recording, binding)) setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, recording, setShortcut, showToast, t]);

  if (!open) return null;

  return (
    <div className="modal-mask" onClick={close}>
      <div className="dialog shortcut-dialog" data-testid="shortcut-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h4>
            <Icon name="help" size={16} style={{ color: 'var(--accent)' }} />
            {t('shortcuts.title')}
          </h4>
          <p>{recording ? t('shortcuts.pressEsc') : t('shortcuts.subtitle')}</p>
        </div>
        <div className="dialog-body">
          <div className="shortcut-list">
            {SHORTCUT_IDS.map((id) => (
              <div className="shortcut-row" key={id} data-testid={`shortcut-${id}`}>
                <span className="shortcut-name">{t(`shortcuts.${id}`)}</span>
                <kbd className={`kbd${recording === id ? ' recording' : ''}`} data-testid={`shortcut-value-${id}`}>
                  {recording === id ? t('shortcuts.press') : displayBinding(shortcuts[id] ?? DEFAULT_SHORTCUTS[id])}
                </kbd>
                <button
                  className="btn btn-outline"
                  type="button"
                  data-testid={`shortcut-record-${id}`}
                  onClick={() => setRecording(recording === id ? null : id)}
                >
                  {recording === id ? t('shortcuts.cancel') : t('shortcuts.change')}
                </button>
              </div>
            ))}
          </div>
          <div className="drawer-note">{t('shortcuts.note')}</div>
        </div>
        <div className="dialog-foot">
          <button className="btn btn-ghost" type="button" data-testid="shortcut-reset" onClick={resetShortcuts}>
            {t('shortcuts.reset')}
          </button>
          <div className="right">
            <button className="btn btn-outline" type="button" onClick={close}>
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
