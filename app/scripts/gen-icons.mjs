/**
 * 由 src-tauri/icons/source-light.svg 生成整套应用图标。
 * Tauri 默认 ICO 缺 128px，且 16/24px 用细节过多的原图会糊成一团，
 * 这里用 source-light-small.svg 的光学小尺寸版本替换 16/24 并补上 128。
 * 用法：npm run icon:build
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const iconsDir = join(appDir, 'src-tauri', 'icons');
const tmpDir = join(appDir, '.icon-small');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function run(args) {
  const res = spawnSync('npx', args, { cwd: appDir, stdio: 'inherit', shell: true });
  if (res.status !== 0) throw new Error(`npx ${args.join(' ')} 失败`);
}

function readIco(file) {
  const buf = readFileSync(file);
  const count = buf.readUInt16LE(4);
  const images = new Map();
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    const width = buf.readUInt8(entry) || 256;
    const size = buf.readUInt32LE(entry + 8);
    const offset = buf.readUInt32LE(entry + 12);
    images.set(width, buf.subarray(offset, offset + size));
  }
  return images;
}

function writeIco(file, images) {
  const header = Buffer.alloc(6 + SIZES.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(SIZES.length, 4);
  let offset = header.length;
  SIZES.forEach((size, i) => {
    const entry = 6 + i * 16;
    const data = images.get(size);
    if (!data) throw new Error(`缺少 ${size}px 图标数据`);
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(0, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  writeFileSync(file, Buffer.concat([header, ...SIZES.map((size) => images.get(size))]));
}

run(['tauri', 'icon', 'src-tauri/icons/source-light.svg']);
run(['tauri', 'icon', 'src-tauri/icons/source-light-small.svg', '-p', '16,24', '-o', '.icon-small']);

const images = readIco(join(iconsDir, 'icon.ico'));
images.set(16, readFileSync(join(tmpDir, '16x16.png')));
images.set(24, readFileSync(join(tmpDir, '24x24.png')));
images.set(128, readFileSync(join(iconsDir, '128x128.png')));
writeIco(join(iconsDir, 'icon.ico'), images);
rmSync(tmpDir, { recursive: true, force: true });

const legacy = join(iconsDir, 'source.png');
if (existsSync(legacy)) rmSync(legacy);

console.log(`icon.ico: ${SIZES.join(' / ')} px`);
