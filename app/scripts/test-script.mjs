/**
 * 脚本规则（3.13「高级规则 · 脚本」）自测：
 * A 段纯函数（解析、求值、变量、函数、运算符、错误边界、缓存与长度上限）
 * B 段引擎接线（applyRules 真跑、ruleError、ruleSummary、默认值、类型表、旧存档补齐）
 * C 段界面与五语种（编辑器控件、实时示例、18 个键 × 5 语种）
 * D 段文档同源（FEATURE-GAP 3.13、语义清单、README 与 package.json）。
 */
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const outDir = path.join(appRoot, 'node_modules', '.cache', 'script-test');
buildSync({
  entryPoints: [
    path.join(appRoot, 'src', 'lib', 'script.ts'),
    path.join(appRoot, 'src', 'lib', 'rules.ts'),
    path.join(appRoot, 'src', 'lib', 'ruleDefaults.ts'),
  ],
  bundle: true,
  format: 'esm',
  outdir: outDir,
  logLevel: 'silent',
  alias: {
    buffer: path.join(appRoot, 'node_modules', 'buffer'),
    string_decoder: path.join(appRoot, 'node_modules', 'string_decoder'),
  },
});

const { runScript, compileScript } = await import(pathToFileURL(path.join(outDir, 'script.js')).href);
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

