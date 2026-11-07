/**
 * 八类规则真实文件端到端验证。
 *
 * 每条规则：在临时目录建真实文件 → 用真实的规则引擎（src/lib/rules.ts，
 * TypeScript transpileModule 后直接导入）计算新名 → 在磁盘上执行两阶段改名
 * → 校验清单里的真实文件名 → 反向改回 → 校验还原且内容不变。
 * 「按元数据取名」用真实 MP3 的 ID3 TIT2 标签，脚本用独立解析器读出字段；
 * Rust 端的标签提取由既有 metaedit 测试覆盖。
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'renomio-rules-'));
const workDir = mkdtempSync(join(tmpdir(), 'renomio-rules-files-'));
let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else {
    failed += 1;
    failures.push({ name, detail });
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function transpile(name) {
  const source = readFileSync(join(root, 'src', 'lib', `${name}.ts`), 'utf8')
    .replace("from '../i18n'", "from './i18n.mjs'")
    .replace("from './vars'", "from './vars.mjs'");
  writeFileSync(
    join(outDir, `${name}.mjs`),
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    }).outputText,
  );
}
writeFileSync(
  join(outDir, 'i18n.mjs'),
  'export function t(key, params = {}) { return key + ":" + Object.entries(params).map(([k, v]) => k + "=" + v).join(","); }\n',
);
transpile('vars');
transpile('rules');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** 生成一个带 ID3v2.3 TIT2 标签的最小 MP3（真实文件，标签可被独立解析） */
function makeTaggedMp3(path, title) {
  const text = Buffer.from(title, 'latin1');
  const frameBody = Buffer.concat([Buffer.from([0]), text]);
  const frame = Buffer.alloc(10 + frameBody.length);
  frame.write('TIT2', 0, 'latin1');
  frame.writeUInt32BE(frameBody.length, 4);
  frameBody.copy(frame, 10);
  const size = frame.length;
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'latin1');
  header[3] = 3;
  header[4] = 0;
  header[5] = 0;
  header.writeUInt32BE(size, 6); // 小样本不涉及 synchsafe 高位
  writeFileSync(path, Buffer.concat([header, frame, Buffer.from([0xff, 0xfb, 0x90, 0x00])]));
}

function readTitleTag(path) {
  const buf = readFileSync(path);
  if (buf.toString('latin1', 0, 3) !== 'ID3') return '';
  const size = buf.readUInt32BE(6);
  const end = 10 + size;
  let at = 10;
  while (at + 10 <= end) {
    const id = buf.toString('latin1', at, at + 4);
    const frameSize = buf.readUInt32BE(at + 4);
    if (id === 'TIT2') {
      const body = buf.subarray(at + 10, at + 10 + frameSize);
      return body.subarray(1).toString('latin1');
    }
    at += 10 + frameSize;
  }
  return '';
}

function twoPhaseRename(dir, mapping) {
  const temp = mapping.map(([from], index) => [from, `.renomio-tmp-${index}-${from}`]);
  for (const [from, mid] of temp) renameSync(join(dir, from), join(dir, mid));
  for (let i = 0; i < temp.length; i += 1) renameSync(join(dir, temp[i][1]), join(dir, mapping[i][1]));
}

const cases = [
  {
    name: '添加（末尾直接插入）',
    files: ['notes.md'],
    rule: { type: 'add', mode: 'direct', text: '_final', anchor: 'end', position: 1, fromEnd: true, padTo: 4, padChar: '0' },
    expected: ['notes_final.md'],
  },
  {
    name: '替换（正则 + 仅替换数字）',
    files: ['IMG_2020.jpg'],
    rule: { type: 'replace', find: '\\d{4}', replace: '2026', regex: true, caseSensitive: true, nth: 0 },
    expected: ['IMG_2026.jpg'],
  },
  {
    name: '删除（区间）',
    files: ['ABCDEF.txt'],
    rule: { type: 'delete', mode: 'range', from: 1, fromEnd: false, count: 2, left: '', right: '', includeLeft: false, includeRight: false, chars: '', keep: true },
    expected: ['CDEF.txt'],
  },
  {
    name: '编号（起始 5 / 步长 2 / 三位补零）',
    files: ['a.txt', 'b.txt', 'c.txt'],
    rule: { type: 'number', expression: '<NAME>_<#>', start: 5, step: 2, digits: 3, padChar: '0', perFolder: false, onlyChecked: false },
    expected: ['a_005.txt', 'b_007.txt', 'c_009.txt'],
  },
  {
    name: '移动（从第 1 个起取 3 个移到末尾）',
    files: ['ABCDEF.txt'],
    rule: { type: 'move', from: 1, fromEnd: false, count: 3, to: 1, toEnd: true },
    expected: ['DEFABC.txt'],
  },
  {
    name: '大小写（全小写）',
    files: ['Mixed Case.TXT'],
    rule: { type: 'case', mode: 'lower', separators: ' .-_' },
    expected: ['mixed case.TXT'],
  },
  {
    name: '扩展名（jpeg → jpg）',
    files: ['photo.jpeg'],
    rule: { type: 'ext', mode: 'replace', value: 'jpg', position: 'suffix', caseMode: 'lower' },
    expected: ['photo.jpg'],
  },
  {
    name: '按元数据取名（真实 ID3 TIT2）',
    files: ['track.mp3'],
    tagged: { file: 'track.mp3', title: 'Nocturne' },
    rule: { type: 'meta', field: 'title', mode: 'prefix', separator: ' - ' },
    expected: ['Nocturne - track.mp3'],
  },
];

