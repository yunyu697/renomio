/**
 * 收尾（finalizePreview）与换序增量（reorderRows）自测：纯逻辑断言，不启动 GUI。
 *
 * 做法与 e2e/policy.mjs 相同：用 TypeScript 的 transpileModule 把 preview.ts 及其依赖
 * （rules / validate / vars）转成 ESM 后直接导入；i18n 换成保留 key 的桩，便于断言具体原因。
 *
 * 重点覆盖：
 * - 两遍收尾与旧实现（按行 map + 多次 filter）逐条语义等价，含随机表对照；
 * - 批次内重名、目标已存在且源在本批、排除列表、未选中、规则 off；
 * - 换序后只重算号码变了的行，结果与全量重算一致。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'renomio-preview-'));

writeFileSync(
  join(outDir, 'i18n.mjs'),
  'export function t(key, params = {}) { return key + ":" + Object.entries(params).map(([k, v]) => k + "=" + v).join(","); }\n',
);

function transpile(name) {
  const source = readFileSync(join(root, 'src', 'lib', `${name}.ts`), 'utf8')
    .replace("from '../i18n'", "from './i18n.mjs'")
    .replace(/from '\.\/(rules|validate|vars|types|metaFields|mapTable|encoding|script|codepage)'/g, "from './$1.mjs'")
    .replace("from 'iconv-lite'", `from '${pathToFileURL(join(root, 'node_modules', 'iconv-lite', 'lib', 'index.js')).href}'`)
    .replace("from 'opencc-js/cn2t'", `from '${pathToFileURL(join(root, 'node_modules', 'opencc-js', 'dist', 'esm', 'cn2t.js')).href}'`)
    .replace("from 'opencc-js/t2cn'", `from '${pathToFileURL(join(root, 'node_modules', 'opencc-js', 'dist', 'esm', 't2cn.js')).href}'`);
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const file = join(outDir, `${name}.mjs`);
  writeFileSync(file, out);
  return pathToFileURL(file).href;
}

const urls = {
  preview: transpile('preview'),
  rules: transpile('rules'),
  validate: transpile('validate'),
  vars: transpile('vars'),
  metaFields: transpile('metaFields'),
  mapTable: transpile('mapTable'),
  encoding: transpile('encoding'),
  script: transpile('script'),
  codepage: transpile('codepage'),
};
const P = await import(urls.preview);
const V = await import(urls.validate);
const { t } = await import(pathToFileURL(join(outDir, 'i18n.mjs')).href);

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

const env = {
  os: 'windows',
  separator: '\\',
  caseSensitive: false,
  componentLimit: 255,
  pathWarnThreshold: 1000,
  pathHardLimit: 32767,
  dataDir: '',
  creationTimeWritable: true,
  longPathSupport: true,
};
const DIR = 'D:\\renomio';
const optsOf = (extra = {}) => ({
  env, strictWindowsNames: true, readonlySkip: false, diskExists: {}, ...extra,
});

let serial = 0;
function entry(name, extra = {}) {
  serial += 1;
  const path = `${DIR}\\${name}`;
  return {
    id: `${path}#${serial}`,
    path,
    name,
    parent: DIR,
    isDir: false,
    size: 10,
    modified: 1700000000000,
    readonly: false,
    selected: true,
    ...extra,
  };
}

const numberRule = (extra = {}) => ({
  id: 'n1',
  type: 'number',
  enabled: true,
  expression: '<#>',
  start: 1,
  step: 1,
  digits: 2,
  padChar: '0',
  groupBy: 'none',
  exclude: '',
  byPath: false,
  writeVar: '',
  onlyChecked: false,
  ...extra,
});

const normPath = (path) => V.normalizePath(path, env);

/** 旧版收尾：整体复制 + 独立的全表 filter。作为两遍扫描的语义基准 */
function referenceFinalize(built, opts) {
  const rows = built.map((item) => ({ ...item.row, status: item.status, reasons: [...item.reasons] }));

  const claimed = new Map();
  rows.forEach((row, index) => {
    if (row.entry.selected && row.newName !== row.entry.name && row.status !== 'invalid' && row.status !== 'off') {
      const key = `${V.normalizePath(row.entry.parent, opts.env)}|${V.normalizePath(row.newName, opts.env)}`;
      const previous = claimed.get(key);
      if (previous !== undefined) {
        row.status = 'conflict';
        row.reasons = [t('v.duplicate', { row: previous + 1 })];
      } else {
        claimed.set(key, index);
      }
    }
  });

  const movingSources = new Set(
    rows
      .filter((r) => r.entry.selected && r.newName !== r.entry.name)
      .map((r) => V.normalizePath(r.entry.path, opts.env)),
  );

  for (const row of rows) {
    if (row.entry.selected && row.newName !== row.entry.name && row.status !== 'invalid' && row.status !== 'off') {
      const target = V.targetPath(row.entry.parent, row.newName, opts.env);
      const targetKey = V.normalizePath(target, opts.env);
      const sourceKey = V.normalizePath(row.entry.path, opts.env);
      if (opts.diskExists[targetKey] && targetKey !== sourceKey && !movingSources.has(targetKey)) {
        row.status = 'conflict';
        row.reasons = [t('v.exists')];
      }
    }
  }

  const counts = {
    total: rows.length,
    selected: rows.filter((r) => r.entry.selected).length,
    ready: rows.filter((r) => r.status === 'ready').length,
    conflict: rows.filter((r) => r.status === 'conflict').length,
    warn: rows.filter((r) => r.status === 'warn').length,
    invalid: rows.filter((r) => r.status === 'invalid').length,
    unchanged: rows.filter((r) => r.status === 'unchanged').length,
    off: rows.filter((r) => r.status === 'off').length,
  };
  return { rows, counts };
}