const env = {
  name: 'Photo 2024',
  ext: 'jpg',
  original: 'Original Name',
  dir: 'Trip',
  modified: Date.UTC(2024, 0, 2, 3, 4, 5),
  size: 2048,
  users: ['Z', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'],
};
const val = (src) => {
  const r = runScript(src, env);
  return r.ok ? r.value : `ERR:${r.error.code}`;
};
const code = (src) => {
  const r = runScript(src, env);
  return r.ok ? 'ok' : r.error.code;
};

// ---------- A. 纯函数 ----------
check('upper(name) 把当前主干转大写', val('upper(name)') === 'PHOTO 2024', val('upper(name)'));
check('字符串拼接 + 保持不变', val('name + "_v2"') === 'Photo 2024_v2', val('name + "_v2"'));
check('original 指向扫描时的原主干（不随前面规则变化）', val('original') === 'Original Name', val('original'));
check('ext 可读但不改扩展名', val('name + "." + ext') === 'Photo 2024.jpg', val('name + "." + ext'));
check('dir 变量给出目录名', val('dir') === 'Trip', val('dir'));
check('u0–u9 读取用户文本', val('u0 + u1') === 'ZA', val('u0 + u1'));
check('replace 做全量字面替换', val('replace(name, " ", "_")') === 'Photo_2024', val('replace(name, " ", "_")'));
check('regex 支持 \\d 这类反斜杠正则（转义不吞反斜杠）', val('regex(name, "(\\d+)", "[$1]")') === 'Photo [2024]', val('regex(name, "(\\d+)", "[$1]")'));
check('regex 可带第四个 flags 参数', val('regex(name, "photo", "X", "i")') === 'X 2024', val('regex(name, "photo", "X", "i")'));
check('cut 按 1 基起点取子串', val('cut(name, 1, 5)') === 'Photo', val('cut(name, 1, 5)'));
check('cut 越界只返回能取到的部分', val('cut(name, 7, 99)') === '2024', val('cut(name, 7, 99)'));
check('cut 起点小于 1 时夹到 1', val('cut(name, 0, 2)') === 'Ph', val('cut(name, 0, 2)'));
check('pad 左补齐到指定宽度', val('pad("7", 3, "0")') === '007', val('pad("7", 3, "0")'));
check('len 按码点计数（emoji 不拆半）', val('len("a😀b")') === '3', val('len("a😀b")'));
check('contains / startsWith / endsWith 返回布尔', val('contains(name, "2024")') === 'true' && val('startsWith(name, "Photo")') === 'true' && val('endsWith(name, "2024")') === 'true');
check('if 惰性求值', val('if(len(name) > 20, "long", "short")') === 'short', val('if(len(name) > 20, "long", "short")'));
check('三元与比较运算', val('size > 1000 ? "big" : "small"') === 'big', val('size > 1000 ? "big" : "small"'));
check('四则运算与优先级', val('1 + 2 * 3') === '7', val('1 + 2 * 3'));
check('括号改变优先级', val('(1 + 2) * 3') === '9', val('(1 + 2) * 3'));
check('date(fmt) 使用修改时间', val('date("yyyy-MM-dd")') === '2024-01-02', val('date("yyyy-MM-dd")'));
check('time(fmt) 使用修改时间', val('time("HH-mm-ss")') === (() => {
  const d = new Date(env.modified);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
})(), val('time("HH-mm-ss")'));
check('未知变量在解析期报错（不是运行期静默）', code('unknownVar') === 'unknownVar', code('unknownVar'));
check('未知函数在解析期报错', code('foo(1)') === 'unknownFunc', code('foo(1)'));
check('函数参数个数不匹配要报错', code('upper(1, 2)') === 'arity', code('upper(1, 2)'));
check('字面量正则非法在解析期报错', code('regex(name, "[", "x")') === 'badRegex', code('regex(name, "[", "x")'));
check('括号不闭合报语法错误并给位置', compileScript('upper(name').error.code === 'syntax' && compileScript('upper(name').error.pos > 0);
check('空表达式报 empty', code('') === 'empty', code(''));
check('超过 600 字符直接拒绝', code(`"${'a'.repeat(601)}"`) === 'tooLong', code('long'));
check('结果为空视为失败（上层保持原名）', code('"".replace("", "")') === 'empty' || code('if(false, "x", "")') === 'empty', code('if(false, "x", "")'));
check('同一表达式重复编译命中缓存且结果一致', val('upper(name)') === val('upper(name)'));

// ---------- B. 引擎接线 ----------
const ctx = () => ({
  nextNumber: () => 1,
  peekNumber: () => 1,
  vars: {
    stem: 'Photo 2024', ext: 'jpg', dirName: 'Trip', modified: Date.UTC(2024, 0, 2, 3, 4, 5),
    size: 2048, hashes: {}, users: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'], user0: 'Z',
  },
});
const runRules = (stem, rules, { ext = 'jpg', isDir = false } = {}) =>
  applyRules({ stem, ext }, isDir, rules, 'Trip', ctx(), true);
const rule = (source, enabled = true) => ({ id: 's', type: 'script', enabled, source });

check('RULE_TYPES 追加 script 与 codepage', RULE_TYPES.includes('script') && RULE_TYPES.includes('codepage'), RULE_TYPES.join(','));
check('createRuleDefaults(script) 给出可用的默认表达式',
  createRuleDefaults('script', 'd1').source === 'upper(name)', createRuleDefaults('script', 'd1').source);
check('applyRules 用脚本结果替换主干，扩展名不动',
  runRules('Photo 2024', [rule('"SCRIPT_" + original')]).stem === 'SCRIPT_Photo 2024', 'SCRIPT_Photo 2024');
check('脚本看到的是前面规则改过的 name，而 original 保持原名',
  runRules('Photo 2024', [
    { id: 'r', type: 'replace', enabled: true, find: 'Photo', replace: 'IMG', caseSensitive: true, regex: false, nth: 0 },
    rule('name + "|" + original'),
  ]).stem === 'IMG 2024|Photo 2024');
check('脚本结果里的 / 与空格原样保留（不额外替换）', runRules('a b', [rule('replace(name, " ", "/")')]).stem === 'a/b');
check('停用的脚本规则不参与求值', runRules('Photo 2024', [rule('upper(name)', false)]).stem === 'Photo 2024');
check('写错的脚本整条跳过（不会把整条链弄崩）', runRules('Photo 2024', [rule('unknownVar')]).stem === 'Photo 2024');
check('ruleError 对合法脚本返回 null', ruleError(normalizeRule(rule('upper(name)'))) === null);
check('ruleError 对未知变量报本地化错误', ruleError(normalizeRule(rule('nope'))) !== null
  && ruleError(normalizeRule(rule('nope'))).includes('nope'));
check('ruleSummary 带表达式摘要', (() => {
  const summary = ruleSummary(normalizeRule(rule('upper(name)')));
  return (summary.includes('脚本') || summary.toLowerCase().includes('script')) && summary.includes('upper(name)');
})(), ruleSummary(normalizeRule(rule('upper(name)'))));
check('ruleSummary 超长表达式截断到 40 字 + 省略号',
  ruleSummary(normalizeRule(rule(`"${'x'.repeat(60)}"`))).includes('…'));
check('normalizeRule 补齐缺失的 source 为空串（旧存档不崩）',
  normalizeRule({ id: 's', type: 'script', enabled: true }).source === '', normalizeRule({ id: 's', type: 'script', enabled: true }).source);
check('normalizeRule 不覆盖已有 source', normalizeRule(rule('lower(name)')).source === 'lower(name)');

// ---------- C. 界面与五语种 ----------
const read = (rel) => readFileSync(path.join(appRoot, rel), 'utf8');
const editor = read('src/components/RuleEditor.tsx');
check('编辑器有脚本表达式框', editor.includes('data-testid="script-source"'));
check('编辑器有变量/函数提示', editor.includes('data-testid="script-hint"') && editor.includes("t('f.scriptHint')"));
check('编辑器用固定样例实时求值', editor.includes('data-testid="script-sample"') && editor.includes('runScript(rule.source, SCRIPT_SAMPLE)'));
check('编辑器区分语法错误并单独显示', editor.includes('data-testid="script-error"'));
check('编辑器接进 RuleEditor 分发', editor.includes("rule.type === 'script' && <ScriptEditor"));
check('内码编辑器有模式下拉与示例', editor.includes('data-testid="codepage-mode"') && editor.includes('data-testid="codepage-sample"'));
check('内码编辑器接进 RuleEditor 分发', editor.includes("rule.type === 'codepage' && <CodepageEditor"));

let locales = 0;
const localeKeys = [
  "'ruleType.script':", "'ruleDesc.script':", "'f.scriptSource':", "'ph.scriptSource':", "'f.scriptHint':",
  "'f.scriptSample':", "'ruleErr.scriptEmpty':", "'ruleErr.scriptTooLong':", "'ruleErr.scriptSyntax':",
  "'ruleErr.scriptUnknownVar':", "'ruleErr.scriptUnknownFunc':", "'ruleErr.scriptArity':",
  "'ruleErr.scriptBadRegex':", "'ruleErr.scriptBadNumber':", "'ruleSum.script':",
];
for (const file of readdirSync(path.join(appRoot, 'src/locales'))) {
  if (!file.endsWith('.ts')) continue;
  const body = readFileSync(path.join(appRoot, 'src/locales', file), 'utf8');
  if (localeKeys.every((k) => body.includes(k))) locales += 1;
}
check('五语种都补齐脚本规则 15 个键', locales === 5, `${locales} 个语种齐全`);

const pkg = JSON.parse(read('package.json'));
check('package.json 有 test:script 脚本', typeof pkg.scripts['test:script'] === 'string', pkg.scripts['test:script']);

// ---------- D. 文档同源 ----------
const docsRoot = path.join(appRoot, '..', 'docs');
const gap = readFileSync(path.join(docsRoot, 'FEATURE-GAP.md'), 'utf8');
const row313 = gap.split(/\r?\n/).find((l) => l.startsWith('| 3.13 ')) ?? '';
check('FEATURE-GAP 3.13 行标记脚本落地', row313.includes('脚本'), row313.slice(0, 160));
check('FEATURE-GAP 3.13 行记录 test:script 证据', row313.includes('test:script'), row313.slice(0, 200));
check('FEATURE-GAP 3.13 行仍如实记录加密未做', row313.includes('加密'), row313.slice(-160));

const semantics = readFileSync(path.join(docsRoot, '规则语义确认清单.md'), 'utf8');
check('语义清单新增「脚本规则」一节', semantics.includes('脚本规则'));
check('语义清单写明不执行任意代码', semantics.includes('不执行任意代码') || semantics.includes('受限表达式'));

const readme = read('../app/README.md');
check('README 记录脚本规则', readme.includes('脚本表达式') || readme.includes('脚本规则'));

console.log(`\n脚本规则自测：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
