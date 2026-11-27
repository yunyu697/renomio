/**
 * 编码转换规则（3.13「高级规则 · 编码转换」）自测：
 * A 段纯函数（NFC/NFD/NFKC/NFKD、全半角、UTF-8 乱码修复、幂等与安全边界）
 * B 段引擎接线（applyRules 真跑、ruleError、ruleSummary、默认值、类型表、旧存档补齐）
 * C 段界面与五语种（编辑器控件、示例行、14 个键 × 5 语种）
 * D 段文档同源（FEATURE-GAP 3.13、语义清单、README 与 package.json）。
 */
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const outDir = path.join(appRoot, 'node_modules', '.cache', 'encoding-test');
buildSync({
  entryPoints: [
    path.join(appRoot, 'src', 'lib', 'encoding.ts'),
    path.join(appRoot, 'src', 'lib', 'rules.ts'),
    path.join(appRoot, 'src', 'lib', 'ruleDefaults.ts'),
  ],
  bundle: true,
  format: 'esm',
  outdir: outDir,
  logLevel: 'silent',
});

const {
  applyEncoding, ENCODING_MODES, isEncodingMode, repairMojibake, toFullWidth, toHalfWidth,
} = await import(pathToFileURL(path.join(outDir, 'encoding.js')).href);
const { applyRules, normalizeRule, ruleError, ruleSummary } = await import(pathToFileURL(path.join(outDir, 'rules.js')).href);
const { createRuleDefaults, RULE_TYPES } = await import(pathToFileURL(path.join(outDir, 'ruleDefaults.js')).href);

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

const ctx = () => ({
  nextNumber: () => 1,
  peekNumber: () => 1,
  vars: { name: 'x', ext: '', dir: '', parent: '', date: '', size: '', hash: '', user0: '', users: [] },
});

/** 用一条 encoding 规则求值，返回 { stem, ext }。 */
const run = (stem, mode, { ext = 'txt', isDir = false, enabled = true } = {}) => {
  const rule = normalizeRule({ id: 'e', type: 'encoding', enabled, mode });
  return applyRules({ stem, ext }, isDir, [rule], '', ctx(), true);
};

// ---------- A. 纯函数 ----------
const composed = 'e\u0301';
const decomposed = '\u00e9';
check('NFC 把「e + 组合重音」合成 é', applyEncoding(composed, 'nfc') === 'é', applyEncoding(composed, 'nfc'));
check('NFD 把 é 拆成 e + 组合重音（两个码点）', [...applyEncoding(decomposed, 'nfd')].length === 2);
check('NFC 对已是合成形式的串原样', applyEncoding('é', 'nfc') === 'é');
check('NFD 对纯 ASCII 原样', applyEncoding('abc', 'nfd') === 'abc');
check('NFKC 展开连字 ﬁ → fi', applyEncoding('ﬁle', 'nfkc') === 'file', applyEncoding('ﬁle', 'nfkc'));
check('NFKC 展开圆圈数字 ① → 1', applyEncoding('①', 'nfkc') === '1', applyEncoding('①', 'nfkc'));
check('NFKD 展开上标 ² → 2', applyEncoding('²', 'nfkd') === '2', applyEncoding('²', 'nfkd'));

check('全角 → 半角：全角字母数字转 ASCII', toHalfWidth('ＡＢＣ１２３') === 'ABC123', toHalfWidth('ＡＢＣ１２３'));
check('全角 → 半角：全角空格转普通空格', toHalfWidth('Ａ　Ｂ') === 'A B', JSON.stringify(toHalfWidth('Ａ　Ｂ')));
check('全角 → 半角：中文句号原样保留', toHalfWidth('第一。') === '第一。');
check('全角 → 半角：假名原样保留', toHalfWidth('ア') === 'ア');
check('全角 → 半角：纯 ASCII 原样', toHalfWidth('abc') === 'abc');

check('半角 → 全角：字母数字转全角', toFullWidth('ABC123') === 'ＡＢＣ１２３', toFullWidth('ABC123'));
check('半角 → 全角：普通空格转全角空格', toFullWidth('A B') === 'Ａ　Ｂ', JSON.stringify(toFullWidth('A B')));
check('半角 → 全角：中文原样保留', toFullWidth('第一。') === '第一。');
check('半角 → 全角幂等（再跑一次不变）', toFullWidth(toFullWidth('ABC')) === toFullWidth('ABC'));

