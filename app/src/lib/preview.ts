import { t } from '../i18n';
import { applyRules, numberGroupKey, ruleError, ruleTemplateError } from './rules';
import type { EntryFacts, EnvInfo, Entry, MetaFields, NumberRule, PreviewRow, Rule } from './types';
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
  /** 文件路径 → 文件头嗅探出的真实扩展名（扩展名规则「智能分析」使用；空串=识别不出） */
  sniff?: Record<string, string>;
  /** 文件路径 → 已计算的内容哈希（元变量 <CRC32>/<MD5>/<SHA1> 使用） */
  facts?: Record<string, EntryFacts>;
  /** USER1–USER9 */
  userVars?: string[];
  /** USER0 */
  user0?: string;
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
  /** 自定义显示名（路径 → 名称）：优先于规则结果，只影响取名不写磁盘 */
  nameOverrides?: Record<string, string>;
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

/** 排除列表的匹配器：每个模式只编译一次，避免按「条目 × 模式」重复建 RegExp */
function compilePattern(pattern: string): RegExp | null {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  try {
    return new RegExp(`^${escaped}$`, 'i');
  } catch {
    return null;
  }
}

/** 排除列表里的通配符（`*` 任意长度、`?` 单字符），大小写不敏感。 */
export function wildcardMatch(pattern: string, name: string): boolean {
  return compilePattern(pattern)?.test(name) ?? false;
}

function splitPatterns(text: string): string[] {
  return text.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
}

export interface NumberPlan {
  /** entry.id → 该条在此规则下的序号 */
  values: Map<string, number>;
  /** 命中排除列表、不参与编号的条目 */
  excluded: Set<string>;
}

/**
 * 预分配编号：编号只取决于「entries 顺序 + 分组 + 排除」，与逐条取名无关，
 * 所以可以单独跑一次轻量前缀扫描，再喂给逐条求值 —— 只算可见切片也不会错号。
 * - number 规则：按分组累计计数；byPath 时改用完整路径升序；排除命中的条目不占号；
 *   未勾选且 onlyChecked 的条目取值但不占号。
 * - ext(number) 规则：扩展名序号按列表顺序递增（目录不占号），等价于原来的 nextNumber。
 */
export function planNumbers(entries: Entry[], rules: Rule[], opts: PreviewOptions): Map<string, NumberPlan> {
  const plans = new Map<string, NumberPlan>();
  for (const rule of rules) {
    if (!rule.enabled || ruleError(rule)) continue;
    if (rule.type === 'ext' && rule.mode === 'number') {
      const values = new Map<string, number>();
      let seq = 1;
      for (const entry of entries) {
        if (entry.isDir) continue;
        values.set(entry.id, seq);
        seq += 1;
      }
      plans.set(rule.id, { values, excluded: new Set() });
      continue;
    }
    if (rule.type !== 'number') continue;
    const numberRule: NumberRule = rule;
    const tests = splitPatterns(numberRule.exclude)
      .map(compilePattern)
      .filter((re): re is RegExp => !!re);
    const order = numberRule.byPath
      ? [...entries].sort((a, b) => {
          const left = opts.env.caseSensitive ? a.path : a.path.toLowerCase();
          const right = opts.env.caseSensitive ? b.path : b.path.toLowerCase();
          return left < right ? -1 : left > right ? 1 : 0;
        })
      : entries;
    const counters = new Map<string, number>();
    const values = new Map<string, number>();
    const excluded = new Set<string>();
    for (const entry of order) {
      if (tests.length && tests.some((re) => re.test(entry.name))) {
        excluded.add(entry.id);
        continue;
      }
      const key = numberGroupKey(numberRule, entry.parent, opts.meta?.[entry.path]);
      const current = counters.get(key) ?? numberRule.start;
      values.set(entry.id, current);
      if (numberRule.onlyChecked && !entry.selected) continue;
      counters.set(key, current + numberRule.step);
    }
    plans.set(numberRule.id, { values, excluded });
  }
  return plans;
}

/** 变量/算式/条件无法求值时规则会被跳过；整列标红提示，避免误以为「没生效」 */
export function firstTemplateError(rules: Rule[]): string | null {
  return rules.reduce<string | null>((found, rule) => found ?? (rule.enabled ? ruleTemplateError(rule) : null), null);
}

/** 逐条结果：批次内重名、磁盘冲突等顺序相关的判定留给 finalizePreview */
export interface BuiltRow {
  id: string;
  row: PreviewRow;
  status: PreviewRow['status'];
  reasons: string[];
  /** 规范化后的父目录 / 新名 / 源路径 / 目标路径：收尾直接用，不必每轮全表重算 */
  normParent: string;
  normNewName: string;
  normSource: string;
  normTarget: string;
}

