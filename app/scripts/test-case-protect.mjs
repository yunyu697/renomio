/**
 * 大小写例外词表自测：protect 命中的片段在 upper/lower/title/invert/random 后保留原大小写。
 * 纯逻辑，不依赖窗口；用 esbuild 就地打包 src/lib/rules.ts。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, '..', 'node_modules', '.cache', 'case-protect-test.mjs');
buildSync({
  entryPoints: [path.join(here, '..', 'src', 'lib', 'rules.ts')],
  bundle: true,
  format: 'esm',
  outfile,
  logLevel: 'silent',
});

const {
  applyRules, protectTokens, restoreProtected, ruleError,
} = await import(pathToFileURL(outfile).href);

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

const ctx = { vars: {}, nextNumber: () => 1, peekNumber: () => 1 };
const caseRule = (over = {}) => ({
  id: 'c1', type: 'case', enabled: true, mode: 'lower', separators: ' -_.', protect: '', ...over,
});

/** 只跑一条大小写规则，返回新的 stem */
const runCase = (stem, over = {}) => applyRules({ stem, ext: 'jpg' }, false, [caseRule(over)], '', ctx, true).stem;

// 1. 词表解析
check('protectTokens 逗号分隔', JSON.stringify(protectTokens('PDF, iOS')) === '["PDF","iOS"]',
  JSON.stringify(protectTokens('PDF, iOS')));
check('protectTokens 换行/分号/全角逗号都算分隔', JSON.stringify(protectTokens('a\nb;c，d')) === '["a","b","c","d"]',
  JSON.stringify(protectTokens('a\nb;c，d')));
check('protectTokens 忽略空白项', protectTokens(' , \n ').length === 0, JSON.stringify(protectTokens(' , \n ')));

// 2. 没有例外词时行为不变
check('无例外词：upper 全大写', runCase('iPhone Photo', { mode: 'upper' }) === 'IPHONE PHOTO',
  runCase('iPhone Photo', { mode: 'upper' }));

// 3. 精确例外词
check(
  'upper + 例外词 iPhone：iPhone 原样，其余大写',
  runCase('iPhone Photo', { mode: 'upper', protect: 'iPhone' }) === 'iPhone PHOTO',
  runCase('iPhone Photo', { mode: 'upper', protect: 'iPhone' }),
);
check(
  'lower + 例外词 PDF：PDF 原样，其余小写',
  runCase('PDF_Report', { mode: 'lower', protect: 'PDF' }) === 'PDF_report',
  runCase('PDF_Report', { mode: 'lower', protect: 'PDF' }),
);
check(
  '例外词大小写不敏感匹配（写 iphone 也能护住 iPhone）',
  runCase('iPhone Photo', { mode: 'upper', protect: 'iphone' }) === 'iPhone PHOTO',
  runCase('iPhone Photo', { mode: 'upper', protect: 'iphone' }),
);

// 4. 通配符
check(
  '通配 * 护住 i 开头的整段（i* → iPhone）',
  runCase('iPhone Photo', { mode: 'upper', protect: 'i*' }) === 'iPhone PHOTO',
  runCase('iPhone Photo', { mode: 'upper', protect: 'i*' }),
);
check(
  '通配 ? 匹配单个字符（P?F 护住 PDF 而非整个词）',
  runCase('PDF report', { mode: 'lower', protect: 'P?F' }) === 'PDF report',
  runCase('PDF report', { mode: 'lower', protect: 'P?F' }),
);

// 5. 多条例外词
check(
  '多个例外词（逗号 + 换行）各护各的',
  runCase('iOS PDF Camera', { mode: 'lower', protect: 'iOS,\nPDF' }) === 'iOS PDF camera',
  runCase('iOS PDF Camera', { mode: 'lower', protect: 'iOS,\nPDF' }),
);

// 6. 各模式都生效
check('title + 例外词', runCase('iPhone photo stand', { mode: 'title', protect: 'iPhone' }) === 'iPhone Photo Stand',
  runCase('iPhone photo stand', { mode: 'title', protect: 'iPhone' }));
check('invert + 例外词', runCase('IPhone photo', { mode: 'invert', protect: 'IPhone' }) === 'IPhone PHOTO',
  runCase('IPhone photo', { mode: 'invert', protect: 'IPhone' }));
check('random 模式也护住例外词', runCase('iPhone photo', { mode: 'random', protect: 'iPhone' }).startsWith('iPhone '),
  runCase('iPhone photo', { mode: 'random', protect: 'iPhone' }));

// 7. 边界
check(
  '例外词含正则元字符按字面处理（C++ 不报错，保留原名写法）',
  runCase('C++ notes', { mode: 'upper', protect: 'C++' }) === 'C++ NOTES',
  runCase('C++ notes', { mode: 'upper', protect: 'C++' }),
);
check(
  '例外词不命中时结果与不设例外词一致',
  runCase('photo', { mode: 'upper', protect: 'iPhone' }) === 'PHOTO',
  runCase('photo', { mode: 'upper', protect: 'iPhone' }),
);
check(
  'restoreProtected：长度变化（ß→SS）时退回原文变换结果，不越界',
  restoreProtected('straße', 'STRASSE', 'straße') === 'STRASSE',
  restoreProtected('straße', 'STRASSE', 'straße'),
);
check(
  'restoreProtected：空词表直通',
  restoreProtected('abc', 'ABC', '') === 'ABC',
  restoreProtected('abc', 'ABC', ''),
);

// 8. 规则校验不受影响
check('带例外词的大小写规则无校验错误', ruleError(caseRule({ protect: 'iPhone' })) === null,
  String(ruleError(caseRule({ protect: 'iPhone' }))));

console.log(`\n大小写例外词自测：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
