/** 桌面端桥接：Tauri 命令、文件对话框、拖放与日志落盘。浏览器中自动降级为演示模式。 */
import type {
  ApplyItemDto, ApplyOptionsDto, ApplyOutcome, ApplyProgress, AttrInfo, AttrSpecDto, BatchMetadata,
  BatchSummary, EnvInfo, Entry, LegacyImportReport, MetadataInfo, MetaFields, MigrationInfo, MoveItemDto,
  MoveSpecDto, OpTargetDto, OpsOutcome,
  PrivilegeInfo, ScanResultDto, StartupMark, TimeInfo, TimeSpecDto, UndoOutcome,
} from './types';
import { PRODUCT_NAME } from './branding';

export const isDesktop: boolean =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as unknown as Record<string, unknown>);

export const demoEnv: EnvInfo = {
  os: 'windows',
  separator: '\\',
  caseSensitive: false,
  componentLimit: 255,
  pathWarnThreshold: 240,
  pathHardLimit: 32767,
  dataDir: '浏览器演示模式',
  creationTimeWritable: true,
  longPathSupport: true,
};

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop) throw new Error('浏览器演示模式：未连接桌面端');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

export async function getEnvInfo(): Promise<EnvInfo | null> {
  if (!isDesktop) return null;
  try {
    return await invoke<EnvInfo>('env_info');
  } catch {
    return null;
  }
}

/** 当前进程是否提权、安装目录与数据目录；浏览器演示模式返回 null。 */
export async function getPrivilegeInfo(): Promise<PrivilegeInfo | null> {
  if (!isDesktop) return null;
  try {
    return await invoke<PrivilegeInfo>('privilege_info');
  } catch {
    return null;
  }
}

/** 以管理员身份重启自身：true=新进程已启动，false=用户取消 UAC。 */
export async function relaunchAsAdmin(): Promise<boolean> {
  return invoke<boolean>('relaunch_as_admin');
}

/** 批量读取供「按元数据取名」使用的只读字段（EXIF / ID3），缺失为空串。 */
export async function renameFields(paths: string[]): Promise<MetaFields[]> {
  if (!isDesktop) return [];
  return invoke<MetaFields[]>('rename_fields', { paths });
}

/** 旧版数据迁移结果；浏览器演示模式返回 null。 */
export async function getMigrationInfo(): Promise<MigrationInfo | null> {
  if (!isDesktop) return null;
  try {
    return await invoke<MigrationInfo>('migration_info');
  } catch {
    return null;
  }
}

/** 从旧版（Rename Studio）导入数据：先备份当前数据目录，再补齐旧目录独有文件。 */
export async function importLegacyData(): Promise<LegacyImportReport> {
  return invoke<LegacyImportReport>('import_legacy_data');
}

export async function scanPaths(
  paths: string[],
  options: {
    recursive: boolean;
    includeFiles: boolean;
    includeDirs: boolean;
    includePatterns: string[];
    excludePatterns: string[];
    includeHidden: boolean;
    maxEntries?: number;
  },
): Promise<ScanResultDto> {
  return invoke<ScanResultDto>('scan_paths', {
    paths,
    options: {
      recursive: options.recursive,
      includeFiles: options.includeFiles,
      includeDirs: options.includeDirs,
      followSymlinks: false,
      includePatterns: options.includePatterns,
      excludePatterns: options.excludePatterns,
      includeHidden: options.includeHidden,
      maxEntries: options.maxEntries ?? 20000,
      namePatternsArePaths: false,
    },
  });
}

export async function pathsExist(paths: string[]): Promise<boolean[]> {
  if (!paths.length) return [];
  return invoke<boolean[]>('paths_exist', { paths });
}

export async function applyPlan(items: ApplyItemDto[], options: ApplyOptionsDto): Promise<ApplyOutcome> {
  return invoke<ApplyOutcome>('apply_plan', { items, options });
}

/** 请求取消正在执行的批次；返回是否确实有任务在跑。 */
export async function cancelApply(): Promise<boolean> {
  if (!isDesktop) return false;
  try {
    return await invoke<boolean>('cancel_apply');
  } catch {
    return false;
  }
}

/** 订阅批次执行进度；返回取消订阅函数。 */
export async function onApplyProgress(handler: (progress: ApplyProgress) => void): Promise<() => void> {
  if (!isDesktop) return () => undefined;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<ApplyProgress>('apply-progress', (event) => handler(event.payload));
    return unlisten;
  } catch {
    return () => undefined;
  }
}

