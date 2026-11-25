/**
 * 更新通道版本比较守卫（2026-11-25「更新通道失效」回归）。
 *
 * 根因：`is_newer` 用 semver 把整段 `alphaN` 当字母数字标识符做字符串比较，
 * `alpha10 < alpha9`，于是装在 1.2.0-alpha9 上的客户端永远认为已是最新。
 *
 * 三段：
 *  A. 探针：真跑 `cargo run --example version_probe`，把「谁比谁新」读回来逐条比对，
 *     含 alpha9→alpha13 的真实场景与 alpha19→alpha20 的数字位宽边界。
 *  B. 接线：update.rs 只调 core 的 version::is_newer（不得再用 semver 裸比）、
 *     core 注册模块、契约测试存在、CI 跑了契约与本源脚本。
 *  C. 文档：AGENTS / README / FEATURE-GAP 记录本次修复口径。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const repoRoot = path.join(appRoot, '..');
const coreRoot = path.join(appRoot, 'src-tauri', 'renomio-core');
const requireProbe = process.argv.includes('--require-probe');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const read = (abs) => readFileSync(abs, 'utf8');

// ---------------- A. 探针 ----------------
const pairs = [
  // [remote, current, 期望 newer, 期望 order]
  ['1.2.0-alpha13', '1.2.0-alpha9', true, 'newer'], // 回归现场
  ['1.2.0-alpha10', '1.2.0-alpha9', true, 'newer'], // 单数字 → 双数字
  ['1.2.0-alpha9', '1.2.0-alpha10', false, 'older'],
  ['1.2.0-alpha13', '1.2.0-alpha13', false, 'same'],
  ['1.2.0-alpha19', '1.2.0-alpha20', false, 'older'],
  ['1.2.0', '1.2.0-alpha99', true, 'newer'], // 正式版高于预发布
  ['1.2.0-alpha99', '1.2.0', false, 'older'],
  ['1.3.0-alpha1', '1.2.0', true, 'newer'], // base 版本优先
  ['1.2.0-beta1', '1.2.0-alpha13', true, 'newer'], // 文本预发布排在 alpha 之后
  ['1.2.0', '1.2.0-beta1', true, 'newer'],
];

const probeArgs = pairs.flatMap(([remote, current]) => ['--pair', remote, current]);
const runProbe = (args) => {
  const run = spawnSync(
    'cargo',
    ['run', '-q', '--manifest-path', path.join(coreRoot, 'Cargo.toml'), '--example', 'version_probe', '--', ...args],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (run.error) return { error: String(run.error) };
  if (run.status !== 0) {
    return { error: `探针退出码 ${run.status}：${(run.stderr || '').trim().split('\n').slice(-3).join(' | ')}` };
  }
  try {
    return JSON.parse(run.stdout);
  } catch (err) {
    return { error: `探针输出不是 JSON：${err.message}` };
  }
};

console.log('A. 探针实跑（version_probe）');
const result = runProbe(probeArgs);
if (result.error) {
  if (requireProbe) {
    check('探针可运行', false, result.error);
    console.log(`\n更新通道守卫：${pass} 通过 / ${fail} 失败`);
    process.exit(1);
  }
  console.log(`  SKIP  探针未运行：${result.error}`);
} else {
  check('探针输出含 pairs 数组', Array.isArray(result.pairs) && result.pairs.length === pairs.length);
  pairs.forEach(([remote, current, expectNewer, expectOrder], index) => {
    const entry = result.pairs[index] ?? {};
    check(
      `${current} → ${remote}：newer=${expectNewer}（${expectOrder}）`,
      entry.newer === expectNewer && entry.order === expectOrder,
      `实际 ${JSON.stringify(entry)}`,
    );
  });

  // 真实场景复核：本仓库 VERSION 必须比 1.2.0-alpha9 新（否则 alpha9 装机看不到任何后续版本）
  const versionFile = read(path.join(repoRoot, 'VERSION')).trim();
  const live = runProbe(['--pair', versionFile, '1.2.0-alpha9']);
  check(
    `仓库 VERSION（${versionFile}）比 1.2.0-alpha9 新`,
    live && Array.isArray(live.pairs) && live.pairs[0]?.newer === true,
    live?.error ?? JSON.stringify(live?.pairs?.[0]),
  );

  const cmp = runProbe(['--compare', '1.2.0-alpha13', '1.2.0-alpha12']);
  check(
    '--compare 输出 alpha13 > alpha12（order=newer）',
    cmp && cmp.compare && cmp.compare.order === 'newer',
    cmp?.error ?? JSON.stringify(cmp?.compare),
  );
}

// ---------------- B. 接线 ----------------
console.log('B. 接线与实现');
const versionRs = read(path.join(coreRoot, 'src', 'version.rs'));
check('core 存在 version.rs', existsSync(path.join(coreRoot, 'src', 'version.rs')));
check('alpha 序号用数值比较（Prerelease::Alpha + cmp）', /Prerelease::Alpha\(m\), Prerelease::Alpha\(n\)\) => m\.cmp\(n\)/.test(versionRs));
check('提供 is_newer 唯一入口', versionRs.includes('pub fn is_newer'));
check('正式版高于预发布（None 排在 Some 之后）', /\(None, Some\(_\)\) => Ordering::Greater/.test(versionRs));
check('拒绝 alpha 序号为 0 / 前导零 / 空序号', versionRs.includes('alpha 序号不能为 0') && versionRs.includes('alpha<正整数>'));

const coreLib = read(path.join(coreRoot, 'src', 'lib.rs'));
check('core lib 注册 pub mod version', coreLib.includes('pub mod version;'));

const contract = read(path.join(coreRoot, 'tests', 'version_contract.rs'));
check('契约测试含 alpha9 → alpha13 回归', contract.includes('installed_alpha9_sees_alpha13_as_an_update'));
check('契约测试逐条覆盖 alpha10..alpha20', contract.includes('every_alpha_after_nine_is_newer_than_nine'));
check('契约测试含数字位宽边界（alpha19/alpha20）', contract.includes('1.2.0-alpha19') && contract.includes('1.2.0-alpha20'));
check('契约测试钉住探针入口', contract.includes('probe_example_is_the_documented_entry_point'));

const probe = read(path.join(coreRoot, 'examples', 'version_probe.rs'));
check('探针支持 --pair 与 --compare', probe.includes('--pair') && probe.includes('--compare'));
check('探针调用 core 的 compare（不自己再实现）', probe.includes('renomio_core::version::compare'));

const updateRs = read(path.join(appRoot, 'src-tauri', 'src', 'update.rs'));
check('update.rs 调用 core 的 version::is_newer', updateRs.includes('renomio_core::version::is_newer'));
check('update.rs 不再用 semver 裸比版本', !updateRs.includes('semver::Version::parse'));
check('update.rs 有数字位宽回归单测', updateRs.includes('version_compare_handles_digit_width_boundary'));

const tauriCargo = read(path.join(appRoot, 'src-tauri', 'Cargo.toml'));
check('src-tauri 已移除 semver 依赖', !/^semver\s*=/m.test(tauriCargo));

const pkg = JSON.parse(read(path.join(appRoot, 'package.json')));
check('package.json 有 test:update 脚本', Boolean(pkg.scripts?.['test:update']));
check('test:update 自带 --require-probe', String(pkg.scripts?.['test:update'] ?? '').includes('--require-probe'));

const ci = read(path.join(repoRoot, '.github', 'workflows', 'ci.yml'));
check('CI 跑 version_contract', ci.includes('--test version_contract'));
check('CI 跑 test-update.mjs', ci.includes('scripts/test-update.mjs'));
check('CI 在 cross-os 矩阵里跑（三平台）', /cross-os/.test(ci) && ci.indexOf('cross-os') < ci.indexOf('version_contract'));

// ---------------- C. 文档 ----------------
console.log('C. 文档同源');
const agents = read(path.join(repoRoot, 'AGENTS.md'));
check('AGENTS 记录更新通道修复', agents.includes('更新通道'));
check('AGENTS 写明 alpha9 边界原因', agents.includes('alpha9') && agents.includes('alpha10'));

const readmeRoot = read(path.join(repoRoot, 'README.md'));
check('根 README 写明 alpha 序号按数值比较', readmeRoot.includes('alpha') && readmeRoot.includes('数值比较'));

const readmeApp = read(path.join(appRoot, 'README.md'));
check('app README 有版本比较说明', readmeApp.includes('test:update'));

const gap = read(path.join(repoRoot, 'docs', 'FEATURE-GAP.md'));
check('FEATURE-GAP changelog 记录更新通道修复', gap.includes('更新通道'));

console.log(`\n更新通道守卫：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('提示：先用 --require-probe 运行时探针失败会直接失败，不会被当成通过。');
  process.exit(1);
}
