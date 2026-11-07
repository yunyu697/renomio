/** 九类列表页签：更名列表之外的只读视图（属性 / 音乐 / 照片 / 图像 / Office / PDF / 文本 / 归类）。
 *  所有视图只读，不写文件；无法读取的字段逐项显示「暂不支持」或错误原因，不做假入口。 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { readAttrs, readMetadataBatch, readTimes } from '../lib/bridge';
import { formatSize, formatTime } from '../lib/format';
import { defaultMoveRoot, buildMoveRows } from '../lib/moveRules';
import { fileKind } from '../lib/rules';
import { useTranslation } from '../i18n';
import type { AttrInfo, BatchMetadata, Entry, ListTab, MetadataInfo, TimeInfo } from '../lib/types';
import { useApp } from '../store';
import { Icon, type IconName } from './Icon';

export const LIST_TABS: Array<{ key: ListTab; labelKey: string }> = [
  { key: 'rename', labelKey: 'tab.rename' },
  { key: 'attrs', labelKey: 'tab.attrs' },
  { key: 'music', labelKey: 'tab.music' },
  { key: 'photo', labelKey: 'tab.photo' },
  { key: 'image', labelKey: 'tab.image' },
  { key: 'office', labelKey: 'tab.office' },
  { key: 'pdf', labelKey: 'tab.pdf' },
  { key: 'text', labelKey: 'tab.text' },
  { key: 'organize', labelKey: 'tab.organize' },
];

const TAB_FULL_KEY: Record<ListTab, string> = {
  rename: 'tabFull.rename',
  attrs: 'tabFull.attrs',
  music: 'tabFull.music',
  photo: 'tabFull.photo',
  image: 'tabFull.image',
  office: 'tabFull.office',
  pdf: 'tabFull.pdf',
  text: 'tabFull.text',
  organize: 'tabFull.organize',
};

const TAB_ACCEPT: Record<ListTab, (entry: Entry) => boolean> = {
  rename: () => true,
  attrs: () => true,
  music: (e) => fileKind(e.name, e.isDir) === 'music',
  photo: (e) => fileKind(e.name, e.isDir) === 'jpg',
  image: (e) => fileKind(e.name, e.isDir) === 'jpg',
  office: (e) => fileKind(e.name, e.isDir) === 'doc',
  pdf: (e) => fileKind(e.name, e.isDir) === 'pdf',
  text: (e) => fileKind(e.name, e.isDir) === 'txt',
  organize: () => true,
};

/** 列定义：key 用于 i18n（lc.*），field 为后端返回的中文字段名，仅用于匹配元数据值。 */
interface ColDef {
  key: string;
  field?: string;
}

const COLUMNS: Record<Exclude<ListTab, 'rename'>, ColDef[]> = {
  attrs: [
    { key: 'name' }, { key: 'type' }, { key: 'readonly' }, { key: 'hidden' },
    { key: 'creation' }, { key: 'modified' }, { key: 'atime' }, { key: 'size' }, { key: 'location' },
  ],
  music: [
    { key: 'name' }, { key: 'format' }, { key: 'title', field: '标题' }, { key: 'artist', field: '艺术家' },
    { key: 'album', field: '专辑' }, { key: 'year', field: '年份' }, { key: 'track', field: '音轨' },
    { key: 'genre', field: '流派' }, { key: 'sampleRate', field: '采样率' }, { key: 'duration', field: '时长' },
    { key: 'bitrate', field: '码率' },
  ],
  photo: [
    { key: 'name' }, { key: 'format' }, { key: 'dimensions', field: '尺寸' }, { key: 'taken', field: '拍摄时间' },
    { key: 'cameraMake', field: '相机品牌' }, { key: 'cameraModel', field: '相机型号' },
    { key: 'orientation', field: '方向' }, { key: 'iso', field: 'ISO' }, { key: 'shutter', field: '快门' },
    { key: 'aperture', field: '光圈' }, { key: 'focal', field: '焦距' }, { key: 'lens', field: '镜头' },
  ],
  image: [
    { key: 'name' }, { key: 'format' }, { key: 'dimensions', field: '尺寸' }, { key: 'title', field: '标题' },
    { key: 'author', field: '作者' }, { key: 'copyright', field: '版权' }, { key: 'software', field: '软件' },
    { key: 'comment', field: '备注' },
  ],
  office: [
    { key: 'name' }, { key: 'format' }, { key: 'title', field: '标题' }, { key: 'subject', field: '主题' },
    { key: 'author', field: '作者' }, { key: 'lastBy', field: '最后修改者' }, { key: 'revision', field: '修订号' },
    { key: 'creation', field: '创建时间' }, { key: 'modified', field: '修改时间' }, { key: 'pages', field: '页数' },
    { key: 'words', field: '字数' }, { key: 'generator', field: '生成应用' },
  ],
  pdf: [
    { key: 'name' }, { key: 'format' }, { key: 'title', field: '标题' }, { key: 'author', field: '作者' },
    { key: 'subject', field: '主题' }, { key: 'tool', field: '创建工具' }, { key: 'producer', field: '生成器' },
    { key: 'creation', field: '创建时间' }, { key: 'pagesApprox', field: '页数（粗略）' },
  ],
  text: [
    { key: 'name' }, { key: 'format' }, { key: 'encoding', field: '编码' }, { key: 'lines', field: '行数' },
    { key: 'chars', field: '字符数' }, { key: 'summary', field: '内容摘要' },
  ],
  organize: [
    { key: 'name' }, { key: 'currentLocation' }, { key: 'targetDir' }, { key: 'basis' }, { key: 'status' },
  ],
};

