#!/usr/bin/env node
/**
 * 配色方案对比度检查（可重复运行：npm run check:contrast）
 *
 * 数据来源：packages/foundation/src/tokens.css 中实际发布的色板变量，
 * 因此检查对象就是应用最终使用的颜色，不会出现「文档数值」与实现漂移。
 *
 * 阈值（WCAG 对比度）：
 *   正文 ≥ 7    次要 ≥ 5    辅助 ≥ 4.5
 *   强调色 ≥ 4.5  状态色 ≥ 4.5
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tokensPath = join(root, 'packages/foundation/src/tokens.css');
const indexPath = join(root, 'index.html');

const THRESHOLDS = {
  ink: 7,
  ink2: 5,
  muted: 4.5,
  muted2: 4.5,
  accent: 4.5,
  status: 4.5,
  onAccent: 4.5,
};

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseBlocks(css) {
  const clean = stripComments(css);
  const blocks = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(clean))) {
    const selector = match[1].trim().replace(/\s+/g, ' ');
    const vars = {};
    for (const v of match[2].matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      vars[v[1]] = v[2].trim();
    }
    blocks.push({ selector, vars });
  }
  return blocks;
}

const blocks = parseBlocks(readFileSync(tokensPath, 'utf8'));

const find = (predicate) => blocks.filter(predicate);
const rootBlock = find((b) => b.selector === ':root')[0];
if (!rootBlock) {
  console.error('未找到 :root 色板');
  process.exit(1);
}

const darkBlocks = find((b) => b.selector === 'html[data-theme="dark"]');
const paletteBlocks = find((b) => b.selector.includes('data-palette="'));

const palettes = [...new Set(paletteBlocks.map((b) => b.selector.match(/data-palette="([^"]+)"/)[1]))];
if (!palettes.includes('graphite')) palettes.unshift('graphite');

function resolve(palette, tone) {
  const merged = { ...rootBlock.vars };
  if (tone === 'dark') Object.assign(merged, ...darkBlocks.map((b) => b.vars));
  if (palette !== 'graphite') {
    const block = paletteBlocks.find((b) =>
      b.selector.includes(`data-palette="${palette}"`) &&
      b.selector.includes(`data-theme="${tone}"`));
    if (!block) return null;
    Object.assign(merged, block.vars);
  }
  return merged;
}

function channel(value) {
  const hex = value.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}

function luminance(hex) {
  const [r, g, b] = channel(hex).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const surfaces = ['bg', 'panel', 'panel-2', 'panel-3', 'hover', 'selected'];

const checks = [];
function check(label, fg, bg, min) {
  checks.push({ label, fg, bg, min });
}

for (const palette of palettes) {
  for (const tone of ['light', 'dark']) {
    const t = resolve(palette, tone);
    if (!t) {
      console.error(`缺少配色 ${palette} / ${tone} 的色板定义`);
      process.exit(1);
    }
    const missing = ['bg', 'panel', 'panel-2', 'panel-3', 'hover', 'selected', 'ink', 'ink-2', 'muted', 'muted-2', 'accent', 'accent-on', 'accent-ink', 'accent-weak', 'accent-weak-2', 'success', 'success-weak', 'warn', 'warn-weak', 'danger', 'danger-weak', 'info']
      .filter((key) => !t[key]);
    if (missing.length) {
      console.error(`配色 ${palette} / ${tone} 缺少变量：${missing.join(', ')}`);
      process.exit(1);
    }
    for (const surface of surfaces) {
      for (const [token, min] of [['ink', THRESHOLDS.ink], ['ink-2', THRESHOLDS.ink2], ['muted', THRESHOLDS.muted], ['muted-2', THRESHOLDS.muted2]]) {
        check(`${palette}/${tone} ${token} on ${surface}`, t[token], t[surface], min);
      }
      for (const token of ['accent', 'success', 'warn', 'danger', 'info']) {
        check(`${palette}/${tone} ${token} on ${surface}`, t[token], t[surface], THRESHOLDS.status);
      }
    }
    check(`${palette}/${tone} accent-ink on accent-weak`, t['accent-ink'], t['accent-weak'], THRESHOLDS.accent);
    check(`${palette}/${tone} accent-ink on accent-weak-2`, t['accent-ink'], t['accent-weak-2'], THRESHOLDS.accent);
    check(`${palette}/${tone} accent-on on accent`, t['accent-on'], t['accent'], THRESHOLDS.onAccent);
    for (const [fg, bg] of [['success', 'success-weak'], ['warn', 'warn-weak'], ['danger', 'danger-weak']]) {
      check(`${palette}/${tone} ${fg} on ${bg}`, t[fg], t[bg], THRESHOLDS.status);
    }
  }
}

let failed = 0;
const perCombo = {};
for (const c of checks) {
  const value = ratio(c.fg, c.bg);
  const key = c.label.split(' ')[0];
  perCombo[key] = (perCombo[key] || 0) + 1;
  if (value < c.min) {
    failed += 1;
    console.error(`FAIL ${c.label}: ${value.toFixed(2)} < ${c.min} (${c.fg} on ${c.bg})`);
  }
}

// 首帧底色检查：index.html 在样式表加载前写死的底色必须与色板 --bg 一致，
// 否则重启后会先闪另一种底色再跳到目标配色。
const html = readFileSync(indexPath, 'utf8');
const inline = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
const requireColor = (selector, expected, label) => {
  const block = inline.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
  const bg = block && block[1].match(/background:\s*(#[0-9a-fA-F]{3,8})/);
  if (!bg) {
    failed += 1;
    console.error(`FAIL ${label}: index.html 未声明首帧底色`);
    return;
  }
  if (bg[1].toLowerCase() !== expected.toLowerCase()) {
    failed += 1;
    console.error(`FAIL ${label}: 首帧底色 ${bg[1]} ≠ 色板 ${expected}`);
  }
};
requireColor('html', resolve('graphite', 'light').bg, 'graphite/light 首帧');
requireColor('html[data-theme="dark"]', resolve('graphite', 'dark').bg, 'graphite/dark 首帧');
for (const palette of palettes.filter((p) => p !== 'graphite')) {
  requireColor(`html[data-palette="${palette}"]`, resolve(palette, 'light').bg, `${palette}/light 首帧`);
  requireColor(`html[data-palette="${palette}"][data-theme="dark"]`, resolve(palette, 'dark').bg, `${palette}/dark 首帧`);
}
if (!html.includes('data-palette="graphite"')) {
  failed += 1;
  console.error('FAIL index.html 缺少默认 data-palette="graphite"');
}

const combos = Object.entries(perCombo).map(([k, v]) => `${k} ${v}`).join(' · ');
console.log(`配色对比度检查：${palettes.length} 套配色 × 2 种基调，共 ${checks.length} 对颜色`);
console.log(`  ${combos}`);
console.log(`  首帧底色：${palettes.length * 2} 项`);
if (failed) {
  console.error(`结果：${failed} 项未通过`);
  process.exit(1);
}
console.log('结果：全部通过');
