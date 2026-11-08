import type { Entry } from './types';

/** 检查器按文件类型判断某类能力是否适用（EXIF 只对图片、编码只对文本）。 */
export type FileKind = 'image' | 'text';

const KIND_EXTS: Record<FileKind, string[]> = {
  image: ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'gif', 'bmp', 'heic', 'avif'],
  text: [
    'txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'log', 'xml', 'yml', 'yaml',
    'ini', 'conf', 'cfg', 'toml', 'properties', 'html', 'htm', 'css', 'js', 'mjs', 'ts',
    'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'cs', 'sql', 'bat', 'cmd',
    'ps1', 'sh', 'srt', 'ass', 'vtt', 'tex', 'env', 'gitignore',
  ],
};

export function extOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function matchesKind(kind: FileKind, entry: Entry): boolean {
  if (entry.isDir) return false;
  return KIND_EXTS[kind].includes(extOf(entry.path));
}