const META_TABS = new Set<ListTab>(['music', 'photo', 'image', 'office', 'pdf', 'text']);

const TAB_NOTE_KEY: Partial<Record<ListTab, string>> = {
  attrs: 'list.attrsNote',
  image: 'list.imageNote',
  office: 'list.officeNote',
  photo: 'list.photoNote',
  text: 'list.textNote',
  organize: 'list.organizeNote',
};

function metaKindIcon(tab: ListTab): IconName {
  if (tab === 'music') return 'music';
  if (tab === 'photo' || tab === 'image') return 'image';
  if (tab === 'pdf') return 'pdf';
  if (tab === 'text') return 'text';
  return 'doc';
}

function fieldOf(info: MetadataInfo | null, field: string): string {
  const hit = info?.fields.find((f) => f.label === field);
  return hit ? hit.value : '—';
}

function rowType(entry: Entry, t: (key: string) => string): string {
  if (entry.isDir) return t('type.folder');
  const kind = fileKind(entry.name, entry.isDir);
  const map: Record<string, string> = {
    jpg: 'type.image',
    music: 'type.audio',
    pdf: 'type.pdf',
    txt: 'type.text',
    video: 'type.video',
    doc: 'type.doc',
    file: 'type.file',
  };
  return t(map[kind] ?? 'type.file');
}

interface ViewRow {
  id: string;
  entry: Entry;
  icon: IconName;
  values: string[];
  note?: string;
}

export function tabAccepts(tab: ListTab, entry: Entry): boolean {
  return TAB_ACCEPT[tab](entry);
}

export function tabCount(tab: ListTab, entries: Entry[]): number {
  if (tab === 'rename' || tab === 'attrs' || tab === 'organize') return entries.length;
  return entries.filter((e) => TAB_ACCEPT[tab](e)).length;
}

export function ListTabs() {
  const { t } = useTranslation();
  const entries = useApp((s) => s.entries);
  const listTab = useApp((s) => s.listTab);
  const setListTab = useApp((s) => s.setListTab);

  return (
    <div className="list-tabs" role="tablist" data-testid="list-tabs">
      {LIST_TABS.map((tab) => (
        <div
          key={tab.key}
          className={`tab ${listTab === tab.key ? 'active' : 'dim'}`}
          role="tab"
          aria-selected={listTab === tab.key}
          data-testid={`list-tab-${tab.key}`}
          title={t(TAB_FULL_KEY[tab.key])}
          onClick={() => setListTab(tab.key)}
        >
          {t(tab.labelKey)}
          <span className="num" data-testid={`list-tab-count-${tab.key}`}>{tabCount(tab.key, entries)}</span>
        </div>
      ))}
    </div>
  );
}

