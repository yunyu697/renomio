# FEATURE-GAP：六域功能对账（对标商业批量改名软件）

- 对账日期：2026-11-06
- 我方产品：Renomio（Tauri v2 + React 19 + Rust core `renomio-core`），当前工作树版本 `1.1.0-alpha7`（公开最新为 `1.1.0-alpha7`）
- 参照产品：某商业批量改名软件（Windows 原版；证据见 `docs/商业改名软件-实证分析与跨平台重构方案.md` 第 1.5 节，37 项功能清单）
- 状态口径（验证层级，不用「已实现」掩盖未验证）：
  - **A 已实现·有实测**：真实文件 / 端到端跑过，有可复核断言
  - **B 已实现·仅单测**：只有 Rust/前端单测或 mock，未做真实文件端到端
  - **C 已实现·无验证**：代码存在，无自动化或人工证据
  - **D 部分**：能力不全或只覆盖子集
  - **E 未做**：无对应实现
  - **N 本版不做**：明确不支持并给出拒绝路径

---

## 域一 文件导入与列表

| # | 功能 | 状态 | 验证证据 | 与商业标杆的差距 |
| --- | --- | --- | --- | --- |
| 1.1 | 添加文件 / 文件夹（对话框、递归、含文件夹名） | A | Rust `scan_recursive_filter_and_dedup`；e2e 添加真实临时文件 | 原版还支持工具栏过滤区与「含文件夹名」组合；我们已覆盖递归/含目录名，未做过滤区常驻控件 |
| 1.2 | 拖放添加（文件/文件夹混合、多批） | A | `test:drop` + e2e mock；真实 OS 拖放未做人工点验 | 原版仅推断支持（`DragAcceptFiles`），入口未实证；我们实现更明确 |
| 1.3 | 通配符过滤（保留/排除、执行过滤） | A | `scan_recursive_filter_and_dedup` 断言；执行筛选入口内联在路径条筛选组（「仅保留匹配」按钮，填了条件才出现，Enter 等效 / Esc 清空，空结果不落地并提示），更多菜单不再放执行动作；`npm run test:filter` 23 条（纯函数 11 + 接线 10 + 文档 2）+ e2e 7 条 | 原版支持 `<FILE>/<DIR>` 占位与独立 `TFilterForm`；我们只有通配符，无 `<FILE>/<DIR>` 语义与独立过滤器面板 |
| 1.4 | 九类列表页签（属性/音乐/照片/图像/Office/PDF/文本/归类等） | N | 按 `docs/界面重构-HIG基线.md` §1.16 下线：列表是唯一主视图（页签、`ListView.tsx` 分类列、`.list-tabs` 样式全部删除，残留死样式由 `npm run test:css` 守住 0 孤儿） | 设计决策不做：多页签切视图与原版形态不同；九类只读分类列不再提供 |
| 1.5 | 列显隐 / 列宽 / 排序持久化（含**自动列宽**） | A | e2e `12-column-menu`、`13-columns-resized`；localStorage。自动列宽：算法在 `src/lib/columnFit.ts`（`clampWidth` / `fitColumnWidth` / `fitWidths` 纯函数，文本测量由调用方注入），表头分隔线**双击**按该列真实内容自适应、列菜单「自动列宽」一次算全部可见列；`npm run test:columns` 56 条（Node 类型剥离直接 import 后实跑 18 条 + 接线 28 条 + 文档同源 8 条，宿主机缺 strip-types 时回落 tsc）与 e2e 6 条几何断言；列宽预算扣掉表头/行两侧内边距（`LIST_PAD = 24`），1280×800 不再挤横向滚动条 | 原版有自动列宽与系统图标；我们补上自动列宽，仍无系统文件类型图标 |
| 1.6 | 顶部搜索（名称 / 路径 / 新名） | A | `store.search` + e2e `Ctrl K` 搜索断言 | 原版**没有**搜索框（1.5 节 #36 未找到）；本项我们领先 |
| 1.7 | 勾选部分执行（未勾选不计数） | A | Rust onlyChecked 测试 + e2e | 原版 `NxCheckBoxColumn` 同等能力；持平 |
| 1.8 | 重复添加：同绝对路径忽略并提示「已存在」；mtime/size 变化就地更新 | A | e2e 重复添加段（同路径忽略、size 变化更新） | 原版未提供内容级重复检测；本项我们领先 |
| 1.9 | 同名不同目录：保留并标「重名」 | A | e2e 重复添加段 | 原版仅靠冲突策略；我们列表内显式标记，领先 |
| 1.10 | 内容相同检测（size 分组 → SHA-256 → 逐字节确认）+ 一键去重（不删磁盘） | A | e2e 内容相同分组与去重；`DuplicateReportDto` | 原版无对应能力；领先 |
| 1.11 | 大批量拖入一次遍历去重（非 O(n²)） | A | 同路径 Set/索引 + size 分组，e2e 批量断言 | 原版无对应能力 |

## 域二 列表排序与自动编号

| # | 功能 | 状态 | 验证证据 | 与商业标杆的差距 |
| --- | --- | --- | --- | --- |
| 2.1 | 拖拽重排（拖动柄 + 落点指示） | A | e2e 拖动排序 + 截图；`MainPane.tsx` 拖动柄 | 原版未见明确拖放目标；本项我们领先 |
| 2.2 | 上移 / 下移按钮 | A | e2e 上移按钮断言 | 原版无对应按钮（以排序/编号为主）；领先 |
| 2.3 | 顺序持久化（`rename-studio.session` v3，重启恢复） | A | store 会话恢复 + e2e | 原版命令列表保存顺序；我们会话自动恢复，体验更顺 |
| 2.4 | 编号严格按当前列表顺序 | A | e2e 编号断言；store 顺序为唯一来源 | 原版按扫描/载入顺序，表头排序不改编号；一致 |
| 2.5 | 表头排序不改变编号 | A | 实现约束 + 既有断言 | 一致 |
| 2.6 | 仅勾选行不消耗序号 | A | onlyChecked 单测/集成 | 一致 |
| 2.7 | 自动编号完整参数（起始/增量/位数/补位/分组/排除/按路径/赋值 USER 变量） | A | `NumberRule` 含 `expression/start/step/digits/padChar/groupBy(none·parent·field:)/exclude(通配)/byPath/writeVar(USER0–USER9)/onlyChecked`；`e2e/number-advanced.mjs` 真实目录回放（分组-按目录/不分组/按相机字段、排除、按路径取号、序号写入 `<USERn>` 后供后续规则引用），含磁盘改名与撤销还原断言 | 原版 1.N.4 的「重复/跳过」语义仍按我们自己的口径实现；其余参数已覆盖 |
| 2.8 | 元变量（`<FILENAME>/<NAME>/<EXT>/<DOTEXT>/<SUBSTR>/<DIR>/<DIFNSUBSTR>/<CRC32>/<MD5>/<SHA1>/<SIZE>/<DATE>/<TIME>/<USERn>/<#>`） | A | 全套已实现并可组合；`e2e/vars.mjs` 73/73（真实文件覆盖中文名、无扩展名、240 字超长；`<SUBSTR>`/`<DIFNSUBSTR>` 的正/负起始、超长截取边界、与 `<#>` 组合、非法参数报错）；Rust 哈希向量 6/6；浏览器面板与实时预览 e2e | 菜单形态仍为输入框内嵌可点选面板，不是原版右键菜单；`<USER0>` 未支持；未实现原版的算术/条件表达式 |

## 域三 更名规则与预览

