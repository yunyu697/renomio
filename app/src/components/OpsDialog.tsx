/** P1 第二梯队：时间修改 / 属性修改 / 归类移动。
 *
 * 三块面板都遵循同一套约束：先预览「原值 → 新值」，确认后才走批次日志写入，
 * 结果里逐条列出失败原因，并可在「操作记录」中撤销。
 */
import { useEffect, useMemo, useState } from 'react';
import { applyAttrs, applyMove, applyTime, pathsExist, readAttrs, readTimes } from '../lib/bridge';
import { formatTime } from '../lib/format';
import { buildMoveRows, defaultMoveRoot, type DateGranularity, type MoveRuleKind } from '../lib/moveRules';
import { randomMsOf } from '../lib/time';
import { useTranslation } from '../i18n';
import type { AttrInfo, AttrSpecDto, Entry, OpsOutcome, TimeField, TimeInfo, TimeSpecDto } from '../lib/types';
import { normalizePath } from '../lib/validate';
import { useApp } from '../store';
import { Icon } from './Icon';

const FIELD_KEY: Record<TimeField, string> = {
  mtime: 'lc.modified',
  atime: 'lc.atime',
  creation: 'lc.creation',
};

const UNIT_MS = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;
type ShiftUnit = keyof typeof UNIT_MS;

function selectedFiles(entries: Entry[]): Entry[] {
  return entries.filter((e) => e.selected && !e.isDir);
}

function ResultPanel({ outcome, onClose }: { outcome: OpsOutcome; onClose: () => void }) {
  const { t } = useTranslation();
  const undoUntil = useApp((s) => s.undoUntil);
  const [undoing, setUndoing] = useState(false);
  const undo = async () => {
    setUndoing(true);
    try {
      await undoUntil(outcome.batch.id);
    } finally {
      setUndoing(false);
    }
  };
  return (
    <div className="ops-result" data-testid="ops-result">
      <div className="ops-result-head">
        <Icon name={outcome.failed.length ? 'alert' : 'check'} size={15} />
        <b>{outcome.applied.length}</b> {t('ops.success')} · <b>{outcome.skipped.length}</b> {t('ops.skipped')} ·
        <b> {outcome.failed.length}</b> {t('ops.failed')}
        <span className="foot-note" style={{ marginLeft: 8 }}>
          {t('ops.batchNote', { batch: outcome.batch.id })}
        </span>
        <button
          className="mini"
          type="button"
          data-testid="ops-undo"
          disabled={undoing}
          style={{ marginLeft: 8 }}
          onClick={() => void undo()}
        >
          <Icon name="undo" size={12} />{undoing ? t('ops.undoing') : t('ops.undoThis')}
        </button>
      </div>
      {(outcome.failed.length > 0 || outcome.skipped.length > 0) && (
        <div className="ops-result-list" data-testid="ops-result-failed">
          {outcome.failed.map((f) => (
            <div className="ops-result-row bad" key={`f-${f.id}`}>
              <span className="n">{f.source}</span>
              <span className="reason">{f.reason}</span>
            </div>
          ))}
          {outcome.skipped.map((s) => (
            <div className="ops-result-row" key={`s-${s.id}`}>
              <span className="n">{s.source}</span>
              <span className="reason">{s.reason}</span>
            </div>
          ))}
        </div>
      )}
      <div className="ops-result-actions">
        <button className="btn btn-primary" type="button" onClick={onClose}>{t('common.close')}</button>
      </div>
    </div>
  );
}

function DialogHead({ title, subtitle }: { title: string; subtitle: string }) {
  const { t } = useTranslation();
  return (
    <div className="dialog-head">
      <h4>
        <Icon name="bolt" size={16} style={{ color: 'var(--accent)' }} />
        {title}
        <span className="readonly-chip"><Icon name="undo" size={11} />{t('ops.revocable')}</span>
      </h4>
      <p>{subtitle}</p>
    </div>
  );
}

