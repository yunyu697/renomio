/** 归类移动的规则求值：扩展名 / 日期 / 首字母 / 正则捕获组。 */
import { t } from '../i18n';
import { baseName, extName, removeExt } from './format';
import type { Entry, EnvInfo } from './types';
import { normalizePath, targetPath } from './validate';

export type MoveRuleKind = 'ext' | 'date' | 'initial' | 'regex';
export type DateGranularity = 'year' | 'month' | 'day';

export interface MoveConfig {
  kind: MoveRuleKind;
  /** 目标根目录（可以是尚不存在的新目录） */
  root: string;
  /** 在新的根下保持原目录结构 */
  keepStructure: boolean;
  dateGranularity: DateGranularity;
  /** 正则模式（作用于完整文件名） */
  pattern: string;
  /** 捕获组序号；0 = 整个匹配 */
  capture: number;
}

export interface MovePreviewRow {
  entry: Entry;
  subdir: string;
  target: string;
  status: 'ready' | 'unchanged' | 'conflict' | 'invalid';
  reasons: string[];
}

const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

function segments(path: string): string[] {
  return path.replace(/[\\/]+/g, '/').split('/');
}

function commonPrefix(paths: string[]): string {
  if (!paths.length) return '';
  const lists = paths.map(segments);
  const min = Math.min(...lists.map((l) => l.length));
  let i = 0;
  while (i < min && lists.every((l) => l[i] === lists[0][i])) i += 1;
  const sep = paths[0].includes('\\') ? '\\' : '/';
  const prefix = lists[0].slice(0, i).join(sep);
  if (sep === '/' && prefix === '') return '/';
  return prefix;
}

/** 默认目标根：所有勾选项的共同父目录下的「归类结果」。 */
export function defaultMoveRoot(entries: Entry[], env: EnvInfo): string {
  const selected = entries.filter((e) => e.selected && !e.isDir);
  const parents = selected.map((e) => normalizePath(e.parent, env));
  const common = commonPrefix(parents) || (selected[0]?.parent ?? '');
  if (!common) return '';
  return targetPath(common, t('move.defaultRoot'), env);
}

function sanitizeSegment(value: string, fallback: string): string {
  const cleaned = value.replace(INVALID_CHARS, '_').replace(/[. ]+$/g, '').trim();
  return cleaned || fallback;
}

function dateBucket(ms: number, granularity: DateGranularity): string {
  const d = new Date(ms || Date.now());
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = String(d.getFullYear());
  if (granularity === 'year') return year;
  const month = `${year}-${pad(d.getMonth() + 1)}`;
  return granularity === 'month' ? month : `${month}-${pad(d.getDate())}`;
}

function bucketFor(entry: Entry, cfg: MoveConfig): { ok: true; value: string } | { ok: false; reason: string } {
  const name = entry.name;
  switch (cfg.kind) {
    case 'ext': {
      const ext = extName(name);
      return { ok: true, value: ext ? ext.toUpperCase() : t('move.noExt') };
    }
    case 'date':
      return { ok: true, value: dateBucket(entry.modified, cfg.dateGranularity) };
    case 'initial': {
      const stem = removeExt(name);
      const first = Array.from(stem)[0] ?? '#';
      const letter = /[a-zA-Z]/.test(first) ? first.toUpperCase() : /[0-9]/.test(first) ? '0-9' : '#';
      return { ok: true, value: letter };
    }
    case 'regex': {
      if (!cfg.pattern) return { ok: false, reason: t('move.emptyRegex') };
      let re: RegExp;
      try {
        re = new RegExp(cfg.pattern);
      } catch (err) {
        return { ok: false, reason: t('move.badRegex', { message: err instanceof Error ? err.message : String(err) }) };
      }
      const match = re.exec(name);
      if (!match) return { ok: false, reason: t('move.noMatch') };
      const captured = match[cfg.capture];
      if (captured === undefined) return { ok: false, reason: t('move.noGroup', { index: cfg.capture }) };
      if (!captured.trim()) return { ok: false, reason: t('move.emptyGroup', { index: cfg.capture }) };
      return { ok: true, value: captured };
    }
    default:
      return { ok: false, reason: t('move.unknown') };
  }
}

function relativeParent(parent: string, root: string, sep: string): string {
  const norm = (p: string) => p.replace(/[\\/]+/g, sep).replace(/[\\/]+$/g, '');
  const p = norm(parent);
  const r = norm(root);
  if (!r) return '';
  if (p.toLowerCase() === r.toLowerCase()) return '';
  if (p.toLowerCase().startsWith(`${r.toLowerCase()}${sep}`)) return p.slice(r.length + 1);
  return '';
}

export function buildMoveRows(
  entries: Entry[],
  cfg: MoveConfig,
  env: EnvInfo,
  diskExists: Record<string, boolean>,
): MovePreviewRow[] {
  const root = cfg.root.trim().replace(/[\\/]+$/g, '');
  const rows: MovePreviewRow[] = [];
  const seen = new Map<string, number>();

  for (const entry of entries) {
    if (!entry.selected || entry.isDir) continue;
    const bucket = bucketFor(entry, cfg);
    if (!bucket.ok) {
      rows.push({ entry, subdir: '', target: '', status: 'invalid', reasons: [bucket.reason] });
      continue;
    }
    if (!root) {
      rows.push({ entry, subdir: '', target: '', status: 'invalid', reasons: [t('move.needRoot')] });
      continue;
    }
    const subdir = sanitizeSegment(bucket.value, t('move.uncategorized'));
    const rel = cfg.keepStructure ? relativeParent(entry.parent, root, env.separator) : '';
    const dir = [root, rel, subdir].filter((part) => part && part !== '.').join(env.separator);
    const target = targetPath(dir, baseName(entry.path), env);
    const key = normalizePath(target, env);
    const dup = seen.get(key);
    seen.set(key, (dup ?? 0) + 1);

    const reasons: string[] = [];
    let status: MovePreviewRow['status'] = 'ready';
    if (entry.path === target) {
      status = 'unchanged';
      reasons.push(t('move.atTarget'));
    } else if (dup !== undefined) {
      status = 'conflict';
      reasons.push(t('move.duplicate'));
    } else if (diskExists[key]) {
      status = 'conflict';
      reasons.push(t('move.exists'));
    }
    rows.push({ entry, subdir, target, status, reasons });
  }
  return rows;
}

/** 便于测试/调试：从父路径与子目录拼出完整目录。 */
export function joinDir(parent: string, child: string, env: EnvInfo): string {
  if (!child) return parent;
  return `${parent}${parent.endsWith(env.separator) ? '' : env.separator}${child}`;
}
