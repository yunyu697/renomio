/**
 * 命名方案库与最近记录。
 *
 * 方案只保存规则链（不含路径），与「保存方案 JSON」同源；最近记录保存方案与目录，
 * 各最多 10 条，写入 WebView 的 localStorage，关掉重开后仍在。
 */

import type { Rule } from './types';
import { normalizeRules } from './rules';

export const SAVED_PLANS_KEY = 'renomio.saved-plans';
export const RECENT_ITEMS_KEY = 'renomio.recent-items';
export const RECENT_LIMIT = 10;

export interface SavedPlan {
  id: string;
  name: string;
  rules: Rule[];
  savedAt: number;
}

export type RecentItem =
  | { kind: 'plan'; id: string; name: string; rules: Rule[]; at: number }
  | { kind: 'dir'; id: string; path: string; at: number };

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存储不可用时只影响记忆功能，不影响当前会话
  }
}

function normalizePlan(raw: unknown): SavedPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Partial<SavedPlan>;
  const name = typeof source.name === 'string' ? source.name.trim() : '';
  if (!name || !Array.isArray(source.rules)) return null;
  const rules = normalizeRules(source.rules as Rule[]);
  if (!rules.length) return null;
  return {
    id: typeof source.id === 'string' && source.id ? source.id : newId(),
    name,
    rules,
    savedAt: typeof source.savedAt === 'number' ? source.savedAt : Date.now(),
  };
}

export function loadSavedPlans(): SavedPlan[] {
  const raw = readJson(SAVED_PLANS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizePlan)
    .filter((item): item is SavedPlan => item !== null)
    .sort((a, b) => b.savedAt - a.savedAt);
}

/** 同名方案直接覆盖（按名称去重），返回最新列表。 */
export function savePlan(name: string, rules: Rule[]): SavedPlan[] {
  const trimmed = name.trim();
  const normalized = normalizeRules(rules);
  if (!trimmed || !normalized.length) return loadSavedPlans();
  const list = loadSavedPlans().filter((item) => item.name !== trimmed);
  list.unshift({ id: newId(), name: trimmed, rules: normalized, savedAt: Date.now() });
  writeJson(SAVED_PLANS_KEY, list);
  return list;
}

export function deletePlan(id: string): SavedPlan[] {
  const list = loadSavedPlans().filter((item) => item.id !== id);
  writeJson(SAVED_PLANS_KEY, list);
  return list;
}

function normalizeRecent(raw: unknown): RecentItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const at = typeof source.at === 'number' ? source.at : Date.now();
  if (source.kind === 'dir') {
    const path = typeof source.path === 'string' ? source.path : '';
    if (!path) return null;
    return { kind: 'dir', id: `dir:${path}`, path, at };
  }
  if (source.kind === 'plan') {
    const name = typeof source.name === 'string' ? source.name.trim() : '';
    if (!name || !Array.isArray(source.rules)) return null;
    const rules = normalizeRules(source.rules as Rule[]);
    if (!rules.length) return null;
    return { kind: 'plan', id: `plan:${name}`, name, rules, at };
  }
  return null;
}

export function loadRecentItems(): RecentItem[] {
  const raw = readJson(RECENT_ITEMS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeRecent)
    .filter((item): item is RecentItem => item !== null)
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENT_LIMIT);
}

function storeRecent(items: RecentItem[]): RecentItem[] {
  const kept = items.slice(0, RECENT_LIMIT);
  writeJson(RECENT_ITEMS_KEY, kept);
  return kept;
}

export function pushRecentPlan(name: string, rules: Rule[]): RecentItem[] {
  const trimmed = name.trim();
  const normalized = normalizeRules(rules);
  if (!trimmed || !normalized.length) return loadRecentItems();
  const rest = loadRecentItems().filter((item) => item.id !== `plan:${trimmed}`);
  return storeRecent([{ kind: 'plan', id: `plan:${trimmed}`, name: trimmed, rules: normalized, at: Date.now() }, ...rest]);
}

export function pushRecentDir(path: string): RecentItem[] {
  if (!path) return loadRecentItems();
  const rest = loadRecentItems().filter((item) => item.id !== `dir:${path}`);
  return storeRecent([{ kind: 'dir', id: `dir:${path}`, path, at: Date.now() }, ...rest]);
}

export function removeRecentItem(id: string): RecentItem[] {
  return storeRecent(loadRecentItems().filter((item) => item.id !== id));
}