check('乱码修复：cafÃ© → café', repairMojibake('cafÃ©') === 'café', repairMojibake('cafÃ©'));
check('乱码修复：中文「æ–‡ä»¶」→「文件」', repairMojibake('æ–‡ä»¶') === '文件', repairMojibake('æ–‡ä»¶'));
check('乱码修复：正常 UTF-8 名「café」原样', repairMojibake('café') === 'café');
check('乱码修复：纯 ASCII 原样', repairMojibake('photo-01') === 'photo-01');
check('乱码修复：CP1252 引号「â€œ」→ 全角左引号', repairMojibake('â€œ') === '\u201c', repairMojibake('â€œ'));
check('乱码修复：单独一个 Ã 解不动，原样返回', repairMojibake('Ã') === 'Ã');
check('乱码修复：正常重音名「François」原样', repairMojibake('François') === 'François');
check('乱码修复幂等（修好的串再跑不变）', repairMojibake(repairMojibake('æ–‡ä»¶')) === '文件');
check('未知模式原样返回', applyEncoding('abc', 'bogus') === 'abc');
check('空串安全', applyEncoding('', 'nfd') === '' && repairMojibake('') === '');
check('ENCODING_MODES 是七种且 isEncodingMode 认它', ENCODING_MODES.length === 7 && ENCODING_MODES.every(isEncodingMode));
check('isEncodingMode 拒绝未知值', isEncodingMode('upper') === false && isEncodingMode(3) === false);

// ---------- B. 引擎接线 ----------
const def = createRuleDefaults('encoding', 'r1');
check('默认规则：type=encoding / mode=nfc / enabled', def.type === 'encoding' && def.mode === 'nfc' && def.enabled === true, JSON.stringify(def));
check('RULE_TYPES 含 encoding（共 13 种）', RULE_TYPES.includes('encoding') && RULE_TYPES.length === 13, String(RULE_TYPES.length));

check('ruleError 对合法 mode 返回 null', ruleError(normalizeRule({ id: 'e', type: 'encoding', enabled: true, mode: 'half' })) === null);
check('ruleError 对非法 mode 报错',
  ruleError({ id: 'e', type: 'encoding', enabled: true, mode: 'bogus' }) !== null);

const halfRun = run('ＡＢＣ１２３', 'half');
check('applyRules：主干被转成半角、扩展名保留', halfRun.stem === 'ABC123' && halfRun.ext === 'txt', JSON.stringify(halfRun));
const dirRun = run('ＡＢＣ目录', 'half', { isDir: true, ext: '' });
check('目录名同样适用编码转换', dirRun.stem === 'ABC目录' && dirRun.ext === '');

const legacy = normalizeRule({ id: 'e', type: 'encoding', enabled: true });
check('旧存档缺 mode：补齐为 nfc', legacy.mode === 'nfc', String(legacy.mode));
const legacyBad = normalizeRule({ id: 'e', type: 'encoding', enabled: true, mode: 'weird' });
check('旧存档非法 mode：回落 nfc', legacyBad.mode === 'nfc', String(legacyBad.mode));
check('normalizeRule 保留合法 mode', normalizeRule({ id: 'e', type: 'encoding', enabled: true, mode: 'full' }).mode === 'full');

const chain = applyRules(
  { stem: 'cafÃ©', ext: 'jpg' },
  false,
  [
    normalizeRule({ id: 'a', type: 'replace', enabled: true, find: '-', replace: '_', caseSensitive: false, regex: false, nth: 0 }),
    normalizeRule({ id: 'b', type: 'encoding', enabled: true, mode: 'mojibake' }),
  ],
  '',
  ctx(),
  true,
);
check('与 replace 链式：先替换再修乱码（cafÃ©.jpg → café.jpg）', chain.stem === 'café' && chain.ext === 'jpg', JSON.stringify(chain));

