import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from '../i18n';
import { useApp } from '../store';
import type {
  AddRule, CaseRule, DeleteRule, ExtRule, MetaRule, MoveRule, NumberRule, ReplaceRule, Rule,
} from '../lib/types';
import { ruleError } from '../lib/rules';
import { SAMPLE_VARS, expandTemplate } from '../lib/vars';

type Patch = (patch: Record<string, unknown>) => void;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <span className="switch-row" style={{ cursor: 'pointer' }} onClick={() => onChange(!on)}>
      <span className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} />
      <span className="lbl">{label}</span>
    </span>
  );
}

function Seg<T extends string>({
  value, options, onChange,
}: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <span className="seg-ctrl">
      {options.map(([key, label]) => (
        <span key={key} className={value === key ? 'on' : ''} onClick={() => onChange(key)}>{label}</span>
      ))}
    </span>
  );
}

const EMPTY_HISTORY: string[] = [];

const VAR_TOKENS = ['<FILENAME>', '<NAME>', '<EXT>', '<DOTEXT>', '<SUBSTR>', '<DIFNSUBSTR>', '<DIR>', '<DATE>', '<TIME>', '<SIZE>', '<CRC32>', '<MD5>', '<SHA1>', '<USER1>'];

/**
 * 规则链输入框：historyKey 不为空时，失焦后把填过的内容按字段记入历史，
 * 并在输入框下方提供历史列表（方向键/回车可选、单条删除、清空二次确认）。
 */
