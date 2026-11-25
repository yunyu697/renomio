/**
 * 列宽自适应（FEATURE-GAP 1.5 的「自动列宽」缺口）自测。
 *
 * 判据：**算法本身能跑（不是只写在组件里），界面确实接上了，五语种与文档同源**。
 * 三段：
 *  A. 算法实跑：优先用 Node ≥22.18 的类型剥离直接 import `src/lib/columnFit.ts`
 *     （CI 的 cross-os 不装 node_modules 也能跑），宿主机不支持时回落 tsc 编译再 import；
 *     逐条断言夹取 / 下界 / 上界 / pad / 空样本 / 非法输入 / 一次算多列 / 列宽预算内边距。
 *  B. 接线：MainPane 的六条分隔线都有 testid 与双击自适应、列菜单有「自动列宽」、
 *     空列表给提示、宽度写进 settings.columnWidths，package.json / CI 各一步。
 *  C. 文档：FEATURE-GAP 1.5 行、changelog、根 README、AGENTS 同源。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const repoRoot = path.join(appRoot, '..');

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
const read = (abs) => readFileSync(abs, 'utf8');

// ---- A. 算法实跑 ------------------------------------------------------------
console.log('[A] 纯函数实跑（优先 Node 内置类型剥离，回落 tsc 编译）');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'renomio-columns-'));
const src = path.join(appRoot, 'src', 'lib', 'columnFit.ts');
check('测试前置：columnFit.ts 存在', existsSync(src), src);

// 首选：Node ≥22.18 自带类型剥离，直接 import .ts（CI 的 cross-os 不装 node_modules 也能跑）
let mod = null;
let route = '';
try {
  mod = await import(pathToFileURL(src).href);
  route = 'node 类型剥离';
} catch (err) {
  const tsc = path.join(appRoot, 'node_modules', 'typescript', 'lib', 'tsc.js');
  console.log(`  （类型剥离不可用：${String((err && err.message) || err).slice(0, 90)} → 回落 tsc）`);
  if (existsSync(tsc)) {
    const compiled = spawnSync(
      process.execPath,
      [tsc, src, '--module', 'esnext', '--target', 'es2022', '--moduleResolution', 'bundler', '--outDir', tmp, '--skipLibCheck'],
      { encoding: 'utf8' },
    );
    console.log(`  （tsc 退出码 ${compiled.status}）${(compiled.stdout || compiled.stderr || '').slice(0, 200)}`);
    const outFile = path.join(tmp, 'columnFit.js');
    if (compiled.status === 0 && existsSync(outFile)) mod = await import(pathToFileURL(outFile).href);
    route = 'tsc 编译';
  }
}
rmSync(tmp, { recursive: true, force: true });

check('算法模块已加载并能调用 fitColumnWidth', !!mod && typeof mod.fitColumnWidth === 'function', route);
const srcBody = read(src);
check('算法层不 import 任何模块（纯函数，可脱离浏览器与 node_modules 单测）', !/^\s*import\s/m.test(srcBody) && !/require\(/.test(srcBody));
const tokensCss = read(path.join(appRoot, 'src', 'styles', 'design-system-tokens.css'));
const space5 = Number((tokensCss.match(/--ds-space-5:\s*(\d+)px/) || [])[1] ?? NaN);
const listPad = Number((read(path.join(appRoot, 'src', 'components', 'MainPane.tsx')).match(/const LIST_PAD = (\d+)/) || [])[1] ?? NaN);
check('列宽预算扣的内边距 = 表头/行两侧各 --ds-space-5（LIST_PAD = 2 × 12px）', space5 === 12 && listPad === space5 * 2, `space-5=${space5} LIST_PAD=${listPad}`);

if (mod) {
  const { clampWidth, fitColumnWidth, fitWidths } = mod;
  /** 假测量器：每个字符 8px，便于手算期望值 */
  const measure = (text) => [...text].length * 8;
  const spec = { min: 100, max: 400, pad: 24 };

  check('clampWidth：低于下界取整到下界', clampWidth(40, 100, 400) === 100, String(clampWidth(40, 100, 400)));
  check('clampWidth：高于上界取整到上界', clampWidth(999, 100, 400) === 400, String(clampWidth(999, 100, 400)));
  check('clampWidth：区间内四舍五入取整', clampWidth(120.6, 100, 400) === 121, String(clampWidth(120.6, 100, 400)));
  check('clampWidth：NaN 退回下界（不产出 px: NaN）', clampWidth(Number.NaN, 100, 400) === 100);
  check('clampWidth：Infinity 退回下界', clampWidth(Number.POSITIVE_INFINITY, 100, 400) === 100);

  check('fitColumnWidth：空样本 → 下界', fitColumnWidth([], measure, spec) === 100);
  check('fitColumnWidth：全空字符串 → 下界', fitColumnWidth(['', ''], measure, spec) === 100);
  check('fitColumnWidth：最宽一行决定宽度（10 字符 → 80+24）', fitColumnWidth(['abc', 'abcdefghij'], measure, spec) === 104, String(fitColumnWidth(['abc', 'abcdefghij'], measure, spec)));
  check('fitColumnWidth：pad 计入（同文本不同 pad 差 16）', fitColumnWidth(['abcdefghij'], measure, { ...spec, pad: 40 }) === 120);
  check('fitColumnWidth：短内容被下界夹住', fitColumnWidth(['ab'], measure, spec) === 100);
  check('fitColumnWidth：超长内容被上界夹住（60 字符 → 480+24 → 400）', fitColumnWidth(['x'.repeat(60)], measure, spec) === 400);
  check('fitColumnWidth：null / undefined 项按空处理，不炸也不放大', fitColumnWidth([null, 'ab', undefined], measure, spec) === 100);
  check('fitColumnWidth：测量器返回 NaN 时忽略该行', fitColumnWidth(['ab'], () => Number.NaN, spec) === 100);
  check('fitColumnWidth：CJK / emoji 按注入测量器的码点宽度（未超下界时取 100）', fitColumnWidth(['中文名.jpg', '🎉🎉'], measure, spec) === 100, String(fitColumnWidth(['中文名.jpg', '🎉🎉'], measure, spec)));
  check('fitColumnWidth：CJK 长文件名按码点算宽（13 字 → 104+24）', fitColumnWidth(['中文名字很长的文件.jpg'], measure, spec) === 128, String(fitColumnWidth(['中文名字很长的文件.jpg'], measure, spec)));

  const specs = { name: spec, size: { min: 62, max: 96, pad: 26 } };
  check('fitWidths：没有样本的列不出现在结果里（保持原宽）', !('size' in fitWidths({ name: ['abcdefghij'] }, measure, specs)));
  check('fitWidths：有样本的列按各自 spec 计算', fitWidths({ name: ['abcdefghij'], size: ['12 KB'] }, measure, specs).size === 66, String(fitWidths({ name: ['abcdefghij'], size: ['12 KB'] }, measure, specs).size));
  check('fitWidths：空样本对象 → 空结果', Object.keys(fitWidths({}, measure, specs)).length === 0);
}

