// A 方案逐条对照：在已安装 Renomio 的真实窗口上测 DOM 尺寸/位置并截图。
// 一次运行对应一个窗口尺寸 + 一个 layout.view；由 probe-layout.ps1 逐个调用。
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './cdp.mjs';

const VIEW = process.env.LAYOUT_VIEW || 'files-left';
const LABEL = process.env.LAYOUT_LABEL || `${VIEW}-default`;
const OUT = process.env.VERIFY_OUT || path.join(process.cwd(), 'verify-out', 'layout');
const CORPUS = process.env.CHAIN_CORPUS;
const RULE_COUNT = Number(process.env.LAYOUT_RULES || '0');
const RESTORE = process.env.LAYOUT_RESTORE === '1';
const BACKUP = path.join(OUT, 'settings-backup.json');

fs.mkdirSync(OUT, { recursive: true });

const cdp = await connect({ port: process.env.CDP_PORT || '9446' });
const report = { label: LABEL, view: VIEW, viewport: null, measures: {}, shots: [], checks: [] };
const add = (name, ok, detail = '') => {
  report.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name} ${detail}`);
};

const readEnv = async () => {
  const raw = await cdp.evaluate(`localStorage.getItem('rename-studio.settings')`);
  return raw ? JSON.parse(raw) : { data: {}, version: 0 };
};
const holderOf = (env) => (env.data ? 'data' : 'state');

try {
  await cdp.waitFor(`Boolean(document.querySelector('.workspace'))`, '工作区就绪', 25000);

  if (RESTORE) {
    const backup = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
    if (backup.settings) await cdp.evaluate(`localStorage.setItem('rename-studio.settings', ${JSON.stringify(backup.settings)})`);
    else await cdp.evaluate(`localStorage.removeItem('rename-studio.settings')`);
    if (backup.session) await cdp.evaluate(`localStorage.setItem('rename-studio.session', ${JSON.stringify(backup.session)})`);
    else await cdp.evaluate(`localStorage.removeItem('rename-studio.session')`);
    await cdp.reload();
    console.log('[RESTORE] settings/session 已恢复');
    cdp.close();
    process.exit(0);
  }

  // 首次运行保存原始设置与会话，全部跑完后由 LAYOUT_RESTORE=1 还原
  if (!fs.existsSync(BACKUP)) {
    const settings = await cdp.evaluate(`localStorage.getItem('rename-studio.settings')`);
    const session = await cdp.evaluate(`localStorage.getItem('rename-studio.session')`);
    fs.writeFileSync(BACKUP, JSON.stringify({ settings, session }));
  }

  // 设定期望的布局视图（仅此一项），清空上一轮会话保证文件列表可复现
  const env = await readEnv();
  const holder = holderOf(env);
  env[holder] = {
    ...(env[holder] || {}),
    layout: { ...((env[holder] || {}).layout || {}), view: VIEW, advanced: false },
  };
  await cdp.evaluate(`localStorage.setItem('rename-studio.settings', ${JSON.stringify(JSON.stringify(env))})`);
  await cdp.evaluate(`localStorage.removeItem('rename-studio.session')`);
  await cdp.reload();

  // 载入三份真实文件（JPEG/MP3/GBK 文本），并全选，让检查器有真实作用对象
  const files = ['album-2024.jpg', 'track-01.mp3', 'notes-gbk.txt'].map((f) => path.join(CORPUS, f));
  const emitted = await cdp.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit_to', {
    target: { kind: 'Webview', label: 'main' },
    event: 'tauri://drag-drop',
    payload: { type: 'drop', paths: ${JSON.stringify(files)}, position: { x: 400, y: 300 } }
  }).then(() => true, e => 'ERR:' + e)`);
  add('真实文件载入', emitted === true, String(emitted));
  await cdp.waitFor(`document.querySelectorAll('.trow').length >= 3`, '三行文件', 15000);
  // 拖入后通常已自动勾选；只有不足 3 行被选中时才点全选，避免把已有勾选反选掉
  const selectedNow = await cdp.evaluate(`document.querySelectorAll('.trow.selected').length`);
  if (selectedNow < 3) {
    await cdp.evaluate(`(() => { const c = document.querySelector('.thead .checkbox'); if (!c) return false; c.click(); return true; })()`);
    await cdp.waitFor(`document.querySelectorAll('.trow.selected').length >= 3`, '全选三行', 8000);
  }

  // 添加 N 条规则（不同类型，避免互相遮蔽形成冲突面板挤占规则区）
  if (RULE_COUNT > 0) {
    if (await cdp.evaluate(`Boolean(document.querySelector('[data-testid="expand-rules"]'))`)) await cdp.click('expand-rules');
    if (await cdp.evaluate(`Boolean(document.querySelector('[data-testid="clear-rules"]'))`)) await cdp.click('clear-rules');
    const types = ['replace', 'add', 'delete', 'case', 'ext'];
    for (let i = 0; i < RULE_COUNT; i += 1) {
      const type = types[i % types.length];
      await cdp.click('add-rule');
      await cdp.waitFor(`Boolean(document.querySelector('[data-testid="rule-type-${type}"]'))`, `规则菜单 ${i + 1}`);
      await cdp.click(`rule-type-${type}`);
      await cdp.sleep(300);
    }
    await cdp.sleep(500);
  }

  // 记录「检查器尚未打开」时的规则区形态（此时工作台宽度最大）
  const ruleBefore = await cdp.evaluate(`(() => {
    const rl = document.querySelector('[data-testid="rule-list"]');
    if (!rl) return null;
    const b = rl.getBoundingClientRect();
    return {
      w: Math.round(b.width), h: Math.round(b.height),
      display: getComputedStyle(rl).display,
      grid: getComputedStyle(rl).gridTemplateColumns,
      cards: [...document.querySelectorAll('[data-testid="rule-card"]')].map((c) => Math.round(c.getBoundingClientRect().width)),
    };
  })()`);
  report.ruleListBeforeInspector = ruleBefore;

  // 「默认是否展开」先按打开前的真实状态记录，再打开检查器做后续测量
  const inspectorBefore = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="inspector"]'))`);
  report.inspectorOpenByDefault = inspectorBefore;
  add('检查器默认展开', inspectorBefore, `打开前 inspector 存在=${inspectorBefore}`);
  if (!inspectorBefore) {
    await cdp.click('inspector-toggle');
    await cdp.waitFor(`Boolean(document.querySelector('[data-testid="inspector"]'))`, '检查器出现', 6000);
  }
  await cdp.sleep(400);

  // 展开第一条规则，验证宽而矮容器下「展开项跨整行」
  if (RULE_COUNT > 0) {
    await cdp.evaluate(`(() => { const c = document.querySelector('[data-testid="rule-card"]'); if (!c) return false; c.click(); return true; })()`);
    await cdp.sleep(350);
  }

  const measure = await cdp.evaluate(`(() => {
    const box = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
        right: Math.round(b.right), bottom: Math.round(b.bottom),
        display: cs.display, position: cs.position,
        flexBasis: cs.flexBasis, flexDirection: cs.flexDirection,
        gridTemplateColumns: cs.gridTemplateColumns, flexWrap: cs.flexWrap,
        overflowX: cs.overflowX, scrollbarWidth: cs.scrollbarWidth,
        transform: cs.transform, zIndex: cs.zIndex,
        visible: b.width > 0 && b.height > 0,
      };
    };
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];
    const text = (el) => el ? el.innerText.replace(/\\s+/g, ' ').trim() : null;
    const tabs = q('[data-testid="list-tabs"]');
    const inspector = q('[data-testid="inspector"]');
    const ruleList = q('[data-testid="rule-list"]');
    const ws = q('.workspace');
    const nav = q('.nav');
    const actionbar = q('.actionbar');
    return {
      viewport: { innerWidth: innerWidth, innerHeight: innerHeight, dpr: devicePixelRatio },
      workspace: { ...box(ws), view: ws && ws.dataset.view, narrow: ws && ws.dataset.narrow, grid: ws ? getComputedStyle(ws).gridTemplateColumns : null },
      nav: {
        box: box(nav),
        groups: qa('[data-testid^="nav-group-"]').map((g) => g.dataset.testid),
        files: qa('[data-testid="nav-items-files"] [data-testid^="nav-"]').map((i) => i.dataset.testid),
        inspector: qa('[data-testid="nav-items-inspector"] [data-testid^="nav-"]').map((i) => i.dataset.testid),
        foot: qa('.nav-foot [data-testid]').map((i) => i.dataset.testid),
      },
      panes: {
        box: box(q('.panes')), view: q('.panes') && q('.panes').dataset.view,
        dir: q('.panes') && getComputedStyle(q('.panes')).flexDirection,
        main: box(q('.panes > .main')),
        rules: box(q('.panes > .rules')),
      },
      listTabs: tabs ? {
        box: box(tabs), clientWidth: tabs.clientWidth, scrollWidth: tabs.scrollWidth,
        tabs: qa('.list-tabs .tab').map((t2) => ({ key: t2.dataset.testid, text: text(t2), x: Math.round(t2.getBoundingClientRect().x), y: Math.round(t2.getBoundingClientRect().y), w: Math.round(t2.getBoundingClientRect().width) })),
        dock: (() => { const d = q('[data-testid="inspector-toggle"]'); return d ? { ...box(d), text: text(d), expanded: d.getAttribute('aria-expanded') } : null; })(),
      } : null,
      inspector: inspector ? {
        box: box(inspector), mode: inspector.dataset.mode,
        scope: text(q('[data-testid="inspector-scope"]')),
        tabs: qa('.inspector-tab').map((t2) => ({ id: t2.dataset.testid, text: text(t2), selected: t2.getAttribute('aria-selected') })),
        footer: (() => { const f = q('.inspector .dialog-foot'); return f ? { box: box(f), buttons: qa('.inspector .dialog-foot button').map((b) => ({ id: b.dataset.testid, text: text(b) })) } : null; })(),
        close: box(q('[data-testid="inspector-close"]')),
      } : null,
      ruleList: ruleList ? {
        ...box(ruleList),
        cards: qa('[data-testid="rule-card"]').map((c) => ({ ...box(c), open: c.classList.contains('open') })),
        empty: Boolean(q('.rules-empty')),
      } : null,
      actionbar: box(actionbar),
      narrowUi: {
        fab: box(q('[data-testid="nav-fab"]')),
        notice: box(q('[data-testid="narrow-notice"]')),
        noticeText: text(q('[data-testid="narrow-notice"]')),
      },
      legacy: {
        pageTestIds: qa('[data-testid^="page-"]').map((e) => e.dataset.testid),
        oldNav: qa('[data-testid="nav-music"],[data-testid="nav-photo"],[data-testid="nav-office"],[data-testid="nav-text"]').map((e) => e.dataset.testid),
        metaEditDialogOpen: Boolean(q('[data-testid="meta-edit-dialog"]')),
        inlineEditButtons: qa('[data-testid^="list-action-edit-"],[data-testid^="list-action-attrs"],[data-testid^="list-action-organize"]').map((e) => e.dataset.testid),
      },
      rows: qa('.trow').length,
    };
  })()`);

  report.viewport = measure.viewport;
  report.measures = measure;

  const shot = await cdp.shot(`layout-${LABEL}`);
  report.shots.push(shot);

  const vw = measure.viewport.innerWidth;
  add('窗口实测宽高', true, `${vw}x${measure.viewport.innerHeight} dpr=${measure.viewport.dpr}`);
  add('布局视图', measure.panes.view === VIEW, `panes.view=${measure.panes.view}`);
  add('检查器停靠右侧', Boolean(measure.inspector) && measure.inspector.box.right >= vw - 2, measure.inspector ? `x=${measure.inspector.box.x} right=${measure.inspector.box.right} w=${measure.inspector.box.w} vw=${vw}` : '不存在');
  const docked = measure.inspector && measure.inspector.box.position === 'static';
  add('检查器宽 320px（停靠时）', docked ? measure.inspector.box.w === 320 : measure.inspector.box.w === 340, measure.inspector ? `${measure.inspector.box.w} (${measure.inspector.box.position})` : '-');
  add('检查器页签 6 个', measure.inspector ? measure.inspector.tabs.length === 6 : false, measure.inspector ? measure.inspector.tabs.map((t2) => t2.id).join(',') : '-');
  add('检查器作用于 N 个文件', measure.inspector ? /3/.test(measure.inspector.scope || '') : false, measure.inspector ? measure.inspector.scope : '-');
  add('规则链与检查器同屏', Boolean(measure.panes.rules) && Boolean(measure.inspector), measure.panes.rules ? `rules h=${measure.panes.rules.h} w=${measure.panes.rules.w}` : 'rules 不存在');
  add('页签行横向溢出', measure.listTabs ? measure.listTabs.scrollWidth === measure.listTabs.clientWidth : false, measure.listTabs ? `client=${measure.listTabs.clientWidth} scroll=${measure.listTabs.scrollWidth}` : '-');
  add('页签行带检查器开关', Boolean(measure.listTabs && measure.listTabs.dock), measure.listTabs && measure.listTabs.dock ? `w=${measure.listTabs.dock.w} text=${measure.listTabs.dock.text}` : '-');
  add('导航两组', measure.nav.groups.length === 2, measure.nav.groups.join(','));
  add('旧整页入口残留', measure.legacy.pageTestIds.length === 0 && measure.legacy.oldNav.length === 0, JSON.stringify(measure.legacy));
  add('动作栏在底部', Boolean(measure.actionbar) && measure.actionbar.bottom >= measure.viewport.innerHeight - 60, measure.actionbar ? `y=${measure.actionbar.y} bottom=${measure.actionbar.bottom} ih=${measure.viewport.innerHeight}` : '-');
  if (measure.ruleList) {
    const wideShort = ['files-top', 'rules-top', 'compact'].includes(VIEW) || vw < 1280;
    if (wideShort) {
      add('规则卡片多列自适应', measure.ruleList.display === 'grid', `display=${measure.ruleList.display} cols=${measure.ruleList.gridTemplateColumns} cards=${measure.ruleList.cards.length}`);
      const ropen = measure.ruleList.cards.find((c) => c.open);
      // 列表内边距 10px×2，展开卡片扣掉纵向滚动条仍应接近整行内容宽
      add('展开卡片跨整行', Boolean(ropen) && ropen.w >= measure.ruleList.w - 35, ropen ? `open.w=${ropen.w} list.w=${measure.ruleList.w} 内容宽=${measure.ruleList.w - 20}` : '无展开卡片');
    } else {
      add('并排视图保持单栏', measure.ruleList.display === 'flex' && measure.ruleList.cards.every((c) => c.w >= measure.ruleList.w - 35), `display=${measure.ruleList.display} cards=${measure.ruleList.cards.map((c) => c.w).join('/')} list.w=${measure.ruleList.w}`);
    }
  }
  if (vw <= 1100) {
    add('≤1100 检查器变抽屉', Boolean(measure.inspector) && measure.inspector.box.position === 'absolute', measure.inspector ? measure.inspector.box.position : '-');
    add('窄窗提示条出现', Boolean(measure.narrowUi.notice), measure.narrowUi.noticeText || '-');
  }

  fs.writeFileSync(path.join(OUT, `layout-${LABEL}.json`), JSON.stringify(report, null, 2));
  console.log(`\n=== ${LABEL} 结果 ===`);
  console.log(JSON.stringify({ inspectorOpenByDefault: report.inspectorOpenByDefault, failures: report.checks.filter((c) => !c.ok) }, null, 2));
} finally {
  cdp.close();
}
