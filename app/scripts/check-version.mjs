#!/usr/bin/env node
/**
 * 版本规则校验（单一版本来源 = 仓库根 VERSION 文件）：
 *   1) 格式：<major>.<minor>.<patch>、<major>.<minor>.<patch>-alpha<N> 或 -RC<N>
 *   2) 段位：除第一段外，每段数值 <= 10（minor / patch / 预发布序号）
 *   3) 预发布序号：单调递增、不复用、不带前导零、不得为 0（**仅 tag 推送时严格**）
 *   4) tag（v 前缀）去掉 v 后必须与 VERSION 完全一致
 *   5) 各清单文件必须与 VERSION 一致（漂移即失败）
 *   6) 分支推送只要求 VERSION 不低于最新已发布预发布版（等于可通过，低于才拦截）
 *
 * 顺序约定：alphaN < betaN < RCN < 正式版；RC 序号同样按数值比较。
 *
 * 用法：
 *   node scripts/check-version.mjs                 # 校验 VERSION + 清单（分支推送上只校验下限）
 *   node scripts/check-version.mjs --tag v1.0.0-alpha1
 *   node scripts/check-version.mjs --self-test     # 反例自测（不需要仓库状态）
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const STD_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PRE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-(alpha|RC)([1-9]\d*)$/;
const MAX_SEGMENT = 10; // 除第一段外，其余每段数值上限
const MAX_PRE = 99; // 预发布序号上限（alpha 会随迭代持续累加，单独放宽；minor/patch 仍 <= 10）
const PRE_RANK = { alpha: 0, beta: 1, rc: 2 };

/** 纯函数：校验版本字符串本身。返回错误数组（空数组 = 通过）。 */
export function validateVersionString(v) {
  const errors = [];
  if (typeof v !== 'string' || v.length === 0) return ['版本为空'];
  if (v !== v.trim()) errors.push(`版本含首尾空白："${v}"`);

  const pre = PRE_VERSION_RE.exec(v);
  const stable = pre ? null : STD_VERSION_RE.exec(v);
  if (!pre && !stable) {
    errors.push(`格式不合法：${v}（只允许 x.y.z、x.y.z-alphaN 或 x.y.z-RC<N>，序号为正整数无前导零）`);
    return errors;
  }

  const major = Number((pre ?? stable)[1]);
  const minor = Number((pre ?? stable)[2]);
  const patch = Number((pre ?? stable)[3]);
  if (minor > MAX_SEGMENT) errors.push(`第二段 ${minor} > ${MAX_SEGMENT}（例 1.11.0 不允许）`);
  if (patch > MAX_SEGMENT) errors.push(`第三段 ${patch} > ${MAX_SEGMENT}`);
  if (pre) {
    const number = Number(pre[5]);
    if (number > MAX_PRE) errors.push(`${pre[4]} 序号 ${number} > ${MAX_PRE}`);
  }
  if (major === 0 && !pre) errors.push('正式版本不得为 0.x.y（本项目自 1.0.0 起）');
  return errors;
}

/** 纯函数：解析成可比较的结构。 */
export function parseVersion(v) {
  const pre = PRE_VERSION_RE.exec(v);
  const stable = pre ? null : STD_VERSION_RE.exec(v);
  if (!pre && !stable) return null;
  const m = pre ?? stable;
  const kind = pre ? (pre[4] === 'RC' ? 'rc' : 'alpha') : null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    kind,
    pre: pre ? Number(pre[5]) : null,
    alpha: kind === 'alpha' ? Number(pre[5]) : null,
    base: `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`,
  };
}

/** 纯函数：把解析结构还原成可读标签。 */
function versionLabel(p) {
  return p.kind === null ? p.base : `${p.base}-${p.kind === 'rc' ? 'RC' : 'alpha'}${p.pre}`;
}

/** 纯函数：tag（可带 v 前缀）与版本是否一致。 */
export function validateTagPair(version, tag) {
  if (!tag) return ['缺少 tag'];
  const expected = tag.startsWith('v') ? tag.slice(1) : tag;
  if (expected !== version) return [`tag ${tag} 与 VERSION ${version} 不一致`];
  return [];
}

/**
 * 纯函数：预发布序号必须严格大于同一 base 版本已发布的最大预发布版。
 * existingTags 为 v 开头的 tag 列表；alpha / RC 混用时按 alpha < RC 排序。
 *
 * 只用于 **tag 推送**：预发布复用（等于）与倒退（小于）都拦截。
 * 分支推送不走这里，改用 `validateBranchFloor`（等于可通过）。
 */
export function validateMonotonic(version, existingTags) {
  const parsed = parseVersion(version);
  if (!parsed) return [`版本不合法，无法判断单调性：${version}`];
  if (parsed.kind === null) return [];
  const latest = existingTags
    .map((t) => (/^v/.test(t) ? parseVersion(t.slice(1)) : null))
    .filter((p) => p && p.base === parsed.base && p.kind !== null)
    .reduce((acc, p) => (acc === null || compareVersions(p, acc) > 0 ? p : acc), null);
  if (latest && compareVersions(parsed, latest) <= 0) {
    return [`预发布序号必须递增：已有 ${versionLabel(latest)}，本次为 ${versionLabel(parsed)}`];
  }
  return [];
}

