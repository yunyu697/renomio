/**
 * 设置文件的导入/导出（`.ini`）。
 *
 * 职责边界：文本语法（分节、下标、引号、行号错误）全在 Rust `renomio_core::ini` 一侧，
 * 这里只做三件事——拼导出载荷、调命令、导入后按默认设置的形状做类型白名单。
 * 白名单很重要：用户在文本编辑器里改出来的东西可能是任意形状，直接 `updateSettings`
 * 会把界面拖进不一致状态（比如 rules 里少字段、columns 多一堆假列）。
 */
import { isDesktop, openTextFile, saveTextFile, settingsFromIni, settingsToIni } from './bridge';
import type { SaveTextResult } from './bridge';
import { DEFAULT_SETTINGS } from '../runtime';
import type { AppSettings } from './types';

/** 导出文件的标识：导入时用来区分「Renomio 设置文件」和随便一个 ini。 */
export const SETTINGS_FORMAT = 'renomio-settings';

export interface SettingsFilePayload {
  meta: { format: string; exportedAt: string };
  settings: AppSettings;
}

export interface SettingsImportResult {
  canceled?: boolean;
  error?: string;
  /** 通过白名单校验、可以写进设置的部分 */
  patch?: Partial<AppSettings>;
  appliedKeys?: string[];
  /** 被丢弃的键（类型不符、未知键、坏规则条目），用于给用户看得懂的提示 */
  ignoredKeys?: string[];
  path?: string;
}

/** 组装导出载荷：包一层 meta，导入时能认出这是本产品的设置文件。 */
export function buildSettingsPayload(settings: AppSettings, now = new Date()): SettingsFilePayload {
  return {
    meta: { format: SETTINGS_FORMAT, exportedAt: now.toISOString() },
    settings,
  };
}

export function settingsFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `renomio-settings-${stamp}.ini`;
}

/** 导出：先由 core 编成 INI 文本，再走「临时文件 + fsync + 两阶段改名」落盘。 */
export async function exportSettingsFile(settings: AppSettings): Promise<SaveTextResult> {
  if (!isDesktop) return { ok: false, error: '浏览器演示模式不支持导出设置文件' };
  try {
    const text = await settingsToIni(JSON.stringify(buildSettingsPayload(settings)));
    return await saveTextFile(settingsFileName(), text, [{ name: 'INI', extensions: ['ini'] }]);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 导入：选文件 → 读文本 → core 解析 → 白名单校验；任何一步失败都只返回错误，不动设置。 */
export async function importSettingsFile(): Promise<SettingsImportResult> {
  if (!isDesktop) return { error: '浏览器演示模式不支持导入设置文件' };
  const picked = await openTextFile([{ name: 'INI', extensions: ['ini'] }]);
  if (picked.canceled) return { canceled: true };
  if (picked.error) return { error: picked.error, path: picked.path };
  try {
    const json = await settingsFromIni(picked.text ?? '');
    const parsed: unknown = JSON.parse(json);
    const checked = validateImportedSettings(parsed);
    return { ...checked, path: picked.path };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), path: picked.path };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameKind(template: unknown, value: unknown): boolean {
  if (Array.isArray(template)) return Array.isArray(value);
  if (isPlainObject(template)) return isPlainObject(value);
  if (typeof template === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof template === typeof value;
}

/** 规则条目至少要满足界面能渲染的最低形状，否则丢弃并计数。 */
function isUsableRule(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return typeof value.id === 'string' && typeof value.type === 'string' && typeof value.enabled === 'boolean';
}

function sanitizeRules(value: unknown): { rules: unknown[]; dropped: number } {
  if (!Array.isArray(value)) return { rules: [], dropped: 0 };
  const rules: unknown[] = [];
  let dropped = 0;
  for (const item of value) {
    if (isUsableRule(item)) rules.push(item);
    else dropped += 1;
  }
  return { rules, dropped };
}

/** 快捷键表：值必须是字符串，坏的键丢掉（宁可少一条也不能写进非法绑定）。 */
function sanitizeShortcuts(value: unknown): { shortcuts: Record<string, string>; dropped: number } {
  if (!isPlainObject(value)) return { shortcuts: {}, dropped: 0 };
  const shortcuts: Record<string, string> = {};
  let dropped = 0;
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string') shortcuts[key] = val;
    else dropped += 1;
  }
  return { shortcuts, dropped };
}

/**
 * 按 `DEFAULT_SETTINGS` 的形状做白名单：键必须已知、类型必须同名同形。
 * 只返回能安全合并的部分；不认识的键和被丢掉的坏条目都记进 `ignoredKeys` 供提示。
 */
export function validateImportedSettings(raw: unknown): { patch: Partial<AppSettings>; appliedKeys: string[]; ignoredKeys: string[] } {
  const envelope = isPlainObject(raw) && isPlainObject(raw.settings) ? raw.settings : raw;
  const patch: Partial<AppSettings> = {};
  const appliedKeys: string[] = [];
  const ignoredKeys: string[] = [];

  if (!isPlainObject(envelope)) {
    return { patch, appliedKeys, ignoredKeys: ['*'] };
  }

  for (const [key, value] of Object.entries(envelope)) {
    const template = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key];
    if (template === undefined) {
      ignoredKeys.push(`${key}（未知键）`);
      continue;
    }
    if (!sameKind(template, value)) {
      ignoredKeys.push(`${key}（类型不符）`);
      continue;
    }
    if (key === 'rules') {
      const { rules, dropped } = sanitizeRules(value);
      if (dropped > 0) ignoredKeys.push(`rules（丢弃 ${dropped} 条不完整规则）`);
      patch.rules = rules as AppSettings['rules'];
      appliedKeys.push(key);
      continue;
    }
    if (key === 'shortcuts') {
      const { shortcuts, dropped } = sanitizeShortcuts(value);
      if (dropped > 0) ignoredKeys.push(`shortcuts（丢弃 ${dropped} 条非文本绑定）`);
      patch.shortcuts = shortcuts as AppSettings['shortcuts'];
      appliedKeys.push(key);
      continue;
    }
    (patch as Record<string, unknown>)[key] = value;
    appliedKeys.push(key);
  }

  return { patch, appliedKeys, ignoredKeys };
}
