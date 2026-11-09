/**
 * 编号规则增强（分组 / 排除 / 按路径取号 / 写入 USERn）与元变量表达式（USER0 / <<#>> 四则 / <IF:…>）
 * 的真实文件验证。
 *
 * 做法：用 TypeScript 的 transpileModule 直接导入 src/lib 下的 vars / rules / validate / preview，
 * 在临时目录建真实文件 → 用 computePreview 得到与新名 → 按预览结果在磁盘上两段式改名 →
 * 校验真实文件名与内容 → 再撤销并校验还原。
 */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'renomio-num-'));
const workDir = mkdtempSync(join(tmpdir(), 'renomio-num-files-'));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else {
    failed += 1;
    failures.push({ name, detail });
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function transpile(name) {
  const source = readFileSync(join(root, 'src', 'lib', `${name}.ts`), 'utf8')
    .replace(/from '\.\.\/i18n'/g, "from './i18n.mjs'")
    .replace(/from '\.\/([a-z]+)'/g, "from './$1.mjs'");
  writeFileSync(
    join(outDir, `${name}.mjs`),
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    }).outputText,
  );
}

writeFileSync(join(outDir, 'i18n.mjs'), 'export function t(key) { return key; }\n');
for (const name of ['vars', 'rules', 'validate', 'preview']) transpile(name);

const { computePreview } = await import(pathToFileURL(join(outDir, 'preview.mjs')).href);
const { ruleError } = await import(pathToFileURL(join(outDir, 'rules.mjs')).href);

const env = {
  os: 'windows',
  separator: '\\',
  caseSensitive: false,
  componentLimit: 255,
  pathWarnThreshold: 240,
  pathHardLimit: 260,
  dataDir: workDir,
  creationTimeWritable: true,
  longPathSupport: true,
};

const numberRule = (over = {}) => ({
  id: 'n1', type: 'number', enabled: true, expression: '<#>', start: 1, step: 1, digits: 3, padChar: '0',
  groupBy: 'parent', exclude: '', byPath: false, writeVar: '', onlyChecked: false, ...over,
});
const addRule = (over = {}) => ({
  id: 'a1', type: 'add', enabled: true, mode: 'direct', text: '_x', anchor: 'start', position: 1, fromEnd: false, padTo: 4, padChar: '0', ...over,
});

const toSlash = (value) => value.split(sep).join('/');

function listing(dir) {
  const out = [];
  const walk = (at) => {
    for (const item of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, item.name);
      if (item.isDirectory()) walk(full);
      else out.push(toSlash(relative(dir, full)));
    }
  };
  walk(dir);
  return out.sort();
}

/** 两段式改名：先全部改成临时名，再落到目标名，避免同批互换失败 */
function twoPhase(pairs) {
  const staged = pairs.map((pair, index) => ({ ...pair, tmp: join(dirname(pair.from), `.renomio-tmp-${index}`) }));
  for (const item of staged) renameSync(item.from, item.tmp);
  for (const item of staged) renameSync(item.tmp, item.to);
}

function buildEntries(caseDir, order) {
  return order.map((rel, index) => {
    const abs = join(caseDir, ...rel.split('/'));
    const stat = statSync(abs);
    return {
      id: `e${index}`,
      path: abs,
      name: abs.split(sep).pop(),
      parent: dirname(abs),
      isDir: false,
      size: stat.size,
      modified: stat.mtimeMs,
      readonly: false,
      selected: true,
    };
  });
}

/**
 * files: { 相对路径: 内容 }
 * order: 文件列表顺序（预览按此顺序处理，除 byPath）
 * expect: { 原相对路径: 期望新相对路径 }
 */
function runCase({ name, files, order, expect, rules, meta, userVars, user0 }) {
  const caseDir = join(workDir, `case-${passed + failed + 1}`);
  mkdirSync(caseDir, { recursive: true });
  for (const rel of order) {
    const abs = join(caseDir, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `id:${rel}`);
  }
  const entries = buildEntries(caseDir, order);
  const metaMap = {};
  for (const [rel, fields] of Object.entries(meta ?? {})) {
    metaMap[join(caseDir, ...rel.split('/'))] = { path: '', taken: '', camera: '', title: '', artist: '', album: '', track: '', ...fields };
  }
  const result = computePreview(entries, rules, {
    env,
    strictWindowsNames: false,
    readonlySkip: true,
    diskExists: {},
    meta: metaMap,
    userVars: userVars ?? [],
    user0: user0 ?? '',
  });
  const rows = new Map(result.rows.map((row) => [toSlash(relative(caseDir, row.entry.path)), row]));
  for (const [rel, wanted] of Object.entries(expect)) {
    const row = rows.get(rel);
    const actual = row ? toSlash(relative(caseDir, join(row.entry.parent, row.newName))) : '(missing)';
    check(`${name}：预览 ${rel} → ${wanted}`, actual === wanted, `actual=${actual} status=${row?.status} ${(row?.reasons ?? []).join('|')}`);
  }

  const pairs = result.rows
    .filter((row) => row.newName !== row.entry.name)
    .map((row) => ({ from: row.entry.path, to: join(row.entry.parent, row.newName) }));
  const uniqueTargets = new Set(pairs.map((pair) => pair.to));
  check(`${name}：目标名无重复`, uniqueTargets.size === pairs.length, pairs.map((pair) => toSlash(relative(caseDir, pair.to))).join(', '));
  if (uniqueTargets.size !== pairs.length) return rows;
  twoPhase(pairs);
  const expectedNames = [...new Set(Object.values(expect))].sort();
  check(`${name}：磁盘真实文件名`, JSON.stringify(listing(caseDir)) === JSON.stringify(expectedNames), listing(caseDir).join(', '));
  const contentsOk = Object.entries(expect).every(([rel, wanted]) => {
    try {
      return readFileSync(join(caseDir, ...wanted.split('/')), 'utf8') === `id:${rel}`;
    } catch {
      return false;
    }
  });
  check(`${name}：改名后内容与原文件对应`, contentsOk);
  twoPhase(pairs.map((pair) => ({ from: pair.to, to: pair.from })));
  check(`${name}：撤销后还原`, JSON.stringify(listing(caseDir)) === JSON.stringify([...order].sort()), listing(caseDir).join(', '));
  return rows;
}

