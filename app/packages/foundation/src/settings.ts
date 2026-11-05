/**
 * 版本化设置存储：schema 迁移、损坏自愈、订阅通知、原子写入（localStorage）。
 * 业务只关心自己的 Settings 类型，不需要重复处理版本与容错。
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SettingsMigration<T> {
  /** 从旧版本升级：返回迁移后的数据；抛错则走默认值 + 备份 */
  (fromVersion: number, data: unknown): T | null;
}

export interface SettingsOptions<T> {
  key: string;
  version: number;
  defaults: T;
  storage?: StorageLike;
  migrate?: SettingsMigration<T>;
  /** 解析失败时保留原始字符串的备份 key，默认 `${key}.corrupt` */
  corruptBackupKey?: string;
}

interface Envelope<T> {
  version: number;
  data: T;
}

function resolveStorage(storage?: StorageLike): StorageLike | null {
  if (storage) return storage;
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* 隐私模式等场景忽略 */
  }
  return null;
}

export class SettingsStore<T extends object> {
  private readonly opts: SettingsOptions<T>;
  private readonly storage: StorageLike | null;
  private state: T;
  private listeners = new Set<(value: T, changed: (keyof T)[]) => void>();
  /** 本次加载是否触发了损坏自愈 */
  recovered = false;

  constructor(opts: SettingsOptions<T>) {
    this.opts = opts;
    this.storage = resolveStorage(opts.storage);
    this.state = this.load();
  }

  get value(): T {
    return this.state;
  }

  get<V extends T[keyof T]>(key: keyof T): V {
    return this.state[key] as V;
  }

  private load(): T {
    if (!this.storage) return { ...this.opts.defaults };
    const raw = this.storage.getItem(this.opts.key);
    if (!raw) return { ...this.opts.defaults };

    try {
      const parsed = JSON.parse(raw) as Partial<Envelope<T>>;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.version !== 'number') {
        throw new Error('设置格式无效');
      }
      if (parsed.version === this.opts.version) {
        return { ...this.opts.defaults, ...(parsed.data as T) };
      }
      const migrated = this.opts.migrate?.(parsed.version, parsed.data);
      if (migrated) return { ...this.opts.defaults, ...migrated };
      // 无法迁移的旧版本：保留备份后回到默认值
      this.storage.setItem(this.opts.corruptBackupKey ?? `${this.opts.key}.corrupt`, raw);
      this.recovered = true;
      return { ...this.opts.defaults };
    } catch {
      this.storage.setItem(this.opts.corruptBackupKey ?? `${this.opts.key}.corrupt`, raw);
      this.recovered = true;
      return { ...this.opts.defaults };
    }
  }

  save(patch: Partial<T>): T {
    const changed = (Object.keys(patch) as (keyof T)[]).filter((k) => patch[k] !== undefined);
    const next = { ...this.state, ...patch };
    this.state = next;
    if (this.storage) {
      const envelope: Envelope<T> = { version: this.opts.version, data: next };
      try {
        this.storage.setItem(this.opts.key, JSON.stringify(envelope));
      } catch {
        /* 配额不足时不影响内存状态 */
      }
    }
    this.listeners.forEach((fn) => fn(next, changed));
    return next;
  }

  reset(): T {
    this.state = { ...this.opts.defaults };
    if (this.storage) this.storage.removeItem(this.opts.key);
    this.listeners.forEach((fn) => fn(this.state, Object.keys(this.state) as (keyof T)[]));
    return this.state;
  }

  subscribe(fn: (value: T, changed: (keyof T)[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export function createSettings<T extends object>(opts: SettingsOptions<T>): SettingsStore<T> {
  return new SettingsStore(opts);
}
