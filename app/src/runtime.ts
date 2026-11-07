import { createLogger, createSettings, createUpdater, TaskQueue } from '@foundation';
import type { AppSettings } from './lib/types';
import { DEFAULT_SHORTCUTS } from './lib/shortcuts';
import { logToDisk } from './lib/bridge';

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  language: 'system',
  strictWindowsNames: true,
  readonlySkip: false,
  autoPreview: true,
  conflictPolicy: 'skip',
  alwaysAdmin: false,
  replaceInvalid: false,
  invalidReplacement: '_',
  /** 名称长度上限（0 = 用平台上限）；只收紧不放宽 */
  nameMaxLength: 255,
  /** 超长名称处理：block 阻止 / truncate 截断主体保留扩展名 */
  longNameAction: 'block',
  /** 空名处理：block 阻止 / fallback 用备用名 */
  emptyNameAction: 'block',
  emptyNameFallback: '未命名',
  /** 是否跳过带系统/隐藏属性的文件 */
  skipSystemHidden: false,
  /** USER1–USER9：供名称模板 <USERn> 使用；默认全空 */
  userVars: ['', '', '', '', '', '', '', '', ''],
  /** 全局快捷键：默认与旧版硬编码行为一致，可在键位窗里改 */
  shortcuts: { ...DEFAULT_SHORTCUTS },
  columns: {
    name: true,
    location: true,
    size: true,
    modified: true,
    newName: true,
    status: true,
  },
  columnWidths: {},
  migrationNoticeDismissed: false,
  rules: [],
  ruleUi: { expanded: [], openId: null, collapsed: false },
  layout: { view: 'files-left', advanced: false, side: 400, stack: 320 },
};

export const settingsStore = createSettings<AppSettings>({
  key: 'rename-studio.settings',
  version: 1,
  defaults: DEFAULT_SETTINGS,
  migrate: () => null,
});

export const logger = createLogger({
  maxEntries: 400,
  persistKey: 'rename-studio.logs',
  sink: (entry) => {
    void logToDisk(entry.level, entry.event, entry.message);
  },
});

export const loggerUninstall = logger.installCrashHandlers();

export const queue = new TaskQueue(24);

export const updater = createUpdater();
