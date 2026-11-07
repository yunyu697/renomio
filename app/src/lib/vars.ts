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
 * - `<USER1>`–`<USER9>` 用户自定义文本（未设置为空串）
 * - `<#>` 序号，仅在「编号」规则的表达式里有效
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
  /** 仅编号规则的表达式会传入 */
  counter?: string;
}

export interface TemplateScan {
  /** 未知变量名（不含尖括号）；为空表示全部可识别 */
  unknown: string;
  /** 参数不合法时的变量名 */
  badArgs: string;
  /** 使用了 `<#>` */
  counter: boolean;
  /** 需要的哈希算法（去重、仅返回实际引用到的） */
  hashes: HashAlgo[];
  /** 引用了 USERn */
  users: number[];
}

const BASE_NAMES = new Set([
  'FILENAME', 'NAME', 'EXT', 'DOTEXT', 'SUBSTR', 'DIFNSUBSTR', 'DIR', 'DATE', 'TIME', 'SIZE', 'CRC32', 'MD5', 'SHA1',
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

/** 扫描模板：找未知变量、非法参数与依赖项。不会修改文本。 */
export function scanTemplate(text: string): TemplateScan {
  const scan: TemplateScan = { unknown: '', badArgs: '', counter: false, hashes: [], users: [] };
  const re = /<([^<>]+)>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const inner = match[1];
    if (inner === '#') {
      scan.counter = true;
      continue;
    }
    const sep = inner.indexOf(':');
    const rawName = sep < 0 ? inner : inner.slice(0, sep);
    const args = sep < 0 ? [] : inner.slice(sep + 1).split(':');
    const name = rawName.toUpperCase();
    if (!BASE_NAMES.has(name)) {
      if (!scan.unknown) scan.unknown = rawName;
      continue;
    }
    if (!validArgs(name, args)) {
      if (!scan.badArgs) scan.badArgs = rawName;
      continue;
    }
    if (name === 'CRC32') { if (!scan.hashes.includes('crc32')) scan.hashes.push('crc32'); }
    if (name === 'MD5') { if (!scan.hashes.includes('md5')) scan.hashes.push('md5'); }
    if (name === 'SHA1') { if (!scan.hashes.includes('sha1')) scan.hashes.push('sha1'); }
    if (isUser(name)) {
      const index = Number(name.slice(4));
      if (!scan.users.includes(index)) scan.users.push(index);
    }
  }
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

/** 展开模板；调用前应先用 scanTemplate 校验。未知变量按空串展开（预览会拦截应用）。 */
export function expandTemplate(text: string, ctx: VarContext): string {
  return text.replace(/<([^<>]+)>/g, (whole, inner: string) => {
    if (inner === '#') return ctx.counter ?? '';
    const sep = inner.indexOf(':');
    const rawName = sep < 0 ? inner : inner.slice(0, sep);
    const args = sep < 0 ? [] : inner.slice(sep + 1).split(':');
    const name = rawName.toUpperCase();
    if (!BASE_NAMES.has(name) || !validArgs(name, args)) return whole;
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
      default: {
        const index = Number(name.slice(4));
        return ctx.users[index - 1] ?? '';
      }
    }
  });
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