export function ListView({ tab }: { tab: Exclude<ListTab, 'rename'> }) {
  const { t } = useTranslation();
  const entries = useApp((s) => s.entries);
  const env = useApp((s) => s.env);
  const diskExists = useApp((s) => s.diskExists);
  const isDemo = useApp((s) => s.isDemo);
  const openOps = useApp((s) => s.openOps);
  const openMetaEditor = useApp((s) => s.openMetaEditor);
  const [meta, setMeta] = useState<Record<string, BatchMetadata>>({});
  const [times, setTimes] = useState<Record<string, TimeInfo>>({});
  const [attrs, setAttrs] = useState<Record<string, AttrInfo>>({});
  const [loading, setLoading] = useState(false);
  const [loadedKey, setLoadedKey] = useState('');

  const files = useMemo(
    () => entries.filter((e) => !e.isDir && TAB_ACCEPT[tab](e)).slice(0, 500),
    [entries, tab],
  );
  const pathKey = files.map((f) => f.path).join('|');

  useEffect(() => {
    if (!files.length) {
      setLoading(false);
      return;
    }
    if (pathKey === loadedKey) return;
    let cancelled = false;
    setLoading(true);
    setLoadedKey(pathKey);
    const paths = files.map((f) => f.path);
    if (tab === 'attrs') {
      void Promise.all([readTimes(paths), readAttrs(paths)])
        .then(([timeList, attrList]) => {
          if (cancelled) return;
          setTimes(Object.fromEntries(timeList.map((t) => [t.path, t])));
          setAttrs(Object.fromEntries(attrList.map((a) => [a.path, a])));
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    } else if (META_TABS.has(tab)) {
      void readMetadataBatch(paths)
        .then((list) => {
          if (cancelled) return;
          setMeta(Object.fromEntries(list.map((m) => [m.path, m])));
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    } else {
      setLoading(false);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, pathKey]);

  const organizeRows = useMemo(() => {
    if (tab !== 'organize' || !files.length) return [];
    const all = files.map((e) => ({ ...e, selected: true }));
    const root = defaultMoveRoot(all, env);
    const rows = buildMoveRows(
      all,
      { kind: 'ext', root, keepStructure: false, dateGranularity: 'year', pattern: '', capture: 0 },
      env,
      diskExists,
    );
    return rows.map((row, index) => ({
      id: `${row.entry.id}-${index}`,
      entry: row.entry,
      subdir: row.subdir,
      target: row.target,
      status: row.status,
      reasons: row.reasons,
    }));
  }, [tab, files, env, diskExists]);

  const rows = useMemo<ViewRow[]>(() => {
    if (tab === 'organize') {
      return organizeRows.map((row) => ({
        id: row.id,
        entry: row.entry,
        icon: 'folder',
        values: [
          row.entry.name,
          row.entry.parent,
          row.target || '—',
          row.subdir ? t('list.organizeReason', { ext: row.subdir }) : '—',
          row.status === 'ready' ? t('list.moveReady') : row.status === 'unchanged' ? t('list.moveUnchanged') : row.status === 'conflict' ? t('list.moveConflict') : t('list.moveInvalid'),
        ],
        note: row.reasons[0],
      }));
    }
    if (tab === 'attrs') {
      return files.map((entry) => {
        const timeInfo = times[entry.path];
        const a = attrs[entry.path];
        return {
          id: entry.id,
          entry,
          icon: tabIconOf(entry),
          values: [
            entry.name,
            rowType(entry, t),
            a ? (a.readonly ? t('list.readonlyYes') : t('list.readonlyNo')) : '—',
            a ? (a.hiddenSupported ? (a.hidden ? t('list.hiddenYes') : t('list.hiddenNo')) : t('list.notSupported')) : '—',
            timeInfo?.creationMs ? formatTime(timeInfo.creationMs) : timeInfo?.creationWritable ? '—' : t('list.notSupported'),
            formatTime(entry.modified),
            timeInfo?.atimeMs ? formatTime(timeInfo.atimeMs) : '—',
            entry.isDir ? '—' : formatSize(entry.size),
            entry.parent,
          ],
          note: a?.error ?? timeInfo?.error ?? undefined,
        };
      });
    }
    return files.map((entry) => {
      const item = meta[entry.path];
      const info = item?.info ?? null;
      const defs = COLUMNS[tab];
      const values = defs.map((def) => {
        if (def.key === 'name') return entry.name;
        if (def.key === 'format') return info?.format ?? '—';
        return fieldOf(info, def.field ?? '');
      });
      return {
        id: entry.id,
        entry,
        icon: metaKindIcon(tab),
        values,
        note: item?.error ?? info?.warnings[0] ?? undefined,
      };
    });
  }, [tab, files, meta, times, attrs, organizeRows, t]);

  const headers = COLUMNS[tab];
  const cols = `${headers.length > 1 ? 'minmax(0, 1.4fr)' : '1fr'} ${headers.slice(1).map(() => 'minmax(0, 1fr)').join(' ')}`;
  const noteKey = TAB_NOTE_KEY[tab];
  // 元数据页签不只做展示：勾选的文件（未勾选时取当前页签全部）可直接进入编辑对话框。
  const metaTargets = META_TABS.has(tab)
    ? (files.filter((f) => f.selected).length ? files.filter((f) => f.selected) : files).map((f) => f.path)
    : [];

  return (
    <div className="list-view" data-testid={`list-view-${tab}`}>
      {(noteKey || META_TABS.has(tab)) && (
        <div className="list-note" data-testid={`list-note-${tab}`}>
          <Icon name="info" size={12} />{noteKey ? t(noteKey) : t('list.metaEditHint')}
          {META_TABS.has(tab) && (
            <button
              className="mini"
              type="button"
              data-testid={`list-action-edit-${tab}`}
              disabled={!metaTargets.length}
              onClick={() => openMetaEditor(metaTargets)}
            >
              {t('list.metaEdit', { count: metaTargets.length })}
            </button>
          )}
          {(tab === 'organize' || tab === 'attrs') && (
            <button
              className="mini"
              type="button"
              data-testid={`list-action-${tab}`}
              onClick={() => openOps(tab === 'organize' ? 'move' : 'attrs')}
            >
              {tab === 'organize' ? t('list.openOrganize') : t('list.openAttrs')}
            </button>
          )}
        </div>
      )}
      <div className="table" role="table" data-testid={`meta-table-${tab}`} style={{ ['--cols' as string]: cols } as CSSProperties}>
        <div className="thead" role="row">
          {headers.map((def, index) => (
            <div className="th" key={`${def.key}-${index}`} title={t(`lc.${def.key}`)}>{t(`lc.${def.key}`)}</div>
          ))}
        </div>
        {rows.map((row) => (
          <div
            className={`trow ${row.note ? 'warnrow' : ''}`}
            key={row.id}
            role="row"
            data-testid="meta-row"
            title={row.note ? `${row.entry.path}\n${row.note}` : row.entry.path}
            onDoubleClick={() => {
              if (isDemo) return;
              void import('../lib/bridge').then(({ revealPath }) => revealPath(row.entry.path).catch(() => undefined));
            }}
          >
            {row.values.map((value, index) => (
              <div className={`cell ${index === 0 ? '' : 'mono'}`} key={`${row.id}-${index}`}>
                {index === 0 ? (
                  <>
                    <span className={`file-ico ${fileKind(row.entry.name, row.entry.isDir)}`}>
                      <Icon name={row.icon} />
                    </span>
                    <span className="txt" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
                  </>
                ) : (
                  <span className="txt" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
                )}
              </div>
            ))}
          </div>
        ))}
        {!rows.length && (
          <div className="no-rows" data-testid="meta-empty">
            {loading ? t('list.reading') : tab === 'organize' ? t('list.noOrganize') : t('list.noType', { type: t(LIST_TABS.find((item) => item.key === tab)?.labelKey ?? 'tab.rename') })}
          </div>
        )}
        {loading && rows.length > 0 && <div className="no-rows">{t('list.reading')}</div>}
      </div>
    </div>
  );
}

function tabIconOf(entry: Entry): IconName {
  const kind = fileKind(entry.name, entry.isDir);
  const map: Record<string, IconName> = {
    folder: 'folder',
    jpg: 'image',
    pdf: 'pdf',
    txt: 'text',
    music: 'music',
    video: 'video',
    doc: 'doc',
    file: 'file',
  };
  return map[kind] ?? 'file';
}
