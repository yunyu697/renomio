/**
 * 生成应用图标源图（1024×1024 PNG），不依赖任何图像库。
 * 图案：蓝青渐变圆角方块 + 白色"文件 → 箭头"符号（自绘，不复用原版素材）。
 * 用法：node scripts/gen-icon.mjs [outPath]
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';

const SIZE = 1024;
const out = process.argv[2] ?? 'src-tauri/icons/source.png';

const pixels = Buffer.alloc(SIZE * SIZE * 4);

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

const radius = 200;
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const idx = (y * SIZE + x) * 4;
    // 圆角矩形遮罩（超采样 2×2 抗锯齿）
    let inside = 0;
    for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const px = x + ox;
      const py = y + oy;
      const cx = Math.min(Math.max(px, radius), SIZE - radius);
      const cy = Math.min(Math.max(py, radius), SIZE - radius);
      if ((px - cx) ** 2 + (py - cy) ** 2 <= radius * radius) inside += 1;
    }
    if (inside === 0) continue;
    const t = (x + y) / (SIZE * 2);
    const r = lerp(0x33, 0x00, t);
    const g = lerp(0x58, 0xa7, t);
    const b = lerp(0xf4, 0xb5, t);
    const alpha = (inside / 4) * 255;
    pixels[idx] = r;
    pixels[idx + 1] = g;
    pixels[idx + 2] = b;
    pixels[idx + 3] = alpha;
  }
}

function paint(x0, y0, x1, y1, color) {
  for (let y = Math.max(0, y0); y < Math.min(SIZE, y1); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(SIZE, x1); x += 1) {
      const idx = (y * SIZE + x) * 4;
      // 只在不透明区域上叠加
      if (pixels[idx + 3] < 128) continue;
      pixels[idx] = color[0];
      pixels[idx + 1] = color[1];
      pixels[idx + 2] = color[2];
      pixels[idx + 3] = 255;
    }
  }
}

const white = [255, 255, 255];

// 左侧文件轮廓（圆角描边用四条矩形近似）
const fx0 = 214, fx1 = 452, fy0 = 300, fy1 = 724, stroke = 30;
paint(fx0, fy0, fx1, fy0 + stroke, white);
paint(fx0, fy1 - stroke, fx1, fy1, white);
paint(fx0, fy0, fx0 + stroke, fy1, white);
paint(fx1 - stroke, fy0, fx1, fy1, white);
// 折角
paint(fx1 - 150, fy0, fx1, fy0 + 150, white);
paint(fx1 - 150, fy0, fx1 - 120, fy0 + 150, white);
paint(fx1 - 30, fy0 + 120, fx1, fy0 + 150, white);

// 右侧箭头：箭杆 + 三角
paint(400, 478, 700, 546, white);
for (let i = 0; i <= 150; i += 1) {
  const y0 = Math.max(0, 512 - i * 1.15);
  const y1 = Math.min(SIZE, 512 + i * 1.15);
  paint(690 + i, Math.round(y0), 691 + i, Math.round(y1), white);
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

writeFileSync(out, png);
console.log(`icon written: ${out} (${png.length} bytes)`);
