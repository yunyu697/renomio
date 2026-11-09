/** 名称模板里的元变量：解析、校验与展开。
 *
 * 语法：`<名称>`，可带参数 `<名称:参数1:参数2>`；名称大小写不敏感。
 * - `<FILENAME>` 原文件名（含扩展名；目录为整个目录名）
 * - `<NAME>`  原文件名（不含扩展名）
 * - `<EXT>`   扩展名，不含点（目录为空串）
 * - `<DOTEXT>` 扩展名，含前导点（无扩展名时为空串）
 * - `<SUBSTR>` 原名（不含扩展名）的子串；`<SUBSTR:起>` / `<SUBSTR:起:长>`
 * - `<DIFNSUBSTR>` 原名（不含扩展名）去掉上述子串后剩下的部分（参数同上）
 * - `<DIR>`   所在目录名（根目录为空串）
 * - `<DATE>`  文件修改日期，默认 `yyyyMMdd`；`<DATE:yyyy-MM-dd>` 自定义格式
 * - `<TIME>`  文件修改时间，默认 `HHmmss`；`<TIME:HH-mm-ss>` 自定义格式
 * - `<SIZE>`  字节数；`<SIZE:KB>` 换单位；`<SIZE:KB:6>` 再补零到 6 位
 * - `<CRC32>` / `<MD5>` / `<SHA1>` 内容哈希（小写十六进制）
 * - `<USER0>`–`<USER9>` 用户自定义文本（未设置为空串）
 * - `<#>` 序号（仅编号规则表达式）
 * - `<<#>>` 当前序号，可做整数四则：`<<#>+10>>`、`<<#> * 2 - 1>>`
 * - `<IF:条件|真|假>` 条件表达式，条件如 `#>=3`、`EXT=JPG`；假分支可省略
 */

import type { Rule } from './types';

export type HashAlgo = 'crc32' | 'md5' | 'sha1';

export const HASH_ALGOS: HashAlgo[] = ['crc32', 'md5', 'sha1'];

export interface HashValues {
  crc32?: string;
  md5?: string;
  sha1?: string;
}

export interface VarContext {
  /** 扫描时的原文件名（不含扩展名），不随前面的规则变化 */
  stem: string;
  /** 扫描时的原扩展名（不含点） */
  ext: string;
  /** 所在目录名 */
  dirName: string;
  /** 文件修改时间（毫秒） */
  modified: number;
  /** 字节数 */
  size: number;
  hashes: HashValues;
  /** USER1–USER9（长度 9，缺失为空串） */
  users: string[];
  /** USER0（可选，未设置为空串） */
  user0?: string;
  /** 仅编号规则的表达式会传入（已按位数/补齐字符格式化） */
  counter?: string;
  /** 仅编号规则的表达式会传入（原始数值，供 <<#>> 运算） */
  counterRaw?: number;
  /** <<#>> 运算结果的格式化函数（缺省用十进制原样输出） */
  counterFormat?: (value: number) => string;
}

export interface TemplateScan {
  /** 未知变量名（不含尖括号）；为空表示全部可识别 */
  unknown: string;
  /** 参数不合法时的变量名 */
  badArgs: string;
  /** 使用了 `<#>` / `<<#>>` / 条件里引用了 `#` */
  counter: boolean;
  /** `<<#>>` 内的算式无法求值 */
  counterBad: boolean;
  /** 条件表达式不合法（原文） */
  condBad: string;
  /** 需要的哈希算法（去重、仅返回实际引用到的） */
  hashes: HashAlgo[];
  /** 引用了 USERn（1–9） */
  users: number[];
  /** 引用了 USER0 */
  user0: boolean;
}

const BASE_NAMES = new Set([
  'FILENAME', 'NAME', 'EXT', 'DOTEXT', 'SUBSTR', 'DIFNSUBSTR', 'DIR', 'DATE', 'TIME', 'SIZE', 'CRC32', 'MD5', 'SHA1',
  'USER0',
  ...Array.from({ length: 9 }, (_, i) => `USER${i + 1}`),
]);

const SIZE_UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

function isUser(name: string): boolean {
  return /^USER[1-9]$/.test(name);
}

