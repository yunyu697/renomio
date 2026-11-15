#!/usr/bin/env node
/**
 * 设计稿令牌同步校验
 *
 * 目标：design/ 下的静态设计稿必须消费与实现同一套 --ds-* 令牌，
 *       且令牌值一旦变化，设计稿必须显式重新确认（否则构建/CI 失败）。
 *
 * 校验项：
 *   1. 引用完整性：设计稿里的每个 var(--x) 都能在令牌文件或设计稿局部 :root 中找到定义。
 *   2. 裸值禁止：颜色、字号、圆角、间距不得写裸值；控件高度不得写裸 px。
 *   3. 快照同步：设计稿依赖的令牌闭包（亮/暗两套解析值）与 design/tokens.lock.json 一致。
 *
 * 用法：
 *   node scripts/check-design-tokens.mjs            校验（CI 默认）
 *   node scripts/check-design-tokens.mjs --update   重新生成快照（改完设计稿后执行）
 *   node scripts/check-design-tokens.mjs --self-test 自测（含反例）
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const TOKEN_FILES = [
  'app/src/styles/design-system-tokens.css',
  'app/packages/foundation/src/tokens.css',
];
const DESIGN_CSS = 'design/assets/ui.css';
const DESIGN_HTML = ['design/index.html', 'design/rules.html', 'design/states.html'];
const LOCK_FILE = 'design/tokens.lock.json';

const SPACING_PROPS = [
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'gap', 'row-gap', 'column-gap',
];
// 这些选择器下的 height 属于「控件 / 行 / 栏」高度，必须走令牌
const CONTROL_SELECTOR = /\.(btn|search|mini|chip|kbd|status|switch|input|select|thead|trow|checkbox|win-controls|pathbar|actionbar|statusbar|add-rule|rule-num)(?![-\w])/;
const RAW_COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

// ---------------------------------------------------------------- 解析

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** 收集 CSS 块：{ selector, body, line } */
function collectBlocks(css) {
  const src = stripComments(css);
  const blocks = [];
  const stack = [];
  let segStart = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      const selector = src
        .slice(segStart, i)
        .replace(/@(?:import|charset|layer)[^;{]*;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      stack.push({ selector, line: lineOf(src, segStart), bodyStart: i + 1 });
      segStart = i + 1;
    } else if (ch === '}') {
      const block = stack.pop();
      if (block && !block.selector.startsWith('@')) {
        blocks.push({
          selector: block.selector,
          line: lineOf(src, block.bodyStart),
          body: src.slice(block.bodyStart, i),
        });
      }
      segStart = i + 1;
    }
  }
  return blocks;
}

/** 提取令牌定义：name -> { value, line }，按选择器分组 */
function collectTokenScopes(css) {
  const scopes = new Map();
  for (const block of collectBlocks(css)) {
    const defs = new Map();
    const re = /(--[\w-]+)\s*:\s*([^;{}]+);/g;
    let m;
    while ((m = re.exec(block.body))) defs.set(m[1], { value: m[2].trim(), line: block.line });
    if (defs.size) scopes.set(block.selector.replace(/\s+/g, ' '), defs);
  }
  return scopes;
}

function mergeMaps(...maps) {
  const out = new Map();
  for (const map of maps) for (const [k, v] of map) out.set(k, v);
  return out;
}

/** var(--x) 引用（忽略 var(--x, fallback) 的 fallback 部分） */
function collectRefs(text) {
  const names = new Set();
  const re = /var\(\s*(--[\w-]+)/g;
  let m;
  while ((m = re.exec(text))) names.add(m[1]);
  return names;
}

function resolveValue(name, vars, seen = new Set()) {
  if (seen.has(name)) return `var(${name})`;
  const def = vars.get(name);
  if (!def) return `var(${name})`;
  seen.add(name);
  return def.value.replace(/var\(\s*(--[\w-]+)(?:\s*,[^)]*)?\)/g, (_m, ref) => resolveValue(ref, vars, seen));
}

// ---------------------------------------------------------------- 规则

const CONTROL_HEIGHT_PROPS = /^(min-)?height$/;

