import type { ShortcutId } from './shortcuts';

export type RuleType = 'add' | 'replace' | 'delete' | 'number' | 'move' | 'case' | 'ext' | 'meta';

export interface Entry {
  id: string;
  path: string;
  name: string;
  parent: string;
  isDir: boolean;
  size: number;
  modified: number;
  readonly: boolean;
  /** 隐藏属性（Windows 属性或名称以 . 开头），来自扫描结果 */
  hidden?: boolean;
  /** 系统属性（仅 Windows 可判定），来自扫描结果 */
  system?: boolean;
  selected: boolean;
}

/** 元变量需要的内容哈希（按需计算，缺失字段为空） */
export interface EntryFacts {
  crc32?: string;
  md5?: string;
  sha1?: string;
  /** 计算失败时的原因（失败文件不再自动重试） */
  error?: string;
}

export interface EnvInfo {
  os: 'windows' | 'macos' | 'linux';
  separator: string;
  caseSensitive: boolean;
  componentLimit: number;
  pathWarnThreshold: number;
  pathHardLimit: number;
  dataDir: string;
  creationTimeWritable: boolean;
  longPathSupport: boolean;
}

export type ConflictPolicy = 'skip' | 'suffix' | 'overwrite';

/** 界面语言设置：跟随系统，或五种受支持语言之一。 */
export type LocaleSetting = 'system' | 'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP' | 'es-ES';

export type ColumnKey = 'name' | 'location' | 'size' | 'modified' | 'newName' | 'status';

/** 规则链与文件列表的预设布局视图。 */
export type LayoutView = 'files-left' | 'rules-left' | 'files-top' | 'rules-top' | 'compact';

/** 规则链折叠/展开状态（随设置持久化，重启后保留）。 */
export interface RuleUiState {
  /** 已展开编辑器的规则 id（单栏下可同时展开多条） */
  expanded: string[];
  /** 当前选中（获得焦点）的规则 id */
  openId: string | null;
  /** 整块规则栏收成窄竖条 */
  collapsed: boolean;
}

/** 布局设置：预设视图 + 可选高级自由拖动尺寸。 */
export interface LayoutState {
  view: LayoutView;
  /** 高级模式：允许拖动分隔条自由调整（默认关闭，使用预设比例） */
  advanced: boolean;
  /** 并排视图下规则栏宽度（旧字段，保留作默认值） */
  side: number;
  /** 上下视图下规则栏高度（旧字段，保留作默认值） */
  stack: number;
  /** 每个视图各自记住的尺寸（并排=宽度，上下=高度），互不串用 */
  sizes: Partial<Record<LayoutView, number>>;
  /** 紧凑视图：规则区底部面板是否展开（持久化） */
  compactOpen: boolean;
}

/** 主题选择：显式浅/深，或跟随系统（运行时随系统切换）。 */
export type ThemeSetting = 'light' | 'dark' | 'system';

/** 配色方案：完整色板，与明暗基调独立组合。 */
export type PaletteId = 'graphite' | 'paper' | 'ocean' | 'moss';

