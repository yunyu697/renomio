/**
 * 智能更名最小策略面板验证（默认值对照 + 真实文件）。
 *
 * 做法：把 src/lib/preview.ts（及其依赖 rules.ts / validate.ts / vars.ts）用
 * TypeScript 的 transpileModule 转成 ESM 后直接导入，在临时目录建真实文件，
 * 用 fs.stat 的真实元数据构造 Entry，断言预览结果；超长截断还会真实改名落盘再还原。
 * 同时解析 src/runtime.ts 的默认值，保证「老配置升级后行为不突变」。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'renomio-policy-'));
const workDir = mkdtempSync(join(tmpdir(), 'renomio-policy-files-'));
let passed = 0;
let failed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = typeof actual === 'function' ? actual() : Object.is(actual, expected);
  if (ok) passed += 1;
  else failed += 1, failures.push({ name, actual, expected });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `  actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
}

function transpile(name) {
  const source = readFileSync(join(root, 'src', 'lib', `${name}.ts`), 'utf8')
    .replace("from '../i18n'", "from './i18n.mjs'")
    .replace(/from '\.\/(rules|validate|vars|types)'/g, "from './$1.mjs'");
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  writeFileSync(join(outDir, `${name}.mjs`), out);
  return pathToFileURL(join(outDir, `${name}.mjs`)).href;
}

// i18n stub：保留 key 与参数，便于断言具体原因
writeFileSync(
  join(outDir, 'i18n.mjs'),
  'export function t(key, params = {}) { return key + ":" + Object.entries(params).map(([k, v]) => k + "=" + v).join(","); }\n',
);

const urls = {
  preview: transpile('preview'),
  rules: transpile('rules'),
  validate: transpile('validate'),
  vars: transpile('vars'),
};
for (const name of ['rules', 'validate', 'vars']) {
  if (!existsSync(join(outDir, `${name}.mjs`))) throw new Error(`缺少转译产物 ${name}.mjs`);
}

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

const folder = join(workDir, '政策测试');
mkdirSync(folder, { recursive: true });

const base = { id: 'r1', enabled: true };
const rule = {
  replace: (id, find, replace, extra = {}) => ({
    ...base, id, type: 'replace', find, replace, caseSensitive: false, regex: false, nth: 0, ...extra,
  }),
  ext: (id, mode, value = '') => ({ ...base, id, type: 'ext', mode, value, position: 'suffix', caseMode: 'upper' }),
};

function makeFile(name, content = 'x') {
  const path = join(folder, name);
  writeFileSync(path, content);
  return path;
}

function entryOf(name, extra = {}) {
  const path = join(folder, name);
  const st = statSync(path);
  return {
    id: path, path, name, parent: folder, isDir: false,
    size: st.size, modified: st.mtimeMs, readonly: false, selected: true, ...extra,
  };
}

/** 只存在于内存的条目（用于磁盘上无法创建的名称，如含 Windows 非法字符） */
function virtualEntry(name, extra = {}) {
  const path = join(folder, name);
  return {
    id: path, path, name, parent: folder, isDir: false,
    size: 1, modified: Date.now(), readonly: false, selected: true, ...extra,
  };
}

const defaults = { env, strictWindowsNames: true, readonlySkip: false, diskExists: {} };

const longStem = 'a'.repeat(250);
const longName = `${longStem}.txt`; // 254 字符，磁盘可创建

const files = {
  normal: makeFile('photo.jpg'),
  long: makeFile(longName),
  secret: makeFile('.secret.txt'),
  system: makeFile('desktop.ini', '[.ShellClassInfo]'),
  notes: makeFile('notes.txt', 'note'),
  readonly: makeFile('readonly.txt', 'lock'),
};
chmodSync(files.readonly, 0o444);
const readonlyEntry = entryOf('readonly.txt', { readonly: true });

function reasonsOf(row) {
  return row.reasons.join(' | ');
}