/** SUBSTR / DIFNSUBSTR 的截取参数：起始为 1 基（负值从末尾数），长度可省略（到末尾）。 */
function parseSliceArgs(args: string[]): { start: number; length: number | null } | null {
  if (args.length === 0) return { start: 1, length: null };
  if (args.length > 2) return null;
  if (!/^-?\d{1,6}$/.test(args[0] ?? '')) return null;
  const start = Number(args[0]);
  if (start === 0) return null;
  if (args.length === 1) return { start, length: null };
  if (!/^\d{1,6}$/.test(args[1] ?? '')) return null;
  return { start, length: Number(args[1]) };
}

function validArgs(name: string, args: string[]): boolean {
  if (name === 'DATE' || name === 'TIME') return args.length <= 1;
  if (name === 'SUBSTR' || name === 'DIFNSUBSTR') return parseSliceArgs(args) !== null;
  if (name === 'FILENAME') return args.length === 0;
  if (name === 'SIZE') {
    if (args.length === 0) return true;
    const unit = args[0].toUpperCase();
    if (!SIZE_UNITS[unit]) return false;
    if (args.length === 1) return true;
    return /^\d{1,2}$/.test(args[1]) && Number(args[1]) <= 12;
  }
  return args.length === 0;
}

/* ------------------------------------------------------------------ *
 * 模板解析：文本 / 变量 / <#> / <<#表达式>> / <IF:条件|真|假>
 * ------------------------------------------------------------------ */

type Token =
  | { kind: 'text'; text: string }
  | { kind: 'var'; inner: string }
  | { kind: 'counter' }
  | { kind: 'expr'; expr: string }
  | { kind: 'if'; cond: string; yes: string; no: string };

/** `<IF:` 内部允许出现 `>` 与 `<`（比较运算符）与嵌套变量，按层数找真正的结束尖括号。 */
function findIfEnd(text: string, from: number): number {
  let depth = 0;
  for (let j = from; j < text.length; j += 1) {
    const c = text[j];
    if (c === '<' && text[j + 1] !== '=') {
      depth += 1;
      continue;
    }
    if (c !== '>') continue;
    if (depth > 0) {
      depth -= 1;
      continue;
    }
    // `>=` / `>` 运算符：紧跟 `=` 时不作为标签结束
    if (text[j + 1] === '=') continue;
    return j;
  }
  return -1;
}

/** `<IF:条件|真|假>`：只按前两个 `|` 切分，假分支可省略。 */
function splitIfBody(body: string): [string, string, string] {
  const a = body.indexOf('|');
  if (a < 0) return [body, '', ''];
  const b = body.indexOf('|', a + 1);
  if (b < 0) return [body.slice(0, a), body.slice(a + 1), ''];
  return [body.slice(0, a), body.slice(a + 1, b), body.slice(b + 1)];
}

function parseTemplate(text: string): Token[] {
  const tokens: Token[] = [];
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf) {
      tokens.push({ kind: 'text', text: buf });
      buf = '';
    }
  };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      buf += text.slice(i);
      break;
    }
    if (lt > i) buf += text.slice(i, lt);
    if (text.startsWith('<<#>', lt)) {
      const close = text.indexOf('>>', lt + 4);
      // 简写 `<<#>>` 只有一层收尾尖括号；带算式时写作 `<<#>+10>>`
      if (close < 0 && text[lt + 4] === '>') {
        flush();
        tokens.push({ kind: 'expr', expr: '' });
        i = lt + 5;
        continue;
      }
      if (close < 0) {
        buf += text.slice(lt);
        break;
      }
      flush();
      tokens.push({ kind: 'expr', expr: text.slice(lt + 4, close).trim() });
      i = close + 2;
      continue;
    }
    if (text.slice(lt + 1, lt + 4).toUpperCase() === 'IF:') {
      const end = findIfEnd(text, lt + 4);
      if (end < 0) {
        buf += text.slice(lt);
        break;
      }
      const [cond, yes, no] = splitIfBody(text.slice(lt + 4, end));
      flush();
      tokens.push({ kind: 'if', cond, yes, no });
      i = end + 1;
      continue;
    }
    const gt = text.indexOf('>', lt + 1);
    if (gt < 0) {
      buf += text.slice(lt);
      break;
    }
    const inner = text.slice(lt + 1, gt);
    flush();
    tokens.push(inner === '#' ? { kind: 'counter' } : { kind: 'var', inner });
    i = gt + 1;
  }
  flush();
  return tokens;
}

/* ------------------------------------------------------------------ *
 * 序号四则运算：只支持整数、+ - * / 与括号；除不尽向零取整
 * ------------------------------------------------------------------ */

