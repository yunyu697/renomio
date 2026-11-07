/**
 * 元变量（<NAME>/<EXT>/<DATE>/<SIZE>/<CRC32>…）真实文件验证。
 *
 * 做法：把 src/lib/vars.ts 与 src/lib/rules.ts 用 TypeScript 的 transpileModule
 * 转成 ESM 后直接导入（不经构建），在临时目录里建真实文件，
 * 用 fs.stat 得到的真实修改时间/字节数 + Node 独立算出的哈希构造上下文，
 * 逐条断言展开结果；同时校验未知变量与 <#> 误用的报错。
 */
import { existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'renomio-vars-'));
const workDir = mkdtempSync(join(tmpdir(), 'renomio-vars-files-'));
let passed = 0;
let failed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    failures.push({ name, actual, expected });
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `  actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`}`);
}

function transpile(name) {
  const source = readFileSync(join(root, 'src', 'lib', `${name}.ts`), 'utf8').replace(
    "from '../i18n'",
    "from './i18n.mjs'",
  ).replace("from './vars'", "from './vars.mjs'");
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  writeFileSync(join(outDir, `${name}.mjs`), out);
  return pathToFileURL(join(outDir, `${name}.mjs`)).href;
}

writeFileSync(
  join(outDir, 'i18n.mjs'),
  'export function t(key, params = {}) { return key + ":" + Object.entries(params).map(([k, v]) => k + "=" + v).join(","); }\n',
);

const varsUrl = transpile('vars');
const rulesUrl = transpile('rules');

/** 独立实现的 CRC32（逐位算法，和被测实现的查表法不同） */
function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

async function main() {
  const { expandTemplate, scanTemplate, dirNameOf } = await import(varsUrl);
  const { ruleError, applyRules } = await import(rulesUrl);

  const folder = join(workDir, '旅行照片');
  mkdirSync(folder, { recursive: true });
  const file = join(folder, 'IMG_2048.jpg');
  const bytes = Buffer.alloc(123456);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37 + 11) & 0xff;
  writeFileSync(file, bytes);

  // 中文名、无扩展名、超长名（240 个汉字 + .txt，仍在单组件 255 内）各建一个真实文件
  const cnFile = join(folder, '中文文件.jpg');
  writeFileSync(cnFile, bytes);
  const noExtFile = join(folder, '无扩展名');
  writeFileSync(noExtFile, bytes);
  const longStem = '长'.repeat(240);
  const longFile = join(folder, `${longStem}.txt`);
  writeFileSync(longFile, bytes);

  // 固定修改时间为本地 2026-01-02 03:04:05
  const stamp = new Date(2026, 0, 2, 3, 4, 5, 0);
  utimesSync(file, stamp, stamp);
  const stat = statSync(file);
  const md5 = createHash('md5').update(bytes).digest('hex');
  const sha1 = createHash('sha1').update(bytes).digest('hex');

  const ctx = {
    stem: 'IMG_2048',
    ext: 'jpg',
    dirName: dirNameOf(folder),
    modified: stat.mtimeMs,
    size: stat.size,
    hashes: { crc32: crc32(bytes), md5, sha1 },
    users: ['公司', '项目A', '', '', '', '', '', '', ''],
  };

  check('stat.size 等于写入字节数', stat.size, bytes.length);
  check('DIR 取真实目录名', ctx.dirName, '旅行照片');
  check('NAME', expandTemplate('<NAME>', ctx), 'IMG_2048');
  check('EXT 不含点', expandTemplate('<EXT>', ctx), 'jpg');
  check('DOTEXT 含点', expandTemplate('<DOTEXT>', ctx), '.jpg');
  check('NAME_<#><EXT> 组合（EXT 不含点）', expandTemplate('<NAME>_<#><EXT>', { ...ctx, counter: '007' }), 'IMG_2048_007jpg');
  check('NAME_<#><DOTEXT> 组合（DOTEXT 含点）', expandTemplate('<NAME>_<#><DOTEXT>', { ...ctx, counter: '007' }), 'IMG_2048_007.jpg');
  check('变量名大小写不敏感', expandTemplate('<name>-<ext>', ctx), 'IMG_2048-jpg');
  check('DATE 默认格式取修改时间', expandTemplate('<DATE>', ctx), '20260102');
  check('DATE 格式串', expandTemplate('<DATE:yyyy-MM-dd>', ctx), '2026-01-02');
  check('TIME 默认格式', expandTemplate('<TIME>', ctx), '030405');
  check('TIME 格式串', expandTemplate('<TIME:HH-mm-ss>', ctx), '03-04-05');
  check('SIZE 字节', expandTemplate('<SIZE>', ctx), '123456');
  check('SIZE KB 换单位（向下取整）', expandTemplate('<SIZE:KB>', ctx), '120');
  check('SIZE KB 补零', expandTemplate('<SIZE:KB:6>', ctx), '000120');
  check('CRC32 与 Node 独立实现一致', expandTemplate('<CRC32>', ctx), crc32(bytes));
  check('MD5 与 node:crypto 一致', expandTemplate('<MD5>', ctx), md5);
  check('SHA1 与 node:crypto 一致', expandTemplate('<SHA1>', ctx), sha1);
  check('USER1', expandTemplate('<USER1>', ctx), '公司');
  check('USER9 未设置为空串', expandTemplate('<USER9>', ctx), '');
  check('目录扩展名为空', expandTemplate('<EXT>|<DOTEXT>', { ...ctx, ext: '' }), '|');
  check('同一文件多次引用哈希共用同一值', expandTemplate('<MD5>|<MD5>', ctx), `${md5}|${md5}`);

  // --- 新增元变量：<FILENAME> / <SUBSTR> / <DIFNSUBSTR>（真实文件：中文、无扩展名、超长） ---
  const cnStat = statSync(cnFile);
  const noExtStat = statSync(noExtFile);
  const longStat = statSync(longFile);
  const cnCtx = { ...ctx, stem: '中文文件', ext: 'jpg', size: cnStat.size };
  const noExtCtx = { ...ctx, stem: '无扩展名', ext: '', size: noExtStat.size };
  const longCtx = { ...ctx, stem: longStem, ext: 'txt', size: longStat.size };
  check('中文文件真实落盘字节数', cnStat.size, bytes.length);
  check('无扩展名文件真实落盘字节数', noExtStat.size, bytes.length);
  check('超长文件真实落盘字节数', longStat.size, bytes.length);

  check('FILENAME 含扩展名', expandTemplate('<FILENAME>', ctx), 'IMG_2048.jpg');
  check('FILENAME 大小写不敏感', expandTemplate('<filename>', ctx), 'IMG_2048.jpg');
  check('SUBSTR 无参数取全部原名', expandTemplate('<SUBSTR>', ctx), 'IMG_2048');
  check('SUBSTR:起 到末尾', expandTemplate('<SUBSTR:5>', ctx), '2048');
  check('SUBSTR:起:长 截一段', expandTemplate('<SUBSTR:5:4>', ctx), '2048');
  check('SUBSTR 从第 1 位取 4 个', expandTemplate('<SUBSTR:1:4>', ctx), 'IMG_');
  check('SUBSTR 负起始从末尾数（-4）', expandTemplate('<SUBSTR:-4>', ctx), '2048');
  check('SUBSTR 长度超过剩余部分取到末尾', expandTemplate('<SUBSTR:5:999>', ctx), '2048');
  check('SUBSTR 起始超过末尾得到空串', expandTemplate('<SUBSTR:9>', ctx), '');
  check('SUBSTR 极大起始得到空串', expandTemplate('<SUBSTR:999:5>', ctx), '');
  check('SUBSTR 负起始超过开头钳到第 1 位', expandTemplate('<SUBSTR:-99:2>', ctx), 'IM');
  check('SUBSTR 长度为 0 得到空串', expandTemplate('<SUBSTR:5:0>', ctx), '');
  check('SUBSTR 变量名大小写不敏感', expandTemplate('<substr:5:4>', ctx), '2048');
  check('DIFNSUBSTR 无参数为空串', expandTemplate('<DIFNSUBSTR>', ctx), '');
  check('DIFNSUBSTR 去掉前缀子串', expandTemplate('<DIFNSUBSTR:1:4>', ctx), '2048');
  check('DIFNSUBSTR 去掉中间子串', expandTemplate('<DIFNSUBSTR:5:4>', ctx), 'IMG_');
  check('DIFNSUBSTR 去掉整个原名得到空串', expandTemplate('<DIFNSUBSTR:1:8>', ctx), '');
  check('DIFNSUBSTR 去掉末尾子串', expandTemplate('<DIFNSUBSTR:-4>', ctx), 'IMG_');
  check('中文名 FILENAME', expandTemplate('<FILENAME>', cnCtx), '中文文件.jpg');
  check('中文名 SUBSTR 按字符截取', expandTemplate('<SUBSTR:1:2>', cnCtx), '中文');
  check('中文名 SUBSTR 负起始', expandTemplate('<SUBSTR:-2>', cnCtx), '文件');
  check('中文名 DIFNSUBSTR 保留其余汉字', expandTemplate('<DIFNSUBSTR:3:2>', cnCtx), '中文');
  check('无扩展名 FILENAME 就是主体', expandTemplate('<FILENAME>', noExtCtx), '无扩展名');
  check('无扩展名 DOTEXT 为空', expandTemplate('<DOTEXT>', noExtCtx), '');
  check('无扩展名 SUBSTR 截取', expandTemplate('<SUBSTR:1:3>', noExtCtx), '无扩展');
  check('无扩展名 DIFNSUBSTR 去中间', expandTemplate('<DIFNSUBSTR:2:2>', noExtCtx), '无名');
  check('超长名 FILENAME 含扩展名总长 244', expandTemplate('<FILENAME>', longCtx).length, 244);
  check('超长名 SUBSTR 取中段 40 字', expandTemplate('<SUBSTR:201:40>', longCtx).length, 40);
  check('超长名 SUBSTR 起始越过末尾', expandTemplate('<SUBSTR:241>', longCtx), '');
  check('超长名 DIFNSUBSTR 去掉前 200 字后剩 40 字', expandTemplate('<DIFNSUBSTR:1:200>', longCtx).length, 40);
  check('超长名 SUBSTR 末尾 40 字与原名一致', expandTemplate('<SUBSTR:-40>', longCtx), Array.from(longStem).slice(-40).join(''));
  check(
    '超长名 SUBSTR 与 <#> 组合',
    expandTemplate('<SUBSTR:1:3>_<#><DOTEXT>', { ...longCtx, counter: '007' }),
    `长长长_007.txt`,
  );

  const sliceScan = scanTemplate('<SUBSTR:5:4>|<DIFNSUBSTR:-4>|<FILENAME>');
  check('新增变量全部可识别', `${sliceScan.unknown}|${sliceScan.badArgs}`, '|');
  check('SUBSTR 起始 0 报非法参数', scanTemplate('<SUBSTR:0>').badArgs, 'SUBSTR');
  check('SUBSTR 非数字参数报非法参数', scanTemplate('<SUBSTR:a>').badArgs, 'SUBSTR');
  check('SUBSTR 参数过多报非法参数', scanTemplate('<SUBSTR:1:2:3>').badArgs, 'SUBSTR');
  check('DIFNSUBSTR 长度非数字报非法参数', scanTemplate('<DIFNSUBSTR:1:x>').badArgs, 'DIFNSUBSTR');
  check('FILENAME 带参数报非法参数', scanTemplate('<FILENAME:x>').badArgs, 'FILENAME');

  const sliceNumber = {
    id: 'r3', type: 'number', enabled: true, expression: '<SUBSTR:5:4>_<#>',
    start: 1, step: 1, digits: 3, padChar: '0', perFolder: false, onlyChecked: false,
  };
  check('编号表达式可用 <SUBSTR>', ruleError(sliceNumber), null);
  const sliceApplied = applyRules(
    { stem: 'IMG_2048', ext: 'jpg' }, false, [sliceNumber], folder,
    { nextNumber: () => 7, peekNumber: () => 7, vars: ctx }, true,
  );
  check('SUBSTR 与 <#> 组合实际改名', `${sliceApplied.stem}.${sliceApplied.ext}`, '2048_007.jpg');
  const swapNumber = { ...sliceNumber, id: 'r4', expression: '<DIFNSUBSTR:5:4><SUBSTR:5:4>_<#>' };
  const swapApplied = applyRules(
    { stem: 'IMG_2048', ext: 'jpg' }, false, [swapNumber], folder,
    { nextNumber: () => 7, peekNumber: () => 7, vars: ctx }, true,
  );
  check('DIFNSUBSTR + SUBSTR 组合改名（IMG_2048 → IMG_2048_007）', `${swapApplied.stem}.${swapApplied.ext}`, 'IMG_2048_007.jpg');
  check('添加规则可用 <FILENAME>', ruleError({
    id: 'r5', type: 'add', enabled: true, mode: 'direct', text: '<FILENAME>',
    anchor: 'end', position: 1, fromEnd: true, padTo: 4, padChar: '0',
  }), null);

  const unknown = scanTemplate('<NAME>_<FOO>');
  check('未知变量被识别', unknown.unknown, 'FOO');
  const addRule = { id: 'r1', type: 'add', enabled: true, mode: 'direct', text: '<NOPE>', anchor: 'end', position: 1, fromEnd: true, padTo: 4, padChar: '0' };
  check('未知变量报错而不是原样输出', ruleError(addRule).includes('unknownVar'), true);
  const badArgs = { ...addRule, text: '<SIZE:XB>' };
  check('SIZE 非法单位报错', ruleError(badArgs).includes('badVarArgs'), true);
  const counterInAdd = { ...addRule, text: '<#>' };
  check('<#> 用在非编号规则里报错', ruleError(counterInAdd).includes('counterOnlyNumber'), true);
  const numberRule = { id: 'r2', type: 'number', enabled: true, expression: '<NAME>_<#>', start: 5, step: 2, digits: 3, padChar: '0', perFolder: false, onlyChecked: false };
  check('编号表达式允许 <#>', ruleError(numberRule), null);
  check('编号表达式也允许元变量', ruleError({ ...numberRule, expression: '<NAME>_<DATE>_<#>' }), null);

  // --- 真实磁盘改名 → 校验 → 还原（新变量单独跑一遍，不只验证引擎输出） ---
  const realRenames = [
    { file: 'IMG_2048.jpg', template: '<SUBSTR:5:4>_<#><DOTEXT>', ctx, expect: '2048_007.jpg' },
    { file: '中文文件.jpg', template: '<SUBSTR:3:2>_<#><DOTEXT>', ctx: cnCtx, expect: '文件_007.jpg' },
    { file: '无扩展名', template: '<DIFNSUBSTR:2:2><SUBSTR:2:2>', ctx: noExtCtx, expect: '无名扩展' },
    { file: `${longStem}.txt`, template: '<SUBSTR:1:3>_<#><DOTEXT>', ctx: longCtx, expect: '长长长_007.txt' },
  ];
  for (const item of realRenames) {
    const source = join(folder, item.file);
    const target = join(folder, item.expect);
    const computed = expandTemplate(item.template, { ...item.ctx, counter: '007' });
    const to = join(folder, computed);
    check(`真实改名计算：${item.file} → ${computed}`, computed, item.expect);
    renameSync(source, to);
    check(`真实改名落盘存在：${computed}`, existsSync(to), true);
    check(`真实改名后原名不存在：${item.file}`, existsSync(source), false);
    renameSync(to, source);
    check(`撤销还原：${item.file}`, existsSync(source), true);
    check(`撤销后新名不存在：${computed}`, existsSync(target), false);
  }

  console.log(`\nRESULT ${passed}/${passed + failed} passed, ${failed} failed`);
  if (failures.length) console.log(JSON.stringify(failures, null, 2));
  return failed === 0;
}

try {
  const ok = await main();
  process.exitCode = ok ? 0 : 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
}
