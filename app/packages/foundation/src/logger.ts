/**
 * 日志与崩溃上报（本地优先）：
 * - 环形缓冲，UI 可直接展示；
 * - 安装全局错误 / Promise 拒绝 / Tauri 崩溃钩子；
 * - 通过 sink 把日志落盘或上报，默认只在内存 + localStorage。
 * 不内置任何远端上报地址，避免悄悄上传数据。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  event: string;
  message?: string;
  data?: unknown;
}

export type LogSink = (entry: LogEntry) => void;

export interface LoggerOptions {
  maxEntries?: number;
  sink?: LogSink;
  /** localStorage key，默认关闭持久化 */
  persistKey?: string;
  appName?: string;
}

let idSeq = 0;

export class Logger {
  private entries: LogEntry[] = [];
  private listeners = new Set<(entries: LogEntry[]) => void>();
  private readonly maxEntries: number;
  private readonly sink?: LogSink;
  private readonly persistKey?: string;
  private uninstallers: Array<() => void> = [];

  constructor(opts: LoggerOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 500;
    this.sink = opts.sink;
    this.persistKey = opts.persistKey;
    if (this.persistKey) this.restore();
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(this.persistKey!);
      if (!raw) return;
      const parsed = JSON.parse(raw) as LogEntry[];
      if (Array.isArray(parsed)) this.entries = parsed.slice(-this.maxEntries);
    } catch {
      /* ignore */
    }
  }

  private persist(): void {
    if (!this.persistKey) return;
    try {
      localStorage.setItem(this.persistKey, JSON.stringify(this.entries.slice(-200)));
    } catch {
      /* quota */
    }
  }

  log(level: LogLevel, event: string, message?: string, data?: unknown): LogEntry {
    idSeq += 1;
    const entry: LogEntry = { id: idSeq, ts: Date.now(), level, event, message, data };
    this.entries = [...this.entries, entry].slice(-this.maxEntries);
    this.listeners.forEach((fn) => fn(this.entries));
    this.persist();
    try {
      this.sink?.(entry);
    } catch {
      /* sink 自身异常不应影响主流程 */
    }
    return entry;
  }

  debug(event: string, message?: string, data?: unknown): LogEntry { return this.log('debug', event, message, data); }
  info(event: string, message?: string, data?: unknown): LogEntry { return this.log('info', event, message, data); }
  warn(event: string, message?: string, data?: unknown): LogEntry { return this.log('warn', event, message, data); }
  error(event: string, message?: string, data?: unknown): LogEntry { return this.log('error', event, message, data); }

  get all(): LogEntry[] {
    return this.entries;
  }

  subscribe(fn: (entries: LogEntry[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  clear(): void {
    this.entries = [];
    this.persist();
    this.listeners.forEach((fn) => fn(this.entries));
  }

  exportText(): string {
    return this.entries
      .map((e) => `${new Date(e.ts).toISOString()} [${e.level.toUpperCase()}] ${e.event}${e.message ? ` — ${e.message}` : ''}${e.data !== undefined ? `\n  ${safeJson(e.data)}` : ''}`)
      .join('\n');
  }

  /** 安装全局崩溃 / 错误捕获，返回卸载函数 */
  installCrashHandlers(extra?: { onCrash?: (message: string, data?: unknown) => void }): () => void {
    if (this.uninstallers.length) return () => this.uninstallAll();

    const onError = (event: ErrorEvent) => {
      this.error('crash.unhandled', event.message, { filename: event.filename, line: event.lineno, col: event.colno });
      extra?.onCrash?.(event.message, event.error);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      this.error('crash.rejection', String(event.reason), { reason: event.reason });
      extra?.onCrash?.(String(event.reason), event.reason);
    };
    const onBeforeUnload = () => this.persist();

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('beforeunload', onBeforeUnload);

    this.uninstallers = [
      () => window.removeEventListener('error', onError),
      () => window.removeEventListener('unhandledrejection', onRejection),
      () => window.removeEventListener('beforeunload', onBeforeUnload),
    ];
    return () => this.uninstallAll();
  }

  private uninstallAll(): void {
    this.uninstallers.forEach((fn) => fn());
    this.uninstallers = [];
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  return new Logger(opts);
}
