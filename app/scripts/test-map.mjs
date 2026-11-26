/**
 * 对照表规则（3.13「高级规则 · 对照表」）自测：
 * A 段纯函数（解析 / 最长匹配 / 单遍不连锁 / 大小写 / 上限 / 错误码）
 * B 段引擎接线（applyRules 真跑、ruleError、ruleSummary、默认值、类型表、编辑器与五语种）
 * C 段文档同源（FEATURE-GAP 3.13 与语义清单）。
 */
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const outDir = path.join(appRoot, 'node_modules', '.cache', 'map-test');
buildSync({
  entryPoints: [
    path.join(appRoot, 'src', 'lib', 'mapTable.ts'),
    path.join(appRoot, 'src', 'lib', 'rules.ts'),
    path.join(appRoot, 'src', 'lib', 'ruleDefaults.ts'),
  ],
  bundle: true,
  format: 'esm',
  outdir: outDir,
  logLevel: 'silent',
});

const {
  applyMapping, mapErrorKey, parseMapTable, MAP_MAX_ENTRIES,
} = await import(pathToFileURL(path.join(outDir, 'mapTable.js')).href);
const {
  applyRules, normalizeRule, ruleError, ruleSummary,
} = await import(pathToFileURL(path.join(outDir, 'rules.js')).href);
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

/** 用一条 map 规则求值，返回新 stem。 */
const run = (stem, table, { caseSensitive = false, isDir = false, ext = 'txt' } = {}) => {
  const rule = normalizeRule({ id: 'm', type: 'map', enabled: true, table, caseSensitive });
  const out = applyRules({ stem, ext }, isDir, [rule], '', ctx(), true);
  return out.stem;
};

// ---------- A. 纯函数：解析 ----------
const tbl = (text, cs = false) => parseMapTable(text, cs);

const basic = tbl('IMG=照片\nDSC=相机');
check('两行「旧=新」解析出 2 条', basic.entries.length === 2 && basic.errors.length === 0, JSON.stringify(basic));
check('条目带原始行号（1、2）', basic.entries[0].line === 1 && basic.entries[1].line === 2);
check('键值正确（IMG→照片 / DSC→相机）', basic.entries[0].key === 'IMG' && basic.entries[0].value === '照片');

const tabbed = tbl('IMG\t照片');
check('制表符也能作分隔符', tabbed.entries.length === 1 && tabbed.entries[0].value === '照片', JSON.stringify(tabbed));

const mixed = tbl('a=b=c');
check('第一个 = 作分隔，后面的 = 留在新词里', mixed.entries.length === 1 && mixed.entries[0].key === 'a' && mixed.entries[0].value === 'b=c');

const escaped = tbl('a\\=b=c');
check('\\= 转义：键里能有字面 =', escaped.entries.length === 1 && escaped.entries[0].key === 'a=b' && escaped.entries[0].value === 'c', JSON.stringify(escaped.entries));

const trimmed = tbl('  IMG  =  照片  ');
check('键值两侧空白被去掉', trimmed.entries[0].key === 'IMG' && trimmed.entries[0].value === '照片', JSON.stringify(trimmed.entries));

const spaceKeep = tbl('IMG=\\s照片');
check('\\s 表示要保留的空格', spaceKeep.entries[0].value === ' 照片', JSON.stringify(spaceKeep.entries[0].value));

const comments = tbl('# 注释\n// 另一种注释\nIMG=照片\n\n   \nDSC=相机');
check('注释与空行被忽略，只剩 2 条', comments.entries.length === 2 && comments.errors.length === 0, JSON.stringify(comments));
check('注释行不影响后续行号（IMG 记在第 3 行）', comments.entries[0].line === 3, String(comments.entries[0].line));

const emptyValue = tbl('IMG=');
check('新词留空合法（表示删除命中的片段）', emptyValue.entries.length === 1 && emptyValue.entries[0].value === '' && emptyValue.errors.length === 0);