export interface AppSettings {
  theme: ThemeSetting;
  /** 配色方案（默认石墨），与 theme 独立持久化 */
  palette: PaletteId;
  /** 界面语言：跟随系统或五种受支持语言之一（默认 system） */
  language: LocaleSetting;
  strictWindowsNames: boolean;
  readonlySkip: boolean;
  autoPreview: boolean;
  conflictPolicy: ConflictPolicy;
  /** 启动时若未提权，尝试以管理员身份重启（默认关闭；UAC 取消后继续以普通权限运行） */
  alwaysAdmin: boolean;
  /** 自动把 Windows 非法字符替换为指定字符（默认关闭） */
  replaceInvalid: boolean;
  invalidReplacement: string;
  /** 名称长度上限（0 = 平台上限），只能收紧（默认 255） */
  nameMaxLength: number;
  /** 超长名称处理：block 阻止（默认）/ truncate 截断主体保留扩展名 */
  longNameAction: 'block' | 'truncate';
  /** 空名处理：block 阻止（默认）/ fallback 使用备用名 */
  emptyNameAction: 'block' | 'fallback';
  /** 空名备用文本（仅在 fallback 时使用，默认「未命名」） */
  emptyNameFallback: string;
  /** 跳过带系统/隐藏属性的文件（默认 false，与旧行为一致） */
  skipSystemHidden: boolean;
  /** USER1–USER9：名称模板里 <USERn> 展开为对应文本（默认全空） */
  userVars: string[];
  /** USER0：名称模板里 <USER0> 展开的文本（默认空） */
  userVar0: string;
  /** 全局快捷键绑定（命令 id → `Ctrl+Shift+K` 形式），可自定义 */
  shortcuts: Record<ShortcutId, string>;
  columns: Record<ColumnKey, boolean>;
  columnWidths: Partial<Record<ColumnKey, number>>;
  /** 首次启动「已导入上一版本数据」提示已关闭（默认 false，只提示一次） */
  migrationNoticeDismissed: boolean;
  /** 当前规则链（含执行顺序；随设置持久化，重启后顺序不变） */
  rules: Rule[];
  /** 规则栏折叠/展开状态 */
  ruleUi: RuleUiState;
  /** 文件列表与规则链的布局 */
  layout: LayoutState;
}

/** 规则之间（含顶部路径筛选模式）的冲突类型。 */
export type ConflictKind =
  | 'include-exclude'
  | 'path-overlap'
  | 'action-contradiction'
  | 'shadowed'
  | 'regex-overlap';

/** 一条冲突：同一对对象多类型命中的合并为一条。 */
export interface RuleConflict {
  key: string;
  kinds: ConflictKind[];
  /** 涉及的规则 id（路径模式冲突时为空） */
  ruleIds: string[];
  /** 涉及的筛选模式（规则动作冲突时为空） */
  patterns: string[];
  /** 命中摘要（模式文本或规则类型名），用于就地展示 */
  detail: string;
}

/** 首次启动迁移结果（Rust `migration_info`）。 */
export interface MigrationInfo {
  /** no-legacy | skipped-both | migrated | failed */
  status: 'no-legacy' | 'skipped-both' | 'migrated' | 'failed' | string;
  oldDir: string;
  newDir: string;
  oldDirExists: boolean;
  files: number;
  bytes: number;
  migratedAt: number | null;
  error: string | null;
}

/** 设置里「从旧版导入数据」的结果（导入前已备份当前数据目录）。 */
export interface LegacyImportReport {
  imported: number;
  skipped: number;
  bytes: number;
  backupDir: string;
}

/** 权限/失败分类：由 Rust 侧 `classify_failure` 归一，界面据此给不同文案与动作。 */
export type FailureCode =
  | 'access-denied'
  | 'in-use'
  | 'not-found'
  | 'readonly'
  | 'conflict'
  | 'path-too-long'
  | 'invalid-name'
  | 'io-error';

export interface PrivilegeInfo {
  elevated: boolean;
  platform: string;
  exePath: string;
  installDir: string;
  appDataDir: string;
}

interface RuleBase {
  id: string;
  type: RuleType;
  enabled: boolean;
}

export interface AddRule extends RuleBase {
  type: 'add';
  mode: 'direct' | 'pad';
  text: string;
  anchor: 'start' | 'end' | 'at';
  position: number;
  fromEnd: boolean;
  padTo: number;
  padChar: string;
}

export interface ReplaceRule extends RuleBase {
  type: 'replace';
  find: string;
  replace: string;
  caseSensitive: boolean;
  regex: boolean;
  /** 0 = 全部 */
  nth: number;
}

export interface DeleteRule extends RuleBase {
  type: 'delete';
  mode: 'range' | 'between' | 'charset' | 'trim';
  from: number;
  fromEnd: boolean;
  count: number;
  left: string;
  right: string;
  includeLeft: boolean;
  includeRight: boolean;
  chars: string;
  keep: boolean;
}

