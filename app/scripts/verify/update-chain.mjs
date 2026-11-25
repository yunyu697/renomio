// 更新链路真机验证：已安装的 1.2.0-alpha16 → 应用内检查更新 → 下载验签 → 安装 1.2.0-alpha17
// 用法：先由外部脚本带 CDP 端口拉起安装版，再 node update-chain.mjs
import fs from 'node:fs';
import path from 'node:path';
import { connect, sleep } from './cdp.mjs';

const OUT = process.env.VERIFY_OUT || path.join(process.cwd(), 'verify-out', 'update-chain-alpha17');
fs.mkdirSync(OUT, { recursive: true });
const log = [];
const say = (msg, data) => {
  log.push({ at: new Date().toISOString(), msg, ...(data ? { data } : {}) });
  console.log(msg + (data ? ' ' + JSON.stringify(data) : ''));
};

const cdp = await connect({ port: process.env.CDP_PORT || '9444', timeoutMs: 30000 });
await cdp.waitFor(`Boolean(document.querySelector('.titlebar'))`, '应用首屏', 20000);
say('应用已连上 CDP');

// 1) 打开设置抽屉 → 更新区块
const opened = await cdp.evaluate(`Boolean(document.querySelector('[data-testid="update-settings"]'))`);
if (!opened) {
  // 「更多」按钮的 testid 随版本变过（toolbar-more / toolbar-more-menu），两个都认
  const clicked = await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-testid="toolbar-more-menu"]') || document.querySelector('[data-testid="toolbar-more"]');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!clicked) throw new Error('找不到「更多」按钮');
  await cdp.waitFor(`Boolean(document.querySelector('[data-testid="open-settings"]'))`, '更多菜单', 6000);
  await cdp.click('open-settings');
  await cdp.waitFor(`Boolean(document.querySelector('.drawer'))`, '设置抽屉', 8000);
}
await cdp.waitFor(`Boolean(document.querySelector('[data-testid="update-settings"]'))`, '更新区块', 8000);
await sleep(300);

const current = await cdp.evaluate(`document.querySelector('[data-testid="update-current"]')?.textContent || ''`);
say('当前版本（应用内显示）', { current });
const mirror = await cdp.evaluate(`document.querySelector('[data-testid="update-mirror"]')?.value || ''`);
say('镜像选择', { mirror });
await cdp.shot('01-update-idle');

// 升级完成后复检：只做「检查更新」，应报「已是最新」，用来证明清单读取与版本比较在升级后仍正确
if (process.env.CHECK_ONLY === '1') {
  await cdp.click('update-check');
  let p = 'checking';
  const t = Date.now();
  while (Date.now() - t < 120000) {
    p = await cdp.evaluate(`document.querySelector('[data-testid="update-settings"]').getAttribute('data-phase')`);
    if (p !== 'checking') break;
    await sleep(500);
  }
  const latestText = await cdp.evaluate(`document.querySelector('[data-testid="update-latest"]')?.textContent || ''`);
  const statusText2 = await cdp.evaluate(`document.querySelector('[data-testid="update-status"]')?.textContent || ''`);
  await cdp.shot('05-update-after-install');
  say('升级后复检', { phase: p, latestText, statusText2, seconds: ((Date.now() - t) / 1000).toFixed(1) });
  fs.writeFileSync(
    path.join(OUT, 'result-after-install.json'),
    JSON.stringify({ ok: p === 'latest', current, phase: p, latestText, statusText2, log }, null, 2),
  );
  cdp.close();
  process.exit(p === 'latest' ? 0 : 3);
}

// 2) 检查更新
await cdp.click('update-check');
let phase = 'checking';
const t0 = Date.now();
while (Date.now() - t0 < 120000) {
  phase = await cdp.evaluate(`document.querySelector('[data-testid="update-settings"]').getAttribute('data-phase')`);
  if (phase !== 'checking') break;
  await sleep(500);
}
const status = await cdp.evaluate(`document.querySelector('[data-testid="update-status"]')?.textContent || ''`);
const err = await cdp.evaluate(`document.querySelector('[data-testid="update-error"]')?.textContent || ''`);
say('检查结果', { phase, status, err, seconds: ((Date.now() - t0) / 1000).toFixed(1) });
await cdp.shot('02-update-checked');

if (phase !== 'available') {
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ ok: false, stage: 'check', current, phase, status, err, log }, null, 2));
  process.exit(2);
}

const notes = await cdp.evaluate(`document.querySelector('[data-testid="update-notes"]')?.textContent?.slice(0, 120) || ''`);
say('更新说明开头', { notes });

// 3) 点「更新」→ 确认 → 下载 → 验签 → 安装
await cdp.click('update-action');
await cdp.waitFor(`Boolean(document.querySelector('[data-testid="update-confirm"]'))`, '安装确认', 6000);
await cdp.shot('03-update-confirm');
await cdp.click('update-confirm-yes');
say('已确认安装，开始下载');

let lastPhase = '';
let sawVerified = false;
let sawReady = false;
let sawInstalling = false;
const t1 = Date.now();
let dropped = false;
while (Date.now() - t1 < 480000) {
  let snap;
  try {
    snap = await cdp.evaluate(`(() => {
      const el = document.querySelector('[data-testid="update-progress"]');
      if (!el) return null;
      const head = el.querySelector('.update-progress-head')?.textContent || '';
      const meta = el.querySelector('.update-progress-meta')?.textContent || '';
      return { head, meta, phase: document.querySelector('[data-testid="update-settings"]')?.getAttribute('data-phase'), raw: el.textContent };
    })()`);
  } catch (e) {
    dropped = true;
    say('CDP 连接中断（应用退出，交给安装器）', { message: String(e.message).slice(0, 120) });
    break;
  }
  if (!snap) { await sleep(500); continue; }
  const p = (snap.raw.match(/(下载|下载中|校验|已校验|准备|安装中|download|verify|verified|ready|install)/i) || [])[0] || '';
  const phaseText = snap.head.replace(/\d+%$/, '');
  if (phaseText !== lastPhase) {
    lastPhase = phaseText;
    say('进度阶段', { phaseText, meta: snap.meta, raw: snap.raw.slice(0, 120) });
    if (phaseText.includes('校验') || phaseText.toLowerCase().includes('verif')) sawVerified = true;
    if (phaseText.includes('准备') || phaseText.toLowerCase().includes('ready')) sawReady = true;
    if (phaseText.includes('安装') || phaseText.toLowerCase().includes('install')) sawInstalling = true;
    await cdp.shot(`04-progress-${lastPhase.replace(/[^\w\u4e00-\u9fa5]+/g, '_').slice(0, 20)}`);
  }
  if (sawInstalling) { say('进入安装阶段，等待应用退出'); break; }
  await sleep(400);
  void p;
}

fs.writeFileSync(
  path.join(OUT, 'result.json'),
  JSON.stringify({ ok: true, current, mirror, phase, status, notes, sawVerified, sawReady, sawInstalling, dropped, log }, null, 2),
);
say('结果已写入', { file: path.join(OUT, 'result.json'), sawVerified, sawReady, sawInstalling, dropped });
try { cdp.close(); } catch {}
process.exit(0);