// 错误码
const noSep = tbl('这一行忘了写等号');
check('缺分隔符 → no-separator 且带行号', noSep.errors.length === 1 && noSep.errors[0].code === 'no-separator' && noSep.errors[0].line === 1, JSON.stringify(noSep.errors));

const emptyKey = tbl('=照片');
check('旧词为空 → empty-key', emptyKey.errors.length === 1 && emptyKey.errors[0].code === 'empty-key', JSON.stringify(emptyKey.errors));

const dup = tbl('IMG=1\nIMG=2');
check('重复键 → dup-key 并提示与第 1 行重复', dup.entries.length === 1 && dup.errors[0].code === 'dup-key' && dup.errors[0].text.includes('第 1 行'), JSON.stringify(dup.errors));

const dupCi = parseMapTable('A=1\na=2', false);
check('大小写不敏感时 A 与 a 视为重复', dupCi.entries.length === 1 && dupCi.errors.length === 1 && dupCi.errors[0].code === 'dup-key', JSON.stringify(dupCi));

const dupCs = parseMapTable('A=1\na=2', true);
check('大小写敏感时 A 与 a 各算一条', dupCs.entries.length === 2 && dupCs.errors.length === 0, JSON.stringify(dupCs));

const longKey = `${'x'.repeat(201)}=y`;
const longKeyParsed = tbl(longKey);
check('超长键（>200）不落地并报错', longKeyParsed.entries.length === 0 && longKeyParsed.errors.length === 1, JSON.stringify(longKeyParsed.errors));

const many = Array.from({ length: MAP_MAX_ENTRIES + 2 }, (_, i) => `k${i}=v${i}`).join('\n');
const manyParsed = tbl(many);
check(`超过 ${MAP_MAX_ENTRIES} 条只保留前 ${MAP_MAX_ENTRIES} 条`, manyParsed.entries.length === MAP_MAX_ENTRIES, String(manyParsed.entries.length));
check('超限报 too-many（行号是第一条被丢的行）',
  manyParsed.errors.some((e) => e.code === 'too-many' && e.line === MAP_MAX_ENTRIES + 1),
  JSON.stringify(manyParsed.errors.slice(-1)));

check('错误码到文案键是一一映射', ['no-separator', 'empty-key', 'dup-key', 'too-many']
  .every((code) => mapErrorKey(code).startsWith('ruleErr.map')), 'mapErrorKey');

// ---------- A. 纯函数：应用 ----------
const apply = (text, table, cs = false) => applyMapping(text, parseMapTable(table, cs).entries, cs);

check('简单替换：IMG_001 → 照片_001', apply('IMG_001', 'IMG=照片') === '照片_001', apply('IMG_001', 'IMG=照片'));
check('多次命中全部替换：IMG-IMG → 照片-照片', apply('IMG-IMG', 'IMG=照片') === '照片-照片');
check('最长键优先：IMGX=长、IMG=短，IMGX1 走长键',
  apply('IMGX1', 'IMG=短\nIMGX=长') === '长1', apply('IMGX1', 'IMG=短\nIMGX=长'));