// ---- B. 接线 ---------------------------------------------------------------
console.log('[B] 界面接线（源码静态断言）');
const mainPane = read(path.join(appRoot, 'src', 'components', 'MainPane.tsx'));
const COLS = ['name', 'location', 'size', 'modified', 'newName', 'status'];

check('新增 src/lib/columnFit.ts', existsSync(path.join(appRoot, 'src', 'lib', 'columnFit.ts')));
check('MainPane 引入 columnFit 的纯函数', /from '\.\.\/lib\/columnFit'/.test(mainPane) && /fitColumnWidth/.test(mainPane));
check('每列都有上界与占位常量（COLUMN_MAX / COLUMN_PAD）', /const COLUMN_MAX/.test(mainPane) && /const COLUMN_PAD/.test(mainPane));
check('测量走真实行内字体（getComputedStyle + canvas.measureText）', /getComputedStyle\(/.test(mainPane) && /measureText\(/.test(mainPane));
for (const key of COLS) {
  check(`分隔线有 testid：col-grip-${key}`, mainPane.includes(`data-testid="col-grip-${key}"`));
  check(`分隔线双击自适应：${key}`, new RegExp(`onDoubleClick={\\(\\) => fitColumn\\('${key}'\\)}`).test(mainPane));
}
check('列菜单有「自动列宽」按钮（col-autofit）', /data-testid="col-autofit"/.test(mainPane) && /onClick={fitAllColumns}/.test(mainPane));
check('自动列宽只算可见列（shownKeys）', /for \(const key of shownKeys\)/.test(mainPane));
check('空列表给提示而不是算出一堆下界列宽', /t\('main\.autoFitEmpty'\)/.test(mainPane));
check('宽度写进设置（columnWidths 持久化）', /updateSettings\(\{\s*columnWidths/.test(mainPane));
check('样本取自列表真实文本（name/location/size/modified/newName/status）', ['entry.name', 'entry.parent', 'formatSize', 'formatTime', 'r.newName', 'STATUS_KEY'].every((s) => mainPane.includes(s)));

const pkg = JSON.parse(read(path.join(appRoot, 'package.json')));
check('package.json 注册 test:columns', !!pkg.scripts && typeof pkg.scripts['test:columns'] === 'string', JSON.stringify(pkg.scripts?.['test:columns']));
const ci = read(path.join(repoRoot, '.github', 'workflows', 'ci.yml'));
check('CI cross-os 跑 test-columns', ci.includes('node scripts/test-columns.mjs'));

for (const locale of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'es-ES']) {
  const body = read(path.join(appRoot, 'src', 'locales', `${locale}.ts`));
  const missing = ['main.autoFitColumns', 'main.autoFitEmpty'].filter((key) => !body.includes(`'${key}'`));
  check(`五语种文案齐全：${locale}`, missing.length === 0, missing.join(','));
}

// ---- C. 文档同源 -----------------------------------------------------------
console.log('[C] 文档同源');
const gap = read(path.join(repoRoot, 'docs', 'FEATURE-GAP.md'));
const gapLine = gap.split('\n').find((line) => line.startsWith('| 1.5 |')) ?? '';
check('FEATURE-GAP 1.5 行写明自动列宽已有实测', /自动列宽/.test(gapLine), gapLine.slice(0, 160));
check('FEATURE-GAP 1.5 行不再写「我们无自动列宽」', !/无自动列宽/.test(gapLine));
check('FEATURE-GAP changelog 记录本轮', /列宽自适应|自动列宽/.test(gap));
const rootReadme = read(path.join(repoRoot, 'README.md'));
check('根 README 提到自动列宽', /自动列宽/.test(rootReadme));
const agents = read(path.join(repoRoot, 'AGENTS.md'));
check('AGENTS 提到自动列宽', /自动列宽/.test(agents));
const appReadme = read(path.join(appRoot, 'README.md'));
check('app/README 提到 test:columns', /test:columns/.test(appReadme));

console.log(`\n列宽自适应自测：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
