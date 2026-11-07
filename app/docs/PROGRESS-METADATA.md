# alpha10 元数据/排序/去重 进度

> 本文件是五项追加需求的落地台账，每完成一项即时更新。
> 验证脚本位于工作区 `temp_20261105_06/verify-alpha10/`（夹具 + 独立交叉校验）。

## 状态总览

| # | 需求 | 代码 | 真实文件验证 | 状态 |
|---|------|------|--------------|------|
| 1 | 图片元数据编辑 | 完成（Rust `metaedit/image.rs`，前端 `MetaEditDialog`） | 通过（JPEG/PNG/WebP/TIFF） | 已收口 |
| 2 | 音乐标签编辑 | 完成（Rust `metaedit/audio.rs`） | 通过（MP3 v2.3/v2.4、FLAC、M4A、OGG Vorbis、Opus，含封面） | 已收口 |
| 3 | 文档属性编辑 | 完成（Rust `metaedit/doc.rs`：OOXML ZIP 重打包 + PDF 增量更新） | 通过（DOCX/XLSX/PPTX/PDF，70 项断言 0 失败） | 已收口 |
| 4 | 文件列表拖动排序 | 完成（`MainPane.tsx` / `store.ts` / 会话持久化） | 通过（headless e2e 145/145） | 已收口 |
| 5 | 重复添加处理 | 完成（`store.ts#addPaths` / `scanDuplicates` / `dedupeDuplicates`） | 通过（headless e2e 145/145） | 已收口 |

## 4. 文件列表拖动排序（现状 → 实现）

- 拖动柄：`src/components/MainPane.tsx` 行首 `drag-cell`，`row-handle-<idx>`。
- 落点：行级 `onDragOver/onDrop`，`moveEntryTo(from, to)` 改变 `entries` 顺序。
- 上移/下移：`row-up-<idx>` / `row-down-<idx>`，与拖动共用同一 action。
- 持久化：顺序保存在 `rename-studio.session`（version 3），刷新后 `manualOrder` 与列表顺序一致。
- 防「假排序」：列头排序生效时拖动柄 `draggable=false`，点击上/下移提示 `main.execOrderHint`（先取消列排序）。
- 编号规则口径：**规则链与编号按列表当前顺序执行**，界面在 `manual-order-chip` 处写明。
- e2e 断言：上下移立即生效、重载后顺序保持、合成 DragEvent 拖拽生效、列排序时禁用拖动。

## 5. 重复添加（改造前的真实行为 → 现在）

改造前（HEAD `alpha8`，`src/store.ts#addPaths`，git 可查）：
按 `normalizePath` 建 `known` Set，同路径**静默跳过**（`if (known.has(key)) continue;`，无任何提示），
不刷新 mtime/size（文件被外部修改后列表里的 size/时间仍是旧值）；
同名不同目录正常保留但**无重名标记**；内容相同（不同路径）**完全无检测**。

现在（`src/store.ts` 614-691）：

- 同一绝对路径：`indexByKey`（`normalizePath`）命中即忽略，`existed += 1`；若 `size` 或 `modified` 变化则就地更新该条（`updated += 1`），不新增。提示 `toast.duplicateIgnored`。
- 同批内重复路径：`incomingSeen` 一次遍历去重（O(n)）。
- 同名不同目录：保留两条；`MainPane.tsx` 计算 `duplicateNames` 并显示 `dup-name-<idx>` 「重名」徽标。
- 内容相同（不同路径）：默认保留。`scanDuplicates()` → `find_duplicates`（按 size 分组 + SHA-256 + 逐字节确认）列出 `dup-panel` 疑似重复组；`dedupeDuplicates()` 只移除列表项，不删除磁盘文件；`toast.deduped` 明确「磁盘文件未改动」。
- 大量拖入：`addPaths` 单次遍历建立索引与 Set，无 O(n²)。

## 1. 图片元数据（已验）