/** 纯函数：版本比较。正式版高于同 base 的预发布；预发布按 alpha < beta < RC、同类按数值。 */
export function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.kind === null && b.kind === null) return 0;
  if (a.kind === null) return 1;
  if (b.kind === null) return -1;
  if (PRE_RANK[a.kind] !== PRE_RANK[b.kind]) return PRE_RANK[a.kind] < PRE_RANK[b.kind] ? -1 : 1;
  if (a.pre !== b.pre) return a.pre < b.pre ? -1 : 1;
  return 0;
}

/**
 * 纯函数：**分支推送**的版本下限。
 * 只要求 `version` 不低于最新已发布预发布版：等于可通过，低于才拦截。
 * 严格递增、预发布复用与倒退由 tag 推送时的 `validateMonotonic` 负责。
 */
export function validateBranchFloor(version, existingTags) {
  const parsed = parseVersion(version);
  if (!parsed) return [`版本不合法，无法判断下限：${version}`];
  const released = existingTags
    .map((t) => (/^v/.test(t) ? parseVersion(t.slice(1)) : null))
    .filter((p) => p && p.kind !== null);
  if (released.length === 0) return [];
  const latest = released.reduce((acc, p) => (compareVersions(p, acc) > 0 ? p : acc));
  if (compareVersions(parsed, latest) < 0) {
    return [
      `分支推送的版本 ${version} 低于最新已发布 ${versionLabel(latest)}，请先推进 VERSION`,
    ];
  }
  return [];
}

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appDir, '..');

function readVersionFile() {
  return readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
}

function checkLists(version) {
  const errors = [];
  const files = [
    ['app/package.json', /^\s*"version"\s*:\s*"([^"]*)"/m],
    ['app/packages/foundation/package.json', /^\s*"version"\s*:\s*"([^"]*)"/m],
    ['app/src-tauri/tauri.conf.json', /^\s*"version"\s*:\s*"([^"]*)"/m],
    ['app/src-tauri/Cargo.toml', /\[package\][\s\S]*?\nversion\s*=\s*"([^"]*)"/],
    ['app/src-tauri/renomio-core/Cargo.toml', /\[package\][\s\S]*?\nversion\s*=\s*"([^"]*)"/],
  ];
  for (const [rel, re] of files) {
    const file = path.join(repoRoot, rel);
    const text = readFileSync(file, 'utf8');
    const m = re.exec(text);
    if (!m) {
      errors.push(`${rel}: 找不到版本字段`);
      continue;
    }
    if (m[1] !== version) errors.push(`${rel}: ${m[1]} ≠ VERSION ${version}（先跑 npm run version:sync）`);
  }
  return errors;
}

