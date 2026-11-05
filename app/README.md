# Renomio

MIT License — 见仓库根目录的 [LICENSE](../LICENSE)

跨平台（Windows / macOS / Linux）批量文件更名工具，重构自《菲菲更名宝贝》。**本版由 Rename Studio 改名为 Renomio**（不是原地升级，迁移方式见「改名与旧版迁移」）。内部 crate 名 `ffrn-core`、Cargo/npm 包名 `rename-studio`、本地设置键 `rename-studio.settings`、方案文件 `rename-studio.plan` 均保留不变。

本版聚焦 **P0：可预览、可撤销、不丢文件的安全更名流程**，并落地 **P1 第一梯队**（只读元数据、方案导入导出、CSV 导出、列设置）、**P1 第二梯队**（时间修改、只读/隐藏属性、归类移动）、**权限体验与边界用例**、**五语言界面**。

- 前端：React 19 + TypeScript + Vite 7
- 桌面壳：Tauri 2（Rust）
- 核心：`src-tauri/ffrn-core`（无 Tauri 依赖，可单独 `cargo test`）
- 基础层：`packages/foundation`（workspace 包，供后续“格式工厂”等复用）

## 现在能做什么（P0）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 添加文件 / 文件夹 | ✅ | 系统对话框 + 拖放；递归扫描、跳过符号链接、深度上限 64、去重 |
| 包含隐藏文件 | ✅ | 默认开启；关闭后 Windows 隐藏属性文件与以 `.` 开头的文件都不进入列表，也不递归隐藏目录 |
| 通配符过滤 | ✅ | 保留 / 排除，`*` `?` 语义与 Rust 后端一致；随扫描生效 |
| 规则链 | ✅ | 添加、替换、删除、自动编号、移动字符、大小写、扩展名；可拖拽排序、逐条启停 |
| 实时预览 | ✅ | 原名 / 新名差异分段；编号、大小写、随机大小写均稳定可复现 |
| 冲突检测 | ✅ | 批次内重名 + 磁盘已存在（去抖查询）；大小写敏感度按平台 |
| 冲突策略 | ✅ | 跳过（默认）/ 自动后缀 `name (1).ext` / 覆盖（先备份目标） |
| 执行 | ✅ | 先写临时名，两阶段落到目标；支持交换、环形、仅大小写改名 |
| 批次执行进度 | ✅ | 执行期间显示「已处理/总数 · 当前文件名」，分「阶段 A 移至临时名 / 阶段 B 落到目标」两段推进，可点「取消」；取消只在条目边界生效，未落位的条目自动回退原名，已完成条目保留，批次状态记为「已取消」 |
| 撤销 | ✅ | 两阶段回退；批次日志持久化，**重启后仍可撤销**；撤销前核对磁盘现状，目标被外部移动/删除、备份丢失、批次已撤销等情况会在面板中标明原因 |
| 常见警告 | ✅ | 非法字符、Windows 保留名、结尾空格/点、超长路径、只读、重名 |
| 明暗主题 | ✅ | 令牌化，跟随设置；`?theme=dark` 可强制预览深色 |
| 撤销历史面板 | ✅ | 「操作记录」展示每批时间、类型、条目数、成功/跳过/失败、是否可撤销与原因；支持逐批撤销与「撤销到此」多级回退 |
| 操作记录 / 设置 | ✅ | 环境信息、冲突策略、只读跳过、Windows 安全字符集开关 |

## P1 第一梯队（已实现）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 只读元数据展示 | ✅ | 行内「元数据」按钮；图片尺寸 + EXIF 摘要（相机/时间/方向/ISO/快门/光圈/焦距/镜头）、音乐 ID3 关键字段、PDF / DOCX 标题作者等；面板只读，明确标注不修改文件 |
| 方案（规则链）导入导出 | ✅ | JSON 带 `schema` / `version` / FNV-1a 校验；导入时校验版本与规则，高版本或不兼容会明确报错并禁用导入；替换现有规则前提示冲突 |
| CSV 导出 | ✅ | 当前列表的原名、新名、状态、错误原因；RFC 4180 转义 + BOM，Excel 直接打开不乱码 |
| 列设置 | ✅ | 显示 / 隐藏列（至少保留一列）、拖动表头调列宽，均持久化到本地设置 |

写入类文件操作沿用既有安全机制：导出/方案保存走「同目录临时文件 → `sync_all` → 目标已存在则先备份 → 两阶段改名」。

## P1 第二梯队（已实现）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 时间修改 | ✅ | 批量平移（秒/分/时/天，可为负）或设为固定值；访问 / 修改 / 创建时间可分别勾选。预览逐行显示「原值 → 新值」；先写批次日志并 fsync，再逐条写入；单条失败（只读、被占用、权限不足、平台不支持创建时间）逐条给出原因，不影响其它条目；可撤销 |
| 文件属性 | ✅ | 只读 / 隐藏批量「保持 / 设置 / 清除」，预览「原值 → 新值」。隐藏属性仅 Windows；只读或隐藏写失败逐条标注；可撤销 |
| 归类移动 | ✅ | 按扩展名 / 修改日期（年、年月、年月日）/ 首字母 / 正则捕获组移动到子目录；可保持原相对目录结构；目标目录不存在时自动创建并记录（撤销时清理空目录）；移动不覆盖同名文件；跨盘走「复制 → 逐字节校验 → 删除源」，任一步失败回滚并保留源；整批可撤销 |
| 批次与撤销扩展 | ✅ | 批次日志新增 `kind` 与通用 `ops` 记录（旧批次 JSON 缺省按 rename 处理，保持兼容）；`undo_batch` 按批次类型分派，时间 / 属性 / 移动同样持久化、重启后可撤销 |

时间与属性写入不复制整份文件，失败粒度是「单条」；移动跨盘时会先在同目录生成临时副本，校验通过后才落位并删除源。

**EXIF 拍摄时间写入：评估后暂不实现。** 现有 `metadata.rs` 只解析 EXIF / ID3 / PDF / DOCX 的只读字段，不包含写入器。JPEG 的 `DateTimeOriginal` 位于 APP1 的 TIFF IFD 中，改写需要同步修正 IFD 指针、缩略图偏移与长度，且部分文件带多段 APP 标记；当前依赖里没有经过验证的 EXIF 写入库，强行实现有损坏原图的风险。因此本版「时间属性」只改文件系统的访问/修改/创建时间，EXIF 保持只读；若要写入，建议单独引入成熟库，并强制走「先备份原图 → 写入 → 校验 → 可撤销」路径。

