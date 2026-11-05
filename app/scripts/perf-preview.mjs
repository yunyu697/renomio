/* 10,000 条目的预览引擎基准：用 esbuild 把真实 src/lib/preview.ts 打成一个临时 ESM，
 * 在 Node（与浏览器同为 V8）里计时，不启动 GUI。用法：node scripts/perf-preview.mjs */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(os.tmpdir(), `ffrn-preview-perf-${Date.now()}.mjs`);

await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/lib/preview.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: OUT,
  logLevel: 'silent',
});

const { computePreview } = await import(pathToFileURL(OUT).href);
fs.rmSync(OUT, { force: true });

const env = {
  os: 'windows',
  separator: '\\',
  caseSensitive: false,
  componentLimit: 255,
  pathWarnThreshold: 240,
  pathHardLimit: 32767,
  dataDir: 'C:\\Temp\\data',
  creationTimeWritable: true,
  longPathSupport: true,
};

const exts = ['jpg', 'png', 'mp3', 'pdf', 'txt', 'docx'];
const entries = Array.from({ length: 10000 }, (_, i) => {
  const dir = `D:\\perf\\批次 ${String(i % 100).padStart(3, '0')}`;
  const ext = exts[i % exts.length];
  const long = i % 50 === 0 ? '这是一个比较长的中文文件名用于测试长路径与渲染' : '';
  return {
    id: `${dir}\\照片_${long}_中文_${i}.${ext}`,
    path: `${dir}\\照片_${long}_中文_${i}.${ext}`,
    name: `照片_${long}_中文_${i}.${ext}`,
    parent: dir,
    isDir: false,
    size: 1024,
    modified: 1735689600000,
    readonly: false,
    selected: true,
  };
});

const rules = [
  { id: 'r1', type: 'replace', enabled: true, find: '照片', replace: '旅行', caseSensitive: false, regex: false, nth: 0 },
  { id: 'r2', type: 'number', enabled: true, expression: '<#>', start: 1, step: 1, digits: 4, padChar: '0', perFolder: true, onlyChecked: false },
  { id: 'r3', type: 'case', enabled: true, mode: 'lower', separators: ' -_' },
  { id: 'r4', type: 'move', enabled: true, from: 1, fromEnd: false, count: 3, to: 5, toEnd: false },
  { id: 'r5', type: 'ext', enabled: true, mode: 'case', value: '', position: 'suffix', caseMode: 'lower' },
];

const opts = { env, strictWindowsNames: true, readonlySkip: false, diskExists: {} };

const run = () => computePreview(entries, rules, opts);
run(); // 预热 JIT
const samples = [];
for (let i = 0; i < 5; i += 1) {
  const t = performance.now();
  const result = run();
  samples.push(performance.now() - t);
  if (i === 4) {
    console.log(
      JSON.stringify({
        entries: result.rows.length,
        ready: result.counts.ready,
        conflict: result.counts.conflict,
        ms: Number((performance.now() - t).toFixed(1)),
      }),
    );
  }
}
samples.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    samples_ms: samples.map((s) => Number(s.toFixed(1))),
    avg_ms: Number((samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(1)),
    p50_ms: Number(samples[2].toFixed(1)),
  }),
);