const shape = (row) => `${row.entry.id}\u0000${row.status}\u0000${row.newName}\u0000${row.reasons.join('|')}`;
function sameResult(a, b) {
  if (a.rows.length !== b.rows.length) return false;
  if (JSON.stringify(a.counts) !== JSON.stringify(b.counts)) return false;
  return a.rows.every((row, i) => shape(row) === shape(b.rows[i]));
}

// 1. 批次内重名：先到先占，后到者引用先占行的行号
{
  const list = [entry('a1.txt'), entry('a2.txt'), entry('a3.txt')];
  const nameOverrides = {};
  for (const item of list) nameOverrides[item.path] = 'same.txt';
  const result = P.computePreview(list, [], optsOf({ nameOverrides }));
  check('批次内重名：首个占位为 ready', result.rows[0].status === 'ready', result.rows[0].status);
  check('批次内重名：后到者为 conflict',
    result.rows[1].status === 'conflict' && result.rows[2].status === 'conflict',
    `${result.rows[1].status}/${result.rows[2].status}`);
  check('批次内重名：原因指向先占行', result.rows[1].reasons[0] === t('v.duplicate', { row: 1 }), result.rows[1].reasons[0]);
  check('批次内重名：计数', result.counts.ready === 1 && result.counts.conflict === 2,
    JSON.stringify(result.counts));
}

// 2. 目标已存在（磁盘）：同批次的源会被先移走，不算冲突
{
  const source = entry('a.txt');
  const target = entry('b.txt');
  const diskExists = { [normPath(`${DIR}\\b.txt`)]: true };
  const nameOverrides = { [source.path]: 'b.txt', [target.path]: 'c.txt' };

  const both = P.computePreview([source, target], [], optsOf({ nameOverrides, diskExists }));
  check('目标已存在且源在本批：两行都不冲突',
    both.rows.every((r) => r.status === 'ready'), both.rows.map((r) => `${r.status}:${r.reasons.join('|')}`).join(' / '));

  const sourceOff = P.computePreview([source, { ...target, selected: false }], [], optsOf({ nameOverrides, diskExists }));
  check('目标已存在且源未选中：判冲突',
    sourceOff.rows[0].status === 'conflict' && sourceOff.rows[0].reasons[0] === t('v.exists'),
    `${sourceOff.rows[0].status}:${sourceOff.rows[0].reasons[0]}`);

  const sourceStays = P.computePreview([source, entry('b.txt')], [], optsOf({
    nameOverrides: { [source.path]: 'b.txt' },
    diskExists,
  }));
  check('目标已存在且源不改名：判冲突', sourceStays.rows[0].status === 'conflict', sourceStays.rows[0].status);
}

// 3. 排除列表：命中项不占号，也不改名
{
  const list = [entry('a.txt'), entry('skip.tmp'), entry('b.txt')];
  const result = P.computePreview(list, [numberRule({ exclude: '*.tmp' })], optsOf());
  check('排除列表：命中项保持原名', result.rows[1].newName === 'skip.tmp' && result.rows[1].status === 'unchanged',
    `${result.rows[1].newName}/${result.rows[1].status}`);
  check('排除列表：给出排除原因', result.rows[1].reasons.includes(t('v.numberExcluded')), result.rows[1].reasons.join('|'));
  check('排除列表：命中项不占号',
    result.rows[0].newName === '01.txt' && result.rows[2].newName === '02.txt',
    `${result.rows[0].newName}/${result.rows[2].newName}`);
}

// 4. 未选中：保持 off，不占重名位
{
  const list = [entry('u1.txt', { selected: false }), entry('u2.txt')];
  const nameOverrides = { [list[0].path]: 'same.txt', [list[1].path]: 'same.txt' };
  const result = P.computePreview(list, [], optsOf({ nameOverrides }));
  check('未选中：状态为 off', result.rows[0].status === 'off', result.rows[0].status);
  check('未选中：不占重名位', result.rows[1].status === 'ready', result.rows[1].status);
  check('未选中：计数', result.counts.selected === 1 && result.counts.off === 1, JSON.stringify(result.counts));
}

