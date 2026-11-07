#!/usr/bin/env node
/**
 * 版本注入：唯一可改的版本来源是仓库根目录的 VERSION 文件。
 * 本脚本把它同步写入各处清单，使它们不再需要手工维护（幂等，不改则不动文件）。
 *
 * 用法：
 *   node scripts/version.mjs          # 注入
 *   node scripts/version.mjs --check  # 只检查是否有漂移（CI 用，不写文件）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appDir, '..');
const versionFile = path.join(repoRoot, 'VERSION');

const version = readFileSync(versionFile, 'utf8').trim();
if (!version) {
  console.error(`VERSION 文件为空：${versionFile}`);
  process.exit(1);
}

/** 每个目标文件：如何定位到「应用版本」那一行。 */
const targets = [
  {
    file: path.join(appDir, 'package.json'),
    label: 'app/package.json',
    pattern: /^(\s*"version"\s*:\s*")[^"]*(")/m,
  },
  {
    file: path.join(appDir, 'packages', 'foundation', 'package.json'),
    label: 'app/packages/foundation/package.json',
    pattern: /^(\s*"version"\s*:\s*")[^"]*(")/m,
  },
  {
    file: path.join(appDir, 'src-tauri', 'tauri.conf.json'),
    label: 'app/src-tauri/tauri.conf.json',
    pattern: /^(\s*"version"\s*:\s*")[^"]*(")/m,
  },
  {
    file: path.join(appDir, 'src-tauri', 'Cargo.toml'),
    label: 'app/src-tauri/Cargo.toml',
    pattern: /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]*(")/,
  },
  {
    file: path.join(appDir, 'src-tauri', 'renomio-core', 'Cargo.toml'),
    label: 'app/src-tauri/renomio-core/Cargo.toml',
    pattern: /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]*(")/,
  },
];

const checkOnly = process.argv.includes('--check');
const drifted = [];
let changed = 0;

for (const t of targets) {
  const before = readFileSync(t.file, 'utf8');
  if (!t.pattern.test(before)) {
    console.error(`找不到版本字段：${t.label}`);
    process.exit(1);
  }
  const after = before.replace(t.pattern, `$1${version}$2`);
  if (after === before) continue;
  drifted.push(t.label);
  if (!checkOnly) {
    writeFileSync(t.file, after, 'utf8');
    changed++;
  }
}

if (checkOnly) {
  if (drifted.length > 0) {
    console.error(`版本漂移（应为 ${version}）：${drifted.join(', ')}`);
    process.exit(1);
  }
  console.log(`版本一致：${version}（${targets.length} 处清单）`);
} else {
  console.log(`VERSION=${version}`);
  if (changed === 0) {
    console.log(`无漂移，${targets.length} 处清单已是该版本`);
  } else {
    console.log(`已注入 ${changed} 处：${drifted.join(', ')}`);
  }
}

/**
 * MSI（WiX）只接受纯数字 ProductVersion，且不能再有非数字 prerelease。
 * 这里把 VERSION 的数字核注入 bundle.windows.wix.version；alpha 阶段记为
 * 1.0.0.0，与正式 1.0.0 相同版本号（同版本视为修复安装，不会挡住升级）。
 * 包文件名仍由 tauri.conf.json 的 version 决定，所以仍是 1.0.0-alpha1。
 */
const confPath = path.join(appDir, 'src-tauri', 'tauri.conf.json');
const numeric = version.replace(/-.*$/, '');
const confText = readFileSync(confPath, 'utf8');
const wixRe = /("wix"\s*:\s*\{)([\s\S]*?)(\r?\n(\s*)\})/;
const wix = wixRe.exec(confText);
if (!wix) {
  console.error('tauri.conf.json 找不到 bundle.windows.wix 段');
  process.exit(1);
}
const inner = wix[2];
const indentMatch = /\n(\s*)"/.exec(inner);
const indent = indentMatch ? indentMatch[1] : '        ';
const hasVersion = /\n\s*"version"\s*:\s*"[^"]*"/.test(inner);
const nextInner = hasVersion
  ? inner.replace(/(\n\s*"version"\s*:\s*")[^"]*(")/, `$1${numeric}$2`)
  : `\n${indent}"version": "${numeric}",${inner}`;
const nextConf = hasVersion ? confText.replace(wixRe, `$1${nextInner}$3`) : confText.replace(wixRe, `$1${nextInner}$3`);
const desired = `"version": "${numeric}"`;
if (!nextConf.includes(desired)) {
  console.error('写入 wix.version 失败');
  process.exit(1);
}
if (nextConf !== confText) {
  if (checkOnly) {
    console.error(`版本漂移：tauri.conf.json 的 wix.version 应为 ${numeric}`);
    process.exit(1);
  }
  writeFileSync(confPath, nextConf, 'utf8');
  console.log(`已注入 MSI ProductVersion（wix.version）= ${numeric}`);
}