/** 启动分段计时上报：写 startup.log；`reveal` 时同时显示主窗口。 */
export async function startupReport(
  marks: StartupMark[],
  theme: 'light' | 'dark',
  reveal: boolean,
): Promise<void> {
  if (!isDesktop) return;
  try {
    await invoke('startup_report', { marks, theme, reveal });
  } catch {
    /* 启动日志失败不影响应用 */
  }
}

export async function undoBatch(id: string): Promise<UndoOutcome> {
  return invoke<UndoOutcome>('undo_batch', { id });
}

/** 读取时间原值（只读），用于时间修改的「原值 → 新值」预览。 */
export async function readTimes(paths: string[]): Promise<TimeInfo[]> {
  if (!paths.length) return [];
  return invoke<TimeInfo[]>('read_times', { paths });
}

/** 读取只读 / 隐藏属性原值（只读）。 */
export async function readAttrs(paths: string[]): Promise<AttrInfo[]> {
  if (!paths.length) return [];
  return invoke<AttrInfo[]>('read_attrs', { paths });
}

/** 批量修改时间；先写批次日志再逐条写入。 */
export async function applyTime(items: OpTargetDto[], spec: TimeSpecDto): Promise<OpsOutcome> {
  return invoke<OpsOutcome>('apply_time', { items, spec });
}

/** 批量修改基础属性。 */
export async function applyAttrs(items: OpTargetDto[], spec: AttrSpecDto): Promise<OpsOutcome> {
  return invoke<OpsOutcome>('apply_attrs', { items, spec });
}

/** 归类移动；目标目录自动创建，跨盘复制校验后删源。 */
export async function applyMove(items: MoveItemDto[], spec: MoveSpecDto): Promise<OpsOutcome> {
  return invoke<OpsOutcome>('apply_move', { items, spec });
}

export async function listBatches(): Promise<BatchSummary[]> {
  if (!isDesktop) return [];
  try {
    return await invoke<BatchSummary[]>('list_batches');
  } catch {
    return [];
  }
}

export async function pickFiles(): Promise<string[]> {
  if (!isDesktop) return [];
  const { open } = await import('@tauri-apps/plugin-dialog');
  const result = await open({ multiple: true, directory: false, title: `添加文件到 ${PRODUCT_NAME}` });
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

export async function pickFolders(): Promise<string[]> {
  if (!isDesktop) return [];
  const { open } = await import('@tauri-apps/plugin-dialog');
  const result = await open({ multiple: true, directory: true, title: `添加文件夹到 ${PRODUCT_NAME}` });
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

export async function installDropHandler(
  onDrop: (paths: string[]) => void,
  /** files 为该阶段携带的路径数量：enter 只有在 > 0 时才是真正的文件拖入。 */
  onPhase?: (phase: 'enter' | 'over' | 'drop' | 'leave', files: number) => void,
): Promise<() => void> {
  if (!isDesktop) return () => undefined;
  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    return await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === 'drop') {
        onPhase?.('drop', payload.paths.length);
        onDrop(payload.paths);
      } else if (payload.type === 'enter') {
        onPhase?.('enter', payload.paths.length);
      } else {
        onPhase?.(payload.type, 0);
      }
    });
  } catch {
    return () => undefined;
  }
}

export async function revealPath(path: string): Promise<void> {
  if (!isDesktop) return;
  await invoke('reveal_path', { path });
}

export async function logToDisk(level: string, event: string, message?: string): Promise<void> {
  if (!isDesktop) return;
  try {
    await invoke('append_log', { level, event, message: message ?? null });
  } catch {
    /* 日志失败不影响业务 */
  }
}

/** 只读元数据：桌面端调用 Rust 解析器，演示模式返回与文件名匹配的示例数据。 */
export async function readMetadata(path: string): Promise<MetadataInfo> {
  if (!isDesktop) return demoMetadata(path);
  return invoke<MetadataInfo>('read_metadata', { path });
}

/** 批量只读元数据：九类列表页签一次加载，单条失败逐条返回。 */
export async function readMetadataBatch(paths: string[]): Promise<BatchMetadata[]> {
  if (!paths.length) return [];
  if (!isDesktop) {
    return paths.map((path) => ({ path, info: demoMetadata(path), error: null }));
  }
  return invoke<BatchMetadata[]>('read_metadata_batch', { paths });
}

export interface TextFileFilter {
  name: string;
  extensions: string[];
}

export interface SaveTextResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  backup?: string | null;
  error?: string;
}