function gitTags() {
  try {
    return execFileSync('git', ['tag', '--list', 'v*'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

function selfTest() {
  const cases = [];
  const add = (name, fn) => cases.push({ name, fn });

  add('拒绝 1.11.0 / 1.0.11（minor 或 patch > 10）', () => {
    const a = validateVersionString('1.11.0');
    const b = validateVersionString('1.0.11');
    return a.some((e) => /第二段/.test(e)) && b.some((e) => /第三段/.test(e)) ? null : '未被拦截';
  });
  add('接受 1.10.10（段位恰好为 10）', () => validateVersionString('1.10.10').length ? '被误拦' : null);
  add('拒绝 alpha0（序号不得为 0）', () => validateVersionString('1.0.0-alpha0').length ? null : '未被拦截');
  add('拒绝 alpha01（前导零）', () => validateVersionString('1.0.0-alpha01').length ? null : '未被拦截');
  add('接受 alpha11（alpha 序号上限 99）', () => validateVersionString('1.0.0-alpha11').length ? '被误拦' : null);
  add('接受 1.0.0-alpha1', () => validateVersionString('1.0.0-alpha1').length ? '被误拦' : null);
  add('接受 1.3.0-RC1（RC 预发布）', () => validateVersionString('1.3.0-RC1').length ? '被误拦' : null);
  add('拒绝 RC0 / RC01', () => {
    const a = validateVersionString('1.3.0-RC0');
    const b = validateVersionString('1.3.0-RC01');
    return a.length && b.length ? null : '未被拦截';
  });
  add('RC 序号按数值比较（RC2 < RC10）', () => {
    const a = parseVersion('1.3.0-RC2');
    const b = parseVersion('1.3.0-RC10');
    return compareVersions(a, b) < 0 ? null : '比较错误';
  });
  add('顺序：alpha < RC < 正式版', () => {
    const alpha = parseVersion('1.3.0-alpha99');
    const rc = parseVersion('1.3.0-RC1');
    const stable = parseVersion('1.3.0');
    return compareVersions(alpha, rc) < 0 && compareVersions(rc, stable) < 0 ? null : '顺序错误';
  });
  add('拒绝 RC 复用（已有 RC1，本次 RC1）', () => {
    const errs = validateMonotonic('1.3.0-RC1', ['v1.3.0-RC1', 'v1.2.0-alpha38']);
    return errs.length ? null : '未被拦截';
  });
  add('接受 alpha38 → RC1（同一 base 的升级）', () =>
    validateMonotonic('1.3.0-RC1', ['v1.3.0-alpha38']).length ? '被误拦' : null);
  add('分支推送：已有 RC1，main 推送 RC1 → 允许', () =>
    validateBranchFloor('1.3.0-RC1', ['v1.3.0-RC1', 'v1.2.0-alpha38']).length ? '被误拦' : null);
  add('拒绝 tag 与版本不一致（v1.0.0-alpha2 vs 1.0.0-alpha1）', () => {
    const errs = validateTagPair('1.0.0-alpha1', 'v1.0.0-alpha2');
    return errs.length ? null : '未被拦截';
  });
  add('接受 tag 与版本一致（v1.0.0-alpha1）', () => (validateTagPair('1.0.0-alpha1', 'v1.0.0-alpha1').length ? '被误拦' : null));
  add('拒绝 alpha 复用（已有 alpha1，本次 alpha1）', () => {
    const errs = validateMonotonic('1.0.0-alpha1', ['v0.1.0', 'v1.0.0-alpha1']);
    return errs.length ? null : '未被拦截';
  });
  add('拒绝 alpha 倒退（已有 alpha2，本次 alpha1）', () => {
    const errs = validateMonotonic('1.0.0-alpha1', ['v1.0.0-alpha2']);
    return errs.length ? null : '未被拦截';
  });
  add('接受 alpha 递增（已有 alpha1，本次 alpha2）', () =>
    validateMonotonic('1.0.0-alpha2', ['v1.0.0-alpha1']).length ? '被误拦' : null);
  add('分支推送：已有 alpha5，main 推送 alpha5 → 允许', () =>
    validateBranchFloor('1.0.0-alpha5', ['v1.0.0-alpha4', 'v1.0.0-alpha5']).length ? '被误拦' : null);
  add('分支推送：已有 alpha5，main 推送 alpha4 → 拒绝', () => {
    const errs = validateBranchFloor('1.0.0-alpha4', ['v1.0.0-alpha4', 'v1.0.0-alpha5']);
    return errs.length ? null : '未被拦截';
  });
  // tag 推送仍走 validateMonotonic：已有 alpha5 时再验 alpha5 必须被拒
  // （Git/GitHub 本身会拒绝重复 tag 引用，这里校验的是闸门自身的兜底行为）
  add('tag 推送：已有 alpha5，alpha5 重复 → 仍拒绝', () => {
    const errs = validateMonotonic('1.0.0-alpha5', ['v1.0.0-alpha5']);
    return errs.length ? null : '未被拦截';
  });
  add('拒绝正式版 0.x.y', () => validateVersionString('0.9.0').length ? null : '未被拦截');
  add('拒绝前导零 major（01.0.0）', () => validateVersionString('01.0.0').length ? null : '未被拦截');

  let failed = 0;
  for (const c of cases) {
    const err = c.fn();
    if (err) {
      failed++;
      console.log(`FAIL  反例：${c.name} —— ${err}`);
    } else {
      console.log(`PASS  反例：${c.name}`);
    }
  }
  console.log(`\n自测 ${cases.length - failed}/${cases.length} 通过`);
  process.exit(failed === 0 ? 0 : 1);
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }

  const errors = [];
  const version = readVersionFile();
  errors.push(...validateVersionString(version));
  errors.push(...checkLists(version));

  const tagArgIdx = process.argv.indexOf('--tag');
  let tag = tagArgIdx >= 0 ? process.argv[tagArgIdx + 1] : null;
  if (!tag && process.env.GITHUB_REF_TYPE === 'tag') tag = process.env.GITHUB_REF_NAME;
  if (tag) {
    errors.push(...validateTagPair(version, tag));
    if (tag.startsWith('v') && !version.includes('-')) {
      console.log(`提示：正式版 ${version} 需真机点验通过后由 tag ${tag} 发布`);
    }
  }

  const tags = gitTags();
  if (tags === null) {
    console.log('提示：未读取到 git tag（可能不在 git 仓库中），跳过版本闸门');
  } else if (tag) {
    // tag 推送：严格递增，alpha 复用与倒退一律拦截
    errors.push(...validateMonotonic(version, tags.filter((t) => t !== tag)));
  } else if (process.env.CI) {
    // 分支推送：只要求不低于最新已发布 alpha（等于可通过）
    errors.push(...validateBranchFloor(version, tags));
  }

  if (errors.length > 0) {
    console.error(`版本校验失败（VERSION=${version}）：`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`版本校验通过：VERSION=${version}${tag ? `，tag=${tag}` : ''}（清单 5 处一致）`);
}

main();
