import { create } from 'zustand';
import {
  cancelApply as cancelApplyRequest, demoEntries, demoEnv, demoExistingPaths, getEnvInfo, getMigrationInfo,
  getPrivilegeInfo, importLegacyData,
  isDesktop, listBatches, onApplyProgress, pathsExist, pickFiles, pickFolders, renameFields, scanPaths,
  startupReport,
} from './lib/bridge';
import { baseName, parentPath } from './lib/format';
import { matchesAny, splitPatterns } from './lib/glob';
import { isPermissionRelated } from './lib/permission';
import { computePreview } from './lib/preview';
import { parsePlan, planFilter, serializePlan } from './lib/plan';
import { detectLocale, setUiLocale, t as translate } from './i18n';
import { createRuleDefaults } from './lib/ruleDefaults';
import { splitName, joinName } from './lib/rules';
import { normalizePath, targetPath } from './lib/validate';
import type {
  AppSettings, ApplyItemDto, ApplyOutcome, ApplyProgress, Batch, BatchSummary, ConflictPolicy, Entry,
  EnvInfo, ListTab, MetadataInfo, MetaFields, MigrationInfo, OpsOutcome, PreviewRow, PrivilegeInfo, Rule,
  RuleType, ScanEntryDto, SkippedChange, StartupMark,
} from './lib/types';
import { logger, queue, settingsStore } from './runtime';

export type StatusFilter = 'all' | 'changed' | 'conflict' | 'warn' | 'checked';
export type Drawer = 'history' | 'settings' | 'about' | null;
export type OpsMode = 'time' | 'attrs' | 'move';

/** 执行后逐条失败清单：让用户看到「哪些文件因什么原因失败」，而不是整批一个「失败」。 */
export interface FailureReport {
  items: SkippedChange[];
  done: number;
  total: number;
  batchId: string;
}
export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warn' | 'error';
  text: string;
}

export interface MetadataView {
  open: boolean;
  loading: boolean;
  path: string;
  name: string;
  info: MetadataInfo | null;
  error: string | null;
}

export type PlanDialogState =
  | { mode: 'export'; name: string; count: number }
  | {
      mode: 'import';
      fileName: string;
      name: string;
      rules: Rule[];
      warnings: string[];
      error: string | null;
      version?: number;
      checksumOk: boolean;
    };

