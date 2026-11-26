/**
 * 对照表（3.13「高级规则 · 对照表」）：把用户给的「旧词 → 新词」逐行映射应用到文件名主干。
 *
 * 表格语法（一行一条，`#` 或 `//` 开头是注释、空行忽略）：
 *   旧词=新词          ← 第一个未转义的 `=` 或制表符作分隔
 *   旧词\t新词
 *   旧词=              ← 新词留空 = 删掉命中的片段
 *   \=                 ← 键或值里的字面 `=`（`\\` 表示字面反斜杠）
 * 键与值两侧空白会被去掉；要保留首尾空格请用 `\s`（写成 `\s` 表示空格）。
 *
 * 应用语义：从左到右**单遍**扫描，每个位置取「最长键」命中（同长度取表里靠前的一条），
 * 替换进去的文本不会被再次扫描——所以 `A=B`、`B=C` 不会连锁成 `A=C`，也不会死循环。
 */
export interface MapEntry {
  key: string;
  value: string;
  /** 在原表格里的行号（1 起），便于报错定位 */
  line: number;
}

export type MapErrorCode = 'no-separator' | 'empty-key' | 'dup-key' | 'too-many';

export interface MapParseError {
  code: MapErrorCode;
  line: number;
  /** 出问题的原文（截断到 60 字，仅供界面展示） */
  text: string;
}

export interface MapTable {
  entries: MapEntry[];
  errors: MapParseError[];
}

/** 错误码 → 文案键（引擎与编辑器共用一张表，避免两处漂移） */
export function mapErrorKey(code: MapErrorCode): string {
  return {
    'no-separator': 'ruleErr.mapNoSeparator',
    'empty-key': 'ruleErr.mapEmptyKey',
    'dup-key': 'ruleErr.mapDupKey',
    'too-many': 'ruleErr.mapTooMany',
  }[code];
}

/** 一张表最多 500 条；超过就停下并报 too-many（键最长 200，防止扫描退化成死循环级开销） */
export const MAP_MAX_ENTRIES = 500;
const KEY_MAX = 200;

/** 去掉包裹式空白，并把 `\s` 还原成空格、`\=` 还原成 `=`、`\\` 还原成 `\` */
function unescapePart(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === 's') {
        out += ' ';
        i += 1;
        continue;
      }
      if (next === '=' || next === '\\') {
        out += next;
        i += 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/** 找分隔符：第一个未转义的 `=` 或制表符（两者谁在前用谁） */
function findSeparator(line: string): { index: number; ch: string } | null {
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '=' || ch === '\t') return { index: i, ch };
  }
  return null;
}

/**
 * 解析对照表。`caseSensitive=false` 时键按小写比较，因此大小写不同的两条键也算重复
 * （与其猜用户想要哪条，不如当场报错让他合并）。
 */
export function parseMapTable(text: string, caseSensitive: boolean): MapTable {
  const entries: MapEntry[] = [];
  const errors: MapParseError[] = [];
  const seen = new Map<string, number>();
  const lines = text.split(/\r\n|\n|\r/);

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const lineNo = i + 1;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    const sep = findSeparator(trimmed);
    const clip = (s: string) => s.slice(0, 60);
    if (!sep) {
      errors.push({ code: 'no-separator', line: lineNo, text: clip(trimmed) });
      continue;
    }
    const key = unescapePart(trimmed.slice(0, sep.index).trim());
    const value = unescapePart(trimmed.slice(sep.index + 1).trim());
    if (key === '') {
      errors.push({ code: 'empty-key', line: lineNo, text: clip(trimmed) });
      continue;
    }
    if (key.length > KEY_MAX) {
      errors.push({ code: 'no-separator', line: lineNo, text: clip(trimmed) });
      continue;
    }
    const norm = caseSensitive ? key : key.toLowerCase();
    const prev = seen.get(norm);
    if (prev !== undefined) {
      errors.push({ code: 'dup-key', line: lineNo, text: `${clip(key)}（与第 ${prev} 行重复）` });
      continue;
    }
    if (entries.length >= MAP_MAX_ENTRIES) {
      errors.push({ code: 'too-many', line: lineNo, text: clip(trimmed) });
      break;
    }
    seen.set(norm, lineNo);
    entries.push({ key, value, line: lineNo });
  }

  return { entries, errors };
}

/** 单遍最长匹配替换；表里有错时调用方应先拒绝执行（这里只按 entries 走） */
export function applyMapping(
  text: string,
  entries: MapEntry[],
  caseSensitive: boolean,
): string {
  if (!entries.length || !text) return text;
  // 长键优先；同长度保持表内顺序（sort 是稳定的，但仍显式带 line 兜底）
  const ordered = [...entries].sort((a, b) => b.key.length - a.key.length || a.line - b.line);
  const probe = caseSensitive ? text : text.toLowerCase();
  const keys = ordered.map((e) => (caseSensitive ? e.key : e.key.toLowerCase()));

  let out = '';
  let i = 0;
  while (i < text.length) {
    let hit = -1;
    for (let k = 0; k < ordered.length; k += 1) {
      const key = keys[k];
      if (key.length && probe.startsWith(key, i)) {
        hit = k;
        break;
      }
    }
    if (hit >= 0) {
      out += ordered[hit].value;
      i += keys[hit].length;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

/** 一张表的简短说明，给规则卡片摘要用：`12 条` / `无条目` */
export function mapSummary(table: string, caseSensitive: boolean): string {
  const parsed = parseMapTable(table, caseSensitive);
  return String(parsed.entries.length);
}
