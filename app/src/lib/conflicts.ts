/**
 * 规则冲突分析（纯函数，不依赖 i18n / React，便于独立测试）。
 *
 * 覆盖五类：
 * 1. 同路径同时出现在「包含」与「排除」；
 * 2. 规则动作矛盾（例如两条规则同时改写扩展名但结果不同）；
 * 3. 被前面的规则遮蔽、后续永远不产生新效果；
 * 4. 路径前缀 / 子目录重叠（`C:\data` 与 `C:\data\sub`）；
 * 5. 正则 / 模式等价或重叠。
 *
 * 只提示、不阻断保存：返回结果由界面就地标出并汇总。
 */
import type { ConflictKind, Rule, RuleConflict } from './types';
import { splitPatterns } from './glob';

const normalize = (text: string) => text.replace(/\\/g, '/').trim().toLowerCase();
const trimGlob = (text: string) => normalize(text).replace(/\*+$/, '').replace(/\/+$/, '');

/** 两个模式是否为目录前缀 / 子目录关系（相等时不算前缀）。 */
function isPrefix(a: string, b: string): boolean {
  const left = trimGlob(a);
  const right = trimGlob(b);
  if (!left || !right || left === right) return false;
  return right.startsWith(`${left}/`) || left.startsWith(`${right}/`);
}

function samePattern(a: string, b: string): boolean {
  return trimGlob(a) === trimGlob(b);
}

interface Draft {
  key: string;
  kinds: Set<ConflictKind>;
  ruleIds: string[];
  patterns: string[];
  detail: string;
}

function add(
  map: Map<string, Draft>,
  key: string,
  kinds: ConflictKind[],
  patch: Omit<Draft, 'key' | 'kinds'>,
) {
  const existing = map.get(key);
  if (existing) {
    for (const kind of kinds) existing.kinds.add(kind);
    return;
  }
  map.set(key, { key, kinds: new Set(kinds), ...patch });
}

/** 顶部路径筛选模式的冲突（包含 / 排除）。 */
function patternConflicts(includePattern: string, excludePattern: string): Draft[] {
  const include = splitPatterns(includePattern);
  const exclude = splitPatterns(excludePattern);
  const map = new Map<string, Draft>();

  include.forEach((a, i) => {
    exclude.forEach((b, j) => {
      const key = `patterns:include-${i}:exclude-${j}`;
      const patch = { ruleIds: [], patterns: [a, b], detail: `${a} ⇄ ${b}` };
      if (samePattern(a, b)) add(map, key, ['include-exclude'], patch);
      else if (isPrefix(a, b)) add(map, key, ['path-overlap'], patch);
    });
  });

  // 排除列表内的重复 / 前缀重叠：被更宽的模式覆盖的那条永远不再生效，属于「被遮蔽」。
  // 包含列表是并集语义，内部重叠不会产生行为冲突，因此不在此提示，避免误报。
  const within = (list: string[]) => {
    list.forEach((a, i) => {
      list.forEach((b, j) => {
        if (i >= j) return;
        const key = `patterns:exclude-${i}:exclude-${j}`;
        const patch = { ruleIds: [], patterns: [a, b], detail: `${a} ⇄ ${b}` };
        if (samePattern(a, b) || isPrefix(a, b)) add(map, key, ['path-overlap', 'shadowed'], patch);
      });
    });
  };
  within(exclude);

  return Array.from(map.values());
}

type ExtFamily = 'set' | 'remove' | 'number';

function extFamily(rule: Extract<Rule, { type: 'ext' }>): ExtFamily | null {
  switch (rule.mode) {
    case 'replace':
    case 'fixed':
      return 'set';
    case 'remove':
      return 'remove';
    case 'number':
      return 'number';
    default:
      return null;
  }
}

function extValue(rule: Extract<Rule, { type: 'ext' }>): string {
  return rule.mode === 'replace' || rule.mode === 'fixed'
    ? rule.value.replace(/^\.+/, '').replace(/\.+$/, '').toLowerCase()
    : rule.mode === 'number'
      ? rule.value
      : '';
}

