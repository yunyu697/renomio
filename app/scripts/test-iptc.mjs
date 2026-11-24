/**
 * IPTC-IIM 守卫（域五 5.15）：
 *  A. 静态：四个字段的 IIM 标签映射、APP13/8BIM 常量、UTF-8 标记、读侧兜底接线、界面说明与五语种文案；
 *  B. 真实文件：用 renomio-core 的生产写路径改一张真 JPEG，再用 Pillow（独立实现）回读 IIM、EXIF 与像素。
 *
 * 真实段需要 python + Pillow + cargo；CI 里显式安装 Pillow 并以 --require-real 运行，
 * 缺依赖时不会被说成「通过」。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const coreRoot = path.join(appRoot, 'src-tauri', 'renomio-core');
const requireReal = process.argv.includes('--require-real');

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
const read = (rel) => readFileSync(path.join(appRoot, rel), 'utf8');

// ---------------- A. 静态 ----------------
const imageSrc = readFileSync(path.join(coreRoot, 'src', 'metaedit', 'image.rs'), 'utf8');
const modSrc = readFileSync(path.join(coreRoot, 'src', 'metaedit', 'mod.rs'), 'utf8');

check("APP13 载荷前缀是 'Photoshop 3.0\\0'", imageSrc.includes("b\"Photoshop 3.0\\0\""));
check('IIM 资源号 0x0404 与摘要资源 0x0406 都在代码里', imageSrc.includes('IRB_IIM: u16 = 0x0404') && imageSrc.includes('IRB_IPTC_DIGEST: u16 = 0x0406'));
check('IIM 数据集标记字节 0x1C', imageSrc.includes('IIM_MARKER_BYTE: u8 = 0x1C'));
check('UTF-8 声明用 ESC % G（dataset 1:90）', imageSrc.includes('IIM_UTF8_MARKER') && imageSrc.includes('(1, 90'));

const tags = [
  ['headline', 2, 105],
  ['bylineTitle', 2, 85],
  ['credit', 2, 110],
  ['source', 2, 115],
];
for (const [id, record, dataset] of tags) {
  check(`字段 ${id} 映射到 IIM ${record}:${dataset}（写入与读回同一张表）`,
    imageSrc.includes(`"${id}" => (${record}, ${dataset})`) && imageSrc.includes(`(${record}, ${dataset}) => "${id}"`));
}

check('清空字段时删除对应 dataset，而不是写成空串', imageSrc.includes('datasets.remove(index)'));
check('摘要资源 0x0406 在改动 IIM 后移除，避免过期 MD5', imageSrc.includes('resources.retain(|r| r.id != IRB_IPTC_DIGEST)'));
check('只在用户勾了 IPTC 字段时才重建 APP13（其它写法保持字节不变）', imageSrc.includes('let iim_wanted = fields.keys().any(|id| iim_tag(id).is_some())'));
check('非 Photoshop 的 APP13 原样保留（按前缀判断，不按 marker 一刀切）', imageSrc.includes('starts_with(PHOTOSHOP_IRB_PREFIX)'));
check('读侧兜底接在 read_into 与 read_fields 两处',
  (imageSrc.match(/read_iim\(&data, fields\)/g) ?? []).length >= 1
  && (imageSrc.match(/read_iim\(data, &mut fields\)/g) ?? []).length >= 1);
check('APP13 段长上限检查（避免写出 64 KB 以上的非法段）', imageSrc.includes('APP13 段 64 KB 上限'));
check('能力矩阵里 JPEG 一行写明 IPTC-IIM', modSrc.includes('IPTC-IIM'));

const dialogSrc = read('src/components/MetaEditDialog.tsx');
check('对话框在图像格式下显示 IPTC-IIM 说明（带 testid）',
  dialogSrc.includes('data-testid="meta-iptc-note"') && dialogSrc.includes("t('meta.iptcIimNote')"));
check('说明只在图像格式出现（不误导音频/文档）', dialogSrc.includes("s.kind === 'image'") && dialogSrc.includes("includes('headline')"));

for (const lang of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'es-ES']) {
  const src = read(`src/locales/${lang}.ts`);
  const keyed = src.includes("'meta.iptcIimNote':");
  const labels = tags.filter(([id]) => {
    const match = src.match(new RegExp(`'meta\\.field\\.${id}': '([^']*)'`));
    return match && match[1].includes('IPTC-IIM');
  }).length;
  check(`${lang}：说明键存在且 4 个字段标签都标注 IPTC-IIM`, keyed && labels === 4, `labels=${labels}`);
}

// 与 Rust 单测条数一致的守卫：六个 IIM 用例必须都在（防止有人删断言）
for (const name of [
  'iim_writes_four_fields_and_keeps_unknown_datasets',
  'iim_created_from_scratch_and_dropped_when_last_field_cleared',
  'iim_keeps_foreign_resources_and_foreign_app13',
  'iim_untouched_when_no_iptc_field_requested',
  'iim_read_falls_back_only_when_xmp_missing',
  'iim_extended_length_dataset_roundtrips',
]) {
  check(`Rust 单测在：${name}`, imageSrc.includes(`fn ${name}(`));
}

// ---------------- B. 真实文件 ----------------
const findPython = () => {
  for (const candidate of ['python', 'python3', 'py']) {
    const probe = spawnSync(candidate, ['-c', 'import sys;print(sys.version.split()[0])'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
};

const python = findPython();
const hasPillow = python
  ? spawnSync(python, ['-c', 'import PIL;print(PIL.__version__)'], { encoding: 'utf8' }).status === 0
  : false;
const hasCargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' }).status === 0;
const cargoLock = existsSync(path.join(coreRoot, 'Cargo.toml'));

if (!python || !hasPillow || !hasCargo || !cargoLock) {
  const missing = [!python && 'python', !hasPillow && 'Pillow', !hasCargo && 'cargo'].filter(Boolean).join(', ');
  if (requireReal) {
    check(`真实文件回读需要的依赖缺失：${missing}`, false);
  } else {
    console.log(`  SKIP  真实文件段（缺 ${missing}）`);
  }
} else {
  const work = mkdtempSync(path.join(os.tmpdir(), 'renomio-iptc-'));
  try {
    const probeArgv = ['cargo', 'run', '-q', '--manifest-path', path.join(coreRoot, 'Cargo.toml'), '--example', 'metaedit_probe', '--'];
    const res = spawnSync(python, [path.join(here, 'iptc_verify.py'), work], {
      encoding: 'utf8',
      env: { ...process.env, PROBE_ARGV: JSON.stringify(probeArgv) },
      maxBuffer: 32 * 1024 * 1024,
    });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
    if (output) console.log(output.split('\n').map((line) => `  | ${line}`).join('\n'));
    const summary = /IPTC-IIM 真实文件回读：(\d+) 通过 \/ (\d+) 失败/.exec(output);
    check('真实文件段执行成功并给出结果', res.status === 0 && summary, `exit=${res.status}`);
    if (summary) {
      pass += Number(summary[1]);
      fail += Number(summary[2]);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

console.log(`\nIPTC-IIM 守卫：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