## 性能（10,000 个文件的真实测量）

压测语料：100 个多级目录 × 100 个文件，混合扩展名（jpg/png/mp3/pdf/txt/docx），含中文名与超长名；生成在系统临时目录，测完整体删除，不写用户目录。

| 环节 | 测量层 | 耗时 |
| --- | --- | --- |
| 扫描 10,000 个文件 | Rust release，真实磁盘 | **956 ms** |
| 磁盘冲突探测（10,000 个目标路径） | Rust release，真实磁盘 | **315 ms** |
| 规则应用 + 预览计算（5 条规则） | 真实 `preview.ts`，Node V8 | **79 ms**（5 次采样均值，p50 78.8 ms） |
| 应用执行（10,000 次两阶段改名） | Rust release，真实磁盘 | 31,119 ms（约 3.1 ms/文件，磁盘 I/O 主导） |
| 撤销执行（10,000 条回退） | Rust release，真实磁盘 | 24,978 ms |
| 前端首屏（扫描 + 预览 + 首屏渲染） | 无头 Edge，真实前端产物 | 4,931 ms → **171–260 ms**（三次实测） |
| 切换一条规则后的预览重算 | 无头 Edge，真实前端产物 | 1,615 ms → **115–124 ms** |
| 首屏实际 DOM 行数 | 无头 Edge，真实前端产物 | 10,011 → **20** |

结论：**预览引擎本身达标**（10k 文件约 79 ms，交互级）；瓶颈在「10k 行全量 DOM 渲染」，而不是规则计算。优化方式是表内虚拟滚动（行数 > 200 时启用，固定 43px 行高、sticky 表头、视窗外多渲染 8 行），小列表仍全量渲染以保持原有行为。优化前后为同一轮无头 E2E 的实测数据。

> 说明：首轮基线曾报 28.8 s，其中约 24 s 来自 mock 后端 `scan_paths` 的 O(n²) 路径查找（测试脚手架问题，非应用耗时）。将 mock 改为路径索引后，基线为 4,931 ms，再启用虚拟滚动降到 171–260 ms（同一脚本三次运行，差异来自系统负载与磁盘缓存）。真实 Rust 扫描为 956 ms。

### 启动耗时（无可见窗口测量）

方法：`scripts/measure-startup.ps1` 用 `CreateDesktop` 创建独立隐藏桌面，再以 `STARTUPINFO.lpDesktop` 启动**从新 MSI 静默解包出的 `renomio.exe`**（即安装包内的同一文件）；进程内 `main` 入口、Tauri `setup`、`show()` 与前端 `performance.now()` 标记统一写入 `%APPDATA%\app.renomio.desktop\logs\startup.log`（TSV，含 epoch 毫秒与相对进程起点的 elapsed）。测量期间不会在当前桌面创建窗口，也不会抢焦点。冷启动在进程启动前删除 WebView2 用户数据目录（脚本记录 `profileAtLaunch=absent` 作为佐证），热启动复用。

同机冷启动 / 热启动各 3 次；单位 ms：

| 轮次 | 进程启动 → 导航开始 | 进程启动 → `show()` | `show()` → 首屏可交互 | 进程启动 → 可交互 |
| --- | --- | --- | --- | --- |
| 冷 1 | 497 | 648 | ≈0（应用已先就绪） | 626 |
| 冷 2 | 520 | 689 | 3 | 692 |
| 冷 3 | 522 | 684 | ≈0 | 660 |
| 热 1 | 546 | 696 | 3 | 699 |
| 热 2 | 577 | 790 | 7 | 797 |
| 热 3 | 467 | 722 | ≈0 | 572 |

- 冷启动：`show()` 中位数 **684 ms**、最大值 **689 ms**；到可交互中位数 660 ms、最大值 692 ms。
- 热启动：`show()` 中位数 **722 ms**、最大值 **790 ms**；到可交互中位数 699 ms、最大值 797 ms。
- 冷/热差异在本轮测量中 **不显著**（0–40 ms，小于轮次间波动）。`profileAtLaunch` 证实冷启动确实在无用户数据目录的状态下启动，本机首次创建该目录未带来此前假设的数百毫秒；上一轮 1.0–1.3 s 的样本是在构建/解包后立即采集，受系统负载与文件缓存影响，不作为对比基线。
- 分段（热 3 样本）：`main` 入口 → WebView2 导航开始 **468 ms**（Tauri/Wry 与 WebView2 环境初始化）；导航 → `DOMContentLoaded` **82 ms**（内嵌资源加载 + 370 KB 主包解析执行）；React 首次 commit **555 ms**；首次 commit 后双 rAF 上报 **581 ms**；Rust `show()` 返回 **723 ms**；可交互标记 **573 ms**（早于 `show()`，窗口出现时内容已渲染，无空白帧）。
- **应用自身 `setup` 只占 2–3 ms**（`Core::new` 仅记录数据目录）。启动期没有同步读配置、枚举目录、加载方案、检查更新或读钥匙串；批次历史改为打开「操作记录」面板时按需加载；StrictMode 的重复 `init` 也已去除。
- 启动白屏（先出空白窗再出界面）：窗口以 `visible: false` 创建，创建时即带 `backgroundColor`；`index.html` 在样式表与 React 之前内联 `html/body` 底色并按本地设置提前定主题；前端等 React 首次 commit 后再过两帧，才通过 `startup_report` 让 Rust 调 `show()`，另备 500 ms（前端）与 5 s（Rust）兜底。本机 6 轮测量全部由 `reveal_raf` 显窗，两处兜底均未触发。
- 启动耗时主体在 Tauri/WebView2 初始化与页面加载，不在业务代码或磁盘枚举。

> 分层说明：`window_show` 由 Rust 侧 `show()` 返回后记录；隐藏桌面上 Chromium 不产出 `first-paint` 计时条目，因此「首帧绘制」用 React 首次 commit 事件 + 双 `requestAnimationFrame` 的 `reveal_raf` 作为代理，未用像素截图验证。`show()` 在隐藏桌面上返回耗时（上报→返回约 140 ms）可能比真实桌面慢，且真实桌面的合成延迟（约 1 帧）需真机确认。

## 九类列表页签（已实现）

