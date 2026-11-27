/** 规则引擎：纯函数，输入原名 + 规则链，输出新名。所有语义在 README 中固化说明。 */
import { t } from '../i18n';
import type {
  AddRule, CaseRule, DeleteRule, ExtRule, MapRule, MetaFieldKey, MetaFields, MoveRule, NumberRule, ReplaceRule, Rule,
} from './types';
import { META_FIELDS, metaFieldLabelKey } from './metaFields';
import { applyMapping, mapErrorKey, parseMapTable } from './mapTable';
import { expandTemplate, scanTemplate, type VarContext } from './vars';

export function splitName(name: string, isDir: boolean): { stem: string; ext: string } {
  if (isDir) return { stem: name, ext: '' };
  const idx = name.lastIndexOf('.');
  if (idx > 0 && idx < name.length - 1) return { stem: name.slice(0, idx), ext: name.slice(idx + 1) };
  if (idx > 0) return { stem: name.slice(0, idx), ext: '' };
  return { stem: name, ext: '' };
}

export function joinName(stem: string, ext: string): string {
  return ext ? `${stem}.${ext}` : stem;
}

const toChars = (s: string): string[] => Array.from(s);
const fromChars = (arr: string[]): string => arr.join('');

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function regexEscape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function separatorRegex(seps: string, flags = ''): RegExp {
  const chars = toChars(seps.length ? seps : ' -_.');
  return new RegExp(`[${chars.map(regexEscape).join('')}]`, flags);
}

/** 模板字段的变量校验：未知变量名、非法参数与非法算式/条件必须显式报错，不能原样输出。 */
function templateError(text: string, allowCounter: boolean): string | null {
  const scan = scanTemplate(text);
  if (scan.unknown) return t('ruleErr.unknownVar', { name: scan.unknown });
  if (scan.badArgs) return t('ruleErr.badVarArgs', { name: scan.badArgs });
  if (scan.counterBad) return t('ruleErr.badCounterExpr');
  if (scan.condBad) return t('ruleErr.badCondition', { cond: scan.condBad });
  if (scan.counter && !allowCounter) return t('ruleErr.counterOnlyNumber');
  return null;
}

/** 模板/算式/条件类的错误（与「字段没填完」区分：这类错误会让预览整体标红）。 */
export function ruleTemplateError(rule: Rule): string | null {
  switch (rule.type) {
    case 'add':
      return rule.mode === 'direct' ? templateError(rule.text, false) : null;
    case 'replace':
      return templateError(rule.replace, false);
    case 'number':
      return templateError(rule.expression, true);
    case 'ext':
      return rule.mode === 'number' ? null : templateError(rule.value, false);
    default:
      return null;
  }
}

/** 规则配置是否可用；返回本地化错误说明 */
export function ruleError(rule: Rule): string | null {
  switch (rule.type) {
    case 'add':
      if (rule.mode === 'direct' && rule.text === '') return t('ruleErr.emptyInsert');
      if (rule.mode === 'direct') {
        const bad = templateError(rule.text, false);
        if (bad) return bad;
      }
      if (rule.mode === 'pad' && (rule.padTo < 1 || rule.padTo > 255)) return t('ruleErr.padRange');
      if (rule.anchor === 'at' && (rule.position < 1 || rule.position > 255)) return t('ruleErr.positionRange');
      return null;
    case 'replace':
      if (rule.find === '') return t('ruleErr.emptyFind');
      {
        const bad = templateError(rule.replace, false);
        if (bad) return bad;
      }
      if (rule.regex) {
        try {
          new RegExp(rule.find);
        } catch {
          return t('ruleErr.badRegex');
        }
        const groups = groupCount(rule.find);
        const ref = maxBackslashRef(rule.replace);
        if (groups >= 0 && ref > groups) return t('ruleErr.refExceedsGroups', { ref, groups });
      }
      if (rule.nth < 0) return t('ruleErr.negativeNth');
      return null;
    case 'delete':
      if (rule.mode === 'range' && (rule.from < 1 || rule.count < 1)) return t('ruleErr.rangePositive');
      if (rule.mode === 'charset' && rule.chars === '') return t('ruleErr.emptyCharset');
      // 两个标记都空会命中「整串」，属于误配置：就地报错，不静默把名字删空
      if (rule.mode === 'between' && !rule.left && !rule.right) return t('ruleErr.delMarkerRequired');
      return null;
    case 'number':
      if (!rule.expression.includes('<#>')) return t('ruleErr.needPlaceholder');
      {
        const bad = templateError(rule.expression, true);
        if (bad) return bad;
      }
      if (rule.digits < 1 || rule.digits > 12) return t('ruleErr.digitsRange');
      if (rule.step < 1) return t('ruleErr.stepPositive');
      return null;
    case 'move':
      if (rule.by === 'markers') {
        if (!rule.left && !rule.right) return t('ruleErr.markerRequired');
        return null;
      }
      if (rule.from < 1 || rule.count < 1) return t('ruleErr.rangePositive');
      return null;
    case 'case':
      return null;
    case 'ext':
      if ((rule.mode === 'replace' || rule.mode === 'fixed') && rule.value.trim() === '') return t('ruleErr.emptyExt');
      if (rule.mode === 'number' && (rule.value === '' || Number.isNaN(Number(rule.value)))) return t('ruleErr.badExtStep');
      if (rule.mode === 'replace' || rule.mode === 'fixed' || rule.mode === 'add') {
        const bad = templateError(rule.value, false);
        if (bad) return bad;
      }
      return null;
    case 'meta':
      return null;
    case 'map': {
      const parsed = parseMapTable(rule.table, rule.caseSensitive);
      if (parsed.errors.length) {
        const first = parsed.errors[0];
        return t(mapErrorKey(first.code), { line: first.line, text: first.text });
      }
      if (parsed.entries.length === 0) return t('ruleErr.mapEmpty');
      return null;
    }
    default:
      return null;
  }
}