export function TimeBody({ onClose, targets }: { onClose: () => void; targets: Entry[] }) {
  const { t } = useTranslation();
  const env = useApp((s) => s.env);
  const finishOps = useApp((s) => s.finishOps);
  const showToast = useApp((s) => s.showToast);

  const [info, setInfo] = useState<Record<string, TimeInfo>>({});
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'shift' | 'fixed' | 'random'>('shift');
  const [amount, setAmount] = useState('1');
  const [unit, setUnit] = useState<ShiftUnit>('day');
  const [fixed, setFixed] = useState('');
  const [randomFrom, setRandomFrom] = useState('');
  const [randomTo, setRandomTo] = useState('');
  const [writeExif, setWriteExif] = useState(false);
  const [fields, setFields] = useState<TimeField[]>(['mtime']);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OpsOutcome | null>(null);

  const load = async () => {
    if (!targets.length) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = await readTimes(targets.map((e) => e.path));
      const map: Record<string, TimeInfo> = {};
      for (const item of list) map[item.path] = item;
      setInfo(map);
    } catch (err) {
      showToast('error', t('ops.errReadTime', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets]);

  const deltaMs = mode === 'shift' ? (Number(amount) || 0) * UNIT_MS[unit] : 0;
  const fixedMs = mode === 'fixed' && fixed ? new Date(fixed).getTime() : 0;
  const randomMinMs = mode === 'random' && randomFrom ? new Date(randomFrom).getTime() : 0;
  const randomMaxMs = mode === 'random' && randomTo ? new Date(randomTo).getTime() : 0;
  const randomReady = mode !== 'random' || (randomMinMs > 0 && randomMaxMs > 0);
  const primary: TimeField = fields.includes('mtime') ? 'mtime' : fields[0] ?? 'mtime';

  const nextOf = (path: string, ms: number | null | undefined): number | null => {
    if (mode === 'fixed') return fixedMs || null;
    if (mode === 'random') {
      if (!randomReady) return null;
      return randomMsOf(path, randomMinMs, randomMaxMs, '');
    }
    if (ms === null || ms === undefined) return null;
    return ms + deltaMs;
  };

  const rows = targets.map((entry) => {
    const item = info[entry.path];
    const raw = item
      ? primary === 'mtime'
        ? item.mtimeMs
        : primary === 'atime'
          ? item.atimeMs
          : item.creationMs
      : null;
    const next = nextOf(entry.path, raw ?? null);
    const creationBlocked = fields.includes('creation') && !env.creationTimeWritable;
    const invalid = !item || item.error ? item?.error ?? t('ops.timeUnread') : creationBlocked ? t('ops.creationBlocked') : null;
    return { entry, raw: raw ?? null, next, invalid: invalid ?? null };
  });

  const actionable = rows.filter((r) => !r.invalid);

  const apply = async () => {
    if (!fields.length) {
      showToast('warn', t('ops.needField'));
      return;
    }
    if (mode === 'fixed' && !fixedMs) {
      showToast('warn', t('ops.needFixed'));
      return;
    }
    if (mode === 'random' && !randomReady) {
      showToast('warn', t('ops.needRandom'));
      return;
    }
    if (!actionable.length) {
      showToast('warn', t('ops.noRows'));
      return;
    }
    const spec: TimeSpecDto = {
      mode,
      shiftSeconds: Math.round(deltaMs / 1000),
      fixedMs,
      randomMinMs,
      randomMaxMs,
      randomSeed: '',
      writeExif,
      fields,
    };
    setBusy(true);
    try {
      const outcome = await applyTime(
        actionable.map((r) => ({ id: r.entry.id, path: r.entry.path, isDir: r.entry.isDir })),
        spec,
      );
      setResult(outcome);
      await finishOps(outcome, 'time');
      await load();
    } catch (err) {
      showToast('error', t('ops.errTime', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHead title={t('ops.timeTitle')} subtitle={t('ops.timeSub', { count: targets.length })} />
      <div className="dialog-body">
        {result ? (
          <ResultPanel outcome={result} onClose={onClose} />
        ) : (
          <>
            <div className="ops-form">
              <div className="seg-ctrl" role="group" aria-label={t('ops.timeTitle')}>
                <span
                  className={mode === 'shift' ? 'on' : ''}
                  data-testid="ops-time-mode-shift"
                  onClick={() => setMode('shift')}
                >
                  {t('ops.shift')}
                </span>
                <span
                  className={mode === 'fixed' ? 'on' : ''}
                  data-testid="ops-time-mode-fixed"
                  onClick={() => setMode('fixed')}
                >
                  {t('ops.fixed')}
                </span>
                <span
                  className={mode === 'random' ? 'on' : ''}
                  data-testid="ops-time-mode-random"
                  onClick={() => setMode('random')}
                >
                  {t('ops.random')}
                </span>
              </div>
              {mode === 'shift' ? (
                <div className="field-row">
                  <label className="field" style={{ flex: 1 }}>
                    <span>{t('ops.offset')}</span>
                    <input
                      className="input"
                      data-testid="ops-shift-value"
                      type="number"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  </label>
                  <label className="field" style={{ width: 110 }}>
                    <span>{t('ops.unit')}</span>
                    <select
                      className="input"
                      data-testid="ops-shift-unit"
                      value={unit}
                      onChange={(e) => setUnit(e.target.value as ShiftUnit)}
                    >
                      <option value="second">{t('ops.second')}</option>
                      <option value="minute">{t('ops.minute')}</option>
                      <option value="hour">{t('ops.hour')}</option>
                      <option value="day">{t('ops.day')}</option>
                    </select>
                  </label>
                </div>
              ) : mode === 'fixed' ? (
                <label className="field">
                  <span>{t('ops.fixedTime')}</span>
                  <input
                    className="input"
                    data-testid="ops-fixed-value"
                    type="datetime-local"
                    value={fixed}
                    onChange={(e) => setFixed(e.target.value)}
                  />
                </label>
              ) : (
                <div className="field-row">
                  <label className="field" style={{ flex: 1 }}>
                    <span>{t('ops.randomFrom')}</span>
                    <input
                      className="input"
                      data-testid="ops-random-from"
                      type="datetime-local"
                      value={randomFrom}
                      onChange={(e) => setRandomFrom(e.target.value)}
                    />
                  </label>
                  <label className="field" style={{ flex: 1 }}>
                    <span>{t('ops.randomTo')}</span>
                    <input
                      className="input"
                      data-testid="ops-random-to"
                      type="datetime-local"
                      value={randomTo}
                      onChange={(e) => setRandomTo(e.target.value)}
                    />
                  </label>
                </div>
              )}
              <label className="ops-check">
                <input
                  type="checkbox"
                  data-testid="ops-write-exif"
                  checked={writeExif}
                  onChange={(e) => setWriteExif(e.target.checked)}
                />
                {t('ops.exifWrite')}
              </label>
              <div className="ops-fields">
                <span className="policy-label">{t('ops.applyTo')}</span>
                {(['mtime', 'atime', 'creation'] as TimeField[]).map((field) => {
                  const disabled = field === 'creation' && !env.creationTimeWritable;
                  return (
                    <label className={`ops-check ${disabled ? 'off' : ''}`} key={field}>
                      <input
                        type="checkbox"
                        data-testid={`ops-field-${field}`}
                        disabled={disabled}
                        checked={fields.includes(field)}
                        onChange={(e) =>
                          setFields((cur) =>
                            e.target.checked ? [...cur, field] : cur.filter((f) => f !== field),
                          )
                        }
                      />
                      {t(FIELD_KEY[field])}
                      {disabled && <span className="ops-tag">{t('ops.windowsOnly')}</span>}
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="mini-table ops-table" data-testid="ops-preview">
              <div className="mini-row head">
                <span>{t('ops.file')}</span>
                <span>{t('ops.oldNew', { field: t(FIELD_KEY[primary]) })}</span>
                <span>{t('ops.status')}</span>
              </div>
              {loading && <div className="mini-empty">{t('meta.loading')}</div>}
              {!loading && !rows.length && <div className="mini-empty">{t('ops.selectFirst')}</div>}
              {!loading &&
                rows.map((row) => (
                  <div
                    className={`mini-row ${row.invalid ? 'bad' : ''}`}
                    key={row.entry.id}
                    data-testid="ops-row"
                    data-status={row.invalid ? 'invalid' : 'ready'}
                  >
                    <span className="n" title={row.entry.path}>{row.entry.name}</span>
                    <span className="n ops-change" data-testid="ops-change">
                      <span className="old">{row.raw === null ? '—' : formatTime(row.raw)}</span>
                      <span className="ops-arrow">→</span>
                      <span className="new">
                        {row.next === null ? '—' : formatTime(row.next)}
                      </span>
                    </span>
                    <span className="mini-status" title={row.invalid ?? ''}>
                      {row.invalid ?? t('ops.pending')}
                    </span>
                  </div>
                ))}
            </div>
            <div className="ops-note">
              <Icon name="info" size={12} />
              {t('ops.timeNote')}
            </div>
          </>
        )}
      </div>
      <div className="dialog-foot">
        <span className="foot-note">{t('ops.creationNote')}</span>
        <div className="right">
          <button className="btn btn-outline" type="button" onClick={onClose}>{t('common.cancel')}</button>
          <button
            className="btn btn-primary"
            type="button"
            data-testid="ops-apply"
            disabled={busy || !!result || !actionable.length}
            onClick={() => void apply()}
          >
            <Icon name="play" />{busy ? t('ops.writing') : t('ops.writeCount', { count: actionable.length })}
          </button>
        </div>
      </div>
    </>
  );
}

type AttrChoice = 'keep' | 'set' | 'clear' | 'invert';

export function AttrBody({ onClose, targets }: { onClose: () => void; targets: Entry[] }) {
  const { t } = useTranslation();
  const env = useApp((s) => s.env);
  const finishOps = useApp((s) => s.finishOps);
  const showToast = useApp((s) => s.showToast);

  const [info, setInfo] = useState<Record<string, AttrInfo>>({});
  const [loading, setLoading] = useState(true);
  const [readonly, setReadonly] = useState<AttrChoice>('keep');
  const [hidden, setHidden] = useState<AttrChoice>('keep');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OpsOutcome | null>(null);

  const load = async () => {
    if (!targets.length) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = await readAttrs(targets.map((e) => e.path));
      const map: Record<string, AttrInfo> = {};
      for (const item of list) map[item.path] = item;
      setInfo(map);
    } catch (err) {
      showToast('error', t('ops.errReadAttrs', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets]);

  const desired = (choice: AttrChoice, old: boolean) =>
    choice === 'keep' ? old : choice === 'invert' ? !old : choice === 'set';

  const rows = targets.map((entry) => {
    const item = info[entry.path];
    const oldR = item?.readonly ?? false;
    const oldH = item?.hidden ?? false;
    const newR = desired(readonly, oldR);
    const newH = desired(hidden, oldH);
    const invalid =
      item?.error ?? (hidden !== 'keep' && env.os !== 'windows' ? t('ops.hiddenBlocked') : null);
    return { entry, oldR, oldH, newR, newH, invalid: invalid ?? null };
  });
  const actionable = rows.filter((r) => !r.invalid && (r.oldR !== r.newR || r.oldH !== r.newH));

  const apply = async () => {
    if (readonly === 'keep' && hidden === 'keep') {
      showToast('warn', t('ops.needAttr'));
      return;
    }
    if (!actionable.length) {
      showToast('warn', t('ops.needChange'));
      return;
    }
    const spec: AttrSpecDto = {
      readonly: readonly === 'keep' ? null : readonly,
      hidden: hidden === 'keep' ? null : hidden,
    };
    setBusy(true);
    try {
      const outcome = await applyAttrs(
        actionable.map((r) => ({ id: r.entry.id, path: r.entry.path, isDir: r.entry.isDir })),
        spec,
      );
      setResult(outcome);
      await finishOps(outcome, 'attrs');
      await load();
    } catch (err) {
      showToast('error', t('ops.errAttrs', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const choices: Array<{ id: AttrChoice; label: string }> = [
    { id: 'keep', label: t('ops.keep') },
    { id: 'set', label: t('ops.set') },
    { id: 'clear', label: t('ops.clear') },
    { id: 'invert', label: t('ops.invert') },
  ];

  return (
    <>
      <DialogHead title={t('ops.attrsTitle')} subtitle={t('ops.attrsSub', { count: targets.length })} />
      <div className="dialog-body">
        {result ? (
          <ResultPanel outcome={result} onClose={onClose} />
        ) : (
          <>
            <div className="ops-form">
              <div className="field" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 62 }}>{t('ops.readonly')}</span>
                <div className="seg-ctrl" data-testid="ops-readonly-ctrl">
                  {choices.map((c) => (
                    <span
                      key={c.id}
                      className={readonly === c.id ? 'on' : ''}
                      data-testid={`ops-readonly-${c.id}`}
                      onClick={() => setReadonly(c.id)}
                    >
                      {c.label}
                    </span>
                  ))}
                </div>
              </div>
              <div className="field" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 62 }}>{t('ops.hidden')}</span>
                <div className="seg-ctrl" data-testid="ops-hidden-ctrl">
                  {choices.map((c) => (
                    <span
                      key={c.id}
                      className={hidden === c.id ? 'on' : ''}
                      data-testid={`ops-hidden-${c.id}`}
                      onClick={() => setHidden(c.id)}
                    >
                      {c.label}
                    </span>
                  ))}
                </div>
                {!env.os.startsWith('windows') && <span className="ops-tag">{t('ops.hiddenOnlyWin')}</span>}
              </div>
            </div>
            <div className="mini-table ops-table" data-testid="ops-preview">
              <div className="mini-row head">
                <span>{t('ops.file')}</span>
                <span>{t('ops.attrOldNew')}</span>
                <span>{t('ops.status')}</span>
              </div>
              {loading && <div className="mini-empty">{t('meta.loading')}</div>}
              {!loading && !rows.length && <div className="mini-empty">{t('ops.selectFirst')}</div>}
              {!loading &&
                rows.map((row) => (
                  <div
                    className={`mini-row ${row.invalid ? 'bad' : ''}`}
                    key={row.entry.id}
                    data-testid="ops-row"
                    data-status={row.invalid ? 'invalid' : 'ready'}
                  >
                    <span className="n" title={row.entry.path}>{row.entry.name}</span>
                    <span className="n ops-change">
                      <span className="old">{row.oldR ? t('ops.readonly') : t('ops.writable')} / {row.oldH ? t('ops.hidden') : t('ops.visible')}</span>
                      <span className="ops-arrow">→</span>
                      <span className="new">{row.newR ? t('ops.readonly') : t('ops.writable')} / {row.newH ? t('ops.hidden') : t('ops.visible')}</span>
                    </span>
                    <span className="mini-status">{row.invalid ?? (row.oldR !== row.newR || row.oldH !== row.newH ? t('ops.pending') : t('ops.unchanged'))}</span>
                  </div>
                ))}
            </div>
          </>
        )}
      </div>
      <div className="dialog-foot">
        <span className="foot-note">{t('ops.attrNote')}</span>
        <div className="right">
          <button className="btn btn-outline" type="button" onClick={onClose}>{t('common.cancel')}</button>
          <button
            className="btn btn-primary"
            type="button"
            data-testid="ops-apply"
            disabled={busy || !!result || !actionable.length}
            onClick={() => void apply()}
          >
            <Icon name="play" />{busy ? t('ops.writing') : t('ops.writeCount', { count: actionable.length })}
          </button>
        </div>
      </div>
    </>
  );
}

export function MoveBody({ onClose, targets }: { onClose: () => void; targets: Entry[] }) {
  const { t } = useTranslation();
  const env = useApp((s) => s.env);
  const finishOps = useApp((s) => s.finishOps);
  const showToast = useApp((s) => s.showToast);

  const [kind, setKind] = useState<MoveRuleKind>('ext');
  const [root, setRoot] = useState(() => defaultMoveRoot(targets, env));
  const [keepStructure, setKeep] = useState(false);
  const [granularity, setGranularity] = useState<DateGranularity>('month');
  const [pattern, setPattern] = useState('^(\\d{4})');
  const [capture, setCapture] = useState('1');
  const [template, setTemplate] = useState('<EXT>');
  const userVars = useApp((s) => s.settings.userVars);
  const [existing, setExisting] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OpsOutcome | null>(null);

  const cfg = {
    kind,
    root,
    keepStructure,
    dateGranularity: granularity,
    pattern,
    capture: Number(capture) || 0,
    template,
    users: userVars,
  };
  const rows = useMemo(
    () => buildMoveRows(targets, cfg, env, existing),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targets, kind, root, keepStructure, granularity, pattern, capture, template, userVars, existing, env],
  );

  const signature = rows.map((r) => r.target).filter(Boolean).join('\n');

  useEffect(() => {
    let alive = true;
    const paths = rows.filter((r) => r.status !== 'invalid' && r.target).map((r) => r.target);
    if (!paths.length) {
      setExisting({});
      return () => {
        alive = false;
      };
    }
    const timer = window.setTimeout(() => {
      void pathsExist(Array.from(new Set(paths)))
        .then((flags) => {
          if (!alive) return;
          const map: Record<string, boolean> = {};
          Array.from(new Set(paths)).forEach((p, i) => {
            if (flags[i]) map[normalizePath(p, env)] = true;
          });
          setExisting(map);
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const actionable = rows.filter((r) => r.status === 'ready' || r.status === 'conflict');

  const apply = async () => {
    if (!root.trim()) {
      showToast('warn', t('ops.needRoot'));
      return;
    }
    if (!actionable.length) {
      showToast('warn', t('ops.noMoveRows'));
      return;
    }
    setBusy(true);
    try {
      const outcome = await applyMove(
        actionable.map((r) => ({
          id: r.entry.id,
          source: r.entry.path,
          target: r.target,
          isDir: r.entry.isDir,
        })),
        { createDirs: true, roots: [root], forceCopy: false },
      );
      setResult(outcome);
      await finishOps(outcome, 'move');
    } catch (err) {
      showToast('error', t('ops.errMove', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const kinds: Array<{ id: MoveRuleKind; label: string }> = [
    { id: 'ext', label: t('ops.moveKindExt') },
    { id: 'date', label: t('ops.moveKindDate') },
    { id: 'initial', label: t('ops.moveKindInitial') },
    { id: 'regex', label: t('ops.moveKindRegex') },
    { id: 'template', label: t('ops.moveKindTemplate') },
  ];

  const granularities: Array<[DateGranularity, string]> = [
    ['year', t('ops.year')],
    ['month', t('ops.yearMonth')],
    ['day', t('ops.yearMonthDay')],
  ];

  return (
    <>
      <DialogHead title={t('ops.moveTitle')} subtitle={t('ops.moveSub', { count: targets.length })} />
      <div className="dialog-body">
        {result ? (
          <ResultPanel outcome={result} onClose={onClose} />
        ) : (
          <>
            <div className="ops-form">
              <div className="seg-ctrl" data-testid="ops-move-kind">
                {kinds.map((k) => (
                  <span
                    key={k.id}
                    className={kind === k.id ? 'on' : ''}
                    data-testid={`ops-move-kind-${k.id}`}
                    onClick={() => setKind(k.id)}
                  >
                    {k.label}
                  </span>
                ))}
              </div>
              {kind === 'date' && (
                <div className="mini-radio" style={{ marginBottom: 8 }}>
                  {granularities.map(([id, label]) => (
                    <span
                      key={id}
                      className={granularity === id ? 'on' : ''}
                      data-testid={`ops-move-granularity-${id}`}
                      onClick={() => setGranularity(id)}
                    >
                      <i />{label}
                    </span>
                  ))}
                </div>
              )}
              {kind === 'regex' && (
                <div className="field-row" style={{ marginBottom: 8 }}>
                  <label className="field" style={{ flex: 1 }}>
                    <span>{t('ops.regexLabel')}</span>
                    <input
                      className="input"
                      data-testid="ops-move-pattern"
                      value={pattern}
                      onChange={(e) => setPattern(e.target.value)}
                    />
                  </label>
                  <label className="field" style={{ width: 92 }}>
                    <span>{t('ops.capture')}</span>
                    <input
                      className="input"
                      data-testid="ops-move-capture"
                      type="number"
                      min={0}
                      value={capture}
                      onChange={(e) => setCapture(e.target.value)}
                    />
                  </label>
                </div>
              )}
              {kind === 'template' && (
                <label className="field">
                  <span>{t('ops.moveTemplate')}</span>
                  <input
                    className="input"
                    data-testid="ops-move-template"
                    value={template}
                    onChange={(e) => setTemplate(e.target.value)}
                    placeholder="<EXT>/<DATE:yyyy>"
                  />
                  <span className="drawer-note">{t('ops.moveTemplateHint')}</span>
                </label>
              )}
              <label className="field">
                <span>{t('ops.moveRoot')}</span>
                <input
                  className="input"
                  data-testid="ops-move-root"
                  value={root}
                  onChange={(e) => setRoot(e.target.value)}
                  placeholder={t('ops.moveRootPlaceholder')}
                />
              </label>
              <label className="ops-check">
                <input
                  type="checkbox"
                  data-testid="ops-move-keep"
                  checked={keepStructure}
                  onChange={(e) => setKeep(e.target.checked)}
                />
                {t('ops.keepStructure')}
              </label>
            </div>

            <div className="mini-table ops-table" data-testid="ops-preview">
              <div className="mini-row head">
                <span>{t('ops.oldLocation')}</span>
                <span>{t('ops.newLocation')}</span>
                <span>{t('ops.status')}</span>
              </div>
              {!rows.length && <div className="mini-empty">{t('ops.selectFirst')}</div>}
              {rows.map((row) => (
                <div
                  className={`mini-row ${row.status === 'invalid' || row.status === 'conflict' ? 'bad' : ''}`}
                  key={row.entry.id}
                  data-testid="ops-row"
                  data-status={row.status}
                >
                  <span className="n" title={row.entry.path}>{row.entry.path}</span>
                  <span className="n new" title={row.target} data-testid="ops-target">
                    {row.target || t('ops.cannotCompute')}
                  </span>
                  <span className="mini-status" title={row.reasons.join(' · ')}>
                    {row.status === 'ready' ? t('ops.movePending') : row.status === 'unchanged' ? t('ops.alreadyAtTarget') : row.reasons[0] ?? row.status}
                  </span>
                </div>
              ))}
            </div>
            <div className="ops-note">
              <Icon name="info" size={12} />
              {t('ops.moveNote')}
            </div>
          </>
        )}
      </div>
      <div className="dialog-foot">
        <span className="foot-note">{t('ops.moveFooter')}</span>
        <div className="right">
          <button className="btn btn-outline" type="button" onClick={onClose}>{t('common.cancel')}</button>
          <button
            className="btn btn-primary"
            type="button"
            data-testid="ops-apply"
            disabled={busy || !!result || !actionable.length}
            onClick={() => void apply()}
          >
            <Icon name="play" />{busy ? t('ops.moving') : t('ops.moveCount', { count: actionable.length })}
          </button>
        </div>
      </div>
    </>
  );
}

export function OpsDialog() {
  const mode = useApp((s) => s.opsMode);
  const close = useApp((s) => s.closeOps);
  const entries = useApp((s) => s.entries);
  if (!mode) return null;
  return (
    <div className="modal-mask" onClick={close}>
      <div className="dialog dialog-wide" data-testid="ops-dialog" onClick={(e) => e.stopPropagation()}>
        {mode === 'time' && <TimeBody onClose={close} targets={selectedFiles(entries)} />}
        {mode === 'attrs' && <AttrBody onClose={close} targets={selectedFiles(entries)} />}
        {mode === 'move' && <MoveBody onClose={close} targets={selectedFiles(entries)} />}
      </div>
    </div>
  );
}