/** 去掉多余的非捕获分组，便于判定「正则等价」。 */
function canonicalRegex(source: string): string {
  return source.trim().replace(/\(\?:/g, '(').replace(/\s+/g, '');
}

/** 规则动作之间的冲突（同一对规则多类型命中合并为一条）。 */
function ruleConflicts(rules: Rule[]): Draft[] {
  const map = new Map<string, Draft>();
  const enabled = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.enabled);

  for (let i = 0; i < enabled.length; i += 1) {
    for (let j = i + 1; j < enabled.length; j += 1) {
      const a = enabled[i];
      const b = enabled[j];
      const key = `rules:${a.rule.id}:${b.rule.id}`;
      const patch = {
        ruleIds: [a.rule.id, b.rule.id],
        patterns: [],
        detail: `#${a.index + 1} ⇄ #${b.index + 1}`,
      };

      // 扩展名：两条规则都决定最终扩展名 → 后者覆盖前者
      if (a.rule.type === 'ext' && b.rule.type === 'ext') {
        const aFamily = extFamily(a.rule);
        const bFamily = extFamily(b.rule);
        if (aFamily && bFamily) {
          if (aFamily === bFamily && extValue(a.rule) === extValue(b.rule)) {
            add(map, key, ['shadowed'], patch);
          } else {
            add(map, key, ['action-contradiction', 'shadowed'], patch);
          }
          continue;
        }
        // 扩展名大小写设置互相矛盾
        if (a.rule.mode === 'case' && b.rule.mode === 'case') {
          add(map, key, a.rule.caseMode === b.rule.caseMode ? ['shadowed'] : ['action-contradiction'], patch);
          continue;
        }
      }

      // 主名大小写：大小写变换方向相反 → 矛盾；相同 → 后一条不再改变结果
      if (a.rule.type === 'case' && b.rule.type === 'case') {
        add(map, key, a.rule.mode === b.rule.mode ? ['shadowed'] : ['action-contradiction'], patch);
        continue;
      }

      // 替换：同一查找条件却给出不同替换值 → 矛盾；完全相同的第二次不再命中
      if (a.rule.type === 'replace' && b.rule.type === 'replace') {
        const aRegex = a.rule.regex ? canonicalRegex(a.rule.find) : a.rule.find;
        const bRegex = b.rule.regex ? canonicalRegex(b.rule.find) : b.rule.find;
        if (aRegex === bRegex && a.rule.nth === b.rule.nth && a.rule.caseSensitive === b.rule.caseSensitive) {
          const kinds: ConflictKind[] = a.rule.replace === b.rule.replace ? ['shadowed'] : ['action-contradiction'];
          if (a.rule.regex) kinds.unshift('regex-overlap');
          add(map, key, kinds, patch);
        }
        continue;
      }

      // 删除字符集：同一组字符既「保留」又「删除」
      if (a.rule.type === 'delete' && b.rule.type === 'delete'
        && a.rule.mode === 'charset' && b.rule.mode === 'charset'
        && a.rule.chars === b.rule.chars && a.rule.keep !== b.rule.keep) {
        add(map, key, ['action-contradiction'], patch);
      }
    }
  }

  return Array.from(map.values());
}

/**
 * 分析规则链与顶部筛选模式的冲突。
 * 返回顺序稳定：先路径模式（按其出现顺序），再规则（按规则出现顺序）。
 */
export function analyzeConflicts(
  rules: Rule[],
  includePattern = '',
  excludePattern = '',
): RuleConflict[] {
  const drafts = [...patternConflicts(includePattern, excludePattern), ...ruleConflicts(rules)];
  const order = new Map(rules.map((rule, index) => [rule.id, index]));
  drafts.sort((a, b) => {
    const ai = a.ruleIds.length ? order.get(a.ruleIds[0]) ?? -1 : -1;
    const bi = b.ruleIds.length ? order.get(b.ruleIds[0]) ?? -1 : -1;
    return ai - bi;
  });
  return drafts.map((draft) => ({
    key: draft.key,
    kinds: Array.from(draft.kinds),
    ruleIds: draft.ruleIds,
    patterns: draft.patterns,
    detail: draft.detail,
  }));
}

/** 某条规则命中的冲突（用于卡片上的就地标记）。 */
export function conflictsOfRule(conflicts: RuleConflict[], ruleId: string): RuleConflict[] {
  return conflicts.filter((conflict) => conflict.ruleIds.includes(ruleId));
}