export function evalIntegerExpr(src: string, base: number): number | null {
  const body = src.replace(/\s+/g, '');
  if (!body) return base;
  // `<<#>` 就是当前序号本身，后面的内容接在它后面：
  // `<<#>+10>>` → `1+10`，`<<#> * 2 - 1>>` → `1*2-1`
  const s = `${Math.trunc(base)}${body}`;
  let i = 0;
  const term = (): number | null => {
    let value = factor();
    if (value === null) return null;
    while (i < s.length && (s[i] === '*' || s[i] === '/')) {
      const op = s[i];
      i += 1;
      const right = factor();
      if (right === null) return null;
      if (op === '/' && right === 0) return null;
      value = op === '*' ? value * right : value / right;
    }
    return value;
  };
  const expr = (): number | null => {
    let value = term();
    if (value === null) return null;
    while (i < s.length && (s[i] === '+' || s[i] === '-')) {
      const op = s[i];
      i += 1;
      const right = term();
      if (right === null) return null;
      value = op === '+' ? value + right : value - right;
    }
    return value;
  };
  const factor = (): number | null => {
    if (s[i] === '+' || s[i] === '-') {
      const op = s[i];
      i += 1;
      const value = factor();
      if (value === null) return null;
      return op === '-' ? -value : value;
    }
    if (s[i] === '(') {
      i += 1;
      const value = expr();
      if (value === null || s[i] !== ')') return null;
      i += 1;
      return value;
    }
    const match = /^\d+/.exec(s.slice(i));
    if (!match) return null;
    i += match[0].length;
    return Number(match[0]);
  };
  const value = expr();
  if (value === null || i !== s.length || !Number.isFinite(value)) return null;
  return value;
}

/* ------------------------------------------------------------------ *
 * 条件表达式：`#>=3`、`EXT=JPG`、`# ge 3`（gt/ge/lt/le/eq/ne）
 * ------------------------------------------------------------------ */

const WORD_OPS: Record<string, string> = { eq: '=', ne: '!=', gt: '>', ge: '>=', lt: '<', le: '<=' };

interface Condition {
  left: string;
  op: string;
  right: string;
}

function parseCondition(text: string): Condition | null {
  const t = text.trim();
  if (!t) return null;
  const word = /^(.*?)\s+(eq|ne|gt|ge|lt|le)\s+(.*)$/i.exec(t);
  if (word) return { left: word[1].trim(), op: WORD_OPS[word[2].toLowerCase()], right: word[3].trim() };
  for (const op of ['!=', '>=', '<=', '=', '>', '<']) {
    const at = t.indexOf(op);
    if (at > 0) return { left: t.slice(0, at).trim(), op, right: t.slice(at + op.length).trim() };
  }
  return null;
}

function evalCondition(cond: Condition, ctx: VarContext): boolean {
  const left = cond.left === '#'
    ? String(ctx.counterRaw ?? Number(ctx.counter ?? 0))
    : expandVar(cond.left, ctx) ?? '';
  const a = left.toLowerCase();
  const b = cond.right.toLowerCase();
  const an = /^-?\d+(\.\d+)?$/.test(a) ? Number(a) : null;
  const bn = /^-?\d+(\.\d+)?$/.test(b) ? Number(b) : null;
  const numeric = an !== null && bn !== null;
  switch (cond.op) {
    case '=': return a === b;
    case '!=': return a !== b;
    case '>': return numeric ? an > bn : a > b;
    case '>=': return numeric ? an >= bn : a >= b;
    case '<': return numeric ? an < bn : a < b;
    case '<=': return numeric ? an <= bn : a <= b;
    default: return false;
  }
}

/* ------------------------------------------------------------------ *
 * 扫描与展开
 * ------------------------------------------------------------------ */

function scanVar(inner: string, scan: TemplateScan): void {
  const sep = inner.indexOf(':');
  const rawName = sep < 0 ? inner : inner.slice(0, sep);
  const args = sep < 0 ? [] : inner.slice(sep + 1).split(':');
  const name = rawName.toUpperCase();
  if (!BASE_NAMES.has(name)) {
    if (!scan.unknown) scan.unknown = rawName;
    return;
  }
  if (!validArgs(name, args)) {
    if (!scan.badArgs) scan.badArgs = rawName;
    return;
  }
  if (name === 'CRC32') { if (!scan.hashes.includes('crc32')) scan.hashes.push('crc32'); }
  if (name === 'MD5') { if (!scan.hashes.includes('md5')) scan.hashes.push('md5'); }
  if (name === 'SHA1') { if (!scan.hashes.includes('sha1')) scan.hashes.push('sha1'); }
  if (name === 'USER0') scan.user0 = true;
  if (isUser(name)) {
    const index = Number(name.slice(4));
    if (!scan.users.includes(index)) scan.users.push(index);
  }
}

