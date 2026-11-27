/**
 * 3.13「编码转换」规则：把文件名主干的编码形态整形成想要的样子。
 *
 * 七种模式分三类：
 * - Unicode 规范化：nfc / nfd / nfkc / nfkd（nfd 用来对付 macOS 上传的分解式文件名）
 * - 字符宽度：half（全角 → 半角）/ full（半角 → 全角），只碰 ASCII 与全角空格
 * - 乱码修复：mojibake，还原「UTF-8 字节被按 Latin-1 / CP1252 解码」的串
 *
 * 全部是同步纯函数：预览、e2e、真实改名三个阶段算出来的结果必须一致。
 */

export type EncodingMode = 'nfc' | 'nfd' | 'nfkc' | 'nfkd' | 'half' | 'full' | 'mojibake';

export const ENCODING_MODES: EncodingMode[] = ['nfc', 'nfd', 'nfkc', 'nfkd', 'half', 'full', 'mojibake'];

export function isEncodingMode(value: unknown): value is EncodingMode {
  return typeof value === 'string' && (ENCODING_MODES as string[]).includes(value);
}

/** CP1252 在 0x80–0x9F 区间的可打印字符 → 原始字节（0x81/0x8D/0x8F/0x90/0x9D 无定义）。 */
const CP1252_TO_BYTE: Record<number, number> = {
  0x20ac: 0x80, // €
  0x201a: 0x82, // ‚
  0x0192: 0x83, // ƒ
  0x201e: 0x84, // „
  0x2026: 0x85, // …
  0x2020: 0x86, // †
  0x2021: 0x87, // ‡
  0x02c6: 0x88, // ˆ
  0x2030: 0x89, // ‰
  0x0160: 0x8a, // Š
  0x2039: 0x8b, // ‹
  0x0152: 0x8c, // Œ
  0x017d: 0x8e, // Ž
  0x2018: 0x91, // ‘
  0x2019: 0x92, // ’
  0x201c: 0x93, // “
  0x201d: 0x94, // ”
  0x2022: 0x95, // •
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x02dc: 0x98, // ˜
  0x2122: 0x99, // ™
  0x0161: 0x9a, // š
  0x203a: 0x9b, // ›
  0x0153: 0x9c, // œ
  0x017e: 0x9e, // ž
  0x0178: 0x9f, // Ÿ
};

const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * 还原「UTF-8 字节被按 Latin-1 / CP1252 解码」的乱码：
 * 「cafÃ©」→「café」、「æ–‡ä»¶」→「文件」。
 *
 * 判断依据是字节能不能被严格 UTF-8 解回来：解不动（真正的重音字符、中文、
 * 日文假名等）就原样返回，绝不猜。所以这个模式对正常文件名是恒等变换。
 */
export function repairMojibake(text: string): string {
  if (!text) return text;
  const bytes: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) {
      bytes.push(cp);
      continue;
    }
    const mapped = CP1252_TO_BYTE[cp];
    if (mapped === undefined) return text; // 含非 Latin-1 字符，不可能是这类乱码
    bytes.push(mapped);
  }
  // 全是 ASCII：本来就没被解坏，原样返回（也避免把纯 ASCII 名改出差异）
  if (bytes.every((b) => b < 0x80)) return text;
  try {
    return decoder.decode(new Uint8Array(bytes));
  } catch {
    return text;
  }
}

/** 全角 → 半角：全角空格转普通空格，U+FF01–U+FF5E 转对应 ASCII；中文标点与假名原样保留。 */
export function toHalfWidth(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x3000) out += ' ';
    else if (cp >= 0xff01 && cp <= 0xff5e) out += String.fromCharCode(cp - 0xfee0);
    else out += ch;
  }
  return out;
}

/** 半角 → 全角：普通空格转全角空格，U+0021–U+007E 转对应全角。 */
export function toFullWidth(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x20) out += '\u3000';
    else if (cp >= 0x21 && cp <= 0x7e) out += String.fromCharCode(cp + 0xfee0);
    else out += ch;
  }
  return out;
}

/** 按模式整形一段文本；未知模式原样返回（规则校验层已拦住非法值）。 */
export function applyEncoding(text: string, mode: EncodingMode): string {
  switch (mode) {
    case 'nfc':
      return text.normalize('NFC');
    case 'nfd':
      return text.normalize('NFD');
    case 'nfkc':
      return text.normalize('NFKC');
    case 'nfkd':
      return text.normalize('NFKD');
    case 'half':
      return toHalfWidth(text);
    case 'full':
      return toFullWidth(text);
    case 'mojibake':
      return repairMojibake(text);
    default:
      return text;
  }
}
