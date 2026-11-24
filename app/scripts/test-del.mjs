/**
 * 删除规则自测：四种模式（按位置 / 首尾之间 / 字符集 / 修剪）+ 边界 + 校验 + 摘要 + 五语种 + 界面接线。
 * 纯逻辑（esbuild 就地打包 src/lib/rules.ts 与 ruleDefaults.ts），不依赖窗口。
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const outDir = path.join(appRoot, 'node_modules', '.cache', 'del-test');
buildSync({
  entryPoints: [path.join(appRoot, 'src', 'lib', 'rules.ts'), path.join(appRoot, 'src', 'lib', 'ruleDefaults.ts')],
  bundle: true,
  format: 'esm',
  outdir: outDir,
  logLevel: 'silent',
});

const { applyRules, normalizeRule, ruleError, ruleSummary } = await import(pathToFileURL(path.join(outDir, 'rules.js')).href);
const { createRuleDefaults } = await import(pathToFileURL(path.join(outDir, 'ruleDefaults.js')).href);

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

/** 用一条 delete 规则求值，返回新 stem。 */
const run = (stem, patch, { isDir = false } = {}) => {
  const rule = normalizeRule({ id: 'd', type: 'delete', enabled: true, ...patch });
  const out = applyRules({ stem, ext: 'txt' }, isDir, [rule], '', ctx(), true);
  return out.stem;
};

// 1. 默认值
const def = createRuleDefaults('delete', 'x');
check('新增删除规则默认走「修剪首尾」', def.mode === 'trim', def.mode);
check('默认 trimChars 为空串（等价只剪空白）', def.trimChars === '', JSON.stringify(def.trimChars));
check('默认值与类型字段齐全', def.from === 1 && def.count === 3 && def.keep === false && def.left === '[' && def.right === ']');

// 2. 按位置（非尾部）
check('第 1 个起删 2 个：abcdef → cdef', run('abcdef', { mode: 'range', from: 1, count: 2, fromEnd: false }) === 'cdef');
check('中段：第 3 个起删 2 个：abcdef → abef', run('abcdef', { mode: 'range', from: 3, count: 2, fromEnd: false }) === 'abef');
check('起点超出长度 → 原名不变', run('abc', { mode: 'range', from: 99, count: 2, fromEnd: false }) === 'abc');
check('个数超出长度 → 删到结尾', run('abcdef', { mode: 'range', from: 3, count: 99, fromEnd: false }) === 'ab');
check('emoji 按码点计：a😀b 删第 2 个 → ab', run('a😀b', { mode: 'range', from: 2, count: 1, fromEnd: false }) === 'ab', run('a😀b', { mode: 'range', from: 2, count: 1, fromEnd: false }));
check('count 为 0 时规则报错而不是删空', ruleError(normalizeRule({ id: 'e0', type: 'delete', enabled: true, mode: 'range', from: 1, count: 0 })) !== null);
check('from 为 0 时规则报错', ruleError(normalizeRule({ id: 'e1', type: 'delete', enabled: true, mode: 'range', from: 0, count: 1 })) !== null);

