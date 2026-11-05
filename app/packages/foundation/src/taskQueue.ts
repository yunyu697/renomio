/**
 * 串行任务队列：同一时刻只跑一个重任务（扫描 / 改名 / 撤销），
 * 避免文件系统操作互相干扰，并为 UI 提供统一的进度与取消能力。
 */
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface TaskSnapshot {
  id: string;
  name: string;
  status: TaskStatus;
  progress: number;
  message?: string;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface TaskContext {
  /** 0..1 */
  setProgress(progress: number, message?: string): void;
  /** 任务实现应定期检查，主动中止 */
  readonly cancelled: boolean;
  throwIfCancelled(): void;
}

export type TaskTask<T> = (ctx: TaskContext) => Promise<T>;

export class TaskCancelledError extends Error {
  constructor(message = '任务已取消') {
    super(message);
    this.name = 'TaskCancelledError';
  }
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `t${Date.now().toString(36)}-${seq}`;
}

export class TaskQueue {
  private snapshots: TaskSnapshot[] = [];
  private listeners = new Set<(tasks: TaskSnapshot[]) => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private cancelFlags = new Map<string, boolean>();
  private readonly maxHistory: number;

  constructor(maxHistory = 20) {
    this.maxHistory = maxHistory;
  }

  get tasks(): TaskSnapshot[] {
    return this.snapshots;
  }

  subscribe(fn: (tasks: TaskSnapshot[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const copy = this.snapshots.slice();
    this.listeners.forEach((fn) => fn(copy));
  }

  private patch(id: string, patch: Partial<TaskSnapshot>): void {
    this.snapshots = this.snapshots.map((t) => (t.id === id ? { ...t, ...patch } : t));
    this.emit();
  }

  cancel(id: string): void {
    this.cancelFlags.set(id, true);
  }

  /** 入队并返回任务结果；前序任务完成后才真正开始 */
  enqueue<T>(name: string, task: TaskTask<T>): Promise<T> {
    const id = nextId();
    const snapshot: TaskSnapshot = { id, name, status: 'queued', progress: 0 };
    this.snapshots = [...this.snapshots, snapshot].slice(-this.maxHistory);
    this.emit();

    const run = async (): Promise<T> => {
      const cancelFlags = this.cancelFlags;
      const ctx: TaskContext = {
        setProgress: (progress, message) => {
          this.patch(id, { progress: Math.max(0, Math.min(1, progress)), message });
        },
        get cancelled() {
          return Boolean(cancelFlags.get(id));
        },
        throwIfCancelled: () => {
          if (cancelFlags.get(id)) throw new TaskCancelledError();
        },
      };
      this.patch(id, { status: 'running', startedAt: Date.now(), progress: 0 });
      try {
        const result = await task(ctx);
        this.patch(id, { status: 'done', progress: 1, endedAt: Date.now() });
        return result;
      } catch (err) {
        const cancelled = this.cancelFlags.get(id) || err instanceof TaskCancelledError;
        this.patch(id, {
          status: cancelled ? 'cancelled' : 'failed',
          error: cancelled ? undefined : err instanceof Error ? err.message : String(err),
          endedAt: Date.now(),
        });
        throw err;
      } finally {
        this.cancelFlags.delete(id);
        this.removeOld();
      }
    };

    const promise = this.tail.then(run, run);
    this.tail = promise.catch(() => undefined);
    return promise;
  }

  private removeOld(): void {
    const finished = this.snapshots.filter((t) => t.status !== 'queued' && t.status !== 'running');
    if (finished.length <= 5) return;
    const keep = new Set(finished.slice(-5).map((t) => t.id));
    this.snapshots = this.snapshots.filter((t) => t.status === 'queued' || t.status === 'running' || keep.has(t.id));
    this.emit();
  }

  clearFinished(): void {
    this.snapshots = this.snapshots.filter((t) => t.status === 'queued' || t.status === 'running');
    this.emit();
  }
}
