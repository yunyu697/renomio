/**
 * 正则替换的真实文件端到端闭环（3.3 缺口 A 级证据）。
 *
 * 链路：真实规则引擎（src/lib/rules.ts，esbuild 就地打包）算出新名
 *   → 计划 JSON（与前端 apply_plan 同形状）
 *   → renomio-core 的 plan_probe 走真实两阶段改名（日志 + 备份 + 冲突策略）
 *   → 回到 Node 侧核对磁盘：文件名、目录名、文件内容、未命中文件是否原样
 *   → 再走真实撤销，核对是否逐条还原。
 *
 * 只用临时目录，不碰用户文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const coreRoot = path.join(appRoot, 'src-tauri');

const bundle = path.join(appRoot, 'node_modules', '.cache', 'regex-real-test.mjs');
buildSync({
  entryPoints: [path.join(appRoot, 'src', 'lib', 'rules.ts')],
  bundle: true,
  format: 'esm',
  outfile: bundle,
  logLevel: 'silent',
});
const { applyRules, splitName, joinName, ruleError } = await import(pathToFileURL(bundle).href);

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

const ctx = { vars: {}, nextNumber: () => 1, peekNumber: () => 1 };
const rule = (over) => ({
  id: over.id ?? 'r',
  type: 'replace',
  enabled: true,
  find: '',
  replace: '',
  caseSensitive: false,
  regex: true,
  nth: 0,
  ...over,
});

/** 生产口径：先切主名/扩展名，规则只作用于主名，再拼回。 */
const previewName = (name, isDir, rules) => {
  const split = splitName(name, isDir);
  const out = applyRules(split, isDir, rules, '', ctx, true);
  return joinName(out.stem, out.ext);
};

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const base = path.join(os.tmpdir(), `renomio-regex-real-${stamp}`);
const workRoot = path.join(base, 'files');
const dataDir = path.join(base, 'data');
fs.mkdirSync(workRoot, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const probe = (args) => {
  const r = spawnSync('cargo', ['run', '-q', '--manifest-path', path.join('renomio-core', 'Cargo.toml'), '--example', 'plan_probe', '--', ...args], {
    cwd: coreRoot,
    encoding: 'utf8',
    env: { ...process.env, CARGO_TERM_PROGRESS_WHEN: 'never' },
  });
  if (r.status !== 0) {
    return { ok: false, error: `exit ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(0, 400)}` };
  }
  const outFile = args[args.length - 1];
  const raw = fs.readFileSync(outFile, 'utf8');
  return JSON.parse(raw);
};

const writeFile = (rel, content) => {
  const p = path.join(workRoot, rel);
  fs.writeFileSync(p, content);
  return p;
};

// ---------- 场景 A：Delphi 分组引用 + 目录名，真实两阶段改名 + 撤销 ----------
const rulesA = [
  rule({ id: 'a1', find: '^IMG_(\\d{4})-(\\d{3})$', replace: '\\2_\\1' }),
  rule({ id: 'a2', find: '^Trip (\\d{4})$', replace: '行\\1' }),
];
const filesA = [
  ['IMG_2024-001.jpg', 'alpha-content'],
  ['IMG_2024-002.jpg', 'beta-content'],
  ['照片001.png', 'untouched-content'],
];
for (const [name, content] of filesA) writeFile(name, content);
const dirA = 'Trip 2024';
fs.mkdirSync(path.join(workRoot, dirA));
writeFile(path.join(dirA, 'inside.txt'), 'inside-content');

const planA = [
  { name: 'IMG_2024-001.jpg', isDir: false },
  { name: 'IMG_2024-002.jpg', isDir: false },
  { name: dirA, isDir: true },
].map(({ name, isDir }) => ({
  id: name,
  source: path.join(workRoot, name),
  targetName: previewName(name, isDir, rulesA),
  isDir,
}));

check('引擎：IMG_2024-001.jpg → 001_2024.jpg', planA[0].targetName === '001_2024.jpg', planA[0].targetName);
check('引擎：IMG_2024-002.jpg → 002_2024.jpg', planA[1].targetName === '002_2024.jpg', planA[1].targetName);
check('引擎：目录 Trip 2024 → 行2024', planA[2].targetName === '行2024', planA[2].targetName);
check('未命中文件不进计划（照片001.png 原样）', !planA.some((i) => i.source.endsWith('照片001.png')));

const planPathA = path.join(base, 'plan-a.json');
const outPathA = path.join(base, 'out-a.json');
fs.writeFileSync(
  planPathA,
  JSON.stringify({
    dataDir,
    items: planA,
    options: { policy: 'skip', skipReadonly: false, windowsSafe: true, roots: [workRoot] },
  }),
);

const appliedA = probe(['apply', planPathA, outPathA]);
check('真实改名：probe 返回 ok', appliedA.ok === true, JSON.stringify(appliedA).slice(0, 300));
const outcomeA = appliedA.outcome ?? {};
check('真实改名：3 条全部执行、0 失败', (outcomeA.applied ?? []).length === 3 && (outcomeA.failed ?? []).length === 0,
  `applied=${(outcomeA.applied ?? []).length} failed=${(outcomeA.failed ?? []).length}`);
check('真实改名：批次号非空（供撤销）', typeof outcomeA.batch?.id === 'string' && outcomeA.batch.id.length > 0, String(outcomeA.batch?.id));

const read = (rel) => {
  const p = path.join(workRoot, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};
check('磁盘：IMG_2024-001.jpg → 001_2024.jpg，内容逐字节不变',
  read('001_2024.jpg') === 'alpha-content' && read('IMG_2024-001.jpg') === null,
  String(read('001_2024.jpg')));
check('磁盘：IMG_2024-002.jpg → 002_2024.jpg，内容逐字节不变',
  read('002_2024.jpg') === 'beta-content' && read('IMG_2024-002.jpg') === null);
check('磁盘：目录 Trip 2024 → 行2024，目录内文件内容不变',
  read('行2024/inside.txt') === 'inside-content' && !fs.existsSync(path.join(workRoot, dirA)),
  String(read('行2024/inside.txt')));
check('磁盘：未命中文件 照片001.png 原样保留', read('照片001.png') === 'untouched-content');

const undoPathA = path.join(base, 'undo-a.json');
const undoA = probe(['undo', dataDir, outcomeA.batch?.id ?? '', undoPathA]);
check('真实撤销：probe 返回 ok 且 3 条还原', undoA.ok === true && (undoA.outcome?.restored ?? []).length === 3,
  `restored=${(undoA.outcome?.restored ?? []).length}`);
check('真实撤销：文件名逐条还原、内容不变',
  read('IMG_2024-001.jpg') === 'alpha-content' && read('IMG_2024-002.jpg') === 'beta-content');
check('真实撤销：目录名还原且内部文件仍在',
  read(`${dirA}/inside.txt`) === 'inside-content' && !fs.existsSync(path.join(workRoot, '行2024')));

// ---------- 场景 B：\0 整段匹配 + 第 n 个匹配的分组展开 ----------
const rulesB = [
  rule({ id: 'b1', find: '\\d{4}', replace: 'Y\\0Y' }),
  rule({ id: 'b2', find: '(\\d)', replace: '[\\1]', nth: 2 }),
];
const filesB = [
  ['abc1234.txt', 'one'],
  ['x2025y.txt', 'two'],
];
const base2 = path.join(base, 'files-b');
fs.mkdirSync(base2, { recursive: true });
for (const [name, content] of filesB) fs.writeFileSync(path.join(base2, name), content);

const planB = filesB.map(([name]) => ({ name }));
const namesB = planB.map(({ name }) => previewName(name, false, rulesB));
check('引擎：\\0 整段匹配 + 第 2 个匹配展开 → abcY1[2]34Y.txt', namesB[0] === 'abcY1[2]34Y.txt', namesB[0]);
check('引擎：\\0 整段匹配 + 第 2 个匹配展开 → xY2[0]25Yy.txt', namesB[1] === 'xY2[0]25Yy.txt', namesB[1]);
check('引擎：非正则规则里 \\0 保持字面',
  applyRules({ stem: 'a', ext: 'txt' }, false, [{ ...rule({ find: 'a', replace: '\\0x', regex: false }) }], '', ctx, true).stem === '\\0x');

const planPathB = path.join(base, 'plan-b.json');
const outPathB = path.join(base, 'out-b.json');
fs.writeFileSync(
  planPathB,
  JSON.stringify({
    dataDir,
    items: planB.map(({ name }, i) => ({
      id: name,
      source: path.join(base2, name),
      targetName: namesB[i],
      isDir: false,
    })),
    options: { policy: 'skip', skipReadonly: false, windowsSafe: true, roots: [base2] },
  }),
);
const appliedB = probe(['apply', planPathB, outPathB]);
check('真实改名：\\0/nth 计划执行成功', appliedB.ok === true && (appliedB.outcome?.applied ?? []).length === 2,
  JSON.stringify(appliedB).slice(0, 300));
const readB = (name) => {
  const p = path.join(base2, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};
check('磁盘：abcY1[2]34Y.txt 内容不变', readB('abcY1[2]34Y.txt') === 'one' && !fs.existsSync(path.join(base2, 'abc1234.txt')));
check('磁盘：xY2[0]25Yy.txt 内容不变', readB('xY2[0]25Yy.txt') === 'two' && !fs.existsSync(path.join(base2, 'x2025y.txt')));
check('规则校验：有效规则不报错', ruleError(rulesB[0]) === null && ruleError(rulesB[1]) === null);

fs.rmSync(base, { recursive: true, force: true });

console.log(`\n正则真实文件闭环：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
