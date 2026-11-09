// A 方案：页签行内入口、只读页签、检查器子页签切换的真实界面验证。
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './cdp.mjs';

const OUT = process.env.VERIFY_OUT || path.join(process.cwd(), 'verify-out', 'layout');
const CORPUS = process.env.CHAIN_CORPUS;
const FILES = ['album-2024.jpg', 'track-01.mp3', 'notes-gbk.txt'].map((f) => path.join(CORPUS, f));
fs.mkdirSync(OUT, { recursive: true });

const cdp = await connect({ port: process.env.CDP_PORT || '9446' });
const report = { checks: [], shots: [], steps: [] };
const add = (name, ok, detail = '') => {
  report.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name} ${detail}`);
};
const state = () => cdp.evaluate(`(() => {
  const q = (s) => document.querySelector(s);
  const insp = q('[data-testid="inspector"]');
  return {
    listTab: q('.list-tabs .tab.active')?.dataset.testid ?? null,
    listView: q('.list-view')?.dataset.testid ?? null,
    inspectorOpen: Boolean(insp),
    inspectorMode: insp?.dataset.mode ?? null,
    inspectorScope: q('[data-testid="inspector-scope"]')?.innerText ?? null,
    metaDialogOpen: Boolean(q('[data-testid="meta-edit-dialog"]')),
    metaApply: Boolean(q('[data-testid="meta-apply"]')),
    opsApply: Boolean(q('[data-testid="ops-apply"]')),
    rulesPresent: Boolean(q('[data-testid="rules-module"]')),
    actionbarPresent: Boolean(q('.actionbar')),
    panesView: q('.panes')?.dataset.view ?? null,
    workspaceNarrow: q('.workspace')?.dataset.narrow ?? null,
    readonlyInputs: q('.list-view') ? q('.list-view').querySelectorAll('input,textarea,select').length : -1,
    rows: document.querySelectorAll('.trow').length,
    inspectorTabs: [...document.querySelectorAll('.inspector-tab')].map((t) => t.dataset.testid),
    bodyKids: q('.inspector-body') ? q('.inspector-body').querySelectorAll(':scope > *').length : -1,
  };
})()`);

try {
  await cdp.waitFor(`Boolean(document.querySelector('.workspace'))`, '工作区就绪', 25000);
  const sessionBefore = await cdp.evaluate(`localStorage.getItem('rename-studio.session')`);
  await cdp.evaluate(`localStorage.removeItem('rename-studio.session')`);
  await cdp.reload();
  const emitted = await cdp.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit_to', {
    target: { kind: 'Webview', label: 'main' },
    event: 'tauri://drag-drop',
    payload: { type: 'drop', paths: ${JSON.stringify(FILES)}, position: { x: 400, y: 300 } }
  }).then(() => true, e => 'ERR:' + e)`);
  add('真实文件载入', emitted === true, String(emitted));
  await cdp.waitFor(`document.querySelectorAll('.trow').length >= 3`, '三行文件', 15000);

  // 1) 只读页签：音乐页签只有表格，没有编辑控件
  await cdp.click('list-tab-music');
  await cdp.waitFor(`Boolean(document.querySelector('[data-testid="list-view-music"]'))`, '音乐页签', 8000);
  await cdp.sleep(500);
  const music = await state();
  report.steps.push({ step: '音乐页签', state: music });
  add('页签切换到音乐（只读）', music.listTab === 'list-tab-music' && music.listView === 'list-view-music', `${music.listTab} ${music.listView}`);
  add('只读页签内无输入控件', music.readonlyInputs === 0, `inputs=${music.readonlyInputs}`);

  // 2) 行内「编辑」按钮 → 打开右侧检查器（不是对话框、不是整页替换）
  await cdp.click('list-action-edit-music');
  await cdp.waitFor(`Boolean(document.querySelector('[data-testid="inspector"]'))`, '检查器打开', 6000);
  await cdp.sleep(500);
  const edited = await state();
  report.steps.push({ step: '音乐页签行内编辑', state: edited });
  add('行内编辑打开检查器（元数据）', edited.inspectorOpen && edited.inspectorMode === 'meta', `open=${edited.inspectorOpen} mode=${edited.inspectorMode}`);
  add('行内编辑不再弹旧元数据对话框', edited.metaDialogOpen === false, `dialog=${edited.metaDialogOpen}`);
  add('检查器内有应用按钮', edited.metaApply, 'meta-apply');
  add('检查器打开时页签与规则链仍在', edited.listView === 'list-view-music' && edited.rulesPresent && edited.actionbarPresent, JSON.stringify({ view: edited.listView, rules: edited.rulesPresent, action: edited.actionbarPresent }));
  report.shots.push(await cdp.shot('ia-music-inline-edit'));

  // 3) 属性页签行内按钮 → 检查器属性页
  await cdp.click('list-tab-attrs');
  await cdp.waitFor(`Boolean(document.querySelector('[data-testid="list-view-attrs"]'))`, '属性页签', 8000);
  await cdp.sleep(400);
  await cdp.click('list-action-attrs');
  await cdp.sleep(600);
  const attrs = await state();
  report.steps.push({ step: '属性页签行内入口', state: attrs });
  add('属性行内入口指向检查器属性页', attrs.inspectorMode === 'attrs' && attrs.opsApply, `mode=${attrs.inspectorMode} opsApply=${attrs.opsApply}`);

  // 4) 六个子页签逐个切换，工作台不被整页替换
  const modes = ['attrs', 'meta', 'time', 'organize', 'exif', 'encoding'];
  for (const mode of modes) {
    await cdp.click(`inspector-tab-${mode}`);
    await cdp.sleep(450);
    const s = await state();
    add(`检查器子页签 ${mode}`, s.inspectorMode === mode && s.bodyKids > 0 && s.panesView !== null, `mode=${s.inspectorMode} bodyKids=${s.bodyKids} panes=${s.panesView}`);
  }
  report.shots.push(await cdp.shot('ia-inspector-encoding'));

  // 5) 关闭检查器后列表恢复全宽
  const beforeClose = await cdp.evaluate(`Math.round(document.querySelector('.panes > .main').getBoundingClientRect().width)`);
  await cdp.click('inspector-close');
  await cdp.sleep(500);
  const afterClose = await state();
  const afterWidth = await cdp.evaluate(`Math.round(document.querySelector('.panes > .main').getBoundingClientRect().width)`);
  add('关闭检查器后列表恢复全宽', !afterClose.inspectorOpen && afterWidth > beforeClose, `${beforeClose} -> ${afterWidth}`);

  await cdp.evaluate(`localStorage.setItem('rename-studio.session', ${JSON.stringify(sessionBefore || '')})`);
  if (!sessionBefore) await cdp.evaluate(`localStorage.removeItem('rename-studio.session')`);

  fs.writeFileSync(path.join(OUT, 'probe-ia.json'), JSON.stringify(report, null, 2));
  const failed = report.checks.filter((c) => !c.ok);
  console.log(`\n=== IA 结果: ${report.checks.length - failed.length}/${report.checks.length} PASS ===`);
  if (failed.length) console.log(JSON.stringify(failed, null, 2));
} finally {
  cdp.close();
}