function TextInput({
  value, onChange, mono, placeholder, small, historyKey, testId, vars, counterVar,
}: {
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
  placeholder?: string;
  small?: boolean;
  historyKey?: string;
  testId?: string;
  /** 是否显示元变量插入面板 */
  vars?: boolean;
  /** 面板里是否提供 <#>（仅编号规则表达式） */
  counterVar?: boolean;
}) {
  const { t } = useTranslation();
  const history = useApp((s) => (historyKey ? s.ruleHistory.fields[historyKey] ?? EMPTY_HISTORY : EMPTY_HISTORY));
  const remember = useApp((s) => s.rememberRuleInput);
  const removeEntry = useApp((s) => s.deleteRuleHistoryEntry);
  const clearField = useApp((s) => s.clearRuleHistory);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [confirming, setConfirming] = useState(false);
  const [varsOpen, setVarsOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dirty = useRef(false);

  const rememberCurrent = () => {
    if (!historyKey || !dirty.current) return;
    dirty.current = false;
    remember(historyKey, value);
  };

  const pick = (item: string) => {
    onChange(item);
    if (historyKey) remember(historyKey, item);
    dirty.current = false;
    setOpen(false);
    setActive(-1);
    inputRef.current?.focus();
  };

  /** 在光标处插入变量占位符，并把光标移到插入内容之后 */
  const insertVar = (token: string) => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    dirty.current = true;
    onChange(next);
    setVarsOpen(false);
    requestAnimationFrame(() => {
      input?.focus();
      const at = start + token.length;
      input?.setSelectionRange(at, at);
    });
  };

  return (
    <div className="input-hist" ref={wrapRef}>
      <input
        ref={inputRef}
        data-testid={testId}
        className={`input ${mono ? 'mono' : ''} ${small ? 'small' : ''} ${vars ? 'has-vars' : ''}`}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          dirty.current = true;
          onChange(e.target.value);
        }}
        onBlur={(e) => {
          rememberCurrent();
          const next = e.relatedTarget as Node | null;
          if (!wrapRef.current?.contains(next)) {
            setOpen(false);
            setActive(-1);
            setConfirming(false);
          }
        }}
        onKeyDown={(e) => {
          if (!historyKey) return;
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
            setActive(-1);
            setConfirming(false);
            return;
          }
          if (e.key === 'ArrowDown' && history.length > 0) {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(history.length - 1, i + 1));
            return;
          }
          if (e.key === 'ArrowUp' && history.length > 0) {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.max(0, i - 1));
            return;
          }
          if (e.key === 'Enter' && open && active >= 0 && history[active]) {
            e.preventDefault();
            pick(history[active]);
          }
        }}
      />
      {vars && (
        <button
          type="button"
          className={`hist-toggle var-toggle ${historyKey ? 'with-hist' : ''}`}
          data-testid="var-toggle"
          title={t('vars.open')}
          aria-label={t('vars.open')}
          aria-expanded={varsOpen}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setVarsOpen((o) => !o)}
        >
          {'<>'}
        </button>
      )}
      {vars && varsOpen && (
        <div className="hist-panel var-panel" data-testid="var-panel">
          <div className="hist-head">
            <span>{t('vars.title')}</span>
            <span className="var-hint">{t('vars.hint')}</span>
          </div>
          <div className="var-grid">
            {[...VAR_TOKENS, ...(counterVar ? ['<#>'] : [])].map((token) => (
              <button
                key={token}
                type="button"
                className="var-chip"
                data-testid={`var-${token.slice(1, -1)}`}
                title={t(`vars.desc.${token === '<#>' ? 'counter' : token.slice(1, -1).toLowerCase()}`)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insertVar(token)}
              >
                {token}
              </button>
            ))}
          </div>
          <div className="var-example">
            <span>{t('vars.example')}</span>
            <code>{expandTemplate(value || '<NAME>_<#><DOTEXT>', { ...SAMPLE_VARS, counter: '1' })}</code>
          </div>
        </div>
      )}
      {historyKey && history.length > 0 && (
        <button
          type="button"
          className="hist-toggle"
          data-testid="hist-toggle"
          title={t('hist.open')}
          aria-label={t('hist.open')}
          aria-expanded={open}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setOpen((o) => !o);
            setActive(-1);
            setConfirming(false);
          }}
        >
          ▾
        </button>
      )}
      {open && historyKey && (
        <div className="hist-panel" role="listbox" data-testid="hist-panel" aria-label={t('hist.title')}>
          <div className="hist-head">
            <span>{t('hist.title')} · {history.length}</span>
            {confirming ? (
              <span className="hist-confirm">
                <button
                  type="button"
                  data-testid="hist-clear-confirm"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (historyKey) clearField(historyKey);
                    setConfirming(false);
                    setOpen(false);
                  }}
                >
                  {t('hist.confirmClear')}
                </button>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setConfirming(false)}>
                  {t('hist.cancel')}
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="hist-clear"
                data-testid="hist-clear"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setConfirming(true)}
              >
                {t('hist.clear')}
              </button>
            )}
          </div>
          {history.map((item, index) => (
            <div
              key={item}
              role="option"
              aria-selected={index === active}
              className={`hist-item ${index === active ? 'active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(item)}
            >
              <span className="hist-value" title={item}>{item}</span>
              <button
                type="button"
                className="hist-del"
                title={t('hist.remove')}
                aria-label={t('hist.remove')}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (historyKey) removeEntry(historyKey, item);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NumberInput({
  value, onChange, min = 0, max = 255, testId,
}: { value: number; onChange: (v: number) => void; min?: number; max?: number; testId?: string }) {
  return (
    <input
      className="input mono small"
      type="number"
      data-testid={testId}
      value={Number.isFinite(value) ? value : 0}
      min={min}
      max={max}
      onChange={(e) => {
        const next = Number(e.target.value);
        onChange(Number.isFinite(next) ? next : 0);
      }}
    />
  );
}

export function RuleEditor({ rule, patch }: { rule: Rule; patch: Patch }) {
  const error = ruleError(rule);

  return (
    <div className="rule-body">
      {rule.type === 'add' && <AddEditor rule={rule} patch={patch} />}
      {rule.type === 'replace' && <ReplaceEditor rule={rule} patch={patch} />}
      {rule.type === 'delete' && <DeleteEditor rule={rule} patch={patch} />}
      {rule.type === 'number' && <NumberEditor rule={rule} patch={patch} />}
      {rule.type === 'move' && <MoveEditor rule={rule} patch={patch} />}
      {rule.type === 'case' && <CaseEditor rule={rule} patch={patch} />}
      {rule.type === 'ext' && <ExtEditor rule={rule} patch={patch} />}
      {rule.type === 'meta' && <MetaEditor rule={rule} patch={patch} />}
      {error && <div className="rule-error">{error}</div>}
    </div>
  );
}

function AddEditor({ rule, patch }: { rule: AddRule; patch: Patch }) {
  const { t } = useTranslation();
  return (
    <>
      <Field label={t('f.mode')}>
        <Seg
          value={rule.mode}
          options={[['direct', t('o.direct')], ['pad', t('o.pad')]]}
          onChange={(mode) => patch({ mode })}
        />
      </Field>
      {rule.mode === 'direct' ? (
        <>
          <Field label={t('f.insertText')}>
            <TextInput value={rule.text} mono onChange={(text) => patch({ text })} placeholder={t('ph.insert')} historyKey="add.text" vars />
          </Field>
          <Field label={t('f.position')}>
            <div className="field-row">
              <Seg
                value={rule.anchor}
                options={[['start', t('o.start')], ['end', t('o.end')], ['at', t('o.at')]]}
                onChange={(anchor) => patch({ anchor })}
              />
            </div>
          </Field>
          {rule.anchor === 'at' && (
            <div className="field-row">
              <Field label={t('f.charIndex')}>
                <NumberInput value={rule.position} min={1} onChange={(position) => patch({ position })} />
              </Field>
              <div style={{ paddingTop: 16 }}>
                <Toggle on={rule.fromEnd} label={t('f.fromEnd')} onChange={(fromEnd) => patch({ fromEnd })} />
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="field-row">
          <Field label={t('f.padTo')}>
            <NumberInput value={rule.padTo} min={1} onChange={(padTo) => patch({ padTo })} />
          </Field>
          <Field label={t('f.padChar')}>
            <TextInput value={rule.padChar} mono small onChange={(padChar) => patch({ padChar: padChar.slice(0, 1) })} />
          </Field>
        </div>
      )}
    </>
  );
}

function ReplaceEditor({ rule, patch }: { rule: ReplaceRule; patch: Patch }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="field-row">
        <Field label={t('f.find')}>
          <TextInput value={rule.find} mono onChange={(find) => patch({ find })} placeholder={t('ph.find')} historyKey="replace.find" testId="replace-find" />
        </Field>
        <Field label={t('f.replaceWith')}>
          <TextInput value={rule.replace} mono onChange={(replace) => patch({ replace })} placeholder={t('ph.replace')} historyKey="replace.replace" testId="replace-with" vars />
        </Field>
      </div>
      <div className="field-row" style={{ marginBottom: 9, justifyContent: 'space-between' }}>
        <Toggle on={rule.caseSensitive} label={t('f.caseSensitive')} onChange={(caseSensitive) => patch({ caseSensitive })} />
        <Toggle on={rule.regex} label={t('f.regex')} onChange={(regex) => patch({ regex })} />
      </div>
      <Field label={t('f.replaceScope')}>
        <div className="field-row">
          <Seg
            value={rule.nth === 0 ? 'all' : 'nth'}
            options={[['all', t('f.all')], ['nth', t('f.onlyNth')]]}
            onChange={(mode) => patch({ nth: mode === 'all' ? 0 : 1 })}
          />
          {rule.nth > 0 && (
            <NumberInput value={rule.nth} min={1} onChange={(nth) => patch({ nth })} />
          )}
        </div>
      </Field>
    </>
  );
}

function DeleteEditor({ rule, patch }: { rule: DeleteRule; patch: Patch }) {
  const { t } = useTranslation();
  return (
    <>
      <Field label={t('f.mode')}>
        <Seg
          value={rule.mode}
          options={[['range', t('o.range')], ['between', t('o.between')], ['charset', t('o.charset')], ['trim', t('o.trim')]]}
          onChange={(mode) => patch({ mode })}
        />
      </Field>
      {rule.mode === 'range' && (
        <div className="field-row">
          <Field label={t('f.startPos')}>
            <NumberInput value={rule.from} min={1} onChange={(from) => patch({ from })} />
          </Field>
          <Field label={t('f.deleteCount')}>
            <NumberInput value={rule.count} min={1} onChange={(count) => patch({ count })} />
          </Field>
          <div style={{ paddingTop: 16 }}>
            <Toggle on={rule.fromEnd} label={t('f.fromEnd')} onChange={(fromEnd) => patch({ fromEnd })} />
          </div>
        </div>
      )}
      {rule.mode === 'between' && (
        <>
          <div className="field-row">
            <Field label={t('f.startMarker')}>
              <TextInput value={rule.left} mono onChange={(left) => patch({ left })} placeholder={t('ph.left')} historyKey="delete.left" />
            </Field>
            <Field label={t('f.endMarker')}>
              <TextInput value={rule.right} mono onChange={(right) => patch({ right })} placeholder={t('ph.right')} historyKey="delete.right" />
            </Field>
          </div>
          <div className="field-row">
            <Toggle on={rule.includeLeft} label={t('f.includeStart')} onChange={(includeLeft) => patch({ includeLeft })} />
            <Toggle on={rule.includeRight} label={t('f.includeEnd')} onChange={(includeRight) => patch({ includeRight })} />
          </div>
        </>
      )}
      {rule.mode === 'charset' && (
        <>
          <Field label={t('f.charset')}>
            <TextInput value={rule.chars} mono onChange={(chars) => patch({ chars })} placeholder={t('ph.charset')} historyKey="delete.chars" />
          </Field>
          <Toggle on={rule.keep} label={t('f.keepOnly')} onChange={(keep) => patch({ keep })} />
        </>
      )}
      {rule.mode === 'trim' && (
        <div className="hint-line">{t('f.trimHint')}</div>
      )}
    </>
  );
}

function NumberEditor({ rule, patch }: { rule: NumberRule; patch: Patch }) {
  const { t } = useTranslation();
  return (
    <>
      <Field label={t('f.numberExpr')}>
        <TextInput value={rule.expression} mono onChange={(expression) => patch({ expression })} placeholder={t('ph.number')} historyKey="number.expression" testId="number-expression" vars counterVar />
      </Field>
      <div className="field-row" style={{ marginBottom: 9 }}>
        <Field label={t('f.start')}>
          <NumberInput value={rule.start} min={0} max={999999} testId="number-start" onChange={(start) => patch({ start })} />
        </Field>
        <Field label={t('f.step')}>
          <NumberInput value={rule.step} min={1} max={999} onChange={(step) => patch({ step })} />
        </Field>
        <Field label={t('f.digits')}>
          <NumberInput value={rule.digits} min={1} max={12} onChange={(digits) => patch({ digits })} />
        </Field>
        <Field label={t('f.padChar')}>
          <TextInput value={rule.padChar} mono small onChange={(padChar) => patch({ padChar: padChar.slice(0, 1) })} />
        </Field>
      </div>
      <div className="field-row">
        <Toggle on={rule.perFolder} label={t('f.perFolder')} onChange={(perFolder) => patch({ perFolder })} />
        <Toggle on={rule.onlyChecked} label={t('f.onlyChecked')} onChange={(onlyChecked) => patch({ onlyChecked })} />
      </div>
    </>
  );
}

function MoveEditor({ rule, patch }: { rule: MoveRule; patch: Patch }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="field-row" style={{ marginBottom: 9 }}>
        <Field label={t('f.moveFrom')}>
          <NumberInput value={rule.from} min={1} onChange={(from) => patch({ from })} />
        </Field>
        <Field label={t('f.moveCount')}>
          <NumberInput value={rule.count} min={1} onChange={(count) => patch({ count })} />
        </Field>
        <div style={{ paddingTop: 16 }}>
          <Toggle on={rule.fromEnd} label={t('f.fromEnd')} onChange={(fromEnd) => patch({ fromEnd })} />
        </div>
      </div>
      <div className="field-row">
        <Field label={t('f.moveTo')}>
          <NumberInput value={rule.to} min={1} onChange={(to) => patch({ to })} />
        </Field>
        <div style={{ paddingTop: 16 }}>
          <Toggle on={rule.toEnd} label={t('f.fromEnd')} onChange={(toEnd) => patch({ toEnd })} />
        </div>
      </div>
    </>
  );
}

function CaseEditor({ rule, patch }: { rule: CaseRule; patch: Patch }) {
  const { t } = useTranslation();
  return (
    <>
      <Field label={t('f.caseMode')}>
        <Seg
          value={rule.mode}
          options={[
            ['lower', t('o.lower')], ['upper', t('o.upper')], ['title', t('o.title')],
            ['sentence', t('o.sentence')], ['invert', t('o.invert')], ['random', t('o.random')],
          ]}
          onChange={(mode) => patch({ mode })}
        />
      </Field>
      {rule.mode === 'title' && (
        <Field label={t('f.separators')}>
          <TextInput value={rule.separators} mono onChange={(separators) => patch({ separators })} historyKey="case.separators" />
        </Field>
      )}
      {rule.mode === 'random' && (
        <div className="hint-line">{t('f.randomHint')}</div>
      )}
    </>
  );
}

function ExtEditor({ rule, patch }: { rule: ExtRule; patch: Patch }) {
  const { t } = useTranslation();
  return (
    <>
      <Field label={t('f.mode')}>
        <Seg
          value={rule.mode}
          options={[['case', t('o.case')], ['replace', t('o.replace')], ['add', t('o.add')], ['number', t('o.number')], ['remove', t('o.remove')]]}
          onChange={(mode) => patch({ mode })}
        />
      </Field>
      {rule.mode === 'case' && (
        <Seg
          value={rule.caseMode}
          options={[['lower', t('o.lower')], ['upper', t('o.upper')]]}
          onChange={(caseMode) => patch({ caseMode })}
        />
      )}
      {(rule.mode === 'replace' || rule.mode === 'add' || rule.mode === 'number') && (
        <Field label={rule.mode === 'number' ? t('f.extDigits') : t('f.extContent')}>
          <TextInput
            value={rule.value}
            mono
            onChange={(value) => patch({ value })}
            placeholder={rule.mode === 'number' ? '2' : t('ph.ext')}
            historyKey={rule.mode === 'number' ? 'ext.number' : `ext.${rule.mode}`}
            vars={rule.mode !== 'number'}
          />
        </Field>
      )}
      {rule.mode === 'add' && (
        <Field label={t('f.addPosition')}>
          <Seg
            value={rule.position}
            options={[['prefix', t('o.prefix')], ['suffix', t('o.suffix')]]}
            onChange={(position) => patch({ position })}
          />
        </Field>
      )}
      {rule.mode === 'remove' && <div className="hint-line">{t('f.removeHint')}</div>}
    </>
  );
}

function MetaEditor({ rule, patch }: { rule: MetaRule; patch: Patch }) {
  const { t } = useTranslation();
  return (
    <>
      <Field label={t('f.metaField')}>
        <Seg
          value={rule.field}
          options={[
            ['taken', t('o.metaTaken')],
            ['camera', t('o.metaCamera')],
            ['title', t('o.metaTitle')],
            ['artist', t('o.metaArtist')],
            ['album', t('o.metaAlbum')],
            ['track', t('o.metaTrack')],
          ]}
          onChange={(field) => patch({ field })}
        />
      </Field>
      <Field label={t('f.usage')}>
        <Seg
          value={rule.mode}
          options={[['prefix', t('o.prefix')], ['suffix', t('o.suffix')], ['replace', t('o.replaceName')]]}
          onChange={(mode) => patch({ mode })}
        />
      </Field>
      {rule.mode !== 'replace' && (
        <Field label={t('f.separator')}>
          <TextInput value={rule.separator} small onChange={(separator) => patch({ separator })} placeholder={t('ph.metaSep')} historyKey="meta.separator" />
        </Field>
      )}
      <div className="hint-line">{t('f.metaHint')}</div>
    </>
  );
}