// 3. 从尾部数：起点朝向词尾（与「起始位置」标签一致，本轮修正旧行为）
check('从尾部数 位置 3 + 删 2 个：abcdef → abcf（起点在 d、朝词尾删 de）', run('abcdef', { mode: 'range', from: 3, count: 2, fromEnd: true }) === 'abcf', run('abcdef', { mode: 'range', from: 3, count: 2, fromEnd: true }));
check('旧行为（窗口朝词首删 cd → abef）已不再出现', run('abcdef', { mode: 'range', from: 3, count: 2, fromEnd: true }) !== 'abef');
check('倒数第 1 个起删 2 个：abcdef → abcde（末尾只剩 1 个可删）', run('abcdef', { mode: 'range', from: 1, count: 2, fromEnd: true }) === 'abcde', run('abcdef', { mode: 'range', from: 1, count: 2, fromEnd: true }));
check('删掉末尾 4 个字符：位置 4 + 删除 4 个：abcdef → ab', run('abcdef', { mode: 'range', from: 4, count: 4, fromEnd: true }) === 'ab', run('abcdef', { mode: 'range', from: 4, count: 4, fromEnd: true }));
const tailFrom2 = run('abcdef', { mode: 'range', from: 2, count: 2, fromEnd: true });
check('倒数第 2 个起删 2 个：abcdef → abcd（起点在 e，朝词尾删 ef）', tailFrom2 === 'abcd', tailFrom2);
check('旧行为（窗口朝词首、删到 de → abcf）已不再出现', tailFrom2 !== 'abcf', tailFrom2);
check('倒数第 3 个起删 1 个：abcdef → abcef', run('abcdef', { mode: 'range', from: 3, count: 1, fromEnd: true }) === 'abcef', run('abcdef', { mode: 'range', from: 3, count: 1, fromEnd: true }));
check('从尾部数且个数超出 → 删到词尾', run('abcdef', { mode: 'range', from: 2, count: 99, fromEnd: true }) === 'abcd');
check('从尾部数且起点超出 → 从词首开始删', run('abc', { mode: 'range', from: 99, count: 2, fromEnd: true }) === 'c', run('abc', { mode: 'range', from: 99, count: 2, fromEnd: true }));
check('emoji 从尾部数：a😀b 倒数第 1 个起删 1 个 → a😀', run('a😀b', { mode: 'range', from: 1, count: 1, fromEnd: true }) === 'a😀', run('a😀b', { mode: 'range', from: 1, count: 1, fromEnd: true }));

// 4. 首尾之间
const between = (stem, patch) => run(stem, { mode: 'between', ...patch });
check('含两侧标记：A[xy]B → AB', between('A[xy]B', { left: '[', right: ']', includeLeft: true, includeRight: true }) === 'AB');
check('不含两侧标记：A[xy]B → A[]B', between('A[xy]B', { left: '[', right: ']', includeLeft: false, includeRight: false }) === 'A[]B');
check('只含左标记、保留右标记：A[xy]B → A]B', between('A[xy]B', { left: '[', right: ']', includeLeft: true, includeRight: false }) === 'A]B', between('A[xy]B', { left: '[', right: ']', includeLeft: true, includeRight: false }));
check('只留左标记（到结尾）：A[xy]B → A', between('A[xy]B', { left: '[', right: '', includeLeft: true, includeRight: false }) === 'A');
check('只留右标记、保留右标记：A[xy]B → ]B', between('A[xy]B', { left: '', right: ']', includeLeft: true, includeRight: false }) === ']B', between('A[xy]B', { left: '', right: ']', includeLeft: true, includeRight: false }));
check('只留右标记、连右标记一起删：A[xy]B → B', between('A[xy]B', { left: '', right: ']', includeLeft: true, includeRight: true }) === 'B', between('A[xy]B', { left: '', right: ']', includeLeft: true, includeRight: true }));
check('两个标记都空 → 不改名（引擎层兜底，界面另有报错）', between('abc', { left: '', right: '', includeLeft: true, includeRight: true }) === 'abc');
check('两个标记都空 → 规则卡报错', ruleError(normalizeRule({ id: 'e2', type: 'delete', enabled: true, mode: 'between', left: '', right: '' })) === '首尾之间模式下，起止标记至少要填一个', String(ruleError(normalizeRule({ id: 'e2', type: 'delete', enabled: true, mode: 'between', left: '', right: '' }))));
check('只填一个标记不算错', ruleError(normalizeRule({ id: 'e3', type: 'delete', enabled: true, mode: 'between', left: '[', right: '' })) === null);
check('左标记找不到 → 原名不变', between('plain', { left: '[', right: ']', includeLeft: true, includeRight: true }) === 'plain');
check('右标记找不到 → 原名不变', between('a[b', { left: '[', right: ']', includeLeft: true, includeRight: true }) === 'a[b');
check('右标记出现在左标记之前 → 原名不变（不反向剪）', between('a]b[c', { left: '[', right: ']', includeLeft: true, includeRight: true }) === 'a]b[c', between('a]b[c', { left: '[', right: ']', includeLeft: true, includeRight: true }));
check('emoji 前导（码元/码点换算）：😀[xy]B → 😀B', between('😀[xy]B', { left: '[', right: ']', includeLeft: true, includeRight: true }) === '😀B', between('😀[xy]B', { left: '[', right: ']', includeLeft: true, includeRight: true }));
check('同一标记成对出现：a|bc|d → ad', between('a|bc|d', { left: '|', right: '|', includeLeft: true, includeRight: true }) === 'ad', between('a|bc|d', { left: '|', right: '|', includeLeft: true, includeRight: true }));
check('多字标记：前缀_保留_文字 → 前缀文字', between('前缀_保留_文字', { left: '_', right: '_', includeLeft: true, includeRight: true }) === '前缀文字');
check('标记之间为空 → 无变化', between('A[]B', { left: '[', right: ']', includeLeft: false, includeRight: false }) === 'A[]B');