function scanTokens(tokens: Token[], scan: TemplateScan): void {
  for (const token of tokens) {
    if (token.kind === 'text') continue;
    if (token.kind === 'var') {
      scanVar(token.inner, scan);
      continue;
    }
    if (token.kind === 'counter') {
      scan.counter = true;
      continue;
    }
    if (token.kind === 'expr') {
      scan.counter = true;
      if (evalIntegerExpr(token.expr, 1) === null) scan.counterBad = true;
      continue;
    }
    const cond = parseCondition(token.cond);
    if (!cond) {
      if (!scan.condBad) scan.condBad = token.cond.trim() || '(empty)';
      continue;
    }
    if (cond.left === '#') scan.counter = true;
    else scanVar(cond.left, scan);
    scanTokens(parseTemplate(token.yes), scan);
    scanTokens(parseTemplate(token.no), scan);
  }
}

/** 扫描模板：找未知变量、非法参数、非法算式/条件与依赖项。不会修改文本。 */
export function scanTemplate(text: string): TemplateScan {
  const scan: TemplateScan = {
    unknown: '', badArgs: '', counter: false, counterBad: false, condBad: '', hashes: [], users: [], user0: false,
  };
  scanTokens(parseTemplate(text), scan);
  return scan;
}

const pad = (value: number, digits = 2): string => String(value).padStart(digits, '0');