// ---------------- F1：分组 / 排除 / 按路径 / 写入 USERn ----------------

runCase({
  name: '分组-按目录',
  files: { 'd1/a.txt': '', 'd1/b.txt': '', 'd2/a.txt': '', 'd2/b.txt': '' },
  order: ['d1/a.txt', 'd1/b.txt', 'd2/a.txt', 'd2/b.txt'],
  rules: [numberRule({ groupBy: 'parent' })],
  expect: {
    'd1/a.txt': 'd1/001.txt', 'd1/b.txt': 'd1/002.txt',
    'd2/a.txt': 'd2/001.txt', 'd2/b.txt': 'd2/002.txt',
  },
});

runCase({
  name: '分组-不分组',
  files: { 'd1/a.txt': '', 'd1/b.txt': '', 'd2/a.txt': '', 'd2/b.txt': '' },
  order: ['d1/a.txt', 'd1/b.txt', 'd2/a.txt', 'd2/b.txt'],
  rules: [numberRule({ groupBy: 'none' })],
  expect: {
    'd1/a.txt': 'd1/001.txt', 'd1/b.txt': 'd1/002.txt',
    'd2/a.txt': 'd2/003.txt', 'd2/b.txt': 'd2/004.txt',
  },
});

runCase({
  name: '分组-按相机字段',
  files: { 'm/a.jpg': '', 'm/b.jpg': '', 'm/c.jpg': '' },
  order: ['m/a.jpg', 'm/b.jpg', 'm/c.jpg'],
  meta: { 'm/a.jpg': { camera: 'Alpha' }, 'm/b.jpg': { camera: 'Beta' }, 'm/c.jpg': { camera: 'Alpha' } },
  rules: [numberRule({ groupBy: 'field:camera', expression: '<NAME>_<#>' })],
  expect: { 'm/a.jpg': 'm/a_001.jpg', 'm/b.jpg': 'm/b_001.jpg', 'm/c.jpg': 'm/c_002.jpg' },
});

const excludedRows = runCase({
  name: '排除列表（不占号 + 预览标注）',
  files: { 'IMG_1.jpg': '', 'skip_1.jpg': '', 'IMG_2.jpg': '' },
  order: ['IMG_1.jpg', 'skip_1.jpg', 'IMG_2.jpg'],
  rules: [numberRule({ exclude: 'skip_*' })],
  expect: { 'IMG_1.jpg': '001.jpg', 'skip_1.jpg': 'skip_1.jpg', 'IMG_2.jpg': '002.jpg' },
});
{
  const row = excludedRows.get('skip_1.jpg');
  check('排除列表：预览标注排除原因', (row?.reasons ?? []).includes('v.numberExcluded'), (row?.reasons ?? []).join('|'));
}

runCase({
  name: '按路径取号',
  files: { 'c.txt': '', 'a.txt': '', 'b.txt': '' },
  order: ['c.txt', 'a.txt', 'b.txt'],
  rules: [numberRule({ groupBy: 'none', byPath: true })],
  expect: { 'a.txt': '001.txt', 'b.txt': '002.txt', 'c.txt': '003.txt' },
});

runCase({
  name: '按列表顺序取号（对照）',
  files: { 'c.txt': '', 'a.txt': '', 'b.txt': '' },
  order: ['c.txt', 'a.txt', 'b.txt'],
  rules: [numberRule({ groupBy: 'none', byPath: false })],
  expect: { 'c.txt': '001.txt', 'a.txt': '002.txt', 'b.txt': '003.txt' },
});