// 5. 字符集
const charset = (stem, patch) => run(stem, { mode: 'charset', ...patch });
check('删数字：abc123 → abc', charset('abc123', { chars: '0123456789', keep: false }) === 'abc');
check('只保留数字：abc123 → 123', charset('abc123', { chars: '0123456789', keep: true }) === '123');
check('字符集含多字节字符：a😀b1 删 😀 → ab1', charset('a😀b1', { chars: '😀', keep: false }) === 'ab1');
check('中文字符集：旧照片 001 删 旧 → 照片 001', charset('旧照片 001', { chars: '旧', keep: false }) === '照片 001');
check('空字符集报错', ruleError(normalizeRule({ id: 'e4', type: 'delete', enabled: true, mode: 'charset', chars: '' })) !== null);
check('全部字符被删 → 空名（交由空名策略处理）', charset('123', { chars: '0123456789', keep: false }) === '');

// 6. 修剪
const trim = (stem, patch = {}) => run(stem, { mode: 'trim', ...patch });
check('默认剪空白：两空格 → ab', trim('  ab  ') === 'ab');
check('全角空格也剪：\\u3000ab\\u3000 → ab', trim('\u3000ab\u3000') === 'ab', JSON.stringify(trim('\u3000ab\u3000')));
check('制表与换行也剪', trim('\t\nab\r\n') === 'ab', JSON.stringify(trim('\t\nab\r\n')));
check('中间空格不受影响：a b → a b', trim('a b') === 'a b');
check('自定义字符连续剪：---ab--- → ab', trim('---ab---', { trimChars: '-' }) === 'ab');
check('自定义字符两端各不同：xxabyy → ab', trim('xxabyy', { trimChars: 'xy' }) === 'ab');
check('自定义字符不剪中间：a-b → a-b', trim('a-b', { trimChars: '-' }) === 'a-b');
check('自定义字符全被剪光：--- → 空名', trim('---', { trimChars: '-' }) === '');
check('自定义多字集合按字符：ababab 剪 ab → 空名', trim('ababab', { trimChars: 'ab' }) === '');
check('trim 模式无值不报错', ruleError(normalizeRule({ id: 'e5', type: 'delete', enabled: true, mode: 'trim' })) === null);

// 7. 旧存档兼容
const legacy = normalizeRule({ id: 'old', type: 'delete', enabled: true, mode: 'trim', from: 1, fromEnd: false, count: 3 });
check('旧规则缺 trimChars → 补空串', legacy.trimChars === '', JSON.stringify(legacy.trimChars));
check('旧规则其余字段不改动', legacy.mode === 'trim' && legacy.count === 3 && legacy.from === 1);
check('旧规则求值等价旧行为（只剪空白）', run('  ab  ', { mode: 'trim' }) === 'ab');

// 8. 目录同样适用（重命名文件夹也要能删字符）
check('目录名同样执行删除规则：两空格目录 → 目录', run('  目录  ', { mode: 'trim' }, { isDir: true }) === '目录', JSON.stringify(run('  目录  ', { mode: 'trim' }, { isDir: true })));

