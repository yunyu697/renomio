/**
 * 「按元数据取名」字段自测：字段表 / 规则求值 / 编号分组 / 缺失回退 / 文件名安全化。
 * 纯逻辑，不依赖窗口；用 esbuild 就地打包 src/lib/rules.ts（会连带 metaFields.ts）。
 * 这道闸门防的是「Rust 侧解析了新字段，前端枚举没跟上」这类只在真机才暴露漏字段问题。
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const outfile = path.join(appRoot, 'node_modules', '.cache', 'meta-fields-test.mjs');
const listFile = path.join(appRoot, 'node_modules', '.cache', 'meta-fields-list.mjs');
buildSync({
  entryPoints: [path.join(appRoot, 'src', 'lib', 'rules.ts')],
  bundle: true,
  format: 'esm',
  outfile,
  logLevel: 'silent',
});
buildSync({
  entryPoints: [path.join(appRoot, 'src', 'lib', 'metaFields.ts')],
  bundle: true,
  format: 'esm',
  outfile: listFile,
  logLevel: 'silent',
});

const { applyRules, normalizeRule, numberGroupKey } = await import(pathToFileURL(outfile).href);
const { META_FIELDS, META_FIELD_GROUPS, metaFieldLabelKey } = await import(pathToFileURL(listFile).href);

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

/** 与 Rust `RenameFieldValues` 应当一一对应的 17 个字段（顺序即界面顺序）。 */
const EXPECTED = [
  'taken', 'camera', 'iso', 'aperture', 'shutter', 'focal', 'lens',
  'width', 'height', 'resolution',
  'title', 'artist', 'album', 'track', 'year', 'genre', 'composer',
];

// 1. 字段表本身
check('字段数量 17', META_FIELDS.length === 17, String(META_FIELDS.length));
check('字段顺序与 Rust 侧一致', EXPECTED.every((k, i) => META_FIELDS[i] === k), META_FIELDS.join(','));
check('无重复字段', new Set(META_FIELDS).size === META_FIELDS.length);
check(
  '分组覆盖全部字段',
  META_FIELD_GROUPS.flatMap((g) => g.fields).length === META_FIELDS.length,
);
check('标签键命名 iso → o.metaIso', metaFieldLabelKey('iso') === 'o.metaIso');
check('标签键命名 taken → o.metaTaken', metaFieldLabelKey('taken') === 'o.metaTaken');

// 2. 五语种文案齐全 + 键集合一致（缺一条就是空标签）
const locales = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'es-ES'];
for (const lang of locales) {
  const src = readFileSync(path.join(appRoot, 'src', 'locales', `${lang}.ts`), 'utf8');
  const missing = META_FIELDS.map(metaFieldLabelKey).filter((key) => !src.includes(`'${key}':`));
  const missingGroups = META_FIELD_GROUPS.map((g) => g.titleKey).filter((key) => !src.includes(`'${key}':`));
  check(`${lang} 的 17 个字段文案齐全`, missing.length === 0, missing.join(','));
  check(`${lang} 的分组标题齐全`, missingGroups.length === 0, missingGroups.join(','));
}

// 3. 规则求值：每个字段都能真的拼进新名
const meta = {
  path: 'D:/photos/a.jpg',
  taken: '2025-01-04 08-00-00',
  camera: 'RC-1',
  iso: '3200',
  aperture: '2.8',
  shutter: '1-250',
  focal: '50mm',
  lens: 'RF24-70mm F2.8',
  width: '6000',
  height: '4000',
  resolution: '6000x4000',
  title: '夜曲',
  artist: '周杰伦',
  album: '十一月的萧邦',
  track: '03',
  year: '2005',
  genre: 'Pop',
  composer: '林迈可',
};
const ctx = { vars: {}, nextNumber: () => 1, peekNumber: () => 1, meta };

const prefixRule = (field) => ({
  id: 'm1', type: 'meta', enabled: true, field, mode: 'prefix', separator: '_',
});

