# Renomio

MIT License — 见 [LICENSE](LICENSE) 与 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

跨平台（Windows / macOS / Linux）批量文件 / 文件夹更名工具，重构自一款商业批量改名软件（Rename Studio 的新版本，非原地升级）。当前发布版聚焦「可预览、可撤销、不丢文件」的安全更名流程。

- 前端：React 19 + TypeScript + Vite 7
- 桌面壳：Tauri 2（Rust）
- 核心：`app/src-tauri/renomio-core`（无 Tauri 依赖，可单独 `cargo test`）
- 基础层：`app/packages/foundation`

## 主要能力

| 能力 | 说明 |
| --- | --- |
| 规则链 + 实时预览 | 添加 / 替换 / 删除 / 自动编号 / 移动字符 / 大小写 / 扩展名，可拖拽排序、逐条启停；原名与新名差异分段显示 |
| 冲突检测与策略 | 批次内重名与磁盘已存在；跳过 / 自动后缀 `name (1).ext` / 覆盖（先备份目标） |
| 两阶段执行 + 撤销 | 先写临时名再落目标，支持交换与环形改名；批次日志持久化，**重启后仍可撤销** |
| 撤销历史面板 | 每批时间、类型、成功/跳过/失败、是否可撤销及原因，支持逐批与「撤销到此」多级回退 |
| 元数据与导出 | 图片 / 音频 / Office / PDF 文本字段读写（音频含歌词；图片仅写 XMP，不写 APP13/8BIM）、方案导入导出、多格式导出（CSV / Excel `.xlsx` / HTML / TSV）、列显隐与列宽 |
| 快照 | 记录原路径与新路径映射（可选 SHA-256），还原只改回原名、冲突跳过、绝不覆盖；还原走追加批次日志，可再撤销 |
| 时间 / 属性 / 归类移动 | 批量平移或固定时间、只读与隐藏属性、按扩展名 / 日期 / 首字母 / 正则捕获组移动到子目录 |
| 五语言界面 | 简体中文、繁体中文、English、日本語、Español |

## 界面语言

内置五套界面文案，可在设置中切换（跟随系统或手动指定）：简体中文、繁體中文、English、日本語、Español。繁中 / 日 / 西三套为团队自行翻译，**未经母语审校**（见「已知限制」）。

详细能力表、验证分层与未验证清单见 [app/README.md](app/README.md)。

## 下载与安装

