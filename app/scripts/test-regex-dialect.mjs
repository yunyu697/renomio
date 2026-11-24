/**
 * 正则方言自测：替换串里的 \1..\9 按分组引用处理（Delphi 习惯），\\1 为字面。
 * 纯逻辑，不依赖窗口；用 esbuild 就地打包 src/lib/rules.ts。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, '..', 'node_modules', '.cache', 'regex-dialect-test.mjs');
buildSync({
  entryPoints: [path.join(here, '..', 'src', 'lib', 'rules.ts')],
  bundle: true,
  format: 'esm',
  outfile,
  logLevel: 'silent',
});

const { convertBackslashRefs, maxBackslashRef, ruleError, applyRules } = await import(pathToFileURL(outfile).href);

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

// 1. 反向引用转换
check('\\1 → $1', convertBackslashRefs('\\1') === '$1');
check('\\2 与 \\9 → $2 $9', convertBackslashRefs('[\\2]\\9') === '[$2]$9');
check('混合 $1 与 \\2 并存', convertBackslashRefs('$1-\\2') === '$1-$2');
check('\\0 不当作分组（保持字面）', convertBackslashRefs('\\0') === '\\0');
check('\\a 等非数字转义原样保留', convertBackslashRefs('\\n\\t') === '\\n\\t');
check('\\\\1 表示字面反斜杠 + 1', convertBackslashRefs('\\\\1') === '\\1');
check('普通文本不受影响', convertBackslashRefs('旅行_第\\1组') === '旅行_第$1组');

// 2. 引用的最大分组号
check('maxBackslashRef(空) = 0', maxBackslashRef('') === 0);
check('maxBackslashRef(\\1\\3) = 3', maxBackslashRef('\\1\\3') === 3);
check('maxBackslashRef(\\\\1) = 0', maxBackslashRef('\\\\1') === 0);
check('maxBackslashRef($1) = 0', maxBackslashRef('$1') === 0);

// 3. 分组数校验：引用超过分组数要报错
const baseRule = {
  id: 'r1', type: 'replace', enabled: true, find: '(\\d{3})', replace: '\\1',
  caseSensitive: false, regex: true, nth: 0,
};
check('引用 1 ≤ 分组 1 → 不报错', ruleError(baseRule) === null, String(ruleError(baseRule)));
check(
  '引用 3 > 分组 1 → 报错并提示分组数',
  typeof ruleError({ ...baseRule, replace: '\\3' }) === 'string'
    && ruleError({ ...baseRule, replace: '\\3' }).includes('3')
    && ruleError({ ...baseRule, replace: '\\3' }).includes('1'),
  String(ruleError({ ...baseRule, replace: '\\3' })),
);
check(
  '两个分组时引用 \\2 → 不报错',
  ruleError({ ...baseRule, find: '(\\d)(\\d)', replace: '\\2\\1' }) === null,
  String(ruleError({ ...baseRule, find: '(\\d)(\\d)', replace: '\\2\\1' })),
);
check(
  '\\\\1 是字面，不参与分组校验',
  ruleError({ ...baseRule, find: 'abc', replace: '\\\\1' }) === null,
  String(ruleError({ ...baseRule, find: 'abc', replace: '\\\\1' })),
);
check(
  '非正则规则不做分组校验（\\3 当普通文本）',
  ruleError({ ...baseRule, regex: false, find: 'abc', replace: '\\3' }) === null,
);

// 4. 端到端：applyRules 里真的按捕获组替换
const ctx = { vars: {}, nextNumber: () => 1, peekNumber: () => 1 };
const out = applyRules(
  { stem: '照片001', ext: 'jpg' },
  false,
  [
    { ...baseRule, find: '^(照片)(\\d{3})$', replace: '\\2_\\1' },
  ],
  '',
  ctx,
  true,
);
check('applyRules：\\2_\\1 → 001_照片', out.stem === '001_照片' && out.ext === 'jpg', JSON.stringify(out));

const literal = applyRules(
  { stem: 'a', ext: 'txt' },
  false,
  [{ ...baseRule, regex: false, find: 'a', replace: '\\1x' }],
  '',
  ctx,
  true,
);
check('非正则替换：\\1 保持字面', literal.stem === '\\1x', JSON.stringify(literal));

console.log(`\n正则方言自测：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
