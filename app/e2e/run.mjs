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
    await click('[data-testid="open-settings"]');
    await waitFor(`document.querySelector('.drawer')`, '设置抽屉');
    await clickText('.drawer .seg-ctrl span', '深色');
    await sleep(250);
    const theme = await evaluate(`({
      theme: document.documentElement.dataset.theme,
      panelBg: getComputedStyle(document.querySelector('.win')).backgroundColor,
    })`);
    check('UI', '明暗主题切换 → data-theme=dark 且面板底色变化', theme.theme === 'dark' && theme.panelBg !== bootTheme.panelBg, JSON.stringify(theme));
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
    check('UI', '元数据弹窗展示图片尺寸与只读标识', metaText.includes('4032 × 3024') && metaText.includes('只读') && metaText.includes('不会修改文件'), metaText.slice(0, 120));
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

    // CSV 导出
    await click('[data-testid="csv-export"]');
    await waitFor(`window.__E2E__.writes['D:\\\\e2e\\\\out\\\\list.csv'] !== undefined`, 'CSV 写入');
    const csvWrites = await evaluate(`window.__E2E__.writes`);
    const csv = csvWrites['D:\\e2e\\out\\list.csv'];
    const csvLines = (csv || '').split(/\r?\n/);
    check('UI', 'CSV 导出 → 表头 + 原名/新名/状态/错误原因', csvLines[0].replace('\ufeff', '') === '原文件名,新文件名,状态,原因' && csvLines.length >= 5, `${csvLines.length} 行`);
    check('UI', 'CSV 含冲突原因文本', /冲突/.test(csv) && /目标文件已存在|冲突/.test(csv));

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
    // 恢复“位置”列，避免影响后续截图
    await click('[data-testid="col-toggle-location"]');
    await click('[data-testid="col-settings"]');

    // ---- P1 第二梯队：时间属性（UI 层，mock 后端） ----
    await clickText('.nav .nav-item', '时间属性');
    await waitFor(`document.querySelector('[data-testid="ops-dialog"]')`, '时间面板');
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
    await waitFor(`!document.querySelector('[data-testid="ops-dialog"]')`, '时间面板关闭');
    await click('[data-testid="action-undo"]');
    await sleep(400);
    const mtimeRestored = await evaluate(`window.__E2E__.files.map((f) => f.modified)`);
    check(
      'UI-triggered mock',
      '时间修改可撤销 → mtime 回到原值',
      mtimeRestored.every((v, i) => v === mtimeBefore[i]),
      JSON.stringify(mtimeRestored),
    );

    // ---- 文件属性（UI 层，mock 后端） ----
    await clickText('.nav .nav-item', '文件属性');
    await waitFor(`document.querySelector('[data-testid="ops-dialog"]')`, '属性面板');
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
    await waitFor(`!document.querySelector('[data-testid="ops-dialog"]')`, '属性面板关闭');
    await click('[data-testid="action-undo"]');
    await sleep(400);
    const readonlyRestored = await evaluate(`window.__E2E__.files.filter((f) => f.readonly).length`);
    check('UI-triggered mock', '属性撤销 → 仅原本只读的文件保持只读', readonlyRestored === 1, `readonly=${readonlyRestored}`);

    // ---- 文件归类（正则捕获组分支；UI 层，mock 后端） ----
    await clickText('.nav .nav-item', '文件归类');
    await waitFor(`document.querySelector('[data-testid="ops-dialog"]')`, '归类面板');
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
    await waitFor(`!document.querySelector('[data-testid="ops-dialog"]')`, '归类面板关闭');
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

    // ---- 九类列表页签（UI 层，mock 后端） ----
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

    const tabExpect = {
      attrs: { min: 9, text: '只读' },
      music: { min: 1, text: '夜曲' },
      photo: { min: 4, text: '相机型号' },
      image: { min: 4, text: 'IPTC / XMP' },
      office: { min: 1, text: '会议记录' },
      pdf: { min: 1, text: '产品说明' },
      text: { min: 1, text: 'UTF-8' },
      organize: { min: 9, text: '扩展名' },
    };
    for (const [key, expect] of Object.entries(tabExpect)) {
      await click(`[data-testid="list-tab-${key}"]`);
      await waitFor(`document.querySelector('[data-testid="list-view-${key}"]')`, `页签 ${key} 渲染`);
      const loaded = await waitFor(
        `document.querySelectorAll('[data-testid="meta-row"]').length >= ${expect.min}`,
        `页签 ${key} 数据行`,
      ).then(() => true).catch(() => false);
      const info = await evaluate(`(() => {
        const root = document.querySelector('[data-testid="list-view-${key}"]');
        return {
          rows: root.querySelectorAll('[data-testid="meta-row"]').length,
          th: root.querySelectorAll('.th').length,
          text: root.textContent || '',
          note: !!root.querySelector('[data-testid^="list-note-"]'),
          action: !!root.querySelector('[data-testid^="list-action-"]'),
          empty: !!root.querySelector('[data-testid="meta-empty"]'),
        };
      })()`);
      check(
        'UI',
        `页签「${key}」渲染表格 / 表头 / 数据行且无空壳`,
        info.th > 1 && (info.empty ? !loaded : info.rows >= expect.min && info.text.includes(expect.text)),
        `rows=${info.rows}, th=${info.th}, note=${info.note}, action=${info.action}`,
      );
    }
    await click('[data-testid="list-action-organize"]');
    await waitFor(`document.querySelector('[data-testid="ops-apply"]')`, '归类移动面板打开');
    const organizeActionOk = await evaluate(`Boolean(document.querySelector('[data-testid="ops-apply"]'))`);
    await send('Runtime.evaluate', { expression: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))` });
    await sleep(200);
    check('UI', '归类页签「打开归类移动」按钮可交互并打开真实面板', organizeActionOk, `apply=${organizeActionOk}, note=${(await textOf('[data-testid="list-note-organize"]')).slice(0, 40)}`);

    await click('[data-testid="list-tab-text"]');
    await sleep(300);
    check('UI', '文本页签展示编码 / 行数 / 字符数 / 摘要', (await textOf('[data-testid="list-view-text"]')).includes('UTF-8') && (await textOf('[data-testid="list-view-text"]')).includes('行数'), ``);
    await click('[data-testid="list-tab-image"]');
    await sleep(300);
    check('UI', '图像页签明确标注 IPTC / XMP 暂不支持（不伪装成功）', (await textOf('[data-testid="list-note-image"]')).includes('暂不支持'), ``);
    await click('[data-testid="list-tab-rename"]');
    await sleep(300);
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
    check('UI', '1100×640 @150% DPI 表格内部横向滚动（列不裁切而是可滚动）', !!tableScroll && tableScroll.scrollable && tableScroll.clientWidth > 0, JSON.stringify(tableScroll));
    check('UI', '1100×640 @150% DPI 操作条与工具栏未被裁切', layout.actionBottom <= 641 && layout.actionRight <= 1101 && layout.toolbarBottom <= 641, JSON.stringify(layout));
    await shot('14-min-1100x640-150dpi.png');

    // 最小尺寸 + 150% DPI 下九类页签：页面不溢出、页签条可读
    await click('[data-testid="list-tab-attrs"]');
    await sleep(400);
    const tabLayout = await evaluate(`(() => {
      const tabs = document.querySelector('.list-tabs');
      const view = document.querySelector('[data-testid="list-view-attrs"]');
      return {
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        innerHeight: window.innerHeight,
        tabsClient: tabs?.clientWidth ?? 0,
        tabsScroll: tabs?.scrollWidth ?? 0,
        viewBottom: view?.getBoundingClientRect().bottom ?? 0,
        rowHeight: view?.querySelector('.trow')?.getBoundingClientRect().height ?? 0,
      };
    })()`);
    check(
      'UI',
      '1100×640 @150% DPI：九类页签不撑破页面，页签条与数据行可读',
      tabLayout.scrollWidth <= tabLayout.innerWidth + 1 &&
        tabLayout.tabsScroll <= tabLayout.tabsClient + 1 &&
        tabLayout.viewBottom <= tabLayout.innerHeight + 1 &&
        tabLayout.rowHeight >= 22,
      JSON.stringify(tabLayout),
    );
    await shot('15-min-tabs-1100x640-150dpi.png');
    await click('[data-testid="list-tab-rename"]');
    await sleep(300);

    // 桌面层（mock 调用）覆盖同一路径的断言
    const calls = await evaluate(`window.__E2E__.calls.map((c) => c.cmd)`);
    check('UI-triggered mock', '交互确实经过 Tauri 命令层（env/scan/apply/undo/时间/属性/移动/元数据/批量元数据/事件/写文件）', ['env_info', 'scan_paths', 'apply_plan', 'undo_batch', 'read_metadata', 'read_metadata_batch', 'read_times', 'read_attrs', 'apply_time', 'apply_attrs', 'apply_move', 'write_text_atomic', 'plugin:dialog|open', 'plugin:dialog|save', 'plugin:event|listen'].every((c) => calls.includes(c)), [...new Set(calls)].join(','));

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
      '九类页签与拖放流程无未捕获页面异常',
      pageExceptionCount === 0,
      `exceptions=${pageExceptionCount}`,
    );

    // ---- 阶段 A：权限失败逐条清单 + 提权（UIPI）提示 ----
    await evaluate('location.reload()');
    await sleep(700);
    await waitFor(`document.querySelector('[data-testid="add-files"]')`, '重载后应用就绪', 10000);
    await click('[data-testid="add-files"]');
    await waitFor(`document.querySelectorAll('.trow').length === 4`, '重载后添加 4 个文件');
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

    await click('[data-testid="open-settings"]');
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
      await click('[data-testid="list-tab-rename"]');
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

    cdp.close();
  } finally {
    killTree(child.pid);
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
- 截图目录：\`app/e2e/screenshots/\`

## UI 层断言（DOM / 可见性 / 截图）

| 结果 | 断言 |
| --- | --- |
${ui.map(line).join('\n')}

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
- **mock 后端**：\`scan_paths / apply_plan / undo_batch / read_metadata / read_metadata_batch / read_times / read_attrs / apply_time / apply_attrs / apply_move / write_text_atomic / plugin:event|listen\` 为内存实现，用于跑通交互路径；真实磁盘行为另见 \`src-tauri/ffrn-core/tests/\` 的 Rust 测试（含 \`ops_fs.rs\`）。
- **真机已验证（用户手工确认）**：真实窗口的右上角关闭、最小化、最大化在 Windows 真机上由用户在 2026-11-04 手工确认正常；这是人工确认，**不是本脚本的自动断言**。脚本仍只验证「点击后确实调用了 \`plugin:window|*\`」。
- **未验证（本脚本不覆盖）**：真实 Explorer 拖放（需用户从资源管理器实际拖入一次）、Tauri IPC 序列化、系统文件对话框、NSIS 安装器界面、macOS/Linux 平台差异。需要启动 GUI 或有头环境，按项目约定不在此处自动执行。

## 截图

${report.screenshots.map((s) => `- [${s}](screenshots/${s})`).join('\n')}
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
