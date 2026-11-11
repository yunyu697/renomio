/** 桌面端桥接：Tauri 命令、文件对话框、拖放与日志落盘。浏览器中自动降级为演示模式。 */
import type {
  ApplyItemDto, ApplyOptionsDto, ApplyOutcome, ApplyProgress, AttrInfo, AttrSpecDto, BatchMetadata,
  BatchSummary, DuplicateReportDto, EnvInfo, Entry, ExifClearRequestDto, ExifClearResultDto,
  ExifInventoryDto, FileTypeIconDto, LegacyImportReport, MetaCapabilityDto,
  MetaEditRequestDto, MetaEditResultDto, MetadataInfo, MetaFields, MetaSnapshotDto, MigrationInfo,
  MoveItemDto, MoveSpecDto, OpTargetDto, OpsOutcome,
  PrivilegeInfo, SavedUpdate, ScanResultDto, SnapshotDto, SnapshotPlanItemDto, SnapshotProgress,
  SnapshotRestoreResult, SnapshotSummaryDto, StartupMark, TextBatchRequestDto, TextBatchResultDto,
  TextDetectDto, TextSaveRequestDto,
  TextSaveResultDto, TimeInfo, TimeSpecDto, UndoOutcome,
  UpdateInfo, UpdateProgress,
} from './types';
import { PRODUCT_NAME } from './branding';
import { normalizeHistory, type RuleHistory } from './history';

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

export interface FileHashResult {
  path: string;
  crc32?: string | null;
  md5?: string | null;
  sha1?: string | null;
  error?: string | null;
}

/** 元变量内容哈希：单遍流式读取，仅计算请求的算法；取消用 cancelFileHashes。 */
export async function fileHashes(paths: string[], algos: string[]): Promise<FileHashResult[]> {
  if (!isDesktop) return [];
  return invoke<FileHashResult[]>('file_hashes', { paths, algos });
}

export async function cancelFileHashes(): Promise<boolean> {
  if (!isDesktop) return false;
  return invoke<boolean>('cancel_hash');
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

/** 订阅快照生成/还原进度；返回取消订阅函数。 */
export async function onSnapshotProgress(handler: (progress: SnapshotProgress) => void): Promise<() => void> {
  if (!isDesktop) return () => undefined;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<SnapshotProgress>('snapshot-progress', (event) => handler(event.payload));
    return unlisten;
  } catch {
    return () => undefined;
  }
}

export async function createSnapshot(
  entries: Array<{ from: string; to: string }>,
  withHash: boolean,
  roots: string[],
): Promise<SnapshotDto> {
  return invoke<SnapshotDto>('create_snapshot', { entries, withHash, roots });
}

export async function cancelSnapshot(): Promise<boolean> {
  if (!isDesktop) return false;
  try {
    return await invoke<boolean>('cancel_snapshot');
  } catch {
    return false;
  }
}

export async function listSnapshots(): Promise<SnapshotSummaryDto[]> {
  if (!isDesktop) return [];
  try {
    return await invoke<SnapshotSummaryDto[]>('list_snapshots');
  } catch {
    return [];
  }
}

export async function previewSnapshot(id: string): Promise<SnapshotPlanItemDto[]> {
  return invoke<SnapshotPlanItemDto[]>('preview_snapshot', { id });
}

export async function restoreSnapshot(id: string): Promise<SnapshotRestoreResult> {
  return invoke<SnapshotRestoreResult>('restore_snapshot', { id });
}