export interface NumberRule extends RuleBase {
  type: 'number';
  expression: string;
  start: number;
  step: number;
  digits: number;
  padChar: string;
  /**
   * 计数分组：`none` 全局连续 / `parent` 每个目录 / `field:<字段>` 按元数据字段
   * （taken / camera / title / artist / album / track）。
   */
  groupBy: string;
  /** 排除列表：通配符（`*` `?`），换行或逗号分隔；命中的条目不参与本规则编号 */
  exclude: string;
  /** 按完整路径升序取号（关闭时按列表顺序） */
  byPath: boolean;
  /** 把序号写入指定元变量（`''` 不写；`USER0`–`USER9`） */
  writeVar: string;
  onlyChecked: boolean;
  /** 兼容旧方案：perFolder=true 等价 groupBy='parent' */
  perFolder?: boolean;
}

export interface MoveRule extends RuleBase {
  type: 'move';
  from: number;
  fromEnd: boolean;
  count: number;
  to: number;
  toEnd: boolean;
}

export interface CaseRule extends RuleBase {
  type: 'case';
  mode: 'upper' | 'lower' | 'title' | 'sentence' | 'invert' | 'random';
  separators: string;
}

export interface ExtRule extends RuleBase {
  type: 'ext';
  mode: 'add' | 'replace' | 'remove' | 'number' | 'case' | 'fixed';
  value: string;
  position: 'prefix' | 'suffix';
  caseMode: 'upper' | 'lower';
}

export type MetaFieldKey = 'taken' | 'camera' | 'title' | 'artist' | 'album' | 'track';

/** 供「按元数据取名」使用的只读字段（Rust `rename_fields` 返回，缺失为空串）。 */
export interface MetaFields {
  path: string;
  taken: string;
  camera: string;
  title: string;
  artist: string;
  album: string;
  track: string;
}

/** 可编辑元数据的字段 id（图片 / 音频 / 文档共用一套字符串键，按格式白名单过滤）。 */
export type MetaFieldId =
  | 'title'
  | 'description'
  | 'keywords'
  | 'author'
  | 'copyright'
  | 'software'
  | 'takenAt'
  | 'headline'
  | 'bylineTitle'
  | 'credit'
  | 'source'
  | 'model'
  | 'city'
  | 'location'
  | 'latitude'
  | 'longitude'
  | 'artist'
  | 'album'
  | 'year'
  | 'track'
  | 'genre'
  | 'comment'
  | 'albumArtist'
  | 'lyrics'
  | 'cover'
  | 'subject'
  | 'lastModifiedBy'
  | 'category';

export interface CoverInfoDto {
  present: boolean;
  mime: string;
  bytes: number;
  width: number;
  height: number;
}

/** 某文件的元数据快照（编辑对话框预填；只读）。 */
export interface MetaSnapshotDto {
  path: string;
  kind: 'image' | 'audio' | 'document' | string;
  format: string;
  writable: boolean;
  supportedFields: string[];
  fields: Record<string, string>;
  cover: CoverInfoDto | null;
  warnings: string[];
  unsupportedReason: string | null;
}

/** 格式支持矩阵中的一行（含明确不支持的格式）。 */
export interface MetaCapabilityDto {
  kind: string;
  format: string;
  read: boolean;
  write: boolean;
  fields: string[];
  notes: string;
}

export interface MetaEditRequestDto {
  path: string;
  fields: Record<string, string>;
  coverPath?: string | null;
  clearCover?: boolean;
  backup?: boolean;
}

/** 逐文件写入结果：ok=false 时 error 必定说明具体文件与原因。 */
export interface MetaEditResultDto {
  path: string;
  kind: string;
  format: string;
  supported: boolean;
  ok: boolean;
  backup: string | null;
  written: string[];
  cleared: string[];
  ignored: string[];
  verified: boolean;
  error: string | null;
  warnings: string[];
  elapsedMs: number;
}

/** 内容完全相同的文件组（不同路径）。 */
export interface DuplicateGroupDto {
  size: number;
  hash: string;
  paths: string[];
}

