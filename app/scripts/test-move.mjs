/**
 * 「移动子串」规则自测：按位置 / 按标记两种定位、目标之前之后、从尾部计数、
 * 越界与缺标记的兜底、旧规则字段兼容、五语种文案齐全。
 * 纯逻辑（esbuild 就地打包 src/lib/rules.ts），不依赖窗口。
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const outfile = path.join(appRoot, 'node_modules', '.cache', 'move-test.mjs');
buildSync({
  entryPoints: [path.join(appRoot, 'src', 'lib', 'rules.ts')],
  bundle: true,
  format: 'esm',
  outfile,
  logLevel: 'silent',
});

const { applyRules, normalizeRule, ruleError, ruleSummary } = await import(pathToFileURL(outfile).href);

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

/** 用一条 move 规则给单个名字求值（其它规则类型不参与）。 */
const run = (stem, move, ext = 'txt') => {
  const rule = normalizeRule({ id: 'mv', type: 'move', enabled: true, ...move });
  const out = applyRules({ stem, ext }, false, [rule], '', {
    nextNumber: () => 1,
    peekNumber: () => 1,
    vars: { name: stem, ext, dir: '', parent: '', date: '', size: '', hash: '', user0: '', users: [] },
  }, true);
  return `${out.stem}.${out.ext}`;
};

// 1. 旧规则（只有 from/count/to）兼容：字段补齐且行为不变
const legacy = normalizeRule({ id: 'old', type: 'move', enabled: true, from: 2, fromEnd: false, count: 2, to: 1, toEnd: false });
check('旧规则补 by=index', legacy.by === 'index', legacy.by);
check('旧规则补 insert=before', legacy.insert === 'before', legacy.insert);
check('旧规则补左右标记默认值', legacy.left === '[' && legacy.right === ']', `${legacy.left}|${legacy.right}`);
check('旧规则补包含标记默认值', legacy.includeLeft === true && legacy.includeRight === true);
check('旧规则求值：abcde 第 2 位起 2 个移到第 1 位', run('abcde', { from: 2, fromEnd: false, count: 2, to: 1, toEnd: false }) === 'bcade.txt', run('abcde', { from: 2, fromEnd: false, count: 2, to: 1, toEnd: false }));
check('未补字段的裸规则也能求值（undefined 当 index/before）', run('abcde', { from: 2, count: 2, to: 1, toEnd: false }) === 'bcade.txt', run('abcde', { from: 2, count: 2, to: 1, toEnd: false }));

// 2. 按位置：基本搬运
check('第 4 位起 2 个移到开头', run('abcdefg', { by: 'index', from: 4, count: 2, to: 1, toEnd: false, insert: 'before' }) === 'deabcfg.txt', run('abcdefg', { by: 'index', from: 4, count: 2, to: 1, toEnd: false, insert: 'before' }));
check('第 1 位起 2 个移到末尾（toEnd, to=1 即末尾）', run('abcdefg', { by: 'index', from: 1, count: 2, to: 1, toEnd: true, insert: 'before' }) === 'cdefgab.txt', run('abcdefg', { by: 'index', from: 1, count: 2, to: 1, toEnd: true, insert: 'before' }));
check('从尾部数：倒数第 3 位起 2 个移到开头', run('abcdefg', { by: 'index', from: 3, count: 2, fromEnd: true, to: 1, toEnd: false, insert: 'before' }) === 'efabcdg.txt', run('abcdefg', { by: 'index', from: 3, count: 2, fromEnd: true, to: 1, toEnd: false, insert: 'before' }));

// 3. 目标之前 / 之后（同一 to 值相差一位）
const beforeName = run('abcdefg', { by: 'index', from: 1, count: 2, to: 3, toEnd: false, insert: 'before' });
const afterName = run('abcdefg', { by: 'index', from: 1, count: 2, to: 3, toEnd: false, insert: 'after' });
check('插到第 3 位之前', beforeName === 'cdabefg.txt', beforeName);
check('插到第 3 位之后', afterName === 'cdeabfg.txt', afterName);
check('之前与之后结果不同', beforeName !== afterName);

