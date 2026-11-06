/**
 * 拖放状态机自测：不依赖窗口，纯逻辑断言。
 * 用 esbuild 把 dropGate.ts 转成 ESM 再加载，避免依赖 Node 的 TypeScript 类型剥离版本。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, '..', 'node_modules', '.cache', 'drop-gate-test.mjs');
buildSync({
  entryPoints: [path.join(here, '..', 'src', 'lib', 'dropGate.ts')],
  bundle: true,
  format: 'esm',
  outfile,
  logLevel: 'silent',
});
const { dropReduce, dropVisible, domDepthAfter, LEAVE_GRACE_MS } =
  await import(pathToFileURL(outfile).href);

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

const idle = { status: 'idle' };
const active = { status: 'active' };
const at = (state, kind, files, now) =>
  dropReduce(state, kind === 'enter' || kind === 'drop' ? { kind, files } : { kind }, now);

// 1. 真实文件拖入才点亮
check('enter(2 files) → active', at(idle, 'enter', 2, 0).status === 'active');
check(
  'enter(0 files) → idle（内部拖拽/选中文字不点亮）',
  at(idle, 'enter', 0, 0).status === 'idle',
);

// 2. 没有 enter 的 over 不得点亮（本次 bug 的根因）
check('idle + over → idle', at(idle, 'over', 0, 0).status === 'idle');
check('active + over → active', at(active, 'over', 0, 0).status === 'active');

// 3. leave 有宽限期，随后 over/enter 可抵消抖动
const leaving = at(active, 'leave', 0, 100);
check('active + leave → leaving', leaving.status === 'leaving');
check('宽限期内仍可见', dropVisible(leaving, 100 + LEAVE_GRACE_MS - 1) === true);
check('宽限期后不可见', dropVisible(leaving, 100 + LEAVE_GRACE_MS + 1) === false);
check('leaving + enter(1) 在两个子元素之间抖动 → active', at(leaving, 'enter', 1, 150).status === 'active');
check('leaving + over 在宽限期内 → active', at(leaving, 'over', 0, 150).status === 'active');
check('leaving + over 超过宽限期 → idle', at(leaving, 'over', 0, 400).status === 'idle');

// 4. 松手 / Esc / 失焦 / 空白 enter 之后都要复位
check('active + drop → idle', at(active, 'drop', 2, 0).status === 'idle');
check('active + cancel → idle', at(active, 'cancel', 0, 0).status === 'idle');
check('leaving + cancel → idle', at(leaving, 'cancel', 0, 0).status === 'idle');
check('idle 状态不可见', dropVisible(idle, 0) === false);

// 5. 子元素 dragleave 计数
check('depth 0 + leave 不为负', domDepthAfter(0, -1) === 0);
check('depth 2 + leave → 1', domDepthAfter(2, -1) === 1);

// 6. 完整回归序列：误报 over → 真实拖入 → 移出 → 再进入 → 松手
let s = idle;
s = at(s, 'over', 0, 0);
check('序列: 单独 over 不点亮', dropVisible(s, 0) === false);
s = at(s, 'enter', 2, 10);
check('序列: 真实 enter 点亮', dropVisible(s, 10) === true);
s = at(s, 'leave', 0, 20);
s = at(s, 'over', 0, 120); // 子元素抖动
check('序列: 抖动后仍点亮', dropVisible(s, 120) === true);
s = at(s, 'leave', 0, 200);
s = at(s, 'enter', 1, 250);
check('序列: 重新进入仍点亮', dropVisible(s, 250) === true);
s = at(s, 'drop', 1, 300);
check('序列: 松手复位', dropVisible(s, 300) === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
