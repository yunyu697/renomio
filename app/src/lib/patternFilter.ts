/**
 * 「执行筛选」的纯逻辑层：把保留/排除通配符作用到当前列表。
 *
 * 设计约束：
 * - 只做内存过滤，绝不碰磁盘；调用方负责把 kept 写回列表并给 toast。
 * - 空结果不落地：一个都没匹配上时返回 no-match，列表原样保留——避免一次点击把列表清空。
 * - 没有填任何通配符时返回 no-pattern，不当作「全部保留」。
 */
import { matchesAny, splitPatterns } from './glob';

export type FilterOutcome<T> =
  | { status: 'no-pattern' }
  | { status: 'no-match'; total: number }
  | { status: 'applied'; kept: T[]; removed: number; total: number };

export function applyPatternFilter<T>(
  items: T[],
  include: string,
  exclude: string,
  caseInsensitive: boolean,
  pathOf: (item: T) => string,
): FilterOutcome<T> {
  const inc = splitPatterns(include);
  const exc = splitPatterns(exclude);
  if (!inc.length && !exc.length) return { status: 'no-pattern' };
  const kept = items.filter((item) => {
    const path = pathOf(item);
    if (inc.length && !matchesAny(inc, path, caseInsensitive)) return false;
    if (exc.length && matchesAny(exc, path, caseInsensitive)) return false;
    return true;
  });
  if (items.length > 0 && kept.length === 0) return { status: 'no-match', total: items.length };
  return { status: 'applied', kept, removed: items.length - kept.length, total: items.length };
}
