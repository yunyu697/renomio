import { useEffect, useState, type ReactNode } from 'react';
import { formatTime } from '../lib/format';
import { useTranslation } from '../i18n';
import { PRODUCT_NAME } from '../lib/branding';
import type { BatchSummary, ConflictPolicy, LocaleSetting } from '../lib/types';
import { useApp } from '../store';
import { Icon } from './Icon';

const STATE_KEY: Record<BatchSummary['state'], string> = {
  pending: 'history.statePending',
  completed: 'history.stateCompleted',
  partial: 'history.statePartial',
  cancelled: 'history.stateCancelled',
  undone: 'history.stateUndone',
  'undo-partial': 'history.stateUndoPartial',
};

const KIND_KEY: Record<string, string> = {
  rename: 'history.kindRename',
  time: 'history.kindTime',
  attrs: 'history.kindAttrs',
  move: 'history.kindMove',
};

export function Drawer() {
  const drawer = useApp((s) => s.drawer);
  const closeDrawer = useApp((s) => s.closeDrawer);

  if (!drawer) return null;

  return (
    <div className="modal-mask drawer-mask" onClick={closeDrawer}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        {drawer === 'history' && <HistoryPanel />}
        {drawer === 'settings' && <SettingsPanel />}
        {drawer === 'about' && <AboutPanel />}
      </div>
    </div>
  );
}

