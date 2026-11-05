/** 规则引擎：纯函数，输入原名 + 规则链，输出新名。所有语义在 README 中固化说明。 */
import { t } from '../i18n';
import type {
  AddRule, CaseRule, DeleteRule, ExtRule, MetaFields, MoveRule, NumberRule, ReplaceRule, Rule,
} from './types';

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

/** 规则配置是否可用；返回本地化错误说明 */
export function ruleError(rule: Rule): string | null {
  switch (rule.type) {
    case 'add':
      if (rule.mode === 'direct' && rule.text === '') return t('ruleErr.emptyInsert');
      if (rule.mode === 'pad' && (rule.padTo < 1 || rule.padTo > 255)) return t('ruleErr.padRange');
      if (rule.anchor === 'at' && (rule.position < 1 || rule.position > 255)) return t('ruleErr.positionRange');
      return null;
    case 'replace':
      if (rule.find === '') return t('ruleErr.emptyFind');
      if (rule.regex) {
        try {
          new RegExp(rule.find);
        } catch {
          return t('ruleErr.badRegex');
        }
      }
      if (rule.nth < 0) return t('ruleErr.negativeNth');
      return null;
    case 'delete':
      if (rule.mode === 'range' && (rule.from < 1 || rule.count < 1)) return t('ruleErr.rangePositive');
      if (rule.mode === 'charset' && rule.chars === '') return t('ruleErr.emptyCharset');
      return null;
    case 'number':
      if (!rule.expression.includes('<#>')) return t('ruleErr.needPlaceholder');
      if (rule.digits < 1 || rule.digits > 12) return t('ruleErr.digitsRange');
      if (rule.step < 1) return t('ruleErr.stepPositive');
      return null;
    case 'move':
      if (rule.from < 1 || rule.count < 1) return t('ruleErr.rangePositive');
      return null;
    case 'case':
      return null;
    case 'ext':
      if ((rule.mode === 'replace' || rule.mode === 'fixed') && rule.value.trim() === '') return t('ruleErr.emptyExt');
      if (rule.mode === 'number' && (rule.value === '' || Number.isNaN(Number(rule.value)))) return t('ruleErr.badExtStep');
      return null;
    case 'meta':
      return null;
    default:
      return null;
  }
}

function applyAdd(stem: string, rule: AddRule): string {
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
  chars.splice(index, 0, ...toChars(rule.text));
  return fromChars(chars);
}

function applyReplace(stem: string, rule: ReplaceRule): string {
  if (!rule.find) return stem;
  const source = rule.regex ? rule.find : regexEscape(rule.find);
  const flags = `g${rule.caseSensitive ? '' : 'i'}`;
  let re: RegExp;
  try {
    re = new RegExp(source, flags);
  } catch {
    return stem;
  }
  if (rule.nth === 0) return stem.replace(re, rule.replace);
  let count = 0;
  return stem.replace(re, (match) => {
    count += 1;
    return count === rule.nth ? rule.replace : match;
  });
}

function applyDelete(stem: string, rule: DeleteRule): string {
  const chars = toChars(stem);
  if (rule.mode === 'trim') return stem.trim();
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
      start = at + (rule.includeLeft ? 0 : left.length);
    }
    let end = chars.length;
    if (right) {
      const at = stem.indexOf(right, start);
      if (at < 0) return stem;
      end = at + (rule.includeRight ? right.length : 0);
    }
    if (start >= end) return stem;
    return fromChars([...chars.slice(0, start), ...chars.slice(end)]);
  }
  let start = rule.fromEnd ? chars.length - (rule.from + rule.count - 1) : rule.from - 1;
  start = clamp(start, 0, chars.length);
  const end = clamp(start + rule.count, 0, chars.length);
  return fromChars([...chars.slice(0, start), ...chars.slice(end)]);
}

