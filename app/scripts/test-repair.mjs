/**
 * 数据目录自检与修复（6.15）自测。
 *
 * 判据只有一条：**自检要能说清哪儿坏了，修复要能让它恢复可用，且不删用户数据**。
 * 三段：
 *  A. 探针：真跑 `cargo run --example repair_probe`，逐条验证发现码 / 严重度 / 可修性 /
 *     隔离而非删除 / 临时文件时限 / 幂等 / 退出码。
 *  B. 接线：Tauri 两条命令、core 导出、前端桥接与界面按钮、五语种文案、CI 两步。
 *  C. 文档：FEATURE-GAP 的 6.15 行与统计、README、AGENTS 与本轮同源。
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
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
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'renomio-repair-'));

const REQUIRED_DIRS = ['batches', 'backups', 'logs', 'snapshots'];

const makeDir = (root, name) => mkdirSync(path.join(root, name), { recursive: true });
const writeAt = (root, rel, content) => {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
};
const at = (root, rel) => path.join(root, ...rel.split('/'));

const batchJson = (id) =>
  JSON.stringify({
    id,
    createdAt: 1,
    state: 'completed',
    policy: 'rename',
    roots: [],
    counts: { total: 0, done: 0, skipped: 0, failed: 0 },
    items: [],
  });
const snapshotJson = (id) =>
  JSON.stringify({
    schema: 'renomio-snapshot-v1',
    id,
    createdAt: 1,
    roots: [],
    entryCount: 0,
    hashed: 0,
    skipped: 0,
    entries: [],
  });

const runProbe = (args) => {
  const run = spawnSync(
    'cargo',
    ['run', '-q', '--manifest-path', path.join(coreRoot, 'Cargo.toml'), '--example', 'repair_probe', '--', ...args],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (run.error) return { error: String(run.error) };
  const out = (run.stdout || '').trim();
  const lastLine = out.split('\n').filter((l) => l.trim().startsWith('{')).pop();
  if (!lastLine) {
    return {
      error: `探针没有输出 JSON（退出码 ${run.status}）：${(run.stderr || '').trim().split('\n').slice(-2).join(' | ')}`,
    };
  }
  try {
    return { value: JSON.parse(lastLine), status: run.status };
  } catch (err) {
    return { error: `探针输出不是 JSON：${err.message}` };
  }
};

const codes = (report) => (report.findings || []).map((f) => f.code);
const find = (report, code) => (report.findings || []).find((f) => f.code === code);

// ---------------- A. 探针 ----------------
console.log('A. 探针：自检与修复行为');

// A1 干净目录
{
  const root = path.join(sandbox, 'clean');
  REQUIRED_DIRS.forEach((d) => makeDir(root, d));
  writeAt(root, 'batches/1-000.json', batchJson('1-000'));
  writeAt(root, 'snapshots/s-1.json', snapshotJson('s-1'));
  writeAt(root, 'rule-history.json', '["a","b"]');
  const run = runProbe(['check', root]);
  check('干净目录 check 通过', run.value && run.value.ok === true, run.error);
  check('干净目录无发现', run.value && run.value.findings.length === 0, JSON.stringify(codes(run.value || {})));
  check('干净目录退出码 0', run.status === 0, `status=${run.status}`);
  check('scanned 统计到真实文件', run.value && run.value.scanned >= 3, `scanned=${run.value && run.value.scanned}`);
}

// A2 缺子目录
{
  const root = path.join(sandbox, 'dirs');
  makeDir(root, '');
  const run = runProbe(['check', root]);
  const found = run.value && run.value.findings.filter((f) => f.code === 'missing-dir');
  check('缺 4 个子目录全部报出', found && found.length === 4, JSON.stringify(codes(run.value || {})));
  check('missing-dir 是 info 且可修', found && found.every((f) => f.severity === 'info' && f.fixable));
  check('path 用 / 分隔', found && found.every((f) => !f.path.includes('\\')), JSON.stringify(found && found.map((f) => f.path)));
  const fixed = runProbe(['fix', root]);
  const acts = (fixed.value && fixed.value.fixed) || [];
  check('修复创建 4 个目录', acts.filter((x) => x.action === 'create-dir').length === 4, JSON.stringify(acts));
  check('目录真的建出来了', REQUIRED_DIRS.every((d) => existsSync(path.join(root, d))));
  check('修完再查是干净的', (runProbe(['check', root]).value || {}).findings.length === 0);
}

// A3 坏批次：隔离而非删除
{
  const root = path.join(sandbox, 'badbatch');
  REQUIRED_DIRS.forEach((d) => makeDir(root, d));
  writeAt(root, 'batches/2-000.json', '{ broken');
  const bad = runProbe(['check', root]);
  const f = bad.value && find(bad.value, 'bad-batch');
  check('坏批次被报 error', f && f.severity === 'error', JSON.stringify(codes(bad.value || {})));
  check('坏批次可修', f && f.fixable === true);
  check('check 有 error 时退出码 1', bad.status === 1, `status=${bad.status}`);
  const fixed = runProbe(['fix', root]);
  const item = (fixed.value && fixed.value.fixed && fixed.value.fixed[0]) || {};
  check('修复动作是 quarantine', item.action === 'quarantine', JSON.stringify(item));
  check('原位置已清空', !existsSync(path.join(root, 'batches', '2-000.json')));
  check('隔离副本仍有原字节', item.target && read(at(root, item.target)) === '{ broken', item.target);
  check('隔离目录写在 quarantine', item.target && item.target.startsWith('repair-quarantine/'), item.target);
  check('report 给出 quarantine 目录', fixed.value && typeof fixed.value.quarantine === 'string');
  check('修完退出码 0', fixed.status === 0, `status=${fixed.status}`);
}

// A4 空文件与 id 不符
{
  const root = path.join(sandbox, 'empty');
  REQUIRED_DIRS.forEach((d) => makeDir(root, d));
  writeAt(root, 'batches/1-000.json', '');
  writeAt(root, 'batches/8-000.json', batchJson('9-000'));
  const run = runProbe(['check', root]);
  const empty = find(run.value, 'bad-batch');
  check('空批次 detail 说明空文件', empty && empty.detail.includes('空文件'), empty && empty.detail);
  const mismatch = find(run.value, 'batch-id-mismatch');
  check('id 不一致是 warn', mismatch && mismatch.severity === 'warn', JSON.stringify(codes(run.value || {})));
  check('id 不一致 detail 含两个 id', mismatch && mismatch.detail.includes('8-000') && mismatch.detail.includes('9-000'));
}

// A5 快照
{
  const root = path.join(sandbox, 'snap');
  REQUIRED_DIRS.forEach((d) => makeDir(root, d));
  writeAt(root, 'snapshots/broken.json', '');
  writeAt(root, 'snapshots/file.json', snapshotJson('other'));
  const run = runProbe(['check', root]);
  check('坏快照被报 bad-snapshot', !!find(run.value, 'bad-snapshot'), JSON.stringify(codes(run.value || {})));
  check('快照 id 不一致被报', !!find(run.value, 'snapshot-id-mismatch'));
  const fixed = runProbe(['fix', root]);
  check('两个坏快照都进隔离区', ((fixed.value && fixed.value.fixed) || []).length === 2);
  check('修完快照目录清净', (runProbe(['check', root]).value || {}).ok === true);
}

// A6 规则输入历史
{
  const root = path.join(sandbox, 'history');
  REQUIRED_DIRS.forEach((d) => makeDir(root, d));
  writeAt(root, 'rule-history.json', '"scalar"');
  const bad = runProbe(['check', root]);
  check('标量历史被报 bad-rule-history', !!find(bad.value, 'bad-rule-history'), JSON.stringify(codes(bad.value || {})));
  writeAt(root, 'rule-history.json', '{}');
  check('对象历史合法', !find(runProbe(['check', root]).value, 'bad-rule-history'));
  writeAt(root, 'rule-history.json', '[]');
  check('数组历史合法', !find(runProbe(['check', root]).value, 'bad-rule-history'));
}

// A7 临时文件时限
{
  const root = path.join(sandbox, 'tmp');
  REQUIRED_DIRS.forEach((d) => makeDir(root, d));
  const tmpFile = writeAt(root, 'batches/3-000.json.tmp', '{}');
  const realNow = Math.round(statSync(tmpFile).mtimeMs);
  const fresh = runProbe(['fix', root, String(realNow)]);
  check('刚写的临时文件不删', existsSync(tmpFile) && fresh.value.fixed.length === 0, JSON.stringify(fresh.value.fixed));
  check('刚写的临时文件进 skipped', (fresh.value.skipped || []).some((f) => f.code === 'leftover-temp'));
  const later = runProbe(['fix', root, String(realNow + 25 * 60 * 60 * 1000)]);
  check('超过 24 小时的临时文件被删', later.value.fixed.some((x) => x.action === 'delete-temp'), JSON.stringify(later.value.fixed));
  check('删完文件确实不在了', !existsSync(tmpFile));
}

// A8 孤儿备份只提示
{
  const root = path.join(sandbox, 'orphan');
  REQUIRED_DIRS.forEach((d) => makeDir(root, d));
  writeAt(root, 'batches/1-000.json', batchJson('1-000'));
  writeAt(root, 'backups/1-000/20240101/x.jpg', 'bin');
  writeAt(root, 'backups/9-000/20240101/y.jpg', 'bin');
  makeDir(root, 'backups/7-000');
  const run = runProbe(['check', root]);
  const orphans = (run.value.findings || []).filter((f) => f.code === 'orphan-backup');
  check('只有产物缺失的备份算孤儿', orphans.length === 1, JSON.stringify(codes(run.value || {})));
  check('孤儿备份是 info 且不可修', orphans[0] && orphans[0].severity === 'info' && orphans[0].fixable === false);
  const fixed = runProbe(['fix', root]);
  check('修复不动备份', fixed.value.fixed.length === 0);
  check('备份文件还在', existsSync(path.join(root, 'backups', '9-000', '20240101', 'y.jpg')));
}

// A9 幂等
{
  const root = path.join(sandbox, 'idem');
  REQUIRED_DIRS.forEach((d) => makeDir(root, d));
  writeAt(root, 'batches/5-000.json', '{}');
  const first = runProbe(['fix', root, '1700000000000']);
  check('第一次修复隔离 1 项', first.value.fixed.length === 1);
  const second = runProbe(['fix', root, '1700000000000']);
  check('第二次修复不再动手', second.value.fixed.length === 0, JSON.stringify(second.value.fixed));
  const qdir = path.join(root, 'repair-quarantine', '1700000000000');
  check('隔离目录只有一份副本', readdirSync(path.join(qdir, 'batches')).length === 1, JSON.stringify(readdirSync(path.join(qdir, 'batches'))));
}

// A10 数据目录本身有问题
{
  const root = path.join(sandbox, 'noroot');
  const run = runProbe(['check', root]);
  check('缺根目录报 missing-root', !!find(run.value, 'missing-root'), JSON.stringify(codes(run.value || {})));
  check('缺根目录是 error 且可修', (find(run.value, 'missing-root') || {}).fixable === true);
  const fixed = runProbe(['fix', root]);
  check('fix 建出根目录', existsSync(root) && fixed.value.fixed.some((x) => x.code === 'missing-root'));

  const asFile = path.join(sandbox, 'rootfile');
  writeFileSync(asFile, 'x');
  const bad = runProbe(['check', asFile]);
  const f = find(bad.value, 'root-is-file');
  check('根是文件报 root-is-file', !!f, JSON.stringify(codes(bad.value || {})));
  check('root-is-file 不可修', f && f.fixable === false);
  check('根是文件时不会被当成目录改掉', statSync(asFile).isFile());
}

// A11 check 不写盘
{
  const root = path.join(sandbox, 'readonly');
  REQUIRED_DIRS.forEach((d) => makeDir(root, d));
  writeAt(root, 'batches/6-000.json', '{ broken');
  const run = runProbe(['check', root]);
  check('check 不产生 fixed', run.value.fixed.length === 0);
  check('check 不建隔离目录', !existsSync(path.join(root, 'repair-quarantine')));
  check('check 不动坏文件', existsSync(path.join(root, 'batches', '6-000.json')));
}

// A12 报告字段命名
{
  const root = path.join(sandbox, 'shape');
  REQUIRED_DIRS.forEach((d) => makeDir(root, d));
  writeAt(root, 'batches/7-000.json', '{');
  const run = runProbe(['fix', root]);
  const keys = Object.keys(run.value || {});
  check('报告用 camelCase 键', ['root', 'ok', 'scanned', 'findings', 'fixed', 'skipped'].every((k) => keys.includes(k)), keys.join(','));
  check('fixed 项带 action 与 target', (run.value.fixed[0] || {}).action === 'quarantine' && typeof run.value.fixed[0].target === 'string');
  check('finding 带 fixable 布尔', run.value.findings.every((f) => typeof f.fixable === 'boolean'));
}

// ---------------- B. 接线 ----------------
console.log('B. 接线：命令 / 桥接 / 界面 / 文案 / CI');

const coreLib = read(path.join(coreRoot, 'src', 'lib.rs'));
check('core 导出 repair 模块', /pub mod repair;/.test(coreLib), 'lib.rs 缺 pub mod repair');
check('Core 提供 data_dir()', /pub fn data_dir\(&self\) -> &Path/.test(coreLib));
check('Core 提供 repair_check / repair_fix', /pub fn repair_check/.test(coreLib) && /pub fn repair_fix/.test(coreLib));

const tauriLib = read(path.join(appRoot, 'src-tauri', 'src', 'lib.rs'));
check('Tauri 注册 data_dir_check', /fn data_dir_check\(/.test(tauriLib) && /data_dir_check,/.test(tauriLib));
check('Tauri 注册 data_dir_repair', /fn data_dir_repair\(/.test(tauriLib) && /data_dir_repair,/.test(tauriLib));
check('两条命令都委派 core', /core\.repair_check\(\)/.test(tauriLib) && /core\.repair_fix\(\)/.test(tauriLib));

const bridge = read(path.join(appRoot, 'src', 'lib', 'bridge.ts'));
check('桥接有 dataDirCheck', /export async function dataDirCheck/.test(bridge));
check('桥接有 dataDirRepair', /export async function dataDirRepair/.test(bridge));
check('桥接命令名一致', /'data_dir_check'/.test(bridge) && /'data_dir_repair'/.test(bridge));

const drawer = read(path.join(appRoot, 'src', 'components', 'Drawer.tsx'));
check('抽屉有自检分节', /data-testid="repair-section"/.test(drawer));
check('抽屉有检查按钮', /data-testid="repair-check"/.test(drawer));
check('抽屉有修复按钮', /data-testid="repair-fix"/.test(drawer));
check('演示模式两个按钮都禁用', (drawer.match(/disabled=\{[^}]*!isDesktop/g) || []).length >= 2);
check('结果按 code 输出 findings', /data-testid="repair-finding"/.test(drawer) && /data-code=\{f\.code\}/.test(drawer));
check('修复结果单列一块', /data-testid="repair-fixed"/.test(drawer));
check('隔离目录提示', /data-testid="repair-quarantine"/.test(drawer));

const repairLibTs = read(path.join(appRoot, 'src', 'lib', 'repair.ts'));
check('前端整理层按 code 出翻译键', /settings\.repairCode\./.test(repairLibTs));
check('前端整理层有严重度排序', /RANK/.test(repairLibTs));

const locales = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'es-ES'];
const REPAIR_CODES = [
  'missing-root', 'root-is-file', 'missing-dir', 'bad-batch', 'batch-id-mismatch',
  'bad-snapshot', 'snapshot-id-mismatch', 'bad-rule-history', 'leftover-temp', 'orphan-backup',
];
const ACTIONS = ['create-dir', 'quarantine', 'delete-temp'];
for (const locale of locales) {
  const text = read(path.join(appRoot, 'src', 'locales', `${locale}.ts`));
  const missing = [];
  for (const key of ['settings.repairGroup', 'settings.repairCheck', 'settings.repairCheckAction',
    'settings.repairFix', 'settings.repairFixAction', 'settings.repairClean', 'settings.repairSummary',
    'settings.repairFixedSummary', 'settings.repairSkippedSummary', 'settings.repairQuarantine',
    'toast.repairDone', 'toast.repairFail']) {
    if (!text.includes(`'${key}'`)) missing.push(key);
  }
  for (const code of REPAIR_CODES) if (!text.includes(`'settings.repairCode.${code}'`)) missing.push(`code:${code}`);
  for (const action of ACTIONS) if (!text.includes(`'settings.repairAction.${action}'`)) missing.push(`action:${action}`);
  check(`${locale} 文案齐全（${12 + REPAIR_CODES.length + ACTIONS.length} 条）`, missing.length === 0, missing.join(', '));
}

const shellCss = read(path.join(appRoot, 'src', 'styles', 'shell.css'));
check('样式有 .repair-report', /\.repair-report \{/.test(shellCss));
check('样式有 .repair-item 网格', /\.repair-item \{/.test(shellCss) && /grid-template-columns/.test(shellCss));
check('样式有隔离/已修块', /\.repair-fixed/.test(shellCss) && /\.repair-skipped/.test(shellCss));
check('危险/警告配色来自 token', /--ds-color-danger/.test(shellCss) && /--ds-color-warn/.test(shellCss));

const pkg = JSON.parse(read(path.join(appRoot, 'package.json')));
check('package.json 有 test:repair', /test-repair\.mjs/.test(pkg.scripts['test:repair'] || ''), JSON.stringify(pkg.scripts['test:repair']));

const ci = read(path.join(repoRoot, '.github', 'workflows', 'ci.yml'));
check('CI 跑 repair 契约测试', /--test repair_contract/.test(ci));
check('CI 跑 test-repair.mjs', /test-repair\.mjs --require-probe/.test(ci));

const e2e = read(path.join(appRoot, 'e2e', 'run.mjs'));
check('e2e 覆盖自检分节', /repair-section/.test(e2e) && /repair-check/.test(e2e));

// ---------------- C. 文档 ----------------
console.log('C. 文档：与本轮实现同源');

const gap = read(path.join(repoRoot, 'docs', 'FEATURE-GAP.md'));
check('FEATURE-GAP 有 6.15 行', /6\.15/.test(gap), '缺 6.15');
const line615 = (gap.split('\n').find((l) => l.startsWith('| 6.15 ')) || '');
check('6.15 标为 A（已实现）', /A/.test(line615), line615.slice(0, 160));
check('6.15 描述数据目录自检', /自检/.test(line615) && /修复/.test(line615), line615.slice(0, 160));
check('6.13 注明自检已拆出', /6\.15/.test(gap.split('\n').find((l) => l.startsWith('| 6.13 ')) || ''));

const appReadme = read(path.join(appRoot, 'README.md'));
check('app/README 提到数据自检', /数据目录自检|自检与修复/.test(appReadme));

const rootReadme = read(path.join(repoRoot, 'README.md'));
check('根 README 提到自检', /自检/.test(rootReadme));

const agents = read(path.join(repoRoot, 'AGENTS.md'));
check('AGENTS 提到 repair_contract', /repair_contract/.test(agents));

// ---------------- 收尾 ----------------
rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${pass} 项通过，${fail} 项失败`);
if (fail > 0) {
  if (requireProbe) process.exit(1);
  console.log('（探针相关失败可先 cargo build --example repair_probe 再跑）');
  process.exit(1);
}
