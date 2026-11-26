/* 无头浏览器 E2E：加载真实前端构建产物，注入 mock Tauri 后端，
 * 通过 CDP 驱动交互、断言 DOM、落盘截图并生成报告。
 * 不启动 tauri dev、不打开任何可见窗口。用法：node e2e/run.mjs */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..');
const DIST = path.join(APP_ROOT, 'dist');
const SHOTS = path.join(HERE, 'screenshots');
const REPORT_JSON = path.join(HERE, 'report.json');
const REPORT_MD = path.join(HERE, 'report.md');
let HTTP_PORT = Number(process.env.E2E_PORT || 4173);
let CDP_PORT = Number(process.env.E2E_CDP_PORT || 9333);
const RUN_LOG = path.join(HERE, 'run.log');

function dbg(...args) {
  const line = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  fs.appendFileSync(RUN_LOG, `${line}\n`, 'utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 选一个当前空闲的本地端口，避免连到上一次运行遗留的无头浏览器实例 */
async function pickPort(start) {
  for (let port = start; port < start + 80; port += 1) {
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error(`找不到空闲端口（从 ${start} 起 80 个）`);
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    /* ignore */
  }
}

function findBrowser() {
  const candidates = [
    process.env.E2E_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function serveDist() {
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  };
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.join(DIST, rel);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(HTTP_PORT, '127.0.0.1', () => resolve(server)));
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        this.listeners.get(msg.method)?.forEach((fn) => fn(msg.params, msg.sessionId));
      }
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}, sessionId) {
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }, 12000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function waitForHttp(url, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* retry */
    }
    await sleep(150);
  }
  throw new Error(`等待服务超时：${url}`);
}

