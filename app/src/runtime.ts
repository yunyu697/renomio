import { createLogger, createSettings, createUpdater, TaskQueue } from '@foundation';
import type { AppSettings } from './lib/types';
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