async function main() {
  const { applyRules, splitName, joinName } = await import(pathToFileURL(join(outDir, 'rules.mjs')).href);

  for (const [caseIndex, testCase] of cases.entries()) {
    const dir = join(workDir, `case-${caseIndex + 1}`);
    mkdirSync(dir, { recursive: true });
    const hashes = new Map();
    for (const file of testCase.files) {
      writeFileSync(join(dir, file), `content of ${file}\n`);
      hashes.set(file, sha(readFileSync(join(dir, file))));
    }
    if (testCase.tagged) {
      const p = join(dir, testCase.tagged.file);
      makeTaggedMp3(p, testCase.tagged.title);
      hashes.set(testCase.tagged.file, sha(readFileSync(p)));
      check(`${testCase.name}：独立解析 ID3 TIT2`, readTitleTag(p) === testCase.tagged.title, readTitleTag(p));
    }

    // 与产品一致：按扫描顺序（文件名字典序）处理
    const ordered = [...testCase.files].sort((a, b) => a.localeCompare(b));
    const counters = new Map();
    const nextNumber = (rule, parent) => {
      const key = `${rule.id}::${parent}`;
      const value = counters.get(key) ?? rule.start;
      counters.set(key, value + rule.step);
      return value;
    };
    const peekNumber = (rule, parent) => {
      const key = `${rule.id}::${parent}`;
      return counters.get(key) ?? rule.start;
    };
    const ids = ordered.map((file, index) => {
      const { stem, ext } = splitName(file, false);
      const meta = testCase.tagged
        ? { path: join(dir, file), taken: '', camera: '', title: readTitleTag(join(dir, file)), artist: '', album: '', track: '' }
        : undefined;
      const result = applyRules(
        { stem, ext },
        false,
        [{ ...testCase.rule, id: 'rule-1', enabled: true }],
        '.',
        {
          nextNumber,
          peekNumber,
          meta,
          vars: { stem, ext, dirName: 'case', modified: statSync(join(dir, file)).mtimeMs, size: statSync(join(dir, file)).size, hashes: {}, users: [] },
        },
        true,
      );
      return [file, joinName(result.stem, result.ext)];
    });
    const mapping = ids.filter(([from, to]) => from !== to);
    const stripped = mapping.map(([, to]) => to);
    check(`${testCase.name}：规则引擎输出`, JSON.stringify(stripped.sort()) === JSON.stringify([...testCase.expected].sort()), stripped.join(', '));

    twoPhaseRename(dir, mapping);
    const now = readdirSync(dir).sort();
    check(`${testCase.name}：磁盘真实文件名`, JSON.stringify(now) === JSON.stringify([...testCase.expected].sort()), now.join(', '));
    check(`${testCase.name}：旧名已不存在`, mapping.every(([from]) => !now.includes(from)), mapping.map(([f]) => f).join(','));

    twoPhaseRename(dir, mapping.map(([from, to]) => [to, from]));
    const restored = readdirSync(dir).sort();
    check(`${testCase.name}：撤销后还原`, JSON.stringify(restored) === JSON.stringify([...testCase.files].sort()), restored.join(', '));
    check(
      `${testCase.name}：撤销后内容不变`,
      restored.every((file) => sha(readFileSync(join(dir, file))) === hashes.get(file)),
    );
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
