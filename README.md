# Renomio

MIT License — 见 [LICENSE](LICENSE) 与 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

跨平台（Windows / macOS / Linux）批量文件 / 文件夹更名工具。产品名 **Renomio**（曾用名 Rename Studio，因与已有产品重名才改名；改名不是原地升级，见「改名与旧版迁移」）。当前发布版聚焦「可预览、可撤销、不丢文件」的安全更名流程。

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
| 元数据与导出 | 图片 / 音频 / Office / PDF 文本字段读写（音频含歌词；图片写 XMP，JPEG 的 IPTC Core 四字段同时写 IPTC-IIM / APP13 8BIM，新旧软件看到一致）、方案导入导出、多格式导出（CSV / Excel `.xlsx` / HTML / TSV）、列显隐与列宽 |
| 快照 | 记录原路径与新路径映射（可选 SHA-256），还原只改回原名、冲突跳过、绝不覆盖；还原走追加批次日志，可再撤销 |
| 时间 / 属性 / 归类移动 | 批量平移或固定时间、只读 / 隐藏 / 系统 / 归档属性、按扩展名 / 日期 / 首字母 / 正则捕获组移动到子目录 |
| 五语言界面 | 简体中文、繁体中文、English、日本語、Español |
| 高级规则 | 对照表换词（单遍最长匹配）、编码转换（NFC / 全半角 / UTF-8 乱码修复）、受限脚本表达式、中文内码（GBK 乱码还原 + 简繁 Big5 / GBK 用字）、文件名加解密（口令 + AES / HMAC，可逆）；均只改文件名主干 |

### 高级规则（脚本 / 编码 / 内码 / 加密）

- **脚本规则**：受限表达式，**不执行任意 JavaScript**。可用变量 `name`（当前主干，随前序规则变化）、`ext`、`original`、`dir`、`modified`、`size`、`u0`–`u9`；函数 `upper / lower / trim / len / contains / startsWith / endsWith / replace / regex / cut / pad / if / date / time`；支持 `+ - * / %`、比较、`&& || !`、三元与括号。源 ≤600 字符、token ≤400、嵌套 ≤24；结果为空串视为失败并保留原名。编辑器给实时错误（未知变量、函数参数个数、正则非法等都带位置或名称）。
- **编码转换**：NFC / NFD / NFKC / NFKD、全角→半角、半角→全角、UTF-8 乱码修复。乱码修复只在严格 UTF-8 解码成功时生效，正常文件名不会被误改。
- **中文内码**：`gbk-fix` 还原「UTF-8 被按 GBK 解码」的乱码（整串可逆才替换）；`to-big5` 简体→繁体并采用 Big5 用字；`to-gbk` 繁体→简体。Emoji 等字符集外字符原样保留。
- **文件名加解密**：只加密主干、保留扩展名，不碰文件内容；`encrypt` 生成 `rnc1-` 前缀密文，`decrypt` 用同一口令还原。AES-256-CBC + HMAC-SHA256 认证，口令 PBKDF2 派生；同口令同名同密文，预览稳定。口令随计划保存，别外发含口令的计划。
- 四类规则都只作用于文件名主干，扩展名与目录结构不动；目录名同样适用。旧存档缺或非法 `mode` 会回落到安全默认值（编码 `nfc`、内码 `gbk-fix`、加密 `encrypt`）。


## 界面语言

内置五套界面文案，可在设置中切换（跟随系统或手动指定）：简体中文、繁體中文、English、日本語、Español。繁中 / 日 / 西三套为团队自行翻译，**未经母语审校**（见「已知限制」）。

详细能力表、验证分层与未验证清单见 [app/README.md](app/README.md)。

## 下载与安装