const summary = ruleSummary(normalizeRule({ id: 'e', type: 'encoding', enabled: true, mode: 'half' }));
check('规则摘要带模式名（全角 → 半角）', summary.includes('全角') && summary.includes('半角'), summary);
const summaryNfc = ruleSummary(normalizeRule({ id: 'e', type: 'encoding', enabled: true, mode: 'nfc' }));
check('规则摘要随模式变化', summaryNfc !== summary, summaryNfc);

const disabled = run('ＡＢＣ', 'half', { enabled: false });
check('停用的规则不参与求值', disabled.stem === 'ＡＢＣ', disabled.stem);
const badMode = applyRules({ stem: 'ＡＢＣ', ext: '' }, false, [{ id: 'e', type: 'encoding', enabled: true, mode: 'bogus' }], '', ctx(), true);
check('非法 mode 的规则被整条跳过（求值期不崩）', badMode.stem === 'ＡＢＣ', badMode.stem);

// ---------- C. 界面与五语种 ----------
const read = (rel) => readFileSync(path.join(appRoot, rel), 'utf8');
const editor = read('src/components/RuleEditor.tsx');
check('编辑器按 mode 下拉渲染', editor.includes('data-testid="encoding-mode"'));
check('编辑器有示例行（实时算转换结果）', editor.includes('data-testid="encoding-sample"') && editor.includes('applyEncoding(before, mode)'));
check('编辑器说明行有独立 testid', editor.includes('data-testid="encoding-hint"'));
check('编辑器接进 RuleEditor 分发', editor.includes("rule.type === 'encoding' && <EncodingEditor"));
check('示例串同时含全角、重音与乱码三种样本',
  editor.includes('ＡＢＣ１２３') && editor.includes('Résumé') && editor.includes('cafÃ©'));

let locales = 0;
const localeKeys = [
  "'ruleType.encoding':", "'ruleDesc.encoding':", "'f.encodingMode':", "'f.encodingHint':", "'f.encodingSample':",
  "'f.encoding.nfc':", "'f.encoding.nfd':", "'f.encoding.nfkc':", "'f.encoding.nfkd':",
  "'f.encoding.half':", "'f.encoding.full':", "'f.encoding.mojibake':",
  "'ruleErr.badEncodingMode':", "'ruleSum.encoding':",
];
for (const file of readdirSync(path.join(appRoot, 'src/locales'))) {
  if (!file.endsWith('.ts')) continue;
  const body = readFileSync(path.join(appRoot, 'src/locales', file), 'utf8');
  if (localeKeys.every((k) => body.includes(k))) locales += 1;
}
check('五语种都补齐 14 个编码转换键', locales === 5, `${locales} 个语种齐全`);

const pkg = JSON.parse(read('package.json'));
check('package.json 有 test:encoding 脚本', typeof pkg.scripts['test:encoding'] === 'string', pkg.scripts['test:encoding']);

// ---------- D. 文档同源 ----------
const docsRoot = path.join(appRoot, '..', 'docs');
const gap = readFileSync(path.join(docsRoot, 'FEATURE-GAP.md'), 'utf8');
const row313 = gap.split(/\r?\n/).find((l) => l.startsWith('| 3.13 ')) ?? '';
check('FEATURE-GAP 3.13 行已标记编码转换落地', row313.includes('编码转换'), row313.slice(0, 160));
check('FEATURE-GAP 3.13 行记录 test:encoding 证据', row313.includes('test:encoding'), row313.slice(0, 160));
check('FEATURE-GAP 3.13 行仍如实记录脚本/内码/加密未做',
  row313.includes('脚本') && row313.includes('内码') && row313.includes('加密'), row313.slice(-160));

const semantics = readFileSync(path.join(docsRoot, '规则语义确认清单.md'), 'utf8');
check('语义清单新增「编码转换」一节', semantics.includes('编码转换'));
check('语义清单写明只作用于文件名主干', semantics.includes('只作用于文件名主干') || semantics.includes('只改主干'));
check('语义清单写明乱码修复解不动就原样', semantics.includes('原样') && semantics.includes('乱码'));

const readme = read('../app/README.md');
check('README 记录编码转换规则', readme.includes('编码转换'));

console.log(`\n编码转换规则自测：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
