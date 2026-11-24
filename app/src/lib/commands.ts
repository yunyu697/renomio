/**
 * 命令列表：把「规则链 + 冲突策略」存成一条可复用的批量作业。
 *
 * 与方案库（`plans.ts`，只存规则链、无执行策略、无运行记录）的区别：
 * - 命令额外记住当时的冲突策略，一键运行时不必再选一次；
 * - 记录运行次数与上次运行时间，列表按「最近使用」排序，常用命令自然浮到顶部；
 * - 最多保留 `COMMAND_LIMIT` 条，超出的按最久未用淘汰。
 * 数据只落 localStorage（`renomio.commands`），关掉重开后仍在。
 */

import type { ConflictPolicy, Rule } from './types';
import { normalizeRules } from './rules';

export const COMMANDS_KEY = 'renomio.commands';
export const COMMAND_LIMIT = 30;

export interface SavedCommand {
  id: string;
  name: string;
  rules: Rule[];
  policy: ConflictPolicy;
  createdAt: number;
  /** 上次运行时间；从未运行为 0 */
  lastRunAt: number;
  runs: number;
}

const POLICIES: ConflictPolicy[] = ['skip', 'suffix', 'overwrite'];

function newId(): string {
  return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readJson(): unknown {
  try {
    const raw = localStorage.getItem(COMMANDS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(list: SavedCommand[]): SavedCommand[] {
  try {
    localStorage.setItem(COMMANDS_KEY, JSON.stringify(list));
  } catch {
    // 存储不可用时只影响记忆，不影响当前会话
  }
  return list;
}

function normalize(raw: unknown): SavedCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Partial<SavedCommand>;
  const name = typeof source.name === 'string' ? source.name.trim() : '';
  if (!name || !Array.isArray(source.rules)) return null;
  const rules = normalizeRules(source.rules as Rule[]);
  if (!rules.length) return null;
  const policy = POLICIES.includes(source.policy as ConflictPolicy) ? (source.policy as ConflictPolicy) : 'skip';
  return {
    id: typeof source.id === 'string' && source.id ? source.id : newId(),
    name,
    rules,
    policy,
    createdAt: typeof source.createdAt === 'number' ? source.createdAt : Date.now(),
    lastRunAt: typeof source.lastRunAt === 'number' ? source.lastRunAt : 0,
    runs: typeof source.runs === 'number' && source.runs >= 0 ? Math.trunc(source.runs) : 0,
  };
}

/** 最近使用的在前；都没跑过的按创建时间倒序。 */
export function sortCommands(list: SavedCommand[]): SavedCommand[] {
  return [...list].sort((a, b) => (b.lastRunAt || b.createdAt) - (a.lastRunAt || a.createdAt));
}

export function loadCommands(): SavedCommand[] {
  const raw = readJson();
  if (!Array.isArray(raw)) return [];
  const list = raw
    .map(normalize)
    .filter((item): item is SavedCommand => item !== null);
  return sortCommands(list).slice(0, COMMAND_LIMIT);
}

/** 同名命令覆盖（保留原运行次数），返回最新列表。 */
export function saveCommand(name: string, rules: Rule[], policy: ConflictPolicy): SavedCommand[] {
  const trimmed = name.trim();
  const normalized = normalizeRules(rules);
  if (!trimmed || !normalized.length) return loadCommands();
  const previous = loadCommands();
  const existing = previous.find((item) => item.name === trimmed);
  const rest = previous.filter((item) => item.name !== trimmed);
  const entry: SavedCommand = existing
    ? { ...existing, rules: normalized, policy }
    : { id: newId(), name: trimmed, rules: normalized, policy, createdAt: Date.now(), lastRunAt: 0, runs: 0 };
  return writeJson(sortCommands([entry, ...rest]).slice(0, COMMAND_LIMIT));
}

export function deleteCommand(id: string): SavedCommand[] {
  return writeJson(loadCommands().filter((item) => item.id !== id));
}

/** 记一次运行：次数 +1、更新最近运行时间，并把该条提到最前。 */
export function touchCommand(id: string): SavedCommand[] {
  const list = loadCommands();
  const hit = list.find((item) => item.id === id);
  if (!hit) return list;
  const updated: SavedCommand = { ...hit, runs: hit.runs + 1, lastRunAt: Date.now() };
  return writeJson([updated, ...list.filter((item) => item.id !== id)].slice(0, COMMAND_LIMIT));
}
