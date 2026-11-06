/** 方案（规则链）导入导出：带 schema / version / checksum，导入前完整校验。 */
import { t } from '../i18n';
import { createRuleDefaults, RULE_TYPES } from './ruleDefaults';
import type { PlanFile, Rule, RuleType } from './types';

export const PLAN_SCHEMA = 'rename-studio.plan';
export const PLAN_VERSION = 1;
export const PLAN_APP_VERSION = __APP_VERSION__;

/** 文件对话框过滤器（显示名随界面语言变化）。 */
export function planFilter(): Array<{ name: string; extensions: string[] }> {
  return [{ name: t('plan.filterName'), extensions: ['json'] }];
}

/** 稳定序列化：对象键排序，保证相同内容得到相同校验值。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a:${hash.toString(16).padStart(8, '0')}`;
}

function checksumOf(name: string, rules: Rule[]): string {
  return fnv1a(canonical({ schema: PLAN_SCHEMA, version: PLAN_VERSION, name, rules }));
}

function cloneRules(rules: Rule[]): Rule[] {
  return JSON.parse(JSON.stringify(rules)) as Rule[];
}

export function buildPlan(name: string, rules: Rule[]): PlanFile {
  const cleanName = name.trim() || t('plan.unnamed');
  const cloned = cloneRules(rules);
  return {
    schema: PLAN_SCHEMA,
    version: PLAN_VERSION,
    name: cleanName,
    createdAt: Math.floor(Date.now() / 1000),
    appVersion: PLAN_APP_VERSION,
    rules: cloned,
    checksum: checksumOf(cleanName, cloned),
  };
}

export function serializePlan(name: string, rules: Rule[]): string {
  return `${JSON.stringify(buildPlan(name, rules), null, 2)}\n`;
}

export interface PlanValidation {
  ok: boolean;
  error?: string;
  warnings: string[];
  name: string;
  rules: Rule[];
  version?: number;
  checksumOk: boolean;
}

let importSeq = 0;

function sanitizeRule(raw: unknown): Rule | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;
  const type = src.type;
  if (typeof type !== 'string' || !RULE_TYPES.includes(type as RuleType)) return null;
  const defaults = createRuleDefaults(type as RuleType, `import-${importSeq++}`) as unknown as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (key === 'id' || key === 'type') continue;
    if (!(key in src)) continue;
    const fallback = defaults[key];
    const value = src[key];
    if (typeof fallback === typeof value) merged[key] = value;
  }
  if (typeof src.enabled === 'boolean') merged.enabled = src.enabled;
  if (typeof src.id === 'string' && src.id.trim()) merged.id = src.id.trim();
  return merged as unknown as Rule;
}

export function parsePlan(text: string, fileName?: string): PlanValidation {
  const base: PlanValidation = {
    ok: false,
    warnings: [],
    name: '',
    rules: [],
    checksumOk: false,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ...base, error: t('plan.errBadJson', { message: err instanceof Error ? err.message : String(err) }) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...base, error: t('plan.errRoot') };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schema !== PLAN_SCHEMA) {
    return {
      ...base,
      error: t('plan.errSchema', { schema: String(obj.schema ?? '—') }),
    };
  }
  const version = obj.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ...base, error: t('plan.errVersionMissing') };
  }
  if (version > PLAN_VERSION) {
    return {
      ...base,
      error: t('plan.errVersionTooNew', { version, current: PLAN_VERSION }),
      version,
    };
  }
  if (version !== PLAN_VERSION) {
    return { ...base, error: t('plan.errVersionUnsupported', { version, current: PLAN_VERSION }), version };
  }
  if (!Array.isArray(obj.rules)) {
    return { ...base, error: t('plan.errRulesMissing'), version };
  }

  const warnings: string[] = [];
  const seen = new Set<string>();
  const rules: Rule[] = [];
  let dropped = 0;
  for (const raw of obj.rules) {
    const rule = sanitizeRule(raw);
    if (!rule) {
      dropped += 1;
      continue;
    }
    let id = rule.id;
    while (seen.has(id)) {
      importSeq += 1;
      id = `import-${importSeq}`;
    }
    seen.add(id);
    rules.push({ ...rule, id });
  }
  if (dropped) warnings.push(t('plan.warnDropped', { count: dropped }));
  if (!rules.length) warnings.push(t('plan.warnNoRules'));

  const name =
    (typeof obj.name === 'string' && obj.name.trim()) ||
    (fileName ? fileName.replace(/\.json$/i, '') : '') ||
    t('plan.importedName');

  let checksumOk = false;
  if (typeof obj.checksum === 'string' && obj.checksum) {
    checksumOk = obj.checksum === checksumOf(name, rules);
    if (!checksumOk) warnings.push(t('plan.warnChecksumMismatch'));
  } else {
    warnings.push(t('plan.warnNoChecksum'));
  }

  return { ok: true, warnings, name, rules, version, checksumOk };
}

export function planSummary(validation: PlanValidation): string {
  return t('plan.summaryLine', {
    count: validation.rules.length,
    version: validation.version ?? PLAN_VERSION,
    checksum: validation.checksumOk ? t('plan.checksumOk') : t('plan.checksumBad'),
  });
}
