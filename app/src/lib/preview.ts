import { t } from '../i18n';
import { applyRules } from './rules';
import type { EntryFacts, EnvInfo, Entry, MetaFields, PreviewRow, Rule } from './types';
import { normalizePath, pathLengthCheck, sanitizeInvalid, targetPath, validateName } from './validate';
import { splitName, joinName } from './rules';
import { dirNameOf, scanTemplate, varFieldsOf, type VarContext } from './vars';

export interface PreviewOptions {
  env: EnvInfo;
  strictWindowsNames: boolean;
  readonlySkip: boolean;
  diskExists: Record<string, boolean>;
  /** 文件路径 → 只读元数据字段（「按元数据取名」规则使用） */
  meta?: Record<string, MetaFields>;
  /** 文件路径 → 已计算的内容哈希（元变量 <CRC32>/<MD5>/<SHA1> 使用） */
  facts?: Record<string, EntryFacts>;
  /** USER1–USER9 */
  userVars?: string[];
  /** 是否自动替换 Windows 非法字符 */
  replaceInvalid?: boolean;
  invalidReplacement?: string;
  /** 名称长度上限（0 或未填 = 平台上限），只会收紧 */
  nameMaxLength?: number;
  /** 超长处理：block 阻止（默认）/ truncate 截断主体并保留扩展名 */
  longNameAction?: 'block' | 'truncate';
  /** 空名处理：block 阻止（默认）/ fallback 使用备用名 */
  emptyNameAction?: 'block' | 'fallback';
  emptyNameFallback?: string;
  /** 是否跳过带系统/隐藏属性的文件 */
  skipSystemHidden?: boolean;
}

export interface PreviewResult {
  rows: PreviewRow[];
  counts: {
    total: number;
    selected: number;
    ready: number;
    conflict: number;
    warn: number;
    invalid: number;
    unchanged: number;
    off: number;
  };
}

export interface Diff {
  prefix: string;
  added: string;
  removed: string;
  suffix: string;
}

export function diffNames(before: string, after: string): Diff {
  if (before === after) return { prefix: before, added: '', removed: '', suffix: '' };
  const a = Array.from(before);
  const b = Array.from(after);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s += 1;
  return {
    prefix: a.slice(0, p).join(''),
    added: b.slice(p, b.length - s).join(''),
    removed: a.slice(p, a.length - s).join(''),
    suffix: a.slice(a.length - s).join(''),
  };
}