/** 解析 runtime.ts 默认值，做「默认值与当前行为一致」的对照 */
function runtimeDefaults() {
  const source = readFileSync(join(root, 'src', 'runtime.ts'), 'utf8');
  const pick = (key) => {
    const match = new RegExp(`${key}:\\s*([^,\\n]+)`).exec(source);
    return match ? match[1].trim() : '';
  };
  return {
    nameMaxLength: Number(pick('nameMaxLength')),
    longNameAction: pick('longNameAction').replace(/['"]/g, ''),
    emptyNameAction: pick('emptyNameAction').replace(/['"]/g, ''),
    emptyNameFallback: pick('emptyNameFallback').replace(/['"]/g, ''),
    skipSystemHidden: pick('skipSystemHidden') === 'true',
    replaceInvalid: pick('replaceInvalid') === 'true',
    readonlySkip: pick('readonlySkip') === 'true',
    invalidReplacement: pick('invalidReplacement').replace(/['"]/g, ''),
  };
}

async function main() {
  const { computePreview } = await import(urls.preview);

  // 1) 默认值对照
  const rt = runtimeDefaults();
  check('defaults.nameMaxLength=255', rt.nameMaxLength, 255);
  check('defaults.longNameAction=block', rt.longNameAction, 'block');
  check('defaults.emptyNameAction=block', rt.emptyNameAction, 'block');
  check('defaults.emptyNameFallback=未命名', rt.emptyNameFallback, '未命名');
  check('defaults.skipSystemHidden=false', rt.skipSystemHidden, false);
  check('defaults.replaceInvalid=false', rt.replaceInvalid, false);
  check('defaults.readonlySkip=false', rt.readonlySkip, false);
  check('defaults.invalidReplacement=_', rt.invalidReplacement, '_');

  // 2) 默认行为不变：普通文件按规则改名
  const normal = computePreview(
    [entryOf('photo.jpg')],
    [rule.replace('r1', 'photo', 'holiday')],
    defaults,
  ).rows[0];
  check('normal.ready', normal.status, 'ready');
  check('normal.newName', normal.newName, 'holiday.jpg');

  // 3) 超长 + 默认 block：阻止且不截断
  const longBlock = computePreview(
    [entryOf(longName)],
    [rule.replace('r1', 'a', 'b')],
    { ...defaults, nameMaxLength: 100, longNameAction: 'block' },
  ).rows[0];
  check('longBlock.invalid', longBlock.status, 'invalid');
  check('longBlock.noTruncate', longBlock.newName.length, 254);
  check('longBlock.reason', longBlock.reasons.some((r) => r.startsWith('v.charLimit')), true);

  // 4) 超长 + truncate：截断主体、保留扩展名（真实改名落盘再还原）
  const longTrunc = computePreview(
    [entryOf(longName)],
    [rule.replace('r1', 'a', 'b')],
    { ...defaults, nameMaxLength: 100, longNameAction: 'truncate' },
  ).rows[0];
  check('longTrunc.warn', longTrunc.status, 'warn');
  check('longTrunc.length=100', longTrunc.newName.length, 100);
  check('longTrunc.extKept', longTrunc.newName.endsWith('.txt'), true);
  check('longTrunc.reason', longTrunc.reasons.some((r) => r.startsWith('v.truncated')), true);
  renameSync(files.long, join(folder, longTrunc.newName));
  check('longTrunc.diskRename', () => existsSync(join(folder, longTrunc.newName)) && !existsSync(files.long), true);
  renameSync(join(folder, longTrunc.newName), files.long);
  check('longTrunc.diskRestored', () => existsSync(files.long) && !existsSync(join(folder, longTrunc.newName)), true);

  // 5) 自定义上限只能收紧，不能突破平台上限
  const clamp = computePreview(
    [virtualEntry(`${'c'.repeat(300)}.txt`)],
    [rule.replace('r1', 'c', 'd')],
    { ...defaults, nameMaxLength: 300, longNameAction: 'truncate' },
  ).rows[0];
  check('clamp.length=255', clamp.newName.length, 255);
  check('clamp.extKept', clamp.newName.endsWith('.txt'), true);

  // 6) 空名默认 block
  const emptyRules = [rule.replace('r1', '^.*$', '', { regex: true }), rule.ext('r2', 'remove')];
  const emptyBlock = computePreview([entryOf('notes.txt')], emptyRules, defaults).rows[0];
  check('emptyBlock.newName', emptyBlock.newName, '');
  check('emptyBlock.invalid', emptyBlock.status, 'invalid');
  check('emptyBlock.reason', emptyBlock.reasons.some((r) => r.startsWith('v.empty')), true);

  // 7) 空名 fallback
  const fallback = computePreview([entryOf('notes.txt')], emptyRules, {
    ...defaults, emptyNameAction: 'fallback', emptyNameFallback: '未命名',
  }).rows[0];
  check('fallback.newName', fallback.newName, '未命名');
  check('fallback.warn', fallback.status, 'warn');
  check('fallback.reason', fallback.reasons.some((r) => r.startsWith('v.emptyFallback')), true);

  // 8) fallback 为空串时仍按 block 处理（不会产生空名）
  const fallbackEmpty = computePreview([entryOf('notes.txt')], emptyRules, {
    ...defaults, emptyNameAction: 'fallback', emptyNameFallback: '   ',
  }).rows[0];
  check('fallbackEmpty.invalid', fallbackEmpty.status, 'invalid');

  // 9) 隐藏文件默认照常处理
  const hiddenDefault = computePreview(
    [entryOf('.secret.txt')],
    [rule.replace('r1', 'secret', 'public')],
    defaults,
  ).rows[0];
  check('hiddenDefault.ready', hiddenDefault.status, 'ready');
  check('hiddenDefault.newName', hiddenDefault.newName, '.public.txt');

  // 10) 隐藏文件在 skipSystemHidden=true 时跳过（不计入执行）
  const hiddenSkip = computePreview(
    [entryOf('.secret.txt', { hidden: true })],
    [rule.replace('r1', 'secret', 'public')],
    { ...defaults, skipSystemHidden: true },
  ).rows[0];
  check('hiddenSkip.off', hiddenSkip.status, 'off');
  check('hiddenSkip.reason', hiddenSkip.reasons.some((r) => r.startsWith('v.hiddenSkipped')), true);

  // 11) 系统属性文件同样跳过
  const systemSkip = computePreview(
    [entryOf('desktop.ini', { system: true })],
    [rule.ext('r1', 'fixed', 'cfg')],
    { ...defaults, skipSystemHidden: true },
  ).rows[0];
  check('systemSkip.off', systemSkip.status, 'off');

  // 12) 非法字符：默认不替换 → 阻止；开启替换 → 放行并给出提示
  const badChar = computePreview([virtualEntry('a:b.txt')], [], defaults).rows[0];
  check('badChar.invalid', badChar.status, 'invalid');
  check('badChar.reason', badChar.reasons.some((r) => r.startsWith('v.invalidChar')), true);
  const replaced = computePreview([virtualEntry('a:b.txt')], [], {
    ...defaults, replaceInvalid: true, invalidReplacement: '_',
  }).rows[0];
  check('badChar.replacedName', replaced.newName, 'a_b.txt');
  check('badChar.replacedReason', replaced.reasons.some((r) => r.startsWith('v.replaced')), true);

  // 13) 只读：默认照常处理（提示），开启跳过策略后追加跳过提示
  const ro = computePreview([readonlyEntry], [rule.replace('r1', 'readonly', 'locked')], defaults).rows[0];
  check('readonly.default.ready', ro.status, 'warn');
  check('readonly.default.reason', ro.reasons.some((r) => r.startsWith('v.readonly')), true);
  const roSkip = computePreview([readonlyEntry], [rule.replace('r1', 'readonly', 'locked')], {
    ...defaults, readonlySkip: true,
  }).rows[0];
  check('readonly.skipReason', roSkip.reasons.some((r) => r.startsWith('v.readonlySkip')), true);

  // 14) 无规则时保持 unchanged
  const unchanged = computePreview([entryOf('photo.jpg')], [], defaults).rows[0];
  check('unchanged.status', unchanged.status, 'unchanged');

  chmodSync(files.readonly, 0o666);
  console.log(`RESULT policy passed=${passed} failed=${failed}`);
  if (failed) {
    for (const item of failures) console.log(`  - ${item.name}: actual=${JSON.stringify(item.actual)} expected=${JSON.stringify(item.expected)}`);
  }
  return failed === 0;
}

main()
  .catch((err) => {
    console.error('policy.mjs 异常：', err);
    return false;
  })
  .then((ok) => {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    if (!ok) process.exitCode = 1;
  });