/** 保存文本到用户选择的位置：临时文件 + fsync + 两阶段改名；覆盖时先备份。 */
export async function saveTextFile(
  defaultName: string,
  content: string,
  filters: TextFileFilter[],
): Promise<SaveTextResult> {
  if (!isDesktop) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = defaultName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    return { ok: true, path: `浏览器下载/${defaultName}`, backup: null };
  }
  const { save } = await import('@tauri-apps/plugin-dialog');
  const target = await save({
    title: '保存到',
    defaultPath: defaultName,
    filters,
  });
  if (!target) return { ok: false, canceled: true };
  try {
    const backup = await invoke<string | null>('write_text_atomic', {
      path: target,
      content,
      overwrite: true,
    });
    return { ok: true, path: target, backup };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 选择并读取一个 UTF-8 文本文件；演示模式使用浏览器文件选择器。 */
export async function openTextFile(filters: TextFileFilter[]): Promise<{ canceled?: boolean; path?: string; text?: string; error?: string }> {
  if (!isDesktop) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = filters.flatMap((f) => f.extensions.map((e) => `.${e}`)).join(',');
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) {
          resolve({ canceled: true });
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve({ path: file.name, text: String(reader.result ?? '') });
        reader.onerror = () => resolve({ error: '读取文件失败' });
        reader.readAsText(file, 'utf-8');
      };
      input.click();
    });
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ multiple: false, directory: false, title: '打开方案', filters });
  if (!picked) return { canceled: true };
  const path = Array.isArray(picked) ? picked[0] : picked;
  try {
    const text = await invoke<string>('read_text_file', { path });
    return { path, text };
  } catch (err) {
    return { path, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 演示模式的只读元数据样本（不读取真实文件）。 */
export function demoMetadata(path: string): MetadataInfo {
  const name = path.split(/[\\/]/).pop() ?? path;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const base: MetadataInfo = {
    kind: 'other',
    format: '演示样本',
    readOnly: true,
    fields: [],
    warnings: ['浏览器演示模式：展示的是示例元数据，未读取真实文件'],
  };
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext)) {
    return {
      ...base,
      kind: 'image',
      format: `${ext.toUpperCase()} 图像`,
      fields: [
        { label: '尺寸', value: '4032 × 3024 px' },
        { label: '相机品牌', value: 'DemoCam' },
        { label: '相机型号', value: 'X100' },
        { label: '拍摄时间', value: '2025-06-18 09:12:33' },
        { label: '方向', value: '正常' },
      ],
    };
  }
  if (['mp3', 'flac', 'm4a', 'wav'].includes(ext)) {
    return {
      ...base,
      kind: 'audio',
      format: `${ext.toUpperCase()} 音频`,
      fields: [
        { label: '标题', value: '夜曲' },
        { label: '艺术家', value: '周杰伦' },
        { label: '专辑', value: '十一月的萧邦' },
        { label: '年份', value: '2005' },
        { label: '采样率', value: '44.1 kHz' },
      ],
    };
  }
  if (['docx', 'doc', 'pdf', 'odt'].includes(ext)) {
    return {
      ...base,
      kind: 'document',
      format: `${ext.toUpperCase()} 文档`,
      fields: [
        { label: '标题', value: '会议记录（演示）' },
        { label: '作者', value: '张三' },
        { label: '创建时间', value: '2026-02-01 10:00:00' },
      ],
    };
  }
  return {
    ...base,
    warnings: [...base.warnings, '该类型暂无演示元数据'],
  };
}

/** 浏览器演示用样本（不读写真实磁盘） */
export function demoEntries(): Entry[] {
  const root = 'D:\\素材库';
  const rows: Array<[string, boolean, number, boolean]> = [
    ['旅行\\旧照片 001.jpg', false, 2_411_520, false],
    ['旅行\\旧照片 002.jpg', false, 3_152_000, false],
    ['旅行\\旧照片 003.jpg', false, 1_998_848, true],
    ['旅行\\旧照片 004.jpg', false, 2_883_584, false],
    ['设计\\设计稿 v1.png', false, 812_000, false],
    ['设计\\😀表情包.png', false, 190_464, false],
    ['文档\\会议记录 2026.txt', false, 2_048, false],
    ['文档\\空文件.dat', false, 0, false],
    ['待整理', true, 0, false],
  ];
  return rows.map(([rel, isDir, size, readonly]) => {
    const path = `${root}\\${rel}`;
    const name = rel.split('\\').pop() ?? rel;
    const parent = path.slice(0, path.lastIndexOf('\\'));
    return {
      id: path,
      path,
      name,
      parent,
      isDir,
      size,
      modified: Date.now() - 86_400_000 * 2,
      readonly,
      selected: true,
    };
  });
}

/** 演示模式下"磁盘上已存在"的目标（用于展示冲突策略） */
export const demoExistingPaths = ['D:\\素材库\\旅行\\旅行_004.jpg'];