/** 右侧检查器：属性 / 元数据 / 时间 / 归类 / EXIF / 编码共用一块面板，内容跟随列表勾选。 */
export type InspectorMode = 'attrs' | 'meta' | 'time' | 'organize' | 'exif' | 'encoding';

/** EXIF 清除前预览：按文件实际存在的条目。 */
export interface ExifGroupDto {
  id: string;
  label: string;
  items: string[];
}

export interface ExifInventoryDto {
  path: string;
  format: string;
  groups: ExifGroupDto[];
  orientation: number;
  orientationKept: boolean;
  hasIcc: boolean;
  hasExif: boolean;
  hasXmp: boolean;
  hasThumbnail: boolean;
  warnings: string[];
}

export interface ExifClearScopesDto {
  gps: boolean;
  camera: boolean;
  time: boolean;
  thumbnail: boolean;
  all: boolean;
}

export interface ExifClearRequestDto {
  path: string;
  scopes: ExifClearScopesDto;
  clearXmp?: boolean;
  backup?: boolean;
}

export interface ExifClearResultDto {
  path: string;
  format: string;
  ok: boolean;
  supported: boolean;
  backup: string | null;
  cleared: string[];
  orientationBefore: number;
  orientationAfter: number;
  iccBefore: boolean;
  iccAfter: boolean;
  xmpCleared: boolean;
  pixelsUnchanged: boolean | null;
  verified: boolean;
  warnings: string[];
  error: string | null;
  elapsedMs: number;
}

/** 文本编码转换支持的编码 id。 */
export type TextEncodingId = 'utf8' | 'utf8bom' | 'gb18030' | 'utf16le' | 'utf16be' | 'auto' | 'unknown';

export interface TextDetectDto {
  path: string;
  encoding: string;
  encodingLabel: string;
  confirmed: boolean;
  bytes: number;
  chars: number;
  lines: number;
  preview: string;
  warnings: string[];
}

export interface TextSaveRequestDto {
  path: string;
  targetEncoding: string;
  sourceEncoding?: string | null;
  saveAs?: string | null;
  backup: boolean;
}

export interface TextSaveResultDto {
  path: string;
  outputPath: string;
  sourceEncoding: string;
  sourceEncodingLabel: string;
  targetEncoding: string;
  targetEncodingLabel: string;
  backup: string | null;
  bytesBefore: number;
  bytesAfter: number;
  chars: number;
  verified: boolean;
  ok: boolean;
  error: string | null;
}

export interface DuplicateReportDto {
  groups: DuplicateGroupDto[];
  scanned: number;
  warnings: string[];
}

/** 文件列表顺序（随工作区持久化，重启后保留）。 */
export interface SessionEntryDto {
  path: string;
  name: string;
  parent: string;
  isDir: boolean;
  size: number;
  modified: number;
  readonly: boolean;
  selected: boolean;
}

export interface SessionDto {
  version: number;
  /** 是否经过用户手动拖动排序（用于界面提示「手动顺序」） */
  manualOrder?: boolean;
  entries: SessionEntryDto[];
}

export interface MetaRule extends RuleBase {
  type: 'meta';
  field: MetaFieldKey;
  mode: 'prefix' | 'suffix' | 'replace';
  separator: string;
}

export type Rule =
  | AddRule | ReplaceRule | DeleteRule | NumberRule | MoveRule | CaseRule | ExtRule | MetaRule;

export type RowStatus = 'ready' | 'unchanged' | 'conflict' | 'warn' | 'invalid' | 'off';

export interface PreviewRow {
  entry: Entry;
  newName: string;
  stem: string;
  ext: string;
  status: RowStatus;
  reasons: string[];
  /** 目标完整路径超过平台提示阈值（预览中标红，但仍可在 Windows 长路径前缀下执行） */
  pathTooLong?: boolean;
  diff: DiffSegments;
}

export interface DiffSegments {
  prefix: string;
  added: string;
  removed: string;
  suffix: string;
}

export interface ScanEntryDto {
  id: string;
  path: string;
  name: string;
  parent: string;
  isDir: boolean;
  size: number;
  modified: number;
  readonly: boolean;
}

