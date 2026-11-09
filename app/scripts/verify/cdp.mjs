// 连接已安装 Renomio 的 WebView2 调试通道。只读优先，写入仅限 localStorage 与 UI 操作。
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.CDP_PORT || '9444';
const OUT = process.env.VERIFY_OUT || path.join(process.cwd(), 'verify-out');

export async function connect({ port = PORT, timeoutMs = 20000 } = {}) {
  const started = Date.now();
  let target;
  while (Date.now() - started < timeoutMs) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools://'));
      target = pages.find((t) => t.title === 'Renomio' || t.url.includes('tauri.localhost')) || (pages.length === 1 ? pages[0] : null);
      if (target) break;
    } catch {}
    await sleep(400);
  }
  if (!target) throw new Error(`未找到 WebView2 调试目标（port=${port}）`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };

  const api = {
    ws,
    send,
    evaluate,
    sleep,
    async click(testid) {
      const ok = await evaluate(
        `(() => { const el = document.querySelector('[data-testid="${testid}"]'); if (!el) return false; el.click(); return true; })()`,
      );
      if (!ok) throw new Error('找不到 ' + testid);
    },
    async waitFor(expression, label, timeout = 8000) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (await evaluate(expression)) return true;
        await sleep(250);
      }
      throw new Error('等待超时: ' + label);
    },
    async shot(name) {
      fs.mkdirSync(OUT, { recursive: true });
      const r = await send('Page.captureScreenshot', { format: 'png' });
      const p = path.join(OUT, `${name}.png`);
      fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
      return p;
    },
    async reload(waitSelector = '.titlebar') {
      try {
        await send('Page.reload', { ignoreCache: true });
        await sleep(200);
        await api.waitFor(`Boolean(document.querySelector('${waitSelector}'))`, 'reload ' + waitSelector, 8000);
      } catch {
        // 目标还停在 about:blank 时，reload 不会加载应用，直接导航到 Tauri 入口。
        await send('Page.navigate', { url: 'tauri://localhost' });
        await api.waitFor(`Boolean(document.querySelector('${waitSelector}'))`, 'navigate ' + waitSelector, 20000);
      }
      await sleep(600);
    },
    async readSettings() {
      return evaluate(`localStorage.getItem('rename-studio.settings')`);
    },
    async writeSettings(raw) {
      await evaluate(`localStorage.setItem('rename-studio.settings', ${JSON.stringify(raw)})`);
    },
    async setThemePalette(theme, palette) {
      const raw = await api.readSettings();
      const env = raw ? JSON.parse(raw) : { state: {}, version: 0 };
      // zustand persist 的载荷形如 {state:{...}} 或 {data:{...}}，两种都兼容。
      const holder = env.data ? 'data' : 'state';
      env[holder] = { ...(env[holder] || {}), theme, palette };
      await api.writeSettings(JSON.stringify(env));
      await api.reload();
    },
    close() {
      ws.close();
    },
  };
  return api;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
