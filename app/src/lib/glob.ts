/** 与 Rust 行为一致的通配符匹配（* / ?），用于前端内存过滤 */
export function wildcardMatch(pattern: string, text: string, caseInsensitive: boolean): boolean {
  const p = Array.from(caseInsensitive ? pattern.toLowerCase() : pattern);
  const t = Array.from(caseInsensitive ? text.toLowerCase() : text);
  let pi = 0;
  let ti = 0;
  let star = -1;
  let mark = 0;
  while (ti < t.length) {
    if (pi < p.length && (p[pi] === '?' || p[pi] === t[ti])) {
      pi += 1;
      ti += 1;
    } else if (pi < p.length && p[pi] === '*') {
      star = pi;
      mark = ti;
      pi += 1;
    } else if (star >= 0) {
      pi = star + 1;
      mark += 1;
      ti = mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === '*') pi += 1;
  return pi === p.length;
}

export function splitPatterns(raw: string): string[] {
  return raw
    .split(/[;|]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function matchesAny(patterns: string[], text: string, caseInsensitive: boolean): boolean {
  return patterns.some((p) => wildcardMatch(p, text, caseInsensitive));
}