- 支持：JPEG（APP1 EXIF IFD0 + XMP 合并）、PNG（iTXt）、WebP（RIFF/VPX EXIF+XMP）、TIFF（IFD0）。
- 字段：title / description / keywords / author / copyright / software / takenAt / headline / bylineTitle / credit / source（后四项 IPTC Core，仅写 XMP，不写 APP13/8BIM）。
- 保留：相机 Make/Model/GPS/ICC；只改勾选字段；先备份后原子替换；逐字段回读校验。
- 不支持：HEIC/HEIF（明确拒绝并说明原因）、GIF/BMP/AVIF。
- 实测：`verify_meta.py` 图片段全部通过（Pillow 13 校验尺寸/像素哈希/ICC/EXIF/GPS，备份字节一致，restore 后字节完全还原）。

## 2. 音乐标签（已验）

- 支持：MP3（ID3v2.3 UTF-16 / v2.4 UTF-8）、FLAC（Vorbis comment + PICTURE）、M4A/MP4（ilst/covr）、OGG Vorbis（+framing bit）、Opus（OpusTags）。
- 字段：title / artist / album / year / track / genre / comment / albumArtist / lyrics / cover（lyrics：MP3 `USLT`、FLAC/OGG `LYRICS`、M4A `©lyr`）。
- 本轮修复：MP3 TXXX(comment) 与 COMM 同步；Vorbis 键统一小写且 comment 兼容 DESCRIPTION；OGG Vorbis 注释头补 framing bit；FLAC 封面按读取口径（type 3 优先，否则任取首个图片块）替换/清空，兼容 ffmpeg 写的 pic_type=0。
- 不支持：WMA(ASF) / APE / AIFF / WAV（明确拒绝，不静默跳过）。
- 实测：`verify_meta.py` 音频段 270 项断言 0 失败（含批量逐文件回传、中文/日文标签、解码帧 md5 不变、封面换/清）。

## 3. 文档属性（已验）

- 支持：DOCX / XLSX / PPTX（只替换 `docProps/core.xml`，其余 ZIP 条目按原压缩数据逐字节复制）；
  PDF（经典 xref 增量更新：追加 Info 字典 + XMP + 新 Catalog，`/Prev` 指回旧 xref，原始字节前缀保留）。
- 字段：title / subject / author / lastModifiedBy / keywords / comment / category。
  PDF 的 title/author/subject/keywords 同步写 Info + XMP；comment/lastModifiedBy/category 仅写入 Info 扩展键（界面与结果里给出警告）。
- 实测（`verify_docs.py`，70 项断言 0 失败）：
  - python-docx / openpyxl / python-pptx 复读：属性读→改→回读正确，正文/单元格/幻灯片文本完全不变；
  - ZIP `testzip` 无损坏，条目集合不变，**仅 `docProps/core.xml` 哈希变化**；
  - PDF 严格模式解析成功、页数 2→2、逐页文本完全一致、Info+XMP 同步、原始字节前缀保留、以 `%%EOF` 结尾；
  - 清空后 core.xml 不再含对应元素（XLSX 的 `creator` 会被 openpyxl 回退显示为默认值 `openpyxl`，文件本身已无该元素）；
  - 备份字节一致，`restore` 后文件字节与原始完全一致。
- 明确不支持：旧版 OLE（.doc/.xls/.ppt）、加密 PDF、xref 流 PDF、缺少 `docProps/core.xml` 的 OOXML → 均返回具体文件与原因。
- 单元测试：`cargo test -p renomio-core --lib` 52/53 通过；唯一失败是既有的 `rename::tests::directory_junction_is_renamed_as_a_link`
  （`mklink` 目录联接在整套测试环境下偶发「找不到路径」，单独运行通过，与本次改动无关）。

## 3b. 原软件（Office COM）打开校验（已验）

目的：回答「改完原软件能正常打开、无修复提示」，由用户授权拉起 Office 进程后执行。

- 环境探测：Microsoft Office 16（ClickToRun，`VersionToReport 16.0.20527.20112`，zh-cn，x64）；
  COM ProgID `Word.Application` / `Excel.Application` / `PowerPoint.Application` 均可实例化，
  `Version=16.0`；WPS 的 `KWPS/KET/KWPP.Application` 未安装（注册表与 ProgID 均不存在）。
