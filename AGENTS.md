# AGENTS.md — Renomio 项目记忆

本文件是给 AI 编程助手（Trae / Cursor / Claude Code 等）的常驻上下文。改代码前先读完，再读 `CONTRIBUTING.md`。

## 项目

- 产品：Renomio，Windows 批量重命名与文件操作工具（Tauri 2 + React 19 + TypeScript + Vite 7，核心逻辑在 Rust crate `renomio-core`）。
- 版本：`VERSION` 是唯一来源，当前 `1.2.0-alpha9`；稳定版 `v1.0.0`。
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
npm run test:css       # 孤儿样式选择器检查（CSS 有、源码无 = 死代码）
npm run test:meta      # 元数据取名字段守卫（17 字段 / 五语种文案 / Rust 结构体一一对应）
npm run test:move      # 移动子串守卫（按位置/按标记定位、目标前后、越界与缺标记兜底、旧规则兼容）
npm run test:ext       # 扩展名智能分析守卫（文件头纠正/识别不出保持原名/文案/前后端接线）
npm run test:del       # 删除规则守卫（四模式语义/从尾部数朝向/emoji 码点/空标记拦截/旧规则兼容）
npm run test:iptc      # IPTC-IIM 守卫（静态断言 + 真实 JPEG 用 Pillow 独立回读 APP13 8BIM）
npm run test:platform  # 平台能力契约守卫（跑 platform_probe 与宿主 OS 逐字段比对；CI 三平台矩阵各跑一遍）
npm run test:datadir   # 数据目录契约守卫（跑 datadir_probe 覆盖便携/命令行/环境变量/回落五场景；CI 三平台矩阵各跑一遍）
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

## 当前状态（2026-11-25，1.2.0-alpha14 已发布）