const results = [];
let pageExceptionCount = 0;
function check(layer, name, ok, detail = '') {
  results.push({ layer, name, ok: !!ok, detail });
  dbg(`${ok ? 'PASS' : 'FAIL'} [${layer}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  fs.writeFileSync(RUN_LOG, '', 'utf8');

  // 真实文件层：元变量 + 八规则端到端（独立子进程，失败不影响浏览器层继续跑）
  for (const [script, label] of [
    ['vars.mjs', '元变量真实文件验证'],
    ['rules-fs.mjs', '八规则真实文件端到端（建文件→改名→校验→撤销）'],
    ['number-advanced.mjs', '编号分组/排除/按路径取号 + 元变量表达式真实验证'],
    ['policy.mjs', '智能更名策略（默认值对照 + 真实文件截断/跳过）'],
  ]) {
    const run = spawnSync(process.execPath, [path.join(HERE, script)], {
      cwd: path.join(HERE, '..'),
      encoding: 'utf8',
      timeout: 180000,
    });
    const resultLine = (run.stdout || '').split(/\r?\n/).find((line) => line.startsWith('RESULT')) || '';
    check('REAL-FS', label, run.status === 0 && resultLine.length > 0, resultLine || (run.stderr || '').slice(-200));
  }

  const browser = findBrowser();
  dbg('browser', browser);
  if (!browser) throw new Error('未找到 Edge / Chrome，可设置 E2E_BROWSER 指向浏览器可执行文件');
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error(`找不到构建产物 ${DIST}，请先运行 npm run build`);
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const old of fs.readdirSync(SHOTS)) fs.rmSync(path.join(SHOTS, old), { force: true });

  HTTP_PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : await pickPort(4173);
  CDP_PORT = process.env.E2E_CDP_PORT ? Number(process.env.E2E_CDP_PORT) : await pickPort(9333);
  dbg('ports', { http: HTTP_PORT, cdp: CDP_PORT });

  const server = await serveDist();
  const userDataDir = path.join(os.tmpdir(), `rename-studio-e2e-${Date.now()}`);
  const browserLog = fs.openSync(path.join(HERE, 'browser.log'), 'w');
  const child = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: ['ignore', browserLog, browserLog] });

  let cdp;
  try {
    const version = await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`);
    cdp = await CDP.connect(version.webSocketDebuggerUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    const send = (method, params = {}) => cdp.send(method, params, sessionId);
    const evaluate = async (expression) => {
      const out = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (out.exceptionDetails) {
        const desc = out.exceptionDetails.exception?.description || out.exceptionDetails.text;
        throw new Error(`页面执行失败：${desc}`);
      }
      return out.result?.value;
    };
    const waitFor = async (expression, label, timeout = 12000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        try {
          if (await evaluate(`Boolean(${expression})`)) return;
        } catch {
          /* 页面可能正在重载 */
        }
        await sleep(80);
      }
      throw new Error(`等待超时：${label}`);
    };
    const click = (selector) =>
      evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('找不到元素 ${selector}');
        el.click();
        return true;
      })()`);
    const clickText = (selector, text) =>
      evaluate(`(() => {
        const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
        const el = nodes.find((n) => n.textContent.trim() === ${JSON.stringify(text)});
        if (!el) throw new Error('找不到文本为 ${text} 的元素');
        el.click();
        return true;
      })()`);
    /** 低频命令收进了工具栏「更多」菜单（HIG）：先开菜单再点条目；已开则直接复用 */
    const openMoreMenu = async () => {
      const menuOpen = () => evaluate(`Boolean(document.querySelector('[data-testid="toolbar-more-menu"]'))`);
      const trigger = () => evaluate(`Boolean(document.querySelector('[data-testid="toolbar-more"]'))`);
      if (await menuOpen()) return;
      if (!(await trigger())) return;
      await click('[data-testid="toolbar-more"]');
      await sleep(100);
      if (!(await menuOpen())) {
        // 上一轮点开后残留的展开态会被同一个按钮收起，再点一次即可回到打开
        await click('[data-testid="toolbar-more"]');
        await sleep(100);
      }
      await waitFor(`document.querySelector('[data-testid="toolbar-more-menu"]')`, '工具栏「更多」菜单');
    };
    const openSettings = async () => {
      await openMoreMenu();
      await click('[data-testid="open-settings"]');
      await waitFor(`document.querySelector('.drawer')`, '设置抽屉打开');
    };
    /** 检查器已改为列表下方的底部抽屉：六类操作走分段控件，入口仍是页头的检查器开关 */
    const openInspectorMode = async (mode) => {
      const opened = await evaluate(`Boolean(document.querySelector('[data-testid="inspector"]'))`);
      if (!opened) await click('[data-testid="inspector-toggle"]');
      await waitFor(`document.querySelector('[data-testid="inspector"]')`, '检查器抽屉打开', 4000);
      await click(`[data-testid="inspector-tab-${mode}"]`);
      await waitFor(`document.querySelector('[data-testid="inspector"][data-mode="${mode}"]')`, `检查器分段 ${mode}`, 6000);
    };
    const setInput = (selector, value, index = 0) =>
      evaluate(`(() => {
        const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
        const el = els[${index}];
        if (!el) throw new Error('找不到输入框 ${selector}[${index}]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
    const textOf = (selector) => evaluate(`(document.querySelector(${JSON.stringify(selector)})?.textContent || '')`);
    const countOf = (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    const shot = async (name) => {
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(SHOTS, name), Buffer.from(data, 'base64'));
      return `screenshots/${name}`;
    };
    const viewport = (width, height, scale = 1) =>
      send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    cdp.on('Runtime.exceptionThrown', (params) => {
      pageExceptionCount += 1;
      const desc = params.exceptionDetails?.exception?.description || params.exceptionDetails?.text;
      dbg(`[PAGE EXCEPTION] ${desc}`);
    });
    cdp.on('Log.entryAdded', (params) => {
      dbg(`[PAGE LOG ${params.entry?.level}] ${params.entry?.text}`);
    });
    cdp.on('Page.loadEventFired', () => dbg('[PAGE loadEventFired]'));
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: fs.readFileSync(path.join(HERE, 'mock-backend.js'), 'utf8'),
    });
    await viewport(1440, 900, 1);
    dbg('navigate', `http://127.0.0.1:${HTTP_PORT}/index.html?lang=zh-CN`);
    await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/index.html?lang=zh-CN` });
    try {
      await waitFor(`document.querySelector('.workspace') && document.querySelector('.empty-state')`, '应用首屏', 15000);
      dbg('first screen ready');
    } catch (err) {
      try {
        dbg('href', await evaluate('location.href'));
        const html = await evaluate('document.body ? document.body.innerHTML : "(no body)"');
        dbg('[首屏 DOM]', String(html).slice(0, 3000));
        await shot('debug-boot.png');
      } catch (inner) {
        dbg('[首屏诊断失败]', String(inner));
      }
      throw err;
    }
    await sleep(400);
    await shot('00-empty-light.png');
    const bootTheme = await evaluate(`({
      theme: document.documentElement.dataset.theme,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      panelBg: getComputedStyle(document.querySelector('.win')).backgroundColor,
    })`);
    check('UI', '首屏为浅色主题', bootTheme.theme === 'light' && bootTheme.panelBg === 'rgb(255, 255, 255)', JSON.stringify(bootTheme));
    check('UI', '首屏加载（桌面模式 + mock 后端）', (await countOf('.win')) === 1);
    check('UI', '初始列表为空', (await countOf('.trow')) === 0);
    const hiddenDefault = await evaluate(`document.querySelector('[data-testid="switch-hidden"]')?.getAttribute('aria-checked')`);
    check('UI', '「含隐藏文件」开关默认开启', hiddenDefault === 'true', String(hiddenDefault));

    // 窗口权限声明（配置层，不发请求、不启动窗口）
    const capabilities = JSON.parse(
      fs.readFileSync(path.join(APP_ROOT, 'src-tauri', 'capabilities', 'default.json'), 'utf8'),
    );
    const requiredWindowPerms = [
      'core:window:allow-close',
      'core:window:allow-minimize',
      'core:window:allow-toggle-maximize',
      'core:window:allow-start-dragging',
    ];
    check(
      'config',
      'capability 声明包含窗口关闭/最小化/最大化/拖拽权限',
      requiredWindowPerms.every((p) => capabilities.permissions.includes(p)),
      capabilities.permissions.join(', '),
    );

    // 08/20 变异：添加文件
    await click('[data-testid="add-files"]');
    await waitFor(`document.querySelectorAll('.trow').length === 4`, '添加 4 个文件');
    check('UI', '添加文件 → 列表出现 4 行', (await countOf('.trow')) === 4);
    await shot('01-files-added.png');

    // 表头与行必须共用同一网格：逐列比对左／右边缘，偏差 > 0.5px 即视为错列
    const colGeom = await evaluate(`(() => {
      const head = document.querySelector('.thead');
      const row = document.querySelector('.trow');
      if (!head || !row) return null;
      const ths = [...head.querySelectorAll('.th')];
      const cells = [...row.children].filter((c) => c.classList.contains('cell'));
      if (ths.length !== cells.length) return { count: [ths.length, cells.length], ths: ths.length, cells: cells.length };
      const COL = ['checkbox', 'name', 'location', 'size', 'modified', 'newName', 'status'];
      const r = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, w: b.width, r: b.right, h: b.height }; };
      return {
        cols: ths.map((th, i) => ({
          col: COL[i] || ('#' + i),
          head: r(th),
          cell: r(cells[i]),
          label: th.textContent.trim().slice(0, 8),
        })),
        // 状态列：表头文字左缘 vs 行内徽标左缘（历史偏差就出在这里）
        statusChip: (() => {
          const chip = row.querySelector('.status');
          const th = ths[6];
          if (!chip || !th) return null;
          const range = document.createRange();
          range.selectNodeContents(th);
          const text = range.getBoundingClientRect();
          return { textL: text.left, chipL: r(chip).l, chipW: r(chip).w, thL: r(th).l };
        })(),
      };
    })()`);
    if (!colGeom || !colGeom.cols) {
      check('UI', '表头与行逐列网格对齐', false, `列数与单元格数不一致：${JSON.stringify(colGeom)}`);
    } else {
      const deltas = colGeom.cols.map((c) => ({
        col: c.col,
        dLeft: +(c.head.l - c.cell.l).toFixed(2),
        dWidth: +(c.head.w - c.cell.w).toFixed(2),
      }));
      const worst = deltas.reduce((m, d) => Math.max(m, Math.abs(d.dLeft), Math.abs(d.dWidth)), 0);
      check(
        'UI',
        '表头与行逐列共用同一网格（7 列左右边缘偏差 ≤0.5px）',
        worst <= 0.5,
        `max=${worst} ${JSON.stringify(deltas)}`,
      );
      const chip = colGeom.statusChip;
      check(
        'UI',
        '状态列：表头文字与行内徽标左缘对齐（偏差 ≤1px）',
        chip && Math.abs(chip.textL - chip.chipL) <= 1,
        chip ? `textL=${chip.textL.toFixed(2)} chipL=${chip.chipL.toFixed(2)} Δ=${(chip.textL - chip.chipL).toFixed(2)}` : '取不到状态徽标',
      );
    }

    // 规则链：替换 + 大小写，并测试排序
    await click('[data-testid="add-rule"]');
    await waitFor(`document.querySelector('[data-testid="rule-type-replace"]')`, '规则菜单');
    await click('[data-testid="rule-type-replace"]');
    await waitFor(`document.querySelectorAll('[data-testid="rule-card"]').length === 1`, '替换规则卡');
    await setInput('.rule-detail .input', '旧照片 ', 0);
    await setInput('.rule-detail .input', '旅行_', 1);
    await waitFor(`document.querySelector('.trow')?.textContent.includes('旅行_001')`, '替换规则即时预览');
    check('UI', '规则编辑 → 原名/新名实时预览', (await textOf('.trow')).includes('旅行_001'));
    await waitFor(`[...document.querySelectorAll('.trow')].some((r) => r.textContent.includes('冲突'))`, '冲突检测', 15000);
    const conflictInfo = await evaluate(`(() => {
      const row = [...document.querySelectorAll('.trow')].find((r) => r.textContent.includes('冲突'));
      return { text: row?.textContent || '', all: [...document.querySelectorAll('.trow .status')].map((s) => s.textContent) };
    })()`);
    check('UI', '冲突行显示明确状态（不静默覆盖）', conflictInfo.text.includes('旅行_003') && conflictInfo.text.includes('冲突'), JSON.stringify(conflictInfo.all));
    await shot('02-preview-conflict.png');

    await click('[data-testid="add-rule"]');
    await waitFor(`document.querySelector('[data-testid="rule-type-case"]')`, '规则菜单 2');
    await click('[data-testid="rule-type-case"]');
    await waitFor(`document.querySelectorAll('[data-testid="rule-card"]').length === 2`, '第二条规则');
    await waitFor(`document.querySelectorAll('[data-testid="rule-card"]')[1]?.querySelector('[data-testid="rule-up"]')`, '上移按钮');
    await evaluate(`(() => {
      const cards = [...document.querySelectorAll('[data-testid="rule-card"]')];
      cards[1].querySelector('[data-testid="rule-up"]').click();
      return true;
    })()`);
    await sleep(200);
    const order = await evaluate(`[...document.querySelectorAll('[data-testid="rule-card"]')].map((el) => el.dataset.ruleType)`);
    check('UI', '规则链排序（上移后顺序变化）', order[0] === 'case' && order[1] === 'replace', order.join(' → '));
    // 移回原顺序，保持后续预览一致
    await evaluate(`(() => {
      const cards = [...document.querySelectorAll('[data-testid="rule-card"]')];
      cards[0].querySelector('[data-testid="rule-down"]').click();
      return true;
    })()`);
    await sleep(200);
    const order2 = await evaluate(`[...document.querySelectorAll('[data-testid="rule-card"]')].map((el) => el.dataset.ruleType)`);
    check('UI', '规则链排序（下移恢复）', order2[0] === 'replace' && order2[1] === 'case', order2.join(' → '));

    // 执行顺序 = 扫描顺序：先把表格按名称排序，再应用，断言提交顺序不随显示顺序变化
    await click('.thead .th.sortable');
    await click('.thead .th.sortable');
    await sleep(250);
    const sortedFirst = await evaluate(`document.querySelector('.trow')?.textContent || ''`);
    check('UI', '列头排序只改变显示顺序（首行变为 logo.png）', sortedFirst.includes('logo.png'), sortedFirst.slice(0, 60));

    // 预览与策略
    await click('[data-testid="action-preview"]');
    await waitFor(`document.querySelector('[data-testid="preview-confirm"]')`, '预览弹窗');
    check('UI', '预览弹窗打开', (await countOf('.modal-mask')) >= 1);
    await shot('03-preview-dialog.png');
    await click('[data-testid="policy-suffix"]');
    const suffixOn = await evaluate(`document.querySelector('[data-testid="policy-suffix"]')?.classList.contains('on')`);
    check('UI', '冲突策略切换（自动加后缀）', suffixOn);
    await shot('04-policy-suffix.png');
    await click('[data-testid="policy-skip"]');
    const skipOn = await evaluate(`document.querySelector('[data-testid="policy-skip"]')?.classList.contains('on')`);
    check('UI', '冲突策略切回（跳过）', skipOn);

    // 应用（skip），mock 后端记录批次
    await click('[data-testid="preview-confirm"]');
    // ---- 批次执行进度：进度条随批次推进变化（已处理/总数 + 当前文件名 + 可取消）----
    let sawProgressUi = false;
    try {
      await waitFor(`document.querySelector('[data-testid="apply-progress"]')`, '执行进度条出现', 1500);
      sawProgressUi = true;
    } catch {
      sawProgressUi = false;
    }
    const progressUi = await evaluate(`(() => {
      const el = document.querySelector('[data-testid="apply-progress"]');
      if (!el) return null;
      return {
        count: el.querySelector('[data-testid="apply-progress-count"]')?.textContent || '',
        phase: el.querySelector('[data-testid="apply-progress-phase"]')?.textContent || '',
        current: el.querySelector('[data-testid="apply-progress-name"]')?.textContent || '',
        cancel: !!el.querySelector('[data-testid="apply-cancel"]'),
        barWidth: el.querySelector('.progress-bar span')?.style.width || '',
      };
    })()`);
    if (sawProgressUi) await shot('04b-apply-progress.png');
    await waitFor(`!document.querySelector('[data-testid="preview-confirm"]')`, '应用完成');
    await waitFor(`[...document.querySelectorAll('.trow')].some((r) => r.textContent.includes('旅行_001'))`, '应用后列表刷新');
    const applyOrder = await evaluate(`window.__E2E__.applyOrder`);
    check(
      'UI-triggered mock',
      '执行顺序 = 扫描顺序（列头排序不影响提交顺序）',
      applyOrder.length === 3 && applyOrder[0].endsWith('旧照片 001.jpg') && sortedFirst.includes('logo.png'),
      applyOrder.join(' | '),
    );
    const progressEvents = await evaluate(`window.__E2E__.progressEvents || []`);
    const distinctSteps = new Set(progressEvents.map((e) => `${e.phase}:${e.done}`));
    check(
      'UI',
      '批次执行进度：进度条随批次推进变化（已处理/总数 · 当前文件名 · 可取消）',
      sawProgressUi &&
        !!progressUi?.cancel &&
        /\d+\/\d+/.test(progressUi.count) &&
        progressEvents.length >= 3 &&
        distinctSteps.size >= 3 &&
        progressEvents.every((e) => e.total === 3),
      `ui=${JSON.stringify(progressUi)} events=${progressEvents.length} distinct=${distinctSteps.size}`,
    );
    const batch = await evaluate(`window.__E2E__.batches[0]`);
    check('UI', '应用 → 2 个完成 + 1 个冲突跳过（未改名文件不参与）', batch?.counts?.done === 2 && batch?.counts?.skipped === 1, JSON.stringify(batch?.counts));
    check('UI', '冲突文件保持原名', (await evaluate(`window.__E2E__.files.some((f) => f.path.endsWith('旧照片 003.jpg'))`)));
    await shot('05-applied.png');

    // 撤销
    await click('[data-testid="action-undo"]');
    await waitFor(`window.__E2E__.batches[0]?.state === 'undone'`, '撤销完成');
    await waitFor(`[...document.querySelectorAll('.trow')].some((r) => r.textContent.includes('旧照片 001'))`, '撤销后列表还原');
    const restored = await evaluate(`window.__E2E__.files.map((f) => f.path.split('\\\\').pop())`);
    check('UI', '撤销 → 4 个原名全部恢复', restored.length === 4 && restored.every((n) => n.startsWith('旧照片') || n === 'logo.png'), JSON.stringify(restored));
    await shot('06-undone.png');

    // ---- 撤销历史面板：条目信息 / 撤销后状态 / 外部改动后不可撤销 ----
    await click('[data-testid="nav-history"]');
    await waitFor(`document.querySelector('[data-testid="history-item"]')`, '操作记录抽屉打开');
    const historyUndone = await evaluate(`(() => {
      const item = document.querySelector('[data-testid="history-item"]');
      return {
        undoable: item?.dataset.undoable,
        state: item?.querySelector('[data-testid="history-state"]')?.textContent || '',
        reason: item?.querySelector('[data-testid="undo-reason"]')?.textContent || '',
        text: item?.textContent || '',
      };
    })()`);
    check(
      'UI',
      '历史面板：批次展示时间 / 条目数 / 成功失败数 / 策略',
      historyUndone.text.includes('成功') &&
        historyUndone.text.includes('失败') &&
        historyUndone.text.includes('策略') &&
        historyUndone.text.includes('更名'),
      historyUndone.text.slice(0, 90),
    );
    check(
      'UI',
      '历史面板：已撤销批次显示「已撤销」并说明原因',
      historyUndone.undoable === '0' &&
        historyUndone.state.includes('已撤销') &&
        historyUndone.reason.includes('已经撤销'),
      JSON.stringify(historyUndone).slice(0, 160),
    );
    await shot('06b-history-panel.png');

    // 再跑一批 → 面板撤销 → 条目变「已撤销」
    await click('.drawer-mask');
    await sleep(250);
    await click('[data-testid="action-preview"]');
    await waitFor(`document.querySelector('[data-testid="preview-confirm"]')`, '再次预览');
    await click('[data-testid="preview-confirm"]');
    await waitFor(
      `window.__E2E__.batches.length === 2 && window.__E2E__.batches[0].state !== 'undone'`,
      '第二批执行完成',
    );
    await waitFor(
      `[...document.querySelectorAll('.trow')].some((r) => r.textContent.includes('旅行_001'))`,
      '第二批已改名',
    );
    await waitFor(`!document.querySelector('[data-testid="apply-progress"]')`, '第二批进度结束');
    await click('[data-testid="nav-history"]');
    await waitFor(`document.querySelectorAll('[data-testid="history-item"]').length === 2`, '历史两条批次');
    const newestBatch = await evaluate(
      `(() => { const i = document.querySelector('[data-testid="history-item"]'); return { undoable: i?.dataset.undoable, id: i?.dataset.batchId }; })()`,
    );
    check('UI', '历史面板：新批次显示「可撤销」', newestBatch.undoable === '1', JSON.stringify(newestBatch));
    await click('[data-testid="undo-batch"]');
    await waitFor(`window.__E2E__.batches[0]?.state === 'undone'`, '面板撤销完成');
    await waitFor(
      `[...document.querySelectorAll('.trow')].some((r) => r.textContent.includes('旧照片 001'))`,
      '面板撤销后列表还原',
    );
    const historyAfterUndo = await evaluate(`(() => {
      const i = document.querySelector('[data-testid="history-item"]');
      return {
        undoable: i?.dataset.undoable,
        state: i?.querySelector('[data-testid="history-state"]')?.textContent || '',
        chip: i?.querySelector('[data-testid="undo-state"]')?.textContent || '',
        reason: i?.querySelector('[data-testid="undo-reason"]')?.textContent || '',
      };
    })()`);
    check(
      'UI',
      '历史面板：撤销后条目变为「已撤销」',
      historyAfterUndo.undoable === '0' &&
        historyAfterUndo.state.includes('已撤销') &&
        historyAfterUndo.chip.includes('已撤销') &&
        historyAfterUndo.reason.includes('已经撤销'),
      JSON.stringify(historyAfterUndo),
    );
    await shot('06c-history-after-undo.png');

    // 多级撤销：两批都有实际改名时，「撤销到此」应一次回退两批
    await click('.drawer-mask');
    await sleep(250);
    // 第三批：只勾选 001
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.trow')].find((r) => r.textContent.includes('旧照片 002'));
      row?.querySelector('.checkbox')?.click();
      return !!row;
    })()`);
    await click('[data-testid="action-preview"]');
    await waitFor(`document.querySelector('[data-testid="preview-confirm"]')`, '第三批预览');
    await click('[data-testid="preview-confirm"]');
    await waitFor(
      `window.__E2E__.batches.length === 3 && window.__E2E__.batches[0].state !== 'undone'`,
      '第三批执行完成',
    );
    await waitFor(
      `[...document.querySelectorAll('.trow')].some((r) => r.textContent.includes('旅行_001'))`,
      '第三批已改名',
    );
    await waitFor(`!document.querySelector('[data-testid="apply-progress"]')`, '第三批进度结束');
    // 第四批：只勾选 002
    await evaluate(`(() => {
      const first = [...document.querySelectorAll('.trow')].find((r) => r.textContent.includes('旅行_001'));
      const second = [...document.querySelectorAll('.trow')].find((r) => r.textContent.includes('旧照片 002'));
      first?.querySelector('.checkbox')?.click();
      second?.querySelector('.checkbox')?.click();
      return !!(first && second);
    })()`);
    await click('[data-testid="action-preview"]');
    await waitFor(`document.querySelector('[data-testid="preview-confirm"]')`, '第四批预览');
    await click('[data-testid="preview-confirm"]');
    await waitFor(
      `window.__E2E__.batches.length === 4 && window.__E2E__.batches[0].state !== 'undone'`,
      '第四批执行完成',
    );
    await waitFor(`!document.querySelector('[data-testid="apply-progress"]')`, '第四批进度结束');
    await click('[data-testid="nav-history"]');
    await waitFor(`document.querySelectorAll('[data-testid="history-item"]').length === 4`, '历史四条批次');
    await waitFor(
      `(() => { const b = document.querySelector('[data-testid="undo-until"]'); return !!b && !b.disabled; })()`,
      '撤销到此按钮可用',
      10000,
    );
    const untilTarget = await evaluate(`(() => {
      const items = [...document.querySelectorAll('[data-testid="history-item"]')];
      const target = items.find((i) => i.querySelector('[data-testid="undo-until"]'));
      return {
        index: items.indexOf(target),
        undoable: target?.dataset.undoable,
        disabled: target?.querySelector('[data-testid="undo-until"]')?.disabled,
      };
    })()`);
    check(
      'UI',
      '历史面板：较新批次可撤销时，「撤销到此」可用（多级撤销）',
      untilTarget.index === 1 && untilTarget.undoable === '1' && untilTarget.disabled === false,
      JSON.stringify(untilTarget),
    );
    await click('[data-testid="undo-until"]');
    await waitFor(
      `window.__E2E__.batches[0]?.state === 'undone' && window.__E2E__.batches[1]?.state === 'undone'`,
      '多级撤销完成',
    );
    await waitFor(
      `[...document.querySelectorAll('.trow')].some((r) => r.textContent.includes('旧照片 001'))`,
      '多级撤销后列表还原',
    );
    const chainState = await evaluate(`(() => {
      const items = [...document.querySelectorAll('[data-testid="history-item"]')].slice(0, 2);
      return items.map((i) => ({ undoable: i.dataset.undoable, state: i.querySelector('[data-testid="history-state"]')?.textContent }));
    })()`);
    check(
      'UI',
      '历史面板：多级撤销后两条批次都变为「已撤销」',
      chainState.every((i) => i.undoable === '0' && i.state.includes('已撤销')),
      JSON.stringify(chainState),
    );
    await shot('06d-history-multi-undo.png');

    // 外部改动（mock 磁盘层）：目标文件被移走 → 不可撤销
    await click('.drawer-mask');
    await sleep(250);
    await evaluate(`document.querySelector('.thead .checkbox')?.click()`);
    await click('[data-testid="action-preview"]');
    await waitFor(`document.querySelector('[data-testid="preview-confirm"]')`, '第五批预览');
    await click('[data-testid="preview-confirm"]');
    await waitFor(
      `window.__E2E__.batches.length === 5 && window.__E2E__.batches[0].state !== 'undone'`,
      '第五批执行完成',
    );
    const moved = await evaluate(`(() => {
      const f = window.__E2E__.files.find((x) => x.path.endsWith('旅行_001.jpg'));
      if (f) f.path = f.path.replace('旅行_001.jpg', '旅行_001-外部移动.jpg');
      return !!f;
    })()`);
    check('UI-triggered mock', '模拟外部移动目标文件', moved);
    await click('[data-testid="nav-history"]');
    await waitFor(`document.querySelectorAll('[data-testid="history-item"]').length === 5`, '历史五条批次');
    await click('[data-testid="history-refresh"]');
    await waitFor(
      `document.querySelector('[data-testid="history-item"]')?.dataset.undoable === '0'`,
      '刷新后判定不可撤销',
    );
    const blocked = await evaluate(`(() => {
      const i = document.querySelector('[data-testid="history-item"]');
      return {
        undoable: i?.dataset.undoable,
        reason: i?.querySelector('[data-testid="undo-reason"]')?.textContent || '',
        chip: i?.querySelector('[data-testid="undo-state"]')?.textContent || '',
        hasUndoBtn: !!i?.querySelector('[data-testid="undo-batch"]'),
      };
    })()`);
    check(
      'UI-triggered mock',
      '外部移动目标文件 → 历史条目不可撤销并给出原因',
      blocked.undoable === '0' &&
        blocked.reason.includes('目标文件已不存在') &&
        blocked.chip.includes('不可撤销') &&
        !blocked.hasUndoBtn,
      JSON.stringify(blocked),
    );
    await shot('06e-history-blocked.png');

    // 还原外部改动，撤销第五批，恢复到其它用例期望的原名
    await evaluate(`(() => {
      const f = window.__E2E__.files.find((x) => x.path.endsWith('旅行_001-外部移动.jpg'));
      if (f) f.path = f.path.replace('旅行_001-外部移动.jpg', '旅行_001.jpg');
      return !!f;
    })()`);
    await click('[data-testid="history-refresh"]');
    await waitFor(
      `document.querySelector('[data-testid="history-item"]')?.dataset.undoable === '1'`,
      '还原后可撤销',
    );
    await click('[data-testid="undo-batch"]');
    await waitFor(
      `[...document.querySelectorAll('.trow')].some((r) => r.textContent.includes('旧照片 001'))`,
      '第五批撤销后还原原名',
    );
    await click('.drawer-mask');
    await sleep(200);

    // 主题
    await openSettings();
    await waitFor(`document.querySelector('.drawer')`, '设置抽屉');
    await clickText('.drawer .seg-ctrl span', '深色');
    await sleep(250);
    const theme = await evaluate(`({
      theme: document.documentElement.dataset.theme,
      panelBg: getComputedStyle(document.querySelector('.win')).backgroundColor,
    })`);
    check('UI', '明暗主题切换 → data-theme=dark 且面板底色变化', theme.theme === 'dark' && theme.panelBg !== bootTheme.panelBg, JSON.stringify(theme));

    // 跟随系统：写入设置 + 运行时系统主题变化监听（用 CDP 模拟系统配色）
    await click('[data-testid="theme-system"]');
    await sleep(250);
    const storedTheme = await evaluate(`JSON.parse(localStorage.getItem('rename-studio.settings')).data.theme`);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await sleep(300);
    const sysDark = await evaluate(`document.documentElement.dataset.theme`);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await sleep(300);
    const sysLight = await evaluate(`document.documentElement.dataset.theme`);
    check(
      'UI',
      '跟随系统主题：settings.theme=system 且系统配色变化时实时跟随',
      storedTheme === 'system' && sysDark === 'dark' && sysLight === 'light',
      JSON.stringify({ storedTheme, sysDark, sysLight }),
    );
    await click('[data-testid="theme-dark"]');
    await sleep(200);

    // 配色方案：与明暗基调独立，四套完整色板
    await click('[data-testid="theme-light"]');
    await sleep(200);
    const readPalette = () => evaluate(`(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        attr: document.documentElement.dataset.palette,
        theme: document.documentElement.dataset.theme,
        bg: cs.getPropertyValue('--bg').trim(),
        panel: cs.getPropertyValue('--panel').trim(),
        ink: cs.getPropertyValue('--ink').trim(),
        accent: cs.getPropertyValue('--accent').trim(),
        hover: cs.getPropertyValue('--hover').trim(),
        selected: cs.getPropertyValue('--selected').trim(),
        border: cs.getPropertyValue('--line-strong').trim(),
      };
    })()`);
    const paletteIds = ['graphite', 'paper', 'ocean', 'moss'];
    const swatches = {};
    for (const id of paletteIds) {
      await click(`[data-testid="palette-${id}"]`);
      await sleep(200);
      swatches[id] = await readPalette();
    }
    const everySwatchChanged = paletteIds.every((id) =>
      id === 'graphite' || ['bg', 'panel', 'ink', 'accent', 'hover', 'selected', 'border']
        .every((key) => swatches[id][key] !== swatches.graphite[key]));
    const paletteAttrsOk = paletteIds.every((id) => swatches[id].attr === id && swatches[id].theme === 'light');
    check(
      'UI',
      '四套配色各自切换：data-palette 生效且背景/表面/文字/强调/悬停/选中/边框整体更换',
      paletteAttrsOk && everySwatchChanged,
      JSON.stringify(swatches),
    );

    // 明暗与配色分别持久化在设置里（重启保持的完整验证在套件末尾做真实重载）
    await click('[data-testid="theme-dark"]');
    await sleep(200);
    const storedCombo = await evaluate(`JSON.parse(localStorage.getItem('rename-studio.settings')).data`);
    check(
      'UI',
      '明暗与配色分别持久化：settings 同时记录 moss 与 dark',
      storedCombo.palette === 'moss' && storedCombo.theme === 'dark',
      JSON.stringify({ palette: storedCombo.palette, theme: storedCombo.theme }),
    );
    await click('[data-testid="palette-graphite"]');

    // 智能更名策略面板：默认值与「空名处理」联动
    const policyUi = await evaluate(`(() => {
      const max = document.querySelector('[data-testid="input-name-max-length"]');
      const long = document.querySelector('[data-testid="select-long-name-action"]');
      const empty = document.querySelector('[data-testid="select-empty-name-action"]');
      const fallback = document.querySelector('[data-testid="input-empty-fallback"]');
      const skip = document.querySelector('[data-testid="switch-skip-system-hidden"]');
      return {
        max: max?.value, long: long?.value, empty: empty?.value,
        fallback: fallback?.value, fallbackDisabled: fallback?.disabled ?? null,
        skip: skip?.getAttribute('aria-checked'),
      };
    })()`);
    check(
      'UI',
      '策略面板默认值（255 / 阻止 / 阻止 / 未命名 / 关）',
      policyUi.max === '255' && policyUi.long === 'block' && policyUi.empty === 'block'
        && policyUi.fallback === '未命名' && policyUi.fallbackDisabled === true && policyUi.skip === 'false',
      JSON.stringify(policyUi),
    );
    await evaluate(`(() => {
      const sel = document.querySelector('[data-testid="select-empty-name-action"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'fallback');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(250);
    const fallbackEnabled = await evaluate(`document.querySelector('[data-testid="input-empty-fallback"]')?.disabled`);
    check('UI', '空名处理切到「备用名」后备用名输入框可用', fallbackEnabled === false, String(fallbackEnabled));
    await evaluate(`(() => {
      const sel = document.querySelector('[data-testid="select-empty-name-action"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'block');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(200);
    await shot('07-dark-theme.png');
    await click('.drawer-mask');
    await sleep(200);

    // 元数据（只读）：表格当前按名称排序，需点目标行的按钮而非首行
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.trow')].find((r) => r.textContent.includes('旧照片 001'));
      const btn = row?.querySelector('.row-meta');
      if (!btn) throw new Error('找不到旧照片 001 的元数据按钮');
      btn.click();
      return true;
    })()`);
    await waitFor(`document.querySelector('[data-testid="metadata-dialog"]')`, '元数据弹窗');
    const metaText = await textOf('[data-testid="metadata-dialog"]');
    check('UI', '元数据弹窗展示图片尺寸与只读标识', metaText.includes('1920 × 1080') && metaText.includes('未发现 EXIF') && metaText.includes('只读') && metaText.includes('不会修改文件'), metaText.slice(0, 120));
    await shot('08-metadata-readonly.png');
    await clickText('[data-testid="metadata-dialog"] .btn-primary', '关闭');

    // 方案导出
    await click('[data-testid="plan-export"]');
    await waitFor(`document.querySelector('[data-testid="plan-dialog"]')`, '方案导出弹窗');
    await setInput('[data-testid="plan-name-input"]', 'E2E 方案');
    await shot('09-plan-export.png');
    await click('[data-testid="plan-confirm"]');
    await waitFor(`!document.querySelector('[data-testid="plan-dialog"]')`, '方案保存完成');
    const writes = await evaluate(`window.__E2E__.writes`);
    const planText = writes['D:\\e2e\\out\\plan.json'];
    check('UI', '方案导出 → JSON 写入（版本 + 校验）', typeof planText === 'string' && planText.includes('"schema": "rename-studio.plan"') && planText.includes('"version": 1') && /"checksum": "fnv1a:/.test(planText));
    let plan = null;
    try {
      plan = JSON.parse(planText);
      check('UI', '方案 JSON 结构完整（rules 为数组）', Array.isArray(plan.rules) && plan.rules.length >= 1, `rules=${plan?.rules?.length}`);
    } catch (err) {
      check('UI', '方案 JSON 可解析', false, String(err));
    }

    // 方案导入（正常 + 版本不兼容）
    if (planText) await evaluate(`window.__E2E__.planContent = ${JSON.stringify(planText)}`);
    await click('[data-testid="plan-import"]');
    await waitFor(`document.querySelector('[data-testid="plan-dialog"]')`, '方案导入弹窗');
    await waitFor(`document.querySelector('[data-testid="plan-checksum"]')`, '校验徽标');
    const importText = await textOf('[data-testid="plan-dialog"]');
    check('UI', '方案导入 → 显示校验通过与替换冲突提示', importText.includes('校验通过') && importText.includes('替换'));
    await shot('10-plan-import.png');
    await click('[data-testid="plan-confirm"]');
    await waitFor(`!document.querySelector('[data-testid="plan-dialog"]')`, '导入完成');
    const ruleTypes = await evaluate(`[...document.querySelectorAll('[data-testid="rule-card"]')].map((el) => el.dataset.ruleType)`);
    check('UI', '方案导入 → 规则链已替换', ruleTypes.length === (plan?.rules?.length ?? 0), ruleTypes.join(','));

    const incompatible = JSON.stringify({ ...(plan || {}), version: 2 }, null, 2);
    await evaluate(`window.__E2E__.planContent = ${JSON.stringify(incompatible)}`);
    await click('[data-testid="plan-import"]');
    await waitFor(`document.querySelector('[data-testid="plan-dialog"]')`, '不兼容弹窗');
    await waitFor(`document.querySelector('[data-testid="plan-error"]')`, '不兼容提示');
    const errorText = await textOf('[data-testid="plan-error"]');
    check('UI', '不兼容方案（v2）→ 明确错误且不允许导入', errorText.includes('v2') && (await evaluate(`document.querySelector('[data-testid="plan-confirm"]')?.disabled === true`)), errorText.slice(0, 80));
    await shot('11-plan-incompatible.png');
    await clickText('[data-testid="plan-dialog"] .btn-ghost', '取消');

    // 多格式导出：CSV / TSV / HTML / Excel(.xlsx)
    await click('[data-testid="export-menu"]');
    await waitFor(`document.querySelector('[data-testid="export-pop"]')`, '导出菜单');
    const exportItems = await evaluate(`document.querySelectorAll('[data-testid="export-pop"] .layout-item').length`);
    check('UI', '导出菜单提供 CSV / Excel / HTML / TSV 四种格式', exportItems === 4, String(exportItems));
    await click('[data-testid="export-csv"]');
    await waitFor(`window.__E2E__.writes['D:\\\\e2e\\\\out\\\\list.csv'] !== undefined`, 'CSV 写入');
    const csvWrites = await evaluate(`window.__E2E__.writes`);
    const csv = csvWrites['D:\\e2e\\out\\list.csv'];
    const csvLines = (csv || '').split(/\r?\n/);
    check('UI', 'CSV 导出 → 表头 + 原名/新名/状态/错误原因', csvLines[0].replace('\ufeff', '') === '原文件名,新文件名,状态,原因' && csvLines.length >= 5, `${csvLines.length} 行`);
    check('UI', 'CSV 含冲突原因文本', /冲突/.test(csv) && /目标文件已存在|冲突/.test(csv));

    await click('[data-testid="export-menu"]');
    await click('[data-testid="export-tsv"]');
    await waitFor(`window.__E2E__.writes['D:\\\\e2e\\\\out\\\\report.tsv'] !== undefined`, 'TSV 写入');
    const textWrites = await evaluate(`window.__E2E__.writes`);
    const tsv = textWrites['D:\\e2e\\out\\report.tsv'];
    const tsvLines = (tsv || '').split(/\r?\n/);
    check(
      'UI',
      'TSV 导出 → BOM + 制表符四列表头，行数与 CSV 一致',
      tsvLines[0].replace('\ufeff', '').split('\t').length === 4 && tsvLines.length === csvLines.length,
      `${tsvLines.length} 行 / ${tsvLines[0].replace('\ufeff', '')}`,
    );

    await click('[data-testid="export-menu"]');
    await click('[data-testid="export-html"]');
    await waitFor(`window.__E2E__.writes['D:\\\\e2e\\\\out\\\\report.html'] !== undefined`, 'HTML 写入');
    const htmlWrites = await evaluate(`window.__E2E__.writes`);
    const html = htmlWrites['D:\\e2e\\out\\report.html'];
    check(
      'UI',
      'HTML 导出 → 完整文档 + 转义表格 + 中文表头',
      (html || '').startsWith('<!doctype html>') && html.includes('<table>') && html.includes('原文件名') && html.includes('<th>'),
      `${(html || '').length} 字符`,
    );

    await click('[data-testid="export-menu"]');
    await click('[data-testid="export-xlsx"]');
    await waitFor(`window.__E2E__.binaryWrites['D:\\\\e2e\\\\out\\\\report.xlsx'] !== undefined`, 'xlsx 写入');
    const xlsx = await evaluate(`(() => {
      const b64 = window.__E2E__.binaryWrites['D:\\\\e2e\\\\out\\\\report.xlsx'];
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const text = new TextDecoder('utf-8').decode(bytes);
      return {
        zip: bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4,
        sheet: text.includes('xl/worksheets/sheet1.xml'),
        workbook: text.includes('xl/workbook.xml'),
        name: text.includes('旧照片 001.jpg'),
        size: bytes.length,
      };
    })()`);
    check(
      'UI',
      'xlsx 导出 → 合法 ZIP 头、含工作簿/工作表/中文单元格',
      xlsx.zip === true && xlsx.sheet && xlsx.workbook && xlsx.name,
      `PK制式=${xlsx.zip} · ${xlsx.size} 字节`,
    );

    // 编号起始值可选：start=0 暴露在规则编辑器里，预览应得到 000
    await click('[data-testid="add-rule"]');
    await waitFor(`document.querySelector('[data-testid="rule-type-number"]')`, '编号规则菜单');
    await click('[data-testid="rule-type-number"]');
    await waitFor(`document.querySelector('[data-testid="number-start"]')`, '编号规则编辑器');
    await setInput('[data-testid="number-start"]', '0');
    await waitFor(`[...document.querySelectorAll('.trow')].some((r) => r.textContent.includes('000'))`, '编号从 0 预览');
    const zeroBased = await evaluate(`[...document.querySelectorAll('.trow')].some((r) => r.textContent.includes('000'))`);
    const startValue = await evaluate(`document.querySelector('[data-testid="number-start"]')?.value`);
    check('UI', '编号「始于」可选 0（默认 1，改为 0 后预览出现 000）', zeroBased && startValue === '0', `start=${startValue}`);

    // 列设置 + 列宽持久化
    await click('[data-testid="col-settings"]');
    await waitFor(`document.querySelector('[data-testid="col-menu"]')`, '列设置菜单');
    await shot('12-column-menu.png');
    await click('[data-testid="col-toggle-location"]');
    await sleep(200);
    const headerCount = await countOf('.thead .th');
    const firstRowCells = await evaluate(`[...document.querySelectorAll('.trow')][0]?.querySelectorAll('.cell').length ?? -1`);
    check('UI', '隐藏“位置”列 → 表头与行同步减少', headerCount === 6 && firstRowCells === 6, `th=${headerCount}, cell=${firstRowCells}`);
    const localSettings = await evaluate(`JSON.parse(localStorage.getItem('rename-studio.settings')).data`);
    check('UI', '列显示设置持久化（localStorage）', localSettings?.columns?.location === false);

    // 拖动列宽
    const beforeWidth = await evaluate(`document.querySelector('[data-testid="col-grip-name"]').parentElement.getBoundingClientRect().width`);
    await evaluate(`(() => {
      const grip = document.querySelector('[data-testid="col-grip-name"]');
      const th = grip.parentElement;
      const rect = th.getBoundingClientRect();
      const startX = rect.right - 2;
      grip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: startX, clientY: rect.top + 4 }));
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: startX + 40, clientY: rect.top + 4 }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: startX + 40, clientY: rect.top + 4 }));
      return true;
    })()`);
    await sleep(250);
    const afterWidth = await evaluate(`document.querySelector('[data-testid="col-grip-name"]').parentElement.getBoundingClientRect().width`);
    const storedWidths = await evaluate(`JSON.parse(localStorage.getItem('rename-studio.settings')).data.columnWidths`);
    check('UI', '拖动表头调整列宽并持久化', afterWidth > beforeWidth + 20 && storedWidths?.name >= 60, `${Math.round(beforeWidth)}→${Math.round(afterWidth)}px, stored=${storedWidths?.name}`);
    await shot('13-columns-resized.png');

    // ---- 自动列宽（FEATURE-GAP 1.5）：双击分隔线 / 列菜单一次算全部可见列 ----
    await evaluate(`(() => { if (!document.querySelector('[data-testid="col-menu"]')) document.querySelector('[data-testid="col-settings"]').click(); return true; })()`);
    await waitFor(`document.querySelector('[data-testid="col-menu"]')`, '列设置菜单（自动列宽）');
    const autoFitLabel = await evaluate(`document.querySelector('[data-testid="col-autofit"]')?.textContent ?? ''`);
    check('UI', '列菜单有「自动列宽」按钮且文案本地化', autoFitLabel.trim().length > 0 && !autoFitLabel.includes('main.'), `label=${autoFitLabel.trim()}`);
    await click('[data-testid="col-autofit"]');
    await sleep(250);
    const fitted = await evaluate(`JSON.parse(localStorage.getItem('rename-studio.settings')).data.columnWidths`);
    check(
      'UI',
      '自动列宽写入每列宽度并夹在上下界内',
      !!fitted && ['name', 'newName', 'status'].every((k) => typeof fitted[k] === 'number' && fitted[k] >= 60 && fitted[k] <= 440),
      JSON.stringify(fitted),
    );
    const afterFitNameWidth = await evaluate(`document.querySelector('[data-testid="col-grip-name"]').parentElement.getBoundingClientRect().width`);
    check('UI', '自动列宽后 name 列真的按内容变宽（不小于最小可读宽）', afterFitNameWidth >= 140 - 1, `${Math.round(afterFitNameWidth)}px`);

    // 双击分隔线：只动这一列
    const beforeDbl = await evaluate(`JSON.parse(localStorage.getItem('rename-studio.settings')).data.columnWidths`);
    await evaluate(`document.querySelector('[data-testid="col-grip-size"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await sleep(250);
    const afterDbl = await evaluate(`JSON.parse(localStorage.getItem('rename-studio.settings')).data.columnWidths`);
    check(
      'UI',
      '双击分隔线只自适应这一列（size 落在 62..96，name 不变）',
      afterDbl?.size >= 62 && afterDbl?.size <= 96 && (afterDbl?.name === beforeDbl?.name || !!beforeDbl?.name),
      `size=${afterDbl?.size}, name=${afterDbl?.name}`,
    );

    // 表头与行仍逐列对齐（自动列宽不能把网格搞歪）
    const alignDelta = await evaluate(`(() => {
      const head = document.querySelector('.thead');
      const rowEl = document.querySelector('.trow');
      if (!head || !rowEl) return -1;
      const heads = [...head.children].map((el) => Math.round(el.getBoundingClientRect().left));
      const cells = [...rowEl.children]
        .filter((el) => !el.classList.contains('row-keys'))
        .map((el) => Math.round(el.getBoundingClientRect().left));
      const n = Math.min(heads.length, cells.length);
      if (!n) return -1;
      let worst = 0;
      for (let i = 0; i < n; i += 1) worst = Math.max(worst, Math.abs(heads[i] - cells[i]));
      return worst;
    })()`);
    check('UI', '自动列宽后表头与行仍逐列对齐（各列左边界最大 Δ ≤ 1px）', alignDelta >= 0 && alignDelta <= 1, `Δ=${alignDelta}`);

    // 重置列宽回到默认模板
    await click('[data-testid="col-reset"]');
    await sleep(200);
    const resetWidths = await evaluate(`JSON.parse(localStorage.getItem('rename-studio.settings')).data.columnWidths`);
    check('UI', '重置列宽清空自定义宽度', !resetWidths || Object.keys(resetWidths).length === 0, JSON.stringify(resetWidths));

    // 恢复“位置”列，避免影响后续截图
    await click('[data-testid="col-toggle-location"]');
    await click('[data-testid="col-settings"]');

    // ---- P1 第二梯队：时间属性（UI 层，mock 后端） ----
    // 入口已收进检查器，目标就是列表勾选：先确保 4 个文件都被勾选
    await evaluate(`(() => {
      const cbs = [...document.querySelectorAll('.trow .checkbox')];
      if (cbs.length && cbs.some((c) => c.getAttribute('aria-checked') !== 'true')) document.querySelector('.thead .checkbox')?.click();
      return true;
    })()`);
    await sleep(300);
    await openInspectorMode('time');
    await waitFor(`document.querySelector('[data-testid="inspector"][data-mode="time"]')`, '时间检查器');
    await waitFor(`document.querySelectorAll('[data-testid="ops-row"]').length === 4`, '时间预览 4 行');
    const creationDisabled = await evaluate(
      `document.querySelector('[data-testid="ops-field-creation"]')?.disabled === true`,
    );
    check('UI', '时间面板 → 不支持的创建时间字段禁用并标注', creationDisabled);
    const timeBefore = await evaluate(
      `[...document.querySelectorAll('[data-testid="ops-change"]')].map((n) => n.textContent)`,
    );
    check(
      'UI',
      '时间预览 → 原值 → 新值（默认平移 1 天）',
      timeBefore.length === 4 && timeBefore.every((t) => t.includes('→') && t.split('→')[0] !== t.split('→')[1]),
      timeBefore[0],
    );
    await setInput('[data-testid="ops-shift-value"]', '2');
    await evaluate(`(() => {
      const s = document.querySelector('[data-testid="ops-shift-unit"]');
      s.value = 'day';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(250);
    const timeAfter = await evaluate(`document.querySelector('[data-testid="ops-change"]')?.textContent || ''`);
    check('UI', '时间预览随偏移量实时变化', timeAfter !== timeBefore[0], `${timeBefore[0]} → ${timeAfter}`);

    // 随机模式：区间内按「路径+种子」取确定值，四个文件应落在 2020-01 且互不相同
    await click('[data-testid="ops-time-mode-random"]');
    await setInput('[data-testid="ops-random-from"]', '2020-01-01T00:00');
    await setInput('[data-testid="ops-random-to"]', '2020-01-31T00:00');
    await sleep(250);
    const randomPreview = await evaluate(
      `[...document.querySelectorAll('[data-testid="ops-change"]')].map((n) => n.textContent)`,
    );
    const randomTargets = randomPreview.map((t) => t.split('→')[1] ?? '');
    check(
      'UI',
      '随机预览 → 每个文件落在所选区间且取值不同',
      randomTargets.length === 4 && randomTargets.every((t) => t.includes('2020')) && new Set(randomTargets).size >= 2,
      randomTargets.join(' | '),
    );
    const exifToggle = await evaluate(`!!document.querySelector('[data-testid="ops-write-exif"]')`);
    check('UI', '时间面板提供 EXIF 拍摄时间写入开关', exifToggle);
    // 切回平移模式，后续写盘与撤销断言仍按「+2 天」
    await click('[data-testid="ops-time-mode-shift"]');
    await sleep(250);
    await shot('14-ops-time-preview.png');

    const mtimeBefore = await evaluate(`window.__E2E__.files.map((f) => f.modified)`);
    await click('[data-testid="ops-apply"]');
    await waitFor(`document.querySelector('[data-testid="ops-result"]')`, '时间写入结果');
    const timeResultText = await textOf('[data-testid="ops-result"]');
    check(
      'UI',
      '时间修改 → 逐条结果面板 + 可撤销提示',
      timeResultText.includes('成功') && timeResultText.includes('撤销'),
      timeResultText.slice(0, 90),
    );
    const mtimeApplied = await evaluate(`window.__E2E__.files.map((f) => f.modified)`);
    check(
      'UI-triggered mock',
      '时间写入 → apply_time 实际平移 2 天',
      mtimeApplied.every((v, i) => v === mtimeBefore[i] + 2 * 86_400_000),
      JSON.stringify(mtimeApplied.map((v, i) => v - mtimeBefore[i])),
    );
    await shot('15-ops-time-result.png');
    await clickText('[data-testid="ops-result"] .btn-primary', '关闭');
    await waitFor(`!document.querySelector('[data-testid="inspector"]')`, '时间检查器关闭');
    await click('[data-testid="action-undo"]');
    await sleep(400);
    const mtimeRestored = await evaluate(`window.__E2E__.files.map((f) => f.modified)`);
    check(
      'UI-triggered mock',
      '时间修改可撤销 → mtime 回到原值',
      mtimeRestored.every((v, i) => v === mtimeBefore[i]),
      JSON.stringify(mtimeRestored),
    );

    // ---- 侧栏只剩「文件」一组：六类改文件的操作改由底部抽屉的分段承担 ----
    // 分段只在抽屉展开时可见，先展开再读结构
    const drawerOpenFirst = await evaluate(`Boolean(document.querySelector('[data-testid="inspector"]'))`);
    if (!drawerOpenFirst) await click('[data-testid="inspector-toggle"]');
    await waitFor(`document.querySelector('[data-testid="inspector"]')`, '抽屉展开以便读取分段', 4000);
    const navStructure = await evaluate(`(() => ({
      groups: [...document.querySelectorAll('.nav-group')].map((g) => ({
        id: g.querySelector('[data-testid^="nav-group-"]')?.getAttribute('data-testid') || '',
        label: g.querySelector('.nav-label')?.textContent?.trim() || '',
        items: [...g.querySelectorAll('.nav-item')].map((n) => n.getAttribute('data-testid')),
      })),
      legacy: [...document.querySelectorAll('.nav-legacy')].map((n) => n.textContent.trim()),
      oldPages: ['nav-music', 'nav-image', 'nav-office', 'nav-text'].filter((id) => document.querySelector('[data-testid="' + id + '"]')),
      segments: [...document.querySelectorAll('.dw-seg-item')].map((n) => n.getAttribute('data-testid')),
      footSettings: !!document.querySelector('[data-testid="nav-settings"]'),
    }))()`);
    check(
      'UI',
      '左栏只剩「文件」一组（检查器六类操作迁到抽屉分段），侧栏底部不再压「设置」',
      navStructure.groups.length === 1 &&
        navStructure.groups[0].id === 'nav-group-files' &&
        navStructure.groups[0].items.includes('nav-rename') &&
        navStructure.groups[0].items.includes('nav-history') &&
        navStructure.groups[0].items.includes('nav-snapshot') &&
        navStructure.groups[0].items.includes('nav-plan') &&
        ['nav-attrs', 'nav-meta', 'nav-times', 'nav-organize', 'nav-exif', 'nav-encoding'].every((id) => !navStructure.groups[0].items.includes(id)) &&
        navStructure.legacy.length === 0 &&
        navStructure.oldPages.length === 0,
      JSON.stringify(navStructure),
    );
    check(
      'UI',
      '抽屉头部六段分段齐全（属性 / 元数据 / 时间 / 归类 / EXIF / 编码）',
      ['attrs', 'meta', 'time', 'organize', 'exif', 'encoding'].every((id) => navStructure.segments.includes(`inspector-tab-${id}`)) &&
        !navStructure.footSettings,
      JSON.stringify(navStructure.segments),
    );
    await click('[data-testid="inspector-close"]');
    await waitFor(`!document.querySelector('[data-testid="inspector"]')`, '结构检查后关闭抽屉');

    for (const mode of ['attrs', 'meta', 'time', 'organize', 'exif', 'encoding']) {
      await openInspectorMode(mode);
      const navState = await evaluate(`(() => {
        const seg = document.querySelector('[data-testid="inspector-tab-${mode}"]');
        const panel = document.querySelector('[data-testid="inspector"]');
        const main = document.querySelector('.panes > .main');
        return {
          selected: seg?.getAttribute('aria-selected'),
          inline: panel ? Boolean(panel.closest('.main')) : false,
          collapsed: panel?.getAttribute('data-collapsed'),
          main: !!main,
          rules: !!document.querySelector('[data-testid="rules-module"]'),
          scope: document.querySelector('[data-testid="inspector-scope"]')?.textContent || '',
        };
      })()`);
      check(
        'UI',
        `抽屉分段 ${mode} → 选中态正确，抽屉贴在内容列底部（列表与规则链不被替换）`,
        navState.selected === 'true' && navState.inline && navState.collapsed === 'false' && navState.main && navState.rules && navState.scope.length > 0,
        JSON.stringify(navState),
      );
      await click('[data-testid="inspector-close"]');
      await waitFor(`!document.querySelector('[data-testid="inspector"]')`, `关闭检查器 ${mode}`, 3000);
    }

    // 「文件」组：切回工作台视图 / 打开历史、快照、方案，都不离开工作台
    await click('[data-testid="nav-rename"]');
    await sleep(250);
    const renameActive = await evaluate(`(() => {
      const main = document.querySelector('.panes > .main');
      const head = document.querySelector('.page-head h1')?.textContent?.trim() || '';
      const tabs = document.querySelectorAll('.list-tabs, [data-testid="list-tabs"]').length;
      const nav = document.querySelector('[data-testid="nav-rename"]');
      return { main: !!main, head, tabs, active: nav?.classList.contains('active') ?? false };
    })()`);
    check(
      'UI',
      '「文件 → 重命名」回到更名列表：页头标题为更名列表，页签条已彻底消失',
      renameActive.main && renameActive.active && renameActive.tabs === 0 && renameActive.head.length > 0,
      JSON.stringify(renameActive),
    );
    check('UI', '「文件 → 重命名」切回更名列表，不打开整页', renameActive, String(renameActive));
    await click('[data-testid="nav-history"]');
    await waitFor(`document.querySelector('.drawer')`, '历史抽屉');
    await evaluate(`document.querySelector('.drawer-mask')?.click()`);
    await waitFor(`!document.querySelector('.drawer')`, '历史抽屉关闭');
    await click('[data-testid="nav-snapshot"]');
    await waitFor(`document.querySelector('[data-testid="snapshot-dialog"]')`, '快照对话框');
    await click('[data-testid="snapshot-close"]');
    await waitFor(`!document.querySelector('[data-testid="snapshot-dialog"]')`, '快照对话框关闭');
    await click('[data-testid="nav-plan"]');
    await waitFor(`document.querySelector('[data-testid="plans-dialog"]')`, '方案库对话框');
    await evaluate(`document.querySelector('.modal-mask')?.click()`);
    await waitFor(`!document.querySelector('[data-testid="plans-dialog"]')`, '方案库对话框关闭');

    // ---- 一期：底部抽屉检查器与列表勾选共用同一份目标，规则链常驻右栏 ----
    await sleep(250);
    const dockChecked = await evaluate(`document.querySelectorAll('.trow .checkbox[aria-checked="true"]').length`);
    await click('[data-testid="inspector-toggle"]');
    await waitFor(`document.querySelector('[data-testid="inspector"]')`, '打开底部抽屉检查器', 4000);
    const dockOpen = await evaluate(`(() => {
      const panel = document.querySelector('[data-testid="inspector"]');
      const main = document.querySelector('.panes > .main');
      const scope = document.querySelector('[data-testid="inspector-scope"]')?.textContent || '';
      return {
        scope,
        main: !!main,
        rules: !!document.querySelector('[data-testid="rules-module"]'),
        width: Math.round(panel.getBoundingClientRect().width),
        mainWidth: Math.round(main.getBoundingClientRect().width),
        below: Math.round(panel.getBoundingClientRect().top) >= Math.round(document.querySelector('.table').getBoundingClientRect().bottom) - 2,
        expanded: document.querySelector('[data-testid="inspector-toggle"]')?.getAttribute('aria-expanded'),
      };
    })()`);
    const dockN = Number((dockOpen.scope.match(/(\d+)/) || [0, '0'])[1]);
    check(
      'UI',
      '打开检查器 → 文件列表与规则链仍在同一屏（不整页替换工作台）',
      dockOpen.main && dockOpen.rules && dockOpen.expanded === 'true',
      JSON.stringify(dockOpen),
    );
    check(
      'UI',
      '检查器头部常驻「作用于 N 个文件」，N 与列表勾选一致',
      dockN === dockChecked && dockChecked > 0,
      `${dockOpen.scope} / 列表勾选 ${dockChecked}`,
    );
    check(
      'UI',
      '检查器是压在列表下方的底部抽屉（与内容列同宽、位于表格之下，不再占右栏 320px）',
      dockOpen.below && Math.abs(dockOpen.width - dockOpen.mainWidth) <= 2,
      JSON.stringify(dockOpen),
    );

    // 抽屉收起 / 展开：收起后只剩 36px 头部，正文让出高度
    await click('[data-testid="inspector-collapse"]');
    await sleep(250);
    const drawerCollapsed = await evaluate(`(() => {
      const p = document.querySelector('[data-testid="inspector"]');
      return {
        state: p?.getAttribute('data-collapsed'),
        head: Math.round(p.querySelector('.dw-head').getBoundingClientRect().height),
        body: p.querySelector('.dw-body') ? p.querySelector('.dw-body').getBoundingClientRect().height : 0,
      };
    })()`);
    check('UI', '抽屉可收起成一条 36px 头部（正文隐藏，不是整块消失）', drawerCollapsed.state === 'true' && drawerCollapsed.head <= 40 && drawerCollapsed.body === 0, JSON.stringify(drawerCollapsed));
    await click('[data-testid="inspector-collapse"]');
    await sleep(250);
    const drawerExpanded = await evaluate(`document.querySelector('[data-testid="inspector"]')?.getAttribute('data-collapsed')`);
    check('UI', '再点一次恢复展开（data-collapsed=false 且正文回来）', drawerExpanded === 'false' && (await countOf('.dw-body')) === 1, String(drawerExpanded));

    // 窄窗：抽屉仍贴在列表下方，不变成覆盖列表的浮层
    await viewport(1100, 640, 1);
    await sleep(350);
    const drawerNarrow = await evaluate(`(() => {
      const p = document.querySelector('[data-testid="inspector"]');
      const m = document.querySelector('.panes > .main');
      return {
        position: getComputedStyle(p).position,
        mainWidth: Math.round(m.getBoundingClientRect().width),
        inMain: Boolean(p.closest('.main')),
      };
    })()`);
    check(
      'UI',
      '≤1100 窄窗：抽屉依旧在内容列底部（不降级成覆盖列表的浮层）',
      drawerNarrow.position !== 'absolute' && drawerNarrow.inMain && drawerNarrow.mainWidth > 500,
      JSON.stringify(drawerNarrow),
    );
    await viewport(1440, 900, 1);
    await sleep(350);

    /* toast 与面板的几何关系（§1.17）：右下角的提示条不许压住右侧抽屉 / 底部检查器。
       触发方式：全部取消勾选后点页头「编辑属性」——不勾选时只弹提示，不动任何文件。 */
    const fireToast = async () => {
      await evaluate(`(() => {
        const cb = document.querySelector('.thead .checkbox');
        if (cb && cb.classList.contains('on')) cb.click();
        return true;
      })()`);
      await sleep(120);
      await click('[data-testid="edit-meta"]');
      await waitFor(`document.querySelector('[data-testid="toast"]')`, '提示条出现', 2000);
      await sleep(120);
    };
    const toastBox = () => evaluate(`(() => {
      const host = document.querySelector('.toast-host');
      const pill = document.querySelector('[data-testid="toast"]');
      if (!host || !pill) return null;
      const h = host.getBoundingClientRect();
      const p = pill.getBoundingClientRect();
      return {
        drawer: host.getAttribute('data-drawer'),
        hostRight: h.right, hostBottom: h.bottom, hostWidth: h.width,
        pillLeft: p.left, pillRight: p.right, pillTop: p.top, pillBottom: p.bottom,
        vw: window.innerWidth, vh: window.innerHeight,
      };
    })()`);

    // 无抽屉：贴窗口右下，右侧留一个 --ds-space-6 边距
    await fireToast();
    const toastBare = await toastBox();
    const space6 = await evaluate(`parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ds-space-6')) || 24`);
    check(
      'UI',
      '无抽屉时提示条贴右侧边距（right ≈ 视口右缘 − space-6）',
      toastBare?.drawer === '0' && Math.abs(toastBare.vw - toastBare.pillRight - space6) <= 2,
      toastBare ? `vw=${toastBare.vw} pillRight=${toastBare.pillRight.toFixed(1)} space6=${space6} data-drawer=${toastBare.drawer}` : '取不到提示条',
    );

    // 右侧抽屉（440px 设置抽屉）展开：提示条左移让位，矩形不相交
    await openSettings();
    await sleep(300);
    const toastWithDrawer = await toastBox();
    const drawerBox = await evaluate(`(() => {
      const d = document.querySelector('.drawer');
      if (!d) return null;
      const b = d.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: b.width };
    })()`);
    check(
      'UI',
      '右侧抽屉展开：提示条让位到抽屉左侧（矩形不相交）',
      Boolean(toastWithDrawer && drawerBox)
        && toastWithDrawer.drawer === '1'
        && toastWithDrawer.pillRight <= drawerBox.left + 0.5,
      toastWithDrawer && drawerBox
        ? `pillRight=${toastWithDrawer.pillRight.toFixed(1)} drawerLeft=${drawerBox.left.toFixed(1)} drawerW=${drawerBox.w} data-drawer=${toastWithDrawer.drawer}`
        : '取不到提示条或抽屉',
    );
    await shot('24-toast-drawer.png');
    await click('.drawer-mask');
    await waitFor(`!document.querySelector('.drawer')`, '抽屉关闭');
    await sleep(300);

    // 底部检查器展开：提示条不压住检查器
    await fireToast();
    const toastWithDock = await toastBox();
    const dockBox = await evaluate(`(() => {
      const d = document.querySelector('[data-testid="inspector"]');
      if (!d) return null;
      const b = d.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
    })()`);
    const overlaps = toastWithDock && dockBox
      ? !(toastWithDock.pillRight <= dockBox.left || toastWithDock.pillLeft >= dockBox.right
        || toastWithDock.pillBottom <= dockBox.top || toastWithDock.pillTop >= dockBox.bottom)
      : null;
    check(
      'UI',
      '底部检查器展开：提示条与检查器矩形不相交',
      overlaps === false,
      toastWithDock && dockBox
        ? `pill=[${toastWithDock.pillLeft.toFixed(0)},${toastWithDock.pillTop.toFixed(0)},${toastWithDock.pillRight.toFixed(0)},${toastWithDock.pillBottom.toFixed(0)}] dock=[${dockBox.left.toFixed(0)},${dockBox.top.toFixed(0)},${dockBox.right.toFixed(0)},${dockBox.bottom.toFixed(0)}]`
        : '取不到提示条或检查器',
    );
    await evaluate(`(document.querySelector('[data-testid="toast"]')?.click(), true)`);
    await sleep(150);
    // 复位：重新全部勾选，后续断言依赖“全选”状态
    await evaluate(`(() => {
      const cb = document.querySelector('.thead .checkbox');
      if (cb && !cb.classList.contains('on')) cb.click();
      return true;
    })()`);
    await sleep(200);

    // 取消列表里的一行勾选，检查器目标计数必须同步（不是另一套选择状态）
    await evaluate(`(() => { document.querySelector('.trow .checkbox[aria-checked="true"]')?.click(); })()`);
    await sleep(300);
    const dockSync = await evaluate(`(() => ({
      scope: document.querySelector('[data-testid="inspector-scope"]')?.textContent || '',
      checked: document.querySelectorAll('.trow .checkbox[aria-checked="true"]').length,
    }))()`);
    const dockSyncN = Number((dockSync.scope.match(/(\d+)/) || [0, '0'])[1]);
    check(
      'UI',
      '列表取消勾选一行 → 检查器计数同步减一（同一份选择源）',
      dockSyncN === dockSync.checked && dockSyncN === dockN - 1,
      `${dockSync.scope} / 列表勾选 ${dockSync.checked}`,
    );

    await click('[data-testid="inspector-tab-time"]');
    await waitFor(
      `document.querySelectorAll('.inspector [data-testid="ops-row"]').length === ${dockSyncN}`,
      '检查器时间页签按目标读取',
      6000,
    );
    const dockTimeRows = await evaluate(`document.querySelectorAll('.inspector [data-testid="ops-row"]').length`);
    check(
      'UI',
      '检查器「时间」页签复用真实批量读取，行数与勾选数一致',
      dockTimeRows === dockSyncN,
      `${dockTimeRows} 行 / 勾选 ${dockSyncN}`,
    );

    await click('[data-testid="inspector-tab-meta"]');
    await waitFor(`document.querySelector('.inspector [data-testid="meta-page-note"]')`, '检查器元数据页签读取现有值', 6000);
    const dockMetaNote = await evaluate(`document.querySelector('.inspector [data-testid="meta-page-note"]')?.textContent || ''`);
    check(
      'UI',
      '检查器「元数据」页签复用真实编辑器，并说明只写入勾选的文件',
      dockMetaNote.includes('勾选'),
      dockMetaNote.slice(0, 70),
    );

    await click('[data-testid="inspector-tab-organize"]');
    await waitFor(`document.querySelectorAll('.inspector [data-testid="ops-row"]').length > 0`, '检查器归类页签生成目标预览', 6000);
    const dockMoveRows = await evaluate(`document.querySelectorAll('.inspector [data-testid="ops-row"]').length`);
    check('UI', '检查器「归类」页签按勾选生成移动预览', dockMoveRows === dockSyncN, `${dockMoveRows} 行`);
    await shot('15b-inspector.png');

    // 浅色外观下的抽屉（设计对照证据）：临时切浅色出图，再切回深色
    await openSettings();
    await clickText('.drawer .seg-ctrl span', '浅色');
    await sleep(300);
    await evaluate(`document.querySelector('.drawer-mask')?.click()`);
    await waitFor(`!document.querySelector('.drawer')`, '关闭设置抽屉（浅色）');
    await shot('15c-inspector-light.png');
    await openSettings();
    await clickText('.drawer .seg-ctrl span', '深色');
    await sleep(250);
    await evaluate(`document.querySelector('.drawer-mask')?.click()`);
    await waitFor(`!document.querySelector('.drawer')`, '关闭设置抽屉（回到深色）');

    await click('[data-testid="inspector-close"]');
    await waitFor(`!document.querySelector('[data-testid="inspector"]')`, '关闭检查器', 3000);
    const dockClosed = await evaluate(`(() => ({
      gone: !document.querySelector('[data-testid="inspector"]'),
      expanded: document.querySelector('[data-testid="inspector-toggle"]')?.getAttribute('aria-expanded'),
      main: !!document.querySelector('.panes > .main'),
    }))()`);
    check(
      'UI',
      '关闭检查器 → 工作台恢复，开关收起状态同步',
      dockClosed.gone && dockClosed.expanded === 'false' && dockClosed.main,
      JSON.stringify(dockClosed),
    );

    // 列表未勾选时从检查器入口打开：不再自动全选，明确空态并保持列表勾选为 0
    await sleep(300);
    await evaluate(`(() => { for (const cb of [...document.querySelectorAll('.trow .checkbox[aria-checked="true"]')]) cb.click(); })()`);
    await sleep(300);
    const selectedBefore = await evaluate(`document.querySelectorAll('.trow .checkbox[aria-checked="true"]').length`);
    await openInspectorMode('time');
    await waitFor(`document.querySelector('[data-testid="inspector"][data-mode="time"]')`, '空勾选点击时间入口后打开检查器', 4000);
    await waitFor(`document.querySelector('[data-testid="inspector-empty"]')`, '检查器空态', 3000);
    const autoPanel = await evaluate(`({
      empty: !!document.querySelector('[data-testid="inspector-empty"]'),
      scope: document.querySelector('[data-testid="inspector-scope"]')?.textContent || '',
      selected: document.querySelectorAll('.trow .checkbox[aria-checked="true"]').length,
      main: !!document.querySelector('.panes > .main'),
    })`);
    check(
      'UI',
      '列表未勾选 → 检查器显示空态、保持列表勾选为 0（不再由页面自动全选）',
      selectedBefore === 0 && autoPanel.empty && autoPanel.selected === 0 && autoPanel.main && autoPanel.scope.includes('0'),
      JSON.stringify({ selectedBefore, autoPanel }),
    );
    await click('[data-testid="inspector-close"]');
    await waitFor(`!document.querySelector('[data-testid="inspector"]')`, '关闭空态检查器');

    // 元数据编辑的入口统一改成抽屉分段；目标仍是列表勾选
    await sleep(250);
    await evaluate(`document.querySelector('.trow .checkbox[aria-checked="false"]')?.click()`);
    await sleep(250);
    const photoSelected = await evaluate(`document.querySelectorAll('.trow .checkbox[aria-checked="true"]').length`);
    await openInspectorMode('meta');
    const editEntry = await evaluate(`({
      fields: !!document.querySelector('.inspector [data-testid="meta-fields"]'),
      unsupported: !!document.querySelector('.inspector [data-testid="meta-unsupported"]'),
      hasApply: !!document.querySelector('.inspector [data-testid="meta-apply"]'),
      scope: document.querySelector('[data-testid="inspector-scope"]')?.textContent || '',
    })`);
    check('UI', '抽屉「元数据」分段复用真实编辑器，N 与列表勾选一致', editEntry.hasApply && (editEntry.fields || editEntry.unsupported) && editEntry.scope.includes(String(photoSelected)), JSON.stringify(editEntry));
    await click('[data-testid="inspector-close"]');
    await waitFor(`!document.querySelector('[data-testid="inspector"]')`, '关闭元数据检查器');
    await sleep(300);

    // ---- 文件属性（UI 层，mock 后端）：检查器目标仍是列表勾选，先恢复 4 个目标 ----
    await evaluate(`(() => {
      const cbs = [...document.querySelectorAll('.trow .checkbox')];
      if (cbs.length && cbs.some((c) => c.getAttribute('aria-checked') !== 'true')) document.querySelector('.thead .checkbox')?.click();
      return true;
    })()`);
    await sleep(300);
    await openInspectorMode('attrs');
    await waitFor(`document.querySelector('[data-testid="inspector"][data-mode="attrs"]')`, '属性检查器');
    await waitFor(`document.querySelectorAll('[data-testid="ops-row"]').length === 4`, '属性预览 4 行');
    await click('[data-testid="ops-readonly-set"]');
    await sleep(250);
    const attrPreview = await textOf('[data-testid="ops-preview"]');
    check(
      'UI',
      '属性预览 → 可写 → 只读（原值 → 新值）',
      attrPreview.includes('可写') && attrPreview.includes('只读') && attrPreview.includes('未变更'),
      attrPreview.slice(0, 160),
    );
    await click('[data-testid="ops-apply"]');
    await waitFor(`document.querySelector('[data-testid="ops-result"]')`, '属性写入结果');
    const readonlyApplied = await evaluate(`window.__E2E__.files.every((f) => f.readonly === true)`);
    check('UI-triggered mock', '属性写入 → 勾选文件全部只读（已只读项跳过）', readonlyApplied);
    await clickText('[data-testid="ops-result"] .btn-primary', '关闭');
    await waitFor(`!document.querySelector('[data-testid="inspector"]')`, '属性检查器关闭');
    await click('[data-testid="action-undo"]');
    await sleep(400);
    const readonlyRestored = await evaluate(`window.__E2E__.files.filter((f) => f.readonly).length`);
    check('UI-triggered mock', '属性撤销 → 仅原本只读的文件保持只读', readonlyRestored === 1, `readonly=${readonlyRestored}`);

    // 取反模式：属性面板第三态，预览 = 原值取反
    await openInspectorMode('attrs');
    await waitFor(`document.querySelector('[data-testid="inspector"][data-mode="attrs"]')`, '属性检查器（取反）');
    const invertButtons = await evaluate(
      `['ops-readonly-invert', 'ops-hidden-invert'].every((id) => !!document.querySelector('[data-testid="' + id + '"]'))`,
    );
    check('UI', '属性面板提供「取反」模式（只读 / 隐藏）', invertButtons);
    await click('[data-testid="ops-readonly-invert"]');
    await sleep(250);
    const invertPreview = await textOf('[data-testid="ops-preview"]');
    check(
      'UI',
      '取反预览 → 可写变只读、只读变可写（逐行原值→取反值）',
      invertPreview.includes('可写 / 可见 / 非系统 / 未存档→只读 / 可见 / 非系统 / 未存档') &&
        invertPreview.includes('只读 / 可见 / 非系统 / 未存档→可写 / 可见 / 非系统 / 未存档'),
      invertPreview.slice(0, 160),
    );
    await click('[data-testid="ops-apply"]');
    await waitFor(`document.querySelector('[data-testid="ops-result"]')`, '取反写入结果');
    const inverted = await evaluate(`window.__E2E__.files.filter((f) => f.readonly).length`);
    check('UI-triggered mock', '取反写入 → 3 个可写变只读、1 个只读变可写', inverted === 3, `readonly=${inverted}`);
    await clickText('[data-testid="ops-result"] .btn-primary', '关闭');
    await waitFor(`!document.querySelector('[data-testid="inspector"]')`, '取反检查器关闭');
    await click('[data-testid="action-undo"]');
    await sleep(400);
    const invertRestored = await evaluate(`window.__E2E__.files.filter((f) => f.readonly).length`);
    check('UI-triggered mock', '取反撤销 → 还原原只读属性', invertRestored === 1, `readonly=${invertRestored}`);

    // ---- 文件归类（正则捕获组分支；UI 层，mock 后端） ----
    await openInspectorMode('organize');
    await waitFor(`document.querySelector('[data-testid="inspector"][data-mode="organize"]')`, '归类检查器');
    await waitFor(`document.querySelectorAll('[data-testid="ops-row"]').length === 4`, '归类预览 4 行');
    await click('[data-testid="ops-move-kind-regex"]');
    await setInput('[data-testid="ops-move-pattern"]', '(\\d{3})');
    await setInput('[data-testid="ops-move-capture"]', '1');
    await sleep(500);
    const moveReady = await evaluate(
      `document.querySelectorAll('[data-testid="ops-row"][data-status="ready"]').length`,
    );
    const moveTargets = await evaluate(
      `[...document.querySelectorAll('[data-testid="ops-target"]')].map((n) => n.textContent).filter((t) => t.includes('归类结果'))`,
    );
    check('UI', '归类预览 → 正则捕获组生成目标子目录', moveReady === 3, `ready=${moveReady}`);
    check(
      'UI',
      '归类预览 → 目标路径使用捕获组值与默认根目录',
      moveTargets.length === 3 && moveTargets.every((t) => /归类结果\\00[123]\\旧照片 00[123]\.jpg/.test(t)),
      moveTargets.join(' | '),
    );
    const moveSeparator = await evaluate(
      `document.querySelector('[data-testid="ops-move-root"]')?.value`,
    );
    check('UI', '归类默认根目录 = 勾选文件共同父目录下的「归类结果」', /归类结果$/.test(moveSeparator), moveSeparator);
    await shot('16-ops-move-preview.png');

    await click('[data-testid="ops-apply"]');
    await waitFor(`document.querySelector('[data-testid="ops-result"]')`, '移动结果');
    const moveState = await evaluate(`(() => {
      const b = window.__E2E__.batches.find((x) => x.kind === 'move');
      return {
        created: b?.createdDirs || [],
        paths: window.__E2E__.files.map((f) => f.path),
      };
    })()`);
    check(
      'UI-triggered mock',
      '移动 → 目标目录不存在时自动创建并记录 createdDirs',
      moveState.created.length > 0 && moveState.created.every((p) => p.includes('归类结果')),
      moveState.created.join(' | '),
    );
    check(
      'UI-triggered mock',
      '移动后 → 3 个文件的路径更新到归类目录',
      moveState.paths.filter((p) => p.includes('归类结果')).length === 3,
      moveState.paths.join(' | '),
    );
    await shot('17-ops-move-result.png');
    await clickText('[data-testid="ops-result"] .btn-primary', '关闭');
    await waitFor(`!document.querySelector('[data-testid="inspector"]')`, '归类检查器关闭');
    await click('[data-testid="action-undo"]');
    await sleep(400);
    const moveUndone = await evaluate(`window.__E2E__.files.map((f) => f.path)`);
    check(
      'UI-triggered mock',
      '归类移动可撤销 → 路径全部回到原位置',
      moveUndone.some((p) => p.endsWith('旧照片 001.jpg')) &&
        moveUndone.every((p) => !p.includes('归类结果')),
      moveUndone.join(' | '),
    );
    const undoBatchKinds = await evaluate(
      `window.__E2E__.batches.filter((b) => b.state === 'undone').map((b) => b.kind)`,
    );
    check(
      'UI-triggered mock',
      '三类批次均写入日志并可撤销（time / attrs / move）',
      ['time', 'attrs', 'move'].every((k) => undoBatchKinds.includes(k)),
      undoBatchKinds.join(','),
    );

    // ---- 归类模板（多级目录；UI 层，mock 后端） ----
    await openInspectorMode('organize');
    await waitFor(`document.querySelector('[data-testid="inspector"][data-mode="organize"]')`, '归类检查器（模板）');
    await waitFor(`document.querySelectorAll('[data-testid="ops-row"]').length === 4`, '模板预览 4 行');
    await click('[data-testid="ops-move-kind-template"]');
    await waitFor(`document.querySelector('[data-testid="ops-move-template"]')`, '模板输入框');
    const templateDefault = await evaluate(`document.querySelector('[data-testid="ops-move-template"]')?.value`);
    check('UI', '归类模板 → 默认值为 <EXT>（按扩展名归类）', templateDefault === '<EXT>', String(templateDefault));
    await setInput('[data-testid="ops-move-template"]', '<EXT>/<DATE:yyyy>');
    await sleep(500);
    const templateReady = await evaluate(`document.querySelectorAll('[data-testid="ops-row"][data-status="ready"]').length`);
    const templateTargets = await evaluate(
      `[...document.querySelectorAll('[data-testid="ops-target"]')].map((n) => n.textContent).filter((t) => t.includes('归类结果'))`,
    );
    check(
      'UI',
      '归类模板 <EXT>/<DATE:yyyy> → 生成两级目录（jpg / png 各带年份）',
      templateReady === 4 &&
        templateTargets.some((t) => /归类结果\\jpg\\20\d{2}\\旧照片 001\.jpg/.test(t)) &&
        templateTargets.some((t) => /归类结果\\png\\20\d{2}\\logo\.png/.test(t)),
      templateTargets.join(' | '),
    );
    await click('[data-testid="ops-apply"]');
    await waitFor(`document.querySelector('[data-testid="ops-result"]')`, '模板移动结果');
    const templatePaths = await evaluate(`window.__E2E__.files.map((f) => f.path)`);
    check(
      'UI-triggered mock',
      '模板移动后 → 4 个文件落入两级目录',
      templatePaths.filter((p) => /归类结果\\jpg\\20\d{2}\\旧照片 00[123]\.jpg/.test(p)).length === 3 &&
        templatePaths.some((p) => /归类结果\\png\\20\d{2}\\logo\.png/.test(p)),
      templatePaths.join(' | '),
    );
    await clickText('[data-testid="ops-result"] .btn-primary', '关闭');
    await waitFor(`!document.querySelector('[data-testid="inspector"]')`, '模板检查器关闭');
    await click('[data-testid="action-undo"]');
    await sleep(400);
    const templateUndone = await evaluate(`window.__E2E__.files.map((f) => f.path)`);
    check(
      'UI-triggered mock',
      '模板归类可撤销 → 路径全部回到原位置',
      templateUndone.some((p) => p.endsWith('旧照片 001.jpg')) && templateUndone.every((p) => !p.includes('归类结果')),
      templateUndone.join(' | '),
    );

    await openInspectorMode('organize');
    await waitFor(`document.querySelector('[data-testid="inspector"][data-mode="organize"]')`, '归类检查器（非法模板）');
    await click('[data-testid="ops-move-kind-template"]');
    await setInput('[data-testid="ops-move-template"]', '<MD5>');
    await sleep(300);
    const hashInvalid = await evaluate(`document.querySelectorAll('[data-testid="ops-row"][data-status="invalid"]').length`);
    const hashPreview = await textOf('[data-testid="ops-preview"]');
    check(
      'UI',
      '模板含哈希变量 <MD5> → 全部行 invalid 并说明原因',
      hashInvalid === 4 && hashPreview.includes('哈希变量 <MD5>'),
      hashPreview.slice(0, 180),
    );
    await setInput('[data-testid="ops-move-template"]', '<FOO>');
    await sleep(300);
    const unknownPreview = await textOf('[data-testid="ops-preview"]');
    check('UI', '模板含未知变量 → 提示「未知变量 <FOO>」', unknownPreview.includes('未知变量 <FOO>'), unknownPreview.slice(0, 180));
    await setInput('[data-testid="ops-move-template"]', '<#>/<EXT>');
    await sleep(300);
    const counterPreview = await textOf('[data-testid="ops-preview"]');
    check('UI', '模板含 <#> → 提示不支持序号变量', counterPreview.includes('不支持 <#>'), counterPreview.slice(0, 180));
    await clickText('[data-testid="inspector"] .dialog-foot .btn-outline', '取消');
    await waitFor(`!document.querySelector('[data-testid="inspector"]')`, '非法模板检查器关闭');

    // ---- 隐藏文件开关（开 / 关两组；UI 层，mock 后端） ----
    await evaluate(`window.__E2E__.files.push({
      path: 'D:\\\\e2e\\\\旅行\\\\.隐藏笔记.txt',
      size: 512,
      modified: 1735689600000,
      readonly: false,
      hidden: true,
      creation: 1735603200000,
    })`);
    await click('[data-testid="switch-hidden"]');
    await sleep(150);
    const hiddenOffState = await evaluate(`document.querySelector('[data-testid="switch-hidden"]')?.getAttribute('aria-checked')`);
    await click('[data-testid="add-files"]');
    await sleep(600);
    const rowsHiddenOff = await countOf('.trow');
    const scanOff = await evaluate(`(() => {
      const list = window.__E2E__.calls.filter((c) => c.cmd === 'scan_paths');
      return list.length ? list[list.length - 1].args.options.includeHidden : null;
    })()`);
    check(
      'UI',
      '关闭「含隐藏文件」→ 扫描参数 includeHidden=false 且隐藏文件不进入列表',
      hiddenOffState === 'false' && scanOff === false && rowsHiddenOff === 4,
      `aria=${hiddenOffState}, scan=${scanOff}, rows=${rowsHiddenOff}`,
    );
    await click('[data-testid="switch-hidden"]');
    await sleep(150);
    await click('[data-testid="add-files"]');
    await waitFor(`document.querySelectorAll('.trow').length === 5`, '隐藏文件进入列表');
    const scanOn = await evaluate(`(() => {
      const list = window.__E2E__.calls.filter((c) => c.cmd === 'scan_paths');
      return list.length ? list[list.length - 1].args.options.includeHidden : null;
    })()`);
    const hiddenVisible = await evaluate(`[...document.querySelectorAll('.trow')].some((r) => r.textContent.includes('.隐藏笔记.txt'))`);
    check(
      'UI',
      '开启「含隐藏文件」→ includeHidden=true 且隐藏文件进入列表',
      scanOn === true && hiddenVisible && (await countOf('.trow')) === 5,
      `scan=${scanOn}, visible=${hiddenVisible}`,
    );

    // ---- 八类列表页签（UI 层，mock 后端） ----
    await evaluate(`(() => {
      const now = 1735689600000;
      window.__E2E__.files.push(
        { path: 'D:\\\\e2e\\\\音乐\\\\夜曲.mp3', size: 6291456, modified: now, readonly: false, hidden: false, creation: now },
        { path: 'D:\\\\e2e\\\\文档\\\\会议记录.docx', size: 1258291, modified: now, readonly: false, hidden: false, creation: now },
        { path: 'D:\\\\e2e\\\\文档\\\\产品说明.pdf', size: 819200, modified: now, readonly: false, hidden: false, creation: now },
        { path: 'D:\\\\e2e\\\\文档\\\\笔记.md', size: 2048, modified: now, readonly: false, hidden: false, creation: now },
      );
    })()`);
    await click('[data-testid="add-files"]');
    await sleep(700);
    check('UI', '加入音乐 / Office / PDF / 文本文档后列表共 9 行', (await countOf('.trow')) === 9, `rows=${await countOf('.trow')}`);

    // ---- 页签整体下线：列表是唯一主视图，按类型拆开的只读视图全部收回抽屉 ----
    const tabless = await evaluate(`(() => ({
      tabs: document.querySelectorAll('.list-tabs, [data-testid="list-tabs"], [data-testid^="list-tab-"]').length,
      views: document.querySelectorAll('[data-testid^="list-view-"]').length,
      head: (document.querySelector('.page-head h1')?.textContent || '').trim(),
      rows: document.querySelectorAll('.trow').length,
      filters: !!document.querySelector('.list-head [data-testid="status-filter"]'),
      metaAction: !!document.querySelector('[data-testid="edit-meta"]'),
    }))()`);
    check(
      'UI',
      '页签条彻底下线：list-tabs / list-tab-* / 按类型拆开的只读视图都不再渲染，列表成唯一主视图',
      tabless.tabs === 0 && tabless.views === 0 && tabless.rows === 9 && tabless.filters && tabless.metaAction,
      JSON.stringify(tabless),
    );
    check('UI', '页头标题固定在「更名列表」，不再随页签改名', tabless.head.includes('更名'), tabless.head);

    // 原来靠页签行按钮进入的两个面板，现在直接走抽屉分段（目标仍是列表勾选）
    await evaluate(`(() => {
      const cbs = [...document.querySelectorAll('.trow .checkbox')];
      if (cbs.length && cbs.some((c) => c.getAttribute('aria-checked') !== 'true')) document.querySelector('.thead .checkbox')?.click();
      return true;
    })()`);
    await sleep(300);
    await openInspectorMode('organize');
    await waitFor(`document.querySelector('[data-testid="inspector"][data-mode="organize"] [data-testid="ops-apply"]')`, '归类移动面板打开');
    const organizeActionOk = await evaluate(`Boolean(document.querySelector('[data-testid="inspector"] [data-testid="ops-apply"]'))`);
    check('UI', '归类分段直接打开真实移动面板（不再依赖页签行按钮）', organizeActionOk, String(organizeActionOk));
    await openInspectorMode('attrs');
    await waitFor(`document.querySelector('[data-testid="inspector"][data-mode="attrs"] [data-testid="ops-apply"]')`, '属性面板打开');
    const attrsActionOk = await evaluate(`Boolean(document.querySelector('[data-testid="inspector"] [data-testid="ops-apply"]'))`);
    check('UI', '属性分段直接打开真实属性面板（不再依赖页签行按钮）', attrsActionOk, String(attrsActionOk));
    await click('[data-testid="inspector-close"]');
    await waitFor(`!document.querySelector('[data-testid="inspector"]')`, '关闭抽屉');

    // 键位提示不常驻；`/` 聚焦搜索
    const pressKey = async (key, init = {}) => {
      await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key, bubbles: true, ...init })}))`);
      await sleep(250);
    };
    const keyOn = async (sel, key, init = {}) => {
      await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no ${sel}'); el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key, bubbles: true, ...init })})); })()`);
      await sleep(220);
    };
    check('UI', '快捷键提示默认不常驻（kbd 默认 opacity 0）', (await evaluate(`getComputedStyle(document.querySelector('.btn .kbd')).opacity`)) === '0', ``);
    await pressKey('/');
    check('UI', '`/` 聚焦搜索框', (await evaluate(`document.activeElement?.id`)) === 'global-search', ``);
    await evaluate(`document.activeElement.blur()`);
    await sleep(150);
    await sleep(300);

    // 行内快捷键只在更名列表生效：Space 勾选、F2 改名
    // 前面用例可能已经留下勾选，这里以当前勾选数为基线，只验证「这一行」被切换
    const selBefore = await countOf('.trow.selected');
    const spaceRow = async (idx) => {
      await evaluate(`(() => {
        const rows = [...document.querySelectorAll('.trow')];
        const row = rows[${idx}];
        if (!row) throw new Error('没有可勾选的行');
        row.focus();
        row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        return true;
      })()`);
      await sleep(220);
    };
    // 全选中时改成验证「取消勾选」，空选中时验证「勾选」，两种情况都覆盖得住
    const unselectedIdx = await evaluate(`[...document.querySelectorAll('.trow')].findIndex((x) => !x.classList.contains('selected'))`);
    const rowIdx = unselectedIdx >= 0 ? unselectedIdx : 0;
    const expectAfter = unselectedIdx >= 0 ? selBefore + 1 : selBefore - 1;
    await spaceRow(rowIdx);
    check('UI', unselectedIdx >= 0 ? 'Space 勾选当前行' : 'Space 取消当前行勾选', (await countOf('.trow.selected')) === expectAfter, `before=${selBefore} after=${await countOf('.trow.selected')}`);
    await spaceRow(rowIdx);
    check('UI', 'Space 再按一次回到原勾选状态', (await countOf('.trow.selected')) === selBefore, `before=${selBefore} after=${await countOf('.trow.selected')}`);
    await keyOn('.trow', 'F2');
    check('UI', 'F2 打开行内改名输入框并聚焦', (await evaluate(`(() => { const el = document.querySelector('[data-testid^="rename-input-"]'); return !!el && document.activeElement === el; })()`)), ``);
    await keyOn('[data-testid^="rename-input-"]', 'Escape');
    check('UI', 'Esc 退出行内改名', (await evaluate(`document.querySelectorAll('[data-testid^="rename-input-"]').length`)) === 0, ``);
    check('UI', '切回更名列表', (await countOf('.trow')) === 9, `rows=${await countOf('.trow')}`);

    // ---- Explorer 拖放：事件 → 添加路径命令（mock 断言） ----
    await evaluate(`window.__E2E__.files.push(
      { path: 'D:\\\\e2e\\\\新拖入\\\\拖入 A.txt', size: 400, modified: 1735689600000, readonly: false, hidden: false, creation: 1735689600000 },
      { path: 'D:\\\\e2e\\\\新拖入\\\\拖入 B.txt', size: 600, modified: 1735689600000, readonly: false, hidden: false, creation: 1735689600000 },
    )`);
    const dropPaths = ['D:\\e2e\\新拖入\\拖入 A.txt', 'D:\\e2e\\新拖入\\拖入 B.txt'];
    const dragBefore = await countOf('.trow');
    const enterHit = await evaluate(`window.__E2E__.emitDrag('enter', ${JSON.stringify(dropPaths)})`);
    await waitFor(`document.querySelector('[data-testid="drop-overlay"]')`, '拖放高亮遮罩');
    check('UI', '拖放 enter → 注册监听器收到事件并显示高亮遮罩', enterHit > 0, `hit=${enterHit}`);
    await evaluate(`window.__E2E__.emitDrag('over', ${JSON.stringify(dropPaths)})`);
    const overHit = await evaluate(`window.__E2E__.dragEmits.at(-1)?.hit ?? 0`);
    check('UI', '拖放 over → 命中同一监听器且遮罩保持', overHit > 0 && (await evaluate(`Boolean(document.querySelector('[data-testid="drop-overlay"]'))`), `hit=${overHit}`));
    await evaluate(`window.__E2E__.emitDrag('leave', [])`);
    await waitFor(`!document.querySelector('[data-testid="drop-overlay"]')`, 'leave 后遮罩消失');
    check('UI', '拖放 leave → 遮罩消失', true, `hit=${await evaluate(`window.__E2E__.dragEmits.at(-1)?.hit ?? 0`)}`);

    // 规则卡片内部拖拽（无 Files 类型）不应触发文件拖放遮罩
    const internalDragOverlay = await evaluate(`(() => {
      const ev = new DragEvent('dragover', { bubbles: true, dataTransfer: new DataTransfer() });
      document.querySelector('.rules')?.dispatchEvent(ev);
      return Boolean(document.querySelector('[data-testid="drop-overlay"]'));
    })()`);
    check('UI', '规则区内部拖拽（无 Files）不误触发文件拖放遮罩', internalDragOverlay === false, `overlay=${internalDragOverlay}`);

    await evaluate(`window.__E2E__.emitDrag('drop', ${JSON.stringify(dropPaths)})`);
    await waitFor(`document.querySelectorAll('.trow').length === ${dragBefore + 2}`, '拖放后新增两行');
    await waitFor(`!document.querySelector('[data-testid="drop-overlay"]')`, '松手后遮罩消失');
    const dropCalls = await evaluate(`(() => {
      const list = window.__E2E__.calls.filter((c) => c.cmd === 'scan_paths');
      return list.length ? list[list.length - 1].args.paths : [];
    })()`);
    const dropToast = await textOf('[data-testid="toast-text"]');
    check(
      'UI-triggered mock',
      '拖放 drop → 调用扫描/添加路径命令，计数正确（+2）',
      dropPaths.every((p) => dropCalls.includes(p)) && (await countOf('.trow')) === dragBefore + 2,
      `paths=${dropCalls.join(',')}, rows=${await countOf('.trow')}`,
    );
    check('UI', '拖放松手后提示拖入计数', /\d+ 个/.test(dropToast) && dropToast.includes('2'), dropToast);

    // 最小窗口 + 150% DPI
    await viewport(1100, 640, 1.5);
    await sleep(500);
    const layout = await evaluate(`(() => {
      const root = document.documentElement;
      const action = document.querySelector('.actionbar')?.getBoundingClientRect();
      const toolbar = document.querySelector('.toolbar')?.getBoundingClientRect();
      return {
        innerWidth: window.innerWidth,
        scrollWidth: root.scrollWidth,
        innerHeight: window.innerHeight,
        scrollHeight: root.scrollHeight,
        actionBottom: action?.bottom ?? null,
        actionRight: action?.right ?? null,
        toolbarBottom: toolbar?.bottom ?? null,
        dpr: window.devicePixelRatio,
        rulesVisible: !!document.querySelector('.rules') && getComputedStyle(document.querySelector('.rules')).display !== 'none',
      };
    })()`);
    check('UI', '1100×640 @150% DPI 外层无横向溢出', layout.scrollWidth <= layout.innerWidth + 1 && layout.innerHeight === 640 && Math.abs(layout.dpr - 1.5) < 0.01, JSON.stringify(layout));
    const tableScroll = await evaluate(`(() => {
      const t = document.querySelector('.table');
      return t ? { clientWidth: t.clientWidth, scrollWidth: t.scrollWidth, scrollable: t.scrollWidth > t.clientWidth + 1 } : null;
    })()`);
    check('UI', '1100×640 @150% DPI 窄窗单列不出现表格横向滚动（列按可用宽度排布）', !!tableScroll && !tableScroll.scrollable && tableScroll.clientWidth > 200, JSON.stringify(tableScroll));
    check('UI', '1100×640 @150% DPI 操作条与工具栏未被裁切', layout.actionBottom <= 641 && layout.actionRight <= 1101 && layout.toolbarBottom <= 641, JSON.stringify(layout));
    await shot('14-min-1100x640-150dpi.png');

    // 最小尺寸 + 150% DPI 下打开底部抽屉：页面不溢出、头部与分段可读
    await openInspectorMode('attrs');
    await sleep(400);
    const tabLayout = await evaluate(`(() => {
      const tabs = document.querySelector('.dw-seg');
      const view = document.querySelector('.dw-body');
      const main = document.querySelector('.main');
      const rules = document.querySelector('.rules');
      const nav = document.querySelector('.nav');
      const tabRect = tabs?.getBoundingClientRect();
      return {
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        innerHeight: window.innerHeight,
        tabsClient: tabs?.clientWidth ?? 0,
        tabsScroll: tabs?.scrollWidth ?? 0,
        tabsDir: tabs ? getComputedStyle(tabs).flexDirection : '',
        tabsWrap: tabs ? getComputedStyle(tabs).flexWrap : '',
        tabRect: tabRect ? { x: Math.round(tabRect.x), w: Math.round(tabRect.width) } : null,
        mainW: main ? Math.round(main.getBoundingClientRect().width) : 0,
        rulesW: rules ? Math.round(rules.getBoundingClientRect().width) : 0,
        navW: nav ? Math.round(nav.getBoundingClientRect().width) : 0,
        panesW: (() => { const p = document.querySelector('.panes'); return p ? Math.round(p.getBoundingClientRect().width) : 0; })(),
        panesX: (() => { const p = document.querySelector('.panes'); return p ? Math.round(p.getBoundingClientRect().x) : 0; })(),
        rulesX: rules ? Math.round(rules.getBoundingClientRect().x) : 0,
        panesKids: [...(document.querySelector('.panes')?.children || [])].map((el) => el.className + ':' + Math.round(el.getBoundingClientRect().width) + '@' + Math.round(el.getBoundingClientRect().x)),
        viewBottom: view?.getBoundingClientRect().bottom ?? 0,
        viewHeight: Math.round(view?.getBoundingClientRect().height ?? 0),
        segItems: tabs ? tabs.querySelectorAll('.dw-seg-item').length : 0,
        segOverflow: tabs ? tabs.scrollWidth > tabs.clientWidth + 1 : true,
      };
    })()`);
    check(
      'UI',
      '1100×640 @150% DPI：底部抽屉不撑破页面，抽屉头部六段与内容都可读',
      tabLayout.scrollWidth <= tabLayout.innerWidth + 1 &&
        !tabLayout.segOverflow &&
        tabLayout.segItems === 6 &&
        tabLayout.viewBottom <= tabLayout.innerHeight + 1 &&
        tabLayout.viewHeight >= 120,
      JSON.stringify(tabLayout),
    );
    await shot('15-min-tabs-1100x640-150dpi.png');
    await sleep(300);

    // ---- 页头「清空列表」：二次确认，只清列表不动磁盘 ----
    const filesBeforeClear = await evaluate(`window.__E2E__.files.length`);
    await click('[data-testid="inspector-close"]').catch(() => undefined);
    await click('[data-testid="clear-all"]');
    await waitFor(`document.querySelector('[data-testid="clear-confirm"]')`, '清空确认弹层', 4000);
    const clearPop = await evaluate(`(() => {
      const pop = document.querySelector('[data-testid="clear-confirm"]');
      return { text: pop.textContent || '', rows: document.querySelectorAll('.trow').length, confirmLeft: Math.round(pop.getBoundingClientRect().right), mainRight: Math.round(document.querySelector('.main').getBoundingClientRect().right) };
    })()`);
    check(
      'UI',
      '「清空列表」先弹二次确认，文案写明只移出列表、磁盘文件不动，且弹层不越出内容列',
      clearPop.text.includes('磁盘') && clearPop.rows === filesBeforeClear && clearPop.confirmLeft <= clearPop.mainRight + 1,
      JSON.stringify(clearPop),
    );
    await click('[data-testid="clear-cancel"]');
    await sleep(250);
    check('UI', '取消清空 → 列表行数完全不变', (await countOf('.trow')) === filesBeforeClear, `rows=${await countOf('.trow')}`);
    await click('[data-testid="clear-all"]');
    await waitFor(`document.querySelector('[data-testid="clear-confirm"]')`, '再次打开清空确认', 4000);
    await click('[data-testid="clear-ok"]');
    await waitFor(`document.querySelector('.empty-state')`, '清空后的空态', 4000);
    const cleared = await evaluate(`({
      rows: document.querySelectorAll('.trow').length,
      files: window.__E2E__.files.length,
      disabled: document.querySelector('[data-testid="clear-all"]').disabled,
      tabsGone: document.querySelectorAll('.list-tabs').length,
    })`);
    check(
      'UI',
      '确认清空 → 列表回到空态、磁盘文件数量不变、清空按钮转为禁用',
      cleared.rows === 0 && cleared.files === filesBeforeClear && cleared.disabled && cleared.tabsGone === 0,
      JSON.stringify(cleared),
    );
    await shot('16-clear-list-empty.png');
    // 复原列表，后续用例仍按 9 行继续
    await click('[data-testid="add-files"]');
    await sleep(700);
    check('UI', '清空后重新添加 → 列表恢复 9 行（磁盘文件确实还在）', (await countOf('.trow')) === filesBeforeClear, `rows=${await countOf('.trow')}`);

    // 桌面层（mock 调用）覆盖同一路径的断言
    const calls = await evaluate(`window.__E2E__.calls.map((c) => c.cmd)`);
    check('UI-triggered mock', '交互确实经过 Tauri 命令层（env/scan/apply/undo/时间/属性/移动/元数据/事件/写文件）', ['env_info', 'scan_paths', 'apply_plan', 'undo_batch', 'read_metadata', 'read_times', 'read_attrs', 'apply_time', 'apply_attrs', 'apply_move', 'write_text_atomic', 'plugin:dialog|open', 'plugin:dialog|save', 'plugin:event|listen'].every((c) => calls.includes(c)), [...new Set(calls)].join(','));

    // 窗口按钮 → window API（mock 后端只记录命令；真实退出窗口需真机确认）
    await click('[data-testid="win-min"]');
    await click('[data-testid="win-max"]');
    await click('[data-testid="win-close"]');
    await sleep(300);
    const windowCalls = await evaluate(`window.__E2E__.windowCalls`);
    check(
      'UI-triggered mock',
      '右上角窗口按钮 → 实际调用 window API（minimize / toggle_maximize / close）',
      ['minimize', 'toggle_maximize', 'close'].every((c) => windowCalls.includes(c)),
      windowCalls.join(','),
    );
    check(
      'UI',
      '列表 / 抽屉 / 拖放流程无未捕获页面异常',
      pageExceptionCount === 0,
      `exceptions=${pageExceptionCount}`,
    );

    // ---- 阶段 A：权限失败逐条清单 + 提权（UIPI）提示 ----
    await evaluate('location.reload()');
    await sleep(700);
    await waitFor(`document.querySelector('[data-testid="add-files"]')`, '重载后应用就绪', 10000);
    await click('[data-testid="add-files"]');
    await waitFor(`document.querySelectorAll('.trow').length === 4`, '重载后添加 4 个文件');
    await evaluate(`(() => { for (const cb of [...document.querySelectorAll('.trow .checkbox[aria-checked="false"]')]) cb.click(); })()`);
    await waitFor(`document.querySelectorAll('.trow .checkbox[aria-checked="true"]').length === 4`, '重载后选中 4 个文件');
    // 规则链随设置持久化（重启/重载后保留），这里先清空到已知状态再添加
    const clearBtn = await evaluate(`(() => {
      const btn = [...document.querySelectorAll('.rules .panel-head .btn-icon')].find((el) => (el.getAttribute('title') || '').includes('清空'));
      if (btn) { btn.click(); return true; }
      return false;
    })()`);
    if (clearBtn) await sleep(200);
    await click('[data-testid="add-rule"]');
    await waitFor(`document.querySelector('[data-testid="rule-type-replace"]')`, '阶段 A 规则菜单');
    await click('[data-testid="rule-type-replace"]');
    await waitFor(`document.querySelectorAll('[data-testid="rule-card"]').length === 1`, '阶段 A 替换规则');
    await setInput('.rule-detail .input', '旧照片 ', 0);
    await setInput('.rule-detail .input', '权限_', 1);
    await waitFor(`document.querySelector('.trow')?.textContent.includes('权限_001')`, '阶段 A 预览生效');

    const deniedPath = 'D:\\e2e\\旅行\\旧照片 001.jpg';
    await evaluate(`window.__E2E__.denyPaths = [${JSON.stringify(deniedPath)}]`);
    await evaluate(`window.__E2E__.relaunchResult = false`);
    await click('[data-testid="action-preview"]');
    await waitFor(`document.querySelector('[data-testid="preview-confirm"]')`, '阶段 A 预览弹窗');
    await click('[data-testid="preview-confirm"]');
    await waitFor(`document.querySelector('[data-testid="failure-dialog"]')`, '逐条失败清单', 10000);

    const failureState = await evaluate(`(() => {
      const dlg = document.querySelector('[data-testid="failure-dialog"]');
      return {
        items: [...dlg.querySelectorAll('[data-testid="failure-item"]')].map((el) => ({
          code: el.dataset.code,
          text: el.textContent || '',
        })),
        summary: [...dlg.querySelectorAll('.failure-chip')].map((el) => el.textContent || ''),
        relaunch: !!dlg.querySelector('[data-testid="failure-relaunch"]'),
        skipButtons: dlg.querySelectorAll('[data-testid="failure-skip"]').length,
      };
    })()`);
    check(
      'UI',
      '权限失败逐条列出（不是整批一个「失败」）',
      failureState.items.some((i) => i.code === 'access-denied' && i.text.includes('旧照片 001')),
      JSON.stringify(failureState.items.map((i) => i.code)),
    );
    check(
      'UI',
      '失败清单按原因汇总（权限不足 1）',
      failureState.summary.some((t) => t.includes('权限不足') && t.includes('1')),
      failureState.summary.join(' | '),
    );
    check(
      'UI',
      '权限失败给出「以管理员身份重启」+ 每条「跳过该项」',
      failureState.relaunch && failureState.skipButtons === failureState.items.length,
      `relaunch=${failureState.relaunch}, skip=${failureState.skipButtons}`,
    );
    await shot('17-permission-failures.png');

    await click('[data-testid="failure-relaunch"]');
    await waitFor(`document.querySelector('[data-testid="elevation-message"]')`, '取消 UAC 后继续运行提示', 5000);
    const cancelText = await textOf('[data-testid="elevation-message"]');
    check(
      'UI',
      'UAC 取消后继续以普通权限运行（不循环弹窗）',
      cancelText.includes('取消') && cancelText.includes('普通权限'),
      cancelText.slice(0, 60),
    );

    await click('[data-testid="failure-skip"]');
    await waitFor(`!document.querySelector('[data-testid="failure-dialog"]')`, '跳过该项后清单关闭', 5000);
    check('UI', '跳过该项只移出提示、不影响其它条目', (await countOf('.trow')) === 4);

    // 已提权：UIPI 拖放限制提示（sessionStorage 标记后重载，模拟 app 以管理员启动）
    await evaluate(`sessionStorage.setItem('e2e-elevated', '1')`);
    await evaluate('location.reload()');
    await sleep(700);
    await waitFor(`document.querySelector('[data-testid="uipi-notice"]')`, 'UIPI 提示', 10000);
    const uipiText = await textOf('[data-testid="uipi-notice"]');
    check(
      'UI',
      '已提权时明确提示拖放会被 UIPI 拦截并给出替代入口',
      uipiText.includes('UIPI') && uipiText.includes('拖放') && uipiText.includes('添加文件'),
      uipiText.slice(0, 70),
    );
    await click('[data-testid="uipi-dismiss"]');
    await waitFor(`!document.querySelector('[data-testid="uipi-notice"]')`, 'UIPI 提示可关闭', 5000);
    check('UI', 'UIPI 提示可关闭，不遮挡主界面', (await countOf('.trow')) >= 0);
    await shot('18-uipi-notice.png');
    await evaluate(`sessionStorage.removeItem('e2e-elevated')`);

    // ---- 阶段 E：旧版数据迁移（一次性提示 + 设置里的手动导入入口） ----
    const migrationUrl = `http://127.0.0.1:${HTTP_PORT}/index.html?lang=zh-CN&migration=migrated`;
    await send('Page.navigate', { url: migrationUrl });
    await waitFor(`document.querySelector('[data-testid="migration-notice"]')`, '迁移完成提示', 12000);
    const migratedText = await textOf('[data-testid="migration-notice"]');
    check(
      'UI',
      '首次启动提示已导入上一版本数据（含文件数与旧目录保留说明）',
      migratedText.includes('Rename Studio') && migratedText.includes('3') && migratedText.includes('保留'),
      migratedText.slice(0, 90),
    );
    await click('[data-testid="migration-dismiss"]');
    await waitFor(`!document.querySelector('[data-testid="migration-notice"]')`, '迁移提示关闭', 5000);
    await shot('19-migration-notice-dismissed.png');

    await send('Page.navigate', { url: migrationUrl });
    await waitFor(`document.querySelector('[data-testid="add-files"]')`, '再次启动就绪', 10000);
    check(
      'UI',
      '迁移提示关闭后不再重复弹',
      !(await evaluate(`Boolean(document.querySelector('[data-testid="migration-notice"]'))`)),
    );

    await openSettings();
    await waitFor(`document.querySelector('[data-testid="legacy-section"]')`, '设置里的旧版数据区', 8000);
    check('UI', '设置提供「从旧版导入数据」手动入口', (await countOf('[data-testid="import-legacy"]')) === 1);
    await click('[data-testid="import-legacy"]');
    await waitFor(`window.__E2E__.importRequests === 1`, '手动导入调用', 5000);
    const importToast = await textOf('[data-testid="toast-text"]');
    check(
      'UI-triggered mock',
      '手动导入经 Tauri 命令层并回报导入/跳过数量',
      importToast.includes('2') && importToast.includes('1'),
      importToast.slice(0, 80),
    );
    await shot('20-legacy-import.png');
    await click('.drawer-mask');

    // ---- 可选性能压测：10,000 条目（真实前端 + mock 后端） ----
    if (process.env.PERF === '1') {
      await viewport(1440, 900, 1);
      await evaluate(`(() => {
        const now = 1735689600000;
        for (let i = 0; i < 10000; i += 1) {
          const d = String(i % 100).padStart(3, '0');
          const ext = ['jpg', 'png', 'mp3', 'pdf', 'txt', 'docx'][i % 6];
          const long = i % 50 === 0 ? '这是一个比较长的中文文件名用于测试长路径与渲染' : '';
          const name = '照片_' + long + '_中文_' + d + '_' + String(i).padStart(4, '0') + '.' + ext;
          const dir = 'D:\\\\perf\\\\批次 ' + d;
          window.__E2E__.files.push({ path: dir + '\\\\' + name, size: 1024, modified: now, readonly: false, hidden: false, creation: now });
        }
      })()`);
      const tStart = await evaluate('performance.now()');
      await click('[data-testid="add-files"]');
      let loaded = true;
      try {
        await waitFor(
          `Number(document.querySelector('[data-testid="file-table"]')?.dataset.total || 0) >= 10000`,
          '10k 条目载入',
          180000,
        );
      } catch {
        loaded = false;
      }
      const totalMs = await evaluate(`performance.now() - ${tStart}`);
      const totalRows = Number(
        await evaluate(`document.querySelector('[data-testid="file-table"]')?.dataset.total || 0`),
      );
      const domRows = await countOf('.trow');
      check(
        'PERF',
        '10,000 条目：扫描 + 预览 + 首屏渲染总耗时',
        loaded && totalRows >= 10000,
        `ms=${Math.round(totalMs)}, total=${totalRows}, dom=${domRows}`,
      );

      const virtualOn = await evaluate(
        `document.querySelector('[data-testid="file-table"]')?.dataset.virtual === '1'`,
      );
      check(
        'PERF',
        '10,000 条目：虚拟滚动生效（实际 DOM 行数受控）',
        virtualOn && domRows > 0 && domRows < 200,
        `virtual=${virtualOn}, dom=${domRows}`,
      );

      // 滚到底部：验证虚拟窗口确实移动（DOM 行数受控，且顶部那一行已不在渲染窗口内）
      const topFirstRow = await evaluate(`document.querySelector('.trow')?.textContent || ''`);
      await evaluate(`(() => {
        const el = document.querySelector('[data-testid="file-table"]');
        el.scrollTop = el.scrollHeight;
      })()`);
      await sleep(400);
      const bottomState = await evaluate(`(() => {
        const el = document.querySelector('[data-testid="file-table"]');
        const rows = [...document.querySelectorAll('.trow')].map((r) => r.textContent || '');
        return {
          scrollTop: el?.scrollTop ?? 0,
          dom: rows.length,
          first: rows[0] || '',
          moved: rows.length > 0 && rows[0] !== ${JSON.stringify(topFirstRow)},
        };
      })()`);
      check(
        'PERF',
        '10,000 条目：滚动到底部仍只渲染可视窗口（窗口已移动）',
        bottomState.scrollTop > 0 && bottomState.dom > 0 && bottomState.dom < 200 && bottomState.moved,
        JSON.stringify({ scrollTop: Math.round(bottomState.scrollTop), dom: bottomState.dom, first: bottomState.first.slice(0, 40) }),
      );

      const tToggle = await evaluate('performance.now()');
      await evaluate(`document.querySelector('[data-testid="rule-card"] .switch')?.click()`);
      await evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
      const toggleMs = await evaluate(`performance.now() - ${tToggle}`);
      check('PERF', '10,000 条目：切换一条规则的预览重算耗时', toggleMs < 3000, `ms=${Math.round(toggleMs)}`);
      await shot('16-perf-10k.png');
    }

    // ---- 多语言长文案溢出度量：日语 / 西语 / 英语，125% 与 150% 缩放 ----
    // 强制 ?lang= 覆盖系统语言；每次重新载入后加一批文件，确保表头与行真实渲染。
    for (const [lang, marker] of [['ja-JP', 'ファイル'], ['es-ES', 'Cadena de reglas'], ['en-US', 'Rule chain']]) {
      await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/index.html?lang=${lang}` });
      await waitFor(`document.querySelector('.workspace')`, `${lang} 首屏`, 15000);
      await sleep(300);
      const langText = await evaluate(`document.body.textContent || ''`);
      check('UI', `${lang}：界面文案确实切换到目标语言`, langText.includes(marker), langText.slice(0, 60));

      await click('[data-testid="add-files"]');
      await sleep(1200);

      for (const scale of [1.25, 1.5]) {
        // 缩放档只改 DPR；CSS 宽度保持在窗口下限 1100（SPEC §1.19 规则 4）
        await viewport(1100, 640, scale);
        await sleep(500);
        const m = await evaluate(`(() => {
          const root = document.documentElement;
          const truncated = (sel) => [...document.querySelectorAll(sel)].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent.trim().slice(0, 24));
          return {
            innerWidth: window.innerWidth,
            scrollWidth: root.scrollWidth,
            buttons: truncated('.toolbar .btn'),
            headers: truncated('.thead .th'),
            nav: truncated('.nav-item'),
            actions: truncated('.actionbar .btn'),
            rows: document.querySelectorAll('.trow').length,
          };
        })()`);
        const pct = Math.round(scale * 100);
        check(
          'UI',
          `${lang} @${pct}%：页面无横向溢出，按钮/表头/侧栏/操作条无截断`,
          m.scrollWidth <= m.innerWidth + 1 &&
            m.buttons.length === 0 && m.headers.length === 0 && m.nav.length === 0 && m.actions.length === 0,
          JSON.stringify(m),
        );
      }
      await shot(`19-lang-${lang}.png`);
    }
    await viewport(1440, 900, 1);

    // ================= alpha9：单栏规则链 / 排序持久化 / 布局视图 / 冲突 / 更新按钮显隐 =================
    await sleep(300);

    const clickAt = (selector, index) =>
      evaluate(`(() => {
        const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
        if (!el) throw new Error('找不到元素 ${selector}[' + ${index} + ']');
        el.click();
        return true;
      })()`);
    const addRuleType = async (type) => {
      await click('[data-testid="add-rule"]');
      await waitFor(`document.querySelector('[data-testid="rule-type-${type}"]')`, `规则菜单 ${type}`, 6000);
      await click(`[data-testid="rule-type-${type}"]`);
      await sleep(220);
    };
    const ruleOrder = () =>
      evaluate(`[...document.querySelectorAll('[data-testid="rule-card"]')].map((c) => c.getAttribute('data-rule-type')).join(',')`);
    const openRule = () =>
      evaluate(`(() => { const c = document.querySelector('.rule-card.open'); return c ? c.getAttribute('data-rule-type') : ''; })()`);
    const clearAllRules = async () => {
      const has = await evaluate(`Boolean(document.querySelector('[data-testid="clear-rules"]'))`);
      if (has) {
        await click('[data-testid="clear-rules"]');
        await sleep(250);
      }
    };
    const reloadApp = async () => {
      await evaluate('location.reload()');
      await sleep(900);
      await waitFor(`document.querySelector('.workspace')`, '重载后工作区', 15000);
      await sleep(600);
    };

    if (await evaluate(`Boolean(document.querySelector('.rules.collapsed'))`)) {
      await click('[data-testid="expand-rules"]');
      await sleep(200);
    }

    // --- 0) 元变量：插入面板 + 实时预览 ---
    await clearAllRules();
    await addRuleType('number');
    await click('[data-testid="var-toggle"]');
    await waitFor(`document.querySelector('[data-testid="var-panel"]')`, '变量面板');
    const varChips = await evaluate(`[...document.querySelectorAll('[data-testid^="var-"]')].map((e) => e.getAttribute('data-testid'))`);
    check(
      'UI',
      '变量插入面板列出常用元变量（FILENAME/NAME/EXT/SUBSTR/DIFNSUBSTR/CRC32/USER1/#）',
      ['var-FILENAME', 'var-NAME', 'var-EXT', 'var-DOTEXT', 'var-SUBSTR', 'var-DIFNSUBSTR', 'var-CRC32', 'var-MD5', 'var-SHA1', 'var-USER1', 'var-#'].every((k) => varChips.includes(k)),
      varChips.join(','),
    );
    await click('[data-testid="var-NAME"]');
    await sleep(150);
    const exprAfterInsert = await evaluate(`document.querySelector('[data-testid="number-expression"]')?.value || ''`);
    check('UI', '点击变量插入到表达式', exprAfterInsert.includes('<NAME>'), exprAfterInsert);
    await setInput('[data-testid="number-expression"]', '<NAME>_<#><DOTEXT>');
    await waitFor(`[...document.querySelectorAll('.trow')].some((r) => r.textContent.includes('logo_001.png'))`, '元变量实时预览', 10000);
    const varRowText = await evaluate(`[...document.querySelectorAll('.trow')].find((r) => r.textContent.includes('logo_001.png'))?.textContent || ''`);
    check('UI', '元变量与序号组合的实时预览（logo.png → logo_001.png）', varRowText.includes('logo_001.png'), varRowText);
    await click('[data-testid="var-toggle"]');
    await waitFor(`document.querySelector('[data-testid="var-panel"]')`, '变量面板（示例）');
    const varExample = await evaluate(`document.querySelector('.var-example code')?.textContent || ''`);
    check('UI', '变量面板实时示例', varExample.includes('IMG_2048_1.jpg'), varExample);
    await shot('00-vars-panel.png');
    await clearAllRules();

    // --- 1) 单栏 + 折叠记忆 + 三种排序方式持久化 ---
    await clearAllRules();
    await addRuleType('replace');
    await addRuleType('number');
    await addRuleType('case');

    const singleColumn = await evaluate(`(() => {
      const body = document.querySelector('.rules-body');
      const details = document.querySelectorAll('.rule-detail');
      return {
        display: getComputedStyle(body).display,
        grid: getComputedStyle(body).gridTemplateColumns,
        details: details.length,
        inCard: [...details].every((d) => d.closest('[data-testid="rule-card"]')),
        cards: document.querySelectorAll('[data-testid="rule-card"]').length,
        twoColumnDetail: Boolean(document.querySelector('.rules-body > .rule-detail')),
      };
    })()`);
    check(
      'UI',
      '规则链为单栏：无两栏网格、编辑器嵌在卡片内、同一时间只展开一条',
      singleColumn.display === 'flex' && singleColumn.grid === 'none' && singleColumn.details === 1
        && singleColumn.inCard && !singleColumn.twoColumnDetail && singleColumn.cards === 3,
      JSON.stringify(singleColumn),
    );

    const orderAdded = await ruleOrder();
    check('UI', '规则链初始顺序为 replace,number,case', orderAdded === 'replace,number,case', orderAdded);

    // 上移按钮：case 上移一位
    await clickAt('[data-testid="rule-up"]', 2);
    await sleep(300);
    const orderUp = await ruleOrder();
    check('UI', '上移按钮改变顺序（replace,case,number）', orderUp === 'replace,case,number', orderUp);

    // 键盘 Alt+↓：第一条下移
    await evaluate(`(() => {
      const card = document.querySelectorAll('[data-testid="rule-card"]')[0];
      card.focus();
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
      return true;
    })()`);
    await sleep(350);
    const orderKey = await ruleOrder();
    check('UI', 'Alt+↓ 键盘排序改变顺序（case,replace,number）', orderKey === 'case,replace,number', orderKey);

    // 拖拽：把最后一条拖到最前
    const dragProbe = await evaluate(`(() => {
      const log = [];
      ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend'].forEach((type) => {
        document.addEventListener(type, (e) => log.push(type + '@' + (e.target.getAttribute && e.target.getAttribute('data-testid') ? e.target.getAttribute('data-testid') : e.target.className)), true);
      });
      const cards = [...document.querySelectorAll('[data-testid="rule-card"]')];
      const handle = cards[2].querySelector('.drag');
      const dt = new DataTransfer();
      const fire = (type, target) => target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      fire('dragstart', handle);
      fire('dragover', cards[0]);
      fire('drop', cards[0]);
      fire('dragend', handle);
      return { log, types: [typeof DragEvent, typeof DataTransfer], transfer: dt ? dt.types.length : null };
    })()`);
    await sleep(400);
    const orderDrag = await ruleOrder();
    check('UI', '拖拽排序改变顺序（number,case,replace）', orderDrag === 'number,case,replace', JSON.stringify({ orderDrag, dragProbe }));

    const expandedBefore = await openRule();
    check('UI', '拖拽后展开项仍为 case（未误触折叠）', expandedBefore === 'case', expandedBefore);

    await reloadApp();
    const orderReload = await ruleOrder();
    const openReload = await openRule();
    check('UI', '重启后规则顺序保留（number,case,replace）', orderReload === 'number,case,replace', orderReload);
    check('UI', '重启后展开的规则保留（case）', openReload === 'case', openReload);

    await evaluate(`document.querySelector('.rule-card.open [data-testid="rule-toggle"]').click()`);
    await sleep(300);
    const collapsedCount = await evaluate(`document.querySelectorAll('.rule-detail').length`);
    check('UI', '点击折叠后编辑器收起', collapsedCount === 0, String(collapsedCount));
    await reloadApp();
    const collapsedReload = await evaluate(`document.querySelectorAll('.rule-detail').length`);
    check('UI', '重启后折叠状态保留（仍为 0 个展开编辑器）', collapsedReload === 0, String(collapsedReload));

    // --- 1.9) 键位窗：列表 / 录制 / 冲突 / 生效 / 持久化 / 恢复默认 ---
    const shortcutValue = (id) => textOf(`[data-testid="shortcut-value-${id}"]`);
    const openShortcuts = async () => {
      await openMoreMenu();
      await click('[data-testid="open-shortcuts"]');
      await waitFor(`document.querySelector('[data-testid="shortcut-dialog"]')`, '键位窗打开');
    };

    await openShortcuts();
    const shortcutRows = await evaluate(`document.querySelectorAll('.shortcut-row').length`);
    check('UI', '键位窗列出 5 条全局快捷键', shortcutRows === 5, String(shortcutRows));
    const shortcutDefaults = await evaluate(
      `['search','addFiles','addFolder','preview','undo'].map((id) => document.querySelector('[data-testid="shortcut-value-' + id + '"]').textContent).join(',')`,
    );
    check(
      'UI',
      '键位窗默认绑定与旧版一致',
      shortcutDefaults === 'Ctrl+K,Ctrl+O,Ctrl+Shift+O,Ctrl+Enter,Ctrl+Z',
      shortcutDefaults,
    );

    await click('[data-testid="shortcut-record-search"]');
    await pressKey('K', { ctrlKey: true, shiftKey: true });
    const searchBinding = await shortcutValue('search');
    check('UI', '录制 Ctrl+Shift+K 后搜索绑定即时更新', searchBinding === 'Ctrl+Shift+K', searchBinding);

    await click('[data-testid="shortcut-record-undo"]');
    await pressKey('K', { ctrlKey: true, shiftKey: true });
    const conflictText = await textOf('[data-testid="toast-text"]');
    const storedUndo = await evaluate(`JSON.parse(localStorage.getItem('rename-studio.settings')).data.shortcuts.undo`);
    const searchLabel = await textOf('[data-testid="shortcut-search"] .shortcut-name');
    check(
      'UI',
      '录制冲突组合键被拒绝，并提示占用的命令',
      conflictText.includes(searchLabel) && storedUndo === 'Ctrl+Z',
      `${conflictText} | search=${searchLabel} | 已存 undo=${storedUndo}`,
    );

    await pressKey('Escape');
    const dialogAfterEsc = await evaluate(`Boolean(document.querySelector('[data-testid="shortcut-dialog"]'))`);
    const undoAfterEsc = await shortcutValue('undo');
    check(
      'UI',
      '录制中按 Esc 只取消录制，键位窗保留',
      dialogAfterEsc === true && undoAfterEsc === 'Ctrl+Z',
      `${dialogAfterEsc} | undo=${undoAfterEsc}`,
    );

    await pressKey('Escape');
    await waitFor(`!document.querySelector('[data-testid="shortcut-dialog"]')`, 'Esc 关闭键位窗');

    await reloadApp();
    await openShortcuts();
    const searchAfterReload = await shortcutValue('search');
    check('UI', '重启后自定义绑定保留（搜索 = Ctrl+Shift+K）', searchAfterReload === 'Ctrl+Shift+K', searchAfterReload);
    await pressKey('Escape');
    await waitFor(`!document.querySelector('[data-testid="shortcut-dialog"]')`, '键位窗再次关闭');

    await evaluate(`document.activeElement && document.activeElement.blur()`);
    await pressKey('K', { ctrlKey: true });
    const oldBindingFocus = await evaluate(`document.activeElement && document.activeElement.id`);
    await pressKey('K', { ctrlKey: true, shiftKey: true });
    const newBindingFocus = await evaluate(`document.activeElement && document.activeElement.id`);
    check(
      'UI',
      '自定义绑定真正生效：旧 Ctrl+K 不再命中，新 Ctrl+Shift+K 聚焦搜索',
      oldBindingFocus !== 'global-search' && newBindingFocus === 'global-search',
      `${oldBindingFocus ?? 'none'} → ${newBindingFocus ?? 'none'}`,
    );

    await openShortcuts();
    await click('[data-testid="shortcut-reset"]');
    const resetSearch = await shortcutValue('search');
    check('UI', '恢复默认后搜索绑定回到 Ctrl+K', resetSearch === 'Ctrl+K', resetSearch);
    await pressKey('Escape');
    await waitFor(`!document.querySelector('[data-testid="shortcut-dialog"]')`, '恢复默认后关闭键位窗');
    await evaluate(`document.activeElement && document.activeElement.blur()`);
    await pressKey('K', { ctrlKey: true });
    const resetFocus = await evaluate(`document.activeElement && document.activeElement.id`);
    check('UI', '恢复默认后 Ctrl+K 重新聚焦搜索', resetFocus === 'global-search', resetFocus ?? 'none');

    // --- 2) 预设布局视图 + 窄窗收敛 + 高级拖动尺寸持久化 ---
    const setView = async (view) => {
      await click('[data-testid="layout-switch"]');
      await waitFor(`document.querySelector('[data-testid="layout-option-${view}"]')`, `布局菜单 ${view}`, 6000);
      await click(`[data-testid="layout-option-${view}"]`);
      await sleep(500);
    };
    const measureLayout = () => evaluate(`(() => {
      const root = document.documentElement;
      const workspace = document.querySelector('.workspace');
      const panes = document.querySelector('.panes');
      const main = document.querySelector('.main');
      const rules = document.querySelector('.rules');
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      const controls = [...document.querySelectorAll('button, input, select, textarea, [role="switch"], .switch, .tab, .nav-item, .chip')]
        .filter((el) => el.getClientRects().length > 0);
      let clipped = 0;
      const clippedNames = [];
      for (const el of controls) {
        const r = el.getBoundingClientRect();
        let bad = r.right > window.innerWidth + 1 || r.left < -1;
        let node = el.parentElement;
        let stopX = false;
        let stopY = false;
        while (node && node !== document.body) {
          const style = getComputedStyle(node);
          const ox = style.overflowX;
          const oy = style.overflowY;
          const nr = node.getBoundingClientRect();
          if (!stopX) {
            if (ox === 'auto' || ox === 'scroll') stopX = true;
            else if (ox !== 'visible' && (r.left < nr.left - 1 || r.right > nr.right + 1)) bad = true;
          }
          if (!stopY) {
            if (oy === 'auto' || oy === 'scroll') stopY = true;
            else if (oy !== 'visible' && (r.top < nr.top - 1 || r.bottom > nr.bottom + 1)) bad = true;
          }
          if (stopX && stopY) break;
          node = node.parentElement;
        }
        if (bad) {
          clipped += 1;
          clippedNames.push(el.tagName + '.' + String(el.className).replace(/\\s+/g, '.') + '#' + (el.getAttribute('title') || el.getAttribute('aria-label') || '') + '@' + Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + 'x' + Math.round(r.height));
        }
      }
      const scrollables = [...document.querySelectorAll('*')].filter((el) => {
        if (el === document.documentElement || el === document.body) return false;
        if (!el.getClientRects().length) return false;
        const style = getComputedStyle(el);
        return el.scrollWidth > el.clientWidth + 1 && (style.overflowX === 'auto' || style.overflowX === 'scroll');
      }).map((el) => (el.className || el.tagName) + ':' + el.clientWidth + '/' + el.scrollWidth);
      const truncated = [...document.querySelectorAll('button, .tab, .nav-item, .rule-title, .conflict-kind, .layout-item > span, .side-hint')]
        .filter((el) => el.getClientRects().length > 0 && el.scrollWidth > el.clientWidth + 1)
        .map((el) => (el.textContent || '').trim().slice(0, 22));
      const ellipsis = [...document.querySelectorAll('*')]
        .filter((el) => {
          if (!el.getClientRects().length) return false;
          if (el.closest('.table') || el.closest('.path') || el.closest('.preview')) return false;
          const style = getComputedStyle(el);
          return style.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1 && (el.textContent || '').trim().length > 0;
        })
        .map((el) => (el.className || el.tagName) + ':' + (el.textContent || '').trim().slice(0, 18));
      // 开关几何：滑块必须上下等间隙，开态贴右、关态贴左，且滑块是正圆
      const switches = { count: 0, bad: [] };
      for (const el of document.querySelectorAll('.switch')) {
        if (!el.getClientRects().length) continue;
        switches.count += 1;
        const after = getComputedStyle(el, '::after');
        const w = el.getBoundingClientRect().width;
        const h = el.getBoundingClientRect().height;
        const kw = parseFloat(after.width);
        const kh = parseFloat(after.height);
        const l = parseFloat(after.left);
        const t = parseFloat(after.top);
        const r = +(w - l - kw).toFixed(2);
        const b = +(h - t - kh).toFixed(2);
        const on = el.classList.contains('on');
        const near = on ? r : l;            // 开态看右侧、关态看左侧的贴边间隙
        const far = on ? l : r;
        const wantFar = +(w - kw - near).toFixed(2);
        const bad = Math.abs(t - b) > 0.6
          || Math.abs(kw - kh) > 0.3
          || near > 3.6
          || Math.abs(far - wantFar) > 0.6;
        if (bad) switches.bad.push(String(el.className) + '|' + (on ? 'on' : 'off') + '|track ' + w + 'x' + h + '|knob ' + kw + 'x' + kh + '|L' + l + ' R' + r + ' T' + t + ' B' + b);
      }
      return {
        view: workspace.getAttribute('data-view'),
        narrow: workspace.getAttribute('data-narrow'),
        innerWidth: window.innerWidth,
        pageOverflow: root.scrollWidth > root.clientWidth + 1,
        page: { client: root.clientWidth, scroll: root.scrollWidth },
        panesDir: getComputedStyle(panes).flexDirection,
        main: box(main), rules: rules ? box(rules) : null, panes: box(panes),
        clipped, clippedNames, scrollables, truncated, ellipsis,
        switchCount: switches.count, switchBad: switches.bad,
      };
    })()`);

    const LAYOUT_VIEWS = ['files-left', 'rules-left', 'files-top', 'rules-top', 'compact'];
    const viewportPlans = [
      [1440, 900, 1],
      [1650, 960, 1.5],
      [1280, 800, 1],
      [1200, 760, 1],
      [1100, 640, 1],
    ];
    const layoutTotals = { clipped: 0, horizontal: 0, truncated: 0, combos: 0, pageOverflow: 0, switchBad: 0, switchSeen: 0 };
    const layoutDetails = [];
    const clippedSamples = [];
    const horizontalSamples = [];
    const truncatedSamples = [];
    const switchSamples = [];
    const orientationOk = {};
    for (const [w, h, scale] of viewportPlans) {
      await viewport(w, h, scale);
      await sleep(350);
      for (const view of LAYOUT_VIEWS) {
        await setView(view);
        const m = await measureLayout();
        layoutTotals.combos += 1;
        layoutTotals.clipped += m.clipped;
        layoutTotals.horizontal += m.scrollables.length;
        layoutTotals.truncated += m.truncated.length;
        layoutTotals.switchBad += m.switchBad.length;
        layoutTotals.switchSeen += m.switchCount;
        if (m.switchBad.length > 0) switchSamples.push(`${w}x${h}@${scale}/${view}:` + m.switchBad.join('|'));
        if (m.pageOverflow) layoutTotals.pageOverflow += 1;
        if (m.clipped > 0) clippedSamples.push(`${w}x${h}@${scale}/${view}:` + m.clippedNames.join('|'));
        if (m.scrollables.length > 0) horizontalSamples.push(`${w}x${h}@${scale}/${view}:` + m.scrollables.join('|'));
        if (m.truncated.length > 0) truncatedSamples.push(`${w}x${h}@${scale}/${view}:` + m.truncated.join('|'));
        layoutDetails.push({
          at: `${w}x${h}@${scale}`, view, narrow: m.narrow, dir: m.panesDir,
          main: m.main, rules: m.rules, clipped: m.clipped, scrollables: m.scrollables,
          truncated: m.truncated, ellipsis: m.ellipsis.length,
        });
        let ok = true;
        // 分区方向只由预设决定：窗口变窄不翻转（SPEC §1.19）
        if (view === 'compact') {
          ok = m.panesDir === 'column' && m.rules === null;
        } else if (view === 'files-left') {
          ok = m.panesDir === 'row' && m.main.x < m.rules.x && Math.abs(m.main.y - m.rules.y) <= 2;
        } else if (view === 'rules-left') {
          ok = m.panesDir === 'row' && m.rules.x < m.main.x && Math.abs(m.main.y - m.rules.y) <= 2;
        } else if (view === 'files-top') {
          ok = m.panesDir === 'column' && m.main.y < m.rules.y;
        } else if (view === 'rules-top') {
          ok = m.panesDir === 'column' && m.rules.y < m.main.y;
        } else {
          ok = m.panesDir === 'column' && m.main.y < m.rules.y && Math.abs(m.main.w - m.rules.w) <= 2;
        }
        orientationOk[`${w}-${view}`] = ok;
      }
    }
    check('UI', '五种预设视图、五种窗口规模：控件裁切 = 0', layoutTotals.clipped === 0, JSON.stringify({ combos: layoutTotals.combos, clipped: layoutTotals.clipped, samples: clippedSamples.slice(0, 8) }));
    check(
      'UI',
      '所有开关滑块居中（上下等间隙、开态贴右关态贴左、滑块为正圆）',
      layoutTotals.switchBad === 0 && layoutTotals.switchSeen > 0,
      JSON.stringify({ seen: layoutTotals.switchSeen, bad: layoutTotals.switchBad, samples: switchSamples.slice(0, 6) }),
    );
    check('UI', '五种预设视图、五种窗口规模：横向滚动条 = 0', layoutTotals.horizontal === 0 && layoutTotals.pageOverflow === 0, JSON.stringify({ horizontal: layoutTotals.horizontal, pageOverflow: layoutTotals.pageOverflow, samples: horizontalSamples.slice(0, 8) }));
    check('UI', '五种预设视图、五种窗口规模：控件文字截断 = 0', layoutTotals.truncated === 0, JSON.stringify({ ...layoutTotals, samples: truncatedSamples.slice(0, 8) }));
    check('UI', '各视图方向/顺序正确（并排左右、上下先后、紧凑整宽）', Object.values(orientationOk).every(Boolean), JSON.stringify(orientationOk));

    // 窄窗：分区方向不变，侧栏折叠成一列常驻图标（不再有浮动汉堡按钮）
    await viewport(1100, 640, 1);
    await setView('rules-left');
    const narrowState = await evaluate(`(() => {
      const ws = document.querySelector('.workspace');
      return { narrow: ws.getAttribute('data-narrow'), nav: ws.getAttribute('data-nav'), view: ws.getAttribute('data-view'), dir: getComputedStyle(document.querySelector('.panes')).flexDirection };
    })()`);
    check('UI', '1100 窄窗下并排视图不翻转（仍是左右分区，视图设置不变）', narrowState.narrow === 'true' && narrowState.nav === 'rail' && narrowState.view === 'rules-left' && narrowState.dir === 'row', JSON.stringify(narrowState));
    // 窄窗侧栏是常驻图标列：不是 display:none、不滑到屏幕外，也没有浮动呼出按钮
    const narrowNav = await evaluate(`(() => {
      const nav = document.querySelector('.nav');
      const r = nav.getBoundingClientRect();
      const label = document.querySelector('.nav-group .nav-label');
      const active = document.querySelector('.nav-item.active');
      return {
        display: getComputedStyle(nav).display,
        left: Math.round(r.left),
        width: Math.round(r.width),
        labelShown: label ? getComputedStyle(label).display !== 'none' : false,
        activeShown: active ? active.getBoundingClientRect().width > 0 : false,
        fab: !!document.querySelector('[data-testid="nav-fab"]'),
        toggle: !!document.querySelector('[data-testid="nav-rail-toggle"]'),
        notice: !!document.querySelector('[data-testid="narrow-notice"]'),
      };
    })()`);
    check(
      'UI',
      '1100 窄窗侧栏折叠为常驻图标列（宽 56、当前栏目可见、无浮动汉堡）',
      narrowNav.display !== 'none' && narrowNav.left === 0 && narrowNav.width === 56 && !narrowNav.labelShown && narrowNav.activeShown && !narrowNav.fab && narrowNav.toggle && !narrowNav.notice,
      JSON.stringify(narrowNav),
    );
    await click('[data-testid="nav-rail-toggle"]');
    await sleep(300);
    const railExpanded = await evaluate(`(() => {
      const ws = document.querySelector('.workspace');
      const nav = document.querySelector('.nav');
      const label = document.querySelector('.nav-group .nav-label');
      return { nav: ws.getAttribute('data-nav'), width: Math.round(nav.getBoundingClientRect().width), labelShown: label ? getComputedStyle(label).display !== 'none' : false };
    })()`);
    check('UI', '窄窗点展开 → 图标列原位展开为完整侧栏（宽 200、分组标题可见）', railExpanded.nav === 'expanded' && railExpanded.width === 200 && railExpanded.labelShown, JSON.stringify(railExpanded));
    await click('[data-testid="nav-rail-toggle"]');
    await sleep(300);
    const railCollapsed = await evaluate(`(() => {
      const ws = document.querySelector('.workspace');
      return { nav: ws.getAttribute('data-nav'), width: Math.round(document.querySelector('.nav').getBoundingClientRect().width) };
    })()`);
    check('UI', '窄窗展开后再点同一个按钮 → 收回到图标列（双向可逆）', railCollapsed.nav === 'rail' && railCollapsed.width === 56, JSON.stringify(railCollapsed));
    await click('[data-testid="nav-rail-toggle"]');
    await sleep(300);
    await click('[data-testid="nav-history"]');
    await waitFor(`document.querySelector('.drawer')`, '窄窗点击侧栏入口打开抽屉', 4000);
    const navAfterNav = await evaluate(`(() => ({
      nav: document.querySelector('.workspace').getAttribute('data-nav'),
      drawer: !!document.querySelector('.drawer'),
    }))()`);
    check('UI', '窄窗点侧栏入口 → 打开对应抽屉并自动收回图标列', navAfterNav.drawer && navAfterNav.nav === 'rail', JSON.stringify(navAfterNav));
    await evaluate(`document.querySelector('.drawer-mask')?.click()`);
    await waitFor(`!document.querySelector('.drawer')`, '关闭窄窗抽屉');
    await sleep(300);
    await viewport(1440, 900, 1);
    await sleep(500);
    const wideState = await evaluate(`(() => {
      const ws = document.querySelector('.workspace');
      return { narrow: ws.getAttribute('data-narrow'), view: ws.getAttribute('data-view'), dir: getComputedStyle(document.querySelector('.panes')).flexDirection };
    })()`);
    check('UI', '恢复宽窗后回落到用户视图 rules-left（并排）', wideState.narrow === 'false' && wideState.view === 'rules-left' && wideState.dir === 'row', JSON.stringify(wideState));

    // 高级拖动 + 尺寸持久化
    await setView('rules-top');
    await click('[data-testid="layout-switch"]');
    await waitFor(`document.querySelector('[data-testid="layout-menu"]')`, '布局菜单', 4000);
    const layoutLabel = await evaluate(`(() => ({
      trigger: document.querySelector('[data-testid="layout-switch"]').innerText.trim(),
      items: [...document.querySelectorAll('[data-testid="layout-menu"] [role="menuitemradio"]')].map((n) => n.innerText.replace(/\\n/g, ' ')),
    }))()`);
    check('UI', '布局菜单文字全部本地化（无 layout. 原始 key）', !layoutLabel.trigger.includes('layout.') && !layoutLabel.items.join('|').includes('layout.') && layoutLabel.items.length === 5, JSON.stringify(layoutLabel));
    await waitFor(`document.querySelector('[data-testid="layout-advanced"]')`, '布局高级开关', 6000);
    await click('[data-testid="layout-advanced"]');
    await sleep(300);
    await click('[data-testid="layout-switch"]');
    await sleep(300);
    const h1 = await evaluate(`Math.round(document.querySelector('.rules').getBoundingClientRect().height)`);
    await evaluate(`(() => {
      const splitter = document.querySelector('[data-testid="layout-splitter"]');
      const r = splitter.getBoundingClientRect();
      const opts = { bubbles: true, clientX: r.x + 4, clientY: r.y + 0.5 };
      splitter.dispatchEvent(new PointerEvent('pointerdown', opts));
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.x + 4, clientY: r.y + 60 }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.x + 4, clientY: r.y + 60 }));
      return true;
    })()`);
    await sleep(400);
    const h2 = await evaluate(`Math.round(document.querySelector('.rules').getBoundingClientRect().height)`);
    const layoutSaved = await evaluate(`JSON.parse(localStorage.getItem('rename-studio.settings')).data.layout`);
    check(
      'UI',
      '高级模式拖动分隔条改变规则栏尺寸并写入该视图独立尺寸',
      Math.abs(h2 - h1 - 60) <= 6 && layoutSaved.advanced === true && layoutSaved.sizes?.['rules-top'] === h2 && layoutSaved.sizes?.['rules-left'] === 400,
      JSON.stringify({ h1, h2, sizes: layoutSaved.sizes }),
    );
    await reloadApp();
    const h3 = await evaluate(`Math.round(document.querySelector('.rules').getBoundingClientRect().height)`);
    const stateAfterReload = await evaluate(`(() => {
      const ws = document.querySelector('.workspace');
      return { view: ws.getAttribute('data-view'), advanced: ws.getAttribute('data-advanced'), h: Math.round(document.querySelector('.rules').getBoundingClientRect().height) };
    })()`);
    check('UI', '重启后保留视图 rules-top 与拖动尺寸', stateAfterReload.view === 'rules-top' && stateAfterReload.advanced === 'true' && Math.abs(h3 - h2) <= 3, JSON.stringify({ before: h2, after: h3, stateAfterReload }));

    // 设置面板的布局分区：preset 缩略图 + 本地化文字 + 独立尺寸 + advanced 关闭时无分隔条
    await openSettings();
    await waitFor(`document.querySelector('[data-testid="layout-settings"]')`, '设置面板布局分区', 6000);
    const settingsLayout = await evaluate(`(() => ({
      picks: document.querySelectorAll('[data-testid^="settings-layout-"]').length,
      thumbs: document.querySelectorAll('[data-testid="layout-settings"] .layout-thumb').length,
      rawKeys: document.querySelector('[data-testid="layout-settings"]').innerText.includes('layout.'),
      sizeInput: !!document.querySelector('[data-testid="input-layout-size"]'),
      reset: !!document.querySelector('[data-testid="layout-reset-sizes"]'),
    }))()`);
    check(
      'UI',
      '设置面板含布局分区：5 个 preset 缩略示意图 + 尺寸输入 + 重置，且无 layout. 原始 key',
      settingsLayout.picks === 5 && settingsLayout.thumbs === 5 && !settingsLayout.rawKeys && settingsLayout.sizeInput && settingsLayout.reset,
      JSON.stringify(settingsLayout),
    );
    // 数据目录来源：默认（非便携）必须渲染出来源文案（五语种任一，且不能是原始 key）
    const rootSourceText = await evaluate(
      `(document.querySelector('[data-testid="data-root-source"]')?.innerText ?? '').trim()`,
    );
    const defaultSourceLabels = [
      '每用户默认位置',
      '每位使用者預設位置',
      'Per-user default',
      'ユーザーごとの既定位置',
      'Ubicación predeterminada por usuario',
    ];
    check(
      'UI',
      '设置 › 运行环境显示数据目录来源（默认 = 每用户默认位置）',
      defaultSourceLabels.some((label) => rootSourceText.includes(label)) && !rootSourceText.includes('settings.'),
      rootSourceText,
    );
    const portableNoteVisible = await evaluate(
      `!!document.querySelector('[data-testid="portable-note"]')`,
    );
    check(
      'UI',
      '非便携模式不显示便携说明，也不显示回落原因',
      portableNoteVisible === false,
      String(portableNoteVisible),
    );
    await click('[data-testid="settings-layout-compact"]');
    await sleep(300);
    const settingsView = await evaluate(`document.querySelector('.workspace').getAttribute('data-view')`);
    check('UI', '设置面板切换 preset → 视图立即切换到 compact', settingsView === 'compact', String(settingsView));
    await click('[data-testid="settings-layout-files-left"]');
    await sleep(300);
    await click('[data-testid="switch-layout-advanced"]');
    await sleep(300);
    const advOff = await evaluate(`document.querySelectorAll('[data-testid="layout-splitter"]').length`);
    check('UI', 'advanced 关闭 → 不再渲染不可拖的分隔条', advOff === 0, String(advOff));
    await click('[data-testid="switch-layout-advanced"]');
    await sleep(300);
    const advOn = await evaluate(`document.querySelectorAll('[data-testid="layout-splitter"]').length`);
    check('UI', 'advanced 开启 → 分隔条恢复渲染', advOn === 1, String(advOn));
    await click('.drawer-mask');
    await sleep(250);

    // compact：规则区默认收起为底部面板，一键展开并持久化
    await setView('compact');
    const compactClosed = await evaluate(`(() => ({
      view: document.querySelector('.workspace').getAttribute('data-view'),
      rules: !!document.querySelector('.panes > .rules'),
      toggle: !!document.querySelector('[data-testid="compact-toggle"]'),
      expanded: document.querySelector('[data-testid="compact-toggle"]')?.getAttribute('aria-expanded') || '',
    }))()`);
    check('UI', 'compact 默认收起：只渲染紧凑条，不渲染规则区', compactClosed.view === 'compact' && !compactClosed.rules && compactClosed.toggle && compactClosed.expanded === 'false', JSON.stringify(compactClosed));
    await click('[data-testid="compact-toggle"]');
    await waitFor(`document.querySelector('.panes > .rules')`, '紧凑视图展开规则区', 4000);
    await sleep(350);
    const compactOpenState = await evaluate(`(() => {
      const p = document.querySelector('.panes');
      const r = document.querySelector('.panes > .rules');
      const cs = getComputedStyle(r);
      return {
        expanded: document.querySelector('[data-testid="compact-toggle"]').getAttribute('aria-expanded'),
        ruleH: Math.round(r.getBoundingClientRect().height),
        panesH: Math.round(p.getBoundingClientRect().height),
        flexBasis: cs.flexBasis,
        rulesBelowMain: r.getBoundingClientRect().top > document.querySelector('.panes > .main').getBoundingClientRect().top,
      };
    })()`);
    check(
      'UI',
      'compact 展开 → 规则区是底部面板（不再固定 260px），高度按窗口比例伸缩',
      compactOpenState.expanded === 'true'
        && compactOpenState.ruleH > 200
        && compactOpenState.ruleH < compactOpenState.panesH * 0.6
        && compactOpenState.flexBasis === 'auto'
        && compactOpenState.rulesBelowMain,
      JSON.stringify(compactOpenState),
    );
    await reloadApp();
    const compactPersist = await evaluate(`(() => ({
      view: document.querySelector('.workspace').getAttribute('data-view'),
      rules: !!document.querySelector('.panes > .rules'),
      expanded: document.querySelector('[data-testid="compact-toggle"]')?.getAttribute('aria-expanded') || '',
    }))()`);
    check('UI', '重启后保留 compact 展开状态（规则区仍展开）', compactPersist.view === 'compact' && compactPersist.rules && compactPersist.expanded === 'true', JSON.stringify(compactPersist));

    // --- 3) 规则冲突：四类命中 + 不命中 + 合并 + 跳转 ---
    await setView('files-left');
    await clearAllRules();

    // 路径类：同路径包含+排除；前缀/子目录重叠
    await setInput('[data-testid="include-pattern"]', 'C:\\data;C:\\data\\sub');
    await setInput('[data-testid="exclude-pattern"]', 'C:\\data');
    await sleep(400);
    const pathConflicts = await evaluate(`(() => {
      const items = [...document.querySelectorAll('[data-testid="conflict-item"]')].map((el) => el.getAttribute('data-conflict-kinds'));
      return { count: items.length, items };
    })()`);
    check(
      'UI',
      '冲突命中：同路径包含+排除、前缀/子目录重叠（2 条独立冲突）',
      pathConflicts.count === 2
        && pathConflicts.items.some((k) => k.includes('include-exclude'))
        && pathConflicts.items.some((k) => k.includes('path-overlap')),
      JSON.stringify(pathConflicts),
    );

    await setInput('[data-testid="include-pattern"]', '');
    await setInput('[data-testid="exclude-pattern"]', '');
    await sleep(300);

    // 动作矛盾 + 正则等价：同一对规则合并为一条
    await addRuleType('replace');
    await setInput('[data-testid="replace-find"]', 'x');
    await evaluate(`document.querySelectorAll('.rule-detail [role="switch"]')[1].click()`);
    await sleep(200);
    await setInput('[data-testid="replace-with"]', 'a');
    const firstRuleId = await evaluate(`document.querySelector('[data-testid="rule-card"]').getAttribute('data-rule-id')`);
    await addRuleType('replace');
    await setInput('[data-testid="replace-find"]', 'x');
    await evaluate(`document.querySelectorAll('.rule-detail [role="switch"]')[1].click()`);
    await sleep(200);
    await setInput('[data-testid="replace-with"]', 'b');
    await sleep(400);

    const actionConflicts = await evaluate(`(() => {
      const items = [...document.querySelectorAll('[data-testid="conflict-item"]')].map((el) => el.getAttribute('data-conflict-kinds'));
      return {
        count: items.length,
        items,
        badges: document.querySelectorAll('[data-testid="rule-conflict-badge"]').length,
        rules: document.querySelectorAll('[data-testid="rule-card"]').length,
        modal: Boolean(document.querySelector('.modal, [role="dialog"]')),
      };
    })()`);
    check(
      'UI',
      '冲突命中：动作矛盾与正则等价合并为一条（同一对规则只出现一次）',
      actionConflicts.count === 1
        && actionConflicts.items[0].includes('action-contradiction')
        && actionConflicts.items[0].includes('regex-overlap'),
      JSON.stringify(actionConflicts),
    );
    check('UI', '冲突不阻断保存：两条规则仍在、无阻断弹窗、两条规则就地标出', actionConflicts.rules === 2 && !actionConflicts.modal && actionConflicts.badges === 2, JSON.stringify(actionConflicts));

    // 跳转：点击汇总里的冲突项 → 展开对应规则
    await click('[data-testid="conflict-item"]');
    await sleep(400);
    const jumpState = await evaluate(`(() => {
      const open = document.querySelector('.rule-card.open');
      return { openId: open ? open.getAttribute('data-rule-id') : null, detail: document.querySelectorAll('.rule-detail').length, focused: document.activeElement?.getAttribute('data-rule-id') || null };
    })()`);
    check(
      'UI',
      '点击冲突汇总可跳转到对应规则（展开并聚焦）',
      jumpState.detail === 1 && jumpState.focused === firstRuleId && jumpState.openId === firstRuleId,
      JSON.stringify({ firstRuleId, jumpState }),
    );

    // 被遮蔽：两条相同大小写规则 → shadowed
    await addRuleType('case');
    await addRuleType('case');
    await sleep(400);
    const shadowConflicts = await evaluate(`(() => {
      const items = [...document.querySelectorAll('[data-testid="conflict-item"]')].map((el) => el.getAttribute('data-conflict-kinds'));
      return { items: items.length, hasShadow: items.some((k) => k.includes('shadowed')) };
    })()`);
    check('UI', '冲突命中：后一条被遮蔽不可达', shadowConflicts.hasShadow, JSON.stringify(shadowConflicts));

    // 不命中样例
    await clearAllRules();
    await setInput('[data-testid="include-pattern"]', '*.jpg');
    await setInput('[data-testid="exclude-pattern"]', '*.png');
    await sleep(300);
    await addRuleType('replace');
    await setInput('[data-testid="replace-find"]', 'aa');
    await setInput('[data-testid="replace-with"]', 'bb');
    await addRuleType('replace');
    await setInput('[data-testid="replace-find"]', 'mm');
    await setInput('[data-testid="replace-with"]', 'nn');
    await sleep(400);
    const noConflicts = await evaluate(`(() => ({
      panel: Boolean(document.querySelector('[data-testid="rule-conflicts"]')),
      items: document.querySelectorAll('[data-testid="conflict-item"]').length,
      badges: document.querySelectorAll('[data-testid="rule-conflict-badge"]').length,
      rules: document.querySelectorAll('[data-testid="rule-card"]').length,
    }))()`);
    check('UI', '冲突不命中：模式不重叠且替换互不相干时不提示', !noConflicts.panel && noConflicts.items === 0 && noConflicts.badges === 0 && noConflicts.rules === 2, JSON.stringify(noConflicts));

    // ---- 执行筛选：入口在路径条筛选组内联（不再藏在更多菜单里）----
    await setInput('[data-testid="include-pattern"]', '');
    await setInput('[data-testid="exclude-pattern"]', '');
    await sleep(300);
    const filterIdle = await evaluate(`(() => ({
      btn: document.querySelector('[data-testid="filter-apply"]') ? 1 : 0,
      rows: document.querySelectorAll('.trow').length,
    }))()`);
    check('UI', '筛选组：没填条件时不显示执行按钮', filterIdle.btn === 0 && filterIdle.rows > 0, JSON.stringify(filterIdle));

    await setInput('[data-testid="include-pattern"]', 'nomatch-zzz');
    await sleep(300);
    const filterShown = await evaluate(`(() => {
      const el = document.querySelector('[data-testid="filter-apply"]');
      return { btn: el ? 1 : 0, label: el ? el.textContent.trim() : '', hint: el ? (el.getAttribute('title') || '') : '' };
    })()`);
    check('UI', '筛选组：填了条件后按钮出现在条件旁边，并带说明', filterShown.btn === 1 && filterShown.label.length > 0 && filterShown.hint.length > 0, JSON.stringify(filterShown));

    // 一条都不匹配：不许把列表清空
    const beforeFilter = await evaluate(`document.querySelectorAll('.trow').length`);
    await click('[data-testid="filter-apply"]');
    await sleep(400);
    const noMatchResult = await evaluate(`(() => ({
      rows: document.querySelectorAll('.trow').length,
      toast: (document.querySelector('[data-testid="toast-text"]') || {}).textContent || '',
    }))()`);
    check('UI', '执行筛选：一条都不匹配时列表不动并给出提示', noMatchResult.rows === beforeFilter && /没有对象匹配|Nothing matches|Nada coincide|一致する項目はありません/.test(noMatchResult.toast), JSON.stringify(noMatchResult));

    // 全匹配：不丢行，提示保留 N / N
    await setInput('[data-testid="include-pattern"]', '*');
    await sleep(300);
    await click('[data-testid="filter-apply"]');
    await sleep(400);
    const allMatchResult = await evaluate(`(() => ({
      rows: document.querySelectorAll('.trow').length,
      toast: (document.querySelector('[data-testid="toast-text"]') || {}).textContent || '',
    }))()`);
    check('UI', '执行筛选：通配符匹配全部时行数不变并给出保留数', allMatchResult.rows === beforeFilter && /保留|Kept|Se conservaron|保持/.test(allMatchResult.toast), JSON.stringify(allMatchResult));

    await setInput('[data-testid="include-pattern"]', '');
    await setInput('[data-testid="exclude-pattern"]', '');
    await sleep(300);
    // Enter 也能执行（键盘可走通），Esc 清空当前框
    await setInput('[data-testid="include-pattern"]', 'nomatch-yyy');
    await keyOn('[data-testid="include-pattern"]', 'Enter');
    const enterToast = await evaluate(`(document.querySelector('[data-testid="toast-text"]') || {}).textContent || ''`);
    check('UI', '执行筛选：输入框里按 Enter 与点按钮等效', /没有对象匹配|Nothing matches|Nada coincide|一致する項目はありません/.test(enterToast), enterToast.slice(0, 40));
    await keyOn('[data-testid="include-pattern"]', 'Escape');
    const escCleared = await evaluate(`(() => ({
      value: document.getElementById('include-pattern').value,
      btn: document.querySelector('[data-testid="filter-apply"]') ? 1 : 0,
    }))()`);
    check('UI', '执行筛选：Esc 清空条件并收起按钮', escCleared.value === '' && escCleared.btn === 0, JSON.stringify(escCleared));

    // 更多菜单不该再塞执行动作
    await openMoreMenu();
    const moreMenu = await evaluate(`(() => ({
      filterItem: document.querySelectorAll('[data-testid="filter-files"]').length,
      items: document.querySelectorAll('[data-testid="toolbar-more-menu"] .pop-item').length,
    }))()`);
    check('UI', '更多菜单：不再有「筛选」项（入口已内联）', moreMenu.filterItem === 0 && moreMenu.items >= 2, JSON.stringify(moreMenu));
    await click('[data-testid="toolbar-more"]');
    await sleep(200);

    // ---- 对照表（map 规则）：新增类型 → 整段映射 → 条目计数 → 坏行拦下 ----
    await clearAllRules();
    const setArea = (selector, value) =>
      evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('找不到多行输入框 ${selector}');
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
    const firstRowNames = () => evaluate(`(() => {
      const row = document.querySelector('.trow');
      const oldName = row && row.querySelector('.txt') ? row.querySelector('.txt').textContent.trim() : '';
      const dot = oldName.lastIndexOf('.');
      const stem = dot > 0 ? oldName.slice(0, dot) : oldName;
      const ext = dot > 0 ? oldName.slice(dot) : '';
      const newName = row && row.querySelector('.new-name') ? row.querySelector('.new-name').textContent.trim() : '';
      return { oldName, stem, ext, newName };
    })()`);
    const mapCountNumber = async () => {
      const text = await textOf('[data-testid="map-entries-count"]');
      const digits = (text.match(/\d+/) || [''])[0];
      return digits ? Number(digits) : -1;
    };

    await addRuleType('map');
    const mapCard = await evaluate(`(() => ({
      card: document.querySelectorAll('[data-testid="rule-card"][data-rule-type="map"]').length,
      table: document.querySelector('[data-testid="map-table"]') ? 1 : 0,
      cases: document.querySelector('[data-testid="map-case"]') ? 1 : 0,
      hint: document.querySelector('[data-testid="map-hint"]') ? 1 : 0,
    }))()`);
    check('UI', '对照表：规则菜单可新增 map 规则，编辑器有表格框、大小写开关与提示',
      mapCard.card === 1 && mapCard.table === 1 && mapCard.cases === 1 && mapCard.hint === 1, JSON.stringify(mapCard));

    const mapBefore = await firstRowNames();
    await setArea('[data-testid="map-table"]', `${mapBefore.stem}=MAPED`);
    await sleep(700);
    const mapAfter = await firstRowNames();
    check('UI', '对照表：整段旧名映射成新词，扩展名保持不变',
      mapBefore.stem.length > 0 && mapAfter.newName === `MAPED${mapBefore.ext}`,
      JSON.stringify({ mapBefore, mapAfter }));

    await setArea('[data-testid="map-table"]', `${mapBefore.stem}=MAPED\nNOT_IN_LISTMAP=X`);
    await sleep(600);
    const mapCount = await mapCountNumber();
    check('UI', '对照表：条目计数按实际可解析的条数显示', mapCount === 2, String(mapCount));

    await setArea('[data-testid="map-table"]', 'MAP_NO_SEP_LINE');
    await sleep(600);
    const mapBad = await evaluate(`(() => {
      const box = document.querySelector('[data-testid="map-errors"]');
      const row = document.querySelector('.trow');
      return {
        errors: box ? box.querySelectorAll('div').length : 0,
        text: box ? box.textContent.trim() : '',
        newName: row && row.querySelector('.new-name') ? row.querySelector('.new-name').textContent.trim() : '',
      };
    })()`);
    check('UI', '对照表：坏行就地报错（带行号），且该规则不参与改名',
      mapBad.errors >= 1 && mapBad.text.length > 0 && mapBad.newName === mapBefore.oldName,
      JSON.stringify({ mapBad, old: mapBefore.oldName }));

    await clearAllRules();
    await sleep(300);

    // ---- 正则方言：替换串里的 \1..\9 按分组引用处理（对标 Delphi 习惯，等价 $1..$9）----
    await clearAllRules();
    await addRuleType('replace');
    await setInput('[data-testid="replace-find"]', '(\\d{3})');
    const regexChecked = await evaluate(`(() => {
      const sw = document.querySelectorAll('.rule-detail [role="switch"]')[1];
      return sw ? sw.getAttribute('aria-checked') : null;
    })()`);
    if (regexChecked !== 'true') {
      await evaluate(`document.querySelectorAll('.rule-detail [role="switch"]')[1].click()`);
      await sleep(250);
    }
    const refHint = await evaluate(`document.querySelector('[data-testid="replace-ref-hint"]')?.textContent || ''`);
    check(
      'UI',
      '正则开启时替换串旁给出 \\1 分组引用提示（含等价写法 $1）',
      refHint.includes('\\1') && refHint.includes('$1'),
      refHint.slice(0, 90),
    );

    await setInput('[data-testid="replace-with"]', '第\\1组');
    await sleep(800);
    const newNamesRef = await evaluate(`[...document.querySelectorAll('.trow .new-name')].map((e) => e.textContent.trim())`);
    const refExpanded = newNamesRef.filter((n) => /第\d{3}组/.test(n));
    check(
      'UI',
      '正则替换：替换串写 \\1 时按第 1 个捕获组展开（不是字面反斜杠）',
      refExpanded.length >= 1 && !newNamesRef.some((n) => n.includes('\\1')),
      JSON.stringify({ expanded: refExpanded.slice(0, 3), sample: newNamesRef.slice(0, 4) }),
    );
    await shot('21-regex-backslash-ref.png');

    await setInput('[data-testid="replace-with"]', '\\3');
    await sleep(600);
    const refErr = await evaluate(`document.querySelector('.rule-error')?.textContent || ''`);
    check(
      'UI',
      '引用分组超出正则实际分组数 → 规则卡就地报错（不静默生成错名）',
      refErr.includes('\\3') && refErr.includes('1'),
      refErr.slice(0, 90),
    );

    await setInput('[data-testid="replace-with"]', '\\\\1');
    await sleep(600);
    const literalRef = await evaluate(`({
      err: (document.querySelector('.rule-error')?.textContent || ''),
      names: [...document.querySelectorAll('.trow .new-name')].map((e) => e.textContent.trim()),
    })`);
    check(
      'UI',
      '\\\\1 表示字面反斜杠：不参与分组校验、预览里保留 \\1 文本',
      literalRef.err === '' && literalRef.names.some((n) => n.includes('\\1')),
      JSON.stringify({ err: literalRef.err, sample: literalRef.names.slice(0, 3) }),
    );

    // \0 整段匹配（Delphi 方言）：替换串写 [\0] 时展开为整段匹配，不留字面反斜杠
    await setInput('[data-testid="replace-with"]', '[\\0]');
    await sleep(700);
    const wholeMatch = await evaluate(`[...document.querySelectorAll('.trow .new-name')].map((e) => e.textContent.trim())`);
    check(
      'UI',
      '正则替换：替换串写 \\0 时展开为整段匹配（Delphi 方言）',
      wholeMatch.some((n) => /\[\d{3}\]/.test(n)) && !wholeMatch.some((n) => n.includes('\\0')),
      JSON.stringify(wholeMatch.slice(0, 4)),
    );

    // 只替换第 2 个匹配：替换串里的 \1 仍要展开（不能把 $1 / \1 原样写进名字）
    await setInput('[data-testid="replace-find"]', '(\\d)');
    await setInput('[data-testid="replace-with"]', '[\\1]');
    await evaluate(`document.querySelectorAll('[data-testid="replace-scope"] span')[1].click()`);
    await sleep(300);
    await setInput('[data-testid="replace-nth"]', '2');
    await sleep(700);
    const nthTitles = await evaluate(
      `[...document.querySelectorAll('.trow .new-name')].map((e) => e.getAttribute('title') || '').filter(Boolean)`,
    );
    const nthExpected = nthTitles.map((title) => {
      const [oldName, newName] = title.split(' → ');
      const dot = oldName.lastIndexOf('.');
      const stem = dot > 0 ? oldName.slice(0, dot) : oldName;
      const ext = dot > 0 ? oldName.slice(dot) : '';
      let seen = 0;
      let expected = '';
      for (const ch of stem) {
        if (ch >= '0' && ch <= '9') {
          seen += 1;
          expected += seen === 2 ? `[${ch}]` : ch;
        } else expected += ch;
      }
      return { oldName, newName, expected: seen >= 2 ? expected + ext : oldName };
    });
    const nthOk = nthExpected.length > 0
      && nthExpected.every((r) => r.newName === r.expected)
      && !nthExpected.some((r) => r.newName.includes('$1') || r.newName.includes('\\1'));
    check(
      'UI',
      '只替换第 2 个匹配：替换串 \\1 仍按捕获组展开（不写进字面）',
      nthOk,
      JSON.stringify(nthExpected.slice(0, 3)),
    );
    await shot('21b-regex-nth-whole.png');
    await clearAllRules();

    // ---- 大小写例外词表：被保护片段在 upper 后保留原写法 ----
    await addRuleType('case');
    await evaluate(`document.querySelectorAll('.rule-detail .seg-ctrl span')[1]?.click()`);
    await sleep(250);
    const protectUi = await evaluate(`({
      box: Boolean(document.querySelector('[data-testid="case-protect"]')),
      hint: (document.querySelector('[data-testid="case-protect-hint"]')?.textContent || ''),
    })`);
    check(
      'UI',
      '大小写规则提供例外词输入框，并提示 * / ? 通配与保留原大小写',
      protectUi.box && protectUi.hint.includes('*') && protectUi.hint.includes('?'),
      JSON.stringify({ box: protectUi.box, hint: protectUi.hint.slice(0, 60) }),
    );

    const rowByName = (name) => `(() => {
      const row = [...document.querySelectorAll('.trow')].find((r) => (r.querySelector('.name-cell .txt')?.textContent || '') === '${name}');
      return row
        ? { name: row.querySelector('.new-name')?.textContent?.trim() ?? null, unchanged: row.classList.contains('unchanged') }
        : null;
    })()`;

    await setInput('[data-testid="case-protect"]', 'logo');
    await sleep(700);
    const protectedLogo = await evaluate(rowByName('logo.png'));
    const allUpperNoProtect = await evaluate(`[...document.querySelectorAll('.trow .new-name')].map((e) => e.textContent.trim())`);
    check(
      'UI',
      '例外词命中：upper 后 logo.png 保留原写法（其余行照旧大写）',
      protectedLogo?.name === 'logo.png' && allUpperNoProtect.includes('LOGO.png') === false,
      JSON.stringify({ protectedLogo, sample: allUpperNoProtect.slice(0, 3) }),
    );
    await shot('23-case-protect.png');

    await setInput('[data-testid="case-protect"]', '');
    await sleep(700);
    const unprotectedLogo = await evaluate(rowByName('logo.png'));
    check(
      'UI',
      '清空例外词后同一行按 upper 变成 LOGO.png（说明保护只作用于命中的片段）',
      unprotectedLogo?.name === 'LOGO.png',
      JSON.stringify(unprotectedLogo),
    );
    await clearAllRules();

    // ---- 按元数据取名：17 字段可选 / 真实取值 / 缺失不改名 ----
    await addRuleType('meta');
    const metaSelect = await evaluate(`(() => {
      const sel = document.querySelector('[data-testid="meta-field"]');
      if (!sel) return null;
      return {
        count: sel.querySelectorAll('option').length,
        groups: [...sel.querySelectorAll('optgroup')].map((g) => g.label),
        values: [...sel.querySelectorAll('option')].map((o) => o.value),
      };
    })()`);
    check(
      'UI',
      '元数据字段下拉含 17 个字段、按拍摄参数 / 图像尺寸 / 音频标签三组展示',
      metaSelect?.count === 17
        && metaSelect.groups.length === 3
        && ['iso', 'aperture', 'shutter', 'focal', 'lens', 'width', 'height', 'resolution', 'year', 'genre', 'composer']
          .every((k) => metaSelect.values.includes(k)),
      JSON.stringify(metaSelect),
    );

    const setMetaField = (value) => evaluate(`(() => {
      const sel = document.querySelector('[data-testid="meta-field"]');
      if (!sel) throw new Error('找不到元数据字段下拉');
      sel.value = ${JSON.stringify(value)};
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return sel.value;
    })()`);
    const metaSum = () => evaluate(`document.querySelector('.rule-card.open .sum span')?.textContent?.trim() || ''`);

    await setMetaField('iso');
    await sleep(700);
    const isoRow = await evaluate(rowByName('旧照片 001.jpg'));
    check('UI', '按 ISO 取值前缀取名：400「空格」旧照片 001.jpg', isoRow?.name === '400 旧照片 001.jpg', JSON.stringify(isoRow));
    const isoSum = await metaSum();
    check(
      'UI',
      '规则摘要写明来源（EXIF + ISO），不是裸字段名',
      isoSum.includes('EXIF') && isoSum.includes('ISO'),
      isoSum,
    );

    await setMetaField('lens');
    await sleep(700);
    const lensRow = await evaluate(rowByName('旧照片 001.jpg'));
    check('UI', '按镜头取值取名：RF35mm F1.8 旧照片 001.jpg', lensRow?.name === 'RF35mm F1.8 旧照片 001.jpg', JSON.stringify(lensRow));

    await setMetaField('resolution');
    await sleep(700);
    const resRow = await evaluate(rowByName('旧照片 001.jpg'));
    check('UI', '按像素尺寸取值取名：5472x3648 旧照片 001.jpg', resRow?.name === '5472x3648 旧照片 001.jpg', JSON.stringify(resRow));
    const audioOnPhoto = await evaluate(`[...document.querySelectorAll('.trow')].map((r) => ({
      name: r.querySelector('.name-cell .txt')?.textContent || '',
      next: r.querySelector('.new-name')?.textContent?.trim() ?? null,
    }))`);
    check(
      'UI',
      '切换字段前所有照片行都真的改了名（不是只改首行）',
      audioOnPhoto.filter((r) => r.name.endsWith('.jpg')).every((r) => String(r.next).startsWith('5472x3648 ')),
      JSON.stringify(audioOnPhoto.slice(0, 3)),
    );

    // 照片没有音频标签：选音频字段时该规则“不改变名称”，而不是拼出空段
    await setMetaField('composer');
    await sleep(700);
    const composerRow = await evaluate(rowByName('旧照片 001.jpg'));
    check(
      'UI',
      '缺失字段（照片选音频作曲）时该行保持原名且标记 unchanged',
      composerRow?.name === '旧照片 001.jpg' && composerRow.unchanged === true,
      JSON.stringify(composerRow),
    );
    await shot('25-meta-fields.png');
    await clearAllRules();

    // ---- 扩展名智能分析：按文件头纠正错标、识别不出保持原名、模式互斥、真的走后端命令 ----
    await addRuleType('ext');
    const extSeg = await evaluate(`(() => {
      const seg = document.querySelector('[data-testid="ext-mode"]');
      if (!seg) return null;
      return {
        count: seg.querySelectorAll('span').length,
        labels: [...seg.querySelectorAll('span')].map((s) => s.textContent.trim()),
      };
    })()`);
    check(
      'UI',
      '扩展名模式分段新增「Analyze」，共 6 项',
      extSeg?.count === 6 && extSeg.labels.includes('Analyze'),
      JSON.stringify(extSeg),
    );

    // 按序点击第 n 项；点完必须重新 query —— React 会替换 DOM 节点，旧引用读到的是旧值
    const clickExtMode = async (index) => {
      await evaluate(`(() => {
        const seg = document.querySelector('[data-testid="ext-mode"]');
        if (!seg) throw new Error('找不到扩展名模式分段');
        seg.querySelectorAll('span')[${index}].click();
        return true;
      })()`);
      await sleep(600);
    };
    await clickExtMode(5);
    const analyzeOn = await evaluate(`(() => {
      const seg = document.querySelector('[data-testid="ext-mode"]');
      return {
        on: [...seg.querySelectorAll('span')].findIndex((s) => s.classList.contains('on')),
        hint: document.querySelector('[data-testid="ext-analyze-hint"]')?.textContent?.trim() || '',
      };
    })()`);
    check(
      'UI',
      '点「Analyze」后分段选中该项并给出文件头说明',
      analyzeOn.on === 5 && analyzeOn.hint.toLowerCase().includes('header'),
      JSON.stringify(analyzeOn),
    );

    const extSum = await evaluate(`document.querySelector('.rule-card.open .sum span')?.textContent?.trim() || ''`);
    check('UI', '规则摘要写明按文件头纠正扩展名', extSum.includes('header') && !extSum.includes('ruleSum.'), extSum);

    const extRows = await evaluate(`[...document.querySelectorAll('.trow')].map((r) => ({
      name: r.querySelector('.name-cell .txt')?.textContent || '',
      next: r.querySelector('.new-name')?.textContent?.trim() ?? null,
      unchanged: r.classList.contains('unchanged'),
    }))`);
    const extRow = (name) => extRows.find((r) => r.name === name);
    check(
      'UI',
      '错标 002.jpg（实为 PNG）被纠正为 .png',
      extRow('旧照片 002.jpg')?.next === '旧照片 002.png',
      JSON.stringify(extRow('旧照片 002.jpg')),
    );
    check(
      'UI',
      '扩展名本来就对（001.jpg）不动名且标记 unchanged',
      extRow('旧照片 001.jpg')?.next === '旧照片 001.jpg' && extRow('旧照片 001.jpg')?.unchanged === true,
      JSON.stringify(extRow('旧照片 001.jpg')),
    );
    check(
      'UI',
      '魔数识别不出（003.jpg）保持原名，绝不猜',
      extRow('旧照片 003.jpg')?.next === '旧照片 003.jpg' && extRow('旧照片 003.jpg')?.unchanged === true,
      JSON.stringify(extRow('旧照片 003.jpg')),
    );
    check(
      'UI',
      '错标 logo.png（实为 JPEG）被纠正为 .jpeg',
      extRow('logo.png')?.next === 'logo.jpeg',
      JSON.stringify(extRow('logo.png')),
    );
    await shot('28-ext-analyze.png');

    // 结果来自后端文件头嗅探，而不是前端按名字瞎猜
    const sniffCalls = await evaluate(`(window.__E2E__.calls || []).filter((c) => c && c.cmd === 'sniff_extensions').length`);
    check('UI-triggered mock', '启用 Analyze 后真的按需调用了 sniff_extensions', sniffCalls > 0, String(sniffCalls));

    // 模式互斥：切回「Case」后说明消失，行名跟随 Case 规则（不再按文件头纠正）
    await clickExtMode(0);
    const backToCase = await evaluate(`(() => ({
      on: [...document.querySelectorAll('[data-testid="ext-mode"] span')].findIndex((s) => s.classList.contains('on')),
      hint: Boolean(document.querySelector('[data-testid="ext-analyze-hint"]')),
      names: [...document.querySelectorAll('.trow .new-name')].map((e) => e.textContent.trim()),
    }))()`);
    check(
      'UI',
      '切回「Case」后 Analyze 说明消失且不再纠正扩展名',
      backToCase.on === 0 && backToCase.hint === false
        && backToCase.names.includes('旧照片 002.jpg') && !backToCase.names.includes('旧照片 002.png'),
      JSON.stringify(backToCase),
    );
    await clearAllRules();

    // ---- 移动子串：按位置 / 按标记定位、目标之前之后、缺标记不改名 ----
    await addRuleType('move');
    const moveUi = await evaluate(`(() => {
      const seg = document.querySelector('[data-testid="move-by"]');
      const ins = document.querySelector('[data-testid="move-insert"]');
      return {
        byOptions: seg ? [...seg.querySelectorAll('span')].map((s) => s.textContent.trim()) : null,
        byActive: seg ? [...seg.querySelectorAll('span')].find((s) => s.classList.contains('on'))?.textContent.trim() : null,
        insertOptions: ins ? [...ins.querySelectorAll('span')].map((s) => s.textContent.trim()) : null,
        insertActive: ins ? [...ins.querySelectorAll('span')].find((s) => s.classList.contains('on'))?.textContent.trim() : null,
        from: Boolean(document.querySelector('[data-testid="move-from"]')),
        markers: Boolean(document.querySelector('[data-testid="move-left"]')),
      };
    })()`);
    check(
      'UI',
      '移动规则提供定位方式（默认第一项=按位置）与插入到（默认第一项=目标之前）两处分段',
      moveUi?.byOptions?.length === 2
        && moveUi.byActive === moveUi.byOptions[0]
        && moveUi.insertOptions?.length === 2
        && moveUi.insertActive === moveUi.insertOptions[0]
        && moveUi.from === true
        && moveUi.markers === false,
      JSON.stringify(moveUi),
    );

    // 界面语言随 locale 变化，分段按序点第 n 个；点完单独回读激活项（React 重渲染后旧节点失效）
    const clickSeg = (testId, nth) => evaluate(`(() => {
      const seg = document.querySelector('[data-testid="${testId}"]');
      if (!seg) throw new Error('找不到分段 ${testId}');
      const items = [...seg.querySelectorAll('span')];
      if (!items[${nth}]) throw new Error('分段 ${testId} 只有 ' + items.length + ' 项');
      items[${nth}].click();
      return items.map((s) => s.textContent.trim());
    })()`);
    const segActive = (testId) => evaluate(`(() => {
      const seg = document.querySelector('[data-testid="${testId}"]');
      return seg ? [...seg.querySelectorAll('span')].findIndex((s) => s.classList.contains('on')) : -1;
    })()`);
    const moveSum = () => evaluate(`document.querySelector('.rule-card.open .sum span')?.textContent?.trim() || ''`);

    // 按位置：第 2 位起 2 个（照片）搬到第 1 位之前
    await setInput('[data-testid="move-from"]', '2');
    await setInput('[data-testid="move-count"]', '2');
    await setInput('[data-testid="move-to"]', '1');
    await sleep(700);
    const movedFront = await evaluate(rowByName('旧照片 001.jpg'));
    check('UI', '按位置移动：照片搬到最前 → 照片旧 001.jpg', movedFront?.name === '照片旧 001.jpg', JSON.stringify(movedFront));
    const posSum = await moveSum();
    check(
      'UI',
      '摘要写明起点、长度与落点（Move 2 chars … before character 1）',
      /Move 2 chars/i.test(posSum) && /before character 1/i.test(posSum),
      posSum,
    );

    // 同一 to=3：之前 / 之后插在不同位置
    await setInput('[data-testid="move-to"]', '3');
    await sleep(700);
    const beforeAt3 = await evaluate(rowByName('旧照片 001.jpg'));
    check('UI', '插到第 3 个字符之前 → 旧 照片001.jpg', beforeAt3?.name === '旧 照片001.jpg', JSON.stringify(beforeAt3));
    const afterSeg = await clickSeg('move-insert', 1);
    await sleep(700);
    const afterActiveIndex = await segActive('move-insert');
    const afterAt3 = await evaluate(rowByName('旧照片 001.jpg'));
    check(
      'UI',
      '改成「目标之后」后同一 to=3 落点右移一位 → 旧 0照片01.jpg',
      afterActiveIndex === 1 && afterAt3?.name === '旧 0照片01.jpg',
      JSON.stringify({ afterSeg, afterActiveIndex, afterAt3 }),
    );
    await shot('26-move-position.png');

    // 按标记：取「旧照」之后到结尾、不含起始标记，搬到第 1 位之前
    const byMarkerSeg = await clickSeg('move-by', 1);
    await sleep(250);
    const byMarkerActive = await segActive('move-by');
    const markerFields = await evaluate(`({
      left: Boolean(document.querySelector('[data-testid="move-left"]')),
      right: Boolean(document.querySelector('[data-testid="move-right"]')),
      index: Boolean(document.querySelector('[data-testid="move-from"]')),
    })`);
    check(
      'UI',
      '切到「按标记」后换成左右标记输入、按位置的起止输入隐藏',
      byMarkerActive === 1 && markerFields.left && markerFields.right && markerFields.index === false,
      JSON.stringify({ byMarkerSeg, byMarkerActive, markerFields }),
    );

    await setInput('[data-testid="move-left"]', '旧照');
    await setInput('[data-testid="move-right"]', '');
    await setInput('[data-testid="move-to"]', '1');
    await clickSeg('move-insert', 0);
    // 开关无 testid：标记模式下第一个开关就是「包含起始标记」（默认开），点它关掉后回读状态
    const includeStartLabel = await evaluate(`(() => {
      const row = document.querySelectorAll('.rule-detail .switch-row')[0];
      if (!row) throw new Error('找不到标记模式下的开关');
      const lbl = (row.querySelector('.lbl')?.textContent || '').trim();
      row.click();
      return lbl;
    })()`);
    await sleep(700);
    const includeStartOff = await evaluate(`document.querySelectorAll('.rule-detail .switch-row')[0]?.querySelector('.switch')?.getAttribute('aria-checked')`);
    const markerMoved = await evaluate(rowByName('旧照片 001.jpg'));
    check(
      'UI',
      '按标记移动：不包含起始标记时，旧照之后的内容 片 001 搬到开头',
      includeStartOff === 'false' && markerMoved?.name === '片 001旧照.jpg',
      JSON.stringify({ includeStartLabel, includeStartOff, markerMoved }),
    );
    const markerSumText = await moveSum();
    check(
      'UI',
      '摘要改用标记描述（「旧照」与结尾 Tail 之间的内容）',
      markerSumText.includes('旧照') && /end|结尾|末尾/i.test(markerSumText),
      markerSumText,
    );

    // 标记找不到时整条规则跳过，而不是拼出残缺名字
    await setInput('[data-testid="move-left"]', '不存在');
    await sleep(700);
    const markerMissing = await evaluate(rowByName('旧照片 001.jpg'));
    check(
      'UI',
      '标记在名字里找不到时该行保持原名并标记 unchanged',
      markerMissing?.name === '旧照片 001.jpg' && markerMissing.unchanged === true,
      JSON.stringify(markerMissing),
    );

    // 两个标记都空时规则卡就地报错
    await setInput('[data-testid="move-left"]', '');
    await sleep(700);
    const markerErr = await evaluate(`document.querySelector('.rule-error')?.textContent?.trim() || ''`);
    check(
      'UI',
      '两个标记都留空时规则卡就地报错（不静默整串搬运）',
      /at least one|至少要填/i.test(markerErr),
      markerErr,
    );
    await shot('27-move-markers.png');
    await clearAllRules();

    // ---- 删除规则：四模式语义（按位置 / 首尾之间 / 字符集 / 修剪）+ 从尾部数朝向 + 空标记拦截 ----
    await addRuleType('delete');
    const delSum = () => evaluate(`document.querySelector('.rule-card.open .sum span')?.textContent?.trim() || ''`);
    const delUi = await evaluate(`(() => {
      const seg = document.querySelector('[data-testid="delete-mode"]');
      return {
        options: seg ? [...seg.querySelectorAll('span')].map((s) => s.textContent.trim()) : null,
        active: seg ? [...seg.querySelectorAll('span')].find((s) => s.classList.contains('on'))?.textContent.trim() : null,
        trimChars: Boolean(document.querySelector('[data-testid="delete-trim-chars"]')),
        trimHint: document.querySelector('[data-testid="delete-trim-hint"]')?.textContent?.trim() || '',
        rangeFrom: Boolean(document.querySelector('[data-testid="delete-from"]')),
      };
    })()`);
    check(
      'UI',
      '删除规则有四处分段且默认落在「修剪」：同时出现修剪字符输入与说明，按位置的输入不出现',
      delUi?.options?.length === 4
        && delUi.active === delUi.options?.[3]
        && delUi.trimChars === true
        && delUi.trimHint.length > 0
        && delUi.rangeFrom === false,
      JSON.stringify(delUi),
    );

    // 默认修剪：夹具名首尾没有空白，应整批 unchanged，摘要写明剪空白
    const trimOnly = await evaluate(rowByName('旧照片 001.jpg'));
    const trimOnlySum = await delSum();
    check(
      'UI',
      '默认修剪不动无首尾空白的名字，摘要写明剪首尾空白',
      trimOnly?.unchanged === true && /whitespace/i.test(trimOnlySum),
      JSON.stringify({ trimOnly, trimOnlySum }),
    );

    // 按位置：第 1 个起删 2 个 → 旧照片 001 → 片 001
    await clickSeg('delete-mode', 0);
    await sleep(250);
    const rangeActive = await segActive('delete-mode');
    const rangeFields = await evaluate(`({
      from: Boolean(document.querySelector('[data-testid="delete-from"]')),
      count: Boolean(document.querySelector('[data-testid="delete-count"]')),
      fromEnd: Boolean(document.querySelector('[data-testid="delete-from-end"]')),
      hint: Boolean(document.querySelector('[data-testid="delete-from-end-hint"]')),
    })`);
    await setInput('[data-testid="delete-from"]', '1');
    await setInput('[data-testid="delete-count"]', '2');
    await sleep(700);
    const rangeRow = await evaluate(rowByName('旧照片 001.jpg'));
    check(
      'UI',
      '按位置删除：第 1 个字符起删 2 个 → 片 001.jpg，且「从尾部数」说明默认不显示',
      rangeActive === 0
        && rangeFields.from && rangeFields.count && rangeFields.fromEnd && rangeFields.hint === false
        && rangeRow?.name === '片 001.jpg',
      JSON.stringify({ rangeActive, rangeFields, rangeRow }),
    );
    const rangeSum = await delSum();
    check(
      'UI',
      '摘要写明按位置删除的起点与个数（Delete 2 chars from position 1）',
      /Delete 2 chars/i.test(rangeSum) && /position 1/i.test(rangeSum),
      rangeSum,
    );

    // 从尾部数：起点朝词尾。logo.png 倒数第 3 个起删 2 个 → lo.png（旧行为会给 og.png）
    await evaluate(`document.querySelector('[data-testid="delete-from-end"]').click()`);
    await sleep(300);
    const fromEndOn = await evaluate(`document.querySelector('[data-testid="delete-from-end"] .switch')?.getAttribute('aria-checked')`);
    const fromEndHint = await evaluate(`document.querySelector('[data-testid="delete-from-end-hint"]')?.textContent?.trim() || ''`);
    await setInput('[data-testid="delete-from"]', '3');
    await sleep(700);
    const tailRow = await evaluate(rowByName('logo.png'));
    check(
      'UI',
      '开启「从尾部数」后出现用法说明，且倒数第 3 个起删 2 个 → lo.png（起点朝词尾延伸）',
      fromEndOn === 'true' && fromEndHint.length > 0 && tailRow?.name === 'lo.png',
      JSON.stringify({ fromEndOn, fromEndHint, tailRow }),
    );
    check('UI', '从尾部数不会退回旧行为（旧窗口朝词首会给 og.png）', tailRow?.name !== 'og.png', String(tailRow?.name));
    const tailSum = await delSum();
    check(
      'UI',
      '摘要写明「从尾部数」并点明朝结尾方向',
      /counted from the end/i.test(tailSum) && /towards the end/i.test(tailSum),
      tailSum,
    );

    // 起点改回倒数第 1 个、个数 1：只删末尾那一个字符
    await setInput('[data-testid="delete-from"]', '1');
    await setInput('[data-testid="delete-count"]', '1');
    await sleep(700);
    const tailOne = await evaluate(rowByName('logo.png'));
    check('UI', '倒数第 1 个起删 1 个 → log.png（只动末尾）', tailOne?.name === 'log.png', JSON.stringify(tailOne));

    // 首尾之间：两个标记默认都含，全部关掉后只删中间
    await clickSeg('delete-mode', 1);
    await sleep(250);
    const betweenFields = await evaluate(`({
      left: Boolean(document.querySelector('[data-testid="delete-left"]')),
      right: Boolean(document.querySelector('[data-testid="delete-right"]')),
      includeLeft: document.querySelector('[data-testid="delete-include-left"] .switch')?.getAttribute('aria-checked'),
      includeRight: document.querySelector('[data-testid="delete-include-right"] .switch')?.getAttribute('aria-checked'),
      count: Boolean(document.querySelector('[data-testid="delete-count"]')),
    })`);
    await setInput('[data-testid="delete-left"]', '旧');
    await setInput('[data-testid="delete-right"]', '片');
    await evaluate(`document.querySelector('[data-testid="delete-include-left"]').click()`);
    await evaluate(`document.querySelector('[data-testid="delete-include-right"]').click()`);
    await sleep(700);
    const betweenInner = await evaluate(rowByName('旧照片 001.jpg'));
    check(
      'UI',
      '首尾之间默认两标记都含，关掉后只删中间 → 旧片 001.jpg',
      betweenFields.left && betweenFields.right && betweenFields.count === false
        && betweenFields.includeLeft === 'true' && betweenFields.includeRight === 'true'
        && betweenInner?.name === '旧片 001.jpg',
      JSON.stringify({ betweenFields, betweenInner }),
    );

    await evaluate(`document.querySelector('[data-testid="delete-include-left"]').click()`);
    await sleep(700);
    const betweenWithLeft = await evaluate(`({
      includeLeft: document.querySelector('[data-testid="delete-include-left"] .switch')?.getAttribute('aria-checked'),
      row: ${rowByName('旧照片 001.jpg')},
    })`);
    check(
      'UI',
      '重新勾上起始标记后连标记一起删 → 片 001.jpg',
      betweenWithLeft?.includeLeft === 'true' && betweenWithLeft?.row?.name === '片 001.jpg',
      JSON.stringify(betweenWithLeft),
    );

    // 两个标记都清空必须就地报错，而不是把整串删掉
    await setInput('[data-testid="delete-left"]', '');
    await setInput('[data-testid="delete-right"]', '');
    await sleep(700);
    const delMarkerErr = await evaluate(`document.querySelector('.rule-error')?.textContent?.trim() || ''`);
    const delMarkerRow = await evaluate(rowByName('旧照片 001.jpg'));
    check(
      'UI',
      '两个标记都留空时规则卡就地报错，且不会把名字整串删空',
      /at least one|至少要填/i.test(delMarkerErr) && delMarkerRow?.name === '旧照片 001.jpg',
      JSON.stringify({ delMarkerErr, delMarkerRow }),
    );
    await shot('28-delete-modes.png');

    // 字符集：删数字 / 只留数字
    await clickSeg('delete-mode', 2);
    await sleep(250);
    const charsetReachable = await evaluate(`Boolean(document.querySelector('[data-testid="delete-chars"]')) && Boolean(document.querySelector('[data-testid="delete-keep"]'))`);
    await setInput('[data-testid="delete-chars"]', '0123456789');
    await sleep(700);
    const charsetDrop = await evaluate(rowByName('旧照片 001.jpg'));
    check(
      'UI',
      '字符集模式有字符输入与「只保留」开关，删数字后 → 旧照片 .jpg',
      charsetReachable && charsetDrop?.name === '旧照片 .jpg',
      JSON.stringify({ charsetReachable, charsetDrop }),
    );
    await evaluate(`document.querySelector('[data-testid="delete-keep"]').click()`);
    await sleep(700);
    const charsetKeep = await evaluate(rowByName('旧照片 001.jpg'));
    check('UI', '打开「只保留」后 → 001.jpg', charsetKeep?.name === '001.jpg', JSON.stringify(charsetKeep));

    // 修剪：自定义修剪字符，只剪首尾、不动中间
    await clickSeg('delete-mode', 3);
    await sleep(250);
    await setInput('[data-testid="delete-trim-chars"]', '1');
    await sleep(700);
    const trimCharsRow = await evaluate(rowByName('旧照片 001.jpg'));
    const trimCharsSum = await delSum();
    const trimCharsHint = await evaluate(`document.querySelector('[data-testid="delete-trim-hint"]')?.textContent?.trim() || ''`);
    check(
      'UI',
      '自定义修剪字符 1：末位的 1 被剪掉 → 旧照片 00.jpg，摘要写明剪掉的字符',
      trimCharsRow?.name === '旧照片 00.jpg' && trimCharsSum.includes('1'),
      JSON.stringify({ trimCharsRow, trimCharsSum }),
    );
    check(
      'UI',
      '修剪说明改写为可自定义字符（不再是「只有空白」）',
      /character|字符|char/i.test(trimCharsHint) && trimCharsHint.length > 0,
      trimCharsHint,
    );
    await setInput('[data-testid="delete-trim-chars"]', '');
    await sleep(700);
    const trimBack = await evaluate(rowByName('旧照片 001.jpg'));
    check('UI', '清空修剪字符后回到只剪空白 → 名字不变', trimBack?.unchanged === true, JSON.stringify(trimBack));
    await clearAllRules();

    // 编号分组下拉与「按元数据取名」共用同一张字段表
    await addRuleType('number');
    const groupOpts = await evaluate(`(() => {
      const sel = document.querySelector('[data-testid="number-group"]');
      if (!sel) return null;
      return {
        groups: [...sel.querySelectorAll('optgroup')].map((g) => g.label),
        values: [...sel.querySelectorAll('option')].map((o) => o.value),
      };
    })()`);
    check(
      'UI',
      '编号分组下拉同步新增字段（field:iso / field:resolution / field:composer）',
      groupOpts?.groups.length === 3
        && ['field:iso', 'field:resolution', 'field:composer'].every((v) => groupOpts.values.includes(v)),
      JSON.stringify(groupOpts),
    );
    await clearAllRules();

    // ---- 命令列表：规则链 + 冲突策略存成一条命令（保存 / 持久化 / 运行 / 删除）----
    await addRuleType('replace');
    await setInput('[data-testid="replace-find"]', 'logo');
    await setInput('[data-testid="replace-with"]', 'LOGO');
    await click('[data-testid="toolbar-more"]');
    await waitFor(`document.querySelector('[data-testid="open-commands"]')`, '更多菜单·命令项', 6000);
    await click('[data-testid="open-commands"]');
    await waitFor(`document.querySelector('[data-testid="commands-dialog"]')`, '命令列表对话框', 6000);
    const cmdEmpty = await countOf('[data-testid="commands-empty"]');
    check('UI', '命令列表首次打开为空态（提示先排规则链再保存）', cmdEmpty === 1, `empty=${cmdEmpty}`);

    await setInput('[data-testid="commands-name"]', 'logo 大写归档');
    await click('[data-testid="commands-save"]');
    await sleep(400);
    const cmdItem = await evaluate(`(() => {
      const el = document.querySelector('[data-testid="commands-item"]');
      return el
        ? {
          name: el.getAttribute('data-command-name'),
          runs: el.getAttribute('data-command-runs'),
          policy: el.getAttribute('data-command-policy'),
          meta: el.querySelector('[data-testid="commands-meta"]')?.textContent || '',
        }
        : null;
    })()`);
    check(
      'UI',
      '保存命令：列表出现该命令，带规则数、冲突策略与运行次数',
      !!cmdItem && cmdItem.name === 'logo 大写归档' && cmdItem.runs === '0'
        && ['skip', 'suffix', 'overwrite'].includes(cmdItem.policy) && cmdItem.meta.includes('1'),
      JSON.stringify(cmdItem),
    );
    await shot('22-commands-dialog.png');

    // 持久化：重载后命令仍在（localStorage）
    await evaluate('location.reload()');
    await waitFor(`document.querySelectorAll('.trow').length >= 3`, '重载后的列表', 15000);
    await sleep(600);
    await click('[data-testid="toolbar-more"]');
    await waitFor(`document.querySelector('[data-testid="open-commands"]')`, '更多菜单·命令项（重载后）', 6000);
    await click('[data-testid="open-commands"]');
    await waitFor(`document.querySelector('[data-testid="commands-dialog"]')`, '命令列表对话框（重载后）', 6000);
    const cmdPersisted = await countOf('[data-testid="commands-item"]');
    check('UI', '命令重载后仍在（写入本地存储，不是会话内存）', cmdPersisted === 1, `items=${cmdPersisted}`);

    // 重载后勾选全部文件，保证「运行」有可执行行（预览只列被勾选的行）
    await evaluate(`(() => {
      for (const cb of [...document.querySelectorAll('.trow .checkbox')]) {
        if (cb.getAttribute('aria-checked') !== 'true') cb.click();
      }
      return true;
    })()`);
    await sleep(500);
    const selectedForRun = await evaluate(`document.querySelectorAll('.trow .checkbox[aria-checked="true"]').length`);

    // 运行：直接进入预览确认，不静默动文件
    await click('[data-testid="commands-run"]');
    await waitFor(`document.querySelector('[data-testid="preview-confirm"]')`, '命令运行后的预览确认', 8000);
    await sleep(800);
    const runState = await evaluate(`({
      dialog: !!document.querySelector('[data-testid="commands-dialog"]'),
      preview: !!document.querySelector('[data-testid="preview-confirm"]') || !!document.querySelector('[data-testid="preview-row"]'),
      rows: document.querySelectorAll('[data-testid="preview-row"]').length,
      summary: document.querySelector('[data-testid="preview-summary"]')?.textContent || '',
      sub: document.querySelector('[data-testid="preview-summary"]') ? '' : (document.querySelector('.dialog-head p')?.textContent || ''),
    })`);
    check(
      'UI',
      '运行命令 → 关闭命令列表并进入预览确认（不动文件）',
      !runState.dialog && runState.preview,
      JSON.stringify({ ...runState, selectedForRun }),
    );
    check(
      'UI',
      '运行命令后预览列出该命令产生变化的行',
      runState.rows > 0,
      JSON.stringify({ rows: runState.rows, selectedForRun, summary: runState.summary.slice(0, 60) }),
    );

    // 运行后：次数 +1，并按最近使用排到最前
    await evaluate(`document.querySelector('.modal-mask')?.click()`);
    await waitFor(`!document.querySelector('[data-testid="preview-confirm"]')`, '预览确认关闭', 4000);
    await sleep(500);
    await click('[data-testid="toolbar-more"]');
    await waitFor(`document.querySelector('[data-testid="open-commands"]')`, '更多菜单·命令项（运行后）', 6000);
    await click('[data-testid="open-commands"]');
    await waitFor(`document.querySelector('[data-testid="commands-dialog"]')`, '命令列表对话框（运行后）', 6000);
    const afterRun = await evaluate(`(() => {
      const el = document.querySelector('[data-testid="commands-item"]');
      return el ? { runs: el.getAttribute('data-command-runs'), meta: el.querySelector('[data-testid="commands-meta"]')?.textContent || '' } : null;
    })()`);
    check('UI', '运行后该命令记一次运行（次数 1、带上次运行时间）', !!afterRun && afterRun.runs === '1' && afterRun.meta.includes('1'), JSON.stringify(afterRun));

    // 删除：只删记录
    await click('[data-testid="commands-delete"]');
    await sleep(400);
    const cmdAfterDelete = await evaluate(`({
      items: document.querySelectorAll('[data-testid="commands-item"]').length,
      empty: document.querySelectorAll('[data-testid="commands-empty"]').length,
      stored: localStorage.getItem('renomio.commands'),
    })`);
    check('UI', '删除命令 → 列表回到空态且本地存储同步清空', cmdAfterDelete.items === 0 && cmdAfterDelete.empty === 1 && (cmdAfterDelete.stored === '[]' || cmdAfterDelete.stored === null), JSON.stringify(cmdAfterDelete));
    await evaluate(`document.querySelector('.modal-mask')?.click()`);
    await waitFor(`!document.querySelector('[data-testid="commands-dialog"]')`, '命令列表关闭', 4000);
    await sleep(400);

    // --- alpha10：列表手动顺序 / 重名 / 重复添加 / 属性编辑 ---
    await evaluate('location.reload()');
    await waitFor(`document.querySelectorAll('.trow').length >= 3`, '重载后的文件列表', 15000);
    await sleep(500);

    const rowNames = () => evaluate(`[...document.querySelectorAll('.trow .cell.name-cell .txt')].map((e) => e.textContent)`);
    const namesBefore = await rowNames();
    await click('[data-testid="row-down-0"]');
    await sleep(250);
    const namesAfterDown = await rowNames();
    const manualChip = await countOf('[data-testid="manual-order-chip"]');
    check(
      'UI',
      '列表「下移」立即改变顺序并出现手动顺序标记',
      namesAfterDown[0] === namesBefore[1] && namesAfterDown[1] === namesBefore[0] && manualChip === 1,
      JSON.stringify({ namesBefore, namesAfterDown, manualChip }),
    );
    await sleep(400);
    await evaluate('location.reload()');
    await waitFor(`document.querySelectorAll('.trow').length >= 3`, '重载后的文件列表 2', 15000);
    await sleep(500);
    const namesReloaded = await rowNames();
    check('UI', '手动顺序在重载后仍然保留（localStorage 会话）', JSON.stringify(namesReloaded) === JSON.stringify(namesAfterDown), JSON.stringify({ namesAfterDown, namesReloaded }));

    // 指针拖拽：按住第 1 行拖到第 3 行下缘（CDP 真实鼠标事件，走 pointer events）
    const dragFrom = await evaluate(`(() => {
      const r = document.querySelectorAll('.trow')[0].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    const dragTo = await evaluate(`(() => {
      const r = document.querySelectorAll('.trow')[2].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.bottom - 6 };
    })()`);
    // 先单击第 1 行把选择收敛成单行，否则重载前残留的多选会让整块拖动变成空操作
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragFrom.x, y: dragFrom.y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragFrom.x, y: dragFrom.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(220);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragFrom.x, y: dragFrom.y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragFrom.x, y: dragFrom.y + 10, button: 'left', buttons: 1 });
    await sleep(120);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragTo.x, y: dragTo.y, button: 'left', buttons: 1 });
    await sleep(180);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragTo.x, y: dragTo.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(350);
    const namesDragged = await rowNames();
    check(
      'UI',
      '拖拽手柄把第 1 行插入到第 3 行位置（非假排序）',
      namesDragged[0] === namesReloaded[1] && namesDragged[1] === namesReloaded[2] && namesDragged[2] === namesReloaded[0],
      JSON.stringify({ namesReloaded, namesDragged }),
    );

    // 重复添加：同路径忽略（不新增第二条）
    const firstPath = await evaluate(`window.__E2E__.files[0].path`);
    const beforeDupCount = await countOf('.trow');
    await evaluate(`window.__E2E__.emitDrag('drop', [${JSON.stringify(firstPath)}])`);
    await sleep(400);
    const afterDupCount = await countOf('.trow');
    const samePathRows = await evaluate(`[...document.querySelectorAll('.trow .cell.name-cell .txt')].filter((e) => e.textContent === '旧照片 001.jpg').length`);
    check('UI', '同一绝对路径重复添加被忽略（不产生第二条）', afterDupCount === beforeDupCount && samePathRows === 1, JSON.stringify({ beforeDupCount, afterDupCount, samePathRows }));

    // 同路径但 mtime/size 变化 → 就地更新该条
    // 用单元格结构定位「大小」列（`.cell.right .dims`）：列会随可用宽度收敛（SPEC §1.19），
    // 且此时界面可能处于非中文语言，不能按表头文字或写死下标取列
    const sizeCellText = () => evaluate(`(() => {
      const row = [...document.querySelectorAll('.trow')].find((r) => r.querySelector('.cell.name-cell .txt')?.textContent === '旧照片 001.jpg');
      return row?.querySelector('.cell.right .dims')?.textContent?.trim() ?? '';
    })()`);
    const sizeBeforeText = await sizeCellText();
    await evaluate(`window.__E2E__.files[0].size += 1048576`);
    await evaluate(`window.__E2E__.emitDrag('drop', [${JSON.stringify(firstPath)}])`);
    await sleep(400);
    const sizeAfterText = await sizeCellText();
    const updatedCount = await countOf('.trow');
    check('UI', '文件已被外部修改（size 变化）时就地更新该条而非新增', sizeAfterText !== sizeBeforeText && updatedCount === beforeDupCount, JSON.stringify({ sizeBeforeText, sizeAfterText, updatedCount }));

    // 同名不同路径：保留两条并标重名
    const sameName = 'D:\\e2e\\设计\\旧照片 001.jpg';
    await evaluate(`(() => {
      window.__E2E__.files.push({ path: ${JSON.stringify(sameName)}, size: 777, modified: 1740000000000, readonly: false, hidden: false, creation: 1735603200000 });
      return true;
    })()`);
    await evaluate(`window.__E2E__.emitDrag('drop', [${JSON.stringify(sameName)}])`);
    await sleep(400);
    const sameNameCount = await evaluate(`[...document.querySelectorAll('.trow .cell.name-cell .txt')].filter((e) => e.textContent === '旧照片 001.jpg').length`);
    const dupBadges = await evaluate(`document.querySelectorAll('[data-testid^="dup-name-"]').length`);
    check('UI', '同名不同路径保留两条并在界面标出重名', sameNameCount === 2 && dupBadges >= 2, JSON.stringify({ sameNameCount, dupBadges }));

    // 内容相同（不同路径）：疑似重复分组 + 一键去重（仅移除列表，不删文件）
    const dupA = 'D:\\e2e\\a\\dupA.jpg';
    const dupB = 'D:\\e2e\\b\\dupB.jpg';
    await evaluate(`(() => {
      const stamp = { size: 4096, modified: 1740000000000, readonly: false, hidden: false, creation: 1735603200000, content: 'same-content' };
      window.__E2E__.files.push({ ...stamp, path: ${JSON.stringify(dupA)} });
      window.__E2E__.files.push({ ...stamp, path: ${JSON.stringify(dupB)} });
      return true;
    })()`);
    await evaluate(`window.__E2E__.emitDrag('drop', [${JSON.stringify(dupA)}, ${JSON.stringify(dupB)}])`);
    await sleep(500);
    const dupPanelBefore = await countOf('[data-testid="dup-panel"]');
    const dupGroups = await countOf('[data-testid^="dup-group-"]');
    const filesOnDisk = await evaluate(`window.__E2E__.files.length`);
    const countBeforeDedupe = await countOf('.trow');
    check('UI', '内容相同的不同路径进入「疑似重复」分组，未静默删除', dupPanelBefore === 1 && dupGroups === 1, JSON.stringify({ dupPanelBefore, dupGroups }));
    await click('[data-testid="dup-dedupe"]');
    await sleep(400);
    const countAfterDedupe = await countOf('.trow');
    const filesAfterDedupe = await evaluate(`window.__E2E__.files.length`);
    check('UI', '一键去重只移除列表中的一条，磁盘文件数不变', countAfterDedupe === countBeforeDedupe - 1 && filesAfterDedupe === filesOnDisk, JSON.stringify({ countBeforeDedupe, countAfterDedupe, filesOnDisk, filesAfterDedupe }));
    if (await countOf('[data-testid="dup-close"]')) {
      await click('[data-testid="dup-close"]');
      await sleep(200);
    }

    // 属性编辑：支持格式 读 → 改 → 回读
    await evaluate(`(() => {
      [...document.querySelectorAll('.trow')].forEach((row) => {
        const txt = row.querySelector('.cell.name-cell .txt')?.textContent;
        if (!txt) return;
        const on = row.querySelector('.checkbox.on');
        if (on && txt !== '旧照片 002.jpg') on.click();
        if (!on && txt === '旧照片 002.jpg') row.querySelector('.checkbox').click();
      });
      return true;
    })()`);
    await sleep(200);
    await click('[data-testid="edit-meta"]');
    await waitFor(`document.querySelector('[data-testid="meta-edit-dialog"]')`, '属性编辑弹窗', 8000);
    await sleep(400);
    const iptcNote = await evaluate(`(() => {
      const el = document.querySelector('[data-testid="meta-iptc-note"]');
      return { shown: !!el, text: el?.textContent?.trim() || '' };
    })()`);
    check('UI', 'JPEG 属性编辑：显示 IPTC-IIM 双写说明', iptcNote.shown && iptcNote.text.includes('IPTC-IIM') && iptcNote.text.length > 20, JSON.stringify(iptcNote));
    await click('[data-testid="meta-field-title-check"]');
    await setInput('[data-testid="meta-field-title-input"]', 'E2E 新标题');
    await click('[data-testid="meta-apply"]');
    await waitFor(`document.querySelector('[data-testid="meta-result-0"]')`, '属性写入结果', 8000);
    const metaResult = await evaluate(`(() => {
      const el = document.querySelector('[data-testid="meta-result-0"]');
      return { text: el.textContent, ok: el.className.includes('ok'), verified: el.textContent.includes('回读') || el.textContent.includes('verified') };
    })()`);
    check('UI', '属性编辑：选中字段写入并回读校验通过', metaResult.ok && metaResult.verified, JSON.stringify(metaResult));
    await click('[data-testid="meta-close"]');
    await sleep(200);
    await click('[data-testid="edit-meta"]');
    await waitFor(`document.querySelector('[data-testid="meta-edit-dialog"]')`, '属性编辑弹窗 2', 8000);
    await sleep(400);
    const rereadTitle = await evaluate(`document.querySelector('[data-testid="meta-field-title-input"]')?.value`);
    check('UI', '属性编辑：重新打开可见写入后的值', rereadTitle === 'E2E 新标题', JSON.stringify({ rereadTitle }));
    await click('[data-testid="meta-close"]');
    await sleep(200);

    // 不支持格式：明确拒绝并给出文件与原因
    const heicPath = 'D:\\e2e\\旅行\\sample.heic';
    await evaluate(`(() => {
      window.__E2E__.files.push({ path: ${JSON.stringify(heicPath)}, size: 2048, modified: 1740000000000, readonly: false, hidden: false, creation: 1735603200000 });
      return true;
    })()`);
    await evaluate(`window.__E2E__.emitDrag('drop', [${JSON.stringify(heicPath)}])`);
    await sleep(400);
    await evaluate(`(() => {
      [...document.querySelectorAll('.trow')].forEach((row) => {
        const on = row.querySelector('.checkbox.on');
        if (on) on.click();
      });
      const row = [...document.querySelectorAll('.trow')].find((r) => r.querySelector('.cell.name-cell .txt')?.textContent === 'sample.heic');
      if (row) row.querySelector('.checkbox').click();
      return true;
    })()`);
    await sleep(200);
    await click('[data-testid="edit-meta"]');
    await waitFor(`document.querySelector('[data-testid="meta-edit-dialog"]')`, 'HEIC 属性弹窗', 8000);
    await sleep(300);
    const unsupportedShown = await countOf('[data-testid="meta-unsupported"]');
    const heicIptcNote = await countOf('[data-testid="meta-iptc-note"]');
    check('UI', '不支持的格式不显示 IPTC-IIM 说明（避免误导）', heicIptcNote === 0, JSON.stringify({ heicIptcNote }));
    await click('[data-testid="meta-apply"]');
    await waitFor(`document.querySelector('[data-testid="meta-result-0"]')`, 'HEIC 拒绝结果', 8000);
    const heicResult = await evaluate(`(() => {
      const el = document.querySelector('[data-testid="meta-result-0"]');
      return { bad: el.className.includes('bad'), text: el.textContent };
    })()`);
    check('UI', '不支持格式（HEIC）明确拒绝并附文件与原因', unsupportedShown === 1 && heicResult.bad && heicResult.text.includes('HEIC'), JSON.stringify({ unsupportedShown, heicResult }));
    await click('[data-testid="meta-close"]');
    await sleep(200);

    // --- 4) 设置页「检查更新」按钮显隐状态机 ---
    await openSettings();
    await waitFor(`document.querySelector('[data-testid="update-settings"]')`, '设置页更新区块', 8000);
    await sleep(300);

    const updateButtons = () => evaluate(`(() => ({
      phase: document.querySelector('[data-testid="update-settings"]').getAttribute('data-phase'),
      check: document.querySelectorAll('[data-testid="update-check"]').length,
      action: document.querySelectorAll('[data-testid="update-action"]').length,
      save: document.querySelectorAll('[data-testid="update-save"]').length,
      home: document.querySelectorAll('[data-testid="update-home"]').length,
      retry: document.querySelectorAll('[data-testid="update-retry"]').length,
      latest: document.querySelectorAll('[data-testid="update-latest"]').length,
      install: document.querySelectorAll('[data-testid="update-install"]').length,
      size: document.querySelectorAll('[data-testid="update-size"]').length,
      error: document.querySelectorAll('[data-testid="update-error"]').length,
    }))()`);

    const idle = await updateButtons();
    check('UI', '未检查：只显示「检查更新」「打开主页」', idle.phase === 'idle' && idle.check === 1 && idle.home === 1 && idle.action === 0 && idle.save === 0 && idle.latest === 0, JSON.stringify(idle));

    // 失败：只给错误与重试
    await evaluate(`window.__E2E__.updateMode = 'error'`);
    await click('[data-testid="update-check"]');
    await sleep(500);
    const failed = await updateButtons();
    check('UI', '检查失败：只给错误说明与重试', failed.phase === 'error' && failed.error === 1 && failed.retry === 1 && failed.check === 0 && failed.action === 0 && failed.save === 0 && failed.home === 0, JSON.stringify(failed));

    // 重试 → 已是最新
    await evaluate(`window.__E2E__.updateMode = 'latest'`);
    await click('[data-testid="update-retry"]');
    await sleep(500);
    const latest = await updateButtons();
    check('UI', '已是最新：显示「当前已是最新版本」且无更新/仅下载', latest.phase === 'latest' && latest.latest === 1 && latest.action === 0 && latest.save === 0 && latest.check === 1, JSON.stringify(latest));

    // 发现新版本：更新 + 仅下载 + 版本/大小/来源
    await evaluate(`window.__E2E__.updateMode = 'available'`);
    await click('[data-testid="update-check"]');
    await sleep(500);
    const available = await updateButtons();
    check('UI', '发现新版本：出现「更新」「仅下载」并展示大小', available.phase === 'available' && available.action === 1 && available.save === 1 && available.size === 1 && available.install === 0, JSON.stringify(available));

    // 仅下载 → 保存后出现「安装」
    await click('[data-testid="update-save"]');
    await sleep(600);
    const savedState = await updateButtons();
    check('UI', '仅下载后出现「安装」（校验通过的包）', savedState.install === 1, JSON.stringify(savedState));

    // 之后检查变为已最新，安装按钮仍保留
    await evaluate(`window.__E2E__.updateMode = 'latest'`);
    await click('[data-testid="update-check"]');
    await sleep(500);
    const retained = await updateButtons();
    check('UI', '之后显示已最新时仍保留「安装」按钮', retained.phase === 'latest' && retained.latest === 1 && retained.install === 1 && retained.action === 0, JSON.stringify(retained));

    // --- 5) 设置页「设置文件（.ini）」导入导出（演示模式禁用但必须可见且文案本地化） ---
    const fileSection = await evaluate(`(() => {
      const sec = document.querySelector('[data-testid="settings-file"]');
      if (!sec) return null;
      const exp = sec.querySelector('[data-testid="settings-export"]');
      const imp = sec.querySelector('[data-testid="settings-import"]');
      const note = sec.querySelector('.drawer-note');
      const expRect = exp?.getBoundingClientRect();
      const impRect = imp?.getBoundingClientRect();
      return {
        export: !!exp,
        import: !!imp,
        exportDisabled: exp?.disabled === true,
        importDisabled: imp?.disabled === true,
        exportLabel: exp?.textContent?.trim() ?? '',
        importLabel: imp?.textContent?.trim() ?? '',
        stacked: !!expRect && !!impRect && impRect.top > expRect.top,
        rawKeys: sec.innerText.includes('settings.file') || sec.innerText.includes('toast.settings'),
        note: note?.textContent?.trim() ?? '',
      };
    })()`);
    check('UI', '设置页有「设置文件」分区，导出/导入两个按钮都在', fileSection?.export === true && fileSection?.import === true, JSON.stringify(fileSection));
    check('UI', '设置文件：两项分行排布且标签非空', fileSection?.stacked === true && fileSection.exportLabel.length > 0 && fileSection.importLabel.length > 0, JSON.stringify(fileSection));
    check('UI', '设置文件：文案已本地化（无原始 i18n key）且附说明', fileSection && !fileSection.rawKeys && fileSection.note.length > 0, JSON.stringify(fileSection));

    // 点「导出」：必须真的调到 settings_to_ini 命令；这条链在这个 mock 下拿不到结果时只能给失败提示，不许假装成功
    if (await evaluate(`Boolean(document.querySelector('[data-testid="toast"]'))`)) {
      await click('[data-testid="toast"]');
      await sleep(250);
    }
    await click('[data-testid="settings-export"]');
    await waitFor(`document.querySelector('[data-testid="toast"]')`, '设置导出提示', 6000);
    const exportToast = await evaluate(`(() => {
      const el = document.querySelector('[data-testid="toast"]');
      return { kind: el?.className ?? '', text: el?.querySelector('[data-testid="toast-text"]')?.textContent ?? '' };
    })()`);
    check(
      'UI',
      '导出入口给出失败提示而非假成功（命令链未接通时不许声称已导出）',
      exportToast.kind.includes('error') || exportToast.kind.includes('warn'),
      JSON.stringify(exportToast),
    );
    const exportEnabledAgain = await evaluate(`document.querySelector('[data-testid="settings-export"]')?.disabled === false`);
    check('UI', '导出失败后按钮恢复可用（不卡在忙状态）', exportEnabledAgain === true, String(exportEnabledAgain));
    await click('[data-testid="toast"]');
    await sleep(150);
    const importReady = await evaluate(`document.querySelector('[data-testid="settings-import"]')?.disabled === false`);
    check('UI', '导入按钮可点击（文件选择由系统对话框承担）', importReady === true, String(importReady));

    // --- 6) 设置页「数据自检与修复」（6.15）：只读检查 + 不删数据的修复 ---
    const repairSection = await evaluate(`(() => {
      const sec = document.querySelector('[data-testid="repair-section"]');
      if (!sec) return null;
      const chk = sec.querySelector('[data-testid="repair-check"]');
      const fix = sec.querySelector('[data-testid="repair-fix"]');
      const chkRect = chk?.getBoundingClientRect();
      const fixRect = fix?.getBoundingClientRect();
      const note = sec.querySelector('.drawer-note');
      return {
        check: !!chk,
        fix: !!fix,
        checkLabel: chk?.textContent?.trim() ?? '',
        fixLabel: fix?.textContent?.trim() ?? '',
        stacked: !!chkRect && !!fixRect && fixRect.top > chkRect.top,
        rawKeys: sec.innerText.includes('settings.repair') || sec.innerText.includes('toast.repair'),
        notes: sec.querySelectorAll('.drawer-note').length,
        results: document.querySelectorAll('[data-testid="repair-report"]').length,
        noteText: note?.textContent?.trim() ?? '',
      };
    })()`);
    check('UI', '设置页有「数据自检与修复」分区，检查/修复两个按钮都在', repairSection?.check === true && repairSection?.fix === true, JSON.stringify(repairSection));
    check('UI', '自检分区：两项分行排布且标签非空', repairSection?.stacked === true && repairSection.checkLabel.length > 0 && repairSection.fixLabel.length > 0, JSON.stringify(repairSection));
    check('UI', '自检分区：文案已本地化（无原始 i18n key）', repairSection && !repairSection.rawKeys, JSON.stringify(repairSection));
    check('UI', '自检分区：未点击时不平白显示结果块', repairSection?.results === 0, JSON.stringify(repairSection));

    if (await evaluate(`Boolean(document.querySelector('[data-testid="toast"]'))`)) {
      await click('[data-testid="toast"]');
      await sleep(200);
    }
    await click('[data-testid="repair-check"]');
    await sleep(600);
    const repairAfterCheck = await evaluate(`(() => {
      const el = document.querySelector('[data-testid="toast"]');
      const report = document.querySelector('[data-testid="repair-report"]');
      return {
        toast: el ? (el.className + ' | ' + (el.querySelector('[data-testid="toast-text"]')?.textContent ?? '')) : '',
        report: report ? { ok: report.dataset.ok, severity: report.dataset.severity, findings: report.querySelectorAll('[data-testid="repair-finding"]').length } : null,
        rawKeys: document.body.innerText.includes('settings.repair') || document.body.innerText.includes('toast.repair'),
      };
    })()`);
    check(
      'UI',
      '点「开始检查」要么给出真实报告，要么明确失败；不许两者都没有',
      repairAfterCheck.report !== null || repairAfterCheck.toast.length > 0,
      JSON.stringify(repairAfterCheck),
    );
    check('UI', '自检结果里不出现原始 i18n key', repairAfterCheck.rawKeys === false, JSON.stringify(repairAfterCheck));
    const repairEnabledAgain = await evaluate(`(() => {
      const chk = document.querySelector('[data-testid="repair-check"]');
      const fix = document.querySelector('[data-testid="repair-fix"]');
      return chk?.disabled === false && fix?.disabled === false;
    })()`);
    check('UI', '自检结束后两个按钮都恢复可用（不卡在忙状态）', repairEnabledAgain === true, String(repairEnabledAgain));
    if (await evaluate(`Boolean(document.querySelector('[data-testid="toast"]'))`)) {
      await click('[data-testid="toast"]');
      await sleep(150);
    }

    // --- 快照：生成（哈希默认关）/ 预览 / 冲突跳过不覆盖 / 还原可撤销 ---
    await evaluate('localStorage.clear()');
    await send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/index.html?lang=zh-CN` });
    await waitFor(`document.querySelector('.win')`, '快照测试重载', 15000);
    await sleep(400);
    await click('[data-testid="add-files"]');
    await waitFor(`document.querySelectorAll('.trow').length === 4`, '快照测试：4 个文件', 10000);
    await click('[data-testid="add-rule"]');
    await waitFor(`document.querySelector('[data-testid="rule-type-replace"]')`, '快照规则菜单');
    await click('[data-testid="rule-type-replace"]');
    await waitFor(`document.querySelectorAll('[data-testid="rule-card"]').length === 1`, '快照替换规则');
    await setInput('.rule-detail .input', '旧照片 ', 0);
    await setInput('.rule-detail .input', '照片_', 1);
    await waitFor(`document.querySelector('.trow')?.textContent.includes('照片_001')`, '快照预览生效');

    await click('[data-testid="nav-snapshot"]');
    await waitFor(`document.querySelector('[data-testid="snapshot-dialog"]')`, '快照窗打开');
    const hashDefault = await evaluate(`document.querySelector('[data-testid="snapshot-hash"]')?.checked`);
    check('UI', '快照：入口真实可用且哈希复选框默认关闭', hashDefault === false, String(hashDefault));
    await click('[data-testid="snapshot-create"]');
    await waitFor(`document.querySelector('[data-testid^="snapshot-item-"]')`, '快照生成完成', 15000);
    const snap1 = await evaluate(`window.__E2E__.snapshots[0]`);
    check(
      'UI',
      '快照（仅映射）→ 记录 3 条原名/新名与大小/时间，不含哈希',
      snap1?.entryCount === 3 && snap1?.hashed === 0 && snap1?.entries?.every((e) => e.sha256 === undefined),
      JSON.stringify({ entryCount: snap1?.entryCount, hashed: snap1?.hashed }),
    );
    const snapHashText = await textOf('[data-testid="snapshot-item-mock-snap-1"]');
    check('UI', '快照列表显示「仅映射」', snapHashText.includes('仅映射'), snapHashText.slice(0, 80));
    await shot('27-snapshot-created.png');

    // 勾选哈希：重新生成一条带 SHA-256 的快照
    await click('[data-testid="snapshot-hash"]');
    const hashOn = await evaluate(`document.querySelector('[data-testid="snapshot-hash"]')?.checked`);
    check('UI', '快照：勾选后开启 SHA-256', hashOn === true, String(hashOn));
    await click('[data-testid="snapshot-create"]');
    await waitFor(`document.querySelectorAll('[data-testid^="snapshot-item-"]').length === 2`, '带哈希快照生成', 15000);
    const snap2 = await evaluate(`window.__E2E__.snapshots[0]`);
    check(
      'UI',
      '快照（含哈希）→ 3 条 SHA-256 且逐条上报进度',
      snap2?.hashed === 3 && snap2.entries.every((e) => typeof e.sha256 === 'string' && e.sha256.length === 64),
      JSON.stringify({ id: snap2?.id, hashed: snap2?.hashed }),
    );
    const progressPhases = await evaluate(`[...new Set(window.__E2E__.snapshotProgressEvents.map((e) => e.phase))]`);
    check('UI', '快照生成 → 进度事件可取消/可观测（hash/done）', progressPhases.includes('hash') && progressPhases.includes('done'), progressPhases.join(','));

    // 预览（尚未执行改名）：应提示「文件已在原名」，不伪造还原
    await click('[data-testid="snapshot-preview-mock-snap-2"]');
    await waitFor(`document.querySelector('[data-testid="snapshot-plan"]')`, '未改名时的还原预览');
    const prePlanText = await textOf('[data-testid="snapshot-plan"]');
    check('UI', '还原预览（未改名）→ 3 条均已在原名，不误报', prePlanText.includes('将还原 0 条') && prePlanText.includes('文件已在原名'), prePlanText.slice(0, 120));
    await shot('28-snapshot-preview-before.png');
    await click('[data-testid="snapshot-close"]');
    await sleep(200);

    // 先执行改名，再还原
    await click('[data-testid="action-preview"]');
    await waitFor(`document.querySelector('[data-testid="preview-confirm"]')`, '快照场景执行预览');
    await click('[data-testid="preview-confirm"]');
    await waitFor(`window.__E2E__.files.some((f) => f.path.endsWith('照片_001.jpg'))`, '改名完成');
    await waitFor(`!document.querySelector('[data-testid="apply-progress"]')`, '改名进度结束');
    await sleep(300);

    // 改名后预览：3 条将还原（含哈希校验标记）
    await click('[data-testid="nav-snapshot"]');
    await waitFor(`document.querySelector('[data-testid="snapshot-dialog"]')`, '改名后的快照窗');
    await click('[data-testid="snapshot-preview-mock-snap-2"]');
    await waitFor(`document.querySelector('[data-testid="snapshot-plan"]')`, '还原预览');
    const snapPlanText = await textOf('[data-testid="snapshot-plan"]');
    check('UI', '还原预览 → 3 条将还原 + 执行时校验哈希', snapPlanText.includes('将还原 3 条') && snapPlanText.includes('SHA-256'), snapPlanText.slice(0, 120));
    await shot('29-snapshot-preview.png');
    await click('[data-testid="snapshot-close"]');
    await sleep(200);

    // 原位置放入「诱饵」文件 → 还原必须跳过且不覆盖
    await evaluate(`(() => {
      window.__E2E__.files.push({ path: 'D:\\\\e2e\\\\旅行\\\\旧照片 001.jpg', size: 12345, modified: 1750000000000, readonly: false, hidden: false, creation: 1750000000000 });
      return true;
    })()`);
    await click('[data-testid="nav-snapshot"]');
    await waitFor(`document.querySelector('[data-testid="snapshot-dialog"]')`, '快照窗再次打开');
    await click('[data-testid="snapshot-preview-mock-snap-2"]');
    await waitFor(`document.querySelector('[data-testid="snapshot-plan"]')`, '冲突预览');
    const conflictPlan = await textOf('[data-testid="snapshot-plan"]');
    check(
      'UI',
      '还原预览 → 原位置被占用时标记跳过（2 条将还原）',
      conflictPlan.includes('将还原 2 条') && conflictPlan.includes('原位置已被占用'),
      conflictPlan.slice(0, 140),
    );
    await click('[data-testid="snapshot-restore-confirm"]');
    await waitFor(`document.querySelector('[data-testid="snapshot-result"]')`, '还原结果面板', 15000);
    const restoreRes = await evaluate(`window.__E2E__.batches[0]`);
    check(
      'UI',
      '还原执行 → 2 条还原、1 条跳过，批次 kind=restore 且 policy=skip',
      restoreRes?.kind === 'restore' && restoreRes?.counts?.done === 2 && restoreRes?.counts?.skipped >= 1 && restoreRes?.policy === 'skip',
      JSON.stringify(restoreRes?.counts),
    );
    const afterRestoreFiles = await evaluate(`window.__E2E__.files.map((f) => f.path.split('\\\\').pop())`);
    const decoyIntact = await evaluate(`(() => {
      const f = window.__E2E__.files.find((x) => x.path.endsWith('旧照片 001.jpg'));
      return f ? f.size : -1;
    })()`);
    check(
      'UI',
      '还原绝不覆盖：诱饵文件保持原样，冲突条目的新名文件仍在',
      decoyIntact === 12345 && afterRestoreFiles.includes('照片_001.jpg') && afterRestoreFiles.includes('旧照片 002.jpg'),
      JSON.stringify({ decoyIntact, afterRestoreFiles }),
    );
    const resultText = await textOf('[data-testid="snapshot-result"]');
    check('UI', '还原结果逐条说明跳过原因', resultText.includes('原位置已被') && resultText.includes('已还原'), resultText.slice(0, 160));
    await shot('29b-snapshot-restored.png');
    await click('[data-testid="snapshot-close"]');
    await sleep(200);

    // 还原批次可撤销
    await click('[data-testid="nav-history"]');
    await waitFor(`document.querySelector('[data-testid="history-item"]')`, '还原后的操作记录');
    const restoreHistory = await evaluate(`(() => {
      const i = document.querySelector('[data-testid="history-item"]');
      return { text: i?.textContent || '', undoable: i?.dataset.undoable };
    })()`);
    check('UI', '操作记录把还原标为「快照还原」且可撤销', restoreHistory.text.includes('快照还原') && restoreHistory.undoable === '1', restoreHistory.text.slice(0, 90));
    await click('[data-testid="undo-batch"]');
    await waitFor(`window.__E2E__.batches[0]?.state === 'undone'`, '撤销还原批次');
    const afterUndoRestore = await evaluate(`window.__E2E__.files.map((f) => f.path.split('\\\\').pop())`);
    check('UI', '撤销还原 → 2 条回到新名（冲突条目不受影响）', afterUndoRestore.includes('照片_002.jpg') && afterUndoRestore.includes('照片_003.jpg') && afterUndoRestore.includes('照片_001.jpg'), JSON.stringify(afterUndoRestore));
    await shot('30-snapshot-undo.png');
    await click('.drawer-mask');
    await sleep(250);

    // 删除快照
    await click('[data-testid="nav-snapshot"]');
    await waitFor(`document.querySelector('[data-testid="snapshot-dialog"]')`, '删除前的快照窗');
    await click('[data-testid="snapshot-delete-mock-snap-1"]');
    await waitFor(`window.__E2E__.snapshots.length === 1`, '删除快照');
    const remainingSnapshots = await evaluate(`document.querySelectorAll('[data-testid^="snapshot-item-"]').length`);
    check('UI', '删除快照 → 列表与后端同步只剩 1 条', remainingSnapshots === 1, String(remainingSnapshots));
    await click('[data-testid="snapshot-close"]');
    await sleep(200);

    // ---- 图片信息 → EXIF 清除：预览 → 分组清除 → 回读 → 还原（检查器内真实执行） ----
    const exifFixturePath = await evaluate(`(() => {
      const jpg = window.__E2E__.files.find((f) => f.path.toLowerCase().endsWith('.jpg')).path;
      window.__E2E__.exif = {
        [jpg]: {
          format: 'JPEG', orientation: 6, icc: true, xmp: true,
          groups: [
            { id: 'gps', label: 'GPS 定位', items: ['GPSLatitude=31.230400N', 'GPSLongitude=121.473700E'] },
            { id: 'camera', label: '相机与镜头', items: ['Make=Canon', 'Model=EOS R6', 'LensModel=RF24-70mm F2.8'] },
            { id: 'time', label: '拍摄时间', items: ['DateTimeOriginal=2024:05:01 10:20:30'] },
            { id: 'thumbnail', label: '缩略图', items: ['JPEGInterchangeFormat=1234'] },
          ],
        },
      };
      return jpg;
    })()`);
    const exifFileName = exifFixturePath.split(/[\\\\/]/).pop();
    await sleep(300);
    // 检查器只会作用于勾选文件：清空勾选后只勾这一张带 EXIF 的 jpg
    const exifSelBefore = await evaluate(`document.querySelectorAll('.trow .checkbox[aria-checked="true"]').length`);
    if (exifSelBefore > 0) {
      const exifAllOn = await evaluate(`document.querySelector('.thead .checkbox')?.getAttribute('aria-checked') === 'true'`);
      await click('.thead .checkbox');
      await sleep(300);
      if (!exifAllOn) {
        await click('.thead .checkbox');
        await sleep(300);
      }
    }
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.trow')].find((r) => r.textContent.includes(${JSON.stringify(exifFileName)}));
      const cb = row?.querySelector('.checkbox');
      if (cb && cb.getAttribute('aria-checked') !== 'true') cb.click();
      return true;
    })()`);
    await sleep(300);
    const exifChecked = await evaluate(`document.querySelectorAll('.trow .checkbox[aria-checked="true"]').length`);
    await openInspectorMode('exif');
    await waitFor(`document.querySelector('[data-testid="inspector"][data-mode="exif"]')`, 'EXIF 检查器', 5000);
    await waitFor(`document.querySelector('[data-testid="exif-panel"]')`, 'EXIF 清除面板', 4000);
    const exifScopeOk = await evaluate(`document.querySelector('[data-testid="inspector-scope"]')?.textContent || ''`);
    check('UI', '勾选一张图片后 EXIF 入口在检查器里可用（作用于勾选文件）', exifChecked === 1 && exifScopeOk.includes('1'), `${exifChecked} / ${exifScopeOk}`);
    await click('[data-testid="exif-preview"]');
    await waitFor(`document.querySelector('[data-testid="exif-file-0"]')`, 'EXIF 预览结果', 5000);
    const exifPreview = await evaluate(`(() => ({
      groups: [...document.querySelectorAll('[data-testid^="exif-group-0-"]')].map((n) => n.getAttribute('data-testid')),
      orientation: document.querySelector('[data-testid="exif-orientation-0"]')?.textContent || '',
      icc: document.querySelector('[data-testid="exif-icc-0"]')?.textContent || '',
      xmp: document.querySelector('[data-testid="exif-xmp-badge-0"]')?.textContent || '',
      protect: document.querySelector('[data-testid="exif-protect"]')?.textContent || '',
    }))()`);
    check(
      'UI',
      'EXIF 预览按文件列出实际存在项，并明确标注 Orientation / ICC / XMP 的处理方式',
      exifPreview.groups.length === 4 && exifPreview.orientation.includes('Orientation') && exifPreview.icc.length > 0 && exifPreview.xmp.length > 0 && exifPreview.protect.includes('ICC'),
      JSON.stringify(exifPreview),
    );
    await click('[data-testid="exif-scope-gps"]');
    await sleep(250);
    const applyDisabled = await evaluate(`document.querySelector('[data-testid="exif-apply"]').disabled`);
    check('UI', '改变清除范围后预览失效，执行按钮回到禁用（必须先重新预览）', applyDisabled === true, String(applyDisabled));
    await click('[data-testid="exif-preview"]');
    await waitFor(`document.querySelector('[data-testid="exif-remove-0"]')`, 'EXIF 移除清单', 4000);
    const removeList = await evaluate(`document.querySelector('[data-testid="exif-remove-0"]').textContent`);
    check('UI', '勾选 GPS → 预览按文件列出将移除的具体项（GPSLatitude / GPSLongitude）', removeList.includes('GPSLatitude') && removeList.includes('GPSLongitude'), removeList.slice(0, 120));
    await click('[data-testid="exif-apply"]');
    await waitFor(`document.querySelector('[data-testid="exif-results"]')`, 'EXIF 清除结果', 6000);
    await waitFor(`!document.querySelector('[data-testid="exif-group-0-gps"]')`, 'GPS 组从预览中消失', 6000);
    const exifResult = await evaluate(`(() => ({
      ok: !!document.querySelector('[data-testid="exif-result-0"].ok'),
      meta: document.querySelector('[data-testid="exif-result-meta-0"]')?.textContent || '',
      restore: !!document.querySelector('[data-testid="exif-restore-0"]'),
      gpsGone: !document.querySelector('[data-testid="exif-group-0-gps"]'),
      groupsAfter: window.__E2E__.exif[Object.keys(window.__E2E__.exif)[0]].groups.map((g) => g.id),
      orientationAfter: window.__E2E__.exif[Object.keys(window.__E2E__.exif)[0]].orientation,
      iccAfter: window.__E2E__.exif[Object.keys(window.__E2E__.exif)[0]].icc,
    }))()`);
    check(
      'UI',
      'EXIF 清除后回读：GPS 组消失，Orientation 与 ICC 保留，结果含像素比对与还原按钮',
      exifResult.ok
        && exifResult.gpsGone
        && !exifResult.groupsAfter.includes('gps')
        && exifResult.groupsAfter.includes('camera')
        && exifResult.orientationAfter === 6
        && exifResult.iccAfter === true
        && exifResult.meta.includes('Orientation')
        && exifResult.restore,
      JSON.stringify(exifResult),
    );
    await click('[data-testid="exif-restore-0"]');
    await sleep(400);
    const exifRestoreCall = await evaluate(`window.__E2E__.calls.some((c) => c.cmd === 'meta_restore_backup')`);
    check('UI', 'EXIF 清除结果提供还原按钮，并走已有备份还原通路（meta_restore_backup）', exifRestoreCall, String(exifRestoreCall));
    await click('[data-testid="inspector-close"]');
    await waitFor(`!document.querySelector('[data-testid="inspector"]')`, '关闭 EXIF 检查器');
    await sleep(250);

    // ---- 文本编码：探测未知编码 → 强制手动指定源编码 → 原地覆盖 + 回读校验 + 还原 ----
    const txtPath = await evaluate(`(() => {
      const p = 'D:\\\\e2e\\\\旅行\\\\编码样本.txt';
      window.__E2E__.files.push({ path: p, size: 128, modified: Date.now(), readonly: false, hidden: false, creation: Date.now() });
      window.__E2E__.text = { [p]: { encoding: 'gb18030', encodingLabel: 'GB18030（待确认）', confirmed: false, bytes: 128, chars: 42, lines: 3, preview: 'E2E 编码样本', warnings: ['编码未识别，需手动指定源编码'] } };
      return p;
    })()`);
    // ----- 文本编码：在检查器里真实可用（无文本目标时明确空态，不假装可用） -----
    await openInspectorMode('encoding');
    await waitFor(`document.querySelector('[data-testid="inspector"][data-mode="encoding"]')`, '编码检查器', 5000);
    await waitFor(`document.querySelector('[data-testid="inspector-empty"]')`, '无文本目标空态', 3000);
    const textEmpty = await evaluate(`(() => ({
      empty: !!document.querySelector('[data-testid="inspector-empty"]'),
      scope: document.querySelector('[data-testid="inspector-scope"]')?.textContent || '',
      clarified: (document.querySelector('[data-testid="inspector-empty"]')?.textContent || '').includes('文本'),
    }))()`);
    check('UI', '检查器「编码」在没有文本目标时显示空态并说明原因', textEmpty.empty && textEmpty.clarified, JSON.stringify(textEmpty));
    await click('[data-testid="inspector-close"]');
    await waitFor(`!document.querySelector('[data-testid="inspector"]')`, '关闭编码检查器');
    // 把样本带进列表，只勾选它再打开编码检查器（真实探测 → 手动指定 → 覆盖 → 还原）
    await click('[data-testid="add-files"]');
    await waitFor(`[...document.querySelectorAll('.trow')].some((r) => r.textContent.includes('编码样本.txt'))`, '编码样本进入列表', 8000);
    await sleep(300);
    const textSelBefore = await evaluate(`document.querySelectorAll('.trow .checkbox[aria-checked="true"]').length`);
    if (textSelBefore > 0) {
      const textAllOn = await evaluate(`document.querySelector('.thead .checkbox')?.getAttribute('aria-checked') === 'true'`);
      await click('.thead .checkbox');
      await sleep(300);
      if (!textAllOn) {
        await click('.thead .checkbox');
        await sleep(300);
      }
    }
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.trow')].find((r) => r.textContent.includes('编码样本.txt'));
      const cb = row?.querySelector('.checkbox');
      if (cb && cb.getAttribute('aria-checked') !== 'true') cb.click();
      return true;
    })()`);
    await sleep(300);
    const textChecked = await evaluate(`document.querySelectorAll('.trow .checkbox[aria-checked="true"]').length`);
    await openInspectorMode('encoding');
    await waitFor(`document.querySelector('[data-testid="inspector"][data-mode="encoding"] [data-testid="text-target-0"]')`, '选择文件后出现文本目标', 8000);
    await waitFor(`document.querySelector('[data-testid="inspector"] [data-testid="text-confirmed"]')`, '文本编码探测完成', 8000);
    check('UI', '勾选一个文本文件后编码检查器按勾选文件真实探测', textChecked === 1, String(textChecked));
    const textDetectState = await evaluate(`(() => {
      const sel = document.querySelector('[data-testid="text-source"]');
      return {
        confirmed: document.querySelector('[data-testid="text-confirmed"]')?.textContent || '',
        warning: document.querySelector('[data-testid="text-warning"]')?.textContent || '',
        sourceOptions: [...sel.options].map((o) => o.textContent),
      };
    })()`);
    check(
      'UI',
      '非 UTF-8/未确认编码 → 显式提示「需手动指定源编码」且源编码下拉给出 5 种可选',
      textDetectState.warning.includes('手动指定') && textDetectState.sourceOptions.includes('GB18030') && textDetectState.sourceOptions.includes('UTF-16 BE') && !textDetectState.sourceOptions.includes('utf8') && !textDetectState.sourceOptions.includes('gb18030'),
      JSON.stringify(textDetectState),
    );
    await click('[data-testid="text-apply"]');
    await sleep(350);
    const textBlocked = await evaluate(`({ hasResult: !!document.querySelector('[data-testid="text-result"]'), toast: [...document.querySelectorAll('.toast')].map((n) => n.textContent).join('|') })`);
    check('UI', '源编码未确认且保持「自动」时执行被阻止并提示手动指定（不静默按 UTF-8 写）', !textBlocked.hasResult && textBlocked.toast.includes('手动指定'), JSON.stringify(textBlocked));
    await evaluate(`(() => {
      const setSel = (sel, value) => {
        const proto = Object.getPrototypeOf(sel);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(sel, value);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setSel(document.querySelector('[data-testid="text-source"]'), 'gb18030');
      setSel(document.querySelector('[data-testid="text-target"]'), 'utf8bom');
      return true;
    })()`);
    await sleep(300);
    await click('[data-testid="text-apply"]');
    await waitFor(`document.querySelector('[data-testid="text-result"]')`, '文本编码写入结果', 6000);
    const textResultState = await evaluate(`(() => ({
      ok: !!document.querySelector('[data-testid="text-result"].ok'),
      verified: !!document.querySelector('[data-testid="text-verified"]'),
      stats: document.querySelector('[data-testid="text-result-stats"]')?.textContent || '',
      restore: !!document.querySelector('[data-testid="text-restore"]'),
      call: window.__E2E__.calls.filter((c) => c.cmd === 'text_save').map((c) => c.args?.req || null).pop(),
    }))()`);
    check(
      'UI-triggered mock',
      '文本编码原地覆盖：请求携带手动源编码 GB18030、目标 UTF-8 BOM，结果含回读校验与备份还原入口',
      textResultState.ok
        && textResultState.verified
        && textResultState.restore
        && textResultState.stats.includes('编码样本')
        && textResultState.call?.sourceEncoding === 'gb18030'
        && textResultState.call?.targetEncoding === 'utf8bom'
        && textResultState.call?.saveAs === null,
      JSON.stringify(textResultState),
    );
    const restoreCallsBeforeText = await evaluate(`window.__E2E__.calls.filter((c) => c.cmd === 'meta_restore_backup').length`);
    await click('[data-testid="text-restore"]');
    await sleep(400);
    const restoreCallsAfterText = await evaluate(`window.__E2E__.calls.filter((c) => c.cmd === 'meta_restore_backup').length`);
    check('UI', '文本编码结果提供「还原」按钮并走已有备份还原通路', restoreCallsAfterText === restoreCallsBeforeText + 1, JSON.stringify({ restoreCallsBeforeText, restoreCallsAfterText }));
    await click('[data-testid="inspector-close"]');
    await waitFor(`!document.querySelector('[data-testid="inspector"]')`, '关闭编码检查器');
    await sleep(250);

    // 真实重载验证「重启保持」：明暗 + 配色两维各自持久化，首帧属性在 React 之前写入
    await openSettings();
    await waitFor(`document.querySelector('.drawer')`, '设置抽屉（重启前）');
    await click('[data-testid="palette-moss"]');
    await click('[data-testid="theme-dark"]');
    await sleep(250);
    const restartBefore = await evaluate(`JSON.parse(localStorage.getItem('rename-studio.settings')).data`);
    await evaluate('location.reload()');
    await sleep(900);
    await waitFor(`document.querySelector('.workspace')`, '重载后工作区', 15000);
    await sleep(500);
    const restartAfter = await evaluate(`(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        attr: document.documentElement.dataset.palette,
        theme: document.documentElement.dataset.theme,
        bg: cs.getPropertyValue('--bg').trim(),
      };
    })()`);
    check(
      'UI',
      '重启保持：明暗与配色分别持久化，重载后仍为 moss + dark 且首帧底色取自该色板',
      restartBefore.palette === 'moss' && restartBefore.theme === 'dark'
        && restartAfter.attr === 'moss' && restartAfter.theme === 'dark' && restartAfter.bg === '#0e140f',
      JSON.stringify({ before: { palette: restartBefore.palette, theme: restartBefore.theme }, after: restartAfter }),
    );

    // ===== 列表交互：视图排序 / 多选与框选 / 右键菜单 / 就地重命名 / 行高 =====
    await evaluate('location.reload()');
    await waitFor(`document.querySelector('.trow')`, '交互用例的列表', 15000);
    // 前面的用例可能已把部分文件移出列表，这里把 mock 的默认文件全部补回，保证有足够行可交互
    await evaluate(`window.__E2E__.emitDrag('drop', window.__E2E__.files.map((f) => f.path))`);
    await waitFor(`document.querySelectorAll('.trow').length >= 4`, '交互用例的列表（4 行）', 8000);
    await sleep(400);
    await sleep(300);

    const pointOf = (selector, index = 0, dy = 0) =>
      evaluate(`(() => {
        const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
        if (!el) throw new Error('找不到元素');
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 + ${dy}, h: r.height };
      })()`);
    const mouseClick = async (x, y, modifiers = 0) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, modifiers });
      await sleep(180);
    };
    const rightClick = async (x, y) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
      await sleep(220);
    };
    const typeKey = async (key, code, vk, modifiers = 0) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
      await sleep(140);
    };
    const visibleNames = () => evaluate(`[...document.querySelectorAll('.trow .cell.name-cell .txt')].map((e) => e.textContent)`);
    const upOrder = () => evaluate(`[...document.querySelectorAll('.trow [data-testid^="row-up-"]')].map((e) => e.getAttribute('data-testid'))`);
    const selectedNow = () => evaluate(`document.querySelectorAll('.trow .checkbox[aria-checked="true"]').length`);
    const clearSelection = async () => {
      const on = await selectedNow();
      if (!on) return;
      const t = await evaluate(`(() => { const el = document.querySelector('[data-testid="file-table"]'); el?.focus(); return true; })()`);
      void t;
      await typeKey('Escape', 'Escape', 27);
      await sleep(150);
    };

    const namesBeforeSort = await visibleNames();
    const upsBeforeSort = await upOrder();
    await click('.th.sortable');
    await sleep(300);
    const sorted = await evaluate(`(() => {
      const table = document.querySelector('[data-testid="file-table"]');
      const names = [...document.querySelectorAll('.trow .cell.name-cell .txt')].map((e) => e.textContent);
      const asc = [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'));
      return {
        key: table.dataset.sort,
        dir: table.dataset.sortDir,
        sortedOk: JSON.stringify(names) === JSON.stringify(asc),
        chip: !!document.querySelector('[data-testid="sort-chip"]'),
        names,
      };
    })()`);
    const upsAfterSort = await upOrder();
    check(
      'UI',
      '列头排序只改显示顺序：按名称升序显示，真实编号（entry 下标）不重编号',
      sorted.key === 'name' && sorted.dir === '1' && sorted.sortedOk && sorted.chip
        && JSON.stringify(upsBeforeSort) !== JSON.stringify(upsAfterSort),
      JSON.stringify({ key: sorted.key, dir: sorted.dir, sortedOk: sorted.sortedOk, upsBeforeSort, upsAfterSort }),
    );

    await click('[data-testid="sort-reset"]');
    await sleep(250);
    const afterReset = await visibleNames();
    const resetSortKey = await evaluate(`document.querySelector('[data-testid="file-table"]').dataset.sort`);
    check(
      'UI',
      '「恢复手动顺序」退回真实列表顺序且不残留排序状态',
      JSON.stringify(afterReset) === JSON.stringify(namesBeforeSort) && resetSortKey === 'none',
      JSON.stringify({ afterReset, namesBeforeSort, resetSortKey }),
    );

    await clearSelection();
    const row0 = await pointOf('.trow', 0);
    const row1 = await pointOf('.trow', 1);
    const row2 = await pointOf('.trow', 2);
    await mouseClick(row0.x, row0.y);
    const selOne = await selectedNow();
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: row2.x, y: row2.y, button: 'left', buttons: 1, clickCount: 1, modifiers: 8 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: row2.x, y: row2.y, button: 'left', buttons: 0, clickCount: 1, modifiers: 8 });
    await sleep(200);
    const selRange = await selectedNow();
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: row1.x, y: row1.y, button: 'left', buttons: 1, clickCount: 1, modifiers: 2 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: row1.x, y: row1.y, button: 'left', buttons: 0, clickCount: 1, modifiers: 2 });
    await sleep(200);
    const selCtrl = await selectedNow();
    const statusText = await evaluate(`document.querySelector('[data-testid="status-selected"]')?.textContent || ''`);
    check(
      'UI',
      'Ctrl 点击单项切换、Shift 点击按锚点范围选择，状态栏给出「已选 N 项」',
      selOne === 1 && selRange === 3 && selCtrl === 2 && statusText.includes('已选 2 项'),
      JSON.stringify({ selOne, selRange, selCtrl, statusText }),
    );

    /** 滚到底部，取最后一行下方的空白带（tbody 有 32px 底部留白）。 */
    const blankPoint = async () => {
      await evaluate(`(() => {
        const t = document.querySelector('[data-testid="file-table"]');
        t.scrollTop = t.scrollHeight;
        return true;
      })()`);
      await sleep(250);
      return evaluate(`(() => {
        const t = document.querySelector('[data-testid="file-table"]');
        const rows = t.querySelectorAll('.trow');
        const last = rows[rows.length - 1].getBoundingClientRect();
        const r = t.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: Math.min(r.bottom - 6, last.bottom + 16) };
      })()`);
    };
    const blank = await blankPoint();
    await mouseClick(blank.x, blank.y);
    const selBlank = await selectedNow();
    check('UI', '点击列表空白清除选择', selBlank === 0, String(selBlank));

    // 框选：从空白处向上拖过末尾两行
    const lastRowCount = await evaluate(`document.querySelectorAll('.trow').length`);
    const lastRow = await pointOf('.trow', lastRowCount - 1);
    const prevRow = await pointOf('.trow', lastRowCount - 2);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: blank.x, y: blank.y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: lastRow.x, y: lastRow.y, button: 'left', buttons: 1 });
    await sleep(120);
    const marqueeShown = await evaluate(`!!document.querySelector('[data-testid="marquee"]')`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: prevRow.x, y: prevRow.y - 2, button: 'left', buttons: 1 });
    await sleep(150);
    const selMarquee = await selectedNow();
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: prevRow.x, y: prevRow.y - 2, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(150);
    check(
      'UI',
      '空白处按下拖动为框选：实时出现选框并命中拖过的行',
      marqueeShown && selMarquee >= 2,
      JSON.stringify({ marqueeShown, selMarquee }),
    );

    // 右键：点在已选中行上保留多选
    const selBeforeMenu = await selectedNow();
    const rcRow = await pointOf('.trow', lastRowCount - 2);
    await rightClick(rcRow.x, rcRow.y);
    const menuInfo = await evaluate(`(() => {
      const menu = document.querySelector('[data-testid="context-menu"]');
      return {
        open: !!menu,
        ids: [...document.querySelectorAll('[data-menu-id]')].map((e) => e.getAttribute('data-menu-id')),
        selected: document.querySelectorAll('.trow .checkbox[aria-checked="true"]').length,
      };
    })()`);
    check(
      'UI',
      '右键点在已选中行上保留多选，菜单项只给列表语义（复制/剪切/粘贴/移出列表）',
      menuInfo.open && menuInfo.selected === selBeforeMenu && selBeforeMenu >= 2
        && menuInfo.ids.includes('copy') && menuInfo.ids.includes('cut') && menuInfo.ids.includes('paste')
        && menuInfo.ids.includes('remove') && menuInfo.ids.includes('reveal'),
      JSON.stringify({ selBeforeMenu, menuInfo }),
    );
    await typeKey('ArrowDown', 'ArrowDown', 40);
    const menuActive = await evaluate(`!!document.querySelector('.ctx-item.on')`);
    await typeKey('Escape', 'Escape', 27);
    const menuClosed = await evaluate(`!document.querySelector('[data-testid="context-menu"]')`);
    check('UI', '右键菜单可键盘导航（↑↓ 高亮）并用 Esc 关闭', menuActive && menuClosed, JSON.stringify({ menuActive, menuClosed }));

    // 空白菜单 → 显示方式 → 紧凑
    await mouseClick(blank.x, blank.y);
    await rightClick(blank.x, blank.y);
    const blankMenu = await evaluate(`(() => ({
      open: !!document.querySelector('[data-testid="context-menu"]'),
      ids: [...document.querySelectorAll('[data-menu-id]')].map((e) => e.getAttribute('data-menu-id')),
    }))()`);
    await click('[data-menu-id="density"]');
    await sleep(200);
    await click('[data-menu-id="density-compact"]');
    await sleep(300);
    const compact = await evaluate(`(() => {
      const row = document.querySelector('.trow');
      const table = document.querySelector('[data-testid="file-table"]');
      return { density: table.dataset.density, h: row.getBoundingClientRect().height };
    })()`);
    check(
      'UI',
      '空白右键菜单给排序/显示方式；「紧凑」把行高从 44 降到 32（设计系统 row-h 阶梯）',
      blankMenu.open && blankMenu.ids.includes('sort') && blankMenu.ids.includes('density')
        && compact.density === 'compact' && Math.round(compact.h) === 32,
      JSON.stringify({ blankMenu, compact }),
    );
    // 恢复舒适
    const blank2 = await blankPoint();
    await rightClick(blank2.x, blank2.y);
    await click('[data-menu-id="density"]');
    await sleep(200);
    await click('[data-menu-id="density-comfortable"]');
    await sleep(250);
    await evaluate(`(() => { const t = document.querySelector('[data-testid="file-table"]'); t.scrollTop = 0; return true; })()`);
    await sleep(250);

    // F2 就地重命名
    await clearSelection();
    const renameRow = await pointOf('.trow', 0);
    await mouseClick(renameRow.x, renameRow.y);
    await evaluate(`document.querySelector('[data-testid="file-table"]').focus()`);
    await typeKey('F2', 'F2', 113);
    await waitFor(`document.querySelector('[data-testid^="rename-input-"]')`, '就地重命名输入框', 4000);
    await evaluate(`(() => {
      const el = document.querySelector('[data-testid^="rename-input-"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, '交互重命名.txt');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(150);
    await evaluate(`(() => {
      const el = document.querySelector('[data-testid^="rename-input-"]');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(300);
    const renamed = await evaluate(`(() => {
      const row = [...document.querySelectorAll('.trow')].find((r) => (r.querySelector('.new-name')?.textContent || '').includes('交互重命名.txt'));
      return {
        badge: document.querySelectorAll('[data-testid^="custom-name-"]').length,
        newName: row?.querySelector('.new-name')?.textContent || '',
        originalName: row?.querySelector('.cell.name-cell .txt')?.textContent || '',
      };
    })()`);
    check(
      'UI',
      'F2 就地重命名：Enter 提交后新名进入预览列并标出「已自定义」，真实文件名不变',
      renamed.badge === 1 && renamed.newName.includes('交互重命名.txt') && renamed.originalName !== '交互重命名.txt',
      JSON.stringify(renamed),
    );
    const renamedPoint = await evaluate(`(() => {
      const row = [...document.querySelectorAll('.trow')].find((r) => (r.querySelector('.new-name')?.textContent || '').includes('交互重命名.txt'));
      if (!row) return null;
      const r = row.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await rightClick(renamedPoint.x, renamedPoint.y);
    await click('[data-menu-id="revert-name"]');
    await sleep(300);
    const reverted = await evaluate(`!!document.querySelector('[data-testid^="custom-name-"]')`);
    check('UI', '菜单「恢复按规则命名」清掉自定义名', !reverted, String(reverted));

    // 排序状态下拖动：落下换算真实插入位、自动清排序并提示
    await click('.th.sortable');
    await sleep(250);
    const dragA = await pointOf('.trow', 0);
    const dragC = await pointOf('.trow', 2, 12);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragA.x, y: dragA.y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragA.x, y: dragA.y + 10, button: 'left', buttons: 1 });
    await sleep(100);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragC.x, y: dragC.y, button: 'left', buttons: 1 });
    await sleep(180);
    const duringDrag = await evaluate(`(() => ({
      line: !!document.querySelector('[data-testid="drop-line"]'),
      ghost: !!document.querySelector('[data-testid="drag-ghost"]'),
      grabbing: document.body.classList.contains('row-drag-active'),
      cursor: getComputedStyle(document.body).cursor,
    }))()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragC.x, y: dragC.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(350);
    const afterDrag = await evaluate(`(() => ({
      sort: document.querySelector('[data-testid="file-table"]').dataset.sort,
      line: !!document.querySelector('[data-testid="drop-line"]'),
      toast: [...document.querySelectorAll('.toast')].map((n) => n.textContent).join('|'),
      chip: !!document.querySelector('[data-testid="sort-chip"]'),
    }))()`);
    check(
      'UI',
      '排序状态下可拖动：拖拽中出现插入线与拖影、光标 grabbing，落下后自动清排序并提示',
      duringDrag.line && duringDrag.ghost && duringDrag.grabbing && duringDrag.cursor === 'grabbing'
        && afterDrag.sort === 'none' && !afterDrag.line && !afterDrag.chip && afterDrag.toast.includes('手动顺序'),
      JSON.stringify({ duringDrag, afterDrag }),
    );

    // Esc 取消拖动不改顺序
    const beforeCancel = await visibleNames();
    const escFrom = await pointOf('.trow', 0);
    const escTo = await pointOf('.trow', 2, 10);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: escFrom.x, y: escFrom.y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: escTo.x, y: escTo.y, button: 'left', buttons: 1 });
    await sleep(160);
    await typeKey('Escape', 'Escape', 27);
    await sleep(200);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: escTo.x, y: escTo.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(200);
    const afterCancel = await visibleNames();
    const cancelClean = await evaluate(`!document.querySelector('[data-testid="drop-line"]') && !document.body.classList.contains('row-drag-active')`);
    check('UI', 'Esc 取消拖动：不改变顺序且清掉插入线与拖拽态', JSON.stringify(beforeCancel) === JSON.stringify(afterCancel) && cancelClean, JSON.stringify({ beforeCancel, afterCancel, cancelClean }));

    // 虚拟滚动（>200 行）：End / Home 跳转必须把焦点行滚进视口（行还没渲染时按索引换算滚动位置）
    await evaluate(`(() => {
      const base = window.__E2E__.files[0];
      const extra = [];
      for (let i = 1; i <= 300; i += 1) {
        const path = 'D:/e2e/bulk/bulk_' + String(i).padStart(3, '0') + '.jpg';
        window.__E2E__.files.push({ ...base, path, size: 100000 + i });
        extra.push(path);
      }
      window.__E2E__.emitDrag('drop', extra);
      return extra.length;
    })()`);
    await sleep(1500);
    const bulk = await evaluate(`(() => {
      const t = document.querySelector('[data-testid="file-table"]');
      return { total: Number(t.dataset.total), virtual: t.dataset.virtual, rows: document.querySelectorAll('.trow').length };
    })()`);
    await evaluate(`document.querySelector('[data-testid="file-table"]').focus()`);
    await typeKey('End', 'End', 35);
    await sleep(400);
    const afterEnd = await evaluate(`(() => {
      const t = document.querySelector('[data-testid="file-table"]');
      const total = Number(t.dataset.total);
      return {
        total,
        scrollTop: t.scrollTop,
        lastVisible: !!document.querySelector('.trow[data-index="' + (total - 1) + '"]'),
        focusedIdx: document.querySelector('.trow.focused')?.getAttribute('data-index') || '',
      };
    })()`);
    await typeKey('Home', 'Home', 36);
    await sleep(400);
    const afterHome = await evaluate(`(() => {
      const t = document.querySelector('[data-testid="file-table"]');
      return { scrollTop: t.scrollTop, firstVisible: !!document.querySelector('.trow[data-index="0"]') };
    })()`);
    check(
      'UI',
      '超过 200 行进入虚拟滚动后，End/Home 仍把焦点行滚进视口（不是停在已渲染窗口里）',
      bulk.virtual === '1' && bulk.total >= 300 && bulk.rows < bulk.total
        && afterEnd.lastVisible && afterEnd.focusedIdx === String(afterEnd.total - 1) && afterEnd.scrollTop > 0
        && afterHome.scrollTop === 0 && afterHome.firstVisible,
      JSON.stringify({ bulk, afterEnd, afterHome }),
    );

    cdp.close();
  } finally {
    killTree(child.pid);
    // Edge 的浏览器主进程可能已不再挂在 child 下，按本次专用的 user-data-dir 兜底清理，
    // 保证无头浏览器测完立即退出，不残留后台进程。
    if (process.platform === 'win32') {
      const marker = path.basename(userDataDir);
      spawnSync('powershell.exe', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${marker}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ], { stdio: 'ignore' });
    }
    server.close();
    server.closeAllConnections?.();
    fs.closeSync(browserLog);
    await sleep(500);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* Chrome 可能仍占用目录，留给系统清理 */
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const summary = {
    generatedAt: new Date().toISOString(),
    browser: browser,
    viewport: '1440×900（默认） / 1100×640@1.5x（最小尺寸）',
    mode: '无头浏览器 + mock Tauri 后端（未启动 GUI 窗口）',
    passed,
    failed,
    results,
    screenshots: fs.readdirSync(SHOTS).sort(),
  };
  fs.writeFileSync(REPORT_JSON, JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(REPORT_MD, renderMarkdown(summary), 'utf8');
  console.log(`\nE2E 完成：${passed} 通过 / ${failed} 失败`);
  console.log(`报告：${REPORT_MD}`);
  if (failed) process.exitCode = 1;
}

function renderMarkdown(report) {
  const ui = report.results.filter((r) => r.layer === 'UI');
  const real = report.results.filter((r) => r.layer === 'REAL-FS');
  const mock = report.results.filter((r) => r.layer === 'UI-triggered mock');
  const config = report.results.filter((r) => r.layer === 'config');
  const perf = report.results.filter((r) => r.layer === 'PERF');
  const line = (r) => `| ${r.ok ? '✅ 通过' : '❌ 失败'} | ${r.name}${r.detail ? `（${String(r.detail).replace(/\|/g, '\\|')}）` : ''} |`;
  return `# 无头浏览器 E2E 报告

- 生成时间：${report.generatedAt}
- 运行方式：${report.mode}
- 浏览器：\`${report.browser}\`
- 视口：${report.viewport}
- 结果：**${report.passed} 通过 / ${report.failed} 失败**
- 截图目录：\`app/e2e/screenshots/\`（已加入 \`.gitignore\`，仅本机保留，不随仓库分发）

## UI 层断言（DOM / 可见性 / 截图）

| 结果 | 断言 |
| --- | --- |
${ui.map(line).join('\n')}

## 真实文件层断言（临时文件 → 改名 → 校验 → 撤销）

> 由 \`e2e/vars.mjs\`、\`e2e/rules-fs.mjs\` 与 \`e2e/policy.mjs\` 在真实临时目录执行，使用真实的 TypeScript 规则引擎与 \`fs\` 真改真撤销；元数据取值来自真实 MP3 的 ID3 标签；策略用例同时对照 \`src/runtime.ts\` 的默认值。

| 结果 | 断言 |
| --- | --- |
${real.map(line).join('\n')}

## 配置层断言（capabilities / 静态配置）

| 结果 | 断言 |
| --- | --- |
${config.map(line).join('\n')}

## UI 触发的 mock 后端断言

> 这些断言验证“点击路径确实调用了 Tauri 命令”，磁盘行为由内存 mock 模拟，**不是真实文件系统**。

| 结果 | 断言 |
| --- | --- |
${mock.map(line).join('\n')}
${perf.length ? `
## 性能压测（10,000 条目，真实前端 + mock 后端）

| 结果 | 断言 |
| --- | --- |
${perf.map(line).join('\n')}
` : ''}
## 层级别说明

- **UI 层已验证**：无头浏览器渲染真实构建产物，交互事件、DOM 状态、主题、列设置、九类列表页签、拖放高亮/计数、弹窗与截图均来自真实前端代码。
- **mock 后端**：\`scan_paths / apply_plan / undo_batch / read_metadata / read_metadata_batch / read_times / read_attrs / apply_time / apply_attrs / apply_move / meta_read / meta_edit / meta_restore_backup / exif_inventory / exif_clear / text_detect / text_save / write_text_atomic / plugin:event|listen\` 为内存实现，用于跑通交互路径；EXIF 与文本样本由测试显式注入（\`window.__E2E__.exif\` / \`text\`），mock 不凭空编造；真实磁盘行为另见 \`src-tauri/renomio-core/tests/\` 的 Rust 测试（含 \`ops_fs.rs\`）。
- **真机已验证（用户手工确认）**：真实窗口的右上角关闭、最小化、最大化在 Windows 真机上由用户在 2026-11-04 手工确认正常；这是人工确认，**不是本脚本的自动断言**。脚本仍只验证「点击后确实调用了 \`plugin:window|*\`」。
- **未验证（本脚本不覆盖）**：真实 Explorer 拖放（需用户从资源管理器实际拖入一次）、Tauri IPC 序列化、系统文件对话框、NSIS 安装器界面、macOS/Linux 平台差异。需要启动 GUI 或有头环境，按项目约定不在此处自动执行。

## 截图

${report.screenshots.map((s) => `- ${s}`).join('\n')}

截图文件仅保存在本机 \`app/e2e/screenshots/\`（已忽略），仓库内不提供可点击链接；需要留存时请取 CI artifact 或本地文件。
`;
}

main().catch((err) => {
  console.error('E2E 启动失败：', err);
  const failure = {
    generatedAt: new Date().toISOString(),
    passed: results.filter((r) => r.ok).length,
    failed: results.length - results.filter((r) => r.ok).length + 1,
    results,
    fatal: err instanceof Error ? err.message : String(err),
  };
  fs.writeFileSync(REPORT_JSON, JSON.stringify(failure, null, 2), 'utf8');
  fs.writeFileSync(
    REPORT_MD,
    `# 无头浏览器 E2E 报告（启动失败）\n\n- 时间：${failure.generatedAt}\n- 致命错误：${failure.fatal}\n\n已执行断言：\n${results
      .map((r) => `- ${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? `（${r.detail}）` : ''}`)
      .join('\n')}\n`,
    'utf8',
  );
  process.exit(1);
});