源码仓库已公开；**安装包与更新清单直接发布在 [yunyu697/renomio](https://github.com/yunyu697/renomio/releases)**（旧的发行仓库 `yunyu697/renomio-releases` 已于 2026-11-08 归档，仅保留历史下载）。最新发布是预发布 `v1.1.0-alpha7`（稳定版仍为 `v1.0.0`），源码 `VERSION` 与之一致；滚动更新清单 `latest.json` 仍指向 `1.1.0-alpha5`（最近一次带更新签名的版本，alpha6/alpha7 未生成 `.sig`）。下表为该版本的两个包：

| 包 | 文件 | 大小 | SHA-256（1.1.0-alpha7） |
| --- | --- | --- | --- |
| NSIS（推荐，可选安装范围） | `Renomio_1.1.0-alpha7_x64-setup.exe` | 2,487,921 字节（2.37 MiB） | `83A90904DFE7E6EF2AA66CC5721C03168D7F2AEC4509B3AF302F30219A695E17` |
| MSI（机器级单一包） | `Renomio_1.1.0-alpha7_x64_en-US.msi` | 3,678,208 字节（3.51 MiB） | `1B2C07D1715AF9AA0B24B778726C5BD59E0751541509323BAFF06A7FCC1292FB` |

应用内「设置 → 检查更新」读取源码仓库滚动 release `updates` 下的 `latest.json`，安装包也由该仓库下载；清单与资源地址均指向源码仓库，内置默认地址已随本版切换生效。

版本规则：唯一可改的版本号是仓库根 `VERSION`，其余（`app/package.json`、`app/packages/foundation/package.json`、`app/src-tauri/tauri.conf.json`、两个 `Cargo.toml`）由 `npm run version:sync` 注入；tag（如当前 `v1.1.0-alpha7`）必须与 `VERSION` 一致，段位（第二/三段与 alpha 序号）≤ 10。版本闸门按推送类型分档：**分支推送**（含 `main`）只要求 `VERSION` 不低于最新已发布 alpha，等于可通过、低于即拦截；**tag 推送**仍要求严格递增，alpha 复用与倒退一律拦截（`version` job 的 16 条反例自测覆盖这三种情形）。MSI 的 `ProductVersion` 只能是纯数字，故 `wix.version` 由同一 VERSION 的数字核注入（alpha 阶段取 `1.1.0`），包文件名仍带 alpha 号。

校验方式（PowerShell）：

```powershell
Get-FileHash .\Renomio_<版本>_x64-setup.exe -Algorithm SHA256
```

`SHA256SUMS` 与安装包同批上传，可用于批量比对。

## 安装范围与已知限制

### 安装范围

- **NSIS（`...setup.exe`）：双范围，安装时可选。** 默认「所有用户」→ `C:\Program Files\Renomio`；也可选「仅为我安装」→ `%LocalAppData%\Programs\Renomio`。两种选择都会先弹 UAC（Tauri 的 `both` 模式即使用户选当前用户也需要管理员权限）。
- **MSI（`...msi`）：只有机器级一种。** 固定装到 `C:\Program Files\Renomio`，必须管理员，**向导里没有范围选择页**，不提供用户级安装。需要用户范围请用 NSIS 包。
- **不要在同一台机器上混装两个范围或两种安装器。** NSIS 能识别并卸载已有的 MSI 版；**MSI 不识别 NSIS 版**，先装 NSIS 再装 MSI 会留下两条卸载项与两个同名快捷方式。NSIS 重新安装时若把范围改成相反一侧，安装器会在写文件前提示并中止（已装的一侧需先卸载）。
- 数据目录与安装范围无关，固定为每用户的 `%APPDATA%\app.renomio.desktop`；切换范围不会迁移配置、日志与撤销历史。

### 已知限制

- **旧版 Rename Studio 必须先卸载。** 新版 identifier 与 MSI UpgradeCode 均已变更，不是原地升级。安装器会按「旧显示名 + 旧 UpgradeCode」检测旧版，命中后给出卸载命令并中止。**卸载旧版时不要勾选「删除应用数据」**，否则新版无法导入你的配置与撤销历史。
- **两个安装包都未做代码签名**，首次运行会触发 Windows SmartScreen（「Windows 已保护你的电脑」）。请核对上面的 SHA-256 后再选择「仍要运行」。本轮没有签名证书，签名与时间戳流程尚未执行。
- **当前只发布 Windows x64 产物。** macOS / Linux 的打包配置尚在代码中，但本轮未构建、未验证，也没有对应安装包。
- 安装向导界面、需要 UAC 的安装/卸载、安装后首次启动的真实窗口交互，本轮均未在自动化中执行（按项目约定不在会话里启动带 GUI 或会弹 UAC 的进程）；因此「装到 `Program Files` 的落点、卸载残留、快捷方式位置、旧版并存拦截弹窗」属于**静态核验**结论，不是真机验收。
- 真实 Explorer 拖放、提权后的拖放（UIPI 会拦截）、真实物理跨盘移动、EXIF 拍摄时间写入在真实相机样张上的表现（功能已实现，本机只用自造 JPEG 结构测试）、快照窗在桌面端真实 UI 上的操作（Rust 真实文件测试与浏览器 mock 均已覆盖）均未完成或未验证。
- 繁中 / 日 / 西三套译文本工具产出，**未经母语审校**。

### 创建时间（btime）的跨平台可见性

| 平台 | 读 | 写 | 撤销时的行为 |
| --- | --- | --- | --- |
| Windows（NTFS） | 可读 | 可写 | btime 与 mtime / atime 一起恢复 |
| Linux | 可读（取决于文件系统是否暴露 `STATX_BTIME`） | **不可写**（内核没有写回 btime 的接口） | 在计划阶段标记为跳过，mtime / atime 照常恢复 |
| macOS | 标 `unsupported` | 标 `unsupported` | 与 Linux 同样按跳过处理（本轮未验证） |

- **跳过是「部分成功」，不会让整批撤销失败。** 被跳过的字段进入返回结构的 `skippedFields`（字段名 + 原因），**不计入** `failed`；批次仍记为已撤销，已经恢复的 mtime / atime 也不会被回滚。
- **UI 与日志都明示，不静默。** 撤销完成后界面提示「已撤销 N 项；创建时间在 Linux 上不支持恢复，已跳过」，同时向 `<dataDir>/logs/undo.log` **追加**一行 `undo\t<ts>\tbatch=<id>\tfield=creation\tpath=…\treason=…`（只记元数据，不写文件内容）。

## 卸载

- **NSIS 安装的**：设置 → 应用 → 已安装的应用 → `Renomio` → 卸载；或运行安装目录下的 `uninstall.exe`。
- **MSI 安装的**：设置 → 应用 → 已安装的应用 → `Renomio` → 卸载；或 `msiexec /x <ProductCode>`（ProductCode 可在该应用属性页或注册表 `Uninstall` 项中查到）。
- 卸载程序**只移除程序文件、快捷方式与 ARP 项**，不会自动删除 `%APPDATA%\app.renomio.desktop`（配置、撤销历史、迁移备份）。需要彻底清理时再手动删除该目录。
- 卸载**旧版 Rename Studio** 时不要勾选「删除应用数据」，否则新版无法导入配置与撤销历史（见上）。

## 仓库结构

```
.github/workflows/    CI（frontend / backend / bundle-checks）
app/                  Tauri 2 + React 应用源码
  src/                前端（React + TypeScript）
  src-tauri/          Rust 桌面壳、打包配置、NSIS 安装钩子
  src-tauri/renomio-core/ 更名核心（可独立测试）
  packages/foundation/ 共享基础层
  e2e/                无头 E2E 与截图
  scripts/            打包与校验脚本
design/               界面静态设计稿（HTML）
docs/                 实证分析、规则语义确认、签名与打包流程、完成度说明
CONTRIBUTING.md       项目工作约定
```

## 本地开发

```powershell
cd app
npm install
npm run dev            # 前端
npm run tauri dev      # 桌面壳（会打开窗口）
npm run test:core      # 核心 Rust 测试
npm run test:e2e       # 无头 E2E
npm run tauri build    # 产出 NSIS + MSI 到 src-tauri/target/release/bundle/
```

## 持续集成

[.github/workflows/ci.yml](.github/workflows/ci.yml) 三个 job，push 到 `main` 与 PR 时触发：

| job | runner | 内容 |
| --- | --- | --- |
| `frontend` | ubuntu | `npm ci` → `tsc --noEmit` → `vite build` |
| `backend` | ubuntu | 安装 Tauri v2 Linux 依赖 → `cargo fmt --check`（阻断）→ `cargo clippy`（只暴露警告，不加 `-D warnings`）→ `cargo test`（renomio-core + Tauri 壳，含 `migrate.rs` 迁移单测） |
| `bundle-checks` | windows | 离线组 11 条（读配置，每次都跑）+ 产物组 14 条（有构建产物时才跑） |

`bundle-checks` 分两组断言（`scripts/check-bundle.ps1`）：

- **离线组 11 条**：只读 `tauri.conf.json` / `installer-hooks.nsh` 判定 productName、identifier、version、`bundle.targets`、NSIS `installMode=both`、旧版检测与中止逻辑。CI **每次都真实执行**（`-Offline`），任一不成立即红。
- **产物组 14 条**：读 MSI、NSIS 安装包与 WiX/NSIS 生成的脚本，**必须 `npm run tauri build` 后才有**。CI 不构建安装包（托管 runner 上完整打包约 8–12 分钟，还要下载 NSIS/WiX 工具链，且安装包尚未签名），所以无产物时该组会**显式跳过，并在 Job Summary 列出跳过原因与逐条依赖**，不把跳过伪装成通过。发布前的产物合规仍由本地 `npm run test:bundle` 逐条执行。

两组的边界：**每次 push 真实执行的是 11 条离线断言**（结果在 `bundle-checks` 日志里，任一失败即红）；**14 条产物断言只读构建产物**，CI 未构建时不执行，二者互不重叠、也不互相代替。因此「CI 绿」只能证明配置层面的 11 条成立，**不能**证明安装包的 14 条成立。

## 许可

本项目以 **MIT** 许可发布，全文见 [LICENSE](LICENSE)。

**覆盖范围**：根目录的 `LICENSE` 覆盖 `app/`、`app/packages/foundation` 等**全部子目录**，因此不再单独放 `app/LICENSE`（避免出现两份内容不同的许可文件）。**Release 中分发的安装包（MSI / NSIS）适用同一 MIT 许可**，其内嵌的本项目代码与本仓库源码同源。

第三方依赖的许可证、版权声明与 NOTICE 要求见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)：运行时依赖与构建期依赖分组列出；含 Apache-2.0 的包单列并说明 NOTICE 保留要求（本轮扫描未发现需要随分发保留的独立 NOTICE 文件）；MIT / BSD / ISC 依赖给出合并版权清单（逐包原文）；双许可与字段缺失一律按原始字段记录，未自行取舍；弱 copyleft（MPL-2.0）单列并标注待确认。Windows 的 WebView2 由系统提供，不随安装包分发。

**商标**：MIT 许可授予复制、修改、分发、再许可与销售等权利，但**不授予 Renomio 名称与图标的使用权**——名称与图标不随 MIT 许可一并授权，衍生分发不得暗示官方背书。
