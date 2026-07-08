type CsvRow = Record<string, string | number | boolean | null | undefined> | (string | number)[];

function escapeCsv(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function exportToCsv(filename: string, rows: CsvRow[]) {
  if (rows.length === 0) return;
  let lines: string[] = [];
  const first = rows[0];
  if (Array.isArray(first)) {
    lines = (rows as (string | number)[][]).map((r) => r.map(escapeCsv).join(','));
  } else {
    const headers = Object.keys(first as Record<string, unknown>);
    lines.push(headers.map(escapeCsv).join(','));
    for (const r of rows as Record<string, unknown>[]) {
      lines.push(headers.map((h) => escapeCsv(r[h])).join(','));
    }
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