function applyAdd(stem: string, rule: AddRule, vars: VarContext): string {
  if (rule.mode === 'pad') {
    const chars = toChars(stem);
    const padChar = rule.padChar || '0';
    while (chars.length < rule.padTo) chars.push(padChar);
    return fromChars(chars);
  }
  const chars = toChars(stem);
  let index = 0;
  if (rule.anchor === 'end') index = chars.length;
  else if (rule.anchor === 'at') {
    index = rule.fromEnd ? chars.length - (rule.position - 1) : rule.position - 1;
  }
  index = clamp(index, 0, chars.length);
  chars.splice(index, 0, ...toChars(expandTemplate(rule.text, vars)));
  return fromChars(chars);
}

/**
 * 正则替换的分组引用同时接受两种写法：
 * - JS 方言 `$1` / `$&`（原生）
 * - Delphi 方言 `\1` / `\0`（对标商业批量改名软件的习惯），`\\1` / `\\0` 表示字面反斜杠加数字
 * 因此这里只把「没被转义」的 `\0` 换成 `$&`（整段匹配）、`\1`..`\9` 换成 `$1`..`$9`，
 * 其余反斜杠一律原样保留。
 */
export function convertBackslashRefs(replacement: string): string {
  let out = '';
  for (let i = 0; i < replacement.length; i += 1) {
    const ch = replacement[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = replacement[i + 1];
    const after = replacement[i + 2];
    if (next === '\\' && after !== undefined && after >= '0' && after <= '9') {
      out += `\\${after}`;
      i += 2;
      continue;
    }
    if (next === '0') {
      out += '$&';
      i += 1;
      continue;
    }
    if (next !== undefined && next >= '1' && next <= '9') {
      out += `$${next}`;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 按 JS 替换串语法展开 `$1`..`$9` / `$&` / `$$`。
 * 指定「第 n 个匹配」时必须自己展开：`String.replace` 的回调形式会把返回值当字面，
 * 不会解析 `$` 引用，直接 return 替换串会把 `$1` 原样写进文件名。
 */
function expandDollarRefs(template: string, match: RegExpExecArray): string {
  let out = '';
  for (let i = 0; i < template.length; i += 1) {
    const ch = template[i];
    if (ch !== '$') {
      out += ch;
      continue;
    }
    const next = template[i + 1];
    if (next === '$') {
      out += '$';
      i += 1;
      continue;
    }
    if (next === '&') {
      out += match[0];
      i += 1;
      continue;
    }
    if (next !== undefined && next >= '1' && next <= '9') {
      out += match[Number(next)] ?? '';
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** 替换串里引用的最大分组序号（0 = 没有 `\n` 引用）。 */
export function maxBackslashRef(replacement: string): number {
  let max = 0;
  for (let i = 0; i < replacement.length; i += 1) {
    if (replacement[i] !== '\\') continue;
    const next = replacement[i + 1];
    if (next === '\\') {
      i += 1;
      continue;
    }
    if (next !== undefined && next >= '1' && next <= '9') {
      max = Math.max(max, Number(next));
      i += 1;
    }
  }
  return max;
}

/** 正则里捕获组的数量（编译失败返回 -1）。 */
function groupCount(pattern: string): number {
  try {
    const re = new RegExp(`${pattern}|`);
    const m = re.exec('');
    return m ? m.length - 1 : 0;
  } catch {
    return -1;
  }
}

function applyReplace(stem: string, rule: ReplaceRule, vars: VarContext): string {
  if (!rule.find) return stem;
  const source = rule.regex ? rule.find : regexEscape(rule.find);
  const flags = `g${rule.caseSensitive ? '' : 'i'}`;
  let re: RegExp;
  try {
    re = new RegExp(source, flags);
  } catch {
    return stem;
  }
  const expanded = expandTemplate(rule.replace, vars);
  const replacement = rule.regex ? convertBackslashRefs(expanded) : expanded;
  if (rule.nth === 0) return stem.replace(re, replacement);
  // 只替换第 nth 个匹配：用 exec 逐个找，命中后按捕获组自行展开替换串
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stem)) !== null) {
    count += 1;
    if (count === rule.nth) {
      const head = stem.slice(0, m.index);
      const tail = stem.slice(m.index + m[0].length);
      return head + expandDollarRefs(replacement, m) + tail;
    }
    // 零宽匹配要手动前进，否则 lastIndex 不动会死循环
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return stem;
}

/**
 * 删除规则：从名字里剪掉一段内容。
 * - range：窗口 = 起点 + 个数。`fromEnd` 表示起点从**尾部**数（from=1 即最后一个字符），
 *   个数始终朝**结尾方向**延伸，超出即截止到词尾——与「起始位置」标签一致，也与移动规则同口径。
 * - between：剪掉 left 与 right 之间的内容；空标记=该侧不设边界。**两个标记都空时不算合法配置**
 *   （由 `ruleError` 拦截），避免静默把整个名字删空。
 * - charset：符集逐字符过滤；`keep` 为真时只保留集合内字符。
 * - trim：剪掉首尾内容，默认只剪空白，可指定自定义字符集合。
 * 所有位置都按**码点**计（emoji 算 1 个字符），标记查找也从码点换算，避免代理对被切成半个。
 */
function applyDelete(stem: string, rule: DeleteRule): string {
  const chars = toChars(stem);
  if (rule.mode === 'trim') {
    const trimChars = rule.trimChars ?? '';
    if (!trimChars) return stem.trim();
    const set = new Set(toChars(trimChars));
    let start = 0;
    let end = chars.length;
    while (start < end && set.has(chars[start])) start += 1;
    while (end > start && set.has(chars[end - 1])) end -= 1;
    return fromChars(chars.slice(start, end));
  }
  if (rule.mode === 'charset') {
    const set = new Set(toChars(rule.chars));
    return fromChars(chars.filter((c) => (rule.keep ? set.has(c) : !set.has(c))));
  }
  if (rule.mode === 'between') {
    const left = rule.left;
    const right = rule.right;
    let start = 0;
    if (left) {
      const at = stem.indexOf(left);
      if (at < 0) return stem;
      // indexOf 给的是 UTF-16 码元下标，切片按码点，必须先换算
      const head = toChars(stem.slice(0, at)).length;
      start = head + (rule.includeLeft ? 0 : toChars(left).length);
    }
    let end = chars.length;
    if (right) {
      const at = stem.indexOf(right, left ? stem.indexOf(left) + left.length : 0);
      if (at < 0) return stem;
      const head = toChars(stem.slice(0, at)).length;
      end = head + (rule.includeRight ? toChars(right).length : 0);
    }
    if (start >= end) return stem;
    return fromChars([...chars.slice(0, start), ...chars.slice(end)]);
  }
  // range：起点从尾部数时与「起始位置」标签同义（from=1 指最后一个字符），个数朝结尾延伸
  let start = rule.fromEnd ? chars.length - rule.from : rule.from - 1;
  start = clamp(start, 0, chars.length);
  const end = clamp(start + rule.count, 0, chars.length);
  return fromChars([...chars.slice(0, start), ...chars.slice(end)]);
}

/**
 * 移动子串：把一段内容搬到另一个位置。
 * - by=index：片段 = 第 from 个字符起、长 count（fromEnd 表示从尾部数）。
 * - by=markers：片段 = left 与 right 之间的内容（left/right 为空即“不设边界”，
 *   任一非空标记找不到时**不改名**，与删除规则的“之间”保持一致）。
 * - 目标位置基于**移除片段之后**的字符串：to 默认表示“插到第 to 个字符之前”，
 *   toEnd 表示从尾部数（to=1 即末尾），insert=after 改为插到该字符之后。
 */
function applyMove(stem: string, rule: MoveRule): string {
  const chars = toChars(stem);
  let start: number;
  let end: number;
  if (rule.by === 'markers') {
    start = 0;
    end = chars.length;
    if (rule.left) {
      const at = stem.indexOf(rule.left);
      if (at < 0) return stem;
      const head = toChars(stem.slice(0, at)).length;
      start = head + (rule.includeLeft ? 0 : toChars(rule.left).length);
    }
    if (rule.right) {
      const from = rule.left ? stem.indexOf(rule.left) + rule.left.length : 0;
      const at = stem.indexOf(rule.right, from);
      if (at < 0) return stem;
      const head = toChars(stem.slice(0, at)).length;
      end = head + (rule.includeRight ? toChars(rule.right).length : 0);
    }
  } else {
    start = rule.fromEnd ? chars.length - rule.from : rule.from - 1;
    start = clamp(start, 0, chars.length);
    end = clamp(start + rule.count, 0, chars.length);
  }
  if (end <= start) return stem;
  const block = chars.splice(start, end - start);
  const baseLen = chars.length;
  let pos = rule.toEnd ? baseLen - (rule.to - 1) : rule.to - 1;
  if (rule.insert === 'after') pos += 1;
  pos = clamp(pos, 0, baseLen);
  chars.splice(pos, 0, ...block);
  return fromChars(chars);
}

function hashSeed(text: string, salt: string): number {
  let h = 2166136261;
  const input = `${salt}|${text}`;
  for (const ch of input) {
    h ^= ch.codePointAt(0) ?? 0;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function applyCaseRaw(stem: string, rule: CaseRule): string {
  switch (rule.mode) {
    case 'upper':
      return stem.toUpperCase();
    case 'lower':
      return stem.toLowerCase();
    case 'invert':
      return fromChars(toChars(stem).map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())));
    case 'random': {
      const rand = mulberry32(hashSeed(stem, rule.id));
      return fromChars(
        toChars(stem).map((c) => (rand() > 0.5 ? c.toUpperCase() : c.toLowerCase())),
      );
    }
    case 'sentence': {
      const lower = stem.toLowerCase();
      const chars = toChars(lower);
      for (let i = 0; i < chars.length; i += 1) {
        if (/\s/.test(chars[i])) continue;
        chars[i] = chars[i].toUpperCase();
        break;
      }
      return fromChars(chars);
    }
    case 'title': {
      const re = separatorRegex(rule.separators);
      return stem
        .split(re)
        .map((word) => {
          if (!word) return word;
          const chars = toChars(word.toLowerCase());
          chars[0] = chars[0].toUpperCase();
          return fromChars(chars);
        })
        .join((stem.match(re) ?? []).length ? stem.match(re)![0] : '');
    }
    default:
      return stem;
  }
}

/** 标题式大小写需要保留原分隔符，单独实现 */
function applyTitleRaw(stem: string, rule: CaseRule): string {
  const seps = rule.separators.length ? rule.separators : ' -_.';
  const chars = toChars(stem);
  let atWordStart = true;
  return fromChars(
    chars.map((c) => {
      if (seps.includes(c)) {
        atWordStart = true;
        return c;
      }
      if (atWordStart) {
        atWordStart = false;
        return c.toUpperCase();
      }
      return c.toLowerCase();
    }),
  );
}

/**
 * 例外词表：逗号 / 分号 / 换行分隔，`*` 匹配非空白片段、`?` 匹配单个非空白字符。
 * 大小写不敏感匹配，命中片段保留原名大小写。
 */
export function protectTokens(protect: string): string[] {
  return protect
    .split(/[\n,，;；]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function wildcardPattern(token: string): string {
  let pattern = '';
  for (const ch of Array.from(token)) {
    if (ch === '*') pattern += '[^\\s]*';
    else if (ch === '?') pattern += '[^\\s]';
    else pattern += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return pattern;
}

/** 把例外词在原名中的原始大小写还原回变换结果（仅当变换不改变长度时） */
export function restoreProtected(original: string, transformed: string, protect?: string): string {
  const tokens = protectTokens(protect ?? '');
  if (!tokens.length || original.length !== transformed.length) return transformed;
  let result = transformed;
  for (const token of tokens) {
    const re = new RegExp(wildcardPattern(token), 'gi');
    let match: RegExpExecArray | null = re.exec(original);
    while (match) {
      const span = match[0];
      if (span.length) {
        const kept = original.slice(match.index, match.index + span.length);
        result = result.slice(0, match.index) + kept + result.slice(match.index + span.length);
        re.lastIndex = match.index + span.length;
      } else {
        re.lastIndex += 1;
      }
      match = re.exec(original);
    }
  }
  return result;
}

function applyCase(stem: string, rule: CaseRule): string {
  return restoreProtected(stem, applyCaseRaw(stem, rule), rule.protect);
}

function applyTitle(stem: string, rule: CaseRule): string {
  return restoreProtected(stem, applyTitleRaw(stem, rule), rule.protect);
}

export interface NumberContext {
  /** 计数键（规则 + 分组） */
  key: string;
  counter: number;
  increment: boolean;
}

function formatNumber(value: number, digits: number, padChar: string): string {
  const raw = String(Math.max(0, Math.trunc(value)));
  const pad = padChar || '0';
  return raw.length >= digits ? raw : pad.repeat(digits - raw.length) + raw;
}

function applyNumber(rule: NumberRule, counter: number, vars: VarContext): string {
  const formatted = formatNumber(counter, rule.digits, rule.padChar);
  return expandTemplate(rule.expression, {
    ...vars,
    counter: formatted,
    counterRaw: counter,
    counterFormat: (value) => formatNumber(value, rule.digits, rule.padChar),
  });
}

function applyExt(
  ext: string,
  rule: ExtRule,
  counter: number,
  vars: VarContext,
  detected?: string,
): string {
  const value = expandTemplate(rule.value, vars).replace(/^\.+/, '').replace(/\.+$/, '');
  switch (rule.mode) {
    case 'analyze': {
      // 只信文件头嗅探结果：识别不出（空串）或与当前一致时保持原名，绝不猜
      const real = (detected ?? '').trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
      if (!real) return ext;
      return real === ext.toLowerCase() ? ext : real;
    }
    case 'add':
      return rule.position === 'prefix' ? `${value}${ext}` : `${ext}${value}`;
    case 'replace':
      return value;
    case 'remove':
      return '';
    case 'case':
      return rule.caseMode === 'upper' ? ext.toUpperCase() : ext.toLowerCase();
    case 'fixed':
      return value;
    case 'number':
      return `${formatNumber(counter, Math.max(1, Number(rule.value) || 1), '0')}${ext}`;
    default:
      return ext;
  }
}

export interface ApplyContext {
  /** 下一个编号值（已按规则/分组维护） */
  nextNumber: (rule: NumberRule, key: string) => number;
  /** 不参与计数时使用的当前值 */
  peekNumber: (rule: NumberRule, key: string) => number;
  /** 预分配的编号（预览按分组/路径顺序算好后传入）；返回 undefined 时退回 nextNumber */
  numberFor?: (rule: NumberRule) => number | undefined;
  /** 该条是否命中本规则的排除列表（命中则跳过编号） */
  isNumberExcluded?: (rule: NumberRule) => boolean;
  /** 当前文件的只读元数据字段（供「按元数据取名」规则使用；缺失则跳过该规则） */
  meta?: MetaFields;
  /** 当前文件按文件头魔数嗅探出的真实扩展名（小写、不含点；空串=识别不出） */
  sniff?: string;
  /** 当前文件的元变量取值（原文件名、扩展名、目录、时间、大小、哈希、用户文本） */
  vars: VarContext;
}

/** 编号规则的计数分组键：不分组 / 按目录 / 按元数据字段。 */
export function numberGroupKey(rule: NumberRule, parent: string, meta?: MetaFields): string {
  if (rule.groupBy === 'parent') return parent;
  if (rule.groupBy.startsWith('field:')) {
    const field = rule.groupBy.slice(6) as keyof MetaFields;
    return `f:${meta?.[field] ?? ''}`;
  }
  return '';
}

export function applyRules(
  original: { stem: string; ext: string },
  isDir: boolean,
  rules: Rule[],
  parent: string,
  ctx: ApplyContext,
  entrySelected: boolean,
): { stem: string; ext: string; numbers: string[] } {
  let stem = original.stem;
  let ext = original.ext;
  const numbers: string[] = [];
  // 编号可写入 USERn，供后续规则引用；每个文件用独立副本，不污染其他条目
  const vars: VarContext = { ...ctx.vars, users: [...(ctx.vars.users ?? [])] };

  for (const rule of rules) {
    if (!rule.enabled || ruleError(rule)) continue;
    switch (rule.type) {
      case 'add':
        stem = applyAdd(stem, rule, vars);
        break;
      case 'replace':
        stem = applyReplace(stem, rule, vars);
        break;
      case 'delete':
        stem = applyDelete(stem, rule);
        break;
      case 'number': {
        if (ctx.isNumberExcluded?.(rule)) break;
        const planned = ctx.numberFor?.(rule);
        const key = numberGroupKey(rule, parent, ctx.meta);
        const value = planned ?? (rule.onlyChecked && !entrySelected
          ? ctx.peekNumber(rule, key)
          : ctx.nextNumber(rule, key));
        stem = applyNumber(rule, value, vars);
        const formatted = formatNumber(value, rule.digits, rule.padChar);
        numbers.push(formatted);
        if (rule.writeVar) {
          const index = Number(rule.writeVar.slice(4));
          if (index === 0) vars.user0 = formatted;
          else if (index >= 1 && index <= 9) vars.users[index - 1] = formatted;
        }
        break;
      }
      case 'move':
        stem = applyMove(stem, rule);
        break;
      case 'case':
        stem = rule.mode === 'title' ? applyTitle(stem, rule) : applyCase(stem, rule);
        break;
      case 'ext':
        if (isDir) break;
        if (rule.mode === 'number') {
          const probe: NumberRule = {
            id: rule.id, type: 'number', enabled: rule.enabled, expression: '<#>',
            start: 1, step: 1, digits: Math.max(1, Number(rule.value) || 1), padChar: '0',
            groupBy: 'none', exclude: '', byPath: false, writeVar: '', onlyChecked: false,
          };
          // 序号已在 planNumbers 里按列表顺序预分配（目录不占号），逐条求值只用不占；
          // 只有计划缺项时才回退到顺序计数器，保证可见切片单独求值的序号与整表一致
          const value = ctx.numberFor?.(probe) ?? ctx.nextNumber(probe, '');
          ext = applyExt(ext, rule, value, vars, ctx.sniff);
        } else {
          ext = applyExt(ext, rule, 1, vars, ctx.sniff);
        }
        break;
      case 'meta': {
        const value = ctx.meta?.[rule.field] ?? '';
        if (value) {
          if (rule.mode === 'replace') stem = value;
          else if (rule.mode === 'prefix') stem = `${value}${rule.separator}${stem}`;
          else stem = `${stem}${rule.separator}${value}`;
        }
        break;
      }
      case 'map': {
        // 表已在 ruleError 里校验过；这里再解析一次是纯函数、无副作用，避免结论依赖调用顺序
        const parsed = parseMapTable(rule.table, rule.caseSensitive);
        if (parsed.entries.length) stem = applyMapping(stem, parsed.entries, rule.caseSensitive);
        break;
      }
      default:
        break;
    }
  }
  return { stem, ext, numbers };
}

function metaFieldLabel(field: string): string {
  const key = (META_FIELDS as string[]).includes(field) ? (field as MetaFieldKey) : 'taken';
  return t(metaFieldLabelKey(key));
}

/** 规则卡片摘要里每个字段的说法（比编辑器里的字段名更具体，注明来源 EXIF / 音频标签）。 */
const META_SUMMARY_KEYS: Record<MetaFieldKey, string> = {
  taken: 'ruleSum.metaTaken',
  camera: 'ruleSum.metaCamera',
  iso: 'ruleSum.metaIso',
  aperture: 'ruleSum.metaAperture',
  shutter: 'ruleSum.metaShutter',
  focal: 'ruleSum.metaFocal',
  lens: 'ruleSum.metaLens',
  width: 'ruleSum.metaWidth',
  height: 'ruleSum.metaHeight',
  resolution: 'ruleSum.metaResolution',
  title: 'ruleSum.metaTitle',
  artist: 'ruleSum.metaArtist',
  album: 'ruleSum.metaAlbum',
  track: 'ruleSum.metaTrack',
  year: 'ruleSum.metaYear',
  genre: 'ruleSum.metaGenre',
  composer: 'ruleSum.metaComposer',
  fontFamily: 'ruleSum.metaFontFamily',
  fontStyle: 'ruleSum.metaFontStyle',
  fontVersion: 'ruleSum.metaFontVersion',
  fileVersion: 'ruleSum.metaFileVersion',
  keywords: 'ruleSum.metaKeywords',
  caption: 'ruleSum.metaCaption',
  copyright: 'ruleSum.metaCopyright',
  location: 'ruleSum.metaLocation',
};

/** 兼容旧规则字段：perFolder → groupBy；移动规则补齐 by/标记/insert；其余补齐默认值。 */
export function normalizeRule(rule: Rule): Rule {
  if (rule.type === 'move') {
    // 旧版本只有 from/count/to：默认按位置定位、插到目标之前，语义与旧行为一致
    const legacy = rule as MoveRule & Partial<Pick<MoveRule, 'by' | 'left' | 'right' | 'includeLeft' | 'includeRight' | 'insert'>>;
    return {
      ...legacy,
      by: legacy.by === 'markers' ? 'markers' : 'index',
      left: legacy.left ?? '[',
      right: legacy.right ?? ']',
      includeLeft: legacy.includeLeft ?? true,
      includeRight: legacy.includeRight ?? true,
      insert: legacy.insert === 'after' ? 'after' : 'before',
    };
  }
  if (rule.type === 'delete') {
    // trimChars 是本轮新增字段：旧存档缺省为空串，等价于「只剪空白」，行为不变
    const legacy = rule as DeleteRule & { trimChars?: string };
    return { ...legacy, trimChars: typeof legacy.trimChars === 'string' ? legacy.trimChars : '' };
  }
  if (rule.type === 'map') {
    // 手改存档 / 旧计划文件可能缺字段：补齐后再进解析，避免 undefined 崩掉整条链
    const legacy = rule as MapRule & Partial<Pick<MapRule, 'table' | 'caseSensitive'>>;
    return {
      ...legacy,
      table: typeof legacy.table === 'string' ? legacy.table : '',
      caseSensitive: !!legacy.caseSensitive,
    };
  }
  if (rule.type !== 'number') return rule;
  const legacy = rule as NumberRule & { perFolder?: boolean };
  const raw = typeof legacy.groupBy === 'string' && legacy.groupBy
    ? legacy.groupBy
    : (legacy.perFolder ? 'parent' : 'none');
  const groupBy = raw === 'none' || raw === 'parent'
    || (raw.startsWith('field:') && META_FIELDS.includes(raw.slice(6) as MetaFieldKey))
    ? raw
    : 'none';
  return {
    ...legacy,
    groupBy,
    exclude: legacy.exclude ?? '',
    byPath: !!legacy.byPath,
    writeVar: /^USER[0-9]$/.test(legacy.writeVar ?? '') ? legacy.writeVar : '',
  };
}

export function normalizeRules(rules: Rule[]): Rule[] {
  return rules.map(normalizeRule);
}

/** 规则卡片的一句话摘要 */
export function ruleSummary(rule: Rule): string {
  switch (rule.type) {
    case 'add':
      if (rule.mode === 'pad') return t('ruleSum.pad', { n: rule.padTo, ch: rule.padChar || '0' });
      return t('ruleSum.insert', {
        where: rule.anchor === 'start' ? t('ruleSum.atStart') : rule.anchor === 'end' ? t('ruleSum.atEnd') : t('ruleSum.atPos'),
        text: rule.text,
      });
    case 'replace':
      return t('ruleSum.replace', {
        regex: rule.regex ? t('ruleSum.regex') : '',
        find: rule.find,
        replace: rule.replace,
        nth: rule.nth ? t('ruleSum.nth', { n: rule.nth }) : '',
        case: rule.caseSensitive ? t('ruleSum.case') : '',
      });
    case 'delete':
      if (rule.mode === 'trim') {
        return rule.trimChars ? t('ruleSum.trimChars', { chars: rule.trimChars }) : t('ruleSum.trim');
      }
      if (rule.mode === 'between') return t('ruleSum.between', { left: rule.left, right: rule.right });
      if (rule.mode === 'charset') {
        return t(rule.keep ? 'ruleSum.charsetKeep' : 'ruleSum.charsetDrop', { chars: rule.chars });
      }
      return t(rule.fromEnd ? 'ruleSum.rangeEnd' : 'ruleSum.range', {
        from: rule.from, count: rule.count, reverse: rule.fromEnd ? t('ruleSum.reverse') : '',
      });
    case 'number': {
      const group = rule.groupBy === 'parent'
        ? t('ruleSum.perFolder')
        : rule.groupBy.startsWith('field:')
          ? t('ruleSum.groupField', { label: metaFieldLabel(rule.groupBy.slice(6)) })
          : '';
      const extra = [
        rule.byPath ? t('ruleSum.byPath') : '',
        rule.writeVar ? t('ruleSum.writeVar', { name: rule.writeVar }) : '',
        rule.exclude.trim() ? t('ruleSum.exclude', { list: rule.exclude.trim().split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean).join(', ') }) : '',
      ].join('');
      return t('ruleSum.number', {
        expr: rule.expression, start: rule.start, step: rule.step, digits: rule.digits, group,
      }) + extra;
    }
    case 'move': {
      const target = rule.toEnd
        ? t('ruleSum.moveToEnd', { to: rule.to })
        : t(rule.insert === 'after' ? 'ruleSum.moveToAfter' : 'ruleSum.moveTo', { to: rule.to });
      if (rule.by === 'markers') {
        return t('ruleSum.moveMarkers', {
          left: rule.left || t('ruleSum.moveHead'),
          right: rule.right || t('ruleSum.moveTail'),
          target,
        });
      }
      return t('ruleSum.move', {
        from: rule.from, count: rule.count, reverse: rule.fromEnd ? t('ruleSum.reverse') : '', target,
      });
    }
    case 'case':
      return {
        upper: t('ruleSum.caseUpper'), lower: t('ruleSum.caseLower'), title: t('ruleSum.caseTitle'),
        sentence: t('ruleSum.caseSentence'), invert: t('ruleSum.caseInvert'), random: t('ruleSum.caseRandom'),
      }[rule.mode];
    case 'ext':
      return {
        add: t(rule.position === 'prefix' ? 'ruleSum.extBefore' : 'ruleSum.extAfter', { value: rule.value }),
        replace: t('ruleSum.extReplace', { value: rule.value }),
        remove: t('ruleSum.extRemove'),
        number: t('ruleSum.extNumber'),
        case: t(rule.caseMode === 'upper' ? 'ruleSum.extCaseUpper' : 'ruleSum.extCaseLower'),
        fixed: t('ruleSum.extFixed', { value: rule.value }),
        analyze: t('ruleSum.extAnalyze'),
      }[rule.mode];
    case 'meta': {
      const label = t(META_SUMMARY_KEYS[rule.field] ?? 'ruleSum.metaTaken');
      if (rule.mode === 'replace') return t('ruleSum.metaReplace', { label });
      const base = t(rule.mode === 'prefix' ? 'ruleSum.metaPrefix' : 'ruleSum.metaSuffix', {
        label, sep: '',
      });
      return `${base}${rule.separator ? t('ruleSum.metaSep', { sep: rule.separator }) : ''}`;
    }
    case 'map': {
      const parsed = parseMapTable(rule.table, rule.caseSensitive);
      return t(rule.caseSensitive ? 'ruleSum.mapCase' : 'ruleSum.map', { n: parsed.entries.length });
    }
    default:
      return '';
  }
}

/** 文件图标分类 */
export function fileKind(name: string, isDir: boolean): string {
  if (isDir) return 'folder';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'tiff'].includes(ext)) return 'jpg';
  if (ext === 'pdf') return 'pdf';
  if (['txt', 'md', 'log', 'csv', 'json', 'xml', 'srt'].includes(ext)) return 'txt';
  if (['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg'].includes(ext)) return 'music';
  if (['mp4', 'mov', 'mkv', 'avi', 'webm'].includes(ext)) return 'video';
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return 'doc';
  return 'file';
}
