# AGENTS.md — Renomio 项目记忆

本文件是给 AI 编程助手（Trae / Cursor / Claude Code 等）的常驻上下文。改代码前先读完，再读 `CONTRIBUTING.md`。

## 项目

- 产品：Renomio，Windows 批量重命名与文件操作工具（Tauri 2 + React 19 + TypeScript + Vite 7，核心逻辑在 Rust crate `renomio-core`）。
- 版本：`VERSION` 是唯一来源，当前 `1.2.0-alpha4`；稳定版 `v1.0.0`。
- 仓库：`yunyu697/renomio`（源码与 Releases 同仓）。当前只发布 Windows x64。
- 许可证见 `LICENSE`，第三方见 `THIRD-PARTY-NOTICES.md`。

## 目录与入口

- `app/src/store.ts`：唯一 zustand store，状态与跨组件动作都在这里。
- `app/src/lib/bridge.ts`：唯一 Tauri `invoke` 出口；浏览器环境自动走 mock。新增命令需同时改 `src-tauri/src/lib.rs`、`lib/types.ts`、`lib/bridge.ts`。
- `app/src/lib/plans.ts`：方案库与最近记录（localStorage：`renomio.saved-plans`、`renomio.recent-items`；会话键 `rename-studio.session`）。
- `app/src/lib/commands.ts`：命令列表（规则链 + 冲突策略的批量作业，localStorage `renomio.commands`，最多 30 条、按最近使用排序；入口在「更多 → 命令」，`components/CommandsDialog.tsx`）。
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
npm run test:regex     # 正则方言（\1 分组引用）自测
npm run test:case      # 大小写例外词表自测
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
5. 更新签名私钥在仓库根 `renomio-signing\renomio.key`（`.gitignore` 的 `*.key` 已覆盖，同目录的 `renomio.key.pub` 是公钥、与 `tauri.conf.json` 的 `plugins.updater.pubkey` 配对）。构建时**只以路径**注入环境变量，切勿复制进产物目录、切勿 `type`/`Get-Content` 打印正文、切勿 `git add`：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = (Resolve-Path "..\renomio-signing\renomio.key").Path   # 在 app/ 下
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""                                             # 该密钥为空口令
npm run tauri:build
```

## 当前状态（2026-11-25，1.2.0-alpha4 已发布）

已实现并有证据：F2 方案库/最近记录、F3 SYSTEM/ARCHIVE 属性、F4 文本编码批量转换、U3 表格自动列宽 + 系统文件类型图标（逐项证据见 `docs/1.1.0-收口清单.md`）；界面重构落地——检查器改为列表下方底部抽屉、八类列表页签下线（列表为唯一主视图、右栏只留规则链）、页头「清空列表」带二次确认、侧栏收敛为「文件」一组、设置移入「更多」，结构决策见 `docs/界面重构-HIG基线.md` §11–§12；规则开关几何按尺寸变量重算并有 E2E 巡检；正则替换兼容 Delphi 方言 `\1..\9`（`\\1` 为字面，引用分组超限就地报错），见 `docs/规则语义确认清单.md` 末节与 `npm run test:regex`；命令列表（FEATURE-GAP 4.10）——规则链 + 冲突策略存成命令，「套用」只载入、「运行」必进预览确认，见 `docs/FEATURE-GAP.md`；大小写例外词表——`protect` 命中的片段在六种大小写模式下保留原写法（支持 `*`/`?`、大小写不敏感），见 `docs/规则语义确认清单.md` 末节与 `npm run test:case`。

已知缺口：
- Windows 安装包未做 Authenticode 代码签名（本机无 OV/EV 证书），SmartScreen 会警告；更新用 `.sig` 已验过。
- 已发布：`v1.2.0-alpha4`（2026-11-25，Pre-release，14 资产）为当前最新；滚动清单 release `updates` 的 `latest.json` 已指向 alpha4（三平台键齐全）。macOS/Linux 产物由 CI 构建（macOS ad-hoc 签名、未公证），未在真机桌面验证；繁中/日/西译文未经母语审校。
- `renomio-core` 的 `rename::tests::directory_junction_is_renamed_as_a_link` 在部分环境因联接点权限失败，属环境问题。
- 界面层遗留：`app.css` 里 `.list-tabs/.tab` 旧样式块已无引用；抽屉展开时 toast 会压住右下角；表头与行在「状态」列存在历史对齐偏差。

## 发布要点

1. 改 `VERSION` → `npm run version:sync`。
2. `npm run tauri:build`。先按「硬性约束」第 5 条把仓库外 `renomio-signing\renomio.key` 的**路径**注入 `TAURI_SIGNING_PRIVATE_KEY`（空口令），否则 `createUpdaterArtifacts` 会在产出两个安装包后因缺私钥以退出码 1 结束；有私钥时两个 `.sig` 与安装包同批产出。
3. `npm run test:bundle`；计算 SHA-256；更新根 `README.md` 与 `app/README.md` 产物表；用 `.sig` 内容重写 `latest.json`（version / size / 文件名 / signature 四项与实际包对齐）。
4. macOS/Linux 产物由 CI `bundle-linux` / `bundle-macos` 构建并上传 artifact（未签名，不改 Release 与 `latest.json`）。
5. 提交 → `git tag -a v<版本>` → 推 `main` 与 tag → `gh release create <tag> --prerelease` 上传两个包、`SHA256SUMS` 与 `latest.json`。
6. 完整步骤与签名说明见 `docs/交接说明.md` 第 7 节、`docs/签名与打包流程.md`。

## 常见坑

- E2E 对导航与预览文案有断言：`nav-plan` 现在打开**方案库**（`plans-dialog`），方案导入导出在工具栏 `plan-export`；属性取反预览行包含「非系统 / 未存档」列。改行为要同步改 `e2e/run.mjs`。
- PowerShell 不支持 `git commit -m "$(cat <<'EOF')"` 这种 Heredoc；用 `-F <文件>`。
- `cargo test` 若写 `renomio-core/Cargo.lock` 失败，改到 `app/src-tauri` 下执行，并设独立 `CARGO_TARGET_DIR`。
- 安装版调试端口：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9475 --remote-allow-origins=*'`，CDP 工具在 `app/scripts/verify/cdp.mjs`。
- 卸载不删 `%APPDATA%\app.renomio.desktop`；迁移与撤销历史都在这。

## 文档索引

`docs/交接说明.md`（总入口）、`docs/1.1.0-收口清单.md`、`docs/规则语义确认清单.md`、`docs/签名与打包流程.md`、`docs/FEATURE-GAP.md`、`docs/P0-完成度与验证说明.md`、`CONTRIBUTING.md`。