// 5. 规则 off：整条规则不生效
{
  const list = [entry('a.txt'), entry('b.txt')];
  const result = P.computePreview(list, [numberRule({ enabled: false })], optsOf());
  check('规则 off：不改名', result.rows.every((r) => r.newName === r.entry.name && r.status === 'unchanged'),
    result.rows.map((r) => `${r.newName}/${r.status}`).join(' / '));
}

// 6. 随机表对照：两遍扫描与旧实现逐条一致
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCase(seed) {
  const rand = mulberry32(seed);
  const list = [];
  const nameOverrides = {};
  const diskExists = {};
  for (let i = 0; i < 24; i += 1) {
    const bad = rand() < 0.08;
    const name = bad
      ? `bad:${i}.txt`
      : `f${Math.floor(rand() * 5)}.${rand() < 0.2 ? 'tmp' : 'txt'}`;
    const item = entry(name, { selected: rand() > 0.12 });
    list.push(item);
    if (rand() < 0.5) nameOverrides[item.path] = `t${Math.floor(rand() * 8)}.txt`;
    if (rand() < 0.3) diskExists[normPath(`${DIR}\\t${Math.floor(rand() * 8)}.txt`)] = true;
  }
  const rules = rand() < 0.5 ? [numberRule({ exclude: '*.tmp' })] : [];
  return { list, rules, opts: optsOf({ nameOverrides, diskExists }) };
}

{
  let mismatch = 0;
  let nonTrivial = 0;
  for (let seed = 1; seed <= 300; seed += 1) {
    const { list, rules, opts } = randomCase(seed);
    const built = P.buildPreviewRows(list, rules, opts);
    const next = P.finalizePreview(built, opts);
    const ref = referenceFinalize(built, opts);
    if (!sameResult(next, ref)) {
      mismatch += 1;
      if (mismatch === 1) {
        const at = next.rows.findIndex((row, i) => shape(row) !== shape(ref.rows[i]));
        console.log(`    首个差异 seed=${seed} index=${at} new=${shape(next.rows[at])} old=${shape(ref.rows[at])}`);
      }
    }
    if (next.counts.conflict > 0 || next.counts.off > 0 || next.counts.invalid > 0) nonTrivial += 1;
  }
  check('随机表 300 组与旧实现逐条一致', mismatch === 0, `不一致 ${mismatch} 组`);
  check('随机表确实覆盖到冲突 / 未选中 / 非法', nonTrivial >= 100, `有效样本 ${nonTrivial} 组`);
}

// 7. 换序增量：只重算号码变了的行，结果与全量重算一致
{
  const list = Array.from({ length: 200 }, (_, i) => entry(`p${String(i).padStart(3, '0')}.txt`));
  const rules = [numberRule()];
  const opts = optsOf();
  const plans1 = P.planNumbers(list, rules, opts);
  const built1 = P.buildPreviewRows(list, rules, opts, plans1, null);
  const oldById = new Map(built1.map((item) => [item.id, item]));

  const moved = list.slice();
  const [picked] = moved.splice(10, 1);
  moved.splice(11, 0, picked);
  const plans2 = P.planNumbers(moved, rules, opts);
  const inc = P.reorderRows(moved, rules, opts, plans2, null, {
    built: built1,
    numbers: P.numbersFor(list, plans1),
  });
  const rebuilt = inc.built.filter((item) => oldById.get(item.id) !== item).length;
  check('同屏内移动一格：只重算 2 行', rebuilt === 2, `重算 ${rebuilt} 行`);

  const full = P.buildPreviewRows(moved, rules, opts, plans2, null);
  check('增量结果与全量重算一致（逐条）',
    inc.built.every((item, i) => item.row.newName === full[i].row.newName
      && item.status === full[i].status
      && JSON.stringify(item.reasons) === JSON.stringify(full[i].reasons)),
    '逐条比对失败');
  check('增量结果与全量重算一致（收尾计数）',
    sameResult(P.finalizePreview(inc.built, opts), P.finalizePreview(full, opts)),
    '计数比对失败');

  // 跨 150 行：号码区间整体平移，增量仍须与全量重算等价
  const far = list.slice();
  const [farPicked] = far.splice(10, 1);
  far.splice(160, 0, farPicked);
  const plans3 = P.planNumbers(far, rules, opts);
  const incFar = P.reorderRows(far, rules, opts, plans3, null, {
    built: built1,
    numbers: P.numbersFor(list, plans1),
  });
  const fullFar = P.buildPreviewRows(far, rules, opts, plans3, null);
  check('跨 150 行移动：增量与全量重算一致',
    incFar.built.every((item, i) => item.row.newName === fullFar[i].row.newName && item.status === fullFar[i].status),
    '逐条比对失败');
}

rmSync(outDir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
