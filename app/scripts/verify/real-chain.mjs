// 规则链真实文件闭环（安装版 UI，不用 mock）：
// 拖入真实文件 -> 规则 -> 预览 -> 确认执行 -> 撤销，并用文件系统现状核对。
// 外部工具读回（exiftool/ffprobe/attrib/PowerShell 编码）由 real-chain.ps1 负责。
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './cdp.mjs';

const CORPUS = process.env.CHAIN_CORPUS;
const OUT = process.env.VERIFY_OUT || path.join(process.cwd(), 'verify-out', 'real-chain');
if (!CORPUS) throw new Error('缺少 CHAIN_CORPUS');
const FILES = ['album-2024.jpg', 'track-01.mp3', 'notes-gbk.txt'].map((f) => path.join(CORPUS, f));

const exists = (name) => fs.existsSync(path.join(CORPUS, name));
const waitFile = async (name, want, timeout = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (exists(name) === want) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

const cdp = await connect();
const report = { entry: '安装版 UI（tauri://drag-drop 事件 + 规则面板 + 执行/撤销）', corpus: CORPUS, steps: [], checks: [], failures: [] };
const add = (name, ok, detail = '') => {
  report.checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) report.failures.push(`${name} ${detail}`);
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name} ${detail}`);
};

try {
  await cdp.waitFor(`Boolean(document.querySelector('.titlebar'))`, '应用界面就绪', 20000);
  const sessionBefore = await cdp.evaluate(`localStorage.getItem('rename-studio.session')`);
  report.sessionBeforePresent = Boolean(sessionBefore);

  // 清掉上一轮会话里的真实文件，避免混淆：直接置空后 reload。
  await cdp.evaluate(`localStorage.removeItem('rename-studio.session')`);
  await cdp.reload();

  const emitted = await cdp.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit_to', {
    target: { kind: 'Webview', label: 'main' },
    event: 'tauri://drag-drop',
    payload: { type: 'drop', paths: ${JSON.stringify(FILES)}, position: { x: 400, y: 300 } }
  }).then(() => true, e => 'ERR:' + e)`);
  add('真实文件通过 drag-drop 事件载入', emitted === true, String(emitted));

  await cdp.waitFor(`document.querySelectorAll('.trow').length >= 3`, '三行文件', 12000);
  const loaded = await cdp.evaluate(`[...document.querySelectorAll('.trow')].map(r => r.innerText.replace(/\\s+/g,' ').trim())`);
  report.steps.push({ step: '载入', rows: loaded });
  add('列表出现 3 个真实文件', loaded.length >= 3, JSON.stringify(loaded));

  // 规则：两条替换，覆盖图片与音频；文本不受影响。
  if (await cdp.evaluate(`Boolean(document.querySelector('[data-testid="expand-rules"]'))`)) await cdp.click('expand-rules');
  if (await cdp.evaluate(`Boolean(document.querySelector('[data-testid="clear-rules"]'))`)) await cdp.click('clear-rules');
  await cdp.click('add-rule');
  await cdp.waitFor(`Boolean(document.querySelector('[data-testid="rule-type-replace"]'))`, '规则菜单');
  await cdp.click('rule-type-replace');
  await cdp.waitFor(`Boolean(document.querySelector('[data-testid="replace-find"]'))`, '替换输入');
  const setInput = (testid, value, index = 0) =>
    cdp.evaluate(`(() => {
      const el = document.querySelectorAll('[data-testid="${testid}"]')[${index}];
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    })()`);
  add('替换规则 1 输入生效', (await setInput('replace-find', '2024')) === '2024' && (await setInput('replace-with', '1999')) === '1999');
  await cdp.click('add-rule');
  await cdp.waitFor(`Boolean(document.querySelector('[data-testid="rule-type-replace"]'))`, '规则菜单 2');
  await cdp.click('rule-type-replace');
  await cdp.sleep(400);
  const setLastCardInput = (testid, value) =>
    cdp.evaluate(`(() => {
      const card = [...document.querySelectorAll('[data-testid="rule-card"]')].pop();
      const el = card.querySelector('[data-testid="${testid}"]');
      if (!el) return null;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    })()`);
  // 同一时间只展开一张卡片，点最后一张即可把第二张规则展开。
  if (!(await setLastCardInput('replace-find', '01'))) {
    await cdp.evaluate(`(() => { const c = [...document.querySelectorAll('[data-testid="rule-card"]')]; c[c.length - 1]?.click(); return c.length; })()`);
    await cdp.sleep(500);
  }
  const r2a = await setLastCardInput('replace-find', '01');
  const r2b = await setLastCardInput('replace-with', '99');
  if (r2a === null) throw new Error('第二条替换规则没有出现输入框');
  add('替换规则 2 输入生效', r2a === '01' && r2b === '99', `find=${r2a} replace=${r2b}`);

  // 预览：真实规则引擎在页面内用真实文件路径计算。
  const previewOk = await cdp.waitFor(
    `(() => { const t = [...document.querySelectorAll('.trow')].map(r => r.innerText.replace(/\\s+/g,''));
      return t.some(x => x.includes('album-1999.jpg')) && t.some(x => x.includes('track-99.mp3')); })()`,
    '预览出现预期新名',
    12000,
  );
  const preview = await cdp.evaluate(`[...document.querySelectorAll('.trow')].map(r => r.innerText.replace(/\\s+/g,' ').trim())`);
  report.steps.push({ step: '预览', rows: preview });
  add('预览新名符合规则', previewOk, JSON.stringify(preview));

  await cdp.click('action-apply');
  await cdp.waitFor(`Boolean(document.querySelector('[data-testid="preview-confirm"]'))`, '执行确认框', 12000);
  await cdp.shot('chain-before-apply');
  await cdp.click('preview-confirm');
  const renamed1 = await waitFile('album-1999.jpg', true);
  const renamed2 = await waitFile('track-99.mp3', true);
  const gone = !exists('album-2024.jpg') && !exists('track-01.mp3');
  const kept = exists('notes-gbk.txt');
  await cdp.sleep(1500);
  await cdp.shot('chain-after-apply');
  report.steps.push({ step: '执行', album1999: renamed1, track99: renamed2, originalsGone: gone, textUntouched: kept });
  add('执行后图片/音频按规则改名', renamed1 && renamed2 && gone, `album1999=${renamed1} track99=${renamed2} originalsGone=${gone}`);
  add('未匹配的 GBK 文本保持原名', kept, 'notes-gbk.txt');

  // 撤销：回到原文件名。
  await cdp.click('action-undo');
  const back1 = await waitFile('album-2024.jpg', true);
  const back2 = await waitFile('track-01.mp3', true);
  const undone = !exists('album-1999.jpg') && !exists('track-99.mp3');
  await cdp.sleep(1500);
  await cdp.shot('chain-after-undo');
  report.steps.push({ step: '撤销', back1, back2, newNamesGone: undone });
  add('撤销恢复原名', back1 && back2 && undone, `back1=${back1} back2=${back2} newNamesGone=${undone}`);

  if (sessionBefore) await cdp.evaluate(`localStorage.setItem('rename-studio.session', ${JSON.stringify(sessionBefore)})`);
  else await cdp.evaluate(`localStorage.removeItem('rename-studio.session')`);
  await cdp.reload();

  report.summary = report.failures.length ? 'FAIL' : 'ALL PASS';
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'real-chain-ui.json'), JSON.stringify(report, null, 2));
  console.log('SUMMARY', report.summary, report.failures.length ? JSON.stringify(report.failures) : '');
  if (report.failures.length) process.exitCode = 1;
} finally {
  cdp.close();
}
