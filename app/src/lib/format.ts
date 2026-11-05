export function formatSize(bytes: number, isDir = false): string {
  if (isDir) return '文件夹';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function baseName(path: string): string {
  const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

export function removeExt(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(0, idx) : name;
}

export function extName(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(idx + 1) : '';
}

export function parentPath(path: string): string {
  const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return idx > 0 ? path.slice(0, idx) : path;
}

export function plural(n: number, unit: string): string {
  return `${n} ${unit}`;
}