check('同长度取表里靠前的一条', apply('AB', 'AB=一\nAB=二') === '一', apply('AB', 'AB=一\nAB=二'));
check('插入文本不再扫描：A=B、B=C 不连锁 → B', apply('A', 'A=B\nB=C') === 'B', apply('A', 'A=B\nB=C'));
check('链式表也不会死循环（长串一次到底）', apply('A'.repeat(200), 'A=B\nB=C').length === 200);
check('空新词 = 删除片段：IMG_001 → _001', apply('IMG_001', 'IMG=') === '_001', apply('IMG_001', 'IMG='));
check('未命中原样返回', apply('hello', 'IMG=照片') === 'hello');
check('空表原样返回', apply('hello', '') === 'hello');
check('空文本原样返回', apply('', 'IMG=照片') === '');
check('中文键可用：旧词→新词', apply('旧词测试', '旧词=新词') === '新词测试', apply('旧词测试', '旧词=新词'));
check('emoji 键按整段匹配：😀x → 笑脸x', apply('😀x', '😀=笑脸') === '笑脸x', apply('😀x', '😀=笑脸'));
check('emoji 不被拆成半个码点（未命中保持不变）', apply('😀', 'A=B') === '😀');
check('大小写敏感：img 不命中 IMG', apply('img_1', 'IMG=照片', true) === 'img_1');
check('大小写不敏感：img 命中 IMG', apply('img_1', 'IMG=照片', false) === '照片_1');
check('大小写不敏感时命中段被整段替换（保留相对位置）', apply('aImGb', 'img=X') === 'aXb');
check('键里含空格（trim 后保留内部空格）', apply('my file', 'my file=我的文件') === '我的文件');
check('替换值里含 = 号（第一个 = 之后全是值）', apply('a1', 'a1=x=y') === 'x=y');
check('重复应用到同一结果是幂等的（旧词已不存在）', apply(apply('IMG_1', 'IMG=照片'), 'IMG=照片') === '照片_1');

// ---------- B. 引擎接线 ----------
const def = createRuleDefaults('map', 'x');
check('新增对照表规则默认空表 + 不区分大小写', def.type === 'map' && def.table === '' && def.caseSensitive === false, JSON.stringify(def));

check('RULE_TYPES 含 map（规则菜单与计划导入都靠它）', RULE_TYPES.includes('map'), RULE_TYPES.join(','));

check('空表报错（不当作“原样通过”）', typeof ruleError(normalizeRule({ id: 'e', type: 'map', enabled: true, table: '', caseSensitive: false })) === 'string');
check('只有注释也算空表',
  typeof ruleError(normalizeRule({ id: 'e', type: 'map', enabled: true, table: '# 只有注释\n// 还是注释', caseSensitive: false })) === 'string');
check('坏行报错并带行号',
  (() => {
    const msg = ruleError(normalizeRule({ id: 'e', type: 'map', enabled: true, table: 'IMG=照片\n这一行没有等号', caseSensitive: false }));
    return typeof msg === 'string' && msg.includes('2');
  })(), ruleError(normalizeRule({ id: 'e', type: 'map', enabled: true, table: 'IMG=照片\n这一行没有等号', caseSensitive: false })));
check('合法表不报错', ruleError(normalizeRule({ id: 'e', type: 'map', enabled: true, table: 'IMG=照片', caseSensitive: false })) === null);

check('旧存档缺字段时 normalizeRule 补齐（table 空串、区分大小写 false）', (() => {
  const fixed = normalizeRule({ id: 'n', type: 'map', enabled: true });
  return fixed.table === '' && fixed.caseSensitive === false;
})(), JSON.stringify(normalizeRule({ id: 'n', type: 'map', enabled: true })));

check('applyRules 真跑：IMG_001.txt → 照片_001.txt', (() => {
  const out = applyRules({ stem: 'IMG_001', ext: 'txt' }, false,
    [normalizeRule({ id: 'm', type: 'map', enabled: true, table: 'IMG=照片', caseSensitive: false })], '', ctx(), true);
  return out.stem === '照片_001' && out.ext === 'txt';
})(), run('IMG_001', 'IMG=照片'));
check('扩展名不受影响：只改主干', run('IMG_001', 'IMG=照片') === '照片_001');
check('目录（无扩展名）同样适用', (() => {
  const rule = normalizeRule({ id: 'm', type: 'map', enabled: true, table: 'IMG=照片', caseSensitive: false });
  return applyRules({ stem: 'IMG_2024', ext: '' }, true, [rule], '', ctx(), true).stem === '照片_2024';
})());
check('大小写敏感开关影响引擎结果',
  run('img_1', 'IMG=照片', { caseSensitive: true }) === 'img_1'
  && run('img_1', 'IMG=照片', { caseSensitive: false }) === '照片_1');