// 4. 按标记：取两标记之间的内容搬走
check('取 [ ] 之间的内容移到开头（含标记）', run('A[xy]B', { by: 'markers', left: '[', right: ']', includeLeft: true, includeRight: true, to: 1, toEnd: false, insert: 'before' }) === '[xy]AB.txt', run('A[xy]B', { by: 'markers', left: '[', right: ']', includeLeft: true, includeRight: true, to: 1, toEnd: false, insert: 'before' }));
check('取 [ ] 之间的内容移到末尾（不含标记）', run('A[xy]B', { by: 'markers', left: '[', right: ']', includeLeft: false, includeRight: false, to: 1, toEnd: true, insert: 'before' }) === 'A[]Bxy.txt', run('A[xy]B', { by: 'markers', left: '[', right: ']', includeLeft: false, includeRight: false, to: 1, toEnd: true, insert: 'before' }));
check('标记之间为空时原名不变', run('A[]B', { by: 'markers', left: '[', right: ']', includeLeft: false, includeRight: false, to: 1, toEnd: false, insert: 'before' }) === 'A[]B.txt', run('A[]B', { by: 'markers', left: '[', right: ']', includeLeft: false, includeRight: false, to: 1, toEnd: false, insert: 'before' }));
check('标记找不到时整条规则跳过', run('plain', { by: 'markers', left: '[', right: ']', includeLeft: true, includeRight: true, to: 1, toEnd: false, insert: 'before' }) === 'plain.txt', run('plain', { by: 'markers', left: '[', right: ']', includeLeft: true, includeRight: true, to: 1, toEnd: false, insert: 'before' }));
check('只填左标记=从该标记到结尾', run('ab-cd', { by: 'markers', left: '-', right: '', includeLeft: true, includeRight: false, to: 1, toEnd: false, insert: 'before' }) === '-cdab.txt', run('ab-cd', { by: 'markers', left: '-', right: '', includeLeft: true, includeRight: false, to: 1, toEnd: false, insert: 'before' }));
check('只填右标记=从开头到该标记', run('ab-cd', { by: 'markers', left: '', right: '-', includeLeft: false, includeRight: false, to: 1, toEnd: true, insert: 'before' }) === '-cdab.txt', run('ab-cd', { by: 'markers', left: '', right: '-', includeLeft: false, includeRight: false, to: 1, toEnd: true, insert: 'before' }));

// 5. 越界与非法输入：clamp 后不崩、不改出怪名字
check('from 超出长度 → 原名不变', run('abc', { by: 'index', from: 99, count: 2, to: 1, toEnd: false, insert: 'before' }) === 'abc.txt');
check('count 超出长度 → 取到结尾', run('abcd', { by: 'index', from: 3, count: 99, to: 1, toEnd: false, insert: 'before' }) === 'cdab.txt', run('abcd', { by: 'index', from: 3, count: 99, to: 1, toEnd: false, insert: 'before' }));
check('to 超出长度 → 贴到末尾', run('abcd', { by: 'index', from: 1, count: 1, to: 99, toEnd: false, insert: 'before' }) === 'bcda.txt', run('abcd', { by: 'index', from: 1, count: 1, to: 99, toEnd: false, insert: 'before' }));
check('移动整串 → 原名不变', run('abcd', { by: 'index', from: 1, count: 4, to: 1, toEnd: false, insert: 'before' }) === 'abcd.txt');
check('emoji（代理对）按字符计', run('a😀bc', { by: 'index', from: 2, count: 1, to: 1, toEnd: false, insert: 'before' }) === '😀abc.txt', run('a😀bc', { by: 'index', from: 2, count: 1, to: 1, toEnd: false, insert: 'before' }));
check('标记定位也按字符计（emoji 前缀）', run('😀[xy]B', { by: 'markers', left: '[', right: ']', includeLeft: true, includeRight: true, to: 1, toEnd: false, insert: 'before' }) === '[xy]😀B.txt', run('😀[xy]B', { by: 'markers', left: '[', right: ']', includeLeft: true, includeRight: true, to: 1, toEnd: false, insert: 'before' }));

