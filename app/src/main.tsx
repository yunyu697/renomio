import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@foundation/tokens.css';
import './styles/app.css';
import './styles/shell.css';
import { App } from './App';
import { startupReport } from './lib/bridge';
import type { StartupMark } from './lib/types';
import { resolveLocale, setUiLocale } from './i18n';
import { settingsStore } from './runtime';

const host = document.getElementById('root');
if (!host) throw new Error('#root 未找到');

// 首帧之前确定语言：显式 ?lang= > 用户设置 > 系统语言 > 简体中文
setUiLocale(resolveLocale(settingsStore.value.language ?? 'system'));

const marks: StartupMark[] = [];
function addMark(name: string, ms = performance.now()): void {
  marks.push({ name, at: Math.round(performance.timeOrigin + ms), ms: Math.round(ms * 10) / 10 });
}

addMark('navigation_start', 0);
document.addEventListener('DOMContentLoaded', () => addMark('dom_content_loaded'), { once: true });
const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
if (nav && nav.responseStart > 0) addMark('ttfb', nav.responseStart);
addMark('script_start');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/** 首帧完成后才显示窗口（窗口在 tauri.conf.json 里是 visible:false）。 */
let revealed = false;
async function reveal(source: 'raf' | 'timer'): Promise<void> {
  if (revealed) return;
  revealed = true;
  addMark(`reveal_${source}`);
  const commit = (window as unknown as { __FIRST_COMMIT_MS__?: number }).__FIRST_COMMIT_MS__;
  if (typeof commit === 'number') addMark('react_commit', commit);
  for (const entry of performance.getEntriesByType('paint')) {
    addMark(entry.name.replace('-paint', '_paint'), entry.startTime);
  }
  const theme = (window as unknown as { __STARTUP_THEME__?: string }).__STARTUP_THEME__ === 'dark' ? 'dark' : 'light';
  await startupReport(marks.splice(0), theme, true);
}

/** React 首次 commit 之后再过两帧才显窗：此时首屏内容已经绘制，避免先露白底。 */
function scheduleReveal(): void {
  requestAnimationFrame(() => requestAnimationFrame(() => void reveal('raf')));
}
if ((window as unknown as { __FIRST_COMMIT_MS__?: number }).__FIRST_COMMIT_MS__ !== undefined) {
  // 首屏提交早于本模块监听（初始渲染同步完成）时不漏掉
  scheduleReveal();
} else {
  window.addEventListener('app-first-commit', scheduleReveal, { once: true });
}
// 隐藏桌面/被遮挡时 rAF 可能被节流；500ms 保底显示，避免窗口一直不出来
window.setTimeout(() => void reveal('timer'), 500);