/** 按列表顺序取号的规则（byPath=false 的编号、扩展名序号）会让换序影响编号 */
export function previewDependsOnOrder(rules: Rule[]): boolean {
  return rules.some((rule) => rule.enabled
    && ((rule.type === 'number' && !(rule as NumberRule).byPath) || (rule.type === 'ext' && rule.mode === 'number')));
}

export interface NumberCursor {
  next: (rule: { id: string; start: number; step: number }, key: string) => number;
  peek: (rule: { id: string; start: number }, key: string) => number;
}

/** 顺序回退计数器：编号与扩展名序号都已由 planNumbers 预分配，这里只作兜底 */
export function createNumberCursor(): NumberCursor {
  const counters = new Map<string, number>();
  return {
    next: (rule, key) => {
      const counterKey = `${rule.id}::${key}`;
      const value = counters.get(counterKey) ?? rule.start;
      counters.set(counterKey, value + rule.step);
      return value;
    },
    peek: (rule, key) => {
      const counterKey = `${rule.id}::${key}`;
      return counters.get(counterKey) ?? rule.start;
    },
  };
}

/**
 * 单条求值。序号来自 plans（按整表前缀计数算好），所以只算可见切片也不会错号；
 * `cursor` 只在 plans 缺项时兜底，正常路径不会走到。
 */
export function buildRow(
  entry: Entry,
  rules: Rule[],
  opts: PreviewOptions,
  plans: Map<string, NumberPlan>,
  badTemplate: string | null,
  cursor: NumberCursor,
): BuiltRow {
  const userVars = opts.userVars ?? [];
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
    user0: opts.user0,
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
    {
      nextNumber: cursor.next,
      peekNumber: cursor.peek,
      numberFor: (rule) => plans.get(rule.id)?.values.get(entry.id),
      isNumberExcluded: (rule) => plans.get(rule.id)?.excluded.has(entry.id) ?? false,
      meta: opts.meta?.[entry.path],
      sniff: opts.sniff?.[entry.path],
      vars,
    },
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
  // 手动改过的名字优先：预览、导出、执行都用同一个值
  const override = opts.nameOverrides?.[entry.path];
  const newName = override ?? joinName(stem, applied.ext);
  const check = validateName(newName, opts.env, opts.strictWindowsNames, limit);
  const pathCheck = pathLengthCheck(entry.parent, newName, opts.env);
  const block = [...check.block, ...pathCheck.block];
  const warn = [...check.warn, ...pathCheck.warn];
  if (entry.readonly) warn.push(t('v.readonly'));
  if (opts.readonlySkip && entry.readonly) warn.push(t('v.readonlySkip'));
  if (replacedInvalid) warn.push(t('v.replaced', { char: opts.invalidReplacement || '_' }));
  if (usedFallback) warn.push(t('v.emptyFallback', { name: stem }));
  if (truncated) warn.push(t('v.truncated', { limit }));
  const excludedByRule = entry.selected
    && rules.some((rule) => rule.type === 'number' && (plans.get(rule.id)?.excluded.has(entry.id) ?? false));
  if (excludedByRule) warn.push(t('v.numberExcluded'));

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
    if (excludedByRule) reasons.push(t('v.numberExcluded'));
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
  } else if (entry.selected && badTemplate) {
    status = 'invalid';
    reasons.length = 0;
    reasons.push(badTemplate);
  }

  const uniqueReasons = Array.from(new Set(reasons));
  // 规范化只在这里做一次：收尾的重名 / 磁盘冲突直接取用，换序复用行时也不必重算
  const normParent = normalizePath(entry.parent, opts.env);
  const normNewName = normalizePath(newName, opts.env);
  const normSource = normalizePath(entry.path, opts.env);
  const normTarget = normalizePath(targetPath(entry.parent, newName, opts.env), opts.env);
  return {
    id: entry.id,
    row: {
      entry,
      stem,
      ext: applied.ext,
      newName,
      status,
      reasons: uniqueReasons,
      pathTooLong: pathCheck.block.length > 0 || pathCheck.warn.length > 0,
      diff: diffNames(entry.name, newName),
    },
    status,
    reasons: uniqueReasons,
    normParent,
    normNewName,
    normSource,
    normTarget,
  };
}

/** 上一次逐条结果 + 每条当时取到的号码，用于换序后只重算「号码变了」的行 */
export interface RowCache {
  built: BuiltRow[];
  numbers: Map<string, string>;
}