源码仓库已公开；**安装包与更新清单直接发布在 [yunyu697/renomio](https://github.com/yunyu697/renomio/releases)**（旧的发行仓库 `yunyu697/renomio-releases` 已于 2026-11-08 归档，仅保留历史下载）。稳定版仍为 `v1.0.0`。**当前最新发布是预发布 `v1.2.0-alpha17`（2026-11-25，表格自动列宽）**：Windows / macOS / Linux 三平台产物由 CI 在 tag 上构建并带 updater `.sig`，统一上传到同一 Release；滚动更新清单 `latest.json` 已指向本版（三平台键齐全，version / size / 文件名 / 签名四项与实际包对齐）。下表为 Release 中的两个 Windows 包：

| 包 | 文件 | 大小 | SHA-256（1.2.0-alpha17） |
| --- | --- | --- | --- |
| NSIS（推荐，可选安装范围） | `Renomio_1.2.0-alpha17_x64-setup.exe` | 2,561,314 字节（2.44 MiB） | `21720C3B9358DA57BB5D07735217F5A949F623AAD74AF0D05399C4A53E5300BD` |
| MSI（机器级单一包） | `Renomio_1.2.0-alpha17_x64_en-US.msi` | 3,395,584 字节（3.24 MiB） | `DB6C277941D58D59FB2002E7063B14B1B3035833224B6206AC9981CCE15CA9E0` |

应用内「设置 → 检查更新」读取源码仓库滚动 release `updates` 下的 `latest.json`，安装包也由该仓库下载；清单与资源地址均指向源码仓库，内置默认地址已随本版切换生效。

更新判定按 **`alpha` 序号数值比较**（`alpha9 < alpha10 < alpha13`），不是字符串序——2026-11-25 的 alpha13 曾让装在 `1.2.0-alpha9` 的客户端检查不到更新（旧实现把整段 `alphaN` 当 semver 的字母数字标识符，`alpha10 < alpha9`），alpha14 起改由 `renomio_core::version` 统一比较，并有 `npm run test:update` 与三平台 CI 断言钉住。**装在 `1.2.0-alpha9` 及更早版本的机器**因为跑的是旧逻辑，自己看不到后续版本，需要手工装一次 alpha14（或更新版本），之后通道自动恢复。

版本规则：唯一可改的版本号是仓库根 `VERSION`，其余（`app/package.json`、`app/packages/foundation/package.json`、`app/src-tauri/tauri.conf.json`、两个 `Cargo.toml`）由 `npm run version:sync` 注入；tag（如 `v1.1.0-alpha8`）必须与 `VERSION` 一致，段位（第二/三段与 alpha 序号）≤ 10。版本闸门按推送类型分档：**分支推送**（含 `main`）只要求 `VERSION` 不低于最新已发布 alpha，等于可通过、低于即拦截；**tag 推送**仍要求严格递增，alpha 复用与倒退一律拦截（`version` job 的 16 条反例自测覆盖这三种情形）。MSI 的 `ProductVersion` 只能是纯数字，故 `wix.version` 由同一 VERSION 的数字核注入（alpha 阶段取 `1.1.0`），包文件名仍带 alpha 号。

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
- 默认数据目录与安装范围无关，为每用户的 `%APPDATA%\app.renomio.desktop`；切换范围不会迁移配置、日志与撤销历史。需要用 U 盘随身携带时见下方 [便携模式](#便携模式u-盘)。

### 便携模式（U 盘）

- 在 `renomio.exe` 所在目录放一个空文件 `renomio.portable`，数据目录就变成该目录下的 `data/`（配置、批次记录、撤销历史、备份全在里面）；把整个程序目录拷到 U 盘即可带走全部数据。
- 也可显式指定目录：`renomio.exe --data-dir E:\RenomioData`，或设置环境变量 `RENOMIO_DATA_DIR=E:\RenomioData`。
- 优先级：`--data-dir` > `RENOMIO_DATA_DIR` > `renomio.portable`（程序旁的 `data/`）> 每用户默认目录。
- **标记在但目录不可用**（程序目录只读、`data` 被同名文件占住等）时**不会静默失败**：自动回落到每用户默认目录，并把原因显示在 设置 › 运行环境。
- 便携 / 覆盖模式下**不自动迁移**旧版 Rename Studio 的数据（旧目录原样保留，可在设置里手动「从旧版导入数据」导入到当前数据目录）。
- 设置 › 运行环境显示「数据目录 / 数据目录来源 / 便携说明」，来源取值：`命令行 --data-dir`、`环境变量 RENOMIO_DATA_DIR`、`便携模式（U 盘，随程序走）`、`每用户默认位置`。
- 有机器验证：`npm run test:datadir`（44 条，真跑 `datadir_probe` 覆盖无标记 / 有标记 / 标记冲突 / 两级覆盖 / 命令行解析），`cargo test --test datadir_contract`（11 条），CI 的 `cross-os` 在 ubuntu / windows / macos 各跑一遍。

### 设置文件（`.ini`）导入导出

- 设置 › **设置文件**：把整份设置（外观、名称安全策略、USER 变量、快捷键、列宽、规则链、布局）导出成一份可读的 `.ini`；换机器时导入即可复现同样的规则与界面。
- 文件是一行一键值，可用记事本直接看和改：`;` 或 `#` 开头是注释，嵌套对象用点路径（`layout.side = 400`），数组用下标（`userVars[0] = ...`，规则是 `[rules]` 分节下的 `[0].type = replace`），空对象/空数组写作 `{}` / `[]`。
- 导入**只接受已知键且类型匹配**：未知键、类型不符、缺字段的规则条目会被丢弃并在提示里计数；语法错误（重复键、下标跳号、引号未闭合）会带行号报出来，且**当前设置一个字都不改**。
- 编解码只在 `renomio-core/src/ini.rs` 一处实现；有机器验证：`cargo test --test ini_contract`（15 条）与 `npm run test:ini`（66 条，含整份设置往返一致与 6 类坏文件的行号断言）。

### 列宽自适应

- 表头分隔线**双击**：该列按列里真实内容（含表头文案）自动调宽，装得下最长一行；列菜单里的「自动列宽」一次算好所有可见列。
- 宽度夹在每列的最小可读宽度与一个上界之间：一行超长文件名不会把整张表挤爆；算出来的宽度照常写进设置，重启后保持，「重置列宽」可一键回默认。
- 算法收在 `src/lib/columnFit.ts` 的纯函数里（文本测量由调用方注入），所以它能被单独跑：`npm run test:columns`（56 条，含 Node 类型剥离直接实跑 + 接线 + 五语种 + 文档同源），另有 e2e 几何断言验证表头与行仍逐列对齐。

### 属性备份库（跨批次还原）

在检查器里改「只读 / 隐藏 / 系统 / 归档」成功后，Renomio 会把**改之前的四属性**另存一份到
`<数据目录>/attr-backups/<时间戳>-<批次>.json`，与批次历史完全分离：批次记录被清理、甚至整份坏掉，
这份备份仍在。属性面板底部「属性备份」列出最近三份（时间 + 文件数），点「还原」即可把该批条目整体写回；
文件已经不在的条目会单独计数回报，不阻断其他条目。

- 原子写（先 `.tmp` 再改名），坏文件在列表里直接跳过，不会让整个列表不可用。
- 只保留最近 50 份，写入后自动裁剪最旧的；不碰批次日志与 `backups/` 里的文件备份。
- 浏览器演示模式不读取备份库（没有真实文件系统可写）。

### 系统集成（右键菜单与桌面快捷方式）

- 设置 › **系统集成**：一行显示右键菜单当前状态（未安装 / 已安装 3 个入口 / 部分安装 / 当前平台不支持），旁边一个按钮在「安装」与「移除」之间切换，另有「刷新」重新读注册表；下面一行「创建桌面快捷方式」写出 `Renomio.lnk`。
- 右键菜单覆盖三处：文件、文件夹、目录空白处；菜单项是「用 Renomio 重命名」并带程序图标。命令形如 `"<Renomio 可执行文件>" "%1"`（目录背景用 `"%V"`）。
- **只写当前用户**：`HKCU\Software\Classes\*\shell\Renomio`、`Directory\shell\Renomio`、`Directory\Background\shell\Renomio`；不需要管理员权限，卸载时整棵子树删除、本来就不存在也算成功（幂等）。
- 快捷方式由 Windows 自己的 COM（`IShellLinkW` + `IPersistFile.Save`）写出，不是手搓 `.lnk` 字节——缺 IDList/PIDL 的手写文件在系统里目标会读成空；目标必须是绝对路径，相对路径直接报错且不落文件。
- 非 Windows 平台状态显示「当前平台不支持（仅 Windows）」，安装按钮禁用，不会假装改注册表。
- Windows 会缓存右键菜单，装完若没立刻出现，重启资源管理器（或重新登录）即可。
- 有机器验证：`cargo test --test integration_contract`（7 条，含 Windows 真写注册表往返与重复安装/删除幂等）、`src-tauri` 的 `cargo test --lib shortcut`（3 条，COM 回读目标/参数/图标 + 相对路径拒绝 + 平台不支持）、`npm run test:integration`（45 条，静态同源；加 `--require-probe` 再真跑上面两组 cargo 测试）。

### 数据目录自检与修复

- 设置 › **数据自检与修复**：先点「开始检查」做**只读**扫描——缺失的子目录、损坏的批次日志/快照、损坏的规则输入历史、残留临时文件、孤儿备份，每条都写明路径与原因；再点「执行修复」按需处理。
- 修复只做三件事：重建缺失目录；把坏文件**隔离**到 `repair-quarantine/<时间戳>/…`（**不删除**，随时能取回）；清理**超过 24 小时**的自己写的临时文件（`.tmp` / `.json.tmp`）。孤儿备份只提示不动手。
- 修完再查必须是干净的（幂等），所以「修一次还是报错」会立刻暴露；`check` 全程不写一个字节。
- 有机器验证：`cargo test --test repair_contract`（15 条契约）与 `npm run test:repair`（90 条，含探针实跑 12 组场景 + 接线 + 五语种文案），CI 的 `cross-os` 在 ubuntu / windows / macos 各跑一遍。

### 已知限制

- **旧版 Rename Studio 必须先卸载。** 新版 identifier 与 MSI UpgradeCode 均已变更，不是原地升级。安装器会按「旧显示名 + 旧 UpgradeCode」检测旧版，命中后给出卸载命令并中止。**卸载旧版时不要勾选「删除应用数据」**，否则新版无法导入你的配置与撤销历史。
- **Windows 安装包未做代码签名**，首次运行会触发 Windows SmartScreen（「Windows 已保护你的电脑」）。请核对上面的 SHA-256 后再选择「仍要运行」。本轮没有签名证书，签名与时间戳流程尚未执行。
- **三个平台都已进 GitHub Release。** Windows（NSIS / MSI）、Linux（`.deb` / `.AppImage`）、macOS（`.dmg` / `Renomio.app.tar.gz` / `arm64.app.zip`）都由 tag CI 真实构建、带与 `plugins.updater.pubkey` 配对的 updater 签名并上传到同一 Release；滚动 `latest.json` 三平台键齐全。限制仍在：macOS 为 ad-hoc 签名**未公证**（Gatekeeper 需手动放行），Windows 无 Authenticode 证书（SmartScreen 提示），Linux 未做发行版签名——详见下方 [Linux 与 macOS 产物](#linux-与-macos-产物ad-hoc--updater-签名)。
- **Linux 需要系统中文字体。** 界面不自带字体，系统缺 Noto CJK 等中文字体时，所有中文会渲染成空心方块（豆腐块）。安装方式见 [中文字体依赖](#中文字体依赖linux)。
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

## Linux 与 macOS 产物（ad-hoc / updater 签名）

**来源**：CI 的 `bundle-linux` / `bundle-macos` / `bundle-windows` job 会真实执行 `tauri build`，产物以 Actions artifact 形式提供（`renomio-linux-x64`、`renomio-macos-arm64`、`renomio-windows-x64`）。构建时用仓库 secret `TAURI_SIGNING_PRIVATE_KEY` 为安装包生成 updater 签名（`.sig`，与 `tauri.conf.json` 的 `plugins.updater.pubkey` 配对，应用内下载后会验签）。**三者都没有进入 GitHub Release，`latest.json` 目前只含 `windows-x86_64`**，所以 macOS / Linux 的应用内「检查更新」要等下一次发布把对应键写进清单后才可用。

| 平台 | 产物 | 架构 | 签名状态 |
| --- | --- | --- | --- |
| Linux | `.deb`、`.AppImage` | x86_64 | 无 OS 级签名（Linux 无强制要求）；有 updater `.sig` |
| macOS | `.dmg`、`.app.zip` | arm64（Apple Silicon） | **ad-hoc 签名**（`codesign -s -`），未公证；dmg 另有 updater `.sig`（重打 dmg 后重新生成） |
| Windows | `.msi`、`-setup.exe` | x64 | 未做 Authenticode 代码签名（见上）；有 updater `.sig` |

### Linux 安装

```bash
# Debian / Ubuntu：用 apt 装可以自动补 webkit2gtk 依赖
sudo apt install ./Renomio_<版本>_amd64.deb

# 或直接跑 AppImage（需要 FUSE；没有 FUSE 时用 --appimage-extract-and-run）
chmod +x Renomio_<版本>_amd64.AppImage
./Renomio_<版本>_amd64.AppImage
```

AppImage 的可用性取决于发行版的 WebKitGTK 版本（需要 4.1）。**尚未在真实 Linux 桌面上验证**（CI 只在 Xvfb + openbox 下验证了进程能启动、窗口能创建），窗口拖动/缩放、文件管理器拖放、输入法等仍需真机确认。

#### 中文字体依赖（Linux）

界面**不内嵌字体**，中文字形完全依赖系统字体：字体栈优先 macOS/Windows 自带字体（苹方、微软雅黑等），Linux 上回落到 Noto Sans CJK / 思源黑体 / 文泉驿。桌面发行版的中文环境通常自带 Noto CJK；**最小化安装、容器或纯英文环境可能一个中文字体都没有，此时界面里的中文会全部显示为空心方块（豆腐块），英文与数字正常**——数据没有损坏，只是没有字形可渲染。

```bash
# Debian / Ubuntu
sudo apt install fonts-noto-cjk
# Fedora
sudo dnf install google-noto-sans-cjk-fonts
# Arch
sudo pacman -S noto-fonts-cjk
# openSUSE
sudo zypper install google-noto-sans-cjk-fonts
```

`.deb` 已把 `fonts-noto-cjk` 声明为 `Recommends`，`apt install ./Renomio_*.deb` 时默认会一并装上；AppImage 不带任何依赖，字体需自行安装。CI 的 `bundle-linux` 冒烟显式安装 `fonts-noto-cjk`，并在截图前用 `fc-list :lang=zh-cn` 断言中文字体存在（缺失即失败），避免再产出豆腐块截图。

### macOS 安装（ad-hoc 签名，无 Apple 身份）

1. 打开 `.dmg`，把 `Renomio` 拖进「应用程序」。
2. **首次打开会被 Gatekeeper 拦截**（提示「无法验证开发者」或「已损坏，无法打开」）。任选一种放行方式：
   - 在「应用程序」里 **右键 → 打开 → 打开**（只需一次，之后正常双击）；
   - 或 系统设置 → 隐私与安全性 → 底部「仍要打开」；
   - 或终端清除隔离属性：`xattr -dr com.apple.quarantine /Applications/Renomio.app`。
3. 若提示「已损坏」，通常是下载工具附加了隔离属性，用上面第 3 条命令即可；**ad-hoc 签名本身是自洽的**（CI 里 `codesign --verify --deep --strict` 必须通过才会产出）。

> ad-hoc 签名只保证包内签名完整，**不代表 Apple 认可**：`spctl` 会显示 rejected，也无法公证。要消除拦截只能购买 Apple Developer 账号（Developer ID 证书），流程见 [docs/签名与打包流程.md](docs/签名与打包流程.md)。

### 平台功能差异（不要当作功能对等）

| 功能 | Windows | Linux | macOS |
| --- | --- | --- | --- |
| GB18030 文本转换 | 支持（系统代码页 54936） | **不可用**（直接报错，不做静默降级） | **不可用** |
| 只读属性 | 支持 | 支持（UNIX 写位） | 支持（UNIX 写位） |
| 隐藏 / 系统 / 存档属性 | 支持 | **不支持**：逐条失败并给出「仅 Windows」原因（不会静默 no-op、不会假装成功） | **不支持**：同 Linux |
| 创建时间（btime）写回 | 可写（`SetFileTime`） | 只读（`statx` 能读、无 syscall 可写回），撤销时跳过并记录原因 | 标 unsupported，跳过并记录原因 |
| 系统文件类型图标 | 支持 | **不提供**（回退内置图标） | **不提供** |
| 窗口标题栏 | 自绘（`decorations:false`） | 系统原生（`tauri.linux.conf.json` 覆盖为 `decorations:true`，避免 GTK 下无边框窗口无法拖边缩放） | 系统原生（`tauri.macos.conf.json`） |
| 应用内自动更新 | 支持 | 代码已实现（AppImage 就地自替换 / deb 走 `pkexec dpkg -i`，失败回退打开下载文件），`latest.json` 已含 linux-x86_64 键 | 代码已实现（打开 dmg 由用户拖入「应用程序」），`latest.json` 已含 darwin-aarch64 键 |

上表这些差异的**单一事实来源**是 `renomio_core::platform::PlatformReport`（`examples/platform_probe.rs` 可直接打出 JSON）；CI 的 `cross-os` 矩阵在 **ubuntu / windows / macos 三个真实 OS** 上跑同一份 core 测试与 `tests/platform_contract.rs`，所以「Windows 可写 btime、Linux 只读、macOS 不支持、非 Windows 属性写入必须显式失败」这些结论都有实机断言，不是文档自说自话。

macOS 上的提权（以管理员身份重启）在代码里是 Windows-only，macOS 根本不触发；Linux 侧同理。



## 卸载

- **NSIS 安装的**：设置 → 应用 → 已安装的应用 → `Renomio` → 卸载；或运行安装目录下的 `uninstall.exe`。
- **MSI 安装的**：设置 → 应用 → 已安装的应用 → `Renomio` → 卸载；或 `msiexec /x <ProductCode>`（ProductCode 可在该应用属性页或注册表 `Uninstall` 项中查到）。
- 卸载程序**只移除程序文件、快捷方式与 ARP 项**，不会自动删除 `%APPDATA%\app.renomio.desktop`（配置、撤销历史、迁移备份）。需要彻底清理时再手动删除该目录。
- 卸载**旧版 Rename Studio** 时不要勾选「删除应用数据」，否则新版无法导入配置与撤销历史（见上）。
- **Linux（deb）**：`sudo apt remove renomio`。**Linux（AppImage）/ macOS**：直接删除 AppImage 文件，或把 `/Applications/Renomio.app` 移到废纸篓。

## 仓库结构

```
.github/workflows/    CI（frontend / backend / bundle-checks / bundle-linux / bundle-macos）
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
npm run tauri build    # Windows：产出 NSIS + MSI 到 src-tauri/target/release/bundle/
                       # Linux：产出 deb + AppImage；macOS：产出 app + dmg（由 tauri.<platform>.conf.json 覆盖 targets）
```

macOS 无证书时用 `./app/scripts/sign/build-macos.sh`：构建后自动 ad-hoc 签名（`codesign -s -`）并重打 dmg，不公证。

## 持续集成

[.github/workflows/ci.yml](.github/workflows/ci.yml) 七个 job，push 到 `main`、PR 或手动 `workflow_dispatch` 时触发：

| job | runner | 内容 |
| --- | --- | --- |
| `version` | ubuntu | 版本规则反例自测（16 条）+ VERSION/清单/tag 一致性 |
| `frontend` | ubuntu | `npm ci` → `tsc --noEmit` → `vite build` |
| `backend` | ubuntu | 安装 Tauri v2 Linux 依赖 → `cargo fmt --check`（阻断）→ `cargo clippy`（只暴露警告，不加 `-D warnings`）→ `cargo test`（renomio-core + Tauri 壳，含 `migrate.rs` 迁移单测） |
| `bundle-checks` | windows | 离线组 13 条（读配置，每次都跑）+ 产物组 14 条（有构建产物时才跑） |
| `bundle-linux` | ubuntu | 真实 `tauri build` 产出 `.deb` + `.AppImage` 与 updater `.sig`，并在 Xvfb + openbox 下启动 AppImage 做冒烟，产物上传为 artifact |
| `bundle-macos` | macos-latest | 真实 `tauri build` 产出 `.app` + `.dmg`，ad-hoc 签名后重打 dmg 并对最终 dmg 重新生成 updater `.sig`，`codesign --verify` 校验，产物上传为 artifact |
| `bundle-windows` | windows | 真实 `tauri build` 产出 `.msi` + `-setup.exe` 与 updater `.sig`，产物上传为 artifact |

`bundle-linux` / `bundle-macos` / `bundle-windows` **不写 Release、不改 `latest.json`**，只提供带 updater 签名的可下载 artifact。

`bundle-checks` 分两组断言（`scripts/check-bundle.ps1`）：

- **离线组 13 条**：只读 `tauri.conf.json` / `tauri.linux.conf.json` / `tauri.macos.conf.json` / `installer-hooks.nsh` 判定 productName、identifier、version、Windows `bundle.targets`（nsis+msi）、Linux targets（deb+appimage）、macOS targets（app+dmg）、NSIS `installMode=both`、旧版检测与中止逻辑。CI **每次都真实执行**（`-Offline`），任一不成立即红。
- **产物组 14 条**：读 MSI、NSIS 安装包与 WiX/NSIS 生成的脚本，**必须 `npm run tauri build` 后才有**。CI 不构建 Windows 安装包（托管 runner 上完整打包约 8–12 分钟，还要下载 NSIS/WiX 工具链，且安装包尚未签名），所以无产物时该组会**显式跳过，并在 Job Summary 列出跳过原因与逐条依赖**，不把跳过伪装成通过。发布前的产物合规仍由本地 `npm run test:bundle` 逐条执行。

两组的边界：**每次 push 真实执行的是 13 条离线断言**（结果在 `bundle-checks` 日志里，任一失败即红）；**14 条产物断言只读构建产物**，CI 未构建时不执行，二者互不重叠、也不互相代替。因此「CI 绿」只能证明配置层面的 13 条成立，**不能**证明安装包的 14 条成立。

## 许可

本项目以 **MIT** 许可发布，全文见 [LICENSE](LICENSE)。

**覆盖范围**：根目录的 `LICENSE` 覆盖 `app/`、`app/packages/foundation` 等**全部子目录**，因此不再单独放 `app/LICENSE`（避免出现两份内容不同的许可文件）。**Release 中分发的安装包（MSI / NSIS）适用同一 MIT 许可**，其内嵌的本项目代码与本仓库源码同源。

第三方依赖的许可证、版权声明与 NOTICE 要求见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)：运行时依赖与构建期依赖分组列出；含 Apache-2.0 的包单列并说明 NOTICE 保留要求（本轮扫描未发现需要随分发保留的独立 NOTICE 文件）；MIT / BSD / ISC 依赖给出合并版权清单（逐包原文）；双许可与字段缺失一律按原始字段记录，未自行取舍；弱 copyleft（MPL-2.0）单列并标注待确认。Windows 的 WebView2 由系统提供，不随安装包分发。

**商标**：MIT 许可授予复制、修改、分发、再许可与销售等权利，但**不授予 Renomio 名称与图标的使用权**——名称与图标不随 MIT 许可一并授权，衍生分发不得暗示官方背书。