// 6. 校验与摘要
const offRule = normalizeRule({ id: 'e1', type: 'move', enabled: true, by: 'index', from: 0, count: 1, to: 1 });
check('按位置 from=0 报错', ruleError(offRule) === '起始位置与长度需大于 0', String(ruleError(offRule)));
const emptyMarkers = normalizeRule({ id: 'e2', type: 'move', enabled: true, by: 'markers', left: '', right: '', to: 1 });
check('按标记两个标记全空时报错', ruleError(emptyMarkers) === '按标记移动时，起止标记至少要填一个', String(ruleError(emptyMarkers)));
const halfMarkers = normalizeRule({ id: 'e3', type: 'move', enabled: true, by: 'markers', left: '[', right: '', to: 1 });
check('按标记只填一个不报错', ruleError(halfMarkers) === null, String(ruleError(halfMarkers)));
const idxSum = ruleSummary(normalizeRule({ id: 's1', type: 'move', enabled: true, by: 'index', from: 2, count: 3, to: 1, insert: 'after' }));
check('摘要：按位置 + 之后', idxSum.includes('第 2 个字符起 3 个') && idxSum.includes('之后'), idxSum);
const markerSum = ruleSummary(normalizeRule({ id: 's2', type: 'move', enabled: true, by: 'markers', left: '[', right: '', to: 2, toEnd: true }));
check('摘要：按标记 + 结尾占位', markerSum.includes('[') && markerSum.includes('结尾') && markerSum.includes('末尾'), markerSum);
const headSum = ruleSummary(normalizeRule({ id: 's3', type: 'move', enabled: true, by: 'markers', left: '', right: ']', to: 1 }));
check('摘要：左标记为空显示“开头”', headSum.includes('开头'), headSum);

// 7. 五语种文案齐全（缺键会渲染成裸键）
const keys = [
  'f.moveBy', 'f.moveInsert', 'f.moveTo', 'f.moveHint',
  'o.byIndex', 'o.byMarkers', 'o.insertBefore', 'o.insertAfter',
  'ruleErr.markerRequired',
  'ruleSum.move', 'ruleSum.moveTo', 'ruleSum.moveToAfter', 'ruleSum.moveToEnd',
  'ruleSum.moveMarkers', 'ruleSum.moveHead', 'ruleSum.moveTail',
];
for (const lang of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'es-ES']) {
  const src = readFileSync(path.join(appRoot, 'src', 'locales', `${lang}.ts`), 'utf8');
  const missing = keys.filter((key) => !src.includes(`'${key}':`));
  check(`${lang} 的移动规则文案齐全（${keys.length} 条）`, missing.length === 0, missing.join(','));
}
for (const lang of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'es-ES']) {
  const src = readFileSync(path.join(appRoot, 'src', 'locales', `${lang}.ts`), 'utf8');
  const line = src.slice(src.indexOf(`'ruleSum.move':`), src.indexOf('\n', src.indexOf(`'ruleSum.move':`)));
  check(`${lang} 的 ruleSum.move 使用 {target} 占位`, line.includes('{target}'), line.trim());
}

// 8. 编辑器里确实渲染了新控件（防「引擎改了、界面没接线」）
const editorSrc = readFileSync(path.join(appRoot, 'src', 'components', 'RuleEditor.tsx'), 'utf8');
const moveBlock = editorSrc.slice(editorSrc.indexOf('function MoveEditor'), editorSrc.indexOf('function CaseEditor'));
check('编辑器有定位方式分段', moveBlock.includes("t('f.moveBy')") && moveBlock.includes("t('o.byMarkers')") && moveBlock.includes('testId="move-by"'));
check('编辑器有标记输入（带 testid）', moveBlock.includes('testId="move-left"') && moveBlock.includes('testId="move-right"'));
check('编辑器有插入前后分段', moveBlock.includes("t('f.moveInsert')") && moveBlock.includes("t('o.insertAfter')") && moveBlock.includes('testId="move-insert"'));
check('编辑器在标记模式才显示标记字段', moveBlock.includes("=== 'index'") && moveBlock.includes("t('f.startMarker')"));

console.log(`\n移动子串自测：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
