import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const host = process.env.TAURI_DEV_HOST;

// 版本唯一来源：仓库根 VERSION；前端在构建期注入，不在源码里写死版本号。
function readAppVersion(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'VERSION');
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8').trim();
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('未找到仓库根 VERSION 文件');
}

const appVersion = readAppVersion();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@foundation': fileURLToPath(new URL('./packages/foundation/src', import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'chrome105',
    minify: 'esbuild',
    sourcemap: false,
  },
});
