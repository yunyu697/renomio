/**
 * 中文内码规则（3.13「高级规则 · 内码」）自测：
 * A 段纯函数（GBK 乱码还原、简繁 Big5/GBK 用字转换、幂等与安全边界）
 * B 段引擎接线（applyRules 真跑、ruleError、ruleSummary、默认值、类型表、旧存档补齐）
 * C 段界面与五语种（编辑器控件、实时示例、10 个键 × 5 语种、polyfill 配置）
 * D 段文档同源（FEATURE-GAP 3.13、语义清单、README 与 package.json）。
 */
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import iconv from 'iconv-lite';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const outDir = path.join(appRoot, 'node_modules', '.cache', 'codepage-test');
buildSync({
  entryPoints: [
    path.join(appRoot, 'src', 'lib', 'codepage.ts'),
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

const {
  applyCodepage, CODEPAGE_MODES, isCodepageMode, repairGbkMojibake, toBig5Wording, toGbkWording,
} = await import(pathToFileURL(path.join(outDir, 'codepage.js')).href);
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

/** 用真实 iconv 生成「UTF-8 中文被按 GBK 解码」的乱码，避免手抄错字 */
const mojibake = (text) => iconv.decode(Buffer.from(text, 'utf8'), 'gbk');

// ---------- A. 纯函数 ----------
check('内码模式固定三种', CODEPAGE_MODES.join(',') === 'gbk-fix,to-big5,to-gbk', CODEPAGE_MODES.join(','));
check('isCodepageMode 认三种合法值', CODEPAGE_MODES.every((m) => isCodepageMode(m)));
check('isCodepageMode 拒绝非法值', !isCodepageMode('big5-fix') && !isCodepageMode(undefined));

const sampleGb = mojibake('中文测试');
check('GBK 乱码还原：还原回「中文测试」', repairGbkMojibake(sampleGb) === '中文测试', JSON.stringify(sampleGb));
check('GBK 乱码还原：还原回「文档」', repairGbkMojibake(mojibake('文档')) === '文档');
check('GBK 乱码还原：名字含表示不了的字符时原样返回', repairGbkMojibake('照片 😀') === '照片 😀', repairGbkMojibake('照片 😀'));
check('GBK 乱码还原：ASCII 原样返回', repairGbkMojibake('report_final') === 'report_final');
check('GBK 乱码还原：正常中文（不是乱码）原样返回', repairGbkMojibake('普通名字') === '普通名字');
check('GBK 乱码还原：空串原样返回', repairGbkMojibake('') === '');
check('GBK 乱码还原：已还原的串再跑一次不变（幂等）', repairGbkMojibake('中文测试') === '中文测试');

check('简体 → 繁体：简→繁并采用 Big5 用字', toBig5Wording('简体中文测试文件') === '簡體中文測試文件', toBig5Wording('简体中文测试文件'));
check('简体 → 繁体：已经是繁体时保持不变（幂等）', toBig5Wording('簡體中文測試文件') === '簡體中文測試文件', toBig5Wording('簡體中文測試文件'));
check('简体 → 繁体：Emoji 与字母原样保留', toBig5Wording('测试😀ABC') === '測試😀ABC', toBig5Wording('测试😀ABC'));
check('繁体 → 简体：繁转简', toGbkWording('簡體中文測試檔案') === '简体中文测试档案', toGbkWording('簡體中文測試檔案'));
check('繁体 → 简体：简体输入原样返回', toGbkWording('简体中文') === '简体中文', toGbkWording('简体中文'));
check('繁体 → 简体：Emoji 原样保留', toGbkWording('測試😀') === '测试😀', toGbkWording('測試😀'));
check('简→繁→简 回到原串', toGbkWording(toBig5Wording('简体中文测试文件')) === '简体中文测试文件',
  toGbkWording(toBig5Wording('简体中文测试文件')));
check('未知 mode 回落原样（运行期兜底不崩）', applyCodepage('简体中文', 'bogus') === '简体中文');
check('applyCodepage 三种 mode 都有结果', applyCodepage('娴嬭瘯', 'gbk-fix') === '测试'
  && applyCodepage('简体', 'to-big5') === '簡體' && applyCodepage('簡體', 'to-gbk') === '简体');

// ---------- B. 引擎接线 ----------
const ctx = () => ({
  nextNumber: () => 1,
  peekNumber: () => 1,
  vars: {
    stem: 'x', ext: 'txt', dirName: 'Trip', modified: 1, size: 1, hashes: {}, users: [], user0: '',
  },
});
const runRules = (stem, rules, { ext = 'txt', isDir = false } = {}) =>
  applyRules({ stem, ext }, isDir, rules, 'Trip', ctx(), true);
const cp = (mode, enabled = true) => ({ id: 'c', type: 'codepage', enabled, mode });

check('RULE_TYPES 含 codepage', RULE_TYPES.includes('codepage'), RULE_TYPES.join(','));
check('createRuleDefaults(codepage) 默认 gbk-fix', createRuleDefaults('codepage', 'c1').mode === 'gbk-fix',
  createRuleDefaults('codepage', 'c1').mode);
check('applyRules 用内码结果替换主干，扩展名不动',
  runRules('娴嬭瘯', [cp('gbk-fix')], { ext: 'txt' }).stem === '测试'
  && runRules('娴嬭瘯', [cp('gbk-fix')], { ext: 'txt' }).ext === 'txt');
check('applyRules 简→繁作用于主干', runRules('简体中文', [cp('to-big5')]).stem === '簡體中文');
check('停用的内码规则不参与求值', runRules('简体', [cp('to-big5', false)]).stem === '简体');
check('非法 mode 的规则整条跳过（不崩）', runRules('简体', [cp('bogus')]).stem === '简体');
check('ruleError 对合法 mode 返回 null', ruleError(normalizeRule(cp('to-big5'))) === null);
check('ruleError 对非法 mode 报错', ruleError(cp('bogus')) !== null);
const cpSummary = ruleSummary(normalizeRule(cp('to-big5')));
check('ruleSummary 带模式文案',
  (cpSummary.includes('内码') || cpSummary.toLowerCase().includes('codepage'))
  && (cpSummary.includes('繁体') || cpSummary.includes('Big5')), cpSummary);
check('normalizeRule 缺失 mode 回落 gbk-fix',
  normalizeRule({ id: 'c', type: 'codepage', enabled: true }).mode === 'gbk-fix');
check('normalizeRule 非法 mode 回落 gbk-fix',
  normalizeRule({ id: 'c', type: 'codepage', enabled: true, mode: 'bogus' }).mode === 'gbk-fix');

// ---------- C. 界面与五语种 ----------
const read = (rel) => readFileSync(path.join(appRoot, rel), 'utf8');
const editor = read('src/components/RuleEditor.tsx');
check('编辑器有内码模式下拉', editor.includes('data-testid="codepage-mode"'));
check('编辑器有内码说明与示例', editor.includes('data-testid="codepage-hint"') && editor.includes('data-testid="codepage-sample"'));
check('示例覆盖三种模式（GBK 乱码 / 简→繁 / 繁→简）',
  editor.includes("'gbk-fix': '娴嬭瘯'") && editor.includes("'to-big5': '简体中文测试'") && editor.includes("'to-gbk': '簡體中文測試'"));
check('编辑器示例实时调用 applyCodepage', editor.includes('applyCodepage(before, mode)'));
check('编辑器接进 RuleEditor 分发', editor.includes("rule.type === 'codepage' && <CodepageEditor"));

let locales = 0;
const localeKeys = [
  "'ruleType.codepage':", "'ruleDesc.codepage':", "'f.codepageMode':", "'f.codepage.gbk-fix':",
  "'f.codepage.to-big5':", "'f.codepage.to-gbk':", "'f.codepageHint':", "'f.codepageSample':",
  "'ruleErr.badCodepageMode':", "'ruleSum.codepage':",
];
for (const file of readdirSync(path.join(appRoot, 'src/locales'))) {
  if (!file.endsWith('.ts')) continue;
  const body = readFileSync(path.join(appRoot, 'src/locales', file), 'utf8');
  if (localeKeys.every((k) => body.includes(k))) locales += 1;
}
check('五语种都补齐内码规则 10 个键', locales === 5, `${locales} 个语种齐全`);

const vite = read('vite.config.ts');
check('Vite 给 iconv-lite 的 buffer 依赖配了浏览器实现', vite.includes("buffer: fileURLToPath") && vite.includes("string_decoder: fileURLToPath"));
const pkg = JSON.parse(read('package.json'));
check('package.json 有 test:codepage 脚本', typeof pkg.scripts['test:codepage'] === 'string', pkg.scripts['test:codepage']);
check('package.json 记录三个运行时依赖',
  pkg.dependencies['iconv-lite'] && pkg.dependencies['opencc-js'] && pkg.dependencies.buffer,
  JSON.stringify(pkg.dependencies));

// ---------- D. 文档同源 ----------
const docsRoot = path.join(appRoot, '..', 'docs');
const gap = readFileSync(path.join(docsRoot, 'FEATURE-GAP.md'), 'utf8');
const row313 = gap.split(/\r?\n/).find((l) => l.startsWith('| 3.13 ')) ?? '';
check('FEATURE-GAP 3.13 行标记内码落地', row313.includes('内码'), row313.slice(0, 160));
check('FEATURE-GAP 3.13 行记录 test:codepage 证据', row313.includes('test:codepage'), row313.slice(0, 220));
check('FEATURE-GAP 3.13 行仍如实记录加密未做', row313.includes('加密'), row313.slice(-160));

const semantics = readFileSync(path.join(docsRoot, '规则语义确认清单.md'), 'utf8');
check('语义清单新增「中文内码」一节', semantics.includes('中文内码') || semantics.includes('内码规则'));
check('语义清单写明乱码还原只在整串可逆时生效',
  semantics.includes('可逆') && semantics.includes('GBK'));

const readme = read('../app/README.md');
check('README 记录中文内码规则', readme.includes('中文内码') || readme.includes('内码'));

console.log(`\n中文内码规则自测：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