主列表顶部固定 9 个页签，不再有 `P1` 空壳；每类都是真实可用的只读视图（归类页签可直接打开移动面板）：

| 页签 | 实际内容 | 数据来源 / 边界 |
| --- | --- | --- |
| 更名列表 | 原名 / 新名 / 状态 / 错误 | 现有预览引擎 |
| 属性列表 | 名称、类型、只读、隐藏、创建 / 修改 / 访问时间、大小、位置 | `read_times` + `read_attrs`；创建时间与隐藏属性在非 Windows 上显示「暂不支持」 |
| 音乐标签 | 标题、艺术家、专辑、年份、音轨、流派、采样率、时长、码率 | `read_metadata_batch` 的 ID3 / FLAC 解析 |
| 照片信息 | 尺寸、拍摄时间、相机品牌 / 型号、方向、ISO、快门、光圈、焦距、镜头 | EXIF 只读；**拍摄时间暂不支持写入**，面板顶部已标注 |
| 图像信息 | 尺寸、标题、作者、版权、软件、备注 | 仅 EXIF 摘要 / PNG 文本块；**IPTC / XMP 读取与写入暂不支持**，面板顶部明确标注 |
| Office 属性 | 标题、主题、作者、最后修改者、修订号、创建 / 修改时间、页数、字数、生成应用 | DOCX `docProps`；旧版二进制 `.doc/.xls/.ppt` 与加密文档逐行标注读取失败 |
| PDF 属性 | 标题、作者、主题、创建工具、生成器、创建时间、页数（粗略） | PDF 信息字典；不做全文解析 |
| 文本编码 | 编码、行数、字符数、内容摘要 | 识别 BOM / UTF-8；非 UTF-8（GBK/ANSI）明确标注「未识别」，不做自动猜测 |
| 归类 | 当前位置、归类目标目录、依据、状态 | 按扩展名生成移动预览；按钮直接打开归类移动面板（目标目录自动创建、可撤销） |

批量读取走新命令 `read_metadata_batch`：单条失败只影响该行，不中断整页。

左侧导航同样不再留假入口：

- 「高级规则」插入一条默认勾选正则的替换规则（JS 正则、`$1` 反向引用）；
- 「扩展名」插入扩展名规则；
- 「特定文件类型」跳到照片页签并提示可切换的类型页签；
- 音乐 / 图片 / Office / PDF / 文本编码直接切换到对应页签；
- 「方案与快照」打开方案导出对话框；**快照暂不支持**，界面与文档均如实标注。

## 明确的未实现项（不提供假入口）

- 快照（基础层预留接口，当前 backend 为 `unsupported`）；
- 自动更新（同上，当前不提供检查/下载按钮）；
- EXIF / IPTC / XMP 写入（只读展示，UI 已标注「暂不支持」）。

## 三条文件安全底线

1. **默认只预览**：工具栏“应用更名”先打开确认对话框；只有“确认执行”才写磁盘。
2. **冲突绝不静默覆盖**：默认 `skip`；`overwrite` 也必须显式选择，且目标先移入备份目录。
3. **临时文件 + 原子替换**：所有源先移到唯一临时名，再落到目标；日志 fsync 后才开始改名。
4. 撤销同样两阶段，专门处理**仅大小写**改名（大小写不敏感文件系统需要两段式）。
5. 批次日志落在应用数据目录，进程重启后仍可撤销；未完成的批次在启动后可见并可恢复。

## 窗口 API 权限（自定义标题栏）

标题栏是自绘的（`decorations: false`），最小化 / 最大化 / 关闭按钮调用 `getCurrentWindow().minimize() / toggleMaximize() / close()`。这些命令受 Tauri 2 ACL 管控，**`core:window:default` 不包含写操作权限**：缺少声明时调用会被拒绝，表现为「点了没反应」。

`src-tauri/capabilities/default.json` 必须显式声明：

```json
"permissions": [
  "core:default",
  "dialog:default",
  "core:window:allow-close",
  "core:window:allow-minimize",
  "core:window:allow-toggle-maximize",
  "core:window:allow-start-dragging"
]
```

新增任何窗口写操作（`setTitle`、`setAlwaysOnTop`、`setSize` 等）时，要同步加对应的 `core:window:allow-*`，否则同样静默失败。前端也做了兜底：按钮调用失败会弹错误提示并写 `console.error`，不再吞异常。

## 快速开始

环境要求：

- Node.js ≥ 20（本机验证于 Node 26）
- Rust ≥ 1.77（本机 1.99.1）+ Cargo
- Windows：WebView2 Runtime、VS Build Tools（C++ 桌面开发）
- macOS：Xcode Command Line Tools

```powershell
cd app
npm install
npm run dev          # 浏览器演示模式（不读写磁盘）
npm run tauri dev    # 真实桌面应用
npm run build        # tsc --noEmit + vite build
npm run test:core    # ffrn-core 测试：单测 + 真实文件系统回归（47 项）
npm run test:e2e     # 无头浏览器 E2E（mock 后端，不启动 GUI 窗口）
npm run test:bundle  # 打包合规检查：读实际 MSI 数据库 + 生成脚本，13 条断言（不弹 UAC）
```

发布构建与签名见 [../docs/签名与打包流程.md](../docs/签名与打包流程.md)。

## 样本库与验证

```powershell
# 生成可重复样本库（中文、emoji、0 字节、只读、冲突候选、深层嵌套、>260 超长路径）
npm run test:corpus

# 独占句柄锁定样本，验证“被占用文件”不会丢数据
powershell -ExecutionPolicy Bypass -File scripts/hold-lock.ps1 -Seconds 90
```

`npm run test:corpus -- --dir D:\样本 --clean` 可指定目录。生成的 `_manifest.json` 列出全部样本与用途。

真实跑过的结果见 [../docs/P0-完成度与验证说明.md](../docs/P0-完成度与验证说明.md)。

## 规则语义

按顺序执行，所有规则对“当前文件名（不含目录）”生效，扩展名规则单独作用于扩展名。

| 规则 | 语义 |
| --- | --- |
| 添加 | 直接插入文本（开头 / 扩展名前 / 第 N 个字符，可从末尾数）；或补齐到指定长度 |
| 替换 | 文本替换；可选区分大小写、正则（JS 语法）、仅第 N 处；留空即删除 |
| 删除 | 按位置区间、首尾标记之间、字符集（保留或删除）、去首尾空格 |
| 编号 | `<#>` 替换为序号；起始（默认 1，可设为 0）、步长、位数、补位字符；可按目录分组、仅统计勾选行；按扫描顺序取号 |
| 移动 | 从第 N 个字符起取 K 个，移动到指定位置（支持从末尾数） |
| 大小写 | 小写 / 大写 / 词首 / 句首 / 反转 / 随机（稳定种子） |
| 扩展名 | 大小写、替换、添加（扩展名前/后）、用序号作扩展名、删除 |