function DrawerHead({ title, sub }: { title: string; sub: string }) {
  const { t } = useTranslation();
  const closeDrawer = useApp((s) => s.closeDrawer);
  return (
    <div className="drawer-head">
      <div>
        <h3>{title}</h3>
        <p>{sub}</p>
      </div>
      <button className="btn-icon" type="button" title={t('drawer.close')} onClick={closeDrawer}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

function HistoryPanel() {
  const { t } = useTranslation();
  const batches = useApp((s) => s.batches);
  const refreshBatches = useApp((s) => s.refreshBatches);
  const undoBatch = useApp((s) => s.undoBatch);
  const undoUntil = useApp((s) => s.undoUntil);
  const undoBusy = useApp((s) => s.undoBusy);
  const applying = useApp((s) => s.applying);
  const env = useApp((s) => s.env);
  const isDemo = useApp((s) => s.isDemo);
  const revealPath = (path: string) => {
    void import('../lib/bridge').then(({ revealPath: reveal }) => reveal(path).catch(() => undefined));
  };
  const undoableCount = batches.filter((b) => b.undoable).length;

  // 批次历史改为按需加载：只在打开面板时读磁盘，避免启动首屏等待
  useEffect(() => {
    void refreshBatches();
  }, [refreshBatches]);

  return (
    <>
      <DrawerHead
        title={t('history.title')}
        sub={t('history.sub', { total: batches.length, undoable: undoableCount })}
      />
      <div className="drawer-body">
        {batches.length === 0 && <div className="drawer-empty">{t('history.empty')}</div>}
        <div className="undo-list">
          {batches.map((batch, index) => {
            const canUndo = batch.undoable === true;
            // 多级撤销：较新的批次必须都可撤销，才能回退到这一批
            const newerBlocked = batches.slice(0, index).find((b) => !b.undoable);
            return (
              <div
                className={`undo-item ${canUndo ? 'current' : ''}`}
                key={batch.id}
                data-testid="history-item"
                data-batch-id={batch.id}
                data-undoable={canUndo ? '1' : '0'}
              >
                <div style={{ minWidth: 0 }}>
                  <div className="when">
                    {formatTime(batch.createdAt)} · {KIND_KEY[batch.kind ?? 'rename'] ? t(KIND_KEY[batch.kind ?? 'rename']) : batch.kind}
                  </div>
                  <div className="what" title={batch.roots.join(' · ')}>
                    {t('history.counts', {
                      root: batch.roots[0] ?? t('history.noRoot'),
                      done: batch.counts.done,
                      total: batch.counts.total,
                      skipped: batch.counts.skipped,
                      failed: batch.counts.failed,
                    })}
                  </div>
                  <div className="when" style={{ marginTop: 2 }}>
                    <span data-testid="history-state">{t(STATE_KEY[batch.state])}</span> ·{' '}
                    {t('history.meta', {
                      policy: batch.policy,
                      undoable: canUndo ? t('history.undo') : t('history.notUndoable'),
                    })}
                  </div>
                  {!canUndo && batch.undoReason && (
                    <div className="undo-reason" data-testid="undo-reason">
                      {batch.undoReason}
                    </div>
                  )}
                </div>
                <span className="cnt">{batch.id.slice(-8)}</span>
                {canUndo ? (
                  <>
                    <button
                      className="btn btn-outline"
                      type="button"
                      data-testid="undo-batch"
                      disabled={undoBusy || applying}
                      onClick={() => void undoBatch(batch.id)}
                    >
                      <Icon name="undo" size={12} />{t('history.undo')}
                    </button>
                    {index > 0 && (
                      <button
                        className="btn btn-ghost"
                        type="button"
                        data-testid="undo-until"
                        title={
                          newerBlocked
                            ? t('history.undoToHintBlocked', { reason: newerBlocked.undoReason ?? t('history.unknownState') })
                            : t('history.undoToHint', { count: index })
                        }
                        disabled={undoBusy || applying || !!newerBlocked}
                        onClick={() => void undoUntil(batch.id)}
                      >
                        <Icon name="undo" size={12} />{t('history.undoTo')}
                      </button>
                    )}
                  </>
                ) : (
                  <span className="chip" data-testid="undo-state" style={{ height: 24 }}>
                    {batch.state === 'undone'
                      ? t('history.undone')
                      : batch.state === 'undo-partial'
                        ? t('history.undoPartial')
                        : t('history.notUndoable')}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="drawer-foot">
        <span className="drawer-note">
          {isDemo ? t('history.demoOnly') : t('history.dataDir', { dir: env.dataDir })}
        </span>
        {!isDemo && (
          <button className="btn btn-ghost" type="button" onClick={() => revealPath(env.dataDir)}>
            <Icon name="folder" size={13} />{t('history.openDataDir')}
          </button>
        )}
        <button
          className="btn btn-ghost"
          type="button"
          data-testid="history-refresh"
          onClick={() => void refreshBatches()}
          style={{ marginLeft: 'auto' }}
        >
          <Icon name="refresh" size={13} />{t('history.refresh')}
        </button>
      </div>
    </>
  );
}

const LANG_OPTIONS: Array<{ value: LocaleSetting; label: string }> = [
  { value: 'system', label: 'settings.languageSystem' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en-US', label: 'English' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'es-ES', label: 'Español' },
];

function SettingsPanel() {
  const { t } = useTranslation();
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const setTheme = useApp((s) => s.setTheme);
  const env = useApp((s) => s.env);
  const isDemo = useApp((s) => s.isDemo);
  const privilege = useApp((s) => s.privilege);
  const relaunchElevated = useApp((s) => s.relaunchElevated);
  const migration = useApp((s) => s.migration);
  const importLegacy = useApp((s) => s.importLegacy);
  const language = settings.language ?? 'system';
  const unreviewed = language === 'zh-TW' || language === 'ja-JP' || language === 'es-ES';
  const historyLimit = useApp((s) => s.ruleHistory.limit);
  const historyFields = useApp((s) => Object.keys(s.ruleHistory.fields).length);
  const setHistoryLimit = useApp((s) => s.setHistoryLimit);
  const clearRuleHistory = useApp((s) => s.clearRuleHistory);
  const [limitDraft, setLimitDraft] = useState(String(historyLimit));
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => setLimitDraft(String(historyLimit)), [historyLimit]);
  const commitLimit = () => {
    const parsed = Number(limitDraft);
    setHistoryLimit(Number.isFinite(parsed) ? parsed : historyLimit);
  };

  return (
    <>
      <DrawerHead title={t('settings.title')} sub={t('settings.sub')} />
      <div className="drawer-body">
        <section className="settings-section">
          <h4>{t('settings.interface')}</h4>
          <Row label={t('settings.theme')}>
            <span className="seg-ctrl">
              <span className={settings.theme === 'light' ? 'on' : ''} onClick={() => setTheme('light')}>{t('settings.light')}</span>
              <span className={settings.theme === 'dark' ? 'on' : ''} onClick={() => setTheme('dark')}>{t('settings.dark')}</span>
            </span>
          </Row>
          <Row label={t('settings.language')} hint={t('settings.languageHint')}>
            <select
              className="select"
              style={{ width: 170 }}
              data-testid="select-language"
              value={language}
              onChange={(e) => updateSettings({ language: e.target.value as LocaleSetting })}
            >
              {LANG_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label.startsWith('settings.') ? t(option.label) : option.label}
                </option>
              ))}
            </select>
          </Row>
          {unreviewed && <div className="drawer-note" data-testid="lang-unreviewed">{t('settings.unreviewed')}</div>}
        </section>

        <section className="settings-section">
          <h4>{t('settings.nameSafety')}</h4>
          <Row label={t('settings.strictNames')} hint={t('settings.strictNamesHint')}>
            <Switch on={settings.strictWindowsNames} onChange={(v) => updateSettings({ strictWindowsNames: v })} />
          </Row>
          <Row label={t('settings.readonlySkip')} hint={t('settings.readonlySkipHint')}>
            <Switch on={settings.readonlySkip} onChange={(v) => updateSettings({ readonlySkip: v })} />
          </Row>
          <Row label={t('settings.replaceInvalid')} hint={t('settings.replaceInvalidHint')}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                className="input small mono"
                style={{ width: 54 }}
                maxLength={1}
                data-testid="input-invalid-replacement"
                value={settings.invalidReplacement}
                onChange={(e) => updateSettings({ invalidReplacement: e.target.value.slice(0, 1) || '_' })}
              />
              <Switch
                testId="switch-replace-invalid"
                on={settings.replaceInvalid}
                onChange={(v) => updateSettings({ replaceInvalid: v })}
              />
            </div>
          </Row>
          <Row label={t('settings.defaultPolicy')} hint={t('settings.defaultPolicyHint')}>
            <select
              className="select"
              style={{ width: 170 }}
              value={settings.conflictPolicy}
              onChange={(e) => updateSettings({ conflictPolicy: e.target.value as ConflictPolicy })}
            >
              <option value="skip">{t('settings.policySkip')}</option>
              <option value="suffix">{t('settings.policySuffix')}</option>
              <option value="overwrite">{t('settings.policyOverwrite')}</option>
            </select>
          </Row>
        </section>

        <section className="settings-section" data-testid="history-settings">
          <h4>{t('settings.historyGroup')}</h4>
          <Row label={t('settings.historyLimit')} hint={t('settings.historyLimitHint')}>
            <input
              className="input small mono"
              type="number"
              min={10}
              max={200}
              step={10}
              style={{ width: 76 }}
              data-testid="input-history-limit"
              value={limitDraft}
              onChange={(e) => setLimitDraft(e.target.value)}
              onBlur={commitLimit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitLimit();
              }}
            />
          </Row>
          <Row label={t('settings.historyClear')} hint={t('settings.historyClearHint', { count: historyFields })}>
            {confirmClear ? (
              <span style={{ display: 'flex', gap: 6 }}>
                <button
                  className="btn btn-danger-soft"
                  type="button"
                  data-testid="history-clear-confirm"
                  onClick={() => {
                    clearRuleHistory();
                    setConfirmClear(false);
                  }}
                >
                  {t('settings.historyClearConfirm')}
                </button>
                <button className="btn btn-outline" type="button" onClick={() => setConfirmClear(false)}>
                  {t('settings.historyCancel')}
                </button>
              </span>
            ) : (
              <button
                className="btn btn-outline"
                type="button"
                data-testid="history-clear"
                disabled={historyFields === 0}
                onClick={() => setConfirmClear(true)}
              >
                {t('settings.historyClearAction')}
              </button>
            )}
          </Row>
          <div className="drawer-note" style={{ marginTop: 8 }}>
            {t('settings.historyPath')}
          </div>
        </section>

        <section className="settings-section">
          <h4>{t('settings.privilege')}</h4>
          <Row label={t('settings.alwaysAdmin')} hint={t('settings.alwaysAdminHint')}>
            <Switch
              testId="switch-always-admin"
              on={settings.alwaysAdmin}
              onChange={(v) => {
                updateSettings({ alwaysAdmin: v });
                if (v && !privilege?.elevated) void relaunchElevated();
              }}
            />
          </Row>
          <div className="kv" style={{ marginTop: 6 }}>
            <b>{t('settings.currentPrivilege')}</b>
            <span>{isDemo ? t('settings.demoPrivilege') : privilege?.elevated ? t('settings.adminPrivilege') : t('settings.normalPrivilege')}</span>
            {!isDemo && privilege && (
              <>
                <b>{t('settings.installDir')}</b>
                <span style={{ wordBreak: 'break-all' }}>{privilege.installDir}</span>
              </>
            )}
          </div>
          {!isDemo && privilege && !privilege.elevated && /program files/i.test(privilege.installDir) && (
            <div className="drawer-note" style={{ marginTop: 8 }}>
              {t('settings.programFilesNote')}
            </div>
          )}
        </section>

        {migration?.oldDirExists && (
          <section className="settings-section" data-testid="legacy-section">
            <h4>{t('settings.migration')}</h4>
            <Row label={t('settings.legacyImport')} hint={t('settings.legacyImportHint', { dir: migration.oldDir })}>
              <button
                className="btn btn-outline"
                type="button"
                data-testid="import-legacy"
                onClick={() => void importLegacy()}
              >
                <Icon name="folder" size={13} />{t('settings.legacyImportAction')}
              </button>
            </Row>
            {migration.status === 'migrated' && (
              <div className="drawer-note">
                {t('settings.legacyMigrated', {
                  at: formatTime(migration.migratedAt ?? 0),
                  files: migration.files,
                })}
              </div>
            )}
          </section>
        )}

        <section className="settings-section">
          <h4>{t('settings.runtime')}</h4>
          <div className="kv">
            <b>{t('settings.platform')}</b>
            <span>{env.os} · {env.caseSensitive ? t('status.caseSensitive') : t('status.caseInsensitive')}</span>
            <b>{t('settings.separator')}</b><span>{env.separator}</span>
            <b>{t('settings.componentLimit')}</b><span>{t('settings.componentLimitUnit', { count: env.componentLimit })}</span>
            <b>{t('settings.pathWarn')}</b><span>{t('settings.pathWarnUnit', { count: env.pathWarnThreshold })}</span>
            <b>{t('settings.longPath')}</b><span>{env.longPathSupport ? t('settings.longPathEnabled') : t('settings.longPathDisabled')}</span>
            <b>{t('settings.dataDir')}</b><span style={{ fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>{env.dataDir}</span>
          </div>
          {isDemo && <div className="drawer-note" style={{ marginTop: 10 }}>{t('settings.demoEnv')}</div>}
        </section>
      </div>
    </>
  );
}

function AboutPanel() {
  const { t } = useTranslation();
  return (
    <>
      <DrawerHead
        title={t('about.title', { product: PRODUCT_NAME })}
        sub={t('about.sub', { product: PRODUCT_NAME, version: __APP_VERSION__ })}
      />
      <div className="drawer-body">
        <div className="about-brand">
          <span className="tb-mark" style={{ width: 38, height: 38, borderRadius: 10 }}>
            <Icon name="mark" size={20} />
          </span>
          <div>
            <h3>{PRODUCT_NAME}</h3>
            <p>{t('about.tagline')}</p>
          </div>
        </div>
        <section className="settings-section">
          <h4>{t('about.scope')}</h4>
          <ul className="scope-list">
            {[1, 2, 3, 4, 5, 6].map((n) => <li key={n}>{t(`about.scope${n}`)}</li>)}
          </ul>
        </section>
        <section className="settings-section">
          <h4>{t('about.notImplemented')}</h4>
          <ul className="scope-list muted">
            {[1, 2, 3].map((n) => <li key={n}>{t(`about.not${n}`)}</li>)}
          </ul>
        </section>
        <div className="drawer-note">{t('about.note')}</div>
        <div className="drawer-note">{t('about.internalName', { name: 'ffrn-core' })}</div>
      </div>
    </>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div>
        <div className="settings-label">{label}</div>
        {hint && <div className="settings-hint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Switch({ on, onChange, testId }: { on: boolean; onChange: (v: boolean) => void; testId?: string }) {
  return (
    <span
      className={`switch ${on ? 'on' : ''}`}
      role="switch"
      aria-checked={on}
      data-testid={testId}
      onClick={() => onChange(!on)}
      style={{ flex: '0 0 auto' }}
    />
  );
}