function applyMove(stem: string, rule: MoveRule): string {
  const chars = toChars(stem);
  let start = rule.fromEnd ? chars.length - rule.from : rule.from - 1;
  start = clamp(start, 0, chars.length);
  const end = clamp(start + rule.count, 0, chars.length);
  if (end <= start) return stem;
  const block = chars.splice(start, end - start);
  let target = rule.toEnd ? chars.length - (rule.to - 1) : rule.to - 1;
  target = clamp(target, 0, chars.length);
  chars.splice(target, 0, ...block);
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

function applyCase(stem: string, rule: CaseRule): string {
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
function applyTitle(stem: string, rule: CaseRule): string {
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

export interface NumberContext {
  /** 计数键（规则 + 目录） */
  key: string;
  counter: number;
  increment: boolean;
}

function formatNumber(value: number, digits: number, padChar: string): string {
  const raw = String(Math.max(0, Math.trunc(value)));
  const pad = padChar || '0';
  return raw.length >= digits ? raw : pad.repeat(digits - raw.length) + raw;
}

function applyNumber(rule: NumberRule, counter: number): string {
  const formatted = formatNumber(counter, rule.digits, rule.padChar);
  return rule.expression.split('<#>').join(formatted);
}

function applyExt(ext: string, rule: ExtRule, counter: number): string {
  const value = rule.value.replace(/^\.+/, '').replace(/\.+$/, '');
  switch (rule.mode) {
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
  /** 下一个编号值（已按规则/目录维护） */
  nextNumber: (rule: NumberRule, parent: string) => number;
  /** 不参与计数时使用的当前值 */
  peekNumber: (rule: NumberRule, parent: string) => number;
  /** 当前文件的只读元数据字段（供「按元数据取名」规则使用；缺失则跳过该规则） */
  meta?: MetaFields;
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

  for (const rule of rules) {
    if (!rule.enabled || ruleError(rule)) continue;
    switch (rule.type) {
      case 'add':
        stem = applyAdd(stem, rule);
        break;
      case 'replace':
        stem = applyReplace(stem, rule);
        break;
      case 'delete':
        stem = applyDelete(stem, rule);
        break;
      case 'number': {
        const value = rule.onlyChecked && !entrySelected
          ? ctx.peekNumber(rule, rule.perFolder ? parent : '')
          : ctx.nextNumber(rule, rule.perFolder ? parent : '');
        stem = applyNumber(rule, value);
        numbers.push(formatNumber(value, rule.digits, rule.padChar));
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
            perFolder: false, onlyChecked: false,
          };
          const value = ctx.nextNumber(probe, '');
          ext = applyExt(ext, rule, value);
        } else {
          ext = applyExt(ext, rule, 1);
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
      default:
        break;
    }
  }
  return { stem, ext, numbers };
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
      if (rule.mode === 'trim') return t('ruleSum.trim');
      if (rule.mode === 'between') return t('ruleSum.between', { left: rule.left, right: rule.right });
      if (rule.mode === 'charset') {
        return t(rule.keep ? 'ruleSum.charsetKeep' : 'ruleSum.charsetDrop', { chars: rule.chars });
      }
      return t('ruleSum.range', { from: rule.from, count: rule.count, reverse: rule.fromEnd ? t('ruleSum.reverse') : '' });
    case 'number':
      return t('ruleSum.number', {
        expr: rule.expression, start: rule.start, step: rule.step, digits: rule.digits,
        perFolder: rule.perFolder ? t('ruleSum.perFolder') : '',
      });
    case 'move':
      return t('ruleSum.move', {
        from: rule.from, count: rule.count, to: rule.to, reverse: rule.fromEnd ? t('ruleSum.reverse') : '',
      });
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
      }[rule.mode];
    case 'meta': {
      const label = {
        taken: t('ruleSum.metaTaken'), camera: t('ruleSum.metaCamera'), title: t('ruleSum.metaTitle'),
        artist: t('ruleSum.metaArtist'), album: t('ruleSum.metaAlbum'), track: t('ruleSum.metaTrack'),
      }[rule.field] ?? rule.field;
      if (rule.mode === 'replace') return t('ruleSum.metaReplace', { label });
      const base = t(rule.mode === 'prefix' ? 'ruleSum.metaPrefix' : 'ruleSum.metaSuffix', {
        label, sep: '',
      });
      return `${base}${rule.separator ? t('ruleSum.metaSep', { sep: rule.separator }) : ''}`;
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
