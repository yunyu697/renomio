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
  selected: boolean;
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

export interface AppSettings {
  theme: 'light' | 'dark';
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
  columns: Record<ColumnKey, boolean>;
  columnWidths: Partial<Record<ColumnKey, number>>;
  /** 首次启动「已导入上一版本数据」提示已关闭（默认 false，只提示一次） */
  migrationNoticeDismissed: boolean;
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
  perFolder: boolean;
  onlyChecked: boolean;
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
  mode: 'shift' | 'fixed';
  shiftSeconds: number;
  fixedMs: number;
  fields: TimeField[];
}

export interface AttrSpecDto {
  readonly?: boolean | null;
  hidden?: boolean | null;
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