export async function deleteSnapshot(id: string): Promise<void> {
  if (!isDesktop) return;
  await invoke('delete_snapshot', { id });
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

/** 选择一张封面图片（仅 JPEG/PNG；同时限制 5 MB 上限由 Rust 侧再校验一次）。 */
export async function pickCoverImage(): Promise<string | null> {
  if (!isDesktop) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const result = await open({
    multiple: false,
    directory: false,
    title: '选择封面图片（JPEG/PNG，≤ 5 MB）',
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png'] }],
  });
  if (!result) return null;
  return Array.isArray(result) ? result[0] ?? null : result;
}

// ---------------------------------------------------------------------------
// 可编辑元数据（图片 / 音乐 / 文档）
// ---------------------------------------------------------------------------

/** 元数据写入支持矩阵：不支持的格式会明确列出，界面据此提示。 */
export async function metaCapabilities(): Promise<MetaCapabilityDto[]> {
  if (!isDesktop) return demoCapabilities();
  return invoke<MetaCapabilityDto[]>('meta_capabilities');
}

/** 读取某文件的现有属性（编辑对话框预填；只读）。 */
export async function metaRead(path: string): Promise<MetaSnapshotDto> {
  if (!isDesktop) return demoMetaSnapshot(path);
  return invoke<MetaSnapshotDto>('meta_read', { path });
}

/** 批量写入：逐文件返回成功/失败、备份路径与回读校验结果。 */
export async function metaEdit(items: MetaEditRequestDto[]): Promise<MetaEditResultDto[]> {
  if (!isDesktop) return items.map(demoMetaEdit);
  return invoke<MetaEditResultDto[]>('meta_edit', { items });
}

/** 从备份还原（还原前自动为当前文件再留一份保险备份）。 */
export async function metaRestoreBackup(backup: string, target: string): Promise<string> {
  if (!isDesktop) throw new Error('浏览器演示模式：未连接桌面端');
  return invoke<string>('meta_restore_backup', { backup, target });
}

/** EXIF 清除前预览：按文件实际存在的条目列出（只读）。 */
export async function exifInventory(path: string): Promise<ExifInventoryDto> {
  if (!isDesktop) throw new Error('浏览器演示模式：未连接桌面端');
  return invoke<ExifInventoryDto>('exif_inventory', { path });
}

/** EXIF 分组清除：备份 → 重建 → 回读校验（Orientation 与 ICC 保留）。 */
export async function exifClear(items: ExifClearRequestDto[]): Promise<ExifClearResultDto[]> {
  if (!isDesktop) throw new Error('浏览器演示模式：未连接桌面端');
  return invoke<ExifClearResultDto[]>('exif_clear', { items });
}

/** 文本编码探测（只读；非 UTF-8 只做试探并标记未确认）。 */
export async function textDetect(path: string): Promise<TextDetectDto> {
  if (!isDesktop) throw new Error('浏览器演示模式：未连接桌面端');
  return invoke<TextDetectDto>('text_detect', { path });
}

/** 文本编码转换：原地覆盖默认备份，可另存；写完回读校验。 */
export async function textSave(req: TextSaveRequestDto): Promise<TextSaveResultDto> {
  if (!isDesktop) throw new Error('浏览器演示模式：未连接桌面端');
  return invoke<TextSaveResultDto>('text_save', { req });
}

/** 批量文本编码转换：逐条结果，单条失败不影响其余。 */
export async function textSaveBatch(req: TextBatchRequestDto): Promise<TextBatchResultDto> {
  if (!isDesktop) throw new Error('浏览器演示模式：未连接桌面端');
  return invoke<TextBatchResultDto>('text_save_batch', { req });
}

/** 内容完全相同（不同路径）的疑似重复组；只读，不删除文件。 */
export async function findDuplicates(paths: string[]): Promise<DuplicateReportDto> {
  if (!isDesktop) {
    const bySize = new Map<number, string[]>();
    for (const path of new Set(paths)) {
      const entry = demoEntries().find((e) => e.path === path);
      if (!entry || entry.isDir) continue;
      const list = bySize.get(entry.size) ?? [];
      list.push(path);
      bySize.set(entry.size, list);
    }
    const groups = [...bySize.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([size, list]) => ({ size, hash: `demo-${size}`, paths: [...list].sort() }));
    return { groups, scanned: paths.length, warnings: [] };
  }
  return invoke<DuplicateReportDto>('find_duplicates', { paths });
}

const DEMO_META_KEY = 'rename-studio.demo.meta';

function demoKindOf(path: string): { kind: string; format: string; writable: boolean } {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg'].includes(ext)) return { kind: 'image', format: 'JPEG', writable: true };
  if (ext === 'png') return { kind: 'image', format: 'PNG', writable: true };
  if (ext === 'webp') return { kind: 'image', format: 'WebP', writable: true };
  if (['tif', 'tiff'].includes(ext)) return { kind: 'image', format: 'TIFF', writable: true };
  if (['heic', 'heif'].includes(ext)) return { kind: 'image', format: 'HEIC/HEIF', writable: false };
  if (['gif', 'bmp', 'avif'].includes(ext)) return { kind: 'image', format: ext.toUpperCase(), writable: false };
  if (ext === 'mp3') return { kind: 'audio', format: 'MP3', writable: true };
  if (ext === 'flac') return { kind: 'audio', format: 'FLAC', writable: true };
  if (['m4a', 'mp4'].includes(ext)) return { kind: 'audio', format: 'M4A/MP4', writable: true };
  if (['ogg', 'opus'].includes(ext)) return { kind: 'audio', format: 'OGG (Vorbis/Opus)', writable: true };
  if (['wma', 'ape', 'wav', 'aiff'].includes(ext)) return { kind: 'audio', format: ext.toUpperCase(), writable: false };
  if (ext === 'docx') return { kind: 'document', format: 'DOCX', writable: true };
  if (ext === 'xlsx') return { kind: 'document', format: 'XLSX', writable: true };
  if (ext === 'pptx') return { kind: 'document', format: 'PPTX', writable: true };
  if (ext === 'pdf') return { kind: 'document', format: 'PDF', writable: true };
  if (['doc', 'xls', 'ppt', 'odt', 'ods', 'odp'].includes(ext)) {
    return { kind: 'document', format: ext.toUpperCase(), writable: false };
  }
  return { kind: 'other', format: ext.toUpperCase() || '未知', writable: false };
}

function demoDefaults(path: string): Record<string, string> {
  const { kind } = demoKindOf(path);
  if (kind === 'image') {
    return { title: '旅行随拍', description: '海边日落', keywords: '旅行; 海边', author: '张三', copyright: '© 2026 张三', software: 'Renomio', takenAt: '2024-05-01T08:30:00' };
  }
  if (kind === 'audio') {
    return { title: '夜曲', artist: '周杰伦', album: '十一月的萧邦', year: '2005', track: '1', genre: '流行', comment: '', albumArtist: '周杰伦' };
  }
  if (kind === 'document') {
    return { title: '会议记录', subject: '周会', author: '张三', lastModifiedBy: '张三', keywords: '会议; 纪要', comment: '内部资料', category: '文档' };
  }
  return {};
}

function demoMetaStore(): Record<string, Record<string, string>> {
  try {
    const raw = localStorage.getItem(DEMO_META_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Record<string, string>>) : {};
  } catch {
    return {};
  }
}

function demoMetaSave(store: Record<string, Record<string, string>>) {
  try {
    localStorage.setItem(DEMO_META_KEY, JSON.stringify(store));
  } catch {
    // 忽略
  }
}

function demoMetaSnapshot(path: string): MetaSnapshotDto {
  const { kind, format, writable } = demoKindOf(path);
  const store = demoMetaStore();
  const fields = store[path] ?? demoDefaults(path);
  const supportedFields =
    kind === 'image'
      ? ['title', 'description', 'keywords', 'author', 'copyright', 'software', 'takenAt']
      : kind === 'audio'
        ? ['title', 'artist', 'album', 'year', 'track', 'genre', 'comment', 'albumArtist', 'cover']
        : kind === 'document'
          ? ['title', 'subject', 'author', 'lastModifiedBy', 'keywords', 'comment', 'category']
          : [];
  return {
    path,
    kind,
    format,
    writable,
    supportedFields,
    fields,
    cover: kind === 'audio' ? null : null,
    warnings: [],
    unsupportedReason: writable ? null : `${format} 本版本不支持写入（如实拒绝，不做假支持）`,
  };
}

function demoMetaEdit(req: MetaEditRequestDto): MetaEditResultDto {
  const snap = demoMetaSnapshot(req.path);
  const started = Date.now();
  const base = {
    path: req.path,
    kind: snap.kind,
    format: snap.format,
    backup: null as string | null,
    written: [] as string[],
    cleared: [] as string[],
    ignored: [] as string[],
    verified: false,
    error: null as string | null,
    warnings: [] as string[],
    elapsedMs: 0,
  };
  if (!snap.writable) {
    return {
      ...base,
      supported: false,
      ok: false,
      error: `${snap.format} 不支持写入：${snap.unsupportedReason ?? '未知原因'}`,
      elapsedMs: Date.now() - started,
    };
  }
  const store = demoMetaStore();
  const current = { ...(store[req.path] ?? demoDefaults(req.path)) };
  for (const [id, value] of Object.entries(req.fields)) {
    if (!snap.supportedFields.includes(id)) {
      return { ...base, supported: true, ok: false, error: `字段 ${id} 不适用于 ${snap.format}`, elapsedMs: Date.now() - started };
    }
    if (value === '') {
      delete current[id];
      base.cleared.push(id);
    } else {
      current[id] = value;
      base.written.push(id);
    }
  }
  if (req.clearCover) base.cleared.push('cover');
  store[req.path] = current;
  demoMetaSave(store);
  const after = demoMetaSnapshot(req.path);
  const mismatch = base.written.filter((id) => after.fields[id] !== req.fields[id]);
  if (mismatch.length) {
    return { ...base, supported: true, ok: false, error: `写入后回读不一致：${mismatch.join(', ')}`, elapsedMs: Date.now() - started };
  }
  return {
    ...base,
    supported: true,
    ok: true,
    backup: req.backup === false ? null : `${req.path}.${Date.now()}.bak`,
    verified: true,
    elapsedMs: Date.now() - started,
  };
}

function demoCapabilities(): MetaCapabilityDto[] {
  const f = (list: string[]) => list;
  return [
    { kind: 'image', format: 'JPEG', read: true, write: true, fields: f(['title', 'description', 'keywords', 'author', 'copyright', 'software', 'takenAt']), notes: 'XMP + EXIF 文本字段；相机参数/GPS/ICC 原样保留' },
    { kind: 'image', format: 'PNG', read: true, write: true, fields: f(['title', 'description', 'keywords', 'author', 'copyright', 'software', 'takenAt']), notes: 'XMP（iTXt）；其余块原样保留' },
    { kind: 'image', format: 'WebP', read: true, write: true, fields: f(['title', 'description', 'keywords', 'author', 'copyright', 'software', 'takenAt']), notes: 'XMP 块；无 VP8X 时自动补建（不重编码像素）' },
    { kind: 'image', format: 'TIFF', read: true, write: true, fields: f(['title', 'description', 'keywords', 'author', 'copyright', 'software', 'takenAt']), notes: 'IFD0 文本字段 + XMP 标签 700' },
    { kind: 'image', format: 'HEIC/HEIF', read: false, write: false, fields: [], notes: '本版本不支持写入，也不假装能读' },
    { kind: 'image', format: 'GIF/BMP/AVIF', read: false, write: false, fields: [], notes: '不支持写入' },
    { kind: 'audio', format: 'MP3 (ID3v2.3/2.4)', read: true, write: true, fields: f(['title', 'artist', 'album', 'year', 'track', 'genre', 'comment', 'albumArtist', 'cover']), notes: 'v2.3 写 UTF-16，v2.4 写 UTF-8；保留其它帧' },
    { kind: 'audio', format: 'FLAC', read: true, write: true, fields: f(['title', 'artist', 'album', 'year', 'track', 'genre', 'comment', 'albumArtist', 'cover']), notes: 'Vorbis comment；保留音频帧' },
    { kind: 'audio', format: 'M4A/MP4', read: true, write: true, fields: f(['title', 'artist', 'album', 'year', 'track', 'genre', 'comment', 'albumArtist', 'cover']), notes: 'iTunes ilst atoms' },
    { kind: 'audio', format: 'OGG (Vorbis)', read: true, write: true, fields: f(['title', 'artist', 'album', 'year', 'track', 'genre', 'comment', 'albumArtist', 'cover']), notes: 'Vorbis comment；重建头部页并重排页序号，补 framing bit' },
    { kind: 'audio', format: 'Opus (Ogg)', read: true, write: true, fields: f(['title', 'artist', 'album', 'year', 'track', 'genre', 'comment', 'albumArtist', 'cover']), notes: 'OpusTags 注释包；重建头部页并重排页序号（无 framing bit）' },
    { kind: 'audio', format: 'WMA/APE/AIFF/WAV', read: false, write: false, fields: [], notes: '如实标注不支持，未静默跳过' },
    { kind: 'document', format: 'DOCX/XLSX/PPTX', read: true, write: true, fields: f(['title', 'subject', 'author', 'lastModifiedBy', 'keywords', 'comment', 'category']), notes: 'docProps/core.xml；不触碰正文' },
    { kind: 'document', format: 'PDF', read: true, write: true, fields: f(['title', 'subject', 'author', 'lastModifiedBy', 'keywords', 'comment', 'category']), notes: 'Info + XMP 增量更新；原页面逐字节保留' },
    { kind: 'document', format: 'DOC/XLS/PPT (OLE)', read: false, write: false, fields: [], notes: '旧版二进制 Office 不支持写入' },
  ];
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

const DEMO_HISTORY_KEY = 'renomio.rule-history';

/** 读取规则链输入历史：桌面端读数据目录下的 rule-history.json，演示模式读 localStorage。 */
export async function loadRuleHistory(): Promise<RuleHistory | null> {
  try {
    if (!isDesktop) {
      const raw = localStorage.getItem(DEMO_HISTORY_KEY);
      return raw ? normalizeHistory(JSON.parse(raw)) : null;
    }
    const raw = await invoke<string>('load_rule_history');
    return raw ? normalizeHistory(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export async function saveRuleHistory(history: RuleHistory): Promise<void> {
  const json = JSON.stringify(history);
  if (!isDesktop) {
    localStorage.setItem(DEMO_HISTORY_KEY, json);
    return;
  }
  await invoke('save_rule_history', { content: json });
}

/** 检查更新；mirror 为 auto / official / ghproxy / gh-proxy / ghfast。 */
export async function checkUpdate(mirror: string): Promise<UpdateInfo> {
  if (!isDesktop) throw new Error('DEMO');
  return invoke<UpdateInfo>('check_update', { mirror });
}

/** 下载更新：install=下载→校验→安装→重启；save=仅下载到默认下载文件夹。 */
export async function downloadUpdate(mode: 'install' | 'save', mirror: string): Promise<SavedUpdate> {
  return invoke<SavedUpdate>('download_update', { mode, mirror });
}

/** 安装此前「仅下载」的包（安装前会再次做签名校验）。 */
export async function installSavedUpdate(path: string, mirror: string): Promise<void> {
  return invoke('install_saved_update', { path, mirror });
}

/** 订阅更新进度；返回取消订阅函数。 */
export async function onUpdateProgress(handler: (progress: UpdateProgress) => void): Promise<() => void> {
  if (!isDesktop) return () => undefined;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<UpdateProgress>('update-progress', (event) => handler(event.payload));
    return unlisten;
  } catch {
    return () => undefined;
  }
}

/** 打开项目主页（桌面端调系统浏览器，演示模式开新标签页）。 */
export async function openHomepage(): Promise<void> {
  if (!isDesktop) {
    window.open('https://github.com/yunyu697/renomio', '_blank', 'noopener');
    return;
  }
  await invoke('open_homepage');
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

/** 系统文件类型图标：按扩展名（或 `folder`）取与资源管理器一致的 16×16 图标；取不到返回空数组。 */
export async function fileTypeIcons(exts: string[]): Promise<FileTypeIconDto[]> {
  if (!isDesktop || !exts.length) return [];
  try {
    return await invoke<FileTypeIconDto[]>('file_type_icons', { exts });
  } catch {
    return [];
  }
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

/** 选择并保存二进制文件（xlsx 等）：浏览器走下载，桌面端 base64 传给原子写入命令。 */
export async function saveBinaryFile(
  defaultName: string,
  content: Uint8Array,
  filters: TextFileFilter[],
  mime = 'application/octet-stream',
): Promise<SaveTextResult> {
  if (!isDesktop) {
    const blob = new Blob([content as BlobPart], { type: mime });
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
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < content.length; i += step) {
      binary += String.fromCharCode(...content.subarray(i, i + step));
    }
    const backup = await invoke<string | null>('write_bytes_atomic', {
      path: target,
      content: btoa(binary),
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