let seq = 0;
const nextId = (prefix: string) => {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq}`;
};

let toastSeq = 0;

interface AppState {
  ready: boolean;
  bootError: string | null;
  env: EnvInfo;
  isDemo: boolean;
  settings: AppSettings;
  entries: Entry[];
  rules: Rule[];
  openRuleId: string | null;
  search: string;
  statusFilter: StatusFilter;
  listTab: ListTab;
  includePattern: string;
  excludePattern: string;
  recursive: boolean;
  includeDirs: boolean;
  includeHidden: boolean;
  scanning: boolean;
  applying: boolean;
  /** 批次执行进度（来自 Rust `apply-progress` 事件）；非执行期为空 */
  applyProgress: ApplyProgress | null;
  undoBusy: boolean;
  diskExists: Record<string, boolean>;
  batches: BatchSummary[];
  demoBatches: Batch[];
  lastBatchId: string | null;
  previewOpen: boolean;
  applyPolicy: ConflictPolicy;
  drawer: Drawer;
  opsMode: OpsMode | null;
  toast: Toast | null;
  ruleMenuOpen: boolean;
  dragging: boolean;
  metadata: MetadataView;
  planDialog: PlanDialogState | null;
  /** 当前进程的权限信息（浏览器演示模式为 null） */
  privilege: PrivilegeInfo | null;
  /** 已提权：显示 UIPI 会拦截 Explorer 拖放的提示 */
  uipiNotice: boolean;
  /** 提权取消/失败的一次性说明 */
  elevationMessage: string | null;
  failureReport: FailureReport | null;
  /** 文件路径 → 只读元数据字段（「按元数据取名」规则预加载） */
  metaFields: Record<string, MetaFields>;
  /** 首次启动的旧版数据迁移结果（浏览器演示模式为 null） */
  migration: MigrationInfo | null;

  init: () => Promise<void>;
  addPaths: (paths: string[]) => Promise<void>;
  chooseFiles: () => Promise<void>;
  chooseFolder: () => Promise<void>;
  toggleSelect: (id: string) => void;
  toggleSelectAll: () => void;
  removeSelected: () => void;
  clearAll: () => void;
  applyCurrentFilter: () => void;
  setSearch: (value: string) => void;
  setStatusFilter: (value: StatusFilter) => void;
  setListTab: (tab: ListTab) => void;
  setIncludePattern: (value: string) => void;
  setExcludePattern: (value: string) => void;
  setRecursive: (value: boolean) => void;
  setIncludeDirs: (value: boolean) => void;
  setIncludeHidden: (value: boolean) => void;
  setDragging: (value: boolean) => void;

  addRule: (type: RuleType) => void;
  updateRule: (id: string, patch: Record<string, unknown>) => void;
  deleteRule: (id: string) => void;
  moveRule: (id: string, delta: number) => void;
  toggleRule: (id: string) => void;
  clearRules: () => void;
  setOpenRule: (id: string | null) => void;

  openPreview: () => void;
  closePreview: () => void;
  setApplyPolicy: (policy: ConflictPolicy) => void;
  applyRows: (rows: PreviewRow[], policy: ConflictPolicy) => Promise<void>;
  cancelApply: () => Promise<void>;
  undoBatch: (id: string, quiet?: boolean) => Promise<void>;
  undoUntil: (id: string) => Promise<void>;
  undoLast: () => Promise<void>;
  refreshBatches: () => Promise<void>;
  refreshDisk: (rows: PreviewRow[]) => Promise<void>;

  openDrawer: (drawer: Drawer) => void;
  closeDrawer: () => void;
  openOps: (mode: OpsMode) => void;
  closeOps: () => void;
  finishOps: (outcome: OpsOutcome, mode: OpsMode) => Promise<void>;
  showToast: (kind: Toast['kind'], text: string) => void;
  dismissToast: () => void;
  setTheme: (theme: 'light' | 'dark') => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  relaunchElevated: () => Promise<void>;
  dismissUipiNotice: () => void;
  dismissElevationMessage: () => void;
  dismissMigrationNotice: () => void;
  importLegacy: () => Promise<void>;
  closeFailureReport: () => void;
  acknowledgeFailure: (id: string) => void;
  loadMetaFields: (paths: string[]) => Promise<void>;

  openMetadata: (entry: Entry) => Promise<void>;
  closeMetadata: () => void;
  openPlanExport: () => void;
  openPlanImport: () => Promise<void>;
  setPlanName: (name: string) => void;
  closePlanDialog: () => void;
  confirmPlanExport: () => Promise<void>;
  confirmPlanImport: () => void;
}

function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme;
}

function demoRules(): Rule[] {
  return [
    {
      id: 'demo-replace',
      type: 'replace',
      enabled: true,
      find: '旧照片 ',
      replace: '旅行_',
      caseSensitive: false,
      regex: false,
      nth: 0,
    },
    {
      id: 'demo-number',
      type: 'ext',
      enabled: false,
      mode: 'case',
      value: '',
      position: 'suffix',
      caseMode: 'upper',
    },
  ];
}

function demoSummary(batch: Batch): BatchSummary {
  const doneCount =
    batch.items.filter((i) => i.state === 'done').length +
    (batch.ops ?? []).filter((op) => op.state === 'done').length;
  const undoable = batch.state !== 'undone' && batch.state !== 'undo-partial' && doneCount > 0;
  return {
    id: batch.id,
    createdAt: batch.createdAt,
    finishedAt: batch.finishedAt,
    state: batch.state,
    kind: batch.kind,
    policy: batch.policy,
    roots: batch.roots,
    counts: batch.counts,
    undoable,
    undoReason: undoable
      ? null
      : batch.state === 'undone'
        ? translate('store.batchAlreadyUndone')
        : translate('store.batchNothingDone'),
  };
}

interface DemoApplyResult {
  entries: Entry[];
  batch: Batch;
  applied: Array<{ id: string; from: string; to: string }>;
  skipped: Array<{ id: string; source: string; reason: string }>;
}

function demoApply(
  current: Entry[],
  rows: PreviewRow[],
  policy: ConflictPolicy,
  env: EnvInfo,
): DemoApplyResult {
  const norm = (p: string) => normalizePath(p, env);
  const existing = new Set<string>([
    ...current.map((e) => norm(e.path)),
    ...demoExistingPaths.map(norm),
  ]);
  const candidates = rows.filter(
    (r) => r.entry.selected && r.newName !== r.entry.name && r.status !== 'invalid' && r.status !== 'off',
  );
  for (const r of candidates) existing.delete(norm(r.entry.path));

  const applied: DemoApplyResult['applied'] = [];
  const skipped: DemoApplyResult['skipped'] = [];
  const items: Batch['items'] = [];
  const updates = new Map<string, string>();

  for (const row of candidates) {
    let target = targetPath(row.entry.parent, row.newName, env);
    if (existing.has(norm(target))) {
      if (policy === 'skip') {
        const reason = translate('store.skipExists');
        skipped.push({ id: row.entry.id, source: row.entry.path, reason });
        items.push({
          id: row.entry.id, from: row.entry.path, to: target, temp: '', isDir: row.entry.isDir,
          state: 'skipped', reason,
        });
        continue;
      }
      if (policy === 'suffix') {
        const { stem, ext } = splitName(row.entry.name, row.entry.isDir);
        let resolved = '';
        for (let n = 1; n <= 999; n += 1) {
          const candidate = joinName(`${stem} (${n})`, ext);
          const path = targetPath(row.entry.parent, candidate, env);
          if (!existing.has(norm(path))) {
            resolved = path;
            break;
          }
        }
        if (!resolved) {
          const reason = translate('store.skipNoName');
          skipped.push({ id: row.entry.id, source: row.entry.path, reason });
          items.push({
            id: row.entry.id, from: row.entry.path, to: target, temp: '', isDir: row.entry.isDir,
            state: 'skipped', reason,
          });
          continue;
        }
        target = resolved;
      }
    }
    existing.add(norm(target));
    const newName = baseName(target);
    updates.set(row.entry.id, target);
    applied.push({ id: row.entry.id, from: row.entry.path, to: target });
    items.push({
      id: row.entry.id, from: row.entry.path, to: target, temp: '', isDir: row.entry.isDir,
      state: 'done',
    });
    void newName;
  }

  const entries = current.map((e) => {
    const target = updates.get(e.id);
    if (!target) return e;
    const { name } = (() => {
      const idx = Math.max(target.lastIndexOf('\\'), target.lastIndexOf('/'));
      return { name: idx >= 0 ? target.slice(idx + 1) : target };
    })();
    return { ...e, path: target, name, parent: parentPath(target) };
  });

  const batch: Batch = {
    id: `demo-${nextId('b')}`,
    createdAt: Date.now(),
    finishedAt: Date.now(),
    state: skipped.length ? 'partial' : 'completed',
    policy,
    roots: candidates.length ? [candidates[0].entry.parent] : [],
    counts: {
      total: items.length,
      done: applied.length,
      skipped: skipped.length,
      failed: 0,
    },
    items,
  };
  return { entries, batch, applied, skipped };
}

/** StrictMode 会把 effect 跑两次：启动初始化与「可交互」标记只执行第一次。 */
let initStarted = false;
let startupReadyReported = false;
let envReadyReported = false;

/** 把执行结果整理成逐条失败清单；没有失败或没有权限相关跳过时不弹。 */
function buildFailureReport(outcome: ApplyOutcome, total: number): FailureReport | null {
  if (outcome.batch.state === 'cancelled') return null;
  const permissionSkipped = outcome.skipped.filter((item) => isPermissionRelated(item.code));
  if (!outcome.failed.length && !permissionSkipped.length) return null;
  return {
    items: [...outcome.failed, ...permissionSkipped],
    done: outcome.applied.length,
    total,
    batchId: outcome.batch.id,
  };
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  bootError: null,
  env: demoEnv,
  isDemo: !isDesktop,
  settings: settingsStore.value,
  entries: [],
  rules: [],
  openRuleId: null,
  search: '',
  statusFilter: 'all',
  listTab: 'rename',
  includePattern: '',
  excludePattern: '',
  recursive: true,
  includeDirs: false,
  includeHidden: true,
  scanning: false,
  applying: false,
  applyProgress: null,
  undoBusy: false,
  diskExists: {},
  batches: [],
  demoBatches: [],
  lastBatchId: null,
  previewOpen: false,
  applyPolicy: settingsStore.value.conflictPolicy,
  drawer: null,
  opsMode: null,
  toast: null,
  ruleMenuOpen: false,
  dragging: false,
  metadata: { open: false, loading: false, path: '', name: '', info: null, error: null },
  planDialog: null,
  privilege: null,
  uipiNotice: false,
  elevationMessage: null,
  failureReport: null,
  metaFields: {},
  migration: null,

  init: async () => {
    if (initStarted) return;
    initStarted = true;
    const forced = new URLSearchParams(window.location.search).get('theme');
    const themeOverride: 'light' | 'dark' | null = forced === 'dark' || forced === 'light' ? forced : null;
    const stored = settingsStore.value;
    const settings = themeOverride ? { ...stored, theme: themeOverride } : stored;
    applyTheme(settings.theme);
    if (settings.language && settings.language !== 'system') setUiLocale(settings.language);
    const reportMark = (name: string) => {
      const ms = performance.now();
      const mark: StartupMark = {
        name,
        at: Math.round(performance.timeOrigin + ms),
        ms: Math.round(ms * 10) / 10,
      };
      void startupReport([mark], settings.theme, false);
    };
    const reportReady = (name = 'app_ready') => {
      if (startupReadyReported) return;
      startupReadyReported = true;
      reportMark(name);
    };
    try {
      if (!isDesktop) {
        set({
          ready: true,
          isDemo: true,
          env: demoEnv,
          settings,
          entries: demoEntries(),
          rules: demoRules(),
          applyPolicy: settings.conflictPolicy,
          diskExists: Object.fromEntries(
            demoExistingPaths.map((p) => [normalizePath(p, demoEnv), true]),
          ),
        });
        reportReady('app_ready_demo');
        logger.info('app.init', '浏览器演示模式启动');
        return;
      }
      const env = (await getEnvInfo()) ?? demoEnv;
      if (!envReadyReported) {
        envReadyReported = true;
        reportMark('env_ready');
      }
      const privilege = await getPrivilegeInfo();
      // 旧版数据迁移在 Rust 侧早于 Core::new 完成；这里只取结果用于一次性提示/手动导入入口
      const migration = await getMigrationInfo();
      // 批次历史只在打开「操作记录」时读取，避免启动首屏等待磁盘扫描
      set({
        ready: true,
        isDemo: false,
        env,
        settings,
        entries: [],
        rules: [],
        applyPolicy: settings.conflictPolicy,
        batches: [],
        lastBatchId: null,
        privilege,
        migration,
        uipiNotice: privilege?.elevated ?? false,
      });
      reportReady();
      logger.info('app.init', '桌面端启动', { env: env.os, caseSensitive: env.caseSensitive });
      if (privilege?.elevated) {
        logger.info('app.elevated', '已以管理员身份运行；UIPI 将拦截普通权限资源管理器的拖放', {
          installDir: privilege.installDir,
        });
      } else if (settings.alwaysAdmin) {
        // 每次启动最多尝试一次；取消后继续以普通权限运行，不重复弹 UAC
        void get().relaunchElevated();
      }
    } catch (err) {
      initStarted = false; // 允许用户重试
      set({ ready: true, bootError: err instanceof Error ? err.message : String(err) });
      reportReady('app_ready_error');
      logger.error('app.init.failed', String(err));
    }
  },

  addPaths: async (paths) => {
    if (!paths.length) return;
    if (!isDesktop) {
      get().showToast('info', translate('toast.demoNoRead'));
      return;
    }
    const state = get();
    set({ scanning: true });
    try {
      await queue.enqueue(translate('store.scanning'), async (ctx) => {
        ctx.setProgress(0.15, translate('store.readDir'));
        const res = await scanPaths(paths, {
          recursive: state.recursive,
          includeFiles: true,
          includeDirs: state.includeDirs,
          includePatterns: splitPatterns(state.includePattern),
          excludePatterns: splitPatterns(state.excludePattern),
          includeHidden: state.includeHidden,
        });
        ctx.setProgress(0.85, translate('store.sortList'));
        const incoming: Entry[] = res.entries.map((e: ScanEntryDto) => ({ ...e, selected: true }));
        const merged = [...get().entries];
        const known = new Set(merged.map((e) => normalizePath(e.path, state.env)));
        let added = 0;
        for (const entry of incoming) {
          const key = normalizePath(entry.path, state.env);
          if (known.has(key)) continue;
          known.add(key);
          merged.push(entry);
          added += 1;
        }
        set({ entries: merged, scanning: false });
        if (res.truncated) {
          get().showToast('warn', translate('toast.scanTruncated', { count: res.entries.length }));
        } else if (res.warnings.length) {
          get().showToast('warn', res.warnings[0]);
        } else if (added) {
          get().showToast('success', translate('toast.added', { count: added }));
        }
        logger.info('scan.done', `新增 ${added} 个对象`, { total: merged.length, warnings: res.warnings.length });
      });
    } catch (err) {
      set({ scanning: false });
      get().showToast('error', translate('toast.scanFailed', { message: err instanceof Error ? err.message : String(err) }));
      logger.error('scan.failed', String(err));
    }
  },

  chooseFiles: async () => {
    if (!isDesktop) {
      get().showToast('info', translate('toast.demoSamples'));
      return;
    }
    const paths = await pickFiles();
    if (paths.length) await get().addPaths(paths);
  },

  chooseFolder: async () => {
    if (!isDesktop) {
      get().showToast('info', translate('toast.demoSamples'));
      return;
    }
    const paths = await pickFolders();
    if (paths.length) await get().addPaths(paths);
  },

  toggleSelect: (id) =>
    set((s) => ({ entries: s.entries.map((e) => (e.id === id ? { ...e, selected: !e.selected } : e)) })),

  toggleSelectAll: () =>
    set((s) => {
      const allOn = s.entries.every((e) => e.selected);
      return { entries: s.entries.map((e) => ({ ...e, selected: !allOn })) };
    }),

  removeSelected: () => {
    const removed = get().entries.filter((e) => e.selected).length;
    if (!removed) {
      get().showToast('info', translate('toast.noSelection'));
      return;
    }
    set((s) => ({ entries: s.entries.filter((e) => !e.selected) }));
    get().showToast('info', translate('toast.removed', { count: removed }));
  },

  clearAll: () => {
    set({ entries: [], rules: get().rules, openRuleId: null });
  },

  applyCurrentFilter: () => {
    const s = get();
    const inc = splitPatterns(s.includePattern);
    const exc = splitPatterns(s.excludePattern);
    if (!inc.length && !exc.length) {
      get().showToast('info', translate('toast.needPattern'));
      return;
    }
    const before = s.entries.length;
    const filtered = s.entries.filter((e) => {
      if (inc.length && !matchesAny(inc, e.path, !s.env.caseSensitive)) return false;
      if (exc.length && matchesAny(exc, e.path, !s.env.caseSensitive)) return false;
      return true;
    });
    set({ entries: filtered });
    get().showToast('info', translate('toast.filtered', { filtered: filtered.length, before }));
  },

  setSearch: (value) => set({ search: value }),
  setStatusFilter: (value) => set({ statusFilter: value }),
  setListTab: (tab) => set({ listTab: tab }),
  setIncludePattern: (value) => set({ includePattern: value }),
  setExcludePattern: (value) => set({ excludePattern: value }),
  setRecursive: (value) => set({ recursive: value }),
  setIncludeDirs: (value) => set({ includeDirs: value }),
  setIncludeHidden: (value) => set({ includeHidden: value }),
  setDragging: (value) => set({ dragging: value }),

  addRule: (type) => {
    const rule = createRuleDefaults(type, nextId('r'));
    set((s) => ({ rules: [...s.rules, rule], openRuleId: rule.id, ruleMenuOpen: false }));
    logger.info('rule.add', type);
  },

  updateRule: (id, patch) =>
    set((s) => ({
      rules: s.rules.map((r) => (r.id === id ? ({ ...r, ...patch } as Rule) : r)),
    })),

  deleteRule: (id) =>
    set((s) => ({ rules: s.rules.filter((r) => r.id !== id), openRuleId: s.openRuleId === id ? null : s.openRuleId })),

  moveRule: (id, delta) =>
    set((s) => {
      const index = s.rules.findIndex((r) => r.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= s.rules.length) return {};
      const rules = [...s.rules];
      const [rule] = rules.splice(index, 1);
      rules.splice(target, 0, rule);
      return { rules };
    }),

  toggleRule: (id) =>
    set((s) => ({ rules: s.rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)) })),

  clearRules: () => set({ rules: [], openRuleId: null }),

  setOpenRule: (id) => set({ openRuleId: id }),

  openPreview: () => {
    if (!get().entries.length) {
      get().showToast('info', translate('toast.needFiles'));
      return;
    }
    set({ previewOpen: true });
  },
  closePreview: () => set({ previewOpen: false }),
  setApplyPolicy: (policy) => {
    set({ applyPolicy: policy });
    get().updateSettings({ conflictPolicy: policy });
  },

  applyRows: async (rows, policy) => {
    const s = get();
    if (s.applying) return;
    const candidates = rows.filter(
      (r) => r.entry.selected && r.newName !== r.entry.name && r.status !== 'invalid' && r.status !== 'off',
    );
    if (!candidates.length) {
      get().showToast('warn', translate('toast.noExecutable'));
      return;
    }
    const items: ApplyItemDto[] = candidates.map((r) => ({
      id: r.entry.id,
      source: r.entry.path,
      targetName: r.newName,
      isDir: r.entry.isDir,
    }));
    const options = {
      policy,
      skipReadonly: s.settings.readonlySkip,
      windowsSafe: s.settings.strictWindowsNames,
      roots: Array.from(new Set(candidates.map((r) => r.entry.parent))),
    };

    set({ applying: true });
    try {
      if (s.isDemo) {
        const result = demoApply(s.entries, rows, policy, s.env);
        const batches = [result.batch, ...s.demoBatches];
        set({
          entries: result.entries,
          demoBatches: batches,
          batches: batches.map(demoSummary),
          lastBatchId: result.batch.id,
          applying: false,
          previewOpen: false,
        });
        get().showToast(
          'success',
          translate('toast.demoApplied', { applied: result.applied.length, skipped: result.skipped.length }),
        );
        void get().refreshDisk(computePreview(result.entries, get().rules, {
          env: s.env,
          strictWindowsNames: s.settings.strictWindowsNames,
          readonlySkip: s.settings.readonlySkip,
          diskExists: s.diskExists,
        }).rows);
        logger.info('apply.demo', '演示改名', { applied: result.applied.length });
        return;
      }

      const { applyPlan } = await import('./lib/bridge');
      set({ applyProgress: { phase: 'prepare', done: 0, total: items.length, current: '' } });
      const unlisten = await onApplyProgress((progress) => set({ applyProgress: progress }));
      let outcome: ApplyOutcome;
      try {
        outcome = await queue.enqueue(translate('store.applyBatch'), async (ctx) => {
          ctx.setProgress(0.1, translate('store.writeJournal'));
          const res = await applyPlan(items, options);
          ctx.setProgress(1, translate('store.done'));
          return res;
        });
      } finally {
        unlisten();
        set({ applyProgress: null });
      }
      const cancelled = outcome.batch.state === 'cancelled';
      const map = new Map(outcome.applied.map((a) => [a.id, a.to]));
      const entries = get().entries.map((e) => {
        const to = map.get(e.id);
        if (!to) return e;
        return { ...e, path: to, name: baseName(to), parent: parentPath(to) };
      });
      set({
        entries, applying: false, previewOpen: false, lastBatchId: outcome.batch.id,
        failureReport: buildFailureReport(outcome, items.length),
      });
      await get().refreshBatches();
      const permissionFailed = outcome.failed.filter((f) => isPermissionRelated(f.code)).length
        + outcome.skipped.filter((s2) => isPermissionRelated(s2.code)).length;
      get().showToast(
        cancelled ? 'warn' : outcome.failed.length ? 'warn' : 'success',
        cancelled
          ? translate('toast.cancelled', { applied: outcome.applied.length, skipped: outcome.skipped.length })
          : translate(permissionFailed ? 'toast.appliedPerm' : 'toast.applied', {
              applied: outcome.applied.length,
              skipped: outcome.skipped.length,
              failed: outcome.failed.length,
              perm: permissionFailed,
            }),
      );
      logger.info('apply.done', '执行改名', {
        done: outcome.applied.length,
        skipped: outcome.skipped.length,
        failed: outcome.failed.length,
        batch: outcome.batch.id,
        cancelled,
      });
    } catch (err) {
      set({ applying: false });
      const message = err instanceof Error ? err.message : String(err);
      get().showToast('error', translate('toast.applyFailed', { message }));
      logger.error('apply.failed', message);
    }
  },

  cancelApply: async () => {
    const requested = await cancelApplyRequest();
    get().showToast('info', requested ? translate('toast.cancelRequested') : translate('toast.noRunning'));
  },

  undoBatch: async (id, quiet = false) => {
    const s = get();
    if (s.undoBusy || s.applying) return;
    set({ undoBusy: true });
    try {
      if (s.isDemo) {
        const batch = s.demoBatches.find((b) => b.id === id);
        if (!batch) throw new Error(translate('toast.demoBatchMissing'));
        if (batch.state === 'undone') throw new Error(translate('toast.alreadyUndone'));
        const restored = new Map<string, string>();
        for (const item of batch.items) {
          if (item.state !== 'done') continue;
          restored.set(normalizePath(item.to, s.env), item.from);
        }
        const entries = s.entries.map((e) => {
          const from = restored.get(normalizePath(e.path, s.env));
          if (!from) return e;
          return { ...e, path: from, name: baseName(from), parent: parentPath(from) };
        });
        const demoBatches = s.demoBatches.map((b) => (b.id === id ? { ...b, state: 'undone' as const } : b));
        set({ entries, demoBatches, batches: demoBatches.map(demoSummary), undoBusy: false });
        if (!quiet) get().showToast('success', translate('toast.demoUndone', { count: restored.size }));
        logger.info('undo.demo', '演示撤销', { count: restored.size });
        return;
      }
      const { undoBatch } = await import('./lib/bridge');
      const outcome = await queue.enqueue(translate('store.undoBatch'), async (ctx) => {
        ctx.setProgress(0.2, translate('store.readJournal'));
        return undoBatch(id);
      });
      const restored = new Map(outcome.restored.map((r) => [normalizePath(r.from, s.env), r.to]));
      let entries = get().entries.map((e) => {
        const to = restored.get(normalizePath(e.path, s.env));
        if (!to) return e;
        return { ...e, path: to, name: baseName(to), parent: parentPath(to) };
      });
      // 时间 / 属性撤销：按批次 before 值回填列表显示
      const opPatches = new Map<string, Record<string, unknown>>();
      for (const op of outcome.batch.ops ?? []) {
        try {
          const before = JSON.parse(op.before || '{}') as Record<string, unknown>;
          const patch =
            op.kind === 'time' && typeof before.mtime === 'number'
              ? { modified: before.mtime }
              : op.kind === 'attrs' && typeof before.readonly === 'boolean'
                ? { readonly: before.readonly }
                : null;
          if (patch) opPatches.set(normalizePath(op.path, s.env), patch);
        } catch {
          // 旧批次 before 可能为空，忽略
        }
      }
      if (opPatches.size) {
        entries = entries.map((e) => {
          const patch = opPatches.get(normalizePath(e.path, s.env));
          return patch ? { ...e, ...patch } : e;
        });
      }
      set({ entries, undoBusy: false });
      if (!quiet) await get().refreshBatches();
      logger.info('undo.done', '撤销批次', { batch: id, restored: outcome.restored.length, failed: outcome.failed.length });
      if (quiet) return;
      const skippedFields = outcome.skippedFields ?? [];
      const skippedCreation = skippedFields.some((f) => f.field === 'creation');
      get().showToast(
        outcome.failed.length ? 'warn' : 'success',
        skippedCreation
          ? translate('toast.undoDoneSkippedBtime', {
              restored: outcome.restored.length,
              failed: outcome.failed.length,
              platform: get().env?.os === 'macos' ? 'macOS' : 'Linux',
            })
          : translate('toast.undoDone', { restored: outcome.restored.length, failed: outcome.failed.length }),
      );
    } catch (err) {
      set({ undoBusy: false });
      const message = err instanceof Error ? err.message : String(err);
      get().showToast('error', translate('toast.undoFailed', { message }));
      logger.error('undo.failed', message);
    }
  },

  /** 多级撤销：从最新批次依次回退到指定批次（含）。较新的批次必须都可撤销。 */
  undoUntil: async (id) => {
    const s = get();
    if (s.undoBusy || s.applying) return;
    const index = s.batches.findIndex((b) => b.id === id);
    if (index < 0) {
      get().showToast('info', translate('toast.batchMissing'));
      return;
    }
    const chain = s.batches.slice(0, index + 1).filter((b) => b.undoable);
    const blocked = s.batches.slice(0, index + 1).length - chain.length;
    if (blocked > 0) {
      get().showToast('warn', translate('toast.undoBlocked', { count: blocked }));
      return;
    }
    for (const batch of chain) {
      await get().undoBatch(batch.id, true);
    }
    await get().refreshBatches();
    const undone = get().batches.slice(0, index + 1).filter((b) => b.state === 'undone').length;
    get().showToast('success', translate('toast.undoUntil', { undone, total: index + 1 }));
    logger.info('undo.until', '多级撤销', { target: id, batches: index + 1, undone });
  },

  undoLast: async () => {
    const s = get();
    const candidate = s.batches.find((b) => b.undoable);
    if (!candidate) {
      get().showToast('info', translate('toast.noUndoable'));
      return;
    }
    await get().undoBatch(candidate.id);
  },

  refreshBatches: async () => {
    const s = get();
    if (s.isDemo) {
      set({ batches: s.demoBatches.map(demoSummary) });
      return;
    }
    const batches = await listBatches();
    set({ batches, lastBatchId: batches[0]?.id ?? null });
  },

  refreshDisk: async (rows) => {
    const s = get();
    if (s.isDemo) return;
    const targets = Array.from(
      new Set(
        rows
          .filter((r) => r.entry.selected && r.newName !== r.entry.name && r.status !== 'invalid' && r.status !== 'off')
          .map((r) => targetPath(r.entry.parent, r.newName, s.env)),
      ),
    );
    if (!targets.length) {
      if (Object.keys(s.diskExists).length) set({ diskExists: {} });
      return;
    }
    try {
      const flags = await pathsExist(targets);
      const map: Record<string, boolean> = {};
      targets.forEach((t, i) => {
        if (flags[i]) map[normalizePath(t, s.env)] = true;
      });
      if (JSON.stringify(map) !== JSON.stringify(get().diskExists)) set({ diskExists: map });
    } catch (err) {
      logger.warn('diskcheck.failed', String(err));
    }
  },

  openDrawer: (drawer) => set({ drawer }),
  closeDrawer: () => set({ drawer: null }),

  openOps: (mode) => {
    const s = get();
    if (!s.entries.some((e) => e.selected)) {
      get().showToast('info', translate('toast.needChecked'));
      return;
    }
    set({ opsMode: mode });
  },
  closeOps: () => set({ opsMode: null }),

  finishOps: async (outcome, mode) => {
    const s = get();
    let entries = s.entries;
    if (mode === 'move') {
      const map = new Map(outcome.applied.map((a) => [a.id, a.target ?? a.path]));
      entries = entries.map((e) => {
        const to = map.get(e.id);
        if (!to) return e;
        return { ...e, path: to, name: baseName(to), parent: parentPath(to) };
      });
    } else {
      const changes = new Map(outcome.applied.map((a) => [a.id, a.after]));
      entries = entries.map((e) => {
        const raw = changes.get(e.id);
        if (!raw) return e;
        const patch: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (mode === 'time' && typeof parsed.mtime === 'number') patch.modified = parsed.mtime;
          if (mode === 'attrs' && typeof parsed.readonly === 'boolean') patch.readonly = parsed.readonly;
        } catch {
          return e;
        }
        return Object.keys(patch).length ? { ...e, ...patch } : e;
      });
    }
    set({ entries, lastBatchId: outcome.batch.id });
    await get().refreshBatches();
    const labelKey = mode === 'time' ? 'toast.opsTime' : mode === 'attrs' ? 'toast.opsAttrs' : 'toast.opsMove';
    const label = translate(labelKey);
    get().showToast(
      outcome.failed.length ? 'warn' : 'success',
      translate('toast.opsDone', {
        label,
        applied: outcome.applied.length,
        skipped: outcome.skipped.length,
        failed: outcome.failed.length,
      }),
    );
    logger.info(`ops.${mode}.done`, label, {
      done: outcome.applied.length,
      skipped: outcome.skipped.length,
      failed: outcome.failed.length,
      batch: outcome.batch.id,
    });
  },

  showToast: (kind, text) => {
    toastSeq += 1;
    const id = toastSeq;
    set({ toast: { id, kind, text } });
    window.setTimeout(() => {
      if (get().toast?.id === id) set({ toast: null });
    }, 4500);
  },
  dismissToast: () => set({ toast: null }),

  setTheme: (theme) => {
    applyTheme(theme);
    get().updateSettings({ theme });
  },

  updateSettings: (patch) => {
    const settings = settingsStore.save(patch);
    set({ settings, applyPolicy: settings.conflictPolicy });
    if (patch.theme) applyTheme(patch.theme);
    if (patch.language) {
      setUiLocale(patch.language === 'system' ? detectLocale(navigator.language) : patch.language);
    }
  },

  relaunchElevated: async () => {
    if (!isDesktop) {
      get().showToast('info', translate('toast.demoNoElevate'));
      return;
    }
    try {
      const { relaunchAsAdmin } = await import('./lib/bridge');
      const started = await relaunchAsAdmin();
      if (!started) {
        set({ elevationMessage: translate('store.elevCancelDetail') });
        get().showToast('warn', translate('toast.elevationCancelled'));
        logger.info('elevation.cancelled', '用户取消 UAC');
        return;
      }
      set({ elevationMessage: translate('store.elevRestarting') });
      get().showToast('info', translate('toast.elevationStarting'));
      logger.info('elevation.started', '已请求 runas 重启');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ elevationMessage: translate('store.elevFailedDetail', { message }) });
      get().showToast('error', translate('toast.elevationFailed', { message }));
      logger.error('elevation.failed', message);
    }
  },

  dismissUipiNotice: () => set({ uipiNotice: false }),
  dismissElevationMessage: () => set({ elevationMessage: null }),
  dismissMigrationNotice: () => get().updateSettings({ migrationNoticeDismissed: true }),
  importLegacy: async () => {
    try {
      const report = await importLegacyData();
      get().showToast(
        'success',
        translate('migration.importDone', { imported: report.imported, skipped: report.skipped }),
      );
      logger.info('migration.import', '已从旧版导入数据', {
        imported: report.imported,
        skipped: report.skipped,
        backup: report.backupDir,
      });
      void get().refreshBatches();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      get().showToast('error', translate('migration.importFailed', { message }));
      logger.error('migration.import.failed', message);
    }
  },
  closeFailureReport: () => set({ failureReport: null }),
  acknowledgeFailure: (id) =>
    set((s) => {
      if (!s.failureReport) return {};
      const items = s.failureReport.items.filter((item) => item.id !== id);
      return { failureReport: items.length ? { ...s.failureReport, items } : null };
    }),
  loadMetaFields: async (paths) => {
    if (!isDesktop || !paths.length) return;
    const missing = paths.filter((p) => !get().metaFields[p]);
    if (!missing.length) return;
    try {
      const fields = await renameFields(missing);
      set((s) => ({
        metaFields: {
          ...s.metaFields,
          ...Object.fromEntries(fields.map((f) => [f.path, f])),
        },
      }));
    } catch (err) {
      logger.warn('meta.fields', err instanceof Error ? err.message : String(err));
    }
  },

  openMetadata: async (entry) => {
    set({
      metadata: { open: true, loading: true, path: entry.path, name: entry.name, info: null, error: null },
    });
    try {
      const { readMetadata } = await import('./lib/bridge');
      const info = await readMetadata(entry.path);
      set((s) => (s.metadata.path === entry.path ? { metadata: { ...s.metadata, loading: false, info } } : {}));
      logger.info('metadata.read', '读取只读元数据', { path: entry.path, kind: info.kind });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((s) => (s.metadata.path === entry.path ? { metadata: { ...s.metadata, loading: false, error: message } } : {}));
      logger.warn('metadata.failed', message, { path: entry.path });
    }
  },

  closeMetadata: () =>
    set({ metadata: { open: false, loading: false, path: '', name: '', info: null, error: null } }),

  openPlanExport: () => {
    const rules = get().rules;
    if (!rules.length) {
      get().showToast('info', translate('toast.planEmpty'));
      return;
    }
    set({ planDialog: { mode: 'export', name: translate('plan.defaultName'), count: rules.length } });
  },

  openPlanImport: async () => {
    try {
      const { openTextFile } = await import('./lib/bridge');
      const res = await openTextFile(planFilter());
      if (res.canceled) return;
      if (res.error) {
        set({
          planDialog: {
            mode: 'import',
            fileName: res.path ?? translate('plan.unknownFile'),
            name: '',
            rules: [],
            warnings: [],
            error: res.error,
            checksumOk: false,
          },
        });
        return;
      }
      const validation = parsePlan(res.text ?? '', res.path);
      set({
        planDialog: {
          mode: 'import',
          fileName: res.path ?? translate('plan.defaultFile'),
          name: validation.name,
          rules: validation.rules,
          warnings: validation.warnings,
          error: validation.error ?? null,
          version: validation.version,
          checksumOk: validation.checksumOk,
        },
      });
      logger.info('plan.import.read', '读取方案文件', {
        file: res.path,
        rules: validation.rules.length,
        ok: validation.ok,
      });
    } catch (err) {
      get().showToast('error', translate('toast.planImportFailed', { message: err instanceof Error ? err.message : String(err) }));
    }
  },

  setPlanName: (name) =>
    set((s) => (s.planDialog && s.planDialog.mode === 'export' ? { planDialog: { ...s.planDialog, name } } : {})),

  closePlanDialog: () => set({ planDialog: null }),

  confirmPlanExport: async () => {
    const dialog = get().planDialog;
    if (!dialog || dialog.mode !== 'export') return;
    const safe = dialog.name.trim().replace(/[\\/:*?"<>|]/g, '_') || translate('plan.defaultName');
    const text = serializePlan(dialog.name, get().rules);
    try {
      const { saveTextFile } = await import('./lib/bridge');
      const res = await saveTextFile(`${safe}.json`, text, planFilter());
      if (res.canceled) return;
      if (!res.ok) {
        get().showToast('error', translate('toast.planFailed', { message: res.error ?? '' }));
        return;
      }
      set({ planDialog: null });
      get().showToast(
        'success',
        res.backup
          ? translate('toast.planSavedBackup', { path: res.backup })
          : translate('toast.planSaved', { path: res.path ?? '' }),
      );
      logger.info('plan.export.done', '保存方案', { path: res.path, backup: res.backup ?? null });
    } catch (err) {
      get().showToast('error', translate('toast.planFailed', { message: err instanceof Error ? err.message : String(err) }));
    }
  },

  confirmPlanImport: () => {
    const dialog = get().planDialog;
    if (!dialog || dialog.mode !== 'import' || dialog.error) return;
    const replaced = get().rules.length;
    set({ rules: dialog.rules, openRuleId: null, planDialog: null });
    get().showToast(
      dialog.warnings.length ? 'warn' : 'success',
      translate('plan.toastImported', {
        name: dialog.name || translate('plan.defaultName'),
        count: dialog.rules.length,
        replaced: replaced ? translate('plan.toastReplaced', { count: replaced }) : '',
        warning: dialog.warnings.length ? translate('plan.toastWarning', { warning: dialog.warnings[0] }) : '',
      }),
    );
    logger.info('plan.import.done', '导入方案', { rules: dialog.rules.length, replaced });
  },
}));