已实现并有证据：F2 方案库/最近记录、F3 SYSTEM/ARCHIVE 属性、F4 文本编码批量转换、U3 表格自动列宽 + 系统文件类型图标（逐项证据见 `docs/1.1.0-收口清单.md`）；界面重构落地——检查器改为列表下方底部抽屉、八类列表页签下线（列表为唯一主视图、右栏只留规则链）、页头「清空列表」带二次确认、侧栏收敛为「文件」一组、设置移入「更多」，结构决策见 `docs/界面重构-HIG基线.md` §11–§12；规则开关几何按尺寸变量重算并有 E2E 巡检；正则替换兼容 Delphi 方言 `\1..\9`（`\\1` 为字面，引用分组超限就地报错），见 `docs/规则语义确认清单.md` 末节与 `npm run test:regex`；命令列表（FEATURE-GAP 4.10）——规则链 + 冲突策略存成命令，「套用」只载入、「运行」必进预览确认，见 `docs/FEATURE-GAP.md`；大小写例外词表——`protect` 命中的片段在六种大小写模式下保留原写法（支持 `*`/`?`、大小写不敏感），见 `docs/规则语义确认清单.md` 末节与 `npm run test:case`。界面遗留清零（alpha6）——死样式删除 + toast 让位 + 表头/行逐列几何断言，见 `npm run test:css` 与 e2e 几何巡检；按元数据取名扩到 17 字段（alpha7）——EXIF `ISO/光圈/快门/焦距/镜头`、`像素宽/高/像素尺寸`（无 EXIF 回退图像尺寸）、音频 `年份/流派/作曲`，取值统一文件名安全化，并修掉 EXIF SHORT 值无视 TIFF 字节序的读错缺陷，见 `npm run test:meta`、`npm run test:core` 与 `docs/FEATURE-GAP.md` 3.8；移动子串补齐定位与落点（alpha8）——新增 `by=index|markers`（按标记取两标记之间的内容，留空即不设边界、标记找不到整条跳过）、`insert=before|after`（同一目标位差一位，可控落点左右），旧存档规则按 `index`/`before` 兜底、语义不变，见 `npm run test:move`、e2e 10 条断言与 `docs/FEATURE-GAP.md` 3.6；扩展名「智能分析」（alpha9）——Rust 按**文件头魔数**（前 64 字节，不解码内容）识别 20 种格式，前端扩展名规则新增 `analyze` 模式在预览时纠正错标扩展名，识别不出/头部过短/目录/演示模式一律保持原名不猜，见 `npm run test:ext`（56 条）、`npm run test:core`（含 4 条嗅探）与 `docs/FEATURE-GAP.md` 3.7；删除规则补齐四模式（alpha10）——「从尾部数」的起点改为从末尾逆算并朝词尾延伸（旧实现把窗口结束在倒数第 N 个，等于删到词首）、「首尾之间」改按码点换算（emoji 不再被切半个）、两个标记全空时规则卡就地报错而非静默删空整名、修剪新增自定义修剪字符集（留空仍只剪空白，旧存档语义不变），见 `npm run test:del`（77 条）、e2e 16 条断言与 `docs/FEATURE-GAP.md` 3.4；IPTC Core 双写 IPTC-IIM（alpha11）——JPEG 上 Headline / By-line Title / Credit / Source 除 XMP 外同时写进 APP13 的 `Photoshop 3.0` 8BIM 资源 0x0404（`2:105` / `2:85` / `2:110` / `2:115`），非 ASCII 自动插 `1:90 ESC % G` 声明，未知 dataset、别家 APP13、0x040C 缩略图资源原样保留，改动后丢弃过期 `0x0406` 摘要交给 Photoshop 重建，读侧在 XMP 缺值时才回退 IIM，见 `npm run test:iptc`（45 条，真实 JPEG 用 Pillow 独立回读）、`npm run test:core`（含 6 条 IIM 单测）与 `docs/FEATURE-GAP.md` 5.15；跨平台能力契约（alpha12）——`platform::PlatformReport` 成为平台差异的**单一事实来源**（OS/分隔符/大小写默认/路径阈值与硬上限/btime 三态+原因/「隐藏·系统·存档仅 Windows」+原因/长路径前缀），`tests/platform_contract.rs` 11 条逐 OS 断言（只读位真实往返、非 Windows 属性写入必须逐条失败并带原因、Windows 名称规则与宿主无关），`examples/platform_probe.rs` 打出 JSON 由 `npm run test:platform` 逐字段比对；CI 新增 `cross-os` 矩阵在 **ubuntu / windows / macos 三个真实 OS** 上跑同一份 core 测试，见 `docs/FEATURE-GAP.md` 6.11；alpha12 的 tag CI [45504761322](https://github.com/yunyu697/renomio/actions/runs/45504761322) 全绿（含 `cross-os` 的 ubuntu / windows / macos 三条），`v1.2.0-alpha12` 以 Pre-release 发布 15 个资产；alpha13 的 tag CI [45520274192](https://github.com/yunyu697/renomio/actions/runs/45520274192) 同样 10 个 job 一次全绿（`cross-os` 三平台各跑 `platform_contract` + `datadir_contract` + 两个 `--require-probe` 守卫），`v1.2.0-alpha13` 以 Pre-release 发布 15 个资产，滚动 `updates` 的 `latest.json` 已指向 `1.2.0-alpha13`。数据目录 / 便携模式（alpha13）——`renomio-core/src/datadir.rs` 成为数据目录的**唯一解析点**（优先级：`--data-dir` > `RENOMIO_DATA_DIR` > 程序旁 `renomio.portable`（数据落 `<程序目录>/data`）> 每用户目录）；标记在但便携目录不可用（同名文件 / 无写权限）时回落到每用户目录并把原因写进 `dataRootNote`，界面直接显示，不静默丢数据；便携或覆盖时 `migrate::info_skipped` 跳过自动迁移、旧目录保留可手动导入；`tests/datadir_contract.rs` 11 条 + `npm run test:datadir` 44 条（真跑 `datadir_probe` 五场景），CI `cross-os` 三平台各跑一遍；设置 › 运行环境新增「数据目录来源」行与便携说明（五语种）。见 `docs/FEATURE-GAP.md` 6.12。更新通道修复（alpha14）——版本比较从 `update.rs` 的 `semver::Version::parse` 裸比改为 `renomio_core::version::is_newer`：`alpha` 序号按**数值**比较，`alpha9 < alpha10 < alpha13`；旧逻辑把整段 `alphaN` 当 semver 字母数字标识符，字符串序下 `alpha10 < alpha9`，导致装在 1.2.0-alpha9 的机器永远检查不到更新（2026-11-25 实测该机装的正是 alpha9）。配套 `tests/version_contract.rs` 11 条（含 alpha9→alpha13 回归与 alpha10..alpha20 全序列）、`examples/version_probe.rs` 探针、`npm run test:update`（探针实跑 + 接线 + 文档同源）与 CI `cross-os` 三平台各跑一遍；`src-tauri` 已移除 `semver` 依赖。注意：**alpha9 及更早的装机自己跑的是旧逻辑，需手工装一次 alpha14 才能恢复通道**。

已知缺口：
- Windows 安装包未做 Authenticode 代码签名（本机无 OV/EV 证书），SmartScreen 会警告；更新用 `.sig` 已验过。
- 已发布：`v1.2.0-alpha13`（2026-11-25，Pre-release，15 资产）为当前最新；滚动清单 release `updates` 的 `latest.json` 已指向 alpha13（三平台键齐全：windows 2,533,408 / linux 86,927,864 / mac 3,201,704，签名内绑定 `version:1.2.0-alpha13`）。tag CI `45520274192` 全部 job 一次全绿（version / frontend / backend / bundle-windows / bundle-linux / bundle-macos / bundle-checks + `cross-os` 的 ubuntu / windows / macos 三条）；6 个包离线验签全 PASS（keyid `a1d8edb60bbc50fd`）。alpha12 的 CI 为 `45504761322`，alpha11 的 CI 为 `45501730029`。macOS/Linux 产物由 CI 构建（macOS ad-hoc 签名、未公证），`cross-os` 只在无头环境跑，未在真机桌面手工点验；繁中/日/西译文未经母语审校。
- `renomio-core` 的 `rename::tests::directory_junction_is_renamed_as_a_link` 在部分环境因联接点权限失败，属环境问题。
- 界面层遗留（2026-11-25 清零）：`.list-tabs/.tab` 旧样式块连同 105 个死选择器一并删除（app.css −17%、shell.css −8.5%），`npm run test:css` 孤儿守卫进 CI，`scripts/test-css-orphans.mjs` 当前 0 孤儿；toast 改为让位式（右侧抽屉展开左移到抽屉左侧、底部检查器展开抬到检查器上方）；表头与行逐列几何断言实测 7 列 Δ=0、状态列表头文字与徽标 Δ=0.00（`e2e/run.mjs` 第 4 条断言起）。

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
