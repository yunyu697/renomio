/** 多格式导出：TSV / 独立 HTML 表格 / 最小但合规的 xlsx（不引入第三方依赖）。 */
import { statusLabel } from './preview';
import type { PreviewRow } from './types';

type TFn = (key: string, vars?: Record<string, string | number>) => string;

function matrix(rows: PreviewRow[], t: TFn): string[][] {
  const header = [
    t('preview.exportHeaderSource'),
    t('preview.exportHeaderTarget'),
    t('preview.exportHeaderStatus'),
    t('preview.exportHeaderReason'),
  ];
  return [
    header,
    ...rows.map((row) => [row.entry.name, row.newName, statusLabel(row.status), row.reasons.join('; ')]),
  ];
}

/** 去掉 XML/TSV 里会让阅读器报错的不可见控制字符。 */
function clean(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeXml(value: string): string {
  return clean(value).replace(/[&<>"']/g, (ch) => ENTITIES[ch] ?? ch);
}

export function buildTsv(rows: PreviewRow[], t: TFn): string {
  const lines = matrix(rows, t).map((cells) => cells.map((c) => clean(c).replace(/[\t\r\n]/g, ' ')).join('\t'));
  // 带 BOM：Excel 直接双击打开 TSV 时能识别 UTF-8 中文
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

export function buildHtml(rows: PreviewRow[], t: TFn, exportedAt: Date = new Date()): string {
  const cells = matrix(rows, t);
  const [header, ...body] = cells;
  const esc = (value: string) => escapeXml(value);
  const head = header.map((h) => `<th>${esc(h)}</th>`).join('');
  const trs = body
    .map((cellsOfRow) => `<tr>${cellsOfRow.map((c, i) => `<td${i === 3 ? ' class="reason"' : ''}>${esc(c)}</td>`).join('')}</tr>`)
    .join('\n      ');
  const time = exportedAt.toLocaleString();
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Renomio">
<title>${esc(t('export.htmlTitle'))}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 32px; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; line-height: 1.5; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #666; font-size: 12px; margin-bottom: 18px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #d8d8d8; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; font-weight: 600; white-space: nowrap; }
  tr:nth-child(even) td { background: #fafafa; }
  td.reason { color: #8a4b00; }
  @media (prefers-color-scheme: dark) {
    body { background: #1b1b1f; color: #e6e6e6; }
    th { background: #26262b; }
    td, th { border-color: #3a3a40; }
    tr:nth-child(even) td { background: #202024; }
    .meta { color: #9a9aa2; }
    td.reason { color: #e0a458; }
  }
</style>
</head>
<body>
<h1>${esc(t('export.htmlTitle'))}</h1>
<p class="meta">${esc(t('export.summary', { count: rows.length, time }))}</p>
<table>
  <thead><tr>${head}</tr></thead>
  <tbody>
      ${trs}
  </tbody>
</table>
</body>
</html>
`;
}

// ---- xlsx：ZIP(store) + 最小 OOXML 包 ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 只做「存储」不压缩的 ZIP；xlsx 体积小，避免为了 deflate 引入依赖。 */
function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const header = new Uint8Array(30 + name.length);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, 0x04034b50, true);
    hv.setUint16(4, 20, true);
    hv.setUint16(6, 0x0800, true); // UTF-8 文件名
    hv.setUint16(8, 0, true); // 0 = store
    hv.setUint16(10, 0, true); // 1980-01-01 固定时间戳，保证导出可复现
    hv.setUint16(12, 33, true);
    hv.setUint32(14, crc, true);
    hv.setUint32(18, file.data.length, true);
    hv.setUint32(22, file.data.length, true);
    hv.setUint16(26, name.length, true);
    hv.setUint16(28, 0, true);
    header.set(name, 30);
    local.push(header, file.data);

    const entry = new Uint8Array(46 + name.length);
    const ev = new DataView(entry.buffer);
    ev.setUint32(0, 0x02014b50, true);
    ev.setUint16(4, 20, true);
    ev.setUint16(6, 20, true);
    ev.setUint16(8, 0x0800, true);
    ev.setUint16(10, 0, true);
    ev.setUint16(12, 0, true);
    ev.setUint16(14, 33, true);
    ev.setUint32(16, crc, true);
    ev.setUint32(20, file.data.length, true);
    ev.setUint32(24, file.data.length, true);
    ev.setUint16(28, name.length, true);
    ev.setUint32(42, offset, true);
    entry.set(name, 46);
    central.push(entry);
    offset += header.length + file.data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const dv = new DataView(end.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, files.length, true);
  dv.setUint16(10, files.length, true);
  dv.setUint32(12, centralSize, true);
  dv.setUint32(16, offset, true);

  const all = [...local, ...central, end];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of all) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function sheetXml(cells: string[][]): string {
  const rows = cells
    .map((cellsOfRow, rowIndex) => {
      const style = rowIndex === 0 ? ' s="1"' : '';
      const inner = cellsOfRow
        .map((cell) => `<c${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`)
        .join('');
      return `<row r="${rowIndex + 1}">${inner}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols><col min="1" max="1" width="34" customWidth="1"/><col min="2" max="2" width="34" customWidth="1"/><col min="3" max="3" width="14" customWidth="1"/><col min="4" max="4" width="56" customWidth="1"/></cols>
<sheetData>${rows}</sheetData>
</worksheet>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

export function buildXlsx(rows: PreviewRow[], t: TFn): Uint8Array {
  const encoder = new TextEncoder();
  const files = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: 'xl/styles.xml', data: STYLES_XML },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(matrix(rows, t)) },
  ].map((file) => ({ name: file.name, data: encoder.encode(file.data) }));
  return zipStore(files);
}

export function exportFileName(ext: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `rename-report-${stamp}.${ext}`;
}