function lintDeclarations({ label, selector, body, line, defined, problems, inline = false }) {
  const re = /([-\w]+)\s*:\s*([^;{}]+);/g;
  let m;
  while ((m = re.exec(body))) {
    const prop = m[1].toLowerCase();
    const value = m[2].trim();
    const at = line + (body.slice(0, m.index).match(/\n/g)?.length || 0);
    const where = `${label}:${at}`;
    // 去掉 var(...) 后再判断，避免把「含令牌 + 裸值」的混合写法漏掉
    const bare = value.replace(/var\([^)]*\)/g, 'VAR');

    if (SPACING_PROPS.includes(prop) && /\d*\.?\d+px/.test(bare)) {
      problems.push(`${where} 间距写死裸值（${prop}: ${value}），请用 var(--ds-space-*)`);
    }
    if (prop === 'font-size' && /\d*\.?\d+px/.test(bare)) {
      problems.push(`${where} 字号写死裸值（font-size: ${value}），请用 var(--ds-type-role-*) 或 --ds-font-size-*`);
    }
    if (prop === 'border-radius' && /\d*\.?\d+px/.test(bare)) {
      problems.push(`${where} 圆角写死裸值（border-radius: ${value}），请用 var(--ds-radius-*)`);
    }
    if ((prop === 'color' || prop.startsWith('background') || prop.includes('border-color')) && RAW_COLOR.test(bare)) {
      problems.push(`${where} 颜色写死裸值（${prop}: ${value}）`);
    }
    if (!inline && CONTROL_HEIGHT_PROPS.test(prop) && selector && CONTROL_SELECTOR.test(selector)) {
      const mm = /(\d*\.?\d+)px/.exec(bare);
      if (mm && Number(mm[1]) >= 12) {
        problems.push(`${where} 控件高度写死裸值（${selector} { ${prop}: ${value} }），请用 var(--ds-control-h-*) / --ds-row-h-*`);
      }
    }
  }
}

function lintCss(css, defined, label, problems) {
  for (const block of collectBlocks(css)) {
    lintDeclarations({ label, selector: block.selector, body: block.body, line: block.line, defined, problems });
  }
  const re = /var\(\s*(--[\w-]+)/g;
  let m;
  while ((m = re.exec(stripComments(css)))) {
    if (!defined.has(m[1])) {
      problems.push(`${label}:${lineOf(css, m.index)} 引用了未定义的令牌 var(${m[1]})`);
    }
  }
}

/** 只扫描 style="..."，且跳过显式标注 data-token-exempt 的色板样本 */
function lintHtml(html, defined, label, problems) {
  const tagRe = /<[^>]*\bstyle="([^"]*)"[^>]*>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const exempt = m[0].includes('data-token-exempt');
    const style = m[1];
    const line = lineOf(html, m.index);
    if (!exempt) {
      lintDeclarations({ label, selector: null, body: `${style};`, line, defined, problems, inline: true });
    }
    for (const name of collectRefs(style)) {
      if (!defined.has(name)) problems.push(`${label}:${line} 内联样式引用了未定义的令牌 var(${name})`);
    }
  }
}

function collectDesignRefs() {
  const refs = new Set();
  const css = readFileSync(resolve(ROOT, DESIGN_CSS), 'utf8');
  for (const name of collectRefs(css)) refs.add(name);
  for (const file of DESIGN_HTML) {
    const html = readFileSync(resolve(ROOT, file), 'utf8');
    for (const m of html.matchAll(/<[^>]*\bstyle="([^"]*)"[^>]*>/g)) {
      for (const name of collectRefs(m[1])) refs.add(name);
    }
  }
  return refs;
}

function buildThemes() {
  const base = new Map();
  const dark = new Map();
  const tokenNames = new Set();
  for (const file of TOKEN_FILES) {
    const scopes = collectTokenScopes(readFileSync(resolve(ROOT, file), 'utf8'));
    for (const [selector, defs] of scopes) {
      const list = selector.split(',').map((s) => s.trim());
      for (const [k, v] of defs) {
        tokenNames.add(k);
        if (list.includes(':root')) base.set(k, v);
      }
      if (list.includes('[data-theme="dark"]')) for (const [k, v] of defs) dark.set(k, v);
    }
  }
  // 设计稿局部的派生变量（如开关几何、列宽）与主题无关，两边都叠加；
  // 它们由设计稿自己维护，不进入令牌快照。
  const designScopes = collectTokenScopes(readFileSync(resolve(ROOT, DESIGN_CSS), 'utf8'));
  for (const [, defs] of designScopes) {
    for (const [k, v] of defs) {
      base.set(k, v);
      dark.set(k, v);
    }
  }
  return {
    light: base,
    dark: mergeMaps(base, dark),
    tokenNames,
  };
}

function buildSnapshot(themes, refs) {
  const tokens = {};
  for (const name of [...refs].sort()) {
    if (!themes.tokenNames.has(name)) continue;
    tokens[name] = {
      light: resolveValue(name, themes.light),
      dark: resolveValue(name, themes.dark),
    };
  }
  return {
    generatedBy: 'npm run tokens:update',
    themePairs: ['light', 'dark'],
    tokens,
  };
}

function compareSnapshot(actual, expected) {
  const diffs = [];
  const a = actual.tokens || {};
  const e = expected.tokens || {};
  for (const name of new Set([...Object.keys(a), ...Object.keys(e)])) {
    if (!(name in e)) diffs.push(`新增依赖 ${name}`);
    else if (!(name in a)) diffs.push(`移除依赖 ${name}`);
    else if (a[name].light !== e[name].light || a[name].dark !== e[name].dark) {
      diffs.push(`${name} → light ${e[name].light} ⇒ ${a[name].light} / dark ${e[name].dark} ⇒ ${a[name].dark}`);
    }
  }
  return diffs;
}