const expectPrefix = {
  taken: '2025-01-04 08-00-00_原名.jpg',
  camera: 'RC-1_原名.jpg',
  iso: '3200_原名.jpg',
  aperture: '2.8_原名.jpg',
  shutter: '1-250_原名.jpg',
  focal: '50mm_原名.jpg',
  lens: 'RF24-70mm F2.8_原名.jpg',
  width: '6000_原名.jpg',
  height: '4000_原名.jpg',
  resolution: '6000x4000_原名.jpg',
  title: '夜曲_原名.jpg',
  artist: '周杰伦_原名.jpg',
  album: '十一月的萧邦_原名.jpg',
  track: '03_原名.jpg',
  year: '2005_原名.jpg',
  genre: 'Pop_原名.jpg',
  composer: '林迈可_原名.jpg',
};
for (const field of META_FIELDS) {
  const out = applyRules({ stem: '原名', ext: 'jpg' }, false, [prefixRule(field)], '', ctx, true);
  check(`前缀取名取到 ${field}`, `${out.stem}.${out.ext}` === expectPrefix[field], `${out.stem}.${out.ext}`);
}

// 4. 三种用法：replace 整体换名、suffix 追加到末尾
const replaced = applyRules(
  { stem: '原名', ext: 'jpg' }, false,
  [{ ...prefixRule('iso'), mode: 'replace' }], '', ctx, true,
);
check('replace 用法：整名换成 ISO', replaced.stem === '3200' && replaced.ext === 'jpg', JSON.stringify(replaced));

const suffixed = applyRules(
  { stem: '原名', ext: 'jpg' }, false,
  [{ ...prefixRule('resolution'), mode: 'suffix' }], '', ctx, true,
);
check('suffix 用法：追加分辨率', suffixed.stem === '原名_6000x4000', JSON.stringify(suffixed));

// 5. 字段缺失必须“不改变名称”，而不是拼出空段或 undefined
for (const field of ['iso', 'lens', 'year', 'composer']) {
  const out = applyRules(
    { stem: '原名', ext: 'jpg' }, false, [prefixRule(field)], '',
    { vars: {}, nextNumber: () => 1, peekNumber: () => 1, meta: { path: 'x', [field]: '' } }, true,
  );
  check(`缺失字段 ${field} 不改变名称`, `${out.stem}.${out.ext}` === '原名.jpg', `${out.stem}.${out.ext}`);
}

// 6. 完全没有元数据上下文时不崩、不改名
const noMeta = applyRules(
  { stem: '原名', ext: 'jpg' }, false, [prefixRule('aperture')], '',
  { vars: {}, nextNumber: () => 1, peekNumber: () => 1 }, true,
);
check('无 meta 上下文不改变名称', `${noMeta.stem}.${noMeta.ext}` === '原名.jpg', `${noMeta.stem}.${noMeta.ext}`);

// 7. 编号分组：新增字段可以当分组键，未识别键回退 none
for (const field of ['iso', 'width', 'year', 'composer']) {
  const rule = normalizeRule({
    id: 'n1', type: 'number', enabled: true, expression: '<#>', start: 1, step: 1, digits: 2,
    padChar: '0', groupBy: `field:${field}`, exclude: '', byPath: false, writeVar: '', onlyChecked: false,
  });
  check(`groupBy field:${field} 被保留`, rule.groupBy === `field:${field}`, rule.groupBy);
  const key = numberGroupKey(rule, '', meta);
  check(`field:${field} 的分组键取到值`, key === `f:${meta[field]}` && key !== 'f:', key);
}
const bogus = normalizeRule({
  id: 'n2', type: 'number', enabled: true, expression: '<#>', start: 1, step: 1, digits: 2,
  padChar: '0', groupBy: 'field:bogus', exclude: '', byPath: false, writeVar: '', onlyChecked: false,
});
check('未知分组字段回退 none', bogus.groupBy === 'none', bogus.groupBy);

// 8. Rust 侧字段映射不能少项：源码里 17 个字段名都要出现在 rename_field_values 里
const coreSrc = readFileSync(
  path.join(appRoot, 'src-tauri', 'renomio-core', 'src', 'metadata.rs'),
  'utf8',
);
const structBody = coreSrc.slice(
  coreSrc.indexOf('pub struct RenameFieldValues'),
  coreSrc.indexOf('}', coreSrc.indexOf('pub struct RenameFieldValues')),
);
const structFields = [...structBody.matchAll(/pub (\w+): String/g)].map((m) => m[1]);
check(
  'Rust RenameFieldValues 与前端字段表一一对应',
  structFields.length === META_FIELDS.length && EXPECTED.every((k) => structFields.includes(k)),
  structFields.join(','),
);

console.log(`\n元数据字段自测：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