export function computePreview(entries: Entry[], rules: Rule[], opts: PreviewOptions): PreviewResult {
  const counters = new Map<string, number>();
  const nextNumber = (rule: { id: string; start: number; step: number }, parent: string): number => {
    const key = `${rule.id}::${parent}`;
    const value = counters.get(key) ?? rule.start;
    counters.set(key, value + rule.step);
    return value;
  };
  const peekNumber = (rule: { id: string; start: number }, parent: string): number => {
    const key = `${rule.id}::${parent}`;
    return counters.get(key) ?? rule.start;
  };
  const userVars = opts.userVars ?? [];

  const rows: PreviewRow[] = [];
  for (const entry of entries) {
    const original = splitName(entry.name, entry.isDir);
    const facts = opts.facts?.[entry.path];
    const vars: VarContext = {
      stem: original.stem,
      ext: original.ext,
      dirName: dirNameOf(entry.parent),
      modified: entry.modified,
      size: entry.size,
      hashes: facts ?? {},
      users: userVars,
    };
    const pendingHash = entry.selected && rules.some((rule) => {
      // 扩展名规则对目录无效；未勾选的行不参与执行，也不需要哈希
      if (!rule.enabled || (entry.isDir && rule.type === 'ext')) return false;
      return varFieldsOf(rule).some((field) => scanTemplate(field).hashes.some((algo) => !facts?.[algo]));
    });
    const applied = applyRules(
      original,
      entry.isDir,
      rules,
      entry.parent,
      { nextNumber, peekNumber, meta: opts.meta?.[entry.path], vars },
      entry.selected,
    );
    let stem = applied.stem;
    let replacedInvalid = false;
    if (opts.replaceInvalid) {
      const sanitized = sanitizeInvalid(stem, opts.invalidReplacement ?? '_');
      replacedInvalid = sanitized !== stem;
      stem = sanitized;
    }
    // 空名策略：主体与扩展名都为空才算空名；fallback 只替换主体
    let usedFallback = false;
    if (!stem && !applied.ext) {
      const fallback = opts.emptyNameAction === 'fallback' ? (opts.emptyNameFallback ?? '').trim() : '';
      if (fallback) {
        stem = fallback;
        usedFallback = true;
      }
    }
    // 超长策略：只收紧平台上限；truncate 保留扩展名，优先截断主体
    const limit = (opts.nameMaxLength ?? 0) > 0
      ? Math.min(opts.nameMaxLength as number, opts.env.componentLimit)
      : opts.env.componentLimit;
    let truncated = false;
    if (opts.longNameAction === 'truncate' && limit > 0) {
      const extPart = applied.ext ? `.${applied.ext}` : '';
      const budget = limit - Array.from(extPart).length;
      const chars = Array.from(stem);
      if (budget > 0 && chars.length > budget) {
        stem = chars.slice(0, budget).join('');
        truncated = true;
      }
    }
    const newName = joinName(stem, applied.ext);
    const check = validateName(newName, opts.env, opts.strictWindowsNames, limit);
    const pathCheck = pathLengthCheck(entry.parent, newName, opts.env);
    const block = [...check.block, ...pathCheck.block];
    const warn = [...check.warn, ...pathCheck.warn];
    if (entry.readonly) warn.push(t('v.readonly'));
    if (opts.readonlySkip && entry.readonly) warn.push(t('v.readonlySkip'));
    if (replacedInvalid) warn.push(t('v.replaced', { char: opts.invalidReplacement || '_' }));
    if (usedFallback) warn.push(t('v.emptyFallback', { name: stem }));
    if (truncated) warn.push(t('v.truncated', { limit }));

    let status: PreviewRow['status'];
    const reasons: string[] = [];
    if (!entry.selected) {
      status = 'off';
    } else if (block.length) {
      status = 'invalid';
      reasons.push(...block);
    } else if (newName === entry.name) {
      status = 'unchanged';
      reasons.push(t('v.unchanged'));
    } else if (warn.length) {
      status = 'warn';
      reasons.push(...warn);
    } else {
      status = 'ready';
    }
    if (entry.selected && block.length) reasons.push(...block);
    if (entry.selected && warn.length && !block.length && newName !== entry.name) reasons.push(...warn);

    if (entry.selected && opts.skipSystemHidden && (entry.hidden || entry.system)) {
      status = 'off';
      reasons.length = 0;
      reasons.push(t('v.hiddenSkipped'));
    } else if (entry.selected && pendingHash) {
      status = 'invalid';
      reasons.length = 0;
      reasons.push(facts?.error ? t('v.varFailed', { message: facts.error }) : t('v.varPending'));
    }

    rows.push({
      entry,
      stem,
      ext: applied.ext,
      newName,
      status,
      reasons,
      pathTooLong: pathCheck.block.length > 0 || pathCheck.warn.length > 0,
      diff: diffNames(entry.name, newName),
    });
  }

  // 批次内重名（先勾选、已变更、合法者优先占位）
  const claimed = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.entry.selected && row.newName !== row.entry.name && row.status !== 'invalid' && row.status !== 'off') {
      const key = `${normalizePath(row.entry.parent, opts.env)}|${normalizePath(row.newName, opts.env)}`;
      const previous = claimed.get(key);
      if (previous !== undefined) {
        row.status = 'conflict';
        row.reasons = [t('v.duplicate', { row: previous + 1 })];
      } else {
        claimed.set(key, index);
      }
    }
  });

  // 目标位置已存在（磁盘）；同批次的源文件会被两段式移走，不算冲突
  const movingSources = new Set(
    rows
      .filter((r) => r.entry.selected && r.newName !== r.entry.name)
      .map((r) => normalizePath(r.entry.path, opts.env)),
  );

  for (const row of rows) {
    if (row.entry.selected && row.newName !== row.entry.name && row.status !== 'invalid' && row.status !== 'off') {
      const target = targetPath(row.entry.parent, row.newName, opts.env);
      const targetKey = normalizePath(target, opts.env);
      const sourceKey = normalizePath(row.entry.path, opts.env);
      if (opts.diskExists[targetKey] && targetKey !== sourceKey && !movingSources.has(targetKey)) {
        row.status = 'conflict';
        row.reasons = [t('v.exists')];
      }
    }
  }

  const counts = {
    total: rows.length,
    selected: rows.filter((r) => r.entry.selected).length,
    ready: rows.filter((r) => r.status === 'ready').length,
    conflict: rows.filter((r) => r.status === 'conflict').length,
    warn: rows.filter((r) => r.status === 'warn').length,
    invalid: rows.filter((r) => r.status === 'invalid').length,
    unchanged: rows.filter((r) => r.status === 'unchanged').length,
    off: rows.filter((r) => r.status === 'off').length,
  };
  return { rows, counts };
}

export function statusLabel(status: PreviewRow['status']): string {
  return {
    ready: t('preview.exportStatusReady'),
    unchanged: t('preview.exportStatusUnchanged'),
    conflict: t('preview.exportStatusConflict'),
    warn: t('preview.exportStatusWarn'),
    invalid: t('preview.exportStatusInvalid'),
    off: t('preview.exportStatusOff'),
  }[status];
}
