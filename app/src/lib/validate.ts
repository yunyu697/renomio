import { t } from '../i18n';
import type { EnvInfo } from './types';

const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL', 'CLOCK$',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

const WINDOWS_INVALID = new Set(['<', '>', ':', '"', '|', '?', '*', '/', '\\']);

/** 把 Windows 非法字符/控制字符替换为指定字符（替换规则可配置，预览与执行共用）。 */
export function sanitizeInvalid(name: string, replacement: string): string {
  const r = replacement || '_';
  let out = '';
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    out += WINDOWS_INVALID.has(ch) || code < 0x20 || code === 0x7f ? r : ch;
  }
  return out;
}

export interface NameCheck {
  block: string[];
  warn: string[];
}

export function normalizePath(path: string, env: EnvInfo): string {
  const unified = path.replace(/[\\/]/g, env.separator).normalize('NFC');
  return env.caseSensitive ? unified : unified.toLowerCase();
}

export function isReservedWindowsName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return WINDOWS_RESERVED.has(stem.trim().toUpperCase());
}

/** 校验单个名称；strict = Windows 安全字符集（跨平台方案默认开启） */
export function validateName(name: string, env: EnvInfo, strict: boolean): NameCheck {
  const block: string[] = [];
  const warn: string[] = [];

  if (!name) {
    block.push(t('v.empty'));
    return { block, warn };
  }
  if (name === '.' || name === '..') block.push(t('v.dot'));

  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      block.push(t('v.control', { code: `U+${code.toString(16).toUpperCase().padStart(4, '0')}` }));
      break;
    }
  }

  if (strict || env.os === 'windows') {
    const bad = Array.from(name).find((c) => WINDOWS_INVALID.has(c));
    if (bad) block.push(t('v.invalidChar', { char: bad }));
    if (name.endsWith(' ') || name.endsWith('.')) block.push(t('v.trailing'));
    if (isReservedWindowsName(name)) block.push(t('v.reserved'));
  } else if (name.includes('/')) {
    block.push(t('v.separator'));
  }

  if (env.os === 'linux') {
    const bytes = new TextEncoder().encode(name).length;
    if (bytes > env.componentLimit) block.push(t('v.byteLimit', { bytes, limit: env.componentLimit }));
  } else if (name.length > env.componentLimit) {
    block.push(t('v.charLimit', { length: name.length, limit: env.componentLimit }));
  }

  return { block, warn };
}

export function pathLengthCheck(parent: string, name: string, env: EnvInfo): NameCheck {
  const full = `${parent}${parent.endsWith(env.separator) ? '' : env.separator}${name}`;
  const length = env.os === 'linux' ? new TextEncoder().encode(full).length : full.length;
  if (length > env.pathHardLimit) {
    return { block: [t('v.pathHard', { length, limit: env.pathHardLimit })], warn: [] };
  }
  if (length > env.pathWarnThreshold) {
    return { block: [], warn: [t('v.pathWarn', { length })] };
  }
  return { block: [], warn: [] };
}

export function targetPath(parent: string, name: string, env: EnvInfo): string {
  return `${parent}${parent.endsWith(env.separator) ? '' : env.separator}${name}`;
}
