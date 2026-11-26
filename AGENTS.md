# AGENTS.md — Renomio 项目记忆

本文件是给 AI 编程助手（Trae / Cursor / Claude Code 等）的常驻上下文。改代码前先读完，再读 `CONTRIBUTING.md`。

## 项目

- 产品：Renomio，Windows 批量重命名与文件操作工具（Tauri 2 + React 19 + TypeScript + Vite 7，核心逻辑在 Rust crate `renomio-core`）。
- 版本：`VERSION` 是唯一来源，当前 `1.2.0-alpha19`；稳定版 `v1.0.0`。
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
npm run test:repair    # 数据目录自检与修复守卫（cargo test --test repair_contract + 跑 repair_probe；隔离而非删除、临时文件 24h、幂等；CI 三平台矩阵各跑一遍）
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

## 当前状态（2026-11-27，1.2.0-alpha23）

已实现并有证据：F2 方案库/最近记录、F3 SYSTEM/ARCHIVE 属性、F4 文本编码批量转换、U3 表格自动列宽 + 系统文件类型图标（逐项证据见 `docs/1.1.0-收口清单.md`）；界面重构落地——检查器改为列表下方底部抽屉、八类列表页签下线（列表为唯一主视图、右栏只留规则链）、页头「清空列表」带二次确认、侧栏收敛为「文件」一组、设置移入「更多」，结构决策见 `docs/界面重构-HIG基线.md` §11–§12；规则开关几何按尺寸变量重算并有 E2E 巡检；正则替换兼容 Delphi 方言 `\1..\9`（`\\1` 为字面，引用分组超限就地报错），见 `docs/规则语义确认清单.md` 末节与 `npm run test:regex`；命令列表（FEATURE-GAP 4.10）——规则链 + 冲突策略存成命令，「套用」只载入、「运行」必进预览确认，见 `docs/FEATURE-GAP.md`；大小写例外词表——`protect` 命中的片段在六种大小写模式下保留原写法（支持 `*`/`?`、大小写不敏感），见 `docs/规则语义确认清单.md` 末节与 `npm run test:case`。界面遗留清零（alpha6）——死样式删除 + toast 让位 + 表头/行逐列几何断言，见 `npm run test:css` 与 e2e 几何巡检；按元数据取名扩到 17 字段（alpha7）——EXIF `ISO/光圈/快门/焦距/镜头`、`像素宽/高/像素尺寸`（无 EXIF 回退图像尺寸）、音频 `年份/流派/作曲`，取值统一文件名安全化，并修掉 EXIF SHORT 值无视 TIFF 字节序的读错缺陷，见 `npm run test:meta`、`npm run test:core` 与 `docs/FEATURE-GAP.md` 3.8；移动子串补齐定位与落点（alpha8）——新增 `by=index|markers`（按标记取两标记之间的内容，留空即不设边界、标记找不到整条跳过）、`insert=before|after`（同一目标位差一位，可控落点左右），旧存档规则按 `index`/`before` 兜底、语义不变，见 `npm run test:move`、e2e 10 条断言与 `docs/FEATURE-GAP.md` 3.6；扩展名「智能分析」（alpha9）——Rust 按**文件头魔数**（前 64 字节，不解码内容）识别 20 种格式，前端扩展名规则新增 `analyze` 模式在预览时纠正错标扩展名，识别不出/头部过短/目录/演示模式一律保持原名不猜，见 `npm run test:ext`（56 条）、`npm run test:core`（含 4 条嗅探）与 `docs/FEATURE-GAP.md` 3.7；删除规则补齐四模式（alpha10）——「从尾部数」的起点改为从末尾逆算并朝词尾延伸（旧实现把窗口结束在倒数第 N 个，等于删到词首）、「首尾之间」改按码点换算（emoji 不再被切半个）、两个标记全空时规则卡就地报错而非静默删空整名、修剪新增自定义修剪字符集（留空仍只剪空白，旧存档语义不变），见 `npm run test:del`（77 条）、e2e 16 条断言与 `docs/FEATURE-GAP.md` 3.4；IPTC Core 双写 IPTC-IIM（alpha11）——JPEG 上 Headline / By-line Title / Credit / Source 除 XMP 外同时写进 APP13 的 `Photoshop 3.0` 8BIM 资源 0x0404（`2:105` / `2:85` / `2:110` / `2:115`），非 ASCII 自动插 `1:90 ESC % G` 声明，未知 dataset、别家 APP13、0x040C 缩略图资源原样保留，改动后丢弃过期 `0x0406` 摘要交给 Photoshop 重建，读侧在 XMP 缺值时才回退 IIM，见 `npm run test:iptc`（45 条，真实 JPEG 用 Pillow 独立回读）、`npm run test:core`（含 6 条 IIM 单测）与 `docs/FEATURE-GAP.md` 5.15；跨平台能力契约（alpha12）——`platform::PlatformReport` 成为平台差异的**单一事实来源**（OS/分隔符/大小写默认/路径阈值与硬上限/btime 三态+原因/「隐藏·系统·存档仅 Windows」+原因/长路径前缀），`tests/platform_contract.rs` 11 条逐 OS 断言（只读位真实往返、非 Windows 属性写入必须逐条失败并带原因、Windows 名称规则与宿主无关），`examples/platform_probe.rs` 打出 JSON 由 `npm run test:platform` 逐字段比对；CI 新增 `cross-os` 矩阵在 **ubuntu / windows / macos 三个真实 OS** 上跑同一份 core 测试，见 `docs/FEATURE-GAP.md` 6.11；alpha12 的 tag CI [45504761322](https://github.com/yunyu697/renomio/actions/runs/45504761322) 全绿（含 `cross-os` 的 ubuntu / windows / macos 三条），`v1.2.0-alpha12` 以 Pre-release 发布 15 个资产；alpha13 的 tag CI [45520274192](https://github.com/yunyu697/renomio/actions/runs/45520274192) 同样 10 个 job 一次全绿（`cross-os` 三平台各跑 `platform_contract` + `datadir_contract` + 两个 `--require-probe` 守卫），`v1.2.0-alpha13` 以 Pre-release 发布 15 个资产，滚动 `updates` 的 `latest.json` 已指向 `1.2.0-alpha13`。数据目录 / 便携模式（alpha13）——`renomio-core/src/datadir.rs` 成为数据目录的**唯一解析点**（优先级：`--data-dir` > `RENOMIO_DATA_DIR` > 程序旁 `renomio.portable`（数据落 `<程序目录>/data`）> 每用户目录）；标记在但便携目录不可用（同名文件 / 无写权限）时回落到每用户目录并把原因写进 `dataRootNote`，界面直接显示，不静默丢数据；便携或覆盖时 `migrate::info_skipped` 跳过自动迁移、旧目录保留可手动导入；`tests/datadir_contract.rs` 11 条 + `npm run test:datadir` 44 条（真跑 `datadir_probe` 五场景），CI `cross-os` 三平台各跑一遍；设置 › 运行环境新增「数据目录来源」行与便携说明（五语种）。见 `docs/FEATURE-GAP.md` 6.12。更新通道修复（alpha14）——版本比较从 `update.rs` 的 `semver::Version::parse` 裸比改为 `renomio_core::version::is_newer`：`alpha` 序号按**数值**比较，`alpha9 < alpha10 < alpha13`；旧逻辑把整段 `alphaN` 当 semver 字母数字标识符，字符串序下 `alpha10 < alpha9`，导致装在 1.2.0-alpha9 的机器永远检查不到更新（2026-11-25 实测该机装的正是 alpha9）。配套 `tests/version_contract.rs` 11 条（含 alpha9→alpha13 回归与 alpha10..alpha20 全序列）、`examples/version_probe.rs` 探针、`npm run test:update`（探针实跑 + 接线 + 文档同源）与 CI `cross-os` 三平台各跑一遍；`src-tauri` 已移除 `semver` 依赖。注意：**alpha9 及更早的装机自己跑的是旧逻辑，需手工装一次 alpha14 才能恢复通道**。设置导入导出（alpha15，域六 6.14）——`renomio-core/src/ini.rs` 是 **JSON ⇄ INI 的唯一编解码实现**：顶层标量进 `[@root]`、顶层对象/数组各自分节、嵌套用点路径、数组用 `[i]` 下标、空容器写成 `{}`/`[]`、会被读成布尔的 `true`/数字样字符串/带 `= ; # [ ] " \` 或首尾空白的字符串自动加引号、注释 `;`/`#` 与 CRLF/BOM 兼容；**重复键、下标乱序/跳号、键写在分节前、引号未闭合、分节名非法一律带行号拒绝**。Tauri 侧只加两条纯函数命令 `settings_to_ini` / `settings_from_ini`（落盘仍走 `write_text_atomic`），前端 `src/lib/settingsFile.ts` 负责拼载荷与**按 `DEFAULT_SETTINGS` 形状做类型白名单**（未知键/类型不符丢弃并计数、规则条目缺 `id/type/enabled` 丢弃、快捷键非文本绑定丢弃），界面设置 ›「设置文件」两个按钮 + 五语种文案（浏览器演示模式按 `isDesktop` 禁用而不是假装成功）。守卫：`tests/ini_contract.rs` 15 条（真实设置形状往返、空容器、伪标量字符串、坏文件逐条行号、顶层数组分节、两次导出字节一致）、`examples/ini_probe.rs` 探针、`npm run test:ini` 66 条（探针往返 + 手写文件 + 6 类坏文件 + 接线 + 五语种 + 文档同源）、CI `cross-os` 三平台各跑契约与脚本；e2e 新增 5 条（分区存在、分行排布、文案本地化、导出入口在命令链未接通时给失败提示而非假成功、导入按钮可点）。见 `docs/FEATURE-GAP.md` 6.14。数据目录自检与修复（alpha16，域六 6.15）——`renomio-core/src/repair.rs` 是唯一实现：`check(root)` **只读**扫描、`fix(root, now_ms)` 逐条修，10 个稳定发现码（`missing-root` / `root-is-file` / `missing-dir` / `bad-batch` / `batch-id-mismatch` / `bad-snapshot` / `snapshot-id-mismatch` / `bad-rule-history` / `leftover-temp` / `orphan-backup`），每条带 `severity`（error/warn/info）与 `fixable`；修复**只隔离不删除**——缺失目录建回、坏文件移到 `repair-quarantine/<毫秒时间戳>/<原相对路径>`（同名冲突加 `.1`…`.99`）、只删自己写的并超过 24 小时的 `*.tmp`（太新进 `skipped`），第二次 `fix` 幂等不动手，`ok` = 剩余 findings 无 error；报告键一律 camelCase、`path` 一律相对数据目录且 `/` 分隔。Tauri 侧只加 `data_dir_check` / `data_dir_repair` 两条命令委派 Core；前端 `src/lib/repair.ts` 负责码表翻译与「错误优先」排序，设置 ›「数据自检与修复」两个按钮 + 结果块（`data-ok` / `data-severity` / `data-code` 便于断言），浏览器演示模式按 `isDesktop` 禁用。守卫：`repair.rs` 10 条单测、`tests/repair_contract.rs` 15 条（隔离副本字节不变、临时文件 24h 边界、同毫秒幂等、check 不写盘等）、`examples/repair_probe.rs` 探针（退出码按 `ok` 字段定）、`npm run test:repair` 90 条（探针 12 组场景 + 接线 + 五语种 25 条文案 + 文档同源）、CI `cross-os` 三平台各跑契约与脚本；e2e 新增 7 条。**踩过的坑（务必记住）**：`read_dir` 返回的 entry 路径带 `\\?\` 前缀，与传入 root 不同源，`strip_prefix` 会失败 → 一律用 `dir.join(entry.file_name())` 重拼；`\\?\` 前缀路径不接受 `/` 分隔符（`fs::rename` 报 os error 123）→ 隔离目标必须按 `/` 分段 `push` 回本机分隔符；孤儿备份要看一层子目录（真实布局 `backups/<id>/<时间戳>/…`），空目录不算孤儿。见 `docs/FEATURE-GAP.md` 6.15。表格自动列宽（alpha17，域一 1.5）——`src/lib/columnFit.ts` 是纯函数算法层：`FitSpec{min,max,pad}`、`clampWidth`（NaN/Infinity 退回下界、取整夹取）、`fitColumnWidth`（空或全空文本退回下界、忽略 null 与测量 NaN）、`fitWidths`（无样本的列不出现在结果里、保持原宽），文本测量由调用方注入（浏览器用 canvas + 行内真实字体，Node 自测用假测量器）；MainPane 侧 `COLUMN_MAX` / `COLUMN_PAD` 补齐上限与内补，表头六条 `.col-grip` 各带 `data-testid="col-grip-<key>"` 与**双击**自适应，列菜单「自动列宽」一次算全部 `shownKeys`（列表为空给 `main.autoFitEmpty` 提示而非算出一堆下界），结果先清 `dragWidths` 再写 `settings.columnWidths` 持久化；重置按钮带 `data-testid="col-reset"`。**同时修掉列宽预算漏算内边距的缺陷**：原收敛只按 `.table` 宽度算空间，忘掉 `.thead/.trow` 两侧各 12px 的 `--ds-space-5`，1280×800 六列全开时 674px 网格顶到 686px、挤出 6px 横向滚动条；现在预算统一扣 `LIST_PAD = 24`，窄窗按 `COLUMN_RANK` 收起次要列（位置列最后走）。守卫：`npm run test:columns` 56 条（Node 类型剥离直接 import 后实跑 + 接线 + 文档同源；CI 不装 node_modules 也能跑）、CI `cross-os` 加一步、e2e 6 条（菜单项存在、宽度落在上下界内、双击只动该列、持久化、重置清空、表头与行逐列 Δ≤1px，全量 349 条全绿）。见 `docs/FEATURE-GAP.md` 1.5。

正则替换真实文件闭环（alpha18，域三 3.3 升 A）——补齐 Delphi 方言 `\0` = 整段匹配（等价 `$&`，`\\0` 仍是字面），并修掉「只替换第 n 个匹配」的引用不展开缺陷（原 `String.replace` 回调返回值不解析 `$1`/`$&`，替换串写 `\1` 会把字面 `$1` 写进文件名；现按 `exec` 命中分组自行展开，零宽匹配手动推进 `lastIndex`）；新增 `npm run test:regex:real` 21 条**真实文件闭环**：真实规则引擎（esbuild 打包 `src/lib/rules.ts`）算新名 → 计划 JSON → `renomio-core/examples/plan_probe.rs` 交给 core **真实两阶段改名** → 回 Node 核对磁盘文件名/目录名/逐字节内容/未命中文件原样 → `--undo` 真实撤销核对还原，CI `cross-os` 三平台各跑一遍；`test:regex` 18→28 条。执行筛选入口（alpha18，域一 1.3 补口）——此前「执行筛选」**没有界面入口**：更多菜单里的「筛选」只把光标丢进输入框、`applyCurrentFilter` 是孤儿函数，清单里「执行过滤 A」属过度声明；现在筛选条件旁内联「仅保留匹配」按钮（有模式才出现、Enter 等效、Esc 清空当前框），执行逻辑收进 `src/lib/patternFilter.ts` 纯函数（保留/排除叠加、大小写跟随设置、分号或换行分隔），**一条都不匹配时不动列表**并提示，更多菜单该项与孤儿文案已删，占位符改 `*.jpg;*.png` 与实现一致；`npm run test:filter` 23 条 + e2e 7 条（全量 358/0），CI `frontend` 加一步。见 `docs/FEATURE-GAP.md` 3.3 / 1.3。

对照表规则（alpha19，域三 3.13 部分落地）——新增规则类型 `map`：`src/lib/mapTable.ts` 是解析与替换的**唯一纯函数层**（`parseMapTable(text, caseSensitive)` → `{entries, errors}`，`applyMapping` 做替换）。表格式：一行一条 `旧=新`，**第一个未转义** `=` 或 TAB 作分隔，`#`/`//` 开头与空行忽略，`\=`/`\\`/`\s` 转义（`\s` 表示要保留的空格），键值两侧 trim；`caseSensitive=false` 时键按小写判重（`A` 与 `a` 冲突）；上限 500 条、键长 200，错误码 `no-separator` / `empty-key` / `dup-key` / `too-many` 都带原始行号。应用语义：从左到右**单遍**扫描，每位置取**最长键**（同长取表里靠前），写入新词后跳过旧词长度，**插入文本不再扫描**（`A=B`、`B=C` 不连锁、也不会死循环），新词留空即删掉命中片段；只改主干不动扩展名，目录同样适用。引擎侧 `ruleError` 对空表/坏行就地报错（带行号）、`applyRules` 有坏行时不参与求值、`ruleSummary` 给「对照表 · N 条」，`normalizeRule` 给旧存档补齐 `table`/`caseSensitive`（防 undefined 崩链）；`RULE_TYPES` 加了 `map`，规则菜单由它自动生成、`plan.ts` 的导入校验也随之认得新类型。编辑器 `MapEditor`：多行 textarea（`map-table`）、大小写开关（`map-case`）、实时错误列表（`map-errors`）、条目计数（`map-entries-count`）、格式提示（`map-hint`），五语种各 14 个键。守卫：`npm run test:map` **70 条**（纯函数实跑 + 引擎接线 + 五语种 + 文档同源）、e2e 4 条（新增类型与控件、整段映射且扩展名不变、条目计数、坏行报错不改名），全量 e2e 362 通过 / 0 失败。**本轮踩坑**：e2e 的四个真实文件脚本（`vars` / `rules-fs` / `policy` / `number-advanced`）各自手写 `import` 改写规则，新增跨文件依赖后漏转译会直接 `ERR_MODULE_NOT_FOUND`——加新 lib 模块时四处都要补。见 `docs/FEATURE-GAP.md` 3.13 与 `docs/规则语义确认清单.md` 末节。

跨盘移动保链（alpha20，不属于缺口表任何一行，属「静默出错」类真实缺陷）——旧 `ops.rs` 三处语义都错：目录内只要有链接，`copy_dir_all` 就返回 `Unsupported`（「跨盘移动暂不支持」，整目录搬不动）；顶层链接走 `fs::copy` 会**跟随目标**、把链接实体化成目标内容的普通副本再删源（文件名还在、语义没了）；删除用 `exists()` 判断，**悬空链接**被当成「不存在」而不删，Windows 目录联接用 `remove_file` 又删不掉。现在统一按 `EntryKind{Link,Dir,File}`（`symlink_metadata` 先判 `is_symlink`，联接算链接；`move_path` 收 `kind`，不再信任前端传来的 `is_dir`）处理，链接**一律不跟随**：复制用 `copy_link` 在原位重建同类链接（Unix `symlink` 原样保留相对目标；Windows 先 `symlink_dir`/`symlink_file`，落不下来才退化为目录联接 junction，文件链接则明确报「需要开发者模式/管理员」），校验新增 `compare_links`（先比「是不是链接」再比目标，Windows 退化成联接时用 `canonicalize` 判同一目标），删除只删链接本身（目录链接先 `remove_dir` 再回落 `remove_file`）。**两个平台坑**：Windows `symlink_dir` 会**报 1314「客户端没有所需的特权」但链接其实已经建好**，不看落地状态就退化去建联接会一路撞「已存在 / 重分析点数据无效」；手写 `REPARSE_DATA_BUFFER` 在含中文目录名/长路径下会随机退化成 4392/4394（同一份代码一会儿成功一会儿失败），改用社区长期验证的 `junction` crate（`[target.'cfg(windows)'.dependencies]`，两处 `Cargo.lock` 随动）。守卫：`tests/ops_fs.rs` 4 条（目录内链接、顶层链接含撤销、Unix 文件链接保留相对目标、Unix 悬空链接仍当链接），`ops.rs` 内 2 条 Windows 单测（半成功也要认落地 + 联接替换空占位且拒绝非空），ops_fs 18 → 20 条、core 单测 119 → 121 条。顺手补上一个**守卫洞**：`scripts/test-preview-finalize.mjs` 的转译清单漏了 `mapTable`（alpha19 新增跨文件依赖只改了 e2e 四处、漏了这一处），`npm run test:preview` 直接 `ERR_MODULE_NOT_FOUND`，现已补上并在 CI `frontend` 加一步（20 条）。

硬链接关系保持（alpha21，与 alpha20 同族的「静默语义变化」）——`EntryKind` 只有 `Link`/`Dir`/`File`，硬链接在 `symlink_metadata` 里与普通文件无法区分，旧 `copy_dir_all` 给每个名字各 `fs::copy` 一份字节：内容对，但**同一份数据的多个名字变成互不相干的副本**。现在 `copy_dir_tree` 带一份「卷号 + 文件号 → 先复制出来的路径」台账（`HashMap<(u64, u64), PathBuf>`）：Unix 用 `MetadataExt` 的 `dev`/`ino`（`nlink > 1` 才登记），Windows 走 `GetFileInformationByHandle`（`MetadataExt` 的 `file_index`/`number_of_links`/`volume_serial_number` 仍是 unstable 的 `windows_by_handle`，直接用会 E0658）；命中台账就 `fs::hard_link` 指向那一份、不再复制字节，建链失败退回普通复制（内容仍正确）。边界：顶层单文件（同伴在范围内之外）照旧普通复制、范围外同伴不被牵连也不被回写；`nlink == 1` 的同内容文件绝不合并。守卫：`tests/ops_fs.rs` +3（目录内三名含跨子目录 + 改一处三处同步 + 撤销还原关系；同内容独立文件不合并；范围外同伴不受影响），ops_fs 20 → 23、core 合计 230 → 233。见 `docs/FEATURE-GAP.md` 已补段末条。

旧版 OLE 认类型 + 读摘要（alpha22，域五 5.14 的 OLE 部分）——`.doc/.xls/.ppt/.msg/.msi` 的文件头完全一样（`D0 CF 11 E0 A1 B1 1A E1`），旧实现只按魔数判断，于是 Windows 安装包、Outlook 邮件、加密 Office 包一律被叫成「旧版 Office 文档」，属性面板再补一句「解析尚未实现」——类型错、承诺空。现在 `renomio-core/src/cfb.rs` 是 OLE 复合文档的唯一只读解析点：头（512/4096 扇区、mini 64）→ DIFAT → FAT → 目录链 → miniFAT 与迷你流；按根存储 CLSID 认 Word `00020906` / Excel `00020820` / PowerPoint `64818D10` / Visio / Publisher / MSI `000C1084` / Outlook 邮件 `00020D0B`，再按流名兜底（`WordDocument` / `Workbook` / `PowerPoint Document` / `EncryptedPackage` / `__substg1.0` / `_Tables`）。文档类读 `\x05SummaryInformation` + `\x05DocumentSummaryInformation`：VT 类型（I2/I4/LPSTR/LPWSTR/FILETIME/BOOL），窄字符串按码页解码（`encoding_rs` 的 GBK/Shift-JIS/Big5/EUC-KR/1250-1258 码表，UTF-8 直读，认不出按 latin-1 兜底，**绝不静默当 UTF-8**），FILETIME → UTC 文本、标签写 `（UTC）`、不猜本地时区；「标题」直接进 `rename_field_values.title`。读不了就明确拒并给具体原因（安装包/邮件/加密包/未知流名各一条），结构损坏给「结构损坏：<原因>」而非「尚未实现」。**坑**：`MetadataExt` 这套在这里用不上，全部手写 u16/u32 小端读取；迷你流容器必须补满整扇区，否则文件比 FAT 宣告的短、读侧判越界（测试构造器踩过）。守卫：`tests/cfb_contract.rs` 9 条，全部用**测试现场构造的最小 CFB**（扇区/FAT/miniFAT 链自己算，不下载样本、不依赖本机 Office），core 合计 233 → 242。见 `docs/FEATURE-GAP.md` 5.14。

音频容器读出来（alpha23，域五 5.11 只读）——WAV / AIFF / APE / WMA 以前统一结局是「属性面板只看到文件大小 + 一句拒绝」，而采样率、声道、时长、标题、艺术家都在文件里。新增 `renomio-core/src/audio_container.rs`：WAV 走 RIFF（`fmt` 参数、`data` 长度算时长、`LIST/INFO` 标签、`ds64` 认 RF64），AIFF/AIFC 走 IFF（`COMM` 的 **80 位扩展浮点**采样率、`NAME`/`AUTH`/`(c)`/`ANNO` 文本块、AIFC 压缩类型），APE 走 `MAC ` 头描述符（**字段从偏移 8 开始，不是 6**）+ 头数据未压缩时的内嵌 WAV 头 + 文件末尾 APEv2（`APETAGEX` footer，**「带不带标签头」两种写法都要按字节判断，不能只看 flags**），WMA 走 ASF（文件属性播放时长**扣 pre-roll**、音频流属性的 WAVEFORMATEX、内容描述 5 个 UTF-16 串、扩展内容描述的 `WM/AlbumTitle` 等）。**同一个坑踩了两次**：标签常写在音频数据之后，只读头部 8MB 看不到——`read_metadata` 加「头部被截断时再读尾部 1MB」，并且尾部扫 `LIST` 时后面跟的是 4 字节长度、再才是 `INFO`（第一版错在这里，测试直接抓到）。**不猜**：APE 头数据被压缩就明说「需要解码器」，不给默认采样率；`decode_text` 能 UTF-8 就 UTF-8、否则 Windows-1252。附带 `sniff.rs` 认 `aiff`/`ape`/`wma` 魔数，`metaedit::capabilities()` 与前端演示矩阵把这四种容器改成 read:true / write:false 并写清只读原因。守卫：`tests/audio_container_contract.rs` 11 条 + 单测 3 条，全部现场构造最小容器；core 合计 242 → 256。见 `docs/FEATURE-GAP.md` 5.11。

已知缺口：
- Windows 安装包未做 Authenticode 代码签名（本机无 OV/EV 证书），SmartScreen 会警告；更新用 `.sig` 已验过。
- 已发布：`v1.2.0-alpha23`（2026-11-27，Pre-release，15 资产）为当前最新；滚动清单 release `updates` 的 `latest.json` 已指向 alpha23（三平台键齐全：windows 2,701,392 / linux 87,120,376 / mac 3,400,138，pub_date `2026-11-27T12:00:00Z`，线上回读与本地逐字节一致、三个平台包 URLs 回 `200`、`updates` 资产 2194 B / `updated_at 2026-11-26T22:07:28Z`）。tag CI [45901786835](https://github.com/yunyu697/renomio/actions/runs/45901786835) 全部 10 个 job 一次全绿（version / frontend / backend / bundle-windows / bundle-linux / bundle-macos / bundle-checks + `cross-os` 的 ubuntu / windows / macos 三条，三条 cross-os 都真跑了新增的 `audio_container_contract` 11 条）；6 个签名包离线验签全 PASS（keyid `a1d8edb60bbc50fd`，trusted comment 绑定 `version:1.2.0-alpha23`）：NSIS 2,701,392 B / `01B1FC03A0A13B9CA768F4F8B002C1A33CFE0D1C0C61F08977B06BD0206E87C0`，MSI 3,559,424 B / `5188FAF75BB1BC8B0E02339601329CC9AAEBAFE5276EB4E257C5926975FD228C`，AppImage 87,120,376 B / `73A94BD611546A6BAB664060700D26F62086833EB68E81538560EB3557A8F108`，deb 3,654,342 B / `07EFBA092FA9F06EC4CCFD484F0A7BC1D714DFBD1E97D6FB94674A4FAFFD7B3`，dmg 3,848,936 B / `80DB83D38F1B7623A0A89390F717343B9D05CCEFAEC17403561678CFC5BE84C6`，`Renomio.app.tar.gz` 3,400,138 B / `C9ADCA750B5894F9E11AD934F86F601A5C8510DF49E4337F13B6845EB487F73B`；另有 mac `Renomio_1.2.0-alpha23_arm64.app.zip` 3,281,883 B / `9EB9A1F595E4A63728A8805A9CDA59D5049EC190D20BAE4CF66A932026B481F4`（无 `.sig`）。alpha22 的 tag CI 为 `45898584525`，alpha21 为 `45887565589`，alpha20 为 `45857997561`，alpha19 为 `45824773735`，alpha18 为 `45638124135`，alpha17 为 `45609266251`，alpha16 为 `45580888069`，alpha15 为 `45554430932`，alpha14 为 `45524619865`，alpha13 为 `45520274192`，alpha12 为 `45504761322`。macOS/Linux 产物由 CI 构建（macOS ad-hoc 签名、未公证），`cross-os` 只在无头环境跑，未在真机桌面手工点验；繁中/日/西译文未经母语审校。

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
- Windows 上想读「链接数 / 文件号」别用 `MetadataExt`：`file_index` / `number_of_links` / `volume_serial_number` 仍是 nightly 的 `windows_by_handle`，稳定版 `cargo check` 直接 E0658；改走 `GetFileInformationByHandle`（`CreateFileW` + `FILE_READ_ATTRIBUTES` + `FILE_FLAG_BACKUP_SEMANTICS|OPEN_REPARSE_POINT`）。
- Windows `symlink_dir` / `symlink_file` 在未提权时会**返回 1314 但链接已经建好**：判断「到底建没建成」必须实测（`symlink_metadata` + `read_link`/`canonicalize`），只看错误码会把半成功当失败；建 junction 前也要先确认目标位置确实不存在（`junction` crate 走 `FILE_CREATE`，占位目录得先清掉）。
- 整包 `cargo fmt` 会把历史未格式化的文件一起重排（一次二十多个纯格式改动）：本地只格式化本次改动的文件，别对 `renomio-core` 全量跑。

## 文档索引

`docs/交接说明.md`（总入口）、`docs/1.1.0-收口清单.md`、`docs/规则语义确认清单.md`、`docs/签名与打包流程.md`、`docs/更新链路真机记录.md`（应用内更新链真机跑通记录 + 复现脚本）、`docs/FEATURE-GAP.md`、`docs/P0-完成度与验证说明.md`、`CONTRIBUTING.md`。