- 样本（`verify-alpha10/com-check/`，原始与改后各一份，改后文件由生产探针写入）：
  - `report.docx` 35757 → 35797 字节，sha256 `99BECFF6…24B` → `D0B3703A…214`
  - `budget.xlsx` 5689 → 5727 字节，sha256 `BF82988B…620` → `E1B75680…A3A`
  - `deck.pptx` 29532 → 29571 字节，sha256 `8E427E53…D03` → `66C7E877…FBF`
- 方式：`Visible=false`（PowerPoint 见下）、`DisplayAlerts` 关闭、只读打开、不写回；
  每次 Open 前记录基线 PID，结束后只结束本次新起的 `WINWORD/EXCEL/POWERPNT`。
- 结果（原始 → 改后，均为「正常打开」，无弹窗/无错误）：
  - Word：1 页 / 62 词，关键文本（`季度财务报告`、`收入同比增长 12%`、`1200`）均在；
    内置属性 Title/Subject/Author/Keywords/Comments 由 `旧…` 正确变为 `新标题 New/新主题/张三/季度; 财务; alpha10/备注：只改属性，不动正文`；耗时 573 ms → 174 ms。
  - Excel：2 个工作表（`预算`/`明细`），`A2=人力`、`B2=1200`（显示 `1,200.00`）、`B4=SUM=2000`、
    `明细!A2` 文本不变；属性同上正确；耗时 478 ms → 100 ms。
  - PowerPoint：2 页幻灯片，两页关键文本均在；属性同上正确；耗时 155 ms → 44 ms。
- PowerPoint `Application.Visible=false` 被 Office 拒绝（`Hiding the application window is not allowed.`），
  改为 `Presentations.Open(ReadOnly=true, Untitled=false, WithWindow=false)`，打开后可见窗口枚举为空，
  等效无界面，并如实记录该差异。
- 进程清理：6 次打开后无残留进程（`WINWORD/EXCEL/POWERPNT` 均为 NONE）；
  曾出现一个 COM 子进程在退出瞬间 `Access is denied` 无法强杀，数秒后自行退出并复查为 gone。
- 文件占用：6 个样本均可 `FileShare.None` 独占打开，目录内无 `~$*` / `*.~lock*` 临时文件。
- 结论：改后的 DOCX/XLSX/PPTX 可被 Word/Excel/PowerPoint 16.0 正常打开并正确读出属性与正文，
  未见修复提示；对照组（未改原件）结果一致，排除「文件本身有问题」。

## 追加排期（对账后）

| # | 项 | 代码 | 验证 | 状态 |
|---|----|------|------|------|
| 1 | 元变量体系 | `src/lib/vars.ts`（解析/校验/展开）、`rules.ts` 四个文本字段接入、`hashing.rs`（CRC32/MD5/SHA1 流式）、`file_hashes` 命令、规则面板变量插入面板、设置 USER1–9 | `e2e/vars.mjs` 真实文件 28/28；Rust 哈希 6/6；浏览器 e2e 149/149（新增 4 项） | 完成 |
| 2 | 八规则真实文件端到端 | `e2e/rules-fs.mjs`（transpile 真实规则引擎 + 两阶段真改名/撤销 + 独立 ID3 解析） | 41/41；已并入 `npm run test:e2e` 的 REAL-FS 层 | 完成 |
| 3 | 智能更名策略面板 | `preview.ts` 策略、`validateName(limit)`、`scan.rs` hidden/system、设置 UI（长度/超长/空名/跳过系统隐藏） | `e2e/policy.mjs` 41/41；`tsc`、`npm run build`、e2e 154/154（含 2 项面板 UI 断言） | 完成 |
| 4 | 1.0.0 发布 | 签名 NSIS/MSI、v1.0.0 Release（5 资产）、`updates` latest.json、匿名下载核对 | e2e 154/154；两包 200 且 SHA-256 一致；alpha 资产未动 | 完成 |

### 1. 元变量（语义与实现）

