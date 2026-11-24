import { useEffect, useRef, useState } from 'react';
import { useApp } from '../store';
import { useTranslation } from '../i18n';
import {
  deleteCommand, loadCommands, saveCommand, touchCommand, type SavedCommand,
} from '../lib/commands';
import { Icon } from './Icon';

/**
 * 命令列表：把「规则链 + 冲突策略」存成一条批量作业。
 * 「套用」只载入规则链与策略；「运行」载入后直接进入预览确认，避免未经确认就动文件。
 */
export function CommandsDialog() {
  const { t, locale } = useTranslation();
  const open = useApp((s) => s.commandsOpen);
  const rules = useApp((s) => s.rules);
  const applyPolicy = useApp((s) => s.applyPolicy);
  const close = useApp((s) => s.closeCommands);
  const applyCommand = useApp((s) => s.applyCommand);
  const runCommand = useApp((s) => s.runCommand);
  const showToast = useApp((s) => s.showToast);

  const [commands, setCommands] = useState<SavedCommand[]>([]);
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setCommands(loadCommands());
    setName('');
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  if (!open) return null;

  const stamp = (value: number) =>
    value > 0
      ? new Date(value).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : t('commands.neverRun');

  const save = () => {
    if (!rules.length) {
      showToast('info', t('commands.noRules'));
      return;
    }
    const trimmed = name.trim() || t('plan.defaultName');
    setCommands(saveCommand(trimmed, rules, applyPolicy));
    setName('');
    showToast('success', t('commands.saved', { name: trimmed, count: rules.length }));
  };

  const run = (cmd: SavedCommand) => {
    runCommand(cmd.name, cmd.rules, cmd.policy);
    setCommands(touchCommand(cmd.id));
  };

  const remove = (cmd: SavedCommand) => {
    setCommands(deleteCommand(cmd.id));
    showToast('info', t('commands.deleted', { name: cmd.name }));
  };

  return (
    <div className="modal-mask" onClick={close}>
      <div className="dialog dialog-plan" data-testid="commands-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h4>
            <Icon name="bolt" size={16} style={{ color: 'var(--ds-color-accent)' }} />
            {t('commands.title')}
          </h4>
          <p>{t('commands.sub')}</p>
        </div>

        <div className="dialog-body">
          <label className="field-label" htmlFor="commands-name">{t('commands.name')}</label>
          <div className="plans-save">
            <input
              id="commands-name"
              ref={inputRef}
              className="input"
              data-testid="commands-name"
              value={name}
              maxLength={60}
              placeholder={t('commands.namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
              }}
            />
            <button className="btn btn-primary" type="button" data-testid="commands-save" onClick={save}>
              <Icon name="save" size={13} />{t('commands.save')}
            </button>
          </div>
          <div className="foot-note" data-testid="commands-policy-hint">
            {t('commands.saveHint', { policy: t(`policy.${applyPolicy}`), count: rules.length })}
          </div>

          <div className="plans-section-title">{t('commands.list')}</div>
          <div className="plans-list" data-testid="commands-list">
            {commands.length === 0 && (
              <div className="foot-note" data-testid="commands-empty">{t('commands.empty')}</div>
            )}
            {commands.map((cmd) => (
              <div className="plans-item" key={cmd.id} data-testid="commands-item" data-command-name={cmd.name}
                data-command-runs={cmd.runs} data-command-policy={cmd.policy}>
                <span className="plans-item-name" title={cmd.name}>{cmd.name}</span>
                <span className="plans-item-meta" data-testid="commands-meta">
                  {t('commands.meta', {
                    count: cmd.rules.length,
                    policy: t(`policy.${cmd.policy}`),
                    runs: cmd.runs,
                    at: stamp(cmd.lastRunAt),
                  })}
                </span>
                <button className="mini" type="button" data-testid="commands-apply" onClick={() => applyCommand(cmd.name, cmd.rules, cmd.policy)}>
                  {t('commands.apply')}
                </button>
                <button className="mini" type="button" data-testid="commands-run" onClick={() => run(cmd)}>
                  {t('commands.run')}
                </button>
                <button className="mini" type="button" data-testid="commands-delete" onClick={() => remove(cmd)}>
                  {t('commands.delete')}
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="dialog-foot">
          <span className="foot-note">{t('commands.footer')}</span>
          <div className="right">
            <button className="btn btn-ghost" type="button" onClick={close}>{t('common.close')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
