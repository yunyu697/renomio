// 安装版验证：版本、四套配色 × 明暗的 DOM/底色断言与截图，品牌图标只跟明暗。
// 用法：node post-install.mjs  （需先由 post-install.ps1 拉起应用并打开 CDP 端口）
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './cdp.mjs';

const OUT = process.env.VERIFY_OUT || path.join(process.cwd(), 'verify-out');
const PALETTES = ['graphite', 'paper', 'ocean', 'moss'];
const EXPECT_BG = {
  graphite: { light: '#eef1f6', dark: '#0b0f16' },
  paper: { light: '#f3efe6', dark: '#171310' },
  ocean: { light: '#e8eff4', dark: '#071318' },
  moss: { light: '#eff2ea', dark: '#0e140f' },
};
const BM_TILE = { light: '#f7f8fe', dark: '#1e2145' };

const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

const cdp = await connect();
const report = { generatedAt: new Date().toISOString(), version: null, combos: [], failures: [] };

try {
  report.version = await cdp.evaluate(
    `window.__TAURI_INTERNALS__.invoke('plugin:app|version').then(v => v, e => 'ERR:' + e)`,
  );
  const originalSettings = await cdp.readSettings();
  report.originalSettingsPresent = Boolean(originalSettings);

  for (const theme of ['light', 'dark']) {
    for (const palette of PALETTES) {
      await cdp.setThemePalette(theme, palette);
      const dom = await cdp.evaluate(`(() => {
        const cs = getComputedStyle(document.documentElement);
        const body = getComputedStyle(document.body);
        const marks = [...document.querySelectorAll('.brand-mark')];
        const bmTileEl = document.querySelector('.brand-mark .bm-tile');
        return {
          bmTile: bmTileEl ? getComputedStyle(bmTileEl).fill : '',
          bmTileVar: marks[0] ? getComputedStyle(marks[0]).getPropertyValue('--bm-tile').trim() : '',
          bmInk: marks[0] ? getComputedStyle(marks[0]).getPropertyValue('--bm-ink').trim() : '',
          theme: document.documentElement.dataset.theme,
          palette: document.documentElement.dataset.palette,
          startupTheme: window.__STARTUP_THEME__,
          startupPalette: window.__STARTUP_PALETTE__,
          bgVar: cs.getPropertyValue('--bg').trim(),
          panelVar: cs.getPropertyValue('--panel').trim(),
          inkVar: cs.getPropertyValue('--ink').trim(),
          bodyBg: body.backgroundColor,
          brandMarks: marks.length,
          title: document.querySelector('.titlebar')?.innerText?.replace(/\\s+/g, ' ').trim(),
          rows: document.querySelectorAll('.trow').length,
        };
      })()`);
      const shot = await cdp.shot(`alpha4-${theme}-${palette}`);
      const combo = { theme, palette, dom, shot: path.basename(shot) };

      const checks = [];
      checks.push(['data-theme', dom.theme === theme]);
      checks.push(['data-palette', dom.palette === palette]);
      checks.push(['预渲染主题', dom.startupTheme === theme]);
      checks.push(['预渲染配色', dom.startupPalette === palette]);
      checks.push(['--bg 等于色板', dom.bgVar.toLowerCase() === EXPECT_BG[palette][theme]]);
      checks.push(['body 底色等于 --bg', dom.bodyBg === hexToRgb(EXPECT_BG[palette][theme])]);
      checks.push(['品牌图标只跟明暗', dom.bmTileVar.toLowerCase() === BM_TILE[theme]]);
      checks.push(['品牌图标实际填充', dom.bmTile === hexToRgb(BM_TILE[theme])]);
      checks.push(['品牌图标存在', dom.brandMarks >= 1]);
      combo.checks = checks.map(([name, ok]) => ({ name, ok: Boolean(ok) }));
      if (combo.checks.some((c) => !c.ok)) report.failures.push(`${theme}/${palette}: ` + combo.checks.filter((c) => !c.ok).map((c) => c.name).join(', '));
      report.combos.push(combo);
    }
  }

  // 恢复用户原有主题/配色并重新加载，避免把验证状态留在用户设置里。
  if (originalSettings) await cdp.writeSettings(originalSettings);
  await cdp.reload();

  const bmAcrossPalettes = new Set(report.combos.filter((c) => c.theme === 'light').map((c) => c.dom.bmTile));
  report.brandTileLightUnique = [...bmAcrossPalettes];
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'post-install-report.json'), JSON.stringify(report, null, 2));

  console.log(`VERSION ${report.version}`);
  for (const c of report.combos) {
    console.log(
      `COMBO ${c.theme}/${c.palette} bg=${c.dom.bgVar} body=${c.dom.bodyBg} panel=${c.dom.panelVar} ink=${c.dom.inkVar} bm=${c.dom.bmTile} marks=${c.dom.brandMarks} ${c.checks.every((x) => x.ok) ? 'PASS' : 'FAIL'}`,
    );
  }
  console.log(`BRAND-TILE light 四套配色取值集合: ${JSON.stringify(report.brandTileLightUnique)}`);
  console.log(report.failures.length ? `FAILURES ${JSON.stringify(report.failures)}` : 'ALL PASS');
} finally {
  cdp.close();
}
