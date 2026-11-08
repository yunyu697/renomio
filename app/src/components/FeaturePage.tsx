import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { useTranslation } from '../i18n';
import { Icon, type IconName } from './Icon';
import type { Entry, PageId } from '../lib/types';

export type PageKind = 'music' | 'image' | 'office' | 'text' | 'any';

const KIND_EXTS: Record<Exclude<PageKind, 'any'>, string[]> = {
  music: ['mp3', 'flac', 'm4a', 'mp4', 'ogg', 'opus', 'wav', 'aac', 'wma'],
  image: ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'gif', 'bmp', 'heic', 'avif'],
  office: ['docx', 'xlsx', 'pptx', 'pdf', 'doc', 'xls', 'ppt'],
  text: [
    'txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'log', 'xml', 'yml', 'yaml',
    'ini', 'conf', 'cfg', 'toml', 'properties', 'html', 'htm', 'css', 'js', 'mjs', 'ts',
    'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'cs', 'sql', 'bat', 'cmd',
    'ps1', 'sh', 'srt', 'ass', 'vtt', 'tex', 'env', 'gitignore',
  ],
};

function extOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function accept(kind: PageKind, entry: Entry): boolean {
  if (entry.isDir) return false;
  if (kind === 'any') return true;
  return KIND_EXTS[kind].includes(extOf(entry.path));
}

/** 供检查器判断勾选文件是否属于图片 / 文本等能力范围。 */
export function matchesKind(kind: PageKind, entry: Entry): boolean {
  return accept(kind, entry);
}

/**
 * 功能页自带的选择区：默认沿用列表勾选；列表没勾选时默认全选可用文件。
 * 空态分两级：完全没有文件 → 引导选择文件/文件夹；有文件但没有适用类型 → 提示并允许继续选择。
 */
export function usePageTargets(kind: PageKind) {
  const { t } = useTranslation();
  const entries = useApp((s) => s.entries);
  const chooseFiles = useApp((s) => s.chooseFiles);
  const chooseFolder = useApp((s) => s.chooseFolder);

  const files = useMemo(() => entries.filter((e) => accept(kind, e)), [entries, kind]);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [defaulted, setDefaulted] = useState(false);

  useEffect(() => {
    setChosen(null);
  }, [files.length]);

  const effective = useMemo(() => {
    if (chosen) return files.filter((f) => chosen.includes(f.path));
    const picked = files.filter((f) => f.selected);
    return picked.length ? picked : files;
  }, [chosen, files]);

  useEffect(() => {
    setDefaulted(!chosen && files.some((f) => f.selected) === false && files.length > 0);
  }, [chosen, files]);

  const toggle = (path: string, on: boolean) => {
    const current = effective.map((f) => f.path);
    const next = on ? [...current, path] : current.filter((p) => p !== path);
    setChosen(files.filter((f) => next.includes(f.path)).map((f) => f.path));
  };

  const panel = (
    <div className="page-select" data-testid="page-select">
      <div className="page-select-head">
        <strong>{t('page.select')}</strong>
        <span className="page-select-count" data-testid="page-select-count">
          {t('page.selectedCount', { count: effective.length, total: files.length })}
        </span>
        <div className="right">
          <button
            className="mini"
            type="button"
            data-testid="page-select-all"
            onClick={() => setChosen(files.map((f) => f.path))}
            disabled={!files.length}
          >
            {t('page.selectAll')}
          </button>
          <button
            className="mini"
            type="button"
            data-testid="page-select-none"
            onClick={() => setChosen([])}
            disabled={!effective.length}
          >
            {t('page.selectNone')}
          </button>
        </div>
      </div>
      {defaulted && effective.length > 0 && (
        <div className="page-select-note" data-testid="page-select-default">
          {t('page.defaultChecked', { count: effective.length })}
        </div>
      )}
      {files.length > 0 ? (
        <div className="page-file-list">
          {files.map((file, index) => {
            const on = effective.some((f) => f.path === file.path);
            return (
              <label
                className={`page-file${on ? ' on' : ''}`}
                key={file.path}
                data-testid={`page-file-${index}`}
                title={file.path}
              >
                <input type="checkbox" checked={on} onChange={(e) => toggle(file.path, e.target.checked)} />
                <span className="page-file-name">{file.name}</span>
                <span className="page-file-ext">{extOf(file.path) || '—'}</span>
                <span className="page-file-dir">{file.parent}</span>
              </label>
            );
          })}
        </div>
      ) : (
        <div className="page-empty" data-testid="page-empty">
          <Icon name="info" size={22} />
          <p>{entries.length ? t('page.noMatch', { kind: t(`page.kind.${kind}`) }) : t('page.noFiles')}</p>
          <div className="page-empty-actions">
            <button className="btn btn-primary" type="button" data-testid="page-empty-files" onClick={() => void chooseFiles()}>
              <Icon name="file" size={13} />{t('page.chooseFiles')}
            </button>
            <button className="btn btn-ghost" type="button" data-testid="page-empty-folder" onClick={() => void chooseFolder()}>
              <Icon name="folder" size={13} />{t('page.chooseFolder')}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return { files, targets: effective, panel };
}

interface PageShellProps {
  page: PageId;
  icon: IconName;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  extra?: React.ReactNode;
}

/** 功能页外壳：返回按钮 + 标题 + 说明；内容由各页面自带选择区与空态。 */
export function PageShell({ page, icon, title, subtitle, children, extra }: PageShellProps) {
  const { t } = useTranslation();
  const closePage = useApp((s) => s.closePage);
  return (
    <section className="feature-page" data-testid={`page-${page}`}>
      <header className="page-head">
        <button className="page-back" type="button" data-testid="page-back" onClick={closePage}>
          <Icon name="chevron-right" size={14} />{t('page.back')}
        </button>
        <div className="page-title">
          <Icon name={icon} size={18} />
          <div>
            <h2>
              {title}
              <span className="p1-tag page-legacy" data-testid="page-legacy-badge" title={t('page.legacyHint')}>
                {t('page.legacy')}
              </span>
            </h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
        </div>
        {extra && <div className="page-head-extra">{extra}</div>}
      </header>
      <div className="page-content">{children}</div>
    </section>
  );
}