export interface ScanResultDto {
  entries: ScanEntryDto[];
  warnings: string[];
  truncated: boolean;
  visitedDirs: number;
}

/** 批次执行进度事件（Rust `apply-progress`）。 */
export interface ApplyProgress {
  phase: 'prepare' | 'stage' | 'apply' | 'done' | 'cancelled' | string;
  done: number;
  total: number;
  current: string;
}

export interface StartupMark {
  name: string;
  /** performance.timeOrigin + performance.now()，epoch 毫秒 */
  at: number;
  /** 页面内 performance.now() */
  ms: number;
}

export interface AppliedChange {
  id: string;
  from: string;
  to: string;
  backup?: string;
}

export interface SkippedChange {
  id: string;
  source: string;
  reason: string;
  /** 失败/跳过分类（desktop 由 Rust 补齐；演示模式为 mock 提供） */
  code?: FailureCode;
}

export interface BatchCounts {
  total: number;
  done: number;
  skipped: number;
  failed: number;
}

export interface BatchItem {
  id: string;
  from: string;
  to: string;
  temp: string;
  isDir: boolean;
  state: 'planned' | 'staged' | 'done' | 'skipped' | 'failed';
  reason?: string;
  backup?: string;
}

export interface Batch {
  id: string;
  createdAt: number;
  finishedAt?: number;
  state: 'pending' | 'completed' | 'partial' | 'cancelled' | 'undone' | 'undo-partial';
  /** rename / time / attrs / move；旧批次缺省视为 rename */
  kind?: 'rename' | 'time' | 'attrs' | 'move' | string;
  policy: ConflictPolicy;
  roots: string[];
  counts: BatchCounts;
  items: BatchItem[];
  /** 非改名操作记录 */
  ops?: BatchOp[];
  /** 本次执行新建的目录 */
  createdDirs?: string[];
}

export interface BatchOp {
  id: string;
  kind: 'time' | 'attrs' | 'move' | string;
  path: string;
  target?: string;
  before: string;
  after: string;
  state: 'planned' | 'done' | 'skipped' | 'failed';
  reason?: string;
}

export interface BatchSummary {
  id: string;
  createdAt: number;
  finishedAt?: number;
  state: Batch['state'];
  kind?: Batch['kind'];
  policy: ConflictPolicy;
  roots: string[];
  counts: BatchCounts;
  /** 核心按真实磁盘校验后的可撤销状态 */
  undoable?: boolean;
  /** 不可撤销的原因（可撤销时不返回） */
  undoReason?: string | null;
}

/** 时间 / 属性 / 移动批次的执行结果。 */
export interface OpsChange {
  id: string;
  path: string;
  target?: string;
  before: string;
  after: string;
}

export interface OpsOutcome {
  batch: Batch;
  applied: OpsChange[];
  skipped: SkippedChange[];
  failed: SkippedChange[];
}

export interface TimeInfo {
  path: string;
  name: string;
  atimeMs?: number | null;
  mtimeMs?: number | null;
  creationMs?: number | null;
  creationWritable: boolean;
  error?: string | null;
}

export interface AttrInfo {
  path: string;
  name: string;
  readonly: boolean;
  hidden: boolean;
  hiddenSupported: boolean;
  error?: string | null;
}

export interface OpTargetDto {
  id: string;
  path: string;
  isDir: boolean;
}

export type TimeField = 'mtime' | 'atime' | 'creation';

export interface TimeSpecDto {
  mode: 'shift' | 'fixed' | 'random';
  shiftSeconds: number;
  fixedMs: number;
  randomMinMs: number;
  randomMaxMs: number;
  randomSeed: string;
  /** 同时把图片 EXIF 拍摄时间写成新的修改时间 */
  writeExif: boolean;
  fields: TimeField[];
}

/** 单个属性的处理方式；null 表示保持原状。 */
export type AttrAction = 'set' | 'clear' | 'invert';

export interface AttrSpecDto {
  readonly?: AttrAction | null;
  hidden?: AttrAction | null;
}