/** 按格式串输出时间；支持 yyyy yy MM M dd d HH H mm m ss s，其余字符原样保留。 */
export function formatStamp(ms: number, format: string): string {
  const date = new Date(Number.isFinite(ms) && ms > 0 ? ms : 0);
  const parts: Record<string, string> = {
    yyyy: String(date.getFullYear()),
    yy: pad(date.getFullYear() % 100),
    MM: pad(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    dd: pad(date.getDate()),
    d: String(date.getDate()),
    HH: pad(date.getHours()),
    H: String(date.getHours()),
    mm: pad(date.getMinutes()),
    m: String(date.getMinutes()),
    ss: pad(date.getSeconds()),
    s: String(date.getSeconds()),
  };
  return format.replace(/yyyy|yy|MM|M|dd|d|HH|H|mm|m|ss|s/g, (token) => parts[token]);
}

function formatSize(size: number, unit: string, digits: number): string {
  const factor = SIZE_UNITS[unit.toUpperCase()] ?? 1;
  const value = Math.max(0, Math.trunc(Number(size) || 0));
  const scaled = Math.trunc(value / factor);
  return digits > 0 ? String(scaled).padStart(digits, '0') : String(scaled);
}

/** 原文件名（含扩展名）；目录没有扩展名，直接是目录名。 */
function fullNameOf(ctx: VarContext): string {
  return ctx.ext ? `${ctx.stem}.${ctx.ext}` : ctx.stem;
}

/**
 * 按 1 基起始 + 可选长度换算成 0 基区间，越界一律钳到边界：
 * 正起始超过末尾 → 空区间；负起始超过开头 → 从 0 开始；长度超过剩余 → 到末尾。
 */
function sliceRange(total: number, args: string[]): { from: number; to: number } {
  const parsed = parseSliceArgs(args) ?? { start: 1, length: null };
  const rawFrom = parsed.start > 0 ? parsed.start - 1 : total + parsed.start;
  const from = Math.max(0, Math.min(total, rawFrom));
  const to = parsed.length === null ? total : Math.max(from, Math.min(total, from + parsed.length));
  return { from, to };
}

/** 展开单个变量；未知变量/非法参数返回 null（调用方保留原文）。 */
function expandVar(inner: string, ctx: VarContext): string | null {
  const sep = inner.indexOf(':');
  const rawName = sep < 0 ? inner : inner.slice(0, sep);
  const args = sep < 0 ? [] : inner.slice(sep + 1).split(':');
  const name = rawName.toUpperCase();
  if (!BASE_NAMES.has(name) || !validArgs(name, args)) return null;
  switch (name) {
    case 'FILENAME': return fullNameOf(ctx);
    case 'NAME': return ctx.stem;
    case 'EXT': return ctx.ext;
    case 'DOTEXT': return ctx.ext ? `.${ctx.ext}` : '';
    case 'SUBSTR': {
      const chars = Array.from(ctx.stem);
      const { from, to } = sliceRange(chars.length, args);
      return chars.slice(from, to).join('');
    }
    case 'DIFNSUBSTR': {
      const chars = Array.from(ctx.stem);
      const { from, to } = sliceRange(chars.length, args);
      return [...chars.slice(0, from), ...chars.slice(to)].join('');
    }
    case 'DIR': return ctx.dirName;
    case 'DATE': return formatStamp(ctx.modified, args[0] || 'yyyyMMdd');
    case 'TIME': return formatStamp(ctx.modified, args[0] || 'HHmmss');
    case 'SIZE': return formatSize(ctx.size, args[0] || 'B', args[1] ? Number(args[1]) : 0);
    case 'CRC32': return ctx.hashes.crc32 ?? '';
    case 'MD5': return ctx.hashes.md5 ?? '';
    case 'SHA1': return ctx.hashes.sha1 ?? '';
    case 'USER0': return ctx.user0 ?? '';
    default: {
      if (!isUser(name)) return null;
      return ctx.users[Number(name.slice(4)) - 1] ?? '';
    }
  }
}

/** 展开模板；调用前应先用 scanTemplate 校验。未知变量按原文保留（预览会拦截应用）。 */
export function expandTemplate(text: string, ctx: VarContext, depth = 0): string {
  if (depth > 4) return text;
  let out = '';
  for (const token of parseTemplate(text)) {
    switch (token.kind) {
      case 'text':
        out += token.text;
        break;
      case 'counter':
        out += ctx.counter ?? '';
        break;
      case 'expr': {
        const value = evalIntegerExpr(token.expr, ctx.counterRaw ?? 0);
        if (value === null) break;
        const rounded = Math.trunc(value);
        out += ctx.counterFormat ? ctx.counterFormat(rounded) : String(rounded);
        break;
      }
      case 'if': {
        const cond = parseCondition(token.cond);
        const picked = cond && evalCondition(cond, ctx) ? token.yes : token.no;
        out += expandTemplate(picked, ctx, depth + 1);
        break;
      }
      default: {
        const value = expandVar(token.inner, ctx);
        out += value === null ? `<${token.inner}>` : value;
        break;
      }
    }
  }
  return out;
}

/** 从目录路径取最后一段；根目录/空路径返回空串。 */
export function dirNameOf(parent: string): string {
  const trimmed = parent.replace(/[\\/]+$/, '');
  const at = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return at < 0 ? '' : trimmed.slice(at + 1);
}

/** 示例上下文：变量面板的实时示例与文档共用（不依赖真实文件）。 */
export const SAMPLE_VARS: VarContext = {
  stem: 'IMG_2048',
  ext: 'jpg',
  dirName: '旅行照片',
  modified: new Date(2026, 0, 2, 3, 4, 5).getTime(),
  size: 1048576,
  hashes: { crc32: '1a2b3c4d', md5: '0123456789abcdef0123456789abcdef', sha1: '0123456789abcdef0123456789abcdef01234567' },
  users: ['示例文本', '', '', '', '', '', '', '', ''],
  user0: '零号文本',
};

/** 规则的模板字段（只有这些字段里的 `<...>` 会被展开）。 */
export function varFieldsOf(rule: Rule): string[] {
  switch (rule.type) {
    case 'add':
      return rule.mode === 'direct' ? [rule.text] : [];
    case 'replace':
      return [rule.replace];
    case 'number':
      return [rule.expression];
    case 'ext':
      return rule.mode === 'number' ? [] : [rule.value];
    default:
      return [];
  }
}

/** 当前启用的规则需要哪些内容哈希（用于决定是否发起计算）。 */
export function rulesRequireHashes(rules: Rule[]): HashAlgo[] {
  const need = new Set<HashAlgo>();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const text of varFieldsOf(rule)) {
      for (const algo of scanTemplate(text).hashes) need.add(algo);
    }
  }
  return HASH_ALGOS.filter((algo) => need.has(algo));
}
