/* 孤儿样式守卫：CSS 里出现、但全量源码里再也找不到的类选择器 = 死代码。
 * 做法：从 src/styles/*.css 里抽出所有 .class，逐个在 src（.ts/.tsx/.html）里按子串搜索；
 * 源码里的类名无论写成 className="x"、模板串还是状态映射表，都会命中同名字面量。
 * 命中不了又不属于白名单的，就是可以删的孤儿样式块。用法：npm run test:css */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const SRC = path.join(APP, 'src');
const CSS_DIR = path.join(SRC, 'styles');

/** 允许存在但源码不引用的类名（外部注入 / 宿主容器 / 预留状态位） */
const ALLOW = new Map([
  ['win', '宿主窗口根节点由 Tauri 侧标记，前端只做样式'],
]);

const CLASS_RE = /\.([A-Za-z_][A-Za-z0-9_-]*)/g;
const SOURCE_EXT = new Set(['.ts', '.tsx', '.html', '.json']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const cssFiles = fs.readdirSync(CSS_DIR).filter((f) => f.endsWith('.css')).map((f) => path.join(CSS_DIR, f));
const sources = walk(SRC)
  .filter((f) => SOURCE_EXT.has(path.extname(f)))
  .map((f) => fs.readFileSync(f, 'utf8'));
sources.push(fs.readFileSync(path.join(APP, 'index.html'), 'utf8'));

/** 把 CSS 里注释去掉，避免注释里提到的类名被当成选择器 */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');

const found = [];
for (const file of cssFiles) {
  const text = stripComments(fs.readFileSync(file, 'utf8'));
  const names = new Set([...text.matchAll(CLASS_RE)].map((m) => m[1]));
  for (const name of names) {
    if (name.length < 2) continue;
    if (ALLOW.has(name)) continue;
    const used = sources.some((s) => s.includes(name));
    if (!used) {
      const hits = [...text.matchAll(CLASS_RE)].length;
      found.push({ file: path.basename(file), name, hits });
    }
  }
}

console.log(`样式文件 ${cssFiles.length} 个，扫描源码 ${sources.length} 份`);
if (!found.length) {
  console.log('RESULT css-orphans 0 孤儿选择器');
  process.exit(0);
}
console.log(`发现 ${found.length} 个孤儿类选择器：`);
for (const f of found) console.log(`  - .${f.name}  (${f.file})`);
console.log('RESULT css-orphans 存在孤儿选择器');
process.exit(1);
