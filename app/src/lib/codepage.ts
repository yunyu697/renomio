/** 中文内码规则：GBK / Big5 两条路径的「内码还原」与「简繁用字转换」。
 *
 * 文件名在磁盘上一律以 Unicode 交给应用，所以这里的「内码」不是字节平移，而是两件事：
 * 1) 还原：文件名曾被错误地按 GBK 解码（UTF-8 中文变成「涓枃」这类乱码），
 *    把当前字符串按 GBK 重新编码回原始字节，再严格按 UTF-8 解码；只有整串可逆才改写。
 * 2) 用字：简体 ↔ 繁体（台湾正体，Big5 用字）互转，走 OpenCC 词典，不是逐码位映射。
 *
 * 两者都只作用于文件名主干；扩展名由 ext 规则负责。
 */

import iconv from 'iconv-lite';
import * as CN2T from 'opencc-js/cn2t';
import * as T2CN from 'opencc-js/t2cn';

export const CODEPAGE_MODES = ['gbk-fix', 'to-big5', 'to-gbk'] as const;
export type CodepageMode = (typeof CODEPAGE_MODES)[number];

export function isCodepageMode(value: unknown): value is CodepageMode {
  return typeof value === 'string' && (CODEPAGE_MODES as readonly string[]).includes(value);
}

let s2t: ((text: string) => string) | null = null;
let t2s: ((text: string) => string) | null = null;

function simplifiedToTraditional(text: string): string {
  if (!s2t) {
    const converter = CN2T.Converter({ from: 'cn', to: 'tw' });
    s2t = (value: string) => converter(value);
  }
  return s2t(text);
}

function traditionalToSimplified(text: string): string {
  if (!t2s) {
    const converter = T2CN.Converter({ from: 'tw', to: 'cn' });
    t2s = (value: string) => converter(value);
  }
  return t2s(text);
}

/** GBK 误解码还原：整串必须先能无损编码回 GBK，解码出的 UTF-8 才可信。 */
export function repairGbkMojibake(text: string): string {
  if (!text) return text;
  let bytes: ReturnType<typeof iconv.encode>;
  try {
    bytes = iconv.encode(text, 'gbk');
  } catch {
    return text;
  }
  // 含 GBK 表示不了的字符（emoji、生僻字）时 encode 会丢字符，这种串不是「被 GBK 误解的 UTF-8」
  if (iconv.decode(bytes, 'gbk') !== text) return text;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return text;
  }
}

/** 按 Big5 用字把简体转成台湾正体；字符集外的字符（emoji 等）原样保留。 */
export function toBig5Wording(text: string): string {
  if (!text) return text;
  try {
    return simplifiedToTraditional(text);
  } catch {
    return text;
  }
}

/** 按 GBK 用字把台湾正体转回简体；字符集外的字符原样保留。 */
export function toGbkWording(text: string): string {
  if (!text) return text;
  try {
    return traditionalToSimplified(text);
  } catch {
    return text;
  }
}

export function applyCodepage(text: string, mode: CodepageMode): string {
  switch (mode) {
    case 'gbk-fix':
      return repairGbkMojibake(text);
    case 'to-big5':
      return toBig5Wording(text);
    case 'to-gbk':
      return toGbkWording(text);
    default:
      return text;
  }
}