check('表里有坏行时不参与求值（stem 不变）', run('IMG_1', '这一行没有等号') === 'IMG_1', run('IMG_1', '这一行没有等号'));

const summary = ruleSummary(normalizeRule({ id: 's', type: 'map', enabled: true, table: 'IMG=照片\nDSC=相机', caseSensitive: false }));
check('摘要显示条目数', summary.includes('2'), summary);
check('摘要区分大小写开关',
  ruleSummary(normalizeRule({ id: 's', type: 'map', enabled: true, table: 'IMG=照片', caseSensitive: true }))
  !== ruleSummary(normalizeRule({ id: 's', type: 'map', enabled: true, table: 'IMG=照片', caseSensitive: false })));

// 界面接线
const read = (rel) => readFileSync(path.join(appRoot, rel), 'utf8');
const editor = read('src/components/RuleEditor.tsx');
check('规则编辑器有 map 分发', editor.includes("rule.type === 'map' &&"));
check('对照表输入框 testid = map-table', editor.includes('data-testid="map-table"'));
check('大小写开关 testid = map-case', editor.includes('testId="map-case"'));
check('实时错误列表 testid = map-errors', editor.includes('data-testid="map-errors"'));
check('条目计数 testid = map-entries-count', editor.includes('data-testid="map-entries-count"'));
check('提示行 testid = map-hint', editor.includes('data-testid="map-hint"'));
check('编辑器自带解析（不重复实现一套规则）', editor.includes('parseMapTable('));

const panel = read('src/components/RulesPanel.tsx');
check('规则菜单由 RULE_TYPES 生成（新增类型自动出现）', panel.includes('RULE_TYPES.map'));

const plan = read('src/lib/plan.ts');
check('计划校验用 RULE_TYPES，含 map 的导入不会被判非法', plan.includes('RULE_TYPES.includes'));

const css = read('src/styles/shell.css');
check('多行文本域有样式（.map-table）', css.includes('.map-table'));
check('错误列表用警示色（.hint-line.map-error）', css.includes('.hint-line.map-error'));

let locales = 0;
const localeKeys = ["'ruleType.map':", "'ruleDesc.map':", "'f.mapTable':", "'f.mapHint':", "'f.mapCaseSensitive':", "'f.mapCount':", "'ph.mapTable':", "'ruleErr.mapEmpty':", "'ruleErr.mapNoSeparator':", "'ruleErr.mapEmptyKey':", "'ruleErr.mapDupKey':", "'ruleErr.mapTooMany':", "'ruleSum.map':", "'ruleSum.mapCase':"];
for (const file of readdirSync(path.join(appRoot, 'src/locales'))) {
  if (!file.endsWith('.ts')) continue;
  const body = readFileSync(path.join(appRoot, 'src/locales', file), 'utf8');
  if (localeKeys.every((k) => body.includes(k))) locales += 1;
}
check('五语种都补齐 14 个对照表键', locales === 5, `${locales} 个语种齐全`);

// ---------- C. 文档同源 ----------
const docsRoot = path.join(appRoot, '..', 'docs');
const gap = readFileSync(path.join(docsRoot, 'FEATURE-GAP.md'), 'utf8');
const row313 = gap.split(/\r?\n/).find((l) => l.startsWith('| 3.13 ')) ?? '';
check('FEATURE-GAP 3.13 行已标记对照表落地', row313.includes('对照表'), row313.slice(0, 160));
check('FEATURE-GAP 3.13 行记录 test:map 证据', row313.includes('test:map'), row313.slice(0, 160));

const semantics = readFileSync(path.join(docsRoot, '规则语义确认清单.md'), 'utf8');
check('语义清单新增「对照表」一节', semantics.includes('对照表'));
check('语义清单写明「替换文本不再扫描」',
  semantics.includes('不再扫描') || semantics.includes('不再参与扫描') || semantics.includes('不二次扫描'));
check('语义清单写明最长键优先', semantics.includes('最长'));

console.log(`\n对照表规则自测：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