export interface MoveItemDto {
  id: string;
  source: string;
  target: string;
  isDir: boolean;
}

export interface MoveSpecDto {
  createDirs: boolean;
  roots: string[];
  forceCopy?: boolean;
}

export interface ApplyOutcome {
  batch: Batch;
  applied: AppliedChange[];
  skipped: SkippedChange[];
  failed: SkippedChange[];
}

export interface SkippedField {
  /** creation / mtime / atime */
  field: string;
  path: string;
  reason: string;
}

export interface UndoOutcome {
  batch: Batch;
  restored: AppliedChange[];
  failed: SkippedChange[];
  /** 平台能力缺失而主动跳过的字段（不计入 failed），例如 Linux 上的创建时间 */
  skippedFields: SkippedField[];
}

/** 快照条目：from 为原名（还原目标），to 为快照时的计划新名（还原起点）。 */
export interface SnapshotEntryDto {
  from: string;
  to: string;
  size: number;
  mtimeMs: number;
  isDir: boolean;
  sha256?: string | null;
}

export interface SnapshotDto {
  schema: string;
  id: string;
  createdAt: number;
  roots: string[];
  entryCount: number;
  hashed: number;
  skipped: number;
  entries: SnapshotEntryDto[];
}

export interface SnapshotSummaryDto {
  id: string;
  createdAt: number;
  entryCount: number;
  hashed: number;
  skipped: number;
  roots: string[];
}

/** 还原预览行；action=skip 时 reasonCode 供界面本地化。 */
export interface SnapshotPlanItemDto {
  id: string;
  from: string;
  to: string;
  isDir: boolean;
  action: 'restore' | 'skip';
  reasonCode?: string | null;
  reason?: string | null;
  hashCheck: boolean;
}

export interface SnapshotRestoreResult {
  batch?: Batch | null;
  restored: AppliedChange[];
  skipped: SkippedChange[];
  failed: SkippedChange[];
  hashChecked: number;
}

export interface SnapshotProgress {
  phase: string;
  done: number;
  total: number;
  current: string;
}

export interface ApplyItemDto {
  id: string;
  source: string;
  targetName: string;
  isDir: boolean;
}

export interface ApplyOptionsDto {
  policy: ConflictPolicy;
  skipReadonly: boolean;
  windowsSafe: boolean;
  roots: string[];
}

export interface MetadataField {
  label: string;
  value: string;
}

export interface MetadataInfo {
  kind: 'image' | 'audio' | 'document' | 'text' | 'other';
  format: string;
  readOnly: boolean;
  fields: MetadataField[];
  warnings: string[];
}

/** 批量元数据读取结果：单条失败只影响该条。 */
export interface BatchMetadata {
  path: string;
  info?: MetadataInfo | null;
  error?: string | null;
}

/** 九类列表页签。 */
export type ListTab = 'rename' | 'attrs' | 'music' | 'photo' | 'image' | 'office' | 'pdf' | 'text' | 'organize';

/** 方案文件（规则链快照）的磁盘格式。 */
export interface PlanFile {
  schema: string;
  version: number;
  name: string;
  createdAt: number;
  appVersion: string;
  rules: Rule[];
  checksum: string;
}

/** 更新清单摘要（来自滚动 release 的 latest.json）。 */
export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  version: string;
  notes: string;
  pubDate: string;
  source: string;
  installable: boolean;
  assetName: string;
  /** 安装包字节数（清单未提供时为 null） */
  assetSize?: number | null;
}

export type UpdatePhase = 'checking' | 'download' | 'verify' | 'verified' | 'ready' | 'installing' | 'restarting';

/** 更新进度事件（Rust `update-progress`）。 */
export interface UpdateProgress {
  phase: UpdatePhase;
  received: number;
  total: number;
  percent: number;
  source: string;
  attempt: number;
  message: string;
}

/** 「仅下载」结果：落盘路径与版本。 */
export interface SavedUpdate {
  path: string;
  version: string;
  source: string;
  size: number;
}
