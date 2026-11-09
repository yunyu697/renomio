// 通过安装版的 Tauri IPC（与 UI 调用的同一批命令）修改真实文件的元数据/属性/时间/编码。
// 所有写操作都在本目录的真实文件上执行；读回由 real-chain.ps1 用外部工具完成。
import fs from 'node:fs';
import path from 'node:path';
import { connect } from './cdp.mjs';

const CORPUS = process.env.CHAIN_CORPUS;
const OUT = process.env.VERIFY_OUT || path.join(process.cwd(), 'verify-out', 'real-chain');
if (!CORPUS) throw new Error('缺少 CHAIN_CORPUS');

const cdp = await connect();
const invoke = (cmd, args) =>
  cdp.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then(v => ({ ok: true, v }), e => ({ ok: false, e: String(e) }))`);

const report = { corpus: CORPUS, results: [], failures: [] };
const record = (kind, entry, did, extra) => {
  const item = { kind, entry, did, ...extra };
  report.results.push(item);
  console.log(`STEP ${kind} entry=${entry} ${JSON.stringify(extra)}`);
};

try {
  const image = path.join(CORPUS, 'album-2024.jpg');
  const audio = path.join(CORPUS, 'track-01.mp3');
  const text = path.join(CORPUS, 'notes-gbk.txt');
  const readonlyDemo = path.join(CORPUS, 'readonly-demo.txt');

  // 1) 图片：XMP + EXIF 拍摄时间（真实 JPEG，含原有 EXIF/XMP/GPS/ICC）
  const imgRes = await invoke('meta_edit', {
    items: [{
      path: image,
      fields: {
        title: '外滩清晨 2024',
        description: 'Renomio alpha5 真实文件闭环',
        keywords: '外滩; 清晨; 验证',
        author: 'Tyler Zhang',
        copyright: '© 2024 Tyler Zhang',
        software: 'Renomio 1.1.0-alpha5',
        takenAt: '2024:07:08 06:12:33',
        headline: '外滩清晨',
        bylineTitle: '摄影师',
        credit: 'Renomio 验证',
        source: '自有素材',
        model: 'Fujifilm X-T5',
        city: '上海',
        location: '外滩',
        latitude: '31.2397',
        longitude: '121.4998',
      },
      backup: true,
    }],
  });
  if (!imgRes.ok || !imgRes.v?.[0]?.ok) report.failures.push('图片 meta_edit 失败: ' + JSON.stringify(imgRes));
  record('image', 'IPC meta_edit', '写 XMP 11 字段 + EXIF 拍摄时间/机型/地点/坐标，备份 .bak', { result: imgRes.v?.[0] });

  // 2) 音频：ID3 字段（真实 MP3，ID3v2.3）
  const audRes = await invoke('meta_edit', {
    items: [{
      path: audio,
      fields: {
        title: '上海现场 2025',
        artist: 'Renomio 现场',
        album: '现场录音 II',
        year: '2025',
        track: '2/2',
        genre: 'Live',
        comment: 'alpha5 真实文件闭环',
        albumArtist: 'Renomio',
      },
      backup: true,
    }],
  });
  if (!audRes.ok || !audRes.v?.[0]?.ok) report.failures.push('音频 meta_edit 失败: ' + JSON.stringify(audRes));
  record('audio', 'IPC meta_edit', '写 ID3 title/artist/album/year/track/genre/comment/albumArtist，备份 .bak', { result: audRes.v?.[0] });

  // 3) 属性：只读（外部 attrib 读回）
  const attrRes = await invoke('apply_attrs', {
    items: [{ id: 't1', path: readonlyDemo, isDir: false }],
    spec: { readonly: 'set' },
  });
  if (!attrRes.ok || attrRes.v?.failed?.length) report.failures.push('apply_attrs 失败: ' + JSON.stringify(attrRes));
  record('attrs', 'IPC apply_attrs', '给 readonly-demo.txt 设置只读属性', { result: attrRes.v });

  // 4) 文本：GBK -> UTF-8（外部按 UTF-8 读回）。先转码，最后再写时间，避免转码刷新 mtime。
  const det = await invoke('text_detect', { path: text });
  record('text-detect', 'IPC text_detect', '探测源编码', { result: det.v });
  const save = await invoke('text_save', {
    req: { path: text, targetEncoding: 'utf8', sourceEncoding: 'auto', backup: true },
  });
  if (!save.ok || !save.v?.ok) report.failures.push('text_save 失败: ' + JSON.stringify(save));
  record('text-save', 'IPC text_save', 'GB18030 -> UTF-8，原地覆盖 + .bak', { result: save.v });

  // 5) 时间：固定 mtime/atime/creation（外部 Get-Item 读回）
  const fixedMs = Date.UTC(2023, 2, 4, 5, 6, 7) - 8 * 3600 * 1000; // 本地 2023-03-04 05:06:07
  const timeRes = await invoke('apply_time', {
    items: [{ id: 't2', path: text, isDir: false }],
    spec: { mode: 'fixed', fixedMs, fields: ['mtime', 'atime', 'creation'] },
  });
  if (!timeRes.ok || timeRes.v?.failed?.length) report.failures.push('apply_time 失败: ' + JSON.stringify(timeRes));
  record('time', 'IPC apply_time', '固定 M/A/C 时间为本地 2023-03-04 05:06:07', { result: timeRes.v });

  fs.mkdirSync(OUT, { recursive: true });
  report.summary = report.failures.length ? 'FAIL' : 'ALL PASS';
  fs.writeFileSync(path.join(OUT, 'real-chain-ops.json'), JSON.stringify(report, null, 2));
  console.log('SUMMARY', report.summary, report.failures.join(' | '));
  if (report.failures.length) process.exitCode = 1;
} finally {
  cdp.close();
}
