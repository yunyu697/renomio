/**
 * 自动更新适配器：只定义稳定的接口与状态机，不绑定具体实现。
 * 业务侧注入 backend（Tauri updater / Electron autoUpdater / 自建 HTTP）。
 * 默认 unsupported backend，UI 必须显示"未启用"，不做假成功。
 */
export interface UpdateInfo {
  version: string;
  notes?: string;
  releasedAt?: string;
  /** 下载地址等由 backend 自行解释 */
  meta?: Record<string, unknown>;
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'unsupported'
  | 'installing'
  | 'error';

export interface UpdateProgress {
  downloaded: number;
  total?: number;
  percent?: number;
  message?: string;
}

export interface UpdateBackend {
  readonly name: string;
  /** 返回 null 表示已是最新；抛错表示检查失败 */
  check(): Promise<UpdateInfo | null>;
  install(info: UpdateInfo, onProgress: (p: UpdateProgress) => void): Promise<void>;
}

export interface UpdaterSnapshot {
  status: UpdateStatus;
  info?: UpdateInfo;
  error?: string;
  progress?: UpdateProgress;
  lastCheckedAt?: number;
}

export class UnsupportedUpdateBackend implements UpdateBackend {
  readonly name = 'unsupported';
  async check(): Promise<UpdateInfo | null> {
    throw new Error('自动更新未启用：未配置更新后端');
  }
  async install(): Promise<void> {
    throw new Error('自动更新未启用');
  }
}

export class Updater {
  private backend: UpdateBackend;
  private snapshot: UpdaterSnapshot = { status: 'idle' };
  private listeners = new Set<(s: UpdaterSnapshot) => void>();

  constructor(backend: UpdateBackend = new UnsupportedUpdateBackend()) {
    this.backend = backend;
    this.snapshot.status = backend.name === 'unsupported' ? 'unsupported' : 'idle';
  }

  setBackend(backend: UpdateBackend): void {
    this.backend = backend;
    this.set({ status: backend.name === 'unsupported' ? 'unsupported' : 'idle' });
  }

  get state(): UpdaterSnapshot {
    return this.snapshot;
  }

  get enabled(): boolean {
    return this.backend.name !== 'unsupported';
  }

  subscribe(fn: (s: UpdaterSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<UpdaterSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((fn) => fn(this.snapshot));
  }

  async check(): Promise<UpdaterSnapshot> {
    if (!this.enabled) {
      this.set({ status: 'unsupported' });
      return this.snapshot;
    }
    this.set({ status: 'checking', error: undefined });
    try {
      const info = await this.backend.check();
      this.set({
        status: info ? 'available' : 'up-to-date',
        info: info ?? undefined,
        lastCheckedAt: Date.now(),
      });
    } catch (err) {
      this.set({ status: 'error', error: err instanceof Error ? err.message : String(err), lastCheckedAt: Date.now() });
    }
    return this.snapshot;
  }

  async install(): Promise<void> {
    if (!this.snapshot.info) throw new Error('没有可安装的更新');
    this.set({ status: 'installing', progress: { downloaded: 0 } });
    try {
      await this.backend.install(this.snapshot.info, (progress) => this.set({ progress }));
      this.set({ status: 'idle', info: undefined });
    } catch (err) {
      this.set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }
}

export function createUpdater(backend?: UpdateBackend): Updater {
  return new Updater(backend);
}