/** 每条在各编号计划下的取值拼成的键：键相同、Entry 对象相同，逐条结果必然相同 */
export function numbersFor(entries: Entry[], plans: Map<string, NumberPlan>): Map<string, string> {
  const keys = new Map<string, string>();
  for (const entry of entries) {
    let key = '';
    for (const plan of plans.values()) key += `${plan.values.get(entry.id) ?? '-'}|`;
    keys.set(entry.id, key);
  }
  return keys;
}

/**
 * 全量逐条求值。plans / badTemplate 由调用方传入时不再重算。
 */
export function buildPreviewRows(
  entries: Entry[],
  rules: Rule[],
  opts: PreviewOptions,
  plans: Map<string, NumberPlan> = planNumbers(entries, rules, opts),
  badTemplate: string | null = firstTemplateError(rules),
): BuiltRow[] {
  const cursor = createNumberCursor();
  return entries.map((entry) => buildRow(entry, rules, opts, plans, badTemplate, cursor));
}

export interface ReorderedRows {
  built: BuiltRow[];
  /** 本次每条的号码键，下一次换序继续用 */
  numbers: Map<string, string>;
}

/**
 * 换序后的增量求值：Entry 对象没变、号码键也没变的行直接复用上一次结果。
 * 逐条结果只依赖条目本身、规则和它自己的号码，所以复用与全量重算等价。
 */
export function reorderRows(
  entries: Entry[],
  rules: Rule[],
  opts: PreviewOptions,
  plans: Map<string, NumberPlan>,
  badTemplate: string | null,
  previous: RowCache,
): ReorderedRows {
  const numbers = numbersFor(entries, plans);
  const cursor = createNumberCursor();
  const prevById = new Map<string, BuiltRow>();
  for (const item of previous.built) prevById.set(item.id, item);
  const built = entries.map((entry) => {
    const old = prevById.get(entry.id);
    if (old && old.row.entry === entry && previous.numbers.get(entry.id) === numbers.get(entry.id)) return old;
    return buildRow(entry, rules, opts, plans, badTemplate, cursor);
  });
  return { built, numbers };
}

/** 顺序相关的收尾：批次内重名、目标已存在、计数。逐条结果可跨顺序复用，这里每次都基于副本重算 */
export function finalizePreview(built: BuiltRow[], opts: PreviewOptions): PreviewResult {
  const total = built.length;
  const rows: PreviewRow[] = new Array(total);
  /** 参与换名的行：已勾选且新名与原名不同 */
  const active = new Uint8Array(total);
  const movingSources = new Set<string>();

  // 第一遍：复制行对象、标记参与换名的行、收集本批次的源路径（同批次源文件先被移走，被占的目标不算冲突）
  for (let i = 0; i < total; i += 1) {
    const item = built[i];
    rows[i] = { ...item.row, status: item.status, reasons: [...item.reasons] };
    if (item.row.entry.selected && item.row.newName !== item.row.entry.name) {
      active[i] = 1;
      movingSources.add(item.normSource);
    }
  }

  // 第二遍：批次内重名（先到先占）、目标已存在、同时累计计数
  const claimed = new Map<string, number>();
  let selected = 0;
  let ready = 0;
  let conflict = 0;
  let warn = 0;
  let invalid = 0;
  let unchanged = 0;
  let off = 0;
  for (let i = 0; i < total; i += 1) {
    const row = rows[i];
    if (row.entry.selected) selected += 1;
    if (active[i] && row.status !== 'invalid' && row.status !== 'off') {
      const item = built[i];
      const key = `${item.normParent}|${item.normNewName}`;
      const previous = claimed.get(key);
      if (previous !== undefined) {
        row.status = 'conflict';
        row.reasons = [t('v.duplicate', { row: previous + 1 })];
      } else {
        claimed.set(key, i);
      }
      if (opts.diskExists[item.normTarget]
        && item.normTarget !== item.normSource
        && !movingSources.has(item.normTarget)) {
        row.status = 'conflict';
        row.reasons = [t('v.exists')];
      }
    }
    switch (row.status) {
      case 'ready': ready += 1; break;
      case 'conflict': conflict += 1; break;
      case 'warn': warn += 1; break;
      case 'invalid': invalid += 1; break;
      case 'unchanged': unchanged += 1; break;
      default: off += 1;
    }
  }

  return {
    rows,
    counts: { total, selected, ready, conflict, warn, invalid, unchanged, off },
  };
}

export function computePreview(entries: Entry[], rules: Rule[], opts: PreviewOptions): PreviewResult {
  return finalizePreview(buildPreviewRows(entries, rules, opts), opts);
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
