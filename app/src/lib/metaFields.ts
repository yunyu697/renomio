/**
 * 「按元数据取名」与「编号分组」共用同一张只读字段表。
 * 与 Rust 侧 `renomio_core::metadata::rename_field_values` 的字段一一对应：
 * 加字段必须同时改 types.ts 的 `MetaFieldKey`、`MetaFields`、五份语种的 `o.meta<Key>` 文案，
 * 以及 `scripts/test-meta-fields.mjs` 的期望列表（那条自测就是防漏的闸门）。
 */
import type { MetaFieldKey } from './types';

/** 按类别分组，界面下拉里用分组标题区分拍摄参数 / 音频标签 / 字体信息 / 可执行文件 / IPTC。 */
export const META_FIELD_GROUPS: Array<{ titleKey: string; fields: MetaFieldKey[] }> = [
  { titleKey: 'metaGroup.shooting', fields: ['taken', 'camera', 'iso', 'aperture', 'shutter', 'focal', 'lens'] },
  { titleKey: 'metaGroup.pixels', fields: ['width', 'height', 'resolution'] },
  { titleKey: 'metaGroup.audio', fields: ['title', 'artist', 'album', 'track', 'year', 'genre', 'composer'] },
  { titleKey: 'metaGroup.font', fields: ['fontFamily', 'fontStyle', 'fontVersion'] },
  { titleKey: 'metaGroup.pe', fields: ['fileVersion'] },
  { titleKey: 'metaGroup.iptc', fields: ['keywords', 'caption', 'copyright', 'location'] },
];

/** 扁平顺序（校验白名单用）：与分组顺序一致，保证 `field:` 枚举顺序稳定。 */
export const META_FIELDS: MetaFieldKey[] = META_FIELD_GROUPS.flatMap((g) => g.fields);

/** 字段 → 语种键：`iso` → `o.metaIso`、`taken` → `o.metaTaken`。 */
export function metaFieldLabelKey(field: MetaFieldKey): string {
  return `o.meta${field[0].toUpperCase()}${field.slice(1)}`;
}