// 9. 摘要
const sumRange = ruleSummary(normalizeRule({ id: 's1', type: 'delete', enabled: true, mode: 'range', from: 2, count: 3, fromEnd: false }));
check('摘要：按位置写明起点与个数', sumRange.includes('2') && sumRange.includes('3'), sumRange);
const sumEnd = ruleSummary(normalizeRule({ id: 's2', type: 'delete', enabled: true, mode: 'range', from: 2, count: 3, fromEnd: true }));
check('摘要：从尾部数用独立文案并点明朝结尾', sumEnd.includes('2') && /end|倒数|末尾/i.test(sumEnd), sumEnd);
const sumTrim = ruleSummary(normalizeRule({ id: 's3', type: 'delete', enabled: true, mode: 'trim', trimChars: '' }));
check('摘要：修剪未填字符时说明剪空白', /空白|whitespace|espacios/i.test(sumTrim), sumTrim);
const sumTrimChars = ruleSummary(normalizeRule({ id: 's4', type: 'delete', enabled: true, mode: 'trim', trimChars: '-' }));
check('摘要：修剪填了字符时写明该字符', sumTrimChars.includes('-') && sumTrimChars !== sumTrim, sumTrimChars);
const sumKeep = ruleSummary(normalizeRule({ id: 's5', type: 'delete', enabled: true, mode: 'charset', chars: '0123', keep: true }));
check('摘要：字符集保留模式写明字符集', sumKeep.includes('0123'), sumKeep);
const sumDrop = ruleSummary(normalizeRule({ id: 's6', type: 'delete', enabled: true, mode: 'charset', chars: '0123', keep: false }));
check('摘要：保留与删除是两句不同文案', sumDrop !== sumKeep, sumDrop);
check('所有摘要都不是裸键', [sumRange, sumEnd, sumTrim, sumTrimChars, sumKeep, sumDrop].every((s) => s && !s.includes('ruleSum.')));

// 10. 五语种文案齐全
const keys = ['f.trimChars', 'ph.trimChars', 'ruleErr.delMarkerRequired', 'ruleSum.trimChars', 'ruleSum.rangeEnd'];
for (const lang of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'es-ES']) {
  const src = readFileSync(path.join(appRoot, 'src', 'locales', `${lang}.ts`), 'utf8');
  const missing = keys.filter((key) => !src.includes(`'${key}':`));
  check(`${lang} 的删除规则文案齐全（${keys.length} 条）`, missing.length === 0, missing.join(','));
}

// 11. 界面接线（防「引擎改了、界面没接」）
const editorSrc = readFileSync(path.join(appRoot, 'src', 'components', 'RuleEditor.tsx'), 'utf8');
const block = editorSrc.slice(editorSrc.indexOf('function DeleteEditor'), editorSrc.indexOf('function NumberEditor'));
check('编辑器四种模式都有入口', ['o.range', 'o.between', 'o.charset', 'o.trim'].every((k) => block.includes(`t('${k}')`)), 'modes');
check('模式分段带 testid', block.includes('testId="delete-mode"'));
check('按位置的起点/个数输入带 testid', block.includes('testId="delete-from"') && block.includes('testId="delete-count"'));
check('「从尾部数」开关带 testid', block.includes('testId="delete-from-end"'), 'toggle');
check('「从尾部数」打开时给出如何删末尾 N 个的说明', block.includes('data-testid="delete-from-end-hint"') && block.includes("t('f.fromEndHint')"), 'hint');
check('首尾之间左右标记带 testid', block.includes('testId="delete-left"') && block.includes('testId="delete-right"'));
check('字符集输入带 testid', block.includes('testId="delete-chars"'));
check('修剪字符输入带 testid 与提示', block.includes('testId="delete-trim-chars"') && block.includes('data-testid="delete-trim-hint"'));
check('标记包含与「只保留」开关都带 testid（e2e 可点）', ['delete-include-left', 'delete-include-right', 'delete-keep'].every((id) => block.includes(`testId="${id}"`)), 'toggles');

console.log(`\n删除规则自测：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
