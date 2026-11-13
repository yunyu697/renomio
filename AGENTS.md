# AGENTS.md — Renomio 项目记忆

本文件是给 AI 编程助手（Trae / Cursor / Claude Code 等）的常驻上下文。改代码前先读完，再读 `CONTRIBUTING.md`。

## 项目

- 产品：Renomio，Windows 批量重命名与文件操作工具（Tauri 2 + React 19 + TypeScript + Vite 7，核心逻辑在 Rust crate `renomio-core`）。
- 版本：`VERSION` 是唯一来源，当前 `1.1.0-alpha7`；稳定版 `v1.0.0`。
- 仓库：`yunyu697/renomio`（源码与 Releases 同仓）。当前只发布 Windows x64。
- 许可证见 `LICENSE`，第三方见 `THIRD-PARTY-NOTICES.md`。

## 目录与入口

- `app/src/store.ts`：唯一 zustand store，状态与跨组件动作都在这里。
- `app/src/lib/bridge.ts`：唯一 Tauri `invoke` 出口；浏览器环境自动走 mock。新增命令需同时改 `src-tauri/src/lib.rs`、`lib/types.ts`、`lib/bridge.ts`。
- `app/src/lib/plans.ts`：方案库与最近记录（localStorage：`renomio.saved-plans`、`renomio.recent-items`；会话键 `rename-studio.session`）。
- `app/src-tauri/renomio-core/`：纯 Rust，可单独 `cargo test`；文件操作逻辑优先放这里并配集成测试。
- `app/src-tauri/src/icons.rs`：Windows `SHGetFileInfoW` → PNG 图标（FFI，非 Windows 返回空）。
- `app/e2e/run.mjs`：无头 E2E，断言 + 报告落 `app/e2e/report.md|json`。

## 命令（在 `app/` 下）

```powershell
npm run build          # tsc --noEmit && vite build
npm run test:core      # cargo test -p renomio-core
npm run test:e2e       # 无头 E2E（mock 后端）
npm run test:drop      # 拖放状态机自测
npm run test:history   # 输入历史自测
npm run test:contrast  # 对比度
npm run test:bundle    # 打包断言（有产物才跑 14 条产物断言）
npm run version:check  # VERSION 与 5 处清单一致
npm run tauri build    # 产出 NSIS + MSI
```

## 硬性约束

1. 所有构建、测试、截图后台执行，日志落盘；失败先读日志。不要在会话里启动带 GUI 的进程、不要抢焦点。
2. 文件操作验收必须脚本化（临时目录 + 断言），不靠人工点界面。
3. 交付说明如实区分「已验证 / 未验证 / 未实现」，不伪造通过。
4. 不要提交任何私钥、证书、令牌；本地数据在 `%APPDATA%\app.renomio.desktop`。

## 当前状态（2026-11-11，alpha7）

已实现并有证据：F2 方案库/最近记录、F3 SYSTEM/ARCHIVE 属性、F4 文本编码批量转换、U3 表格自动列宽 + 系统文件类型图标。逐项证据见 `docs/1.1.0-收口清单.md`。

已知缺口：
- 更新用 `.sig` 未生成（无 `TAURI_SIGNING_PRIVATE_KEY`），`updates` 的 `latest.json` 仍指向 alpha5。
- 安装包未代码签名（无证书），SmartScreen 会警告。
- macOS/Linux 未构建未验证；繁中/日/西译文未经母语审校。
- `renomio-core` 的 `rename::tests::directory_junction_is_renamed_as_a_link` 在部分环境因联接点权限失败，属环境问题。

## 发布要点

1. 改 `VERSION` → `npm run version:sync`。
2. `npm run tauri build`。若日志出现「A public key has been found, but no private key」，说明未配置签名私钥；两个安装包**已经产出**，但命令会以退出码 1 结束，这不是打包失败。
3. `npm run test:bundle`；计算 SHA-256；更新根 `README.md` 与 `app/README.md` 产物表。
4. 提交 → `git tag -a v<版本>` → 推 `main` 与 tag → `gh release create <tag> --prerelease` 上传两个包与 `SHA256SUMS`。
5. 完整步骤与签名说明见 `docs/交接说明.md` 第 7 节、`docs/签名与打包流程.md`。

## 常见坑

- E2E 对导航与预览文案有断言：`nav-plan` 现在打开**方案库**（`plans-dialog`），方案导入导出在工具栏 `plan-export`；属性取反预览行包含「非系统 / 未存档」列。改行为要同步改 `e2e/run.mjs`。
- PowerShell 不支持 `git commit -m "$(cat <<'EOF')"` 这种 Heredoc；用 `-F <文件>`。
- `cargo test` 若写 `renomio-core/Cargo.lock` 失败，改到 `app/src-tauri` 下执行，并设独立 `CARGO_TARGET_DIR`。
- 安装版调试端口：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9475 --remote-allow-origins=*'`，CDP 工具在 `app/scripts/verify/cdp.mjs`。
- 卸载不删 `%APPDATA%\app.renomio.desktop`；迁移与撤销历史都在这。

## 文档索引

`docs/交接说明.md`（总入口）、`docs/1.1.0-收口清单.md`、`docs/规则语义确认清单.md`、`docs/签名与打包流程.md`、`docs/FEATURE-GAP.md`、`docs/P0-完成度与验证说明.md`、`CONTRIBUTING.md`。
