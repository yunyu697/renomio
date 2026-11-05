#!/usr/bin/env node
/**
 * 生成可重复运行的真实样本库（P0 验证用）。
 * 用法：
 *   node scripts/gen-test-corpus.mjs                # 生成到 app/test-corpus
 *   node scripts/gen-test-corpus.mjs --dir D:\样本  # 指定目录
 *   node scripts/gen-test-corpus.mjs --clean        # 先清空再生成
 *
 * 覆盖：中文名、emoji、0 字节、只读、同名冲突候选、扩展名大小写、
 *       深层嵌套、超长路径（Windows > 260）。锁文件由 scripts/hold-lock.ps1 持有。
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const root = path.resolve(argOf('--dir', path.join(process.cwd(), 'test-corpus')));
const clean = args.includes('--clean');
const isWin = process.platform === 'win32';

/** Windows 长路径需要用 \\?\ 前缀；其他平台原样返回。 */
function nativePath(p) {
  if (!isWin) return p;
  const abs = path.resolve(p);
  if (abs.length < 240) return abs;
  if (abs.startsWith('\\\\?\\')) return abs;
  return abs.startsWith('\\\\') ? `\\\\?\\UNC\\${abs.slice(2)}` : `\\\\?\\${abs}`;
}

function ensureDir(dir) {
  fs.mkdirSync(nativePath(dir), { recursive: true });
}

function writeFile(p, content = '') {
  ensureDir(path.dirname(p));
  fs.writeFileSync(nativePath(p), content);
}

function writeReadonly(p, content = '') {
  writeFile(p, content);
  fs.chmodSync(nativePath(p), 0o444);
}

const created = [];
function record(kind, p, note = '') {
  created.push({ kind, path: p, note });
}

function cleanup() {
  if (fs.existsSync(nativePath(root))) {
    fs.rmSync(nativePath(root), { recursive: true, force: true });
    console.log(`已清空：${root}`);
  }
}

if (clean) cleanup();

ensureDir(root);

// 1) 中文名 + 常见照片命名（配合“替换 旧照片 → 旅行_”）
for (let i = 1; i <= 6; i += 1) {
  const p = path.join(root, `旧照片 ${String(i).padStart(3, '0')}.jpg`);
  writeFile(p, `photo-${i}`);
  record('chinese', p, '中文名 + 空格，编号 001..006');
}

// 2) emoji 文件名
writeFile(path.join(root, '📷 旅行照片 🎉.jpg'), 'emoji');
record('emoji', path.join(root, '📷 旅行照片 🎉.jpg'));

// 3) 0 字节文件
writeFile(path.join(root, '空文件.dat'), '');
record('zero-byte', path.join(root, '空文件.dat'));

// 4) 只读文件
writeReadonly(path.join(root, '只读文件.txt'), 'readonly');
record('readonly', path.join(root, '只读文件.txt'), 'POSIX 0444 / Windows 只读属性');

// 5) 同名冲突候选：规则把“报告 - 副本.txt”里的“ - 副本”删掉后会撞上“报告.txt”
writeFile(path.join(root, '报告.txt'), 'origin');
writeFile(path.join(root, '报告 - 副本.txt'), 'copy');
record('conflict-source', path.join(root, '报告 - 副本.txt'), '规则命中后与 报告.txt 同名');
record('conflict-target', path.join(root, '报告.txt'));

// 6) 扩展名大小写 / 多段扩展名
writeFile(path.join(root, '风景.JPG'), 'jpg');
writeFile(path.join(root, '归档.TAR.GZ'), 'tar.gz');
record('ext-case', path.join(root, '风景.JPG'));
record('ext-multi', path.join(root, '归档.TAR.GZ'));

// 7) 深层嵌套（12 层）
let deep = root;
for (let i = 1; i <= 12; i += 1) {
  deep = path.join(deep, `层级${String(i).padStart(2, '0')}`);
  ensureDir(deep);
}
writeFile(path.join(deep, '深层文件.txt'), 'deep');
record('deep-nested', path.join(deep, '深层文件.txt'), `${12} 层嵌套`);

// 8) 超长路径（Windows 目标 > 260 字符）
let longDir = path.join(root, '超长路径');
const segment = '很长的中文目录名称_0123456789_abcdefghij';
for (let i = 0; i < 12; i += 1) longDir = path.join(longDir, `${segment}_${i}`);
ensureDir(longDir);
const longFile = path.join(longDir, '超长路径测试文件.txt');
writeFile(longFile, 'long');
record('long-path', longFile, `绝对路径长度 ${longFile.length}`);

// 9) 锁定样本（用 scripts/hold-lock.ps1 持有独占句柄）
const locked = path.join(root, '被占用-锁定.docx');
writeFile(locked, 'lock me');
record('locked', locked, '配合 scripts/hold-lock.ps1 使用');

// 10) 非法字符 / 保留名验证素材（名称本身合法，靠规则改成非法）
writeFile(path.join(root, '非法字符待测.txt'), 'invalid');
record('invalid-ready', path.join(root, '非法字符待测.txt'), '规则追加 : 或结尾点即可触发校验');

// 11) 交换场景素材
writeFile(path.join(root, '交换A.txt'), 'A');
writeFile(path.join(root, '交换B.txt'), 'B');
record('swap', path.join(root, '交换A.txt'), '与 交换B.txt 交换名称');
record('swap', path.join(root, '交换B.txt'));

// 12) 仅大小写改名素材
writeFile(path.join(root, 'CaseOnly.txt'), 'case');
record('case-only', path.join(root, 'CaseOnly.txt'), '只为大小写改名');

const manifest = {
  generatedAt: new Date().toISOString(),
  root,
  platform: process.platform,
  count: created.length,
  items: created,
};
fs.writeFileSync(nativePath(path.join(root, '_manifest.json')), JSON.stringify(manifest, null, 2));

console.log(`样本库已生成：${root}`);
console.log(`共 ${created.length} 条样本（含 0 字节、只读、emoji、深层嵌套、超长路径、冲突候选）。`);
const longItem = created.find((x) => x.kind === 'long-path');
if (longItem) console.log(`超长路径长度：${longItem.path.length} 字符（Windows 需 \\\\?\\ 前缀，应用内已处理）`);
console.log('清单：_manifest.json');
console.log('锁定样本：运行 powershell -File scripts/hold-lock.ps1 可持有独占句柄。');
