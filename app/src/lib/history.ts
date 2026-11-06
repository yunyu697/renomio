/**
 * 规则链输入历史（按字段分开保存）。
 *
 * 规则：空白值不记录；相同内容再次输入时提到最前而不是堆叠；超过上限淘汰最旧。
 * 上限默认 50，可在设置里改为 10–200；调小后每个字段只保留最新的 N 条。
 */

export const HISTORY_VERSION = 1;
export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MIN_LIMIT = 10;
export const HISTORY_MAX_LIMIT = 200;

export interface RuleHistory {
  version: number;
  limit: number;
  fields: Record<string, string[]>;
}

export function emptyHistory(): RuleHistory {
  return { version: HISTORY_VERSION, limit: HISTORY_DEFAULT_LIMIT, fields: {} };
}

export function clampHistoryLimit(value: number): number {
  if (!Number.isFinite(value)) return HISTORY_DEFAULT_LIMIT;
  return Math.min(HISTORY_MAX_LIMIT, Math.max(HISTORY_MIN_LIMIT, Math.round(value)));
}

export function truncateHistory(list: string[], limit: number): string[] {
  const cap = clampHistoryLimit(limit);
  return list.length > cap ? list.slice(0, cap) : list;
}

/** 记录一条输入：去重提到最前，超限淘汰最旧，空白值忽略。 */
export function pushHistoryEntry(list: string[], value: string, limit: number): string[] {
  const trimmed = value.trim();
  if (!trimmed) return list;
  return truncateHistory([trimmed, ...list.filter((item) => item !== trimmed)], limit);
}

export function removeHistoryEntry(list: string[], value: string): string[] {
  return list.filter((item) => item !== value);
}

/** 上限改小时：每个字段保留最新的 N 条，超出部分（最旧的）直接淘汰。 */
export function applyHistoryLimit(history: RuleHistory, limit: number): RuleHistory {
  const cap = clampHistoryLimit(limit);
  const fields: Record<string, string[]> = {};
  for (const [key, list] of Object.entries(history.fields)) {
    const kept = truncateHistory(list, cap);
    if (kept.length > 0) fields[key] = kept;
  }
  return { version: HISTORY_VERSION, limit: cap, fields };
}

/** 读回磁盘/演示存储的内容时做一次防御性归一化，坏数据不拖垮界面。 */
export function normalizeHistory(raw: unknown): RuleHistory {
  if (!raw || typeof raw !== 'object') return emptyHistory();
  const source = raw as Partial<RuleHistory>;
  const limit = clampHistoryLimit(Number(source.limit ?? HISTORY_DEFAULT_LIMIT));
  const fields: Record<string, string[]> = {};
  const incoming = source.fields;
  if (incoming && typeof incoming === 'object') {
    for (const [key, value] of Object.entries(incoming)) {
      if (!Array.isArray(value)) continue;
      const seen: string[] = [];
      for (const item of value) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (trimmed && !seen.includes(trimmed)) seen.push(trimmed);
      }
      if (seen.length > 0) fields[key] = truncateHistory(seen, limit);
    }
  }
  return { version: HISTORY_VERSION, limit, fields };
}