| # | 功能 | 状态 | 验证证据 | 与商业标杆的差距 |
| --- | --- | --- | --- | --- |
| 3.1 | 规则链（8 类：插入/替换/删除/编号/移动/大小写/扩展名/元数据） | A | e2e 规则链与预览；`types.ts` `RuleType` | 原版 6 组常规 + 7 组扩展名 + 13 组高级；我们规则类型少、参数粒度粗 |
| 3.2 | 规则启停 / 拖拽排序 / 持久化 | A | `test:history` + e2e | 原版有命令列表；我们只有规则链持久化 |
| 3.3 | 正则替换（JS 方言 `$1` + Delphi 方言 `\1` / `\0`、nth、大小写） | A | `npm run test:regex` 28 条（`\1`/`\0` 转换、边界、分组校验、nth 展开、`applyRules` 端到端）； `npm run test:regex:real` **21 条**真实文件闭环（真实规则引擎算新名 → core 两阶段改名 → 磁盘比对名字/内容/目录 → 真实撤销还原，含未命中文件原样）； e2e 6 条（提示、`\1` 展开、超限报错、`\\1` 字面、`\0` 整段、第 2 个匹配展开） | 已消除 `$1`、`\1`、`\0` 的迁移差异；原版其余 Delphi 语法（脚本类高级规则）仍不支持 |
| 3.4 | 删除模式（区间 / 之间 / 字符集 / 修剪） | A | `npm run test:del` 77 条 + e2e 16 条；修剪支持自定义修剪字符 | 四种模式全部对齐原版：区间含「从尾部数」（起点从末尾逆算、朝词尾延伸）、之间含左右标记各含/不含的四种组合与双空标记拦截、字符集删/留、修剪默认只剪空白并可自定义字符集；emoji 按码点切分，旧存档 `trimChars` 缺省为空即语义不变 |
| 3.5 | 大小写（upper/lower/title/sentence/invert/random，含分隔符与例外词表） | A | `npm run test:case` 18 条（词表解析/精确词/大小写不敏感/`*`·`?` 通配/多词/六种模式/正则元字符按字面/长度变化退回）；e2e 3 条（输入框与提示、`logo.png` 在 upper 下保留原写法、清空后变 `LOGO.png`） | 原版另有「例外词表按词边界匹配」细分；我们按子串匹配 |
| 3.6 | 移动子串 | A | `npm run test:move` 44/44（两种定位、前后插入、越界 clamp、emoji 按字符）；e2e 10 条（默认分段、位置移动、前后落点差一位、标记模式字段切换、缺标记不改名、双空标记报错） | 原版 1.N.5 参数更细（起止/目标位置/从尾部）——已对齐起止标记与目标前后；仍缺「按上一次结果再链式定位」的表达式式参数 |
| 3.7 | 扩展名规则（加/换/删/编号/大小写/固定/**智能分析**） | A | `renomio-core/src/sniff.rs` 按文件头魔数识别 20 种格式（RIFF 按 FORM 分 wav/avi/webp、`ftyp` 按 brand 分 mp4/m4a/mov/heic），仅读前 64 字节；`npm run test:core` 4 条（魔数覆盖、两大容器家族分流、过短/未知头部为 None、错标 `.jpg` 的 PNG 被识别）；`npm run test:ext` 56 条（错标纠正、识别不出与无上下文保持原名、大小写/前导点/目录边界、与固定扩展名串联、校验与摘要、五语种文案、前后端接线）；e2e 9 条（模式分段第 6 项、说明文案、摘要、002.jpg→png、001.jpg 不动、003.jpg 未知不动、logo.png→jpeg、真的调 `sniff_extensions`、切回 Case 不再纠正） | ZIP 容器不深挖内部，故 `docx/xlsx/apk` 一律识别为 `zip`，不会据此改成 Office 后缀 |
| 3.8 | 按元数据取名（21 字段：拍摄时间/相机/ISO/光圈/快门/焦距/镜头/像素宽·高·尺寸/标题/艺术家/专辑/曲目/年份/流派/作曲/字体名/字形/字体版本/可执行文件版本） | A | `MetaRule` + `rename_fields`；`npm run test:core` 10 条（手写 EXIF JPEG 的双字节序取值、PNG 回退尺寸、音频标签缺失为空、字体名/版本取值、`name_safe` 路径与保留字符）+ `tests/apk_contract.rs` 16 条（UTF-16 与 UTF-8 字符串池、包名·版本名·版本号、`@string` 经 `resources.arsc` 解析、缺表与坏表只警告、min/target/compile SDK、主活动相对名补包名、多 activity 只认带 LAUNCHER 的、权限去重、debuggable 与 allowBackup、deflate 压缩清单、非 APK 的 ZIP 不误判、坏中央目录返 None 不 panic、超 8 MB 包用头+尾双窗口、签名块与 v1 签名、真 .apk 走 `read_metadata` 取名可用）+ `tests/pe_contract.rs` 15 条（可选头位数/架构/子系统、DLL 特性位与驱动子系统、`VS_FIXEDFILEINFO` 四段版本、中英文字符串、en-US 表优先、资源 RVA 越界/签名损坏/截断均只警告、真写 .exe 走 `read_metadata` 取名可用）；`npm run test:meta` 60 条（字段表 21 / 五语种文案齐全 / 每字段真拼名 / 缺失不改名 / 编号分组 `field:` / Rust 结构体一一对应）；e2e 7 条（下拉 21 项五组、ISO·镜头·像素尺寸·字体名改名、照片选音频字段保持原名、摘要写明 EXIF 来源、编号分组下拉同步） | 原版 1.S.* 支持音乐/EXIF/IPTC/多媒体/Office/PDF/文本/字体/APK/EXE 十类；我们覆盖 EXIF 拍摄参数 + 像素尺寸 + 音频/文档常用标签 + 字体（TTF/OTF/TTC）+ EXE/DLL 的 PE 版本资源共 21 字段，APK 已补只读（版本名接进「文件版本」），IPTC 细分标签（2:25 关键词/2:120 说明等）与 APK 写入仍是空档 |
| 3.9 | 原名 → 新名实时预览（差异分段 + 状态） | A | e2e 预览截图与断言 | 一致；我们额外有状态筛选/搜索 |
| 3.10 | 冲突检测（批次内重名 + 磁盘存在） | A | `paths_exist_check`、`conflict_skip_leaves_both_files` | 一致 |
| 3.11 | 冲突策略：跳过 / 自动后缀 / 备份覆盖 | A | 3 个对应 Rust 测试 | 原版「智能更名(1)(2)」可配置阈值与只读/系统/超长/重名/空名策略；我们策略面窄 |
| 3.12 | 智能更名策略面板（阈值、空名、系统属性、只读、超长） | A | 设置 → 名称安全：长度上限 255 / 超长 block|truncate / 空名 block|fallback / 跳过系统隐藏；`e2e/policy.mjs` 41/41（默认值对照 + 真实文件截断改名与还原 + 隐藏/系统跳过 + 非法字符 + 只读），v1.0.0 起生效 | 原版可配置项更多（按冲突/重复/只读分别设阈值与动作）；我们已覆盖高频四项，未做按场景多套策略 |
| 3.13 | 高级规则（脚本 / 编码转换 / 内码 / 加密 / 对照表） | D | 对照表已做：`MapRule` + `src/lib/mapTable.ts`（一行一条「旧=新」，`=` 或制表符分隔、`#`/`//` 注释、`\=`/`\s` 转义、键值 trim、大小写开关、500 条上限、逐行错误码）；应用是**单遍最长匹配**、插入文本不再扫描（`A=B`、`B=C` 不连锁）、新词留空即删除，只作用于文件名主干，目录同样适用；`npm run test:map` 70 条（纯函数实跑 + 引擎接线 + 五语种 + 文档同源）+ e2e 4 条 | 脚本 / 编码转换 / 内码 / 加密四项仍不做（见文末） |

## 域四 执行、撤销与历史

| # | 功能 | 状态 | 验证证据 | 与商业标杆的差距 |
| --- | --- | --- | --- | --- |
| 4.1 | 两阶段临时名执行（交换 / 环形 / 仅大小写） | A | `swap_*`、`case_only_*` 集成测试 | 原版同名能力；持平 |
| 4.2 | 只读文件策略（可跳过） | A | `readonly_file_skip_or_rename` | 原版有只读/系统/隐藏策略；我们只读已覆盖，系统/隐藏策略未做 |
| 4.3 | 超长路径 >260 | A | `long_path_over_260_rename_and_undo` | 原版靠警告与截断；我们默认长路径，领先 |
| 4.4 | 锁定 / 权限失败逐条回传 | A | e2e `17-permission-failures`；`FailureCode` | 原版有消息栏；我们逐条回传 + 可撤销，领先 |
| 4.5 | 非法字符 / Windows 保留名拦截 | A | `invalid_and_reserved_names_are_rejected` | 一致 |
| 4.6 | 多级撤销 + 重启后仍可撤销 | A | `journal_survives_restart_for_undo`；e2e 06b–06e | 原版称「无限次」（旧版 9999），未实证；我们多级 + 持久，接近 |
| 4.7 | 操作历史抽屉（时间/批次/影响数/不可撤销原因） | A | e2e 06b–06e 截图与断言 | 原版仅「撤销上次」，无可视化历史；领先 |
| 4.8 | 覆盖备份（`data/backups/<batch>/`，撤销可还原） | A | Rust 撤销测试 | 原版有备份还原；持平；备份被外部删除则不可还原（已知限制） |
| 4.9 | 快照（生成 / 查看 / 还原） | A | 方案 C：默认只存「原名 → 新名 + 大小 + 修改时间」，勾选后才逐条算 SHA-256；还原严格只改回原名，冲突/已变化/路径非法逐条跳过且绝不覆盖；还原写 kind=`restore` 批次，可整批撤销。Rust 5 条真实文件测试（中文名 / 无扩展名 / 占用跳过 / 哈希不符 / 大小变化）+ 浏览器 e2e 11 条。真产物：快照 JSON 648~879 B、还原批次 JSON 859 B；`sha256` 与 PowerShell `Get-FileHash` 对拍一致 | 原版 #23/#24 另有目录树模拟与导出；我们未做快照另存为独立文件（仍可后续加） |
| 4.10 | 命令列表 / 批处理保存载入 / 最近文件 | A | 「更多 → 命令」：把规则链 + 冲突策略存成命令，按最近使用排序，最多 30 条；「套用」只载入，「运行」载入后进预览确认；记运行次数与上次运行时间；`app/src/lib/commands.ts` + e2e 5 条（空态/保存/重载持久化/运行进确认/删除同步存储） | 原版另有命令列表页签与「最近文件」独立入口；我们用「更多 → 命令」+ 方案库的最近目录覆盖高频场景，未做独立页签与最近文件列表 |

## 域五 元数据编辑

| # | 功能 | 状态 | 验证证据 | 与商业标杆的差距 |
| --- | --- | --- | --- | --- |
| 5.1 | 图片 JPEG / PNG / WebP / TIFF 十一字段读写清空（七通用字段 + IPTC Core 的 Headline / By-line Title / Credit / Source；JPEG 上四字段 XMP + IPTC-IIM 双写，见 5.15） | A | `verify_meta.py` 270 项 + `metaedit::image` 8 项 + IPTC-IIM 6 项；真实 JPEG/PNG 回读四字段一致；JPEG 的 APP13 8BIM `2:105/2:85/2:110/2:115` 由 `npm run test:iptc` 用 Pillow 独立回读校验 | 原版 EXIF/IPTC/XMP 三套标签更细；PNG/WebP/TIFF 无 IIM 载体，四字段仍只写 XMP（不做伪 IIM） |
| 5.2 | EXIF / GPS / ICC 原样保留（只改选中字段） | A | 改前改后 Pillow/ffprobe 对照；GPS/ICC 保留断言 | 原版也强调保留；持平 |
| 5.3 | 写前备份 + 可撤销（`.bak.<ms>`） | A | 备份字节一致、restore 字节还原 | 原版有备份还原；持平 |
| 5.4 | HEIC / HEIF | A | `renomio-core/src/heif.rs` 只读解析：品牌判定、`ispe` 尺寸、`pixi` 位深与通道、`hvcC` 色度采样与位深回退、`auxC` alpha 平面、`irot` 旋转、`iloc`/`iinf` 取 Exif 项并定位 TIFF（拍摄时间/相机/镜头）；`bridge.ts` 仍 `writable:false`，写回明确拒绝并给文件与原因 | 原版支持 HEIC（推测经第三方库）；本版只读不写（2026-11-27，alpha25） |
| 5.5 | GIF / BMP / AVIF | A（只读） | GIF：版本、逻辑屏尺寸、全局调色板色数、帧数、动画与否、NETSCAPE 循环次数、注释扩展、逐帧延时之和（不足 1 秒带小数）；BMP：头部类型（CORE / INFO / V2 / V3 / V4 / V5）、尺寸（负高度取绝对值并标「自上而下」）、位深、压缩方式（BI_RGB / RLE8 / RLE4 / BITFIELDS / JPEG / PNG / ALPHABITFIELDS）、DPI（像素每米换算）、调色板色数；AVIF：走 ISOBMFF 盒子（`ftyp` 品牌 + 兼容品牌、`meta/iprp/ipco` 里的 `ispe` 尺寸、`pixi` 通道与位深、`av1C` 位深、`auxC` 的 alpha 平面、`moov/trak/mdia/minf/stbl/stsz` 的采样数即帧数，`avis` 视为动画）。全部**只读**；读不到就不给（截断给截断位置，找不到 `ispe`/`pixi` 明说「尺寸未知」「位深未知」）。守卫：`tests/image_container_contract.rs` 13 条 + `image_container` 单测 3 条，夹具全部现场构造最小 GIF/BMP/AVIF 字节（含 64 位盒长与截断用例） | 原版支持部分格式（写标签）；本版先把容器参数读全，写入仍不做 |
| 5.6 | MP3 ID3v2.3 / 2.4（中文/日文、COMM/USLT 同步、保留其它帧） | A | `verify_meta.py` 音频段；Rust `USLT` 往返；ffprobe 回读 `lyrics`、ffmpeg 音频 md5 不变 | 原版音乐标签支持歌词/封面/进阶；我们已补歌词，仍无进阶字段 |
| 5.7 | FLAC / OGG（Vorbis comment 的 `LYRICS` 键；FLAC 原生 PICTURE 兼容 ffmpeg pic_type=0） | A | Rust `LYRICS` 往返 + ffprobe 回读 `lyrics` | 原版有歌词/封面；我们封面/歌词/字段均覆盖 |
| 5.8 | M4A / MP4（iTunes ilst atoms，含 `©lyr`） | A | 同上 | 原版支持多媒体标签；持平（字段更少） |
| 5.9 | OGG (Vorbis) / Opus（注释头重建、framing bit、页序号重排） | A | 同上；能力表拆分为两行 | 原版支持 OGG；持平 |
| 5.10 | 封面读写（读/换/清） | A | 音频/图片段断言 | 原版支持封面；持平 |
| 5.11 | WMA / APE / WAV / AIFF | A（只读） | 四种容器全部读出来：WAV 读 `fmt`（采样率/声道/位深）+ `data` 长度算时长 + `LIST/INFO`（标题/艺术家/专辑/年份/流派/备注/音轨/软件，含**写在文件末尾**的标签）+ RF64 的 `ds64` 大文件；AIFF/AIFC 读 `COMM`（含 80 位扩展浮点的采样率）+ `NAME`/`AUTH`/`(c)`/`ANNO` 文本块与压缩类型；APE 读 `MAC ` 头描述符 + 头数据未压缩时的内嵌 WAV 头（采样率/声道/位深/时长）+ 文件末尾 APEv2 标签（标题/艺术家/专辑/年份/流派/音轨/作曲/备注）；WMA 读 ASF 文件属性（时长，扣除 pre-roll）/流属性（采样率/声道/位深）/内容描述与扩展内容描述（标题/作者/专辑/流派/年份/音轨）。全部**只读**，不写回；读不出来的量返回空并给具体原因（如 APE 头数据被压缩时明说「需要解码器」），绝不用默认值糊过去。守卫：`tests/audio_container_contract.rs` 11 条 + `audio_container` 单测 3 条（`cargo test` 三平台都跑），夹具全部现场构造 | 原版支持 WMA/APE 读写；本版先把读补齐，写入仍不做（写入要重算帧索引与标签体积，风险高） |
| 5.12 | DOCX / XLSX / PPTX core properties（7 字段，只改 `docProps/core.xml`） | A | `verify_docs.py` 70 项断言 + Office COM 打开校验（无修复提示） | 原版 Office 摘要字段更全（公司/经理/模板等）；我们 7 字段 |
| 5.13 | PDF Info + XMP（Title/Author/Subject/Keywords，增量更新，页面逐字节保留） | A | pypdf strict + 原始字节前缀保留 + 页数/文本不变 | 原版 PDF 属性；我们 Info+XMP 同步，领先 |
| 5.14 | 旧版 OLE（.doc/.xls/.ppt）、加密 PDF、xref 流 PDF | A（OLE + xref 流 PDF + 加密 PDF 识别已落地） | OLE：按根存储 CLSID 与流名认出 Word / Excel / PowerPoint / Visio / Publisher / Outlook 邮件 / MSI 安装包 / 加密 OOXML，文档类读 `\x05SummaryInformation` + `\x05DocumentSummaryInformation`（标题·主题·作者·关键词·备注·模板·最后修改者·修订号·创建与保存时间·页数·字数·字符数·生成应用·类别·经理·公司），窄字符串按码页解码（`encoding_rs` 内置码表，GBK/Shift-JIS/Big5/1250-1258 等），认不出的码页按 latin-1 兜底；读不了的容器明确拒并给具体原因（安装包/邮件/加密包/未知流名各一条），结构损坏给「结构读取失败：<原因>」而不是「尚未实现」。PDF：新增 `renomio-core/src/pdf.rs` 作为唯一只读解析点，经典 xref 表与 PDF 1.5+ xref 流都能读（`/W` 三列、缺省 type 列按 1、`/Index` 缺省 `[0 Size]`），`FlateDecode`（zlib 失败回退 raw deflate）、PNG 预测器 10–15（Sub/Up/Avg/Paeth）、`ASCIIHexDecode`/`ASCII85Decode`，`/Prev` 链最多 16 段且新段优先；`/ObjStm` 对象流按 `/N` 头对「对象号 偏移」+ `/First` 切片；Info 字段支持字面串/十六进制串/间接引用一层，文本按 `FE FF` UTF-16BE、`EF BB BF` UTF-8、合法 UTF-8、latin-1 依次解码，日期 `D:20261127024900+08'00'` 规整成 `2026-11-27 02:49:00 (+08:00)`；页数走 `Catalog /Pages /Count`；加密读 `/Encrypt` 的 `V`/`R`/`/CF /CFM` 只报算法（RC4 40/128、AES-128、AES-256）并说明「没有密码读不到元数据字符串」，不解密、不填默认值 | 原版支持旧版 Office；加密 PDF 只识别算法、不解密，xref 流 PDF 只读、写回仍限经典 xref |
| 5.15 | IPTC Core 四字段（Headline / By-line Title / Credit / Source；XMP + IPTC-IIM 双写） | A | 真实 JPEG 端到端：`metaedit_probe` 走生产写路径写入，再用 Pillow `IptcImagePlugin` 独立回读 APP13 8BIM，4 个 dataset（2:105 / 2:85 / 2:110 / 2:115）逐一比对；非 ASCII 自动插 `1:90 ESC % G` 声明；清空字段删 dataset、全清则 APP13 整段消失；XMP 同步写、EXIF 与像素不变；未知 dataset / 非 Photoshop 的 APP13 / 0x040C 缩略图资源原样保留；过期 0x0406 摘要移除；`npm run test:iptc` 45 条（静态 28 + 真实文件 16 + 汇总） | 原版 #16 同时写 IPTC-IIM——已对齐；文本编码/内容批量（#17）仍未做 |

## 域六 方案、导出与系统能力

| # | 功能 | 状态 | 验证证据 | 与商业标杆的差距 |
| --- | --- | --- | --- | --- |
| 6.1 | 方案（规则链）导出 / 导入 / 不兼容提示 | A | e2e 09–11 截图与断言 | 原版有方案导入导出与对照列表；我们方案为 JSON，无对照列表 |
| 6.2 | 多格式导出（CSV / TSV / HTML / Excel `.xlsx`，旧名/新名/状态/原因；覆盖前备份） | A | e2e 4 条（菜单四项；CSV 表头+冲突原因；TSV BOM+4 列且行数与 CSV 一致；HTML 完整文档+转义+中文表头；xlsx ZIP 头+workbook/sheet+中文单元格）；真实产物校验：`report.xlsx` 5077 字节、6 个 ZIP 条目、4 行、中文单元格与 sheet 名 `Report`，HTML 1777 字符，TSV 274 字节 | 原版另有 RTF；我们未做 RTF（富文本收益低），其余格式已对齐 |
| 6.3 | 文件属性修改（只读/隐藏/系统/归档，设置/清除/取反/保持） | A | Rust `ops_fs` 属性 3/3（设置/清除/取反、只读+隐藏、每次写入 before 备份、撤销还原）；浏览器 e2e 160/160（面板三态与预览/撤销） | 系统/归档属性未做；属性备份是批次日志内的逐文件 before/after，无独立「属性备份库」供跨批次还原 |
| 6.4 | 时间属性修改（创建/修改/访问；统一/自身/表达式） | A | Rust `time_` 8/8（平移重复执行累加、随机区间内确定值、EXIF 写入真实 JPEG）；Rust/前端 FNV 向量一致；浏览器 e2e 160/160 | 原版的表达式/脚本式时间规则未做；EXIF 拍摄时间仅图片支持，且不随批次撤销回滚 |
| 6.5 | 文件归类移动（按规则/变量，预览，只建文件夹） | A | Rust `ops_fs` 移动 5/5（嵌套目录创建、不覆盖、撤销清理）；浏览器 e2e 167/167（模板多级目录、非法变量拦截、应用与撤销）；真实文件校验：`春节 合影.jpg`/`无扩展名`/`IMG_0001.JPG` 按 `<EXT>/<DATE:yyyy>/<SUBSTR:1:2>` 落到 `jpg\2025\春节\`、`2024\无扩\`、`JPG\2025\IM\`，撤销后原目录还原、新建目录清空 | 原版 8 页签命令组 + `#0~#9` 编号变量；模板/多级目录/撤销归类已对齐，编号变量与命令页签仍缺 |
| 6.6 | 明 / 暗主题 | A | 截图 `07-dark-theme`、`main-light/dark` | 一致 |
| 6.7 | 5 语言（zh-CN / zh-TW / en-US / ja-JP / es-ES） | A | e2e 19 三语截图 + 5 份 locales 同步 | 原版仅中文；领先，但 es/ja 未人工校对 |
| 6.8 | 设置持久化（localStorage） | A | e2e 设置项断言 | 原版 INI 配置；我们 localStorage，无导入导出 INI |
| 6.9 | 检查更新 / 自动更新（签名校验） | A | alpha7/8 更新链路实测；`update.rs` | 原版 WinINet 升级组件；我们 Tauri updater + 签名，领先 |
| 6.10 | 快捷键（Ctrl O / Ctrl Shift O / Ctrl K / Ctrl Enter / Ctrl Z） | A | 键位窗 5 条绑定可查看/录制/恢复默认；冲突检测（占用时提示并拒绝）；Esc 分层（录制中只取消录制）；绑定持久化并在刷新后生效；e2e 9 条断言（列表、默认值、录制、冲突、Esc、持久化、旧键失效/新键生效、恢复默认） | 原版快捷键列表窗已对齐；暂不支持无修饰键（如 F2）绑定，避免与输入冲突 |
| 6.11 | 跨平台 macOS / Linux | A | `platform::PlatformReport` 是平台差异的**单一事实来源**（OS/分隔符/大小写默认/路径阈值与硬上限/btime 三态+原因/「隐藏·系统·存档仅 Windows」+原因/长路径前缀）；`tests/platform_contract.rs` **11 条**逐 OS 断言（含只读位真实往返、非 Windows 属性写入必须逐条失败并带原因、Windows 名称规则与宿主无关）；`examples/platform_probe.rs` 输出 JSON，`npm run test:platform` 在宿主 OS 逐字段比对；CI 新增 `cross-os` 矩阵（**ubuntu-latest / windows-latest / macos-latest**）跑同一份 core 测试 + 平台契约 + 探针（三平台实跑记录见本轮 tag CI 的 `cross-os` 三个 job） | 原版仅 Windows；我们代码与测试三平台齐备，**但只在 CI 无头环境实跑**（macOS ad-hoc 未公证、Linux 未做桌面真机手工点验） |
| 6.12 | 便携模式（U 盘）：程序旁放 `renomio.portable` 即把配置、批次记录、撤销历史与备份挪到 `<程序目录>/data`；`--data-dir <路径>` 与 `RENOMIO_DATA_DIR` 可再覆盖；标记在但目录不可用时回落到每用户目录并给出原因 | A | `renomio-core/src/datadir.rs`（四级优先级 + 标记 + 真实可写探针）、`tests/datadir_contract.rs` **11 条**（优先级、真实落盘、回落原因、CLI 解析、序列化、EnvInfo 三字段）、`examples/datadir_probe.rs` 与 `npm run test:datadir` **44 条**（真跑探针 5 个场景 + 接线 + 文档同源）；界面设置 › 运行环境显示「数据目录 / 来源 / 便携说明」；`migrate::info_skipped` 保证便携或覆盖时不自动迁移旧数据 | 原版 #32/#33 的便携/免安装；我们按标记文件实现，未做免安装压缩包分发与 INI 导入导出 |
| 6.13 | 资源管理器右键菜单 / 快捷方式 / 自我修复 / UAC 工具 | E | 无实现 | 原版 #32/#33；本版不做（INI 导入导出已拆出 6.14、数据目录自检与修复已拆出 **6.15** 并实现） |
| 6.14 | 设置导入导出（`.ini`） | A | `renomio-core/src/ini.rs` 是唯一编解码实现：顶层标量进 `[@root]`、对象/数组各自分节、点路径与 `[i]` 下标、`{}`/`[]` 保留空容器、会被读错类型的字符串自动加引号、注释 `;`/`#` 与 CRLF/BOM 容忍、重复键与下标乱序/跳号**带行号拒绝**；`tests/ini_contract.rs` **15 条**（真实设置形状往返、空容器、伪标量字符串、坏文件逐条报错、顶层数组分节、按钮不走旁路）、`examples/ini_probe.rs` 与 `npm run test:ini` **66 条**（真跑探针往返/手写文件/6 类坏文件/两次导出字节一致 + 接线 + 五语种文案 + 文档同源）；Tauri 命令 `settings_to_ini` / `settings_from_ini`，前端导入按 `DEFAULT_SETTINGS` 形状做**白名单校验**（未知键/类型不符/坏规则条目丢弃计数），设置 › 设置文件两个按钮 + 五语种文案；CI `cross-os` 三平台各跑契约与脚本 | 原版用 INI 存配置；我们补的是**可读可手改的设置导入导出**，与 localStorage 持久化并存；`self-repair`/快捷方式/右键菜单仍属 6.13 未做 |
| 6.15 | 数据目录自检与修复（原 6.13 的「自我修复」拆出） | A | `renomio-core/src/repair.rs` 单一实现：`check(root)` 只读扫描、`fix(root, now_ms)` 按发现逐条修；10 个稳定发现码 `missing-root` / `root-is-file` / `missing-dir` / `bad-batch` / `batch-id-mismatch` / `bad-snapshot` / `snapshot-id-mismatch` / `bad-rule-history` / `leftover-temp` / `orphan-backup`，每条带 `severity` 与 `fixable`；修复语义是**只隔离不删除**（坏文件移到 `repair-quarantine/<时间戳>/<原相对路径>`，同名冲突加 `.1`…`.99`）、只清理**超过 24 小时**的自己写的 `*.tmp`/`*.json.tmp`、幂等（第二次 `fix` 不再动手、`ok=true`）；批次与快照按真实结构反序列化并比对**文件名与内部 id**，`rule-history.json` 只认顶层数组/对象；`repair.rs` 内 10 条单测 + `tests/repair_contract.rs` **15 条** + `examples/repair_probe.rs` 与 `npm run test:repair` **90 条**（12 组探针场景 + 接线 + 五语种文案 + 文档同源）；Tauri 命令 `data_dir_check` / `data_dir_repair`，设置 › 数据自检与修复两个按钮 + 五语种文案（发现码逐条翻译）；CI `cross-os` 三平台各跑契约与脚本 | **不删用户数据**是硬约束：坏文件一律进隔离区可人工取回；孤儿备份只提示不动手；跨盘迁移旧数据的自动接管仍不做（仍需手工导入） |

---

## 需要你拍板（取舍项）

1. **HEIC/HEIF 是否转码支持**：需引入 libheif/ImageMagick/ffmpeg 之一，安装包会增大约 15–40 MB，且 HEIC 专利/许可需确认；只读解析已就位（alpha25），写入与转码仍维持「明确拒绝」。
2. **WMA / APE / WAV / AIFF 的标签写入**：读已经补齐（alpha23），写入要重算 APE 帧索引、重排 ASF 对象、重建 RIFF 尺寸，工作量大且容易损坏文件；建议本版只读、继续不做写入。
3. ~~正则方言~~：当前 JS 方言（`$1`），对标产品用户习惯 Delphi 正则（`\1`）。是否增加「兼容模式」做 `\1` → `$1` 自动转换？会增加规则语义分支。
   —— **已解决**：采用自动转换（不开额外开关，正则开启时 `\1..\9` 一律按分组引用处理，`\\1` 表示字面），并对「引用分组超出正则实际分组数」就地报错；见 `rules.ts` `convertBackslashRefs` 与 `npm run test:regex`。
4. ~~CSV 导出格式~~：已补 TSV / HTML / `.xlsx`（自写无依赖 ZIP + OOXML inlineStr，不引入表格库），仅不做 RTF。
5. ~~**快照**：是否实现「生成 / 查看 / 还原」~~——已按方案 C 落地（默认名称映射 + 可选 SHA-256，还原可撤销、绝不覆盖）。
6. ~~命令列表 / 批处理~~：是否单列入口与「最近文件」，还是继续用方案 JSON 承载？
   —— **已落地（方案 C 折中）**：单列「更多 → 命令」入口，命令 = 规则链 + 冲突策略 + 运行次数/上次运行时间，最多 30 条、按最近使用排序；「运行」始终先进预览确认。最近文件仍用方案库里的「最近目录」，不另开列表。
7. **智能更名完整策略面板**：是否补齐阈值、空名、系统属性、只读、超长的可配置策略；会显著增加预览/执行分支。
8. **元变量体系**：是否实现 `<NAME>/<EXT>/<DIR>/<CRC32>/<MD5>/<SHA1>/<SIZE>/<USERn>` 全套；这是与商业标杆差距最大的规则能力。
9. ~~文件属性「取反」与属性级备份~~：已补取反三态与撤销还原（域六 6.3，1.1.0-alpha1）；独立跨批次属性备份库仍未做。
10. **macOS / Linux 首发**：是否投入实机验证、签名/公证；当前只有代码层分支。
11. **版本闸门**：现有规则 alpha 序号 ≤ 10，`1.0.0-alpha11` 会被 `version:check` 拒绝。需二选一：
    - A. 放宽 alpha 上限（如 99），minor/patch 仍 ≤ 10，然后发 `1.0.0-alpha11`；
    - B. 遵守现有闸门，改发 `1.0.1-alpha1`（新 minor 系列的第 1 个 alpha）。
12. **es-ES / ja-JP 翻译校对**：当前机器翻译级文案，是否安排人工校对后再宣称「完整本地化」。

## 本版不做（含理由）

| 项 | 理由 |
| --- | --- |
| HEIC/HEIF、GIF/BMP/AVIF 的写入 | 无自研编码器；引入第三方库会显著增大包体并带来许可问题；HEIC/HEIF、GIF/BMP/AVIF 都已补只读解析，写入仍宁可明确拒绝 |
| WMA/APE/WAV/AIFF 标签 | 读已补齐（alpha23，四种容器全覆盖）；写入仍不做，界面标注「只读」，不静默跳过 |
| 旧版 OLE（.doc/.xls/.ppt） | 二进制复合文档写入风险高；旧版文件可由用户另存为新格式 |
| 加密 PDF、xref 流 PDF | 加密需密钥与算法；xref 流解析复杂度高，增量写入易损坏 |
| 资源管理器右键 / 快捷方式 / UAC 工具 / 自我修复 | 平台集成与安装器成本高，非核心价值（便携模式 6.12、设置导入导出 6.14、数据目录自检与修复 6.15 已单列并实现） |
| 脚本 / 编码转换 / 内码 / 加密 / 对照表高级规则 | 原版 Delphi 特性，重实现成本高且易出错；先保证核心规则链稳定 |
| 「无限次」撤销 | 磁盘备份策略与清理规则未定；当前按批次保留备份，可多级撤销 |
| macOS/Linux 实机验证 | 无 mac/linux 环境；代码分支就绪但不敢宣称通过 |
| 文本编码/内容批量（#17） | 与现有元数据模型差异大，需单独设计；IPTC-IIM 写入已补（5.15），本项只剩文本编码与内容批量 |

## 对账中新发现、已补入本表的缺口

- ~~元变量体系缺失（仅 `<#>`）~~——已补齐 `<FILENAME>/<SUBSTR>/<DIFNSUBSTR>`（域二 2.8，1.1.0-alpha1）；仅余右键菜单形态差异。
- ~~「智能更名」策略面板缺失~~——已补设置 → 名称安全四项策略与 `e2e/policy.mjs`（域三 3.12，v1.0.0 起生效）。
- ~~文件属性「取反」与属性级备份缺失~~——已补取反与撤销还原（域六 6.3）。
- ~~时间属性缺 EXIF 时间/随机/再调整~~——已补（域六 6.4，1.1.0-alpha1）。
- ~~归类缺变量与「撤销归类」~~——已补变量模板与多级目录、撤销沿用 move 批次（域六 6.5，1.1.0-alpha1）。
- ~~快捷键无自动化验证、无键位列表窗~~——已补键位窗与自定义绑定（域六 6.10，1.1.0-alpha1）。
- ~~多格式导出（Excel/HTML/RTF/TSV）缺失~~——已补 TSV/HTML/`.xlsx`（域六 6.2，1.1.0-alpha1）；RTF 不做。
- ~~自动编号缺分组/排除/按路径/USER 变量~~——已补 `groupBy`/`exclude`/`byPath`/`writeVar` 与 `e2e/number-advanced.mjs`（域二 2.7）。
- ~~大小写规则缺例外词表~~——已补 `protect`（`*`/`?` 通配、大小写不敏感、六模式生效）与 `npm run test:case`（域三 3.5）。
- ~~界面层遗留（死样式 / toast 压抽屉 / 状态列对齐）~~——已清零：删 105 个死选择器并加 `npm run test:css` 守卫；toast 改为让位式（抽屉左移 + 检查器抬升）；表头/行 7 列几何断言 Δ=0（2026-11-25，alpha6）。
- ~~按元数据取名只有 6 个字段（拍摄时间/相机/标题/艺术家/专辑/曲目）~~——已扩到 **17 个**：新增 EXIF `ISO/光圈/快门/焦距/镜头`、`像素宽/高/像素尺寸`（无 EXIF 时回退图像尺寸）与音频 `年份/流派/作曲`，取值统一做文件名安全化（`/ : * ? " < > |` → `-`）。顺带修掉 EXIF 解析的真缺陷：SHORT 值（ISO / 方向）此前无视 TIFF 字节序，大端相机读成错值、小端读成 0（域三 3.8，2026-11-25，alpha7）。
- ~~移动子串只有「第几个字符起、取几个」的按位置定位~~——已补 **按标记**（取左右标记之间的内容，留空即不设边界，标记找不到整条跳过）与**插入到目标之前/之后**（同一目标位差一位，可精确决定落点左右），旧存档规则自动按 `by=index`/`insert=before` 兜底，语义与旧行为一致（域三 3.6，2026-11-25，alpha8）。
- ~~扩展名规则没有「智能分析」~~——已补：Rust 侧按**文件头魔数**（前 64 字节，不解码内容）识别 20 种格式，前端扩展名规则新增 `analyze` 模式，预览时用嗅探出的真实扩展名纠正错标；**识别不出、文件头过短、目录、浏览器演示模式一律保持原名，绝不按名字猜**（域三 3.7，2026-11-25，alpha9）。
- ~~删除规则「从尾部数」的起点朝向与标签矛盾，修剪只能剪空白~~——已修：`fromEnd` 的起点改为从末尾逆算并朝**词尾**延伸（旧实现把窗口结束在倒数第 N 个，等于删到词首）、「首尾之间」改用码点换算（emoji 不再被切半个）、两个标记全空时规则卡就地报错而非静默删空整名；修剪新增**自定义修剪字符集**（留空仍只剪空白，旧存档语义不变）（域三 3.4，2026-11-25，alpha10）。
- ~~IPTC Core 四字段只写 XMP，读 IIM 的老软件看不到~~——已补 **IPTC-IIM（APP13 8BIM 0x0404）双写**：JPEG 上 Headline/By-line Title/Credit/Source 同时写进 XMP 与 IIM，新软件读 XMP、老软件读 IIM，两边一致；非 ASCII 自动声明 `1:90 ESC % G`；未知 dataset、别家的 APP13、缩略图资源原样保留；改动 IIM 后丢弃过期 `0x0406` 摘要交给 Photoshop 重建（域五 5.15，2026-11-25，alpha11）。
- ~~跨平台 macOS / Linux 只有代码分支、没有实机验证~~——已补：`platform::PlatformReport` 统一承载全部平台差异（OS/分隔符/大小写默认/路径警告与硬上限/btime 三态及原因/「隐藏·系统·存档仅 Windows」及原因/长路径前缀），`tests/platform_contract.rs` 11 条逐 OS 断言（只读位真实往返、非 Windows 属性写入必须逐条失败并带原因、Windows 名称规则与宿主无关、`\\?\` 不重复叠加），`examples/platform_probe.rs` 与 `npm run test:platform` 在宿主 OS 逐字段比对，CI 新增 `cross-os` 矩阵在 **ubuntu / windows / macos 三个真实 OS** 各跑一遍 core 测试。顺带修掉 README 一处「看着对实际不对」：非 Windows 的属性写入并非 no-op，而是逐条失败并给原因（域六 6.11，2026-11-25，alpha12）。
- ~~U 盘便携 / 数据目录只能写死在每用户目录~~——已补 **便携模式**：程序旁放 `renomio.portable` 就把数据目录切到 `<程序目录>/data`，另可用 `--data-dir <路径>` 或 `RENOMIO_DATA_DIR` 覆盖（优先级：命令行 > 环境变量 > 便携标记 > 每用户目录）；便携标记在但 `data` 建不出来（同名文件/无写权限）时**回落到每用户目录并把原因写进 `dataRootNote` 交给界面显示**，不静默丢数据。数据目录解析收敛到 `renomio-core/src/datadir.rs`，`tests/datadir_contract.rs` 11 条 + `npm run test:datadir` 44 条（真跑 `datadir_probe` 的 5 个场景），CI 的 `cross-os` 三平台各跑一遍；便携/覆盖时 `migrate::info_skipped` 跳过自动迁移，旧数据目录保留可手动导入（域六 6.12 拆分并置 A，2026-11-25，alpha13）。
- ~~更新通道在 alpha9 装机上失效~~——已修：版本比较改由 `renomio_core::version` 唯一实现，`alpha` 序号按**数值**比较（`alpha9 < alpha10 < alpha13`）；旧实现把整段 `alphaN` 当 semver 字母数字标识符做字符串比较，`alpha10 < alpha9`，于是装在 1.2.0-alpha9 的客户端永远认为已是最新。新增 `tests/version_contract.rs` 11 条、`examples/version_probe.rs` 探针、`npm run test:update` 与 CI `cross-os` 三平台各跑一遍（2026-11-25，alpha14）。
- ~~设置在换机器 / 手改时无处可搬~~——已补 **设置导入导出 `.ini`**（域六 6.14）：导出把整份设置（外观、名称安全策略、USER 变量、快捷键、列宽、规则链、布局）编成一行一键值的文本文件，导入时由 Rust core 解析（语法错误带行号），前端再按默认设置的形状做**类型白名单**，未知键、类型不符与被丢弃的坏规则条目都计数回显——不会出现「导进去一半把界面搞坏」。导出-再导入逐键一致由 `tests/ini_contract.rs`（15 条）与 `npm run test:ini`（66 条）守住。
- ~~数据目录坏了没人知道、也不敢修~~——已补 **数据目录自检与修复**（域六 6.15，从 6.13 的「自我修复」拆出）：设置页两个按钮，先只读扫描（缺失子目录、损坏的批次/快照、损坏的输入历史、残留临时文件、孤儿备份），每个发现带稳定 `code` 与严重度，界面按 code 翻译；修复只做三件事——建缺失目录、把坏文件**隔离**到 `repair-quarantine/<时间戳>/…`（不删除，可人工取回）、清理**超过 24 小时**的自己写的临时文件；孤儿备份只提示不动手。幂等由 `tests/repair_contract.rs`（15 条）与 `npm run test:repair`（90 条）守住，CI 的 `cross-os` 三平台各跑一遍。
- ~~列宽只能手动拖、长文件名要自己算~~——已补 **自动列宽**（域一 1.5）：算法收在 `src/lib/columnFit.ts` 的纯函数里（文本测量由调用方注入，浏览器用 canvas + 行内真实字体，测试用假测量器），表头分隔线**双击**即按该列真实内容（含表头文案）自适应，列菜单「自动列宽」一次算好全部可见列；宽度夹在 `COLUMN_MIN`…`COLUMN_MAX` 之间（单行超长名不会把表挤爆）、写入 `settings.columnWidths` 持久化，列表为空时给提示而不是算出一堆下界。`npm run test:columns` 56 条（Node 类型剥离直接实跑 + 接线 + 五语种 + 文档同源），e2e 新增 6 条（菜单项存在、双击后宽度变化且落在上下界内、其他列不动、持久化、重置恢复默认、表头与行仍逐列对齐）。顺手修掉一个**列宽预算漏算内边距**的真实缺陷：列收敛只按 `.table` 宽度算可用空间，忘了 `.thead/.trow` 两侧各有 `--ds-space-5`（12px）内边距，1280×800 下六列全开时内容 674px + 内外边距顶到 686px、被挤出 6px 横向滚动条；现在预算统一扣 `LIST_PAD = 24`，窄窗按 `COLUMN_RANK` 收起次要列（位置列最后走），e2e 349 条全绿（2026-11-25，alpha17）。
- ~~正则替换只在单测里验证过、没在真实文件上跑通~~——已补（域三 3.3 从 B 升 A）：① 语义补齐 Delphi 方言 `\0` = 整段匹配（等价 `$&`，不需要捕获组），`\\0` 仍是字面；② 修掉一个**静默出错名**的真实缺陷——「只替换第 n 个匹配」走 `String.replace` 回调形式，返回值不会被解析 `$1`/`$&`，替换串写 `\1` 会把字面 `$1` 写进文件名；现在改为按 `exec` 命中的分组自行展开（零宽正则手动推进 `lastIndex`，不死循环）；③ 新增 `renomio-core/examples/plan_probe.rs`：把前端算好的改名计划交给**真实的 core 两阶段改名**执行，`--undo` 走真实撤销；④ 新增 `npm run test:regex:real` **21 条真实文件闭环**：真实规则引擎（esbuild 打包 `src/lib/rules.ts`）算新名 → 计划 JSON → core 改名 → 回到 Node 核对磁盘（文件名/目录名/逐字节内容/未命中文件原样）→ 真实撤销核对还原，覆盖文件、目录、`\0`、nth 两种场景；CI `cross-os` 三平台各跑一遍；⑤ `npm run test:regex` 18 → 28 条、e2e 4 → 6 条（`\0` 整段、第 2 个匹配展开）。
- ~~「执行筛选」根本没有入口，只写在清单里~~——已补（域一 1.3 补齐声明）：筛选条件旁内联「仅保留匹配」按钮（填了条件才出现，Enter 等效执行、Esc 清空当前框），执行逻辑收进 `src/lib/patternFilter.ts` 纯函数（保留/排除叠加、大小写跟随设置、分号或换行分隔）；**一条都不匹配时不动列表**并提示，避免一次点击把列表清空；更多菜单里原来那个只把光标丢进输入框的「筛选」项已删除，旧文案随之清掉。条件分割此前只认 `;`/`|`，而占位符却写空格分隔——现在换行也能分隔，占位符改成 `*.jpg;*.png` 与实现一致。`npm run test:filter` 23 条（纯函数实跑 + 接线 + 文档同源）、e2e 新增 7 条（按钮出现条件、空匹配不清表、全匹配保留数、Enter 等效、Esc 收起、更多菜单无筛选项），CI `frontend` 一步（2026-11-25，alpha18）。
- ~~「高级规则」整组只停在「本版不做」~~——已补其中 **对照表**（域三 3.13 从 E 部分落地）：新规则类型 `map`，表格一行一条「旧=新」，`=` 或制表符作分隔、`#`/`//` 开头为注释、空行忽略，`\=`/`\\`/`\s` 转义，键值两侧空白自动去掉（要留空格写 `\s`），大小写敏感可切；解析与替换收在 `src/lib/mapTable.ts` 纯函数（`parseMapTable` / `applyMapping`）。替换语义是**单遍最长匹配**：每个位置取最长键（同长取表里靠前），插入的新词不再参与扫描，所以 `A=B`、`B=C` 不会连锁成 `A=C`，也不会死循环；新词留空即删掉命中的片段；只改文件名主干，扩展名与目录结构不动，目录名同样适用。表有坏行（缺分隔符 / 旧词空 / 旧词重复 / 超 500 条）时规则卡就地报错并给出**行号**，且该规则不参与求值；编辑器给实时错误列表与「已识别 N 条」计数。`npm run test:map` 70 条（纯函数实跑 + 引擎接线 + 五语种 + 文档同源）+ e2e 4 条（2026-11-25，alpha19）。
- ~~跨盘移动碰到符号链接/目录联接要么拒绝、要么静默把链接变成副本~~——已修（不属于表内任何一行，属「静默出错」类真实缺陷）：旧语义三处都错——①目录内只要有链接，`copy_dir_all` 就直接 `Unsupported`（「目录中包含符号链接或联接，跨盘移动暂不支持」，整目录搬不动）；②顶层链接走 `fs::copy` 会**跟随目标**，把链接实体化成目标内容的普通副本、再删掉源链接（文件名还在、语义没了）；③删除用 `exists()` 判断，**悬空链接**被当成「不存在」而不删，Windows 目录联接用 `remove_file` 又删不掉。现在统一按 `EntryKind{Link,Dir,File}`（`symlink_metadata` 先判 `is_symlink`，联接算链接，`move_path` 不再信任前端传来的 `is_dir`）处理，链接**一律不跟随**：复制用 `copy_link` 在原位重建同类链接（Unix `symlink` 原样保留相对目标；Windows 先 `symlink_dir`/`symlink_file`，落不下来才退化为目录联接 junction），校验新增 `compare_links`（先比「是不是链接」再比目标，Windows 退化成联接时用 `canonicalize` 判同一目标），删除只删链接本身（目录链接先 `remove_dir` 再回落 `remove_file`）。**两个平台坑**：Windows `symlink_dir` 会**报 1314「客户端没有所需的特权」但链接其实已建好**，不看落地状态就去建联接会一路撞「已存在」；手写 `REPARSE_DATA_BUFFER` 在含中文目录名/长路径下会随机退化成 4392/4394（同代码一会儿成功一会儿失败），改用社区验证的 `junction` crate（`cfg(windows)` 依赖）。守卫：`tests/ops_fs.rs` 4 条（目录内链接、顶层链接含撤销、Unix 文件链接保留相对目标、Unix 悬空链接仍当链接），`ops.rs` 内 2 条 Windows 单测（半成功也要认落地 + 联接替换空占位且拒绝非空），ops_fs 18 → 20 条、core 单测 119 → 121 条（2026-11-26，alpha20）。
- ~~跨盘移动把同一个文件的多个硬链接拆成互不相干的独立副本~~——已修（同样不属于表内任何一行，与 alpha20 同族的「静默语义变化」）：`EntryKind` 只有 `Link`/`Dir`/`File`，硬链接在 `symlink_metadata` 里和普通文件长得一模一样，于是旧 `copy_dir_all` 给每个名字各 `fs::copy` 一份字节——内容是对的，但**同一份数据的多个名字变成了互不相干的副本**，之后改一个名字里的文件，另一个名字里看不到变化；搬走后用户以为还是「一个文件两个名」，实际是两份。现在复制目录树时带一份「卷号 + 文件号 → 先复制出来的路径」台账（`HashMap<(u64, u64), PathBuf>`）：Unix 用 `std::os::unix::fs::MetadataExt` 的 `dev`/`ino`（`nlink > 1` 才登记），Windows 只能走 `GetFileInformationByHandle`（`volume_serial_number` / `nlink` / `file_index` 三个方法仍是 unstable 的 `windows_by_handle`，直接用 `cargo check` 报 E0658，改成 `CreateFileW` + `FILE_READ_ATTRIBUTES` + `FILE_FLAG_OPEN_REPARSE_POINT` 手动取 `nNumberOfLinks` / `nFileIndexHigh|Low`）；命中已有台账就 `fs::hard_link` 指向那一份，**不再复制字节**，建链失败（目标卷不支持硬链接）退回普通复制，内容仍正确、只是关系不保。范围边界写清：顶层单个文件（同伴不在本次移动范围内）照旧按普通文件复制，**范围外的同伴不被牵连、也不被回写**；`nlink == 1` 的两个同内容文件**绝不合并**（否则会把独立文件粘在一起）。守卫：`tests/ops_fs.rs` +3 条（目录内三名字含子目录跨层、改一处三处同步 + 撤销后关系还原；同内容独立文件不合并；范围外同伴不受影响），ops_fs 20 → 23 条、core 单测 121 → 233 条合计 233（2026-11-27，alpha21）。
- ~~旧版 OLE（.doc/.xls/.ppt）只报「旧版 Office 文档（OLE）」+「属性解析尚未实现」~~——已修（域五 5.14 的 OLE 部分）：`.doc/.xls/.ppt/.msg/.msi` 的文件头**完全一样**（`D0 CF 11 E0 A1 B1 1A E1`），旧实现只按魔数判断，于是 Windows 安装包、Outlook 邮件、加密的 Office 包会被一律叫成「旧版 Office 文档」，属性面板再补一句「解析尚未实现」——类型是错的，承诺也是空的。现在 `renomio-core/src/cfb.rs` 是 OLE 复合文档的**唯一只读解析点**：解析头（512/4096 扇区、mini 64）、DIFAT→FAT→目录链、miniFAT 与迷你流，按根存储 CLSID 认 Word（`00020906-…`）/ Excel（`00020820-…`）/ PowerPoint（`64818D10-…`）/ Visio / Publisher / MSI（`000C1084-…`）/ Outlook 邮件（`00020D0B-…`），再按流名兜底（`WordDocument` / `Workbook` / `PowerPoint Document` / `EncryptedPackage` / `__substg1.0` / `_Tables`）。文档类读 `\x05SummaryInformation` 与 `\x05DocumentSummaryInformation`：属性集按 VT 类型解（I2/I4/LPSTR/LPWSTR/FILETIME/BOOL），窄字符串按码页解码（`encoding_rs` 的 GBK/Shift-JIS/Big5/EUC-KR/1250-1258 码表，UTF-8 直读，认不出的码页按 latin-1 兜底，**绝不把字节静默当 UTF-8**），FILETIME 转 UTC 文本、标签写明 `（UTC）`、不猜本地时区；读出来的「标题」直接进 `rename_field_values` 的 `title`（按元数据取名可用）。读不了的容器**明确拒绝并给具体原因**（安装包 / 邮件 / 加密包 / 未知流名各一条），结构损坏给「文件头声明是 OLE 复合文档，但结构读取失败：<原因>」，不再出现「尚未实现」。守卫：新增 `tests/cfb_contract.rs` 9 条，全部用**测试现场构造的最小 CFB**（每个扇区、每条 FAT/miniFAT 链都在测试里自己算，不下载样本、不靠本机 Office），覆盖 Word 认类型+摘要读全（含 FILETIME 精确到分钟）、Excel/PowerPoint 靠 CLSID 区分、**MSI 不再被叫成 Word**、MSG 与加密 OOXML 认出并拒、GBK 标题按码页解开（用编码器现造字节）、公司来自 DocSummary、损坏结构给原因不 panic、标题进取名取值且已安全化、时间换算边界；core 合计 233 → 242（cfb 契约 9 条，另含原有 121/11/15/23/11/17/15/5/4/11）。参考实现细节：CFB 头第 44 字节是 FAT 扇区数、第 48 是目录起始扇区、第 76 起是 109 个 DIFAT 项；目录项 128 字节、名字长度在偏移 64（含结尾 0）。（2026-11-27，alpha22）
- ~~GIF / BMP / AVIF 只有「尺寸」一行，AVIF 连识别都没有~~——已补（域五 5.5，只读）：旧实现里 GIF/BMP 只读逻辑屏/信息头的前两个数值，属性面板能看到的就一行「尺寸」；AVIF 因为不是 JPEG/PNG/GIF/BMP/WebP 任意一种，直接落到「未识别的文件类型」——格式名是错的。现在 `renomio-core/src/image_container.rs` 是这三种容器的唯一只读解析点。GIF 走块循环：逻辑屏（宽/高/packed）、全局调色板（`packed & 0x80` → `2^(n+1)` 色）、`0x21` 扩展（`0xF9` 图形控制读延时、`0xFE` 注释、`0xFF` 应用扩展认 `NETSCAPE2.0` 并读循环次数，0 表示无限）、`0x2C` 图像描述符计帧并跳局部调色板与 LZW 子块，`0x3B` 结束标记；**两个坑**：① 延时在子块长度字节之后**再隔一个 packed 字节**（`body+2` 而不是 `body+1`，第一版读成 `0x0400` 让 4 ms 变成 20 秒，契约测试直接抓到）；② 真实编码器的 `NETSCAPE2.0` 是「11 字节标识子块 + 3 字节循环子块」两段，按「一次读完所有子块再找循环」会把循环子块当文本吃掉。BMP 按信息头长度分流：12 字节走 OS/2 `BITMAPCOREHEADER`（宽高都是 u16），≥40 走 `BITMAPINFOHEADER` 及其 V2/V3/V4/V5 扩展；高度为负既是「自上而下」也取绝对值展示，压缩编号翻成人话，`xppm/yppm` 按 0.0254 换算 DPI，≤8 位且未压缩时给出调色板色数（`colors_used` 为 0 时按 `2^bpp`）。AVIF 是 ISOBMFF：递归走盒子（`meta` 是 FullBox，子盒从 +4 起；支持 64 位 largesize 与 size=0 到 EOF，递归深度限 12 层防畸形文件打爆栈），`ftyp` 主品牌 `avif/avis` 或**兼容品牌里带 avif**（MIAF 常见 `mif1` 主品牌）都认，读 `ispe` 宽高、`pixi` 通道与每通道位深、`av1C` 的 `high_bitdepth`/`twelve_bit` 位深（8/10/12）、`auxC` 里的 `alpha` URN 判 alpha 平面、`stsz` 的 sample_count 当帧数。读不到一律说明原因（截断给偏移、缺 `ispe` 说尺寸未知、缺 `pixi`/`av1C` 说位深未知），不填默认值。顺带修 `sniff.rs`：`ftyp` 家的 `avif`/`avis` 品牌此前被当成 `mp4`，现在认成 `avif`。能力矩阵与前端演示矩阵同步：GIF/BMP/AVIF 从 `read:false` 改为 `read:true / write:false` 并写清各自能读什么，`detect()` 的拒绝理由统一改成「只读（属性面板可读…），本版本不支持写回」。守卫：`tests/image_container_contract.rs` 13 条 + 单测 3 条，夹具全部现场构造（GIF 三帧+循环+注释+截断、BMP 24 位/8 位调色板+负高度/OS-2 头/异常头、AVIF 静帧、10 位 + alpha、avis 五帧、兼容品牌、截断、非图片字节不被误认、真文件读进 `read_metadata` 后 `rename_field_values` 的宽高可用）；core 合计 256 → 272（2026-11-27，alpha24）。

- ~~HEIC / HEIF 只有文件大小可看~~——已补（域五 5.4，只读）：`metaedit::detect()` 之前对它只给一句「需要 HEVC 解码与专用容器写入库」，属性面板只剩文件大小；而 iPhone 照片、截图、实况照片全是这个容器，里面写着尺寸、位深、色度采样、alpha、旋转和一整套 EXIF（拍摄时间、相机、镜头）。新增 `renomio-core/src/heif.rs` 作为 HEVC 品牌的唯一只读解析点，与 alpha24 的 `image_container.rs`（AVIF，`avif`/`avis` 品牌）互不抢格式。品牌判定：主品牌或兼容品牌命中 `heic`/`heix`/`hevc`/`hevx`/`heim`/`heis`/`hevm`/`hevs` 认成 HEIC（`hevc`/`hevx`/`hevm`/`hevs` 是序列，格式名带「（序列）」），只标通用 `mif1`/`mif2`/`msf1` 也认但编码标「未指明」。容器侧：`meta` 是 FullBox，子盒从 +4 起递归走（支持 64 位 largesize、size=0 到 EOF、深度限 12 层、截断记偏移）；`pitm` 取主图项、`iinf` 遍历 `infe` 计项数、`iprp` 的 `ipco` 收属性盒、`ipma` 把属性关联到项；属性盒读 `ispe` 尺寸、`pixi` 通道与位深、`hvcC` 色度采样（`+16` 低 2 位）与位深（`+17` 低 3 位 + 8，`pixi` 缺失时回退）、`auxC` 的 alpha 平面、`irot` 的旋转（×90°）。像素不动，只按 `iloc`（v0/v1/v2 + `construction_method 0`）的 extent 拼出项字节：Exif 项按规范是「4 字节偏移 + `Exif\0\0` + TIFF」，但各编码器偏移基准不一致（iPhone 写 6），因此不按偏移切而**扫前 96 字节找 `II*\0` / `MM\0*`**，命中后交给 `metadata.rs` 既有的手写 TIFF 解析器，拍摄时间/相机/镜头与 JPEG 走同一条路；序列帧数取 `moov/…/stsz` 的 sample_count。四个坑都由契约测试或实测抓到：① `ftyp` 的兼容品牌必须按声明长度截断，否则把后面 `meta`/`mdat` 的字节当品牌读（第一版品牌字段里混进了 `meta`、`pitm`、`infe`）；② HEVC 族的 alpha 辅助类型是 `urn:mpeg:hevc:2015:auxid:1`，字面**不含 alpha**，按 `b"alpha"` 判会漏，改为同时接受 `alpha` 与 `auxid:`；③ `irot` 是「与主图关联的属性」，不从 `ipma` 关联回填就永远是 None；④ `stsz` 夹具把 version/flags 写了两遍，sample_count 实际落在 +12。读不到一律给原因（无 `meta` 盒、缺 `ispe`、缺 `pixi`/`hvcC`、无 Exif 项、结构截断给偏移），不填默认值。能力矩阵与前端演示矩阵同步：HEIC/HEIF 从 `read:false` 改为 `read:true` / `write:false`（GIF/BMP/AVIF 一并统一成可读），`detect()` 的拒绝理由改成「HEIC/HEIF 只读（可读 ispe 尺寸 / 位深 / 通道 / 色度采样 / alpha / 旋转 / EXIF 拍摄时间与相机），本版本不支持写回」；`sniff.rs` 的 `ftyp` 家族补齐 `hevc`/`hevx`/`heim`/`heis`/`hevm`/`hevs`/`mif2` 七个品牌。守卫：`tests/heif_contract.rs` 13 条（avif/mp4/wav 不被误认、项数与主图项、Exif 带前缀与不带前缀两种定位、无 `pixi` 时回退 `hvcC` 位深、无 `meta` 盒只警告、截断不 panic、10 位 + alpha 平面、`irot` 旋转、`stsz` 帧数、通用品牌编码未知、真 HEIC 走 `read_metadata` + `rename_field_values` 名字可用），夹具全部现场构造最小 ISOBMFF 与最小 TIFF；core 合计 272 → 285（2026-11-27，alpha25）。

- ~~加密 PDF / xref 流 PDF 一律「本版本不支持」~~——已补（域五 5.14 的最后两类，只读）：`metadata.rs::document_pdf` 原先靠窗口扫描 + 数 `/Type /Page` 猜页数，`metaedit/doc.rs::pdf_read` 遇 xref 流直接报错、遇 `/Encrypt` 只给一句「不支持」，Info 在对象流里就只能退回 XMP。新增 `renomio-core/src/pdf.rs`（约 1450 行）作为 PDF 只读解析的唯一实现点，删掉旧的 `pdf_string_after` / `count_pdf_pages` 两个粗糙函数。发现层：从最后一个 `startxref` 出发，`xref` 关键字走经典表（每项 20 字节、`n` 型记偏移），`n g obj` 视为 xref 流对象（`/Type /XRef`），沿 `/Prev` 最多合并 16 段且**新段先写入**（`or_insert` 保证旧段只补缺）；trailer 字典按「新 → 旧」拼接，`dict_find` 取到的就是最新值。取对象：type 1 在偏移处解 `n g obj` 到 `endobj`（含 `stream` 则记字节区间，偏移与对象号不符时退化为按号扫描），type 2 递归解 `/ObjStm`（`/N` 对「对象号 偏移」头 + `/First` 起点）。解码：`FlateDecode`（`ZlibDecoder` 失败回退 raw `DeflateDecoder`）、PNG 预测器 10–15（行首 filter 字节 + Sub/Up/Avg/Paeth，行宽按 `Columns × Colors × BitsPerComponent` 算）、`ASCIIHexDecode`、`ASCII85Decode`，`LZW` 等明确记「不支持的编码」而不是硬解。文本：`FE FF` UTF-16BE（含代理对）、`FF FE` UTF-16LE、`EF BB BF` UTF-8、合法 UTF-8 直读、其余按 latin-1 兜底；日期 `D:…` 规整成 `2026-11-27 02:49:00 (+08:00)`，`Z` 尾缀不伪造偏移。加密：读 `V`/`R`/`/CF /CFM`（嵌套两层要递归找）只报算法（RC4 40 / RC4 128 / AES-128 / AES-256），**不解密**，也不把密文当标题。四个真缺陷由契约测试抓到：① `skip_value` 把 `1 0 R` 只吃到 `1`，所有间接引用（`/Root`/`/Pages`/`/Info`）全断，页数与 Info 一起消失；② `dict_entries` 没先 `trim_ws`，而对象体切片以换行开头，Info 字典解析成空表，只报「Info 字典缺失」；③ 八进制转义 `\351` 的 `i += used` 与末尾统一的 `i += 2` 叠加，吞掉后一个字符（`(A\351B)` 解成 `Aé`）；④ `/CFM` 埋在 `/CF << /StdCF << … >> >>` 两层里，顶层 `dict_name` 取不到，AES-128 被误报成「算法未知」。接线：`metadata.rs::document_pdf` 改为调 `pdf::probe` 并把 probe 的字段/警告原样转成属性行（页数标签从「页数（粗略）」改成「页数」）；`metaedit/doc.rs::pdf_read` 改用 `probe.info`（键无斜杠、值已解码），加密时返回带算法名的明确错误，Info 缺失才回落 XMP；`pdf_rewrite` 不变，xref 流写回给「只读可解析，写入需要经典 xref 表」；`metaedit::capabilities()` 的 PDF 说明与 `bridge.ts` 演示矩阵同步成「表/流/对象流均可读，写入限经典 xref」。守卫：`tests/pdf_contract.rs` 16 条（经典表 Info+页数、UTF-16/转义/十六进制、latin-1 兜底、间接字符串对象、xref 流、Flate+预测器两种编码结果一致、对象流里的 Info、`/Prev` 增量更新取新值、AES-128/RC4 40/RC4 128/AES-256 四种算法、截断不 panic 且给原因、任意前缀截断不 panic、非 PDF 返 None、缺 Info 只警告不填默认、`/Count` 原样取回、日期六种写法），夹具全部现场构造最小 PDF（含用 flate2 在测试里现压的 xref 流与 PNG Up 编码器）；core 合计 285 → 301（2026-11-27，alpha26）。

- ~~字体文件（TTF/OTF/TTC）在属性面板里只有文件大小，也进不了「按元数据取名」~~——已补（域三 3.8 的字体部分，只读）：新增 `renomio-core/src/font.rs`（约 460 行）作为 sfnt 字体的唯一只读解析点，与 `image_container.rs`/`heif.rs`/`pdf.rs` 各管一路、互不抢格式。容器判定：`ttcf` 认成 TTC 集合（读集合内字体数与各表头偏移，越界或非已知 sfnt 的成员**逐个跳过并报警告**，只解第一个字体）、`OTTO` 认成 CFF 轮廓、`\x00\x01\x00\x00` 与苹果 `true` 认成 TrueType、`typ1` 也认（PostScript 包裹）；表目录按 16 字节项遍历，偏移越界或长度超出文件尾都**跳过并给偏移**而不是 panic，长度按文件尾裁剪。`name` 表按「Windows 英文（platform 3 / lang 0x409）> Unicode 平台（platform 0）> Windows 其它语言 > Mac（platform 1）」打分，同一 nameID **只取最高分那条**（避免中文族名把英文族名挤掉）；解码：platform 0/3 走 UTF-16BE（奇数长度按规范丢掉孤字节并警告），platform 1 先试 UTF-8、否则按 Windows-1252 近似解并写明「未内置 MacRoman 码表」——**不猜码页、不把字节静默当 UTF-8**。`maxp` 取字形数、`head` 的 `unitsPerEm` 取设计网格（偏移 +18，第一版写成 +16 被契约测试抓到）、`OS/2` 的 `usWeightClass` 与 `fsSelection` 取字重与斜体，字重按 100…900 映射成 CSS 名（`Thin`…`Black`）。属性面板新增 kind `font`：格式名（TrueType/CFF/TrueType 集合/Apple TrueType）、集合内字体数、字体名、字形、字体全名、PostScript 名、字体版本、字重（`{weight}（{Name}）`）、斜体（是·否）、字形数、设计网格、设计者、授权；缺 `name` 表只报警告、不填默认值；**能力表 `write:false`，写入明确拒绝并说明字体改写要重建表校验和、本版本不做**。接线：`metadata.rs::read_metadata` 在音频容器之后、MP3 之前插字体分支，`RenameFieldValues` 新增 `font_family` / `font_style` / `font_version` 三个改名取值（`Version 1.02;hotconv 1.0.109` 这类尾巴收敛成 `1.02`，取值统一 `name_safe`），前端 `MetaFields` 加 `fontFamily`/`fontStyle`/`fontVersion`、下拉新增第四组「字体信息」、五语种各补 7 个键、`bridge.ts` 演示矩阵与 `sniff.rs`（`ttf`/`otf`/`ttc`）同步。守卫：`tests/font_contract.rs` 17 条（TTC 字体数与首字体、TTC 越界偏移警告、Windows 记录胜过 Mac、仅 Mac 记录近似解码并警告、中文族名 UTF-16BE、缺 `name` 表只警告、name 计数虚高不 panic、表偏移越界跳过、奇数长度 UTF-16 截断、空表目录不报错、非字体返 None、`sniff_magic` 三格式、真写临时 .ttf 走 `read_metadata` + `rename_field_values` 取名可用、OTF 版本尾巴收敛、CFF 与苹果表头格式名）+ 单测 3 条，夹具全部**测试现场构造最小 sfnt**（表偏移按整文件绝对计算、4 字节对齐），不下载样本、不依赖本机字体；core 合计 301 → 321（2026-11-27，alpha27）。

- ~~EXE/DLL 在属性面板里只有文件大小，版本资源（文件版本 / 产品名 / 公司 / 版权）完全读不到~~——已补（域三 3.8 的 EXE 部分，只读）：新增 `renomio-core/src/pe.rs`（约 600 行）作为 PE 的唯一只读解析点，与 `font.rs`/`pdf.rs`/`heif.rs` 各管一路。头解析：只认 `MZ` + `e_lfanew` 处 `PE\0\0`，COFF 取 machine / 时间戳 / 特性位（`0x2000` = DLL），可选头只接受 0x10B（PE32）与 0x20B（PE32+），magic 是 0x107（ROM）直接返回 None 而**不冒充可执行文件**；节表按 40 字节项收集，RVA→文件偏移靠「所在节 + 节内偏移」换算（`delta >= span` 或 `delta >= raw_size` 即判失败）。资源目录三层（类型 16 → 名称/ID 首项 → 语言变体首项 → 16 字节数据项取 RVA/Size），每层 `checked_add` 并给具体中文原因（「没有 RT_VERSION 资源」「资源目录 RVA 不在任何节」「版本资源数据在文件之外」）。版本块：`read_block` 读 `wLength/wValueLength/wType`、UTF-16LE 块名读到 0x0000、值起点按**相对块起点** 4 字节对齐、子块按 `align4(value_end - base)` 推进（不是按绝对偏移，第二版才改对），递归深度上限 8；根块校验 `0xFEEF04BD` 签名并取 MS/LS 四值拼成 `1.2.0.100`，签名不对只报警告、**不套默认版本号**；8 位十六进制表名解成语言 + 代码页，语言表优先 en-US（0x0409），多张表只解一张并在警告里说明张数；字符串项按 `wType == 1` 把 `wValueLength` 当 UTF-16 字符数（含结尾 0），中文公司名照样解对。声明长度超出文件尾按实际内容解析并警告（截断不 panic）。属性面板新增 kind `exe`：位数（`64 位（PE32+）`）、目标架构、子系统、编译时间（`TimeDateStamp` 为 0 报空串，不伪造 1970）、文件版本 / 产品版本、公司名 / 产品名 / 文件说明 / 版权 / 原始文件名 / 内部名 / 商标 / 注释 / 私有构建 / 特殊构建、`版本资源·文件版本` 与 `版本资源·产品版本`（避开与头里「文件版本」撞名）、版本资源语言；**能力表 `write:false`**，写入明确拒绝并说明要重建资源节与校验和。接线：`metadata.rs::read_metadata` 在字体分支之后、ID3 之前插 PE 分支，`RenameFieldValues` 新增 `file_version`（标签「文件版本」→ `name_safe`），`sniff.rs` 的 `HEAD_LEN` 从 64 放宽到 **1024**（PE 签名在 `e_lfanew` ≈0x80 处，原来 64 字节读不到）并新增 `MZ` 分支（有 `PE\0\0` 才按特性位分 `exe`/`dll`，**裸 MZ 不猜**），`metaedit::capabilities()` 与 `detect()` 各加一条，前端 `MetaFields` 加 `fileVersion`、下拉新增第五组「可执行文件」、五语种各补 4 个键、`bridge.ts` 演示矩阵与 `demoKindOf`（`exe`/`dll`/`sys`）同步。守卫：`tests/pe_contract.rs` 15 条（可选头两种位宽、x86/x64/ARM64 架构名、DLL 特性位 vs 驱动子系统、`VS_FIXEDFILEINFO` 四段版本、8 个字符串项、中文 UTF-16、en-US 表优先且警告张数、无资源目录 / 无 RT_VERSION / 签名损坏 / RVA 越界 / 声明长度虚高各自只警告、任意前缀截断不 panic、`sniff_magic` 分 exe 与 dll 且裸 MZ 返 None、真写临时 .exe 走 `read_metadata` + `rename_field_values`）+ 单测 3 条，夹具全部**测试现场构造最小 PE**（DOS 头 `e_lfanew=0x80`、一个 `.rsrc` 节、三层资源目录 + 数据项 + 版本块），不下载样本；另用本机 `renomio.exe`（1.2.0-alpha27，64 位 GUI）与 `C:\Windows\System32\kernel32.dll`（10.0.26100.9974，控制台子系统）各跑一遍真实文件回读，字段与 `wmic`/资源查看器一致；core 合计 321 → 339（2026-11-27，alpha28）。
- ~~APK 在属性面板里只有文件大小，包名 · 版本 · 应用名称读不到，也进不了「按元数据取名」~~——已补（域三 3.8 的 APK 部分，只读）：新增 `renomio-core/src/apk.rs`（约 600 行）作为 APK 的唯一只读解析点。ZIP 层：EOCD 在**尾部窗口**里反向找回（最后一个 `PK\x05\x06`），中央目录按绝对偏移逐条读，条目名 / 压缩方法 / 压缩与原始大小 / 本地头偏移全部 `checked_add`；头 8 MB + 尾 1 MB 的**双窗口**让大于 8 MB 的包也能读（清单通常在文件最前、中央目录在最后），任一条目落在两个窗口之外就明确报「在读取窗口之外」而不是猜；ZIP64 条目直接放弃（字段溢出会算错偏移）、压缩方法只认 存储(0)/deflate(8)。AXML 层：字符串池按 `flags & 0x100` 分 UTF-8 / UTF-16，两种长度前缀都按「1 或 2 字节、最高位表示续字节」解（UTF-8 是字符数 + 字节数两段）；起点元素按 `ResChunk_header` 16 字节 + `ResXMLTree_attrExt` 20 字节布局取值，**属性的起点是 `chunk + 16 + attributeStart`**（第一版按 `24 + attributeStart` 少算 8 字节，契约测试抓到），属性值优先取 `rawValue` 字符串、否则按 `dataType` 解 int / reference / boolean / string；命名空间一律忽略（清单里同名属性不冲突），元素与属性名按字符串池索引还原。ARSC 层：表头 + 全局字符串池 + package 循环，只认与资源 id 高 8 位一致的包，按 `typeId` 找 type 块、按 `entryCount` 界的 `entriesStart` 表定位条目，条目再读 `Res_value` 取全局池字符串；**优先 default 配置**（config 大小之后全 0），其它配置先记成回退值，复杂条目（bag）跳过；声明长度超出文件尾给警告而不是越界读。清单字段：`package` / `versionName` / `versionCode` / `compileSdkVersion` / `uses-sdk` 的 `minSdkVersion` 与 `targetSdkVersion` / `application` 的 `label`（`@string` 引用走 ARSC 解析）·`icon`·`debuggable`·`allowBackup` / `uses-permission(-sdk-23)` 的权限名（去重） / 带 `android.intent.action.MAIN` + `android.intent.category.LAUNCHER` 的 `activity` 作主活动（`.Main` / `Main` 一律补包名前缀）。签名只做存在性判断：中央目录前 16 字节是否 `APK Sig Block 42`（v2/v3/v4），以及 `META-INF/*.RSA|.DSA|.EC|.SF`（v1），**不校验签名、不反编译 dex**。属性面板新增 kind `apk`：包名、文件版本（版本名）、版本号、应用名称、最低 / 目标 / 编译 SDK（`23（Android 6.0）` 这类映射）、主活动、声明权限（前 6 条 + 总数）、声明权限数、可调试、允许备份、图标资源、签名、包内条目；`RenameFieldValues::file_version` 复用「文件版本」标签，APK 的版本名因此可直接进「按元数据取名」（21 字段不变）。接线：`metadata.rs::read_metadata` 在 PE 之后、ID3 之前插 APK 分支（普通 ZIP / DOCX 没有 `AndroidManifest.xml` 就返回 None，不误判），`metaedit::capabilities()` 与 `detect()`（扩展名 `apk` → 只读并说明写回要重建 ZIP 与签名块）各加一条，前端 `types.ts` kind 联合加 `apk`、`MetadataDialog` 的 `kindKey` 与五语种 `meta.apk`、`bridge.ts` 的 `demoKindOf`/能力矩阵同步。守卫：`tests/apk_contract.rs` 16 条 + 单测 4 条（UTF-8/UTF-16 长度前缀与相对名补包名），夹具全部**测试现场构造**（本地头 + 中央目录 + EOCD 的最小 ZIP、AXML 字符串池与起止元素、ARSC 的 package/typeSpec/type 三层），不下载样本；另用构造出的大包（20 KB 未压缩载荷）验证双窗口；core 合计 339 → 359（2026-11-27，alpha29）。


## 统计

A 有实测：70 项（无部分覆盖）；B 仅单测：0 项；C 无验证：0 项；D 部分：1 项（3.13 高级规则，仅有对照表）；E 未做：1 项（6.13）；N 本版不做：1 项（1.4，合计 72 项）。

## 版本闸门（已拍板 A，已解决）

2026-11-06 用户拍板：alpha 序号不受「分段 ≤ 10」限制，可到 99；该口径对所有项目统一。
`check-version.mjs` 已改：`MAX_ALPHA=99` 用于 alpha，`MAX_SEGMENT=10` 仍约束 minor/patch；
自测 16/16（`1.0.0-alpha11` 放行，`1.11.0`/`1.0.11` 拒绝）。`1.0.0-alpha11` 已发布。



