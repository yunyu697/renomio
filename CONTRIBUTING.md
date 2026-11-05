# 项目工作约定（必须遵守）

本仓库包含 `app/`（Tauri 2 + React 应用）、`packages/foundation`（共享基础层）、`scripts/` 与 `docs/`。以下约定对人和自动化代理一视同仁。

## 1. 所有构建、测试、验证一律后台执行

- `cargo build` / `cargo test`、`npm run build`、`npm run tauri build`、自动化测试、数据脚本、无头浏览器截图，全部用后台方式运行：
  - 优先使用工具的 `run_in_background`；
  - 或 `cmd /c ... > build.log 2>&1` 重定向到日志文件，再读取日志判断结果。
- 后台任务必须留下日志路径（例如 `app/build.log`、`app/test.log`、`app/screenshots/`），失败时先读日志定位，不要靠弹窗或目视。
- 不要反复把终端窗口、浏览器窗口、资源管理器窗口弹到前台，不要抢占用户焦点，不要打断用户正在做的事情。

## 2. 禁止在用户会话里启动带 GUI 的进程

- 不要运行 `npm run tauri dev` 起真实窗口；
- 不要启动会抢占桌面的浏览器（包括有头 Chromium/Edge）；
- 不要打开文件管理器、系统设置等窗口。

需要界面效果验证时：

1. 用 `npm run dev` 起 **无头** Vite 服务（本身不弹窗）；
2. 用 `msedge --headless=new --screenshot=...` 等无头渲染方式截图；
3. 读取截图文件做判断。

## 3. 前台例外流程

只有确实必须前台（例如操作系统级签名工具强制交互、需要用户登录）时才例外，并且必须：

1. 先说明为什么非前台不可；
2. 说明预计耗时和会占用什么；
3. 等用户单独确认后再执行。

默认答案永远是“想办法在后台做”。

## 4. 文件操作验收必须脚本化

- 用临时目录 + 断言（Rust 集成测试 / Node 脚本）验证改名、冲突、撤销、锁定、长路径等行为；
- 不靠人工点界面验收批处理与文件操作；
- 样本统一由 `app/scripts/gen-test-corpus.mjs` 生成，可重复运行。

## 5. 交付说明要如实

- 回复和文档中要区分：后台已验证 / 因必须前台而未验证 / 未实现；
- 不要把“没做”包装成“已验证”；
- 构建失败要贴日志关键行，并给出可行的替代路径。

## 6. 常用后台命令

```powershell
# 前端类型检查 + 构建
npm run build > build.log 2>&1

# Rust 核心真实文件测试
cargo test --manifest-path src-tauri/ffrn-core/Cargo.toml > test.log 2>&1

# Windows 发布包
npm run tauri build -- --bundles nsis > release.log 2>&1

# 无头浏览器 E2E（真实 dist + mock 后端；断言、截图、报告落盘到 app/e2e/）
npm run test:e2e > e2e-run.log 2>&1

# 无头截图
msedge --headless=new --disable-gpu --window-size=1440,900 `
  --screenshot=screenshots/main.png http://localhost:1420
```