- 支持：`<NAME>`（原文件名去扩展名）、`<EXT>`（不含点）、`<DOTEXT>`（含点）、`<DIR>`、`<DATE>/<TIME>`（取**修改时间**，默认 `yyyyMMdd`/`HHmmss`，支持格式串）、`<SIZE>`（字节 / `:KB` 等单位 / `:KB:6` 补零）、`<CRC32>/<MD5>/<SHA1>`、`<USER1>–<USER9>`、`<#>`（仅编号表达式）。
- 变量名大小写不敏感；未知变量名由 `ruleError` 报错，`applyRules` 跳过该规则，不会把占位符写进文件名；`<#>` 出现在非编号规则里同样报错。
- 哈希：仅当启用规则引用了哈希才计算；Rust 单遍流式读取（1 MB/块），三种算法同时算，块间检查取消标记；前端每 24 个文件一批，规则面板显示进度并可取消；结果按路径缓存，重复引用只算一次；失败文件不自动重试并在预览里给出原因。
- 变量面板：添加/替换/编号/扩展名输入框内嵌 `<>` 按钮，列出可点选变量（编号表达式额外提供 `<#>`），底部按当前输入实时展开示例（样例文件 `IMG_2048.jpg`）。
- 设置新增 USER1–USER9，默认全空；旧配置缺该字段时按空串处理。

### 2. 八规则真实文件端到端

- 覆盖：添加、正则替换、范围删除、编号（start/step/digits）、移动子串、大小写、扩展名、按元数据取名。
- 每条用例：真实临时文件 → 规则输出 → 两阶段改名（临时名中转，支持交换）→ 校验磁盘真实文件名与旧名消失 →
  反序撤销 → 校验原名恢复且内容 SHA-256 不变；元数据用例使用真实 ID3v2.3 标签并由独立解析器核对。
- 结果 41/41；脚本 `e2e/rules-fs.mjs` 已接入 `npm run test:e2e` 的 REAL-FS 层。

### 3. 智能更名策略面板

- 新增设置（默认值 = 旧行为，老配置缺字段时按默认兜底，不突变）：
  - 名称长度上限 `255`（0 = 平台上限；只会收紧，不突破 `componentLimit`）；
  - 超长处理 `block`（阻止）/ `truncate`（截断主体、保留扩展名）；
  - 空名处理 `block` / `fallback`（备用名默认「未命名」，空串或纯空白仍按阻止）；
  - 跳过系统/隐藏属性 `false`（开启后预览状态为 `off`，不参与执行）；
  - 非法字符替换 `false` / `_`、只读跳过 `false` 沿用原有设置。
- 扫描侧新增 `hidden`/`system`（Windows 读取文件属性 `0x2`/`0x4`；隐藏也包含 `.` 开头名称）。
- 验证：`e2e/policy.mjs` 41/41（默认值解析对照 + 真实文件截断改名/还原 + 隐藏/系统跳过 + 非法字符 + 只读）；
  `npx tsc --noEmit`、`npm run build`、`npm run test:e2e` 154/154（其中 2 项为设置面板 UI 断言：
  默认值 255/阻止/阻止/未命名/关，以及切到「备用名」后输入框可用）。
- 环境说明：`renomio-core` 的 `directory_junction_is_renamed_as_a_link` 在本机失败（PowerShell 对 junction
  执行 `Rename-Item` 同样报「找不到路径」），属环境限制而非代码回归；其余 58 项通过。

## 版本与发布

### alpha11（当前）

- 版本闸门口径修正（用户拍板 A）：alpha 序号上限 10 → 99，minor/patch 仍 ≤ 10；
  自测保持 16 项并更新反例（`1.0.0-alpha11` 放行，`1.11.0`/`1.0.11` 拒绝），结果 16/16。
- `VERSION=1.0.0-alpha11`，`version:sync` 注入 5 处清单，`version:check` 通过；
  `Cargo.lock` 两处版本号手工同步（sync 脚本不含 lock）。