runCase({
  name: '序号写入 USER1 供后续规则引用',
  files: { 'w/a.txt': '' },
  order: ['w/a.txt'],
  rules: [numberRule({ groupBy: 'none', expression: '<NAME>_<#>', writeVar: 'USER1' }), addRule({ text: '<USER1>_' })],
  expect: { 'w/a.txt': 'w/001_a_001.txt' },
});

runCase({
  name: '序号写入 USER0',
  files: { 'w0/a.txt': '' },
  order: ['w0/a.txt'],
  rules: [numberRule({ groupBy: 'none', expression: '<NAME>_<#>', writeVar: 'USER0' }), addRule({ text: '<USER0>_' })],
  expect: { 'w0/a.txt': 'w0/001_a_001.txt' },
});

// ---------------- F7：USER0 / <<#>> 四则 / <IF:…> ----------------

runCase({
  name: 'USER0 与条件分支',
  files: { 'u/a.jpg': '', 'u/b.png': '' },
  order: ['u/a.jpg', 'u/b.png'],
  user0: 'Z',
  rules: [addRule({ text: '<USER0>_<IF:EXT=jpg|J|X>_' })],
  expect: { 'u/a.jpg': 'u/Z_J_a.jpg', 'u/b.png': 'u/Z_X_b.png' },
});

runCase({
  name: '<<#>+10>> 序号加偏移',
  files: { 'n/a.txt': '', 'n/b.txt': '', 'n/c.txt': '' },
  order: ['n/a.txt', 'n/b.txt', 'n/c.txt'],
  rules: [numberRule({ groupBy: 'none', expression: '<<#>+10>>' })],
  expect: { 'n/a.txt': 'n/011.txt', 'n/b.txt': 'n/012.txt', 'n/c.txt': 'n/013.txt' },
});

runCase({
  name: '<<#> * 2 - 1>> 四则运算',
  files: { 'm2/a.txt': '', 'm2/b.txt': '', 'm2/c.txt': '' },
  order: ['m2/a.txt', 'm2/b.txt', 'm2/c.txt'],
  rules: [numberRule({ groupBy: 'none', start: 2, expression: '<<#> * 2 - 1>>' })],
  expect: { 'm2/a.txt': 'm2/003.txt', 'm2/b.txt': 'm2/005.txt', 'm2/c.txt': 'm2/007.txt' },
});

runCase({
  name: '<<#>> 与 <#> 等价',
  files: { 'e/a.txt': '' },
  order: ['e/a.txt'],
  rules: [numberRule({ groupBy: 'none', digits: 2, expression: '<<#>>' })],
  expect: { 'e/a.txt': 'e/01.txt' },
});

runCase({
  name: '编号表达式里的条件分支',
  files: { 'i/a.txt': '', 'i/b.txt': '', 'i/c.txt': '' },
  order: ['i/a.txt', 'i/b.txt', 'i/c.txt'],
  rules: [numberRule({ groupBy: 'none', expression: '<IF:#>=3|H|L>_<#>' })],
  expect: { 'i/a.txt': 'i/L_001.txt', 'i/b.txt': 'i/L_002.txt', 'i/c.txt': 'i/H_003.txt' },
});

// ---------------- 不可求值：明确报错 + 预览标红（不原样写入） ----------------

{
  const badMath = numberRule({ expression: '<<#>abc>>' });
  check('非法算式报错', String(ruleError(badMath)).includes('badCounterExpr'), String(ruleError(badMath)));
  const badCond = numberRule({ expression: '<IF:|a|b>_<#>' });
  check('非法条件报错', String(ruleError(badCond)).includes('badCondition'), String(ruleError(badCond)));
  const unknownCond = numberRule({ expression: '<IF:foo=1|a|b>_<#>' });
  check('条件引用未知变量报错', String(ruleError(unknownCond)).includes('unknownVar'), String(ruleError(unknownCond)));
  const unknownUser = addRule({ text: '<USER10>' });
  check('USER10 不存在', String(ruleError(unknownUser)).includes('unknownVar'), String(ruleError(unknownUser)));
  const counterInAdd = addRule({ text: '<#>' });
  check('<#> 不能用在添加规则', String(ruleError(counterInAdd)).includes('counterOnlyNumber'), String(ruleError(counterInAdd)));
}

{
  const caseDir = join(workDir, 'case-invalid');
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, 'a.txt'), 'id:a.txt');
  const entries = buildEntries(caseDir, ['a.txt']);
  const result = computePreview(entries, [numberRule({ expression: '<<#>abc>>' })], {
    env, strictWindowsNames: false, readonlySkip: true, diskExists: {},
  });
  const row = result.rows[0];
  check('非法算式：预览标红且改名被跳过', row.status === 'invalid' && row.newName === 'a.txt', `${row.status} ${row.newName} ${row.reasons.join('|')}`);
}

console.log(`\nRESULT ${passed}/${passed + failed} passed, ${failed} failed`);
if (failures.length) console.log(JSON.stringify(failures, null, 2));
rmSync(outDir, { recursive: true, force: true });
rmSync(workDir, { recursive: true, force: true });
process.exitCode = failed === 0 ? 0 : 1;
