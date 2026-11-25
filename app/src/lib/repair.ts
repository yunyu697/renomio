/**
 * 数据自检结果的整理层：只做「翻译键 + 排序 + 计数」，不碰文件系统。
 * 判定口径与 `renomio-core::repair` 的 `code` 一一对应，脚本按 code 断言。
 */
import type { RepairFindingDto, RepairReportDto } from './types';

/** 严重程度排序：错误在前，提示在后，便于用户先处理要紧的。 */
const RANK: Record<string, number> = { error: 0, warn: 1, info: 2 };

/** 每条发现都对应一条本地化标题，未知 code 回落到通用标签。 */
export function findingTitleKey(code: string): string {
  return `settings.repairCode.${code}`;
}

/** 修复动作的短标签键。 */
export function actionLabelKey(action: string): string {
  return `settings.repairAction.${action}`;
}

export function sortFindings(list: RepairFindingDto[]): RepairFindingDto[] {
  return [...list].sort((a, b) => {
    const d = (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3);
    if (d !== 0) return d;
    if (a.code !== b.code) return a.code.localeCompare(b.code);
    return a.path.localeCompare(b.path);
  });
}

export interface ReportCounts {
  errors: number;
  warnings: number;
  info: number;
  fixed: number;
  skipped: number;
}

export function countReport(report: RepairReportDto): ReportCounts {
  const counts: ReportCounts = {
    errors: 0,
    warnings: 0,
    info: 0,
    fixed: report.fixed.length,
    skipped: report.skipped.length,
  };
  for (const f of report.findings) {
    if (f.severity === 'error') counts.errors += 1;
    else if (f.severity === 'warn') counts.warnings += 1;
    else counts.info += 1;
  }
  // 修不掉的项（如「数据目录本身是个文件」）落在 skipped，同样算未解决
  return counts;
}

/** 是否值得给用户一个「没发现问题」的正向反馈。 */
export function isClean(report: RepairReportDto): boolean {
  return report.ok && report.findings.length === 0 && report.fixed.length === 0;
}

/** 报告里最严重的那一条，用来决定提示条颜色。 */
export function worstSeverity(report: RepairReportDto): 'error' | 'warn' | 'info' | 'ok' {
  if (report.findings.some((f) => f.severity === 'error')) return 'error';
  if (report.findings.some((f) => f.severity === 'warn')) return 'warn';
  if (report.findings.length > 0) return 'info';
  return 'ok';
}