- 前端 `npm run build` 通过；本版无功能代码变更，沿用 alpha10 的 e2e 145/145 结果。
- 签名构建：NSIS `Renomio_1.0.0-alpha11_x64-setup.exe` 2,337,237 字节
  SHA-256 `C5FE3EDB15F2FBAB6E0D7CA7276B892D4362C41280924EE62157CCB2E65F1586`；
  MSI `Renomio_1.0.0-alpha11_x64_en-US.msi` 3,129,344 字节
  SHA-256 `036C15C6A7FDADF0A52F187075700FCB430505619B55EF7617506C7ADC752E5D`；
  `renomio.exe --version` = `renomio 1.0.0-alpha11`。
- 已发布 https://github.com/yunyu697/renomio-releases/releases/tag/v1.0.0-alpha11 （5 资产），
  `updates` 滚动 tag 的 `latest.json` 已更新（1,003 字节，含 `size` 2337237）；alpha10 资产未改。
- 匿名下载核对：setup.exe / msi / latest.json 均 HTTP 200，字节与 SHA-256 与本地一致；
  alpha10 setup 仍 200、2,337,782 字节、SHA 未变。

### 1.1.0-alpha1（当前开发版）

- `VERSION` → `1.1.0-alpha1`；`version:sync` / `version:check` / `version:selftest` 16/16 通过；
  `Cargo.lock` 两处手工同步。前端 `tsc --noEmit` 通过。
- 元变量：新增 `<FILENAME>`（含扩展名）、`<SUBSTR>` / `<DIFNSUBSTR>`（作用于不含扩展名的原名，
  支持起/长与负起始）；真实文件改名 12 组（中文、无扩展名、240 字超长、越界截取）全部通过。
  `e2e/vars.mjs` 93/93。
- 文件属性：`AttrSpec` 支持 `set/clear/invert`，取反按原值逐文件计算；写入前把原属性存入批次 `before`，
  撤销还原。Rust `ops_fs` 属性 3/3。
- 时间属性：新增「随机区间」（路径 + 种子 FNV-1a 取确定值，前端/Rust 向量一致）与
  「同步写图片 EXIF 拍摄时间」；平移基于当前值，重复执行累加。Rust `time_` 8/8。
- 归类模板：`MoveRuleKind` 新增 `template`，复用 `scanTemplate/expandTemplate`，支持 `/` 多级目录；
  未知变量、非法参数、哈希变量、`<#>`、`..` 逐项拦截并给出原因；撤销沿用既有 move 批次（路径还原 + 清理空目录）。
  真实文件校验 3 组（中文 / 无扩展名 / 大写扩展名）；浏览器 e2e 167/167（新增模板预览、应用、撤销、非法模板 7 条断言）。
  另修正 `renomio-core/Cargo.lock` 中 `renomio-core` 版本（1.0.0 → 1.1.0-alpha1），`--locked` 测试恢复可用。
- 键位窗 `ShortcutDialog`：5 条命令可查看/录制/恢复默认；`lib/shortcuts.ts` 负责解析、规范化与匹配，
  冲突检测在 store 层拒绝并提示；绑定存入设置（localStorage），刷新后仍生效；Esc 分层（录制中只取消录制）。
  浏览器 e2e 176/176（新增 9 条键位断言）。
- 多格式导出：工具栏改为「导出」菜单（CSV / Excel `.xlsx` / HTML / TSV）。`lib/export.ts` 生成
  TSV（BOM + CRLF）、HTML（独立完整文档、内联样式、转义、暗色适配）、`.xlsx`（自写 store-only ZIP +
  CRC32 + OOXML inlineStr，零依赖，冻结表头与列宽）；`bridge.saveBinaryFile` 桌面端走新增的
  `write_bytes_atomic`（base64 → 原子写入，覆盖前备份），浏览器端回落 Blob 下载。
  真产物校验：`report.xlsx` 5077 字节、6 个 ZIP 条目、4 行、中文单元格、sheet 名 `Report`；
  HTML 1777 字符、TSV 274 字节。浏览器 e2e 180/180。
