/**
 * 规则链输入历史自测：纯逻辑，不依赖窗口。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, '..', 'node_modules', '.cache', 'rule-history-test.mjs');
buildSync({
  entryPoints: [path.join(here, '..', 'src', 'lib', 'history.ts')],
  bundle: true,
  format: 'esm',
  outfile,
  logLevel: 'silent',
});
const {
  HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT, HISTORY_MIN_LIMIT,
  applyHistoryLimit, clampHistoryLimit, emptyHistory, normalizeHistory,
  pushHistoryEntry, removeHistoryEntry, truncateHistory,
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

// 1. 默认上限与范围
check('默认上限 50', HISTORY_DEFAULT_LIMIT === 50);
check('下限 10', HISTORY_MIN_LIMIT === 10);
check('上限 200', HISTORY_MAX_LIMIT === 200);
check('clamp(5) → 10', clampHistoryLimit(5) === 10);
check('clamp(500) → 200', clampHistoryLimit(500) === 200);
check('clamp(NaN) → 50', clampHistoryLimit(Number.NaN) === 50);

// 2. 记录与去重
const a = pushHistoryEntry([], '  photo  ', 50);
check('空白值不记录', pushHistoryEntry([], '   ', 50).length === 0);
check('前后空白被裁剪', a[0] === 'photo');
const b = pushHistoryEntry(['x', 'y'], 'y', 50);
check('重复内容提到最前、不堆叠', b.join(',') === 'y,x', b.join(','));
const c = pushHistoryEntry(['a', 'b', 'c'], 'd', 50);
check('新内容插到最前', c.join(',') === 'd,a,b,c');

// 3. 超限淘汰最旧
const words = Array.from({ length: 60 }, (_, i) => `v${i}`);
const capped = pushHistoryEntry(words, 'newest', 50);
check('超限后长度 = 上限', capped.length === 50);
check('最旧被淘汰', !capped.includes('v59'));
check('最新在最前', capped[0] === 'newest');

// 4. 单条删除
const removed = removeHistoryEntry(['a', 'b', 'c'], 'b');
check('单条删除只删目标', removed.join(',') === 'a,c');
check('删除不存在的内容不变', removeHistoryEntry(['a'], 'z').join(',') === 'a');

// 5. 上限调小：每个字段保留最新 N 条
const big = {
  version: 1,
  limit: 50,
  fields: {
    'replace.find': Array.from({ length: 50 }, (_, i) => `f${i}`),
    'replace.replace': ['only'],
        empty: [],
  },
};
const shrunk = applyHistoryLimit(big, 10);
check('调小后每个字段长度 ≤ 10', shrunk.fields['replace.find'].length === 10);
check('保留的是最新 10 条', shrunk.fields['replace.find'][0] === 'f0' && shrunk.fields['replace.find'][9] === 'f9');
check('短字段不受影响', shrunk.fields['replace.replace'].join(',') === 'only');
check('空字段被丢弃', !('empty' in shrunk.fields));
check('limit 已同步', shrunk.limit === 10);

// 6. 坏数据归一化
check('null → 空历史', normalizeHistory(null).fields && Object.keys(normalizeHistory(null).fields).length === 0);
const dirty = normalizeHistory({
  limit: 3,
  fields: { k: ['a', 'a', 7, ' b '], bad: 'nope' },
});
check('limit 被夹到 10', dirty.limit === 10);
check('重复与非字符串被清理', dirty.fields.k.join(',') === 'a,b', dirty.fields.k?.join(','));
check('非数组字段被忽略', !('bad' in dirty.fields));
check('空历史默认 limit 50', emptyHistory().limit === 50);
check('truncate 不改动短列表', truncateHistory(['a', 'b'], 50).length === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