文件夹同样进入规则链；扩展名规则对文件夹无效。

**执行顺序 = 扫描顺序**：预览、编号、批次提交都按扫描载入顺序（路径升序、稳定排序）。点击列头只改变显示顺序，不会改变执行顺序；列表工具条上有对应提示。

## 语义确认结果（2026-11-04）

> 逐条的「当前实现 / 建议默认 / 改动影响 / 理由」与落地状态见 [../docs/规则语义确认清单.md](../docs/规则语义确认清单.md)。除下方标注的两条外，其余均保持现状。

1. **编号排序基准**：默认从 1 起，按列表载入顺序（扫描顺序）编号，不随表头排序变化；勾选“仅对勾选行计数”时未勾选行不消耗序号。起始值在规则编辑器可改为 0。
2. **编号表达式**：仅支持 `<#>` 占位符，未实现原版的算术/条件表达式。
3. **正则方言**：使用 JavaScript 正则（`$1` 反向引用），不是 Delphi/POSIX 语法。
4. **首尾之间删除**：找不到标记时按“无操作”处理，不报错。
5. **随机大小写**：以文件名 + 规则 ID 为种子，保证预览与执行一致；原版为不可复现随机。
6. **扩展名编号**：把 1..N 作为新扩展名（如 `.1`、`.2`），设计稿未给出更多细节。
7. **超长路径阈值**：Windows 240 告警、macOS 900、Linux 3800；硬上限 Windows 32767（`\\?\` 已绕过 260）、macOS 1024、Linux 4096；单组件 255。
8. **Windows 安全字符集**：跨平台默认开启（`strictWindowsNames`），关闭后仍受各平台自身文件系统限制。
9. **只读文件**：默认尝试改名，失败保留源文件；设置开启“只读跳过”后在预览中标黄并跳过。
10. **备份丢失**：覆盖策略的备份文件若被手动删除，撤销无法还原被覆盖的目标，日志会记录失败。
11. **隐藏文件（已落地）**：新增「包含隐藏文件」开关，默认开启；关闭后 Windows 隐藏属性文件与 `.` 开头文件都不扫描，隐藏目录也不递归。
12. **执行顺序（已明确）**：执行与编号顺序 = 扫描顺序；列头排序只影响显示，不改执行顺序。

## 跨平台差异

- 长路径：Windows 统一加 `\\?\` 前缀（UNC 转 `\\?\UNC\`），macOS/Linux 原样。
- 大小写：Windows/macOS 视为不敏感（NFC + lower 比较），Linux 敏感；启动时用探针文件实测。
- 非法字符：Windows 禁用 `< > : " | ? * / \` 与控制字符；保留名 CON/PRN/AUX/NUL/COM1-9/LPT1-9。
- 路径分隔符与名称长度：由 `ffrn-core::platform` 按平台提供，UI 不写死 `\`。
- 隐藏文件：Windows 用 `FILE_ATTRIBUTE_HIDDEN`，macOS/Linux 用前导点；两者都算隐藏，由同一个开关控制。
- 时间/属性写入：创建时间与隐藏属性仅 Windows 可写；其它平台在结果面板逐条提示「不支持」，不影响批次内其它条目。

## 目录结构

```
app/
├─ src/                     React 应用
│  ├─ components/           标题栏、工具栏、导航、文件表、规则链、对话框、抽屉
│  ├─ lib/                  规则引擎、预览、校验、bridge、格式化、通配符
│  ├─ hooks/usePreview.ts   预览缓存 + 磁盘冲突去抖
│  ├─ store.ts              zustand 状态与动作
│  └─ styles/               app.css（设计稿）+ shell.css（应用壳层）
├─ packages/foundation/     可复用基础层（tokens / i18n / settings / queue / logger / updater）
├─ src-tauri/
│  ├─ ffrn-core/            Rust 核心（扫描、校验、两阶段改名、时间/属性/移动、日志、撤销）
│  ├─ src/lib.rs            Tauri commands
│  ├─ entitlements.plist    macOS Hardened Runtime 权限
│  └─ tauri.conf.json       窗口 / 打包配置（macOS 用 tauri.macos.conf.json 恢复原生标题栏）
├─ e2e/
│  ├─ run.mjs               无头浏览器 E2E（CDP 驱动 + 断言 + 截图 + 报告）
│  ├─ mock-backend.js       注入页面的内存版 Tauri 后端
│  ├─ report.md             最近一次运行结果
│  └─ screenshots/          各流程截图
├─ scripts/
│  ├─ gen-test-corpus.mjs   真实样本库生成器
│  ├─ hold-lock.ps1         锁定文件
│  └─ sign/                 Windows / macOS 签名与打包脚本
└─ screenshots/             界面截图
```

## 基础层复用（格式工厂等）

`@rename/foundation` 提供：

- `tokens.css` / `tokens.ts`：颜色、字阶、间距、控件高度、面板宽度
- `createI18n`：词条 + 插值，内置中英文通用词条
- `SettingsStore`：版本化、迁移、损坏自愈（备份为 `*.corrupt`）
- `TaskQueue`：串行任务、进度、取消、历史
- `Logger`：环形缓冲、sink、localStorage、崩溃处理器
- `Updater`：状态机 + `UpdateBackend` 接口，默认 `unsupported`

详见 `packages/foundation/README.md`。

## 验证与截图

- 类型检查与前端构建：`npm run build` ✅（日志 `build.log` / `release.log`）
- Rust 核心测试：`npm run test:core` → 60 passed ✅（扫描/平台/整批改名/撤销现状校验/取消回滚/时间与属性/归类移动/文本编码/批量元数据等真实文件系统用例）
- 桌面壳编译与测试：`cargo test --manifest-path src-tauri/Cargo.toml` → 5 passed ✅（失败原因归类 1 + 旧数据迁移 4：正常迁移且保留旧目录 / 两目录并存不合并 / 手动导入先备份且不覆盖 / **用真实 journal 验证迁移后仍可撤销**）
- 无头浏览器 E2E：`npm run test:e2e` → 104 通过 / 0 失败 ✅（UI 88 / 配置 1 / mock 15；`PERF=1` 时另加性能断言），报告与截图见 `e2e/report.md`、`e2e/screenshots/`
- 性能压测：`cargo run --release --example perf_10k`（真实磁盘 10k）+ `node scripts/perf-preview.mjs`（真实规则引擎 10k）+ `PERF=1 npm run test:e2e`（真实前端 10k 渲染），数据见上文「性能」表；测试语料生成在系统临时目录并在结束时删除
- 窗口按钮：E2E 断言点击最小化/最大化/关闭确实调用 `plugin:window|*`，并校验 capability 声明；**真实窗口的关闭 / 最小化 / 最大化已在 Windows 真机由用户手工确认正常（2026-11-04）**。这是用户手工确认，不是脚本断言。
- 拖放：E2E 用 mock 事件链路断言「drag-enter 显示高亮遮罩 → drag-drop 调用扫描命令并新增 2 行 → 松手提示计数」，并断言规则区内部拖拽（无 `Files`）不误触发遮罩；**真实 Explorer 拖放仍需用户在真机拖一次**。
- 撤销历史面板：E2E 覆盖「执行一批 → 面板看到条目（时间/类型/条目数/成功跳过失败/策略）→ 撤销 → 条目变『已撤销』并锁定」，以及「目标文件被外部移动 → 刷新后判定不可撤销并给出原因」；真实磁盘上的同类判定由 Rust 测试 `batch_undo_status_detects_external_changes` 覆盖。
- Windows 安装包：`npm run tauri build` ✅ → NSIS + MSI 两个包（见下方「产物」）；主程序构建产物为 `renomio.exe`。**本轮 NSIS 为 `installMode: "both"`（必然提权），未执行静默安装/卸载**；MSI 用 Windows Installer COM 读取包内 `Property` 表确认 `ALLUSERS = 1`、`ProductName = Renomio`。安装范围的选择页、默认路径、快捷方式/ARP 位置均从生成的 `.nsi` / `.wxs` 静态核验（见「安装范围」）。**未验证：双击/启动后的真实窗口、需要 UAC 的安装与卸载、旧版并存拦截弹窗**（按项目约定不启动带 GUI 或会弹 UAC 的进程）。
- 打包合规检查：`npm run test:bundle` → **14/14 断言 PASS**（[scripts/check-bundle.ps1](scripts/check-bundle.ps1)，只读产物与生成脚本，不弹 UAC、不开窗口）。共 4 条产物存在 + 2 条 MSI 数据库（`ALLUSERS = 1`、`ProductName = Renomio`）+ 5 条 WiX 脚本（`InstallScope="perMachine"`、安装根 `ProgramFiles64Folder`（x64 分支）、`INSTALLDIR` 名 `Renomio`、新 `UpgradeCode`、x64 根解析）+ 3 条 NSIS 双范围（`INSTALLMODE "both"`、`MULTIUSER_PAGE_INSTALLMODE`、`MULTIUSER_USE_PROGRAMFILES64`）。任一条不成立即以非零码退出，并逐条打印不成立的断言名与期望值（已用指向缺失产物的临时副本验证退出码为 1）。
- 界面截图（无头 Edge 渲染，1440×900）：`screenshots/main-light.png`、`screenshots/main-dark.png`
- 静态设计稿入口：`../design/index.html`（主界面）、`rules.html`、`states.html`

### E2E 验证分层（如实说明）

| 层次 | 覆盖 | 说明 |
| --- | --- | --- |
| UI 层已验证 | 88 项 DOM / 可见性 / 截图断言 | 无头 Edge 加载真实 `dist` 构建产物，注入 mock Tauri 后端；覆盖添加文件、隐藏文件开关（开/关）、规则编辑与排序、列头排序不改变执行顺序、编号 `start=0`、冲突策略、应用、**批次执行进度条（已处理/总数 + 当前文件名 + 可取消，断言事件随批次推进变化）**、撤销、**撤销历史面板（批次信息 / 撤销后『已撤销』/ 不可撤销原因）**、明暗主题（含首屏浅色断言）、元数据、方案导出/导入/版本不兼容、CSV、列显隐与列宽、时间/属性/归类移动面板（预览、逐条结果、撤销）、**九类列表页签逐页渲染与关键控件**、**拖放高亮 / 松手计数 / 规则区不误触发**、1100×640@150% DPI 外层无溢出与页签条完整可读（表格内部横向滚动）、**日/西/英长文案在 125% 与 150% 缩放下无溢出**、**权限失败逐条清单 / UAC 取消后继续运行 / 提权后 UIPI 提示**、**旧版数据迁移一次性提示（关闭后不重复弹）与设置里的手动导入入口** |
| 配置层 | 1 项 | `capabilities/default.json` 必须包含 `core:window:allow-close / allow-minimize / allow-toggle-maximize / allow-start-dragging` |
| UI 触发的 mock 命令层 | 15 项 | 断言上述交互确实经过 `env_info / scan_paths / apply_plan / undo_batch / list_batches / read_metadata / read_metadata_batch / read_times / read_attrs / apply_time / apply_attrs / apply_move / write_text_atomic / plugin:dialog:* / plugin:window:* / plugin:event|listen / import_legacy_data`；包含提交顺序、隐藏扫描参数、拖放事件→扫描命令、窗口按钮命令，且 mock 状态确实被写入、撤销与「外部改动后不可撤销」 |
| 性能层（无头） | 4 项 | 10,000 条目首屏耗时、虚拟滚动生效（DOM 行数受控）、滚动到底部窗口移动、切换规则重算耗时 |
| 真实文件系统（unit 层） | 60 项 Rust 测试 | `ffrn-core` 在临时目录真实改名与写盘：两阶段、撤销、覆盖备份、同名目标防链式覆盖、取消回滚无临时残留；**撤销前磁盘现状校验（目标被外部移动 → 不可撤销）**；时间平移/固定值/逐条失败/撤销、创建时间（Windows `SetFileTime`）、只读与隐藏属性、目标目录自动创建与撤销清理、正则捕获结果落盘、跨盘复制校验失败回滚（`force_copy`）；隐藏文件开关（前导点 + Windows 隐藏属性）；文本编码（UTF-8 / BOM / 非 UTF-8 降级）与批量元数据单条失败隔离 |
| 打包产物层 | 2 个安装包 + 14 条断言 | NSIS：`installMode: "both"`，静态核验范围页/默认 `Program Files`/用户分支 `%LocalAppData%\Programs`/快捷方式与 `SHCTX` ARP（**未执行静默安装，both 必然触发 UAC**）；MSI：定位为机器级单一包，COM 读**实际包内** `ALLUSERS=1` + `ProductName=Renomio` + 生成脚本 `InstallScope="perMachine"`/`ProgramFiles64Folder`(x64)/`INSTALLDIR = Renomio`/新 `UpgradeCode`。以上由 `npm run test:bundle` 自动断言（14/14 PASS）。**安装后启动未验证**（会创建可见窗口） |
| 真机已验证（用户手工确认） | 真实窗口关闭 / 最小化 / 最大化 | 用户在 Windows 真机上于 2026-11-04 手工确认 ✕ 能退出、最小化与最大化正常；**不是自动化断言**，脚本只验证命令调用 |
| 未验证 | 安装后启动与真实窗口交互、**需要 UAC 的安装范围验收**（机器范围装到 `Program Files\Renomio`、用户范围装到 `%LocalAppData%\Programs\Renomio`、两范围交叉安装的 hook 拦截、卸载、ARP 条目 `Renomio`、快捷方式实际落点）、**旧版 Rename Studio 并存拦截弹窗**、**真实用户目录上的首次启动迁移表现与迁移后撤销历史可用性**、**提权后真实 Explorer 拖放行为**、真实 Explorer 拖放、真实物理跨盘移动（用 `force_copy` 模拟复制路径却仍在同盘）、EXIF 拍摄时间写入（未实现，属性面板只改文件系统时间）、macOS/Linux 的创建时间与隐藏属性（平台明确报「不支持」）、Tauri IPC 新命令参数序列化（`migration_info` / `import_legacy_data`）、系统文件对话框、NSIS/MSI 安装向导界面、安装包代码签名、macOS/Linux 平台差异 | 需要 GUI/有头环境、UAC 提权、多磁盘机器、签名证书或其它操作系统，按项目约定不在会话中自动执行 |

### 安装范围（Scope）

**定位**：NSIS = 安装时可选范围（默认所有用户 → `C:\Program Files\Renomio`；可选仅当前用户 → `%LocalAppData%\Programs\Renomio`）；MSI = **只有机器级一种**——所有用户、固定 `Program Files`、必须管理员，**不提供用户级安装，向导里也没有范围页**。需要用户范围就用 NSIS 包。

| 项 | NSIS（`...setup.exe`）：可选范围 | MSI（`...msi`）：机器级单一包，不提供范围选择 |
| --- | --- | --- |
| 范围可选 | **是**：向导中的「为所有用户安装 / 仅为我安装」页（生成脚本含 `MULTIUSER_PAGE_INSTALLMODE`）；静默/被动模式跳过该页，按默认范围安装 | **不提供**：Tauri CLI 2.12.4 / tauri 2.12.5 的 `WixConfig` 没有 `installMode` 字段（schema 里只有 `NsisConfig.installMode`），单包固定 `InstallScope="perMachine"`；这是定位而非「暂时没做」 |
| 默认位置 | 提权后默认「所有用户」→ `C:\Program Files\Renomio`（`MULTIUSER_INSTALLMODE_INSTDIR` + `MULTIUSER_USE_PROGRAMFILES64`） | 固定 `C:\Program Files\Renomio`（`INSTALLDIR` 挂在 `PlatformProgramFilesFolder` 下，x64 解析为 `ProgramFiles64Folder`），无其它取值 |
| 选「仅为我安装」 | `%LocalAppData%\Programs\Renomio`（NSIS `FOLDERID_UserProgramFiles`，缺失时回落 `$LOCALAPPDATA\Programs`） | **不提供**——需要用户范围请改用 NSIS 包 |
| 快捷方式 | `SetShellVarContext all/current` 下的 `$DESKTOP` / `$SMPROGRAMS`：机器范围→公共桌面 + 所有用户开始菜单；用户范围→当前用户桌面/开始菜单；卸载按同一上下文删除 | `DesktopFolder` / `ProgramMenuFolder` + `ALLUSERS=1`（perMachine 下解析为公共位置） |
| ARP / 卸载项 | `SHCTX`（NSIS 3 的 shell 上下文根）：机器范围→`HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\Renomio`；用户范围→同一路径的 `HKCU` | MSI 标准 ARP；实测包内 `Property` 表 `ALLUSERS = 1`（HKLM） |
| 提权 | `MULTIUSER_EXECUTIONLEVEL Highest` → `RequestExecutionLevel highest`：**两个选项都先弹 UAC**（Tauri schema 明说 both 模式即使用户选当前用户也需要管理员）。取消 UAC 时安装器不会启动，也就不会回退到用户目录 | **必然管理员**：perMachine MSI 必弹 UAC；取消 UAC 即安装失败，不会退化为用户级安装 |
| 换范围 / 重装 | 默认沿用上次范围（`${UNINSTKEY}` 里的 `CurrentUser` 值）；若在范围页改成相反范围，[installer-hooks.nsh](src-tauri/installer-hooks.nsh) 会读取相反 hive 的卸载项，提示具体卸载命令后**中止**（先 `RMDir` 空目录，不留半装） | 无范围可切换；重复安装只做升级/修复，永远落在 `Program Files\Renomio` |

**MSI 的定位（正式）**：只做机器级——所有用户 / `C:\Program Files\Renomio` / 必须管理员。同一 `UpgradeCode` 下混用 perMachine 与 perUser 会让升级与卸载互相干扰，为「看起来都能选」再拆出一个 perUser 的 MSI 变体更容易装不干净，因此 MSI **不提供用户级安装**；范围选择统一由 NSIS 提供。该定位不是文档承诺，而是由 `npm run test:bundle` 对**实际产物**断言（真实 `.msi` 的 `ALLUSERS=1` + 生成脚本的 `InstallScope="perMachine"` / `ProgramFiles64Folder`(x64) / `INSTALLDIR` 名 / 新 `UpgradeCode`），配置一旦被改回或改错，检查会失败退出。

跨安装器：NSIS 会识别已安装的 WiX/MSI 版本并在安装前卸载（模板内置 `FindWixInstall` → `PageReinstall`），所以「先 MSI 后 NSIS」是干净的；**MSI 不识别 NSIS 版**，装 MSI 前请先卸载 NSIS 版，否则会留下两条 ARP 与两个同名快捷方式（程序目录相同，卸载可能互删）。这一点**未做自动拦截**。此外 [installer-hooks.nsh](src-tauri/installer-hooks.nsh) 在写文件前按「旧显示名 `Rename Studio`」与「旧 UpgradeCode `B9847038-…`（注册表倒序打包形式）」两条判据检测旧版，命中即提示卸载命令并中止，避免新旧两个应用并存。

数据目录：每用户的 `%APPDATA%\app.renomio.desktop`（Tauri `app_data_dir`，随 identifier 变化），不随安装目录走；**切换安装范围不会迁移配置、日志与撤销历史**（同一用户的同一数据目录，两者共享）。自动更新通道未做。

## 产物

| 安装包 | 路径 | 大小 | SHA-256 |
| --- | --- | --- | --- |
| NSIS | `src-tauri/target/release/bundle/nsis/Renomio_0.1.0_x64-setup.exe` | 1,469,033 字节（1.40 MiB） | `648C0A421196894B8E3768847D2AE2C79A055B52C707A7426DC81695A5B6D8CB` |
| MSI | `src-tauri/target/release/bundle/msi/Renomio_0.1.0_x64_en-US.msi` | 2,101,248 字节（2.00 MiB） | `37545D29D35210262635E56E4101A522733F16B8E04FA503DC35E9D4AB2793CD` |

两包均未签名。`bundle.targets` 已显式设为 `["nsis", "msi"]`，`npm run tauri build` 一次产出两个包。安装范围：NSIS 安装时可选、默认所有用户（`Program Files\Renomio`）；MSI 只有机器级一种（固定 `Program Files\Renomio`、必须管理员、不提供用户级）。**本轮为合并包**：包含阶段 A（权限体验）、B（边界用例 / 撤销持久 / dry-run / 模板规则）、C（五语言）与 E（改名与迁移）的全部改动。主程序为 `renomio.exe`，由 `[[bin]] name = "renomio"` 产出。以上定位由 `npm run test:bundle`（14/14 断言）对实际产物把关。安装/卸载校验只做了不需要 UAC 的部分（MSI 数据库只读查询、生成脚本静态断言），不启动 GUI；「装到 `Program Files`、卸载、ARP、快捷方式落点、两范围交叉安装、旧版并存拦截」均需 UAC，尚未验证。

## 权限体验（Windows）

- **UIPI 冲突结论（实测依据）**：进程提权后，资源管理器仍以 medium 完整性级别运行，它发往高完整性级别窗口的拖放/剪贴板消息会被 UIPI 拦截，**拖放必然失效**；微软官方文档明确不推荐用 `ChangeWindowMessageFilterEx` 放行拖放消息。因此本版**不静默牺牲拖放**：提权时顶部给出常驻可见提示（说明拖放不可用及原因），并保留「添加文件 / 添加文件夹」等价入口（系统文件对话框不受 UIPI 影响）。该结论来自 Windows UIPI 机制与微软文档，未在真机提权后实测拖放（见「需要用户授权才能验证」）。
- **失败原因分类**：执行结果按 `access-denied`（ACL/权限拒绝）、`in-use`（被其他进程占用）、`not-found`（路径不存在）、`readonly`（只读属性）、`conflict`（目标同名）、`path-too-long`、`invalid-name` 归一，逐条给出对应文案；批量任务展示逐条清单与按原因汇总，不再整批一个「失败」。
- **可操作提醒**：失败清单提供「以管理员身份重启」与每条「跳过该项」；安装目录位于 `Program Files` 或检测到写入被拒时，提示里直接说明原因与可选动作。
- **设置开关**：`设置 → 权限 → 始终以管理员身份运行`（默认关闭，持久化）。开启且当前未提权时通过 `ShellExecuteW(runas)` 重建进程；UAC 取消返回 `Ok(false)`，应用**继续以普通权限运行并给出提示**，不会循环弹 UAC。

## 边界用例（阶段 B）

| 用例 | 改前 | 改后 |
| --- | --- | --- |
| 目标同名冲突（Windows 大小写不敏感） | 仅按原样比较，`A.txt` 与 `a.txt` 在 Windows 上被视为不同目标 | 按平台大小写敏感度判定；Windows 上同名不同大小写也判冲突，按策略跳过/加后缀/覆盖 |
| 仅改大小写（`a.txt` → `A.txt`） | 直接改名可能被判为「目标已存在」或静默失败 | 走两次改名（临时名 → 目标名），并在预检中标记为「仅大小写」；撤销同样走临时名 |
| 超长路径 > 260 | 直接在 Win32 API 上报错 | 检测长度并在预览/警告中标注；可用时加 `\\?\` 长路径前缀，超平台上限单独归类为 `path-too-long` |
| 符号链接 / 硬链接 / 目录联接 | 递归扫描可能跟随链接造成重复或越界 | 扫描跳过符号链接与目录联接；硬链接按普通文件处理（改名只影响目录项），不递归穿透 |
| 网络盘 / 只读目录 / 只读文件 | 统一报「失败」 | 分别归类（不可写/拒绝访问/只读属性），逐条给出对应文案；只读文件可在属性面板清除只读后再改名 |
| 文件被其他进程占用（Word / 播放器） | 报通用 IO 错误 | 归类为 `in-use`，文案说明「被其他进程占用，请关闭后重试」 |
| 跨盘移动 | 直接 `rename` 失败 | 复制到目标盘临时文件 → 逐字节校验 → 删除源；任一步失败回滚并保留源，整批可撤销 |
| 撤销跨重启 | 仅进程内可撤 | 批次 journal 落盘并 fsync，重启/崩溃/异常退出后仍可撤销；撤销前核对磁盘现状，目标被外部移动/删除、备份丢失、批次已撤销会标明不可撤销原因 |

撤销边界：**可撤**——本应用写入且磁盘现状与 journal 一致、备份仍存在的批次（改名/时间/属性/移动）；**不可撤**——目标被外部改动或删除、备份丢失、批次已撤销、`pending` 未完成批次、跨版本数据目录未迁移且未手动导入的旧 journal。撤销历史随数据目录长期保留，未做自动清理。

## 预览、模板与规则

- **dry-run 预览**：执行前列出「原文件名 → 新文件名」，标红冲突 / 非法字符 / 超长路径，显示总数、可执行数与冲突数，可导出 CSV（含汇总行）；这是防误操作的核心入口。
- **模板与规则**：序号补零、大小写转换、正则查找替换、按 EXIF（拍摄时间/相机型号）与音频标签（标题/艺术家/专辑/轨道号）取字段；非法字符替换规则可配置并在预览中体现。

## 多语言（阶段 C）

- 支持 **简体中文、繁体中文、English、日本語、Español**；默认跟随系统语言，无法匹配回落简体中文；设置里可手动切换，**即时生效**（`useSyncExternalStore` 重渲染，无需重启）。
- 全部界面字符串集中在 `src/locales/*.ts`，产品名通过 `PRODUCT_NAME` 常量与 `{product}` 占位注入，不在组件里硬编码。
- **译文质量如实标注**：繁中 / 日 / 西由本工具产出，**未经母语审校**（各语言文件头与设置页均有说明）。
- 术语五语一致：模板 template / 模板，撤销 undo / 復原 / undo / 元に戻す / deshacer，冲突 conflict / 衝突 / conflict / 競合 / conflicto，标签 tag / 標籤 / tag / タグ / etiqueta，元数据 metadata / 中繼資料 / metadata / メタデータ / metadatos。
- 溢出度量用日/西/英长文案在 125% 与 150% 缩放重跑：`scrollWidth ≤ innerWidth`，按钮、表头、侧栏、操作条均无截断（E2E 断言）。

## 改名与旧版迁移（阶段 E）

### 旧 → 新 落点

| 项 | 旧（Rename Studio） | 新（Renomio） |
| --- | --- | --- |
| 产品名 / 窗口标题 / 关于页 / 通知 | `Rename Studio`、`更名工坊 · Rename Studio` | `Renomio` |
| 可执行文件 | `rename-studio.exe` | `renomio.exe` |
| identifier | `com.rename.studio` | `app.renomio.desktop` |
| 数据目录 | `%APPDATA%\com.rename.studio` | `%APPDATA%\app.renomio.desktop` |
| 机器级安装目录 | `C:\Program Files\Rename Studio` | `C:\Program Files\Renomio` |
| 用户级安装目录 | `%LocalAppData%\Programs\Rename Studio` | `%LocalAppData%\Programs\Renomio` |
| 快捷方式 / ARP 显示名 | `Rename Studio` | `Renomio` |
| MSI UpgradeCode | `B9847038-2BB9-5D76-A6A3-07C35C086342` | `3C7B1E4A-9F62-4D8B-A5E1-6D2C8F4B7A09` |

**不是原地升级**：新版 identifier 与 UpgradeCode 均已变更，安装器会先检测旧版（旧显示名 + 旧 UpgradeCode 双判据），命中后提示「请先卸载 Rename Studio」并给出卸载命令，然后中止。**卸载旧版时不要勾选删除应用数据**，否则新版无法导入配置与撤销历史。

### 数据迁移（首次启动，Rust `src/migrate.rs`）

1. 条件：新目录 `%APPDATA%\app.renomio.desktop` 不存在，旧目录 `%APPDATA%\com.rename.studio` 存在。
2. 步骤：复制到同卷临时目录 `.renomio-migrate-<pid>-<ts>` → 校验文件数与字节数 → 原子 `rename` 落位 → 写 `migration.json`（来源目录、来源产品、时间、文件数、字节数）并在 `logs/migration.log` 追加一条记录。
3. 失败：清掉临时目录，**旧目录保持不变**，新目录不出现半套数据；界面给出一次性失败提示与手动导入入口。
4. 旧目录**绝不删除**（至少保留一个版本周期，目前不提供自动清理）。
5. 两目录并存：不合并、不覆盖，保留新目录；`设置 → 旧版数据 → 从旧版导入数据` 手动入口，导入前把当前数据目录整份复制到 `import-backup-<ts>`，只补充旧目录独有的文件（已有文件跳过）。
6. 撤销历史随 `batches/` 与 `backups/` 一起复制，`journal` 中记录的是绝对路径，因此**迁移后仍可撤销**（Rust 测试 `migrated_journal_still_undoes` 用真实 `Core` 生成 journal → 迁移 → 在新目录撤销成功；真机用户目录上的迁移表现见待授权清单）。

### 旧名残留白名单（大小写不敏感检索后的结论）

| 位置 | 保留原因 |
| --- | --- |
| `src-tauri/Cargo.toml` / `Cargo.lock` 的包名 `rename-studio`、lib 名 `rename_studio_lib` | 内部 crate 名，不影响用户可见名称；改包名会连带改动构建脚本与 IPC 符号 |
| `package.json` / `package-lock.json` 的 `name: "rename-studio"` | npm 内部包名，不进入安装包界面 |
| `rename-studio.settings` / `rename-studio.logs`（`src/runtime.ts`、`index.html`、foundation 示例） | 既有本地存储键；改名后继续沿用可让**升级用户保留设置**，不迁移 WebView localStorage |
| `rename-studio.plan`（`src/lib/plan.ts`） | 方案文件格式标识；沿用旧值使旧方案文件仍可导入 |
| `e2e/mock-backend.js`、`src-tauri/src/lib.rs`、`migrate.rs`、五个 locale 文件、`bridge.ts` 中的 `Rename Studio` / `com.rename.studio` | 迁移与旧版检测必须引用旧名/旧标识（提示文案「已导入上一版本（Rename Studio）的数据」按需求保留） |
| README / foundation README 中的「原 Rename Studio」 | 说明改名历史 |
| `*.log`、`e2e/report.*` 等生成物 | 历史构建/测试输出，不是产品界面字符串 |

界面可见处已无旧品牌：前端源码中 `Renomio` 只出现在 `src/lib/branding.ts` 一处常量，其余全部通过 `{product}` 占位引用；`tauri.conf.json`、NSIS 生成脚本（`PRODUCTNAME "Renomio"`、`UNINSTKEY ...\Renomio`）、WiX（`Shortcut Name="Renomio"`、`INSTALLDIR Name="Renomio"`）均为新名。

## 工作方式约定

构建、测试、验证一律后台执行；禁止在用户会话中启动带 GUI 的进程（`tauri dev`、有头浏览器、文件管理器）；文件操作验收用临时目录 + 断言脚本，不靠人工点界面。完整约定与常用后台命令见 [../CONTRIBUTING.md](../CONTRIBUTING.md)。