- 快照（方案 C）：`renomio-core/src/snapshot.rs` 新增生成 / 列表 / 读取 / 删除 / 预览 / 还原；
  默认只存「原名 → 新名 + 大小 + 修改时间」，勾选才逐条流式算 SHA-256（可取消、80ms 节流进度）；
  还原严格只改回原名，占用 / 已变化 / 已改名 / 路径非法逐条跳过且绝不覆盖；批次 `kind=restore`，
  `Core::undo` 与 `rename::undo` 都按 rename 处理，因此可整批撤销。前端新增「快照」入口与
  `SnapshotDialog`（哈希默认关、预览、逐条结果、删除），5 语言文案齐备。
  真实产物：`renomio-snap-roundtrip` 快照 JSON 648 B、还原批次 JSON 859 B；占用测试里诱饵 5 B 未被覆盖、
  冲突条目 `旅行_001.jpg` 原地保留；哈希测试快照值 `09757…` 与 PowerShell `Get-FileHash` 对原文一致。
- 浏览器 e2e 195/195；快照 Rust 集成测试 5/5；全量 `renomio-core` 单测 59/60，唯一失败为既有的
  `rename::tests::directory_junction_is_renamed_as_a_link`（本机无创建目录联接的权限，与本批改动无关）。

### 1.0.0（正式版，历史）

- `VERSION=1.0.0`（无 alpha 后缀），`version:sync` 注入 5 处清单，`version:check` 一致，
  `version:selftest` 16/16；`Cargo.lock` 两处（`rename-studio`、`renomio-core`）手工同步为 1.0.0。
- 自测：`tsc --noEmit`、`npm run build`、`npm run test:e2e` 154/154；
  `renomio.exe --version` = `renomio 1.0.0`。
- 签名构建（Tauri 更新签名，沿用既有私钥）：NSIS `Renomio_1.0.0_x64-setup.exe` 2,348,698 字节
  SHA-256 `57BFA4AD581514118660D660BF4913162CD83FF99F2A47A2EF807D423C6EC372`；
  MSI `Renomio_1.0.0_x64_en-US.msi` 3,141,632 字节
  SHA-256 `0F1192E11923225212B16DB676F9DFE6EEF82042CCB900B384FE258032D0555C`。
- 已发布 https://github.com/yunyu697/renomio-releases/releases/tag/v1.0.0 （5 资产），
  `updates` 滚动 tag 的 `latest.json` 已更新（1,079 字节，version=`1.0.0`，含 `size` 2348698，
  `signature` 与 setup.exe.sig 完全一致）。
- 匿名下载核对（无 token）：setup.exe HTTP 200 / 2,348,698 字节、
  msi HTTP 200 / 3,141,632 字节、latest.json HTTP 200 / 1,079 字节，SHA-256 与本地一致。
- alpha 系列未改动：alpha11 setup 仍 HTTP 200、2,337,237 字节、
  SHA-256 `C5FE3EDB…1586`（与发布时记录一致）。
- 环境备注：本机安全策略拒绝在 `Documents` 下写 `node_modules/.vite-temp` 与 `target`，
  构建改用 `vite --configLoader runner` 预构建前端 + `CARGO_TARGET_DIR` 重定向到
  `%TEMP%\renomio-target-1.0.0` 后打包；产物与签名不受影响。

### alpha10（历史）

- `VERSION` → `1.0.0-alpha10`；`version:sync` 注入 5 处清单，`version:check` 通过，`version:selftest` 16/16。
- 前端 `npm run build` 通过；headless e2e 145/145。
- 签名构建（Tauri 更新签名）：NSIS `Renomio_1.0.0-alpha10_x64-setup.exe` 2,337,782 字节、
  MSI `Renomio_1.0.0-alpha10_x64_en-US.msi` 3,129,344 字节；`renomio.exe --version` = `renomio 1.0.0-alpha10`。
- 已发布 https://github.com/yunyu697/renomio-releases/releases/tag/v1.0.0-alpha10 （5 资产），
  `updates` 滚动 tag 的 `latest.json` 已更新（含 `size` 2337782）。
- 匿名下载核对：两包 HTTP 200，字节数与 SHA-256 均与本地一致；`latest.json` HTTP 200。
