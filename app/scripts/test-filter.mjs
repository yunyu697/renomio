/**
 * 「执行筛选」守卫：纯函数算法实跑 + 界面接线 + 文档同源。
 * 用 esbuild 就地打包 src/lib/patternFilter.ts（它只依赖 glob.ts，不碰窗口）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const outfile = path.join(appRoot, 'node_modules', '.cache', 'filter-test.mjs');
buildSync({
  entryPoints: [path.join(appRoot, 'src', 'lib', 'patternFilter.ts')],
  bundle: true,
  format: 'esm',
  outfile,
  logLevel: 'silent',
});
const { applyPatternFilter } = await import(pathToFileURL(outfile).href);

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

// ---------- A. 算法 ----------
const rows = [
  { path: '/p/a.jpg' },
  { path: '/p/b.png' },
  { path: '/p/c.txt' },
  { path: '/p/sub/d.jpg' },
];
const p = (r) => r.path;

const inc = applyPatternFilter(rows, '*.jpg', '', false, p);
check('保留 *.jpg：留下 2 条、移走 2 条', inc.status === 'applied' && inc.kept.length === 2 && inc.removed === 2, JSON.stringify(inc));

const exc = applyPatternFilter(rows, '', '*.png', false, p);
check('排除 *.png：留下 3 条', exc.status === 'applied' && exc.kept.length === 3, JSON.stringify(exc.status));

const both = applyPatternFilter(rows, '*.jpg;*.png', '*/sub/*', false, p);
check('保留 + 排除叠加：sub 里的 jpg 也被排除，剩 2 条',
  both.status === 'applied' && both.kept.length === 2 && both.kept.every((r) => !r.path.includes('/sub/')),
  JSON.stringify(both));

check('没有通配符 → no-pattern（不当作全部保留）', applyPatternFilter(rows, '  ', ' ', false, p).status === 'no-pattern');
check('一条都不匹配 → no-match 且不动列表', applyPatternFilter(rows, '*.mp4', '', false, p).status === 'no-match');
check('空列表 + 有通配符 → applied 0 条（不误报 no-match）',
  (() => { const o = applyPatternFilter([], '*.jpg', '', false, p); return o.status === 'applied' && o.total === 0; })());
check('大小写不敏感：*.JPG 能匹配 a.jpg', applyPatternFilter(rows, '*.JPG', '', true, p).status === 'applied');
check('大小写敏感：*.JPG 不命中 a.jpg → no-match', applyPatternFilter(rows, '*.JPG', '', false, p).status === 'no-match');
check('多条件用分号分隔', applyPatternFilter(rows, '*.jpg;*.png', '', false, p).kept?.length === 3);
check('多条件用换行分隔（粘贴多行可用）', applyPatternFilter([{ path: '/p/a.jpg' }], '*.jpg\n*.png', '', false, p).status === 'applied');
check('含空格的条件不被拆开（*My Files*）',
  applyPatternFilter([{ path: '/p/My Files/x.jpg' }], '*My Files*', '', false, p).status === 'applied');

// ---------- B. 接线 ----------
const read = (rel) => fs.readFileSync(path.join(appRoot, rel), 'utf8');
const pathBar = read('src/components/PathBar.tsx');
check('路径条筛选组有内联执行按钮 filter-apply', pathBar.includes('data-testid="filter-apply"'));
check('按钮只在填了条件时出现（hasPattern）',
  pathBar.includes('const hasPattern') && /hasPattern && \(/.test(pathBar));
check('输入框 Enter 执行、Esc 清空', pathBar.includes("event.key === 'Enter'") && pathBar.includes("event.key === 'Escape'"));
check('两个输入框都接了键盘约定', (pathBar.match(/keyInFilter\(e,/g) ?? []).length === 2);
check('按钮文案走五语种键 path.applyFilter', pathBar.includes("t('path.applyFilter')"));

const more = read('src/components/ToolbarMore.tsx');
check('更多菜单不再放筛选项', !more.includes('filter-files'));

const store = read('src/store.ts');
check('store 执行筛选走纯函数层', store.includes('applyPatternFilter'));
check('空结果不落地（no-match 时不动列表）', store.includes("outcome.status === 'no-match'"));

let keys = 0;
for (const file of fs.readdirSync(path.join(appRoot, 'src/locales'))) {
  const body = fs.readFileSync(path.join(appRoot, 'src/locales', file), 'utf8');
  if (body.includes("'path.applyFilter':") && body.includes("'toast.filterNoMatch':")) keys += 1;
  if (body.includes("'toolbar.filter':") || body.includes("'toolbar.filterHint':")) keys -= 10;
}
check('五语种都有执行筛选文案，且旧菜单文案已清', keys === 5, String(keys));

const css = read('src/styles/app.css');
check('执行按钮有样式（chip-action）', css.includes('.chip-action'));

// ---------- C. 文档同源 ----------
const gap = fs.readFileSync(path.join(appRoot, '..', 'docs', 'FEATURE-GAP.md'), 'utf8');
const row13 = gap.split(/\r?\n/).find((l) => l.startsWith('| 1.3 ')) ?? '';
check('FEATURE-GAP 1.3 记录了内联执行入口', row13.includes('仅保留匹配') || row13.includes('内联执行'), row13.slice(0, 120));
check('FEATURE-GAP 1.3 记录了 test:filter 与 e2e', row13.includes('test:filter'), row13.slice(0, 160));

console.log(`\n执行筛选守卫：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
