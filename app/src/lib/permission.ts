/** 权限/失败原因的用户文案：每种原因说清「为什么失败 + 可以怎么办」。 */
import { t } from '../i18n';
import type { FailureCode, SkippedChange } from './types';

export interface FailureExplanation {
  code: FailureCode;
  title: string;
  detail: string;
  /** 「以管理员身份重启」是否可能解决这一条 */
  adminCanHelp: boolean;
}

const ADMIN_HELP: Record<FailureCode, boolean> = {
  'access-denied': true,
  'in-use': false,
  readonly: false,
  'not-found': false,
  conflict: false,
  'path-too-long': false,
  'invalid-name': false,
  'io-error': false,
};

const CODES: FailureCode[] = [
  'access-denied', 'in-use', 'readonly', 'not-found', 'conflict', 'path-too-long', 'invalid-name', 'io-error',
];

export function explainFailure(code: string | undefined, reason: string): FailureExplanation {
  const key = (code && code in ADMIN_HELP ? code : 'io-error') as FailureCode;
  const detailKey = {
    'access-denied': 'permission.accessDeniedDetail',
    'in-use': 'permission.inUseDetail',
    readonly: 'permission.readonlyDetail',
    'not-found': 'permission.notFoundDetail',
    conflict: 'permission.conflictDetail',
    'path-too-long': 'permission.pathTooLongDetail',
    'invalid-name': 'permission.invalidNameDetail',
    'io-error': 'permission.ioErrorDetail',
  }[key];
  const titleKey = {
    'access-denied': 'permission.accessDenied',
    'in-use': 'permission.inUse',
    readonly: 'permission.readonly',
    'not-found': 'permission.notFound',
    conflict: 'permission.conflict',
    'path-too-long': 'permission.pathTooLong',
    'invalid-name': 'permission.invalidName',
    'io-error': 'permission.ioError',
  }[key];
  const detail = t(detailKey);
  return {
    code: key,
    title: t(titleKey),
    detail: key === 'io-error' && reason ? `${detail}${t('permission.raw', { reason })}` : detail,
    adminCanHelp: ADMIN_HELP[key],
  };
}

/** 需要用户/权限介入的失败（用于汇总横幅与「以管理员重启」按钮）。 */
export function isPermissionRelated(code: string | undefined): boolean {
  return code === 'access-denied' || code === 'in-use' || code === 'readonly' || code === 'not-found';
}

/** 该批次里是否有「管理员可能解决」的失败。 */
export function hasAdminFixable(items: SkippedChange[]): boolean {
  return items.some((item) => explainFailure(item.code, item.reason).adminCanHelp);
}

/** 安装目录是否位于 Program Files（普通权限无法写入）。 */
export function isInProgramFiles(dir: string): boolean {
  return /program files/i.test(dir);
}

/** 按代码统计失败条目，保持稳定顺序。 */
export function summarizeFailures(items: SkippedChange[]): Array<{ code: FailureCode; title: string; count: number }> {
  const counts = new Map<FailureCode, number>();
  for (const item of items) {
    const code = explainFailure(item.code, item.reason).code;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return CODES
    .filter((code) => counts.has(code))
    .map((code) => ({ code, title: explainFailure(code, '').title, count: counts.get(code) ?? 0 }));
}