// ---------------------------------------------------------------- 自测

function selfTest() {
  const defined = new Set(['--ds-space-4', '--ds-color-accent', '--ds-type-role-body', '--ds-radius-tag', '--ds-control-h-lg']);
  const cases = [];
  const expect = (name, fn) => {
    const problems = [];
    fn(problems);
    cases.push({ name, ok: problems.length > 0, problems });
  };

  expect('未定义引用', (p) => lintCss('.a { color: var(--ds-color-nope); }', defined, 'x.css', p));
  expect('裸色值', (p) => lintCss('.a { color: #ff0000; }', defined, 'x.css', p));
  expect('裸字号', (p) => lintCss('.a { font-size: 13px; }', defined, 'x.css', p));
  expect('裸圆角', (p) => lintCss('.a { border-radius: 8px; }', defined, 'x.css', p));
  expect('裸间距', (p) => lintCss('.a { padding: 6px 8px; }', defined, 'x.css', p));
  expect('控件裸高度', (p) => lintCss('.btn { height: 32px; }', defined, 'x.css', p));
  expect('内联裸色', (p) => lintHtml('<b style="color:#123456">x</b>', defined, 'x.html', p));
  {
    const problems = [];
    lintHtml('<i style="background:#ffffff" data-token-exempt="palette-swatch"></i>', defined, 'x.html', problems);
    cases.push({ name: '色板样本豁免', ok: problems.length === 0, problems });
  }

  const pass = (css) => {
    const problems = [];
    lintCss(css, defined, 'x.css', problems);
    if (problems.length) cases.push({ name: `应通过：${css}`, ok: false, problems });
  };
  pass('.a { color: var(--ds-color-accent); padding: var(--ds-space-4); font-size: var(--ds-type-role-body); border-radius: var(--ds-radius-tag); }');
  pass('.btn { height: var(--ds-control-h-lg); }');
  pass('.status .dot { width: 5px; height: 5px; }');

  const snapA = { tokens: { '--a': { light: '1', dark: '2' } } };
  const stale = compareSnapshot({ tokens: { '--a': { light: '1', dark: '3' } } }, snapA);
  cases.push({ name: '快照过期', ok: stale.length === 1, problems: stale });

  let failed = 0;
  for (const c of cases) {
    console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}`);
    if (!c.ok) {
      failed++;
      for (const p of c.problems) console.log(`     ${p}`);
    }
  }
  console.log(`\n自测：${cases.length - failed}/${cases.length} 通过`);
  return failed === 0;
}

// ---------------------------------------------------------------- 主流程

function main() {
  const argv = new Set(process.argv.slice(2));
  if (argv.has('--self-test')) process.exit(selfTest() ? 0 : 1);

  const themes = buildThemes();
  const defined = new Set([...themes.light.keys()]);
  const problems = [];

  lintCss(readFileSync(resolve(ROOT, DESIGN_CSS), 'utf8'), defined, DESIGN_CSS, problems);
  for (const file of DESIGN_HTML) {
    lintHtml(readFileSync(resolve(ROOT, file), 'utf8'), defined, file, problems);
  }

  const snapshot = buildSnapshot(themes, collectDesignRefs());
  const lockPath = resolve(ROOT, LOCK_FILE);

  if (argv.has('--update')) {
    writeFileSync(lockPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`已更新 ${LOCK_FILE}（${Object.keys(snapshot.tokens).length} 个令牌 × 2 套主题）`);
    if (problems.length) {
      console.error(`\n注意：仍有 ${problems.length} 处规范问题：`);
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    return;
  }

  if (!existsSync(lockPath)) {
    problems.push(`${LOCK_FILE} 不存在，先运行 npm run tokens:update`);
  } else {
    const expected = JSON.parse(readFileSync(lockPath, 'utf8'));
    const diffs = compareSnapshot(snapshot, expected);
    if (diffs.length) {
      problems.push(
        `令牌与设计稿快照不一致（${diffs.length} 处）：令牌值变了但设计稿没有重新确认。\n` +
        `    请打开 design/ 预览确认视觉，再运行 npm run tokens:update 更新快照。\n` +
        diffs.slice(0, 12).map((d) => `    · ${d}`).join('\n')
      );
    }
  }

  if (problems.length) {
    console.error(`设计稿令牌校验失败（${problems.length} 项）：\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`\n规范：设计稿与实现共用 ${TOKEN_FILES.join(' + ')}，不得另立裸值。`);
    process.exit(1);
  }

  console.log(
    `设计稿令牌校验通过：${Object.keys(snapshot.tokens).length} 个令牌，亮/暗两套值均与 ${relative(ROOT, lockPath)} 一致。`
  );
}

main();
