/** CSV 导出：当前列表的原名 / 新名 / 状态 / 错误原因。 */
import { statusLabel } from './preview';
import type { PreviewRow } from './types';

type TFn = (key: string, vars?: Record<string, string | number>) => string;

function cell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function buildCsv(rows: PreviewRow[], t: TFn): string {
  const lines = [
    [t('preview.exportHeaderSource'), t('preview.exportHeaderTarget'), t('preview.exportHeaderStatus'), t('preview.exportHeaderReason')]
      .map(cell)
      .join(','),
  ];
  for (const row of rows) {
    const reason = row.reasons.join('; ');
    lines.push(
      [cell(row.entry.name), cell(row.newName), cell(statusLabel(row.status)), cell(reason)].join(','),
    );
  }
  // 带 BOM，便于 Excel 正确识别 UTF-8
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

export function csvFileName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `rename-report-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.csv`;
}
