# 无头浏览器 E2E 报告

- 生成时间：2026-11-26T19:54:11.439Z
- 运行方式：无头浏览器 + mock Tauri 后端（未启动 GUI 窗口）
- 浏览器：`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
- 视口：1440×900（默认） / 1100×640@1.5x（最小尺寸）
- 结果：**362 通过 / 0 失败**
- 截图目录：`app/e2e/screenshots/`（已加入 `.gitignore`，仅本机保留，不随仓库分发）

## UI 层断言（DOM / 可见性 / 截图）

| 结果 | 断言 |
| --- | --- |
| ✅ 通过 | 首屏为浅色主题（{"theme":"light","bodyBg":"rgb(238, 241, 246)","panelBg":"rgb(255, 255, 255)"}） |
| ✅ 通过 | 首屏加载（桌面模式 + mock 后端） |
| ✅ 通过 | 初始列表为空 |
| ✅ 通过 | 「含隐藏文件」开关默认开启（true） |
| ✅ 通过 | 添加文件 → 列表出现 4 行 |
| ✅ 通过 | 表头与行逐列共用同一网格（7 列左右边缘偏差 ≤0.5px）（max=0 [{"col":"checkbox","dLeft":0,"dWidth":0},{"col":"name","dLeft":0,"dWidth":0},{"col":"location","dLeft":0,"dWidth":0},{"col":"size","dLeft":0,"dWidth":0},{"col":"modified","dLeft":0,"dWidth":0},{"col":"newName","dLeft":0,"dWidth":0},{"col":"status","dLeft":0,"dWidth":0}]） |
| ✅ 通过 | 状态列：表头文字与行内徽标左缘对齐（偏差 ≤1px）（textL=1283.98 chipL=1283.98 Δ=0.00） |
| ✅ 通过 | 规则编辑 → 原名/新名实时预览 |
| ✅ 通过 | 冲突行显示明确状态（不静默覆盖）（["可执行","可执行","冲突","未变更"]） |
| ✅ 通过 | 规则链排序（上移后顺序变化）（case → replace） |
| ✅ 通过 | 规则链排序（下移恢复）（replace → case） |
| ✅ 通过 | 列头排序只改变显示顺序（首行变为 logo.png）（logo.png元数据D:\e2e\设计86 KB2025-01-04 09:00logo.png未变更SpaceF2D） |
| ✅ 通过 | 预览弹窗打开 |
| ✅ 通过 | 冲突策略切换（自动加后缀） |
| ✅ 通过 | 冲突策略切回（跳过） |
| ✅ 通过 | 批次执行进度：进度条随批次推进变化（已处理/总数 · 当前文件名 · 可取消）（ui={"count":"0/3","phase":"准备批次日志","current":"—","cancel":true,"barWidth":"0%"} events=8 distinct=8） |
| ✅ 通过 | 应用 → 2 个完成 + 1 个冲突跳过（未改名文件不参与）（{"total":3,"done":2,"skipped":1,"failed":0}） |
| ✅ 通过 | 冲突文件保持原名 |
| ✅ 通过 | 撤销 → 4 个原名全部恢复（["旧照片 001.jpg","旧照片 002.jpg","旧照片 003.jpg","logo.png"]） |
| ✅ 通过 | 历史面板：批次展示时间 / 条目数 / 成功失败数 / 策略（2026-11-27 03:51 · 更名D:\e2e\旅行 · 2/3 成功 · 1 跳过 · 0 失败已撤销 · 策略 skip · 不可撤销该批次已经撤销-batch-1已撤） |
| ✅ 通过 | 历史面板：已撤销批次显示「已撤销」并说明原因（{"undoable":"0","state":"已撤销","reason":"该批次已经撤销","text":"2026-11-27 03:51 · 更名D:\\e2e\\旅行 · 2/3 成功 · 1 跳过 · 0 失败已撤销 · 策略 skip · 不可撤销该批次已经撤销-batch-1已撤销"}） |
| ✅ 通过 | 历史面板：新批次显示「可撤销」（{"undoable":"1","id":"mock-batch-2"}） |
| ✅ 通过 | 历史面板：撤销后条目变为「已撤销」（{"undoable":"0","state":"已撤销","chip":"已撤销","reason":"该批次已经撤销"}） |
| ✅ 通过 | 历史面板：较新批次可撤销时，「撤销到此」可用（多级撤销）（{"index":1,"undoable":"1","disabled":false}） |
| ✅ 通过 | 历史面板：多级撤销后两条批次都变为「已撤销」（[{"undoable":"0","state":"已撤销"},{"undoable":"0","state":"已撤销"}]） |
| ✅ 通过 | 明暗主题切换 → data-theme=dark 且面板底色变化（{"theme":"dark","panelBg":"rgb(21, 26, 35)"}） |
| ✅ 通过 | 跟随系统主题：settings.theme=system 且系统配色变化时实时跟随（{"storedTheme":"system","sysDark":"dark","sysLight":"light"}） |
| ✅ 通过 | 四套配色各自切换：data-palette 生效且背景/表面/文字/强调/悬停/选中/边框整体更换（{"graphite":{"attr":"graphite","theme":"light","bg":"#eef1f6","panel":"#ffffff","ink":"#131a26","accent":"#2f52e0","hover":"#f6f9ff","selected":"#eef3ff","border":"#cfd7e4"},"paper":{"attr":"paper","theme":"light","bg":"#f3efe6","panel":"#fffdf8","ink":"#241d16","accent":"#a13b2c","hover":"#fbf7ef","selected":"#f6eee3","border":"#d8cdba"},"ocean":{"attr":"ocean","theme":"light","bg":"#e8eff4","panel":"#fdfeff","ink":"#0d1c26","accent":"#0a6c8c","hover":"#f2f8fb","selected":"#eaf3f7","border":"#c6d6e0"},"moss":{"attr":"moss","theme":"light","bg":"#eff2ea","panel":"#fbfdf7","ink":"#161d13","accent":"#3f7537","hover":"#f7faf2","selected":"#f1f6eb","border":"#cdd6c1"}}） |
| ✅ 通过 | 明暗与配色分别持久化：settings 同时记录 moss 与 dark（{"palette":"moss","theme":"dark"}） |
| ✅ 通过 | 策略面板默认值（255 / 阻止 / 阻止 / 未命名 / 关）（{"max":"255","long":"block","empty":"block","fallback":"未命名","fallbackDisabled":true,"skip":"false"}） |
| ✅ 通过 | 空名处理切到「备用名」后备用名输入框可用（false） |
| ✅ 通过 | 元数据弹窗展示图片尺寸与只读标识（只读元数据只读旧照片 001.jpg · D:\e2e\旅行\旧照片 001.jpg图片JPEG 图像尺寸1920 × 1080 px文件大小2.3 MB未发现 EXIF 信息（可能是截图、导出图或已剥离元数据）本面板仅读取展示，不会修改文） |
| ✅ 通过 | 方案导出 → JSON 写入（版本 + 校验） |
| ✅ 通过 | 方案 JSON 结构完整（rules 为数组）（rules=2） |
| ✅ 通过 | 方案导入 → 显示校验通过与替换冲突提示 |
| ✅ 通过 | 方案导入 → 规则链已替换（replace,case） |
| ✅ 通过 | 不兼容方案（v2）→ 明确错误且不允许导入（无法导入该文件方案版本 v2 高于当前支持的 v1，请升级应用后再导入） |
| ✅ 通过 | 导出菜单提供 CSV / Excel / HTML / TSV 四种格式（4） |
| ✅ 通过 | CSV 导出 → 表头 + 原名/新名/状态/错误原因（6 行） |
| ✅ 通过 | CSV 含冲突原因文本 |
| ✅ 通过 | TSV 导出 → BOM + 制表符四列表头，行数与 CSV 一致（6 行 / 原文件名	新文件名	状态	原因） |
| ✅ 通过 | HTML 导出 → 完整文档 + 转义表格 + 中文表头（1655 字符） |
| ✅ 通过 | xlsx 导出 → 合法 ZIP 头、含工作簿/工作表/中文单元格（PK制式=true · 5271 字节） |
| ✅ 通过 | 编号「始于」可选 0（默认 1，改为 0 后预览出现 000）（start=0） |
| ✅ 通过 | 隐藏“位置”列 → 表头与行同步减少（th=6, cell=6） |
| ✅ 通过 | 列显示设置持久化（localStorage） |
| ✅ 通过 | 拖动表头调整列宽并持久化（285→325px, stored=325） |
| ✅ 通过 | 列菜单有「自动列宽」按钮且文案本地化（label=自动列宽） |
| ✅ 通过 | 自动列宽写入每列宽度并夹在上下界内（{"name":140,"size":62,"modified":108,"newName":150,"status":96}） |
| ✅ 通过 | 自动列宽后 name 列真的按内容变宽（不小于最小可读宽）（140px） |
| ✅ 通过 | 双击分隔线只自适应这一列（size 落在 62..96，name 不变）（size=62, name=140） |
| ✅ 通过 | 自动列宽后表头与行仍逐列对齐（各列左边界最大 Δ ≤ 1px）（Δ=0） |
| ✅ 通过 | 重置列宽清空自定义宽度（{}） |
| ✅ 通过 | 时间面板 → 不支持的创建时间字段禁用并标注 |
| ✅ 通过 | 时间预览 → 原值 → 新值（默认平移 1 天）（2025-01-01 08:00→2025-01-02 08:00） |
| ✅ 通过 | 时间预览随偏移量实时变化（2025-01-01 08:00→2025-01-02 08:00 → 2025-01-01 08:00→2025-01-03 08:00） |
| ✅ 通过 | 随机预览 → 每个文件落在所选区间且取值不同（2020-01-06 07:19 \| 2020-01-03 02:33 \| 2020-01-09 13:58 \| 2020-01-02 21:57） |
| ✅ 通过 | 时间面板提供 EXIF 拍摄时间写入开关 |
| ✅ 通过 | 时间修改 → 逐条结果面板 + 可撤销提示（4 成功 · 0 跳过 · 0 失败批次 mock-batch-6 已写入日志，可在「操作记录」撤销撤销本次关闭） |
| ✅ 通过 | 左栏只剩「文件」一组（检查器六类操作迁到抽屉分段），侧栏底部不再压「设置」（{"groups":[{"id":"nav-group-files","label":"文件▾","items":["nav-rename","nav-history","nav-snapshot","nav-plan"]}],"legacy":[],"oldPages":[],"segments":["inspector-tab-attrs","inspector-tab-meta","inspector-tab-time","inspector-tab-organize","inspector-tab-exif","inspector-tab-encoding"],"footSettings":false}） |
| ✅ 通过 | 抽屉头部六段分段齐全（属性 / 元数据 / 时间 / 归类 / EXIF / 编码）（["inspector-tab-attrs","inspector-tab-meta","inspector-tab-time","inspector-tab-organize","inspector-tab-exif","inspector-tab-encoding"]） |
| ✅ 通过 | 抽屉分段 attrs → 选中态正确，抽屉贴在内容列底部（列表与规则链不被替换）（{"selected":"true","inline":true,"collapsed":"false","main":true,"rules":true,"scope":"作用于 4 个文件"}） |
| ✅ 通过 | 抽屉分段 meta → 选中态正确，抽屉贴在内容列底部（列表与规则链不被替换）（{"selected":"true","inline":true,"collapsed":"false","main":true,"rules":true,"scope":"作用于 4 个文件"}） |
| ✅ 通过 | 抽屉分段 time → 选中态正确，抽屉贴在内容列底部（列表与规则链不被替换）（{"selected":"true","inline":true,"collapsed":"false","main":true,"rules":true,"scope":"作用于 4 个文件"}） |
| ✅ 通过 | 抽屉分段 organize → 选中态正确，抽屉贴在内容列底部（列表与规则链不被替换）（{"selected":"true","inline":true,"collapsed":"false","main":true,"rules":true,"scope":"作用于 4 个文件"}） |
| ✅ 通过 | 抽屉分段 exif → 选中态正确，抽屉贴在内容列底部（列表与规则链不被替换）（{"selected":"true","inline":true,"collapsed":"false","main":true,"rules":true,"scope":"作用于 4 个文件"}） |
| ✅ 通过 | 抽屉分段 encoding → 选中态正确，抽屉贴在内容列底部（列表与规则链不被替换）（{"selected":"true","inline":true,"collapsed":"false","main":true,"rules":true,"scope":"作用于 4 个文件"}） |
| ✅ 通过 | 「文件 → 重命名」回到更名列表：页头标题为更名列表，页签条已彻底消失（{"main":true,"head":"更名列表","tabs":0,"active":true}） |
| ✅ 通过 | 「文件 → 重命名」切回更名列表，不打开整页（[object Object]） |
| ✅ 通过 | 打开检查器 → 文件列表与规则链仍在同一屏（不整页替换工作台）（{"scope":"作用于 4 个文件","main":true,"rules":true,"width":840,"mainWidth":840,"below":true,"expanded":"true"}） |
| ✅ 通过 | 检查器头部常驻「作用于 N 个文件」，N 与列表勾选一致（作用于 4 个文件 / 列表勾选 4） |
| ✅ 通过 | 检查器是压在列表下方的底部抽屉（与内容列同宽、位于表格之下，不再占右栏 320px）（{"scope":"作用于 4 个文件","main":true,"rules":true,"width":840,"mainWidth":840,"below":true,"expanded":"true"}） |
| ✅ 通过 | 抽屉可收起成一条 36px 头部（正文隐藏，不是整块消失）（{"state":"true","head":36,"body":0}） |
| ✅ 通过 | 再点一次恢复展开（data-collapsed=false 且正文回来）（false） |
| ✅ 通过 | ≤1100 窄窗：抽屉依旧在内容列底部（不降级成覆盖列表的浮层）（{"position":"static","mainWidth":644,"inMain":true}） |
| ✅ 通过 | 无抽屉时提示条贴右侧边距（right ≈ 视口右缘 − space-6）（vw=1440 pillRight=1424.0 space6=16 data-drawer=0） |
| ✅ 通过 | 右侧抽屉展开：提示条让位到抽屉左侧（矩形不相交）（pillRight=984.0 drawerLeft=1000.0 drawerW=440 data-drawer=1） |
| ✅ 通过 | 底部检查器展开：提示条与检查器矩形不相交（pill=[1004,561,1424,599] dock=[200,611,1040,848]） |
| ✅ 通过 | 列表取消勾选一行 → 检查器计数同步减一（同一份选择源）（作用于 3 个文件 / 列表勾选 3） |
| ✅ 通过 | 检查器「时间」页签复用真实批量读取，行数与勾选数一致（3 行 / 勾选 3） |
| ✅ 通过 | 检查器「元数据」页签复用真实编辑器，并说明只写入勾选的文件（只写入勾选的文件；逐字段勾选后才会保存，并保留可还原的备份。） |
| ✅ 通过 | 检查器「归类」页签按勾选生成移动预览（3 行） |
| ✅ 通过 | 关闭检查器 → 工作台恢复，开关收起状态同步（{"gone":true,"expanded":"false","main":true}） |
| ✅ 通过 | 列表未勾选 → 检查器显示空态、保持列表勾选为 0（不再由页面自动全选）（{"selectedBefore":0,"autoPanel":{"empty":true,"scope":"作用于 0 个文件","selected":0,"main":true}}） |
| ✅ 通过 | 抽屉「元数据」分段复用真实编辑器，N 与列表勾选一致（{"fields":true,"unsupported":false,"hasApply":true,"scope":"作用于 1 个文件"}） |
| ✅ 通过 | 属性预览 → 可写 → 只读（原值 → 新值）（文件只读 / 隐藏 / 系统 / 存档（原 → 新）状态旧照片 001.jpg可写 / 可见 / 非系统 / 未存档→只读 / 可见 / 非系统 / 未存档待写入旧照片 002.jpg可写 / 可见 / 非系统 / 未存档→只读 / 可见 / 非系统 / 未存档待写入旧照片 003.jpg只读 / 可见 / 非系统 /） |
| ✅ 通过 | 属性面板提供「取反」模式（只读 / 隐藏） |
| ✅ 通过 | 取反预览 → 可写变只读、只读变可写（逐行原值→取反值）（文件只读 / 隐藏 / 系统 / 存档（原 → 新）状态旧照片 001.jpg可写 / 可见 / 非系统 / 未存档→只读 / 可见 / 非系统 / 未存档待写入旧照片 002.jpg可写 / 可见 / 非系统 / 未存档→只读 / 可见 / 非系统 / 未存档待写入旧照片 003.jpg只读 / 可见 / 非系统 /） |
| ✅ 通过 | 归类预览 → 正则捕获组生成目标子目录（ready=3） |
| ✅ 通过 | 归类预览 → 目标路径使用捕获组值与默认根目录（d:\e2e\归类结果\001\旧照片 001.jpg \| d:\e2e\归类结果\002\旧照片 002.jpg \| d:\e2e\归类结果\003\旧照片 003.jpg） |
| ✅ 通过 | 归类默认根目录 = 勾选文件共同父目录下的「归类结果」（d:\e2e\归类结果） |
| ✅ 通过 | 归类模板 → 默认值为 <EXT>（按扩展名归类）（<EXT>） |
| ✅ 通过 | 归类模板 <EXT>/<DATE:yyyy> → 生成两级目录（jpg / png 各带年份）（d:\e2e\归类结果\jpg\2025\旧照片 001.jpg \| d:\e2e\归类结果\jpg\2025\旧照片 002.jpg \| d:\e2e\归类结果\jpg\2025\旧照片 003.jpg \| d:\e2e\归类结果\png\2025\logo.png） |
| ✅ 通过 | 模板含哈希变量 <MD5> → 全部行 invalid 并说明原因（原位置新位置（子目录 / 文件名）状态D:\e2e\旅行\旧照片 001.jpg（无法计算）归类模板不支持哈希变量 <MD5>D:\e2e\旅行\旧照片 002.jpg（无法计算）归类模板不支持哈希变量 <MD5>D:\e2e\旅行\旧照片 003.jpg（无法计算）归类模板不支持哈希变量 <MD5>D:\e2e\设计\logo.png（无法计算）归类模板不） |
| ✅ 通过 | 模板含未知变量 → 提示「未知变量 <FOO>」（原位置新位置（子目录 / 文件名）状态D:\e2e\旅行\旧照片 001.jpg（无法计算）未知变量 <FOO>D:\e2e\旅行\旧照片 002.jpg（无法计算）未知变量 <FOO>D:\e2e\旅行\旧照片 003.jpg（无法计算）未知变量 <FOO>D:\e2e\设计\logo.png（无法计算）未知变量 <FOO>） |
| ✅ 通过 | 模板含 <#> → 提示不支持序号变量（原位置新位置（子目录 / 文件名）状态D:\e2e\旅行\旧照片 001.jpg（无法计算）归类模板不支持 <#>（没有编号上下文）D:\e2e\旅行\旧照片 002.jpg（无法计算）归类模板不支持 <#>（没有编号上下文）D:\e2e\旅行\旧照片 003.jpg（无法计算）归类模板不支持 <#>（没有编号上下文）D:\e2e\设计\logo.png（无） |
| ✅ 通过 | 关闭「含隐藏文件」→ 扫描参数 includeHidden=false 且隐藏文件不进入列表（aria=false, scan=false, rows=4） |
| ✅ 通过 | 开启「含隐藏文件」→ includeHidden=true 且隐藏文件进入列表（scan=true, visible=true） |
| ✅ 通过 | 加入音乐 / Office / PDF / 文本文档后列表共 9 行（rows=9） |
| ✅ 通过 | 页签条彻底下线：list-tabs / list-tab-* / 按类型拆开的只读视图都不再渲染，列表成唯一主视图（{"tabs":0,"views":0,"head":"更名列表","rows":9,"filters":true,"metaAction":true}） |
| ✅ 通过 | 页头标题固定在「更名列表」，不再随页签改名（更名列表） |
| ✅ 通过 | 归类分段直接打开真实移动面板（不再依赖页签行按钮）（true） |
| ✅ 通过 | 属性分段直接打开真实属性面板（不再依赖页签行按钮）（true） |
| ✅ 通过 | 快捷键提示默认不常驻（kbd 默认 opacity 0） |
| ✅ 通过 | `/` 聚焦搜索框 |
| ✅ 通过 | Space 取消当前行勾选（before=9 after=8） |
| ✅ 通过 | Space 再按一次回到原勾选状态（before=9 after=9） |
| ✅ 通过 | F2 打开行内改名输入框并聚焦 |
| ✅ 通过 | Esc 退出行内改名 |
| ✅ 通过 | 切回更名列表（rows=9） |
| ✅ 通过 | 拖放 enter → 注册监听器收到事件并显示高亮遮罩（hit=1） |
| ✅ 通过 | 拖放 over → 命中同一监听器且遮罩保持 |
| ✅ 通过 | 拖放 leave → 遮罩消失（hit=1） |
| ✅ 通过 | 规则区内部拖拽（无 Files）不误触发文件拖放遮罩（overlay=false） |
| ✅ 通过 | 拖放松手后提示拖入计数（已添加 2 个对象） |
| ✅ 通过 | 1100×640 @150% DPI 外层无横向溢出（{"innerWidth":1100,"scrollWidth":1100,"innerHeight":640,"scrollHeight":640,"actionBottom":640,"actionRight":1100,"toolbarBottom":89,"dpr":1.5,"rulesVisible":true}） |
| ✅ 通过 | 1100×640 @150% DPI 窄窗单列不出现表格横向滚动（列按可用宽度排布）（{"clientWidth":629,"scrollWidth":629,"scrollable":false}） |
| ✅ 通过 | 1100×640 @150% DPI 操作条与工具栏未被裁切（{"innerWidth":1100,"scrollWidth":1100,"innerHeight":640,"scrollHeight":640,"actionBottom":640,"actionRight":1100,"toolbarBottom":89,"dpr":1.5,"rulesVisible":true}） |
| ✅ 通过 | 1100×640 @150% DPI：底部抽屉不撑破页面，抽屉头部六段与内容都可读（{"innerWidth":1100,"scrollWidth":1100,"innerHeight":640,"tabsClient":360,"tabsScroll":360,"tabsDir":"row","tabsWrap":"nowrap","tabRect":{"x":260,"w":360},"mainW":644,"rulesW":400,"navW":56,"panesW":1044,"panesX":56,"rulesX":700,"panesKids":["main:644@56","rules:400@700"],"viewBottom":588,"viewHeight":150,"segItems":6,"segOverflow":false}） |
| ✅ 通过 | 「清空列表」先弹二次确认，文案写明只移出列表、磁盘文件不动，且弹层不越出内容列（{"text":"列表中的 11 个对象会被移出，磁盘上的文件不会被删除或修改。取消清空","rows":11,"confirmLeft":599,"mainRight":700}） |
| ✅ 通过 | 取消清空 → 列表行数完全不变（rows=11） |
| ✅ 通过 | 确认清空 → 列表回到空态、磁盘文件数量不变、清空按钮转为禁用（{"rows":0,"files":11,"disabled":true,"tabsGone":0}） |
| ✅ 通过 | 清空后重新添加 → 列表恢复 9 行（磁盘文件确实还在）（rows=11） |
| ✅ 通过 | 列表 / 抽屉 / 拖放流程无未捕获页面异常（exceptions=0） |
| ✅ 通过 | 权限失败逐条列出（不是整批一个「失败」）（["access-denied"]） |
| ✅ 通过 | 失败清单按原因汇总（权限不足 1）（权限不足（ACL 拒绝） 1） |
| ✅ 通过 | 权限失败给出「以管理员身份重启」+ 每条「跳过该项」（relaunch=true, skip=1） |
| ✅ 通过 | UAC 取消后继续以普通权限运行（不循环弹窗）（已取消管理员授权，继续以普通权限运行。Program Files 或受限目录中的改名可能仍被拒绝；可随时在「设置」里重新） |
| ✅ 通过 | 跳过该项只移出提示、不影响其它条目 |
| ✅ 通过 | 已提权时明确提示拖放会被 UIPI 拦截并给出替代入口（已以管理员身份运行（C:\Program Files\Renomio）。Windows 的 UIPI 会拦截普通权限资源管理器发来的拖放，拖） |
| ✅ 通过 | UIPI 提示可关闭，不遮挡主界面 |
| ✅ 通过 | 首次启动提示已导入上一版本数据（含文件数与旧目录保留说明）（已导入上一版本（Rename Studio）的数据（3 个文件）。旧数据目录仍保留，可随时回退。关闭） |
| ✅ 通过 | 迁移提示关闭后不再重复弹 |
| ✅ 通过 | 设置提供「从旧版导入数据」手动入口 |
| ✅ 通过 | ja-JP：界面文案确实切换到目标语言（
    Renomio☀ファイルを追加フォルダーを追加プランを読み込みプランを保存元に戻すCtrl+Z追加順に戻すCt） |
| ✅ 通过 | ja-JP @125%：页面无横向溢出，按钮/表头/侧栏/操作条无截断（{"innerWidth":1100,"scrollWidth":1100,"buttons":[],"headers":[],"nav":[],"actions":[],"rows":4}） |
| ✅ 通过 | ja-JP @150%：页面无横向溢出，按钮/表头/侧栏/操作条无截断（{"innerWidth":1100,"scrollWidth":1100,"buttons":[],"headers":[],"nav":[],"actions":[],"rows":4}） |
| ✅ 通过 | es-ES：界面文案确实切换到目标语言（
    Renomio☀Añadir archivosAñadir carpetaImportar planGuard） |
| ✅ 通过 | es-ES @125%：页面无横向溢出，按钮/表头/侧栏/操作条无截断（{"innerWidth":1100,"scrollWidth":1100,"buttons":[],"headers":[],"nav":[],"actions":[],"rows":4}） |
| ✅ 通过 | es-ES @150%：页面无横向溢出，按钮/表头/侧栏/操作条无截断（{"innerWidth":1100,"scrollWidth":1100,"buttons":[],"headers":[],"nav":[],"actions":[],"rows":4}） |
| ✅ 通过 | en-US：界面文案确实切换到目标语言（
    Renomio☀Add filesAdd folderImport planSave planUndoCtrl） |
| ✅ 通过 | en-US @125%：页面无横向溢出，按钮/表头/侧栏/操作条无截断（{"innerWidth":1100,"scrollWidth":1100,"buttons":[],"headers":[],"nav":[],"actions":[],"rows":4}） |
| ✅ 通过 | en-US @150%：页面无横向溢出，按钮/表头/侧栏/操作条无截断（{"innerWidth":1100,"scrollWidth":1100,"buttons":[],"headers":[],"nav":[],"actions":[],"rows":4}） |
| ✅ 通过 | 变量插入面板列出常用元变量（FILENAME/NAME/EXT/SUBSTR/DIFNSUBSTR/CRC32/USER1/#）（var-toggle,var-panel,var-FILENAME,var-NAME,var-EXT,var-DOTEXT,var-SUBSTR,var-DIFNSUBSTR,var-DIR,var-DATE,var-TIME,var-SIZE,var-CRC32,var-MD5,var-SHA1,var-USER0,var-USER1,var-#） |
| ✅ 通过 | 点击变量插入到表达式（<#><NAME>） |
| ✅ 通过 | 元变量与序号组合的实时预览（logo.png → logo_001.png）（logo.pngMetadataD:\e2e\设计86 KB2025-01-04 09:00logo_001.png.pngReadySpaceF2Del） |
| ✅ 通过 | 变量面板实时示例（IMG_2048_1.jpg） |
| ✅ 通过 | 规则链为单栏：无两栏网格、编辑器嵌在卡片内、同一时间只展开一条（{"display":"flex","grid":"none","details":1,"inCard":true,"cards":3,"twoColumnDetail":false}） |
| ✅ 通过 | 规则链初始顺序为 replace,number,case（replace,number,case） |
| ✅ 通过 | 上移按钮改变顺序（replace,case,number）（replace,case,number） |
| ✅ 通过 | Alt+↓ 键盘排序改变顺序（case,replace,number）（case,replace,number） |
| ✅ 通过 | 拖拽排序改变顺序（number,case,replace）（{"orderDrag":"number,case,replace","dragProbe":{"log":["dragstart@drag","dragover@rule-card","drop@rule-card","dragend@drag"],"types":["function","function"],"transfer":1}}） |
| ✅ 通过 | 拖拽后展开项仍为 case（未误触折叠）（case） |
| ✅ 通过 | 重启后规则顺序保留（number,case,replace）（number,case,replace） |
| ✅ 通过 | 重启后展开的规则保留（case）（case） |
| ✅ 通过 | 点击折叠后编辑器收起（0） |
| ✅ 通过 | 重启后折叠状态保留（仍为 0 个展开编辑器）（0） |
| ✅ 通过 | 键位窗列出 5 条全局快捷键（5） |
| ✅ 通过 | 键位窗默认绑定与旧版一致（Ctrl+K,Ctrl+O,Ctrl+Shift+O,Ctrl+Enter,Ctrl+Z） |
| ✅ 通过 | 录制 Ctrl+Shift+K 后搜索绑定即时更新（Ctrl+Shift+K） |
| ✅ 通过 | 录制冲突组合键被拒绝，并提示占用的命令（That combination is already used by "Search and focus" \| search=Search and focus \| 已存 undo=Ctrl+Z） |
| ✅ 通过 | 录制中按 Esc 只取消录制，键位窗保留（true \| undo=Ctrl+Z） |
| ✅ 通过 | 重启后自定义绑定保留（搜索 = Ctrl+Shift+K）（Ctrl+Shift+K） |
| ✅ 通过 | 自定义绑定真正生效：旧 Ctrl+K 不再命中，新 Ctrl+Shift+K 聚焦搜索（ → global-search） |
| ✅ 通过 | 恢复默认后搜索绑定回到 Ctrl+K（Ctrl+K） |
| ✅ 通过 | 恢复默认后 Ctrl+K 重新聚焦搜索（global-search） |
| ✅ 通过 | 五种预设视图、五种窗口规模：控件裁切 = 0（{"combos":25,"clipped":0,"samples":[]}） |
| ✅ 通过 | 所有开关滑块居中（上下等间隙、开态贴右关态贴左、滑块为正圆）（{"seen":135,"bad":0,"samples":[]}） |
| ✅ 通过 | 五种预设视图、五种窗口规模：横向滚动条 = 0（{"horizontal":0,"pageOverflow":0,"samples":[]}） |
| ✅ 通过 | 五种预设视图、五种窗口规模：控件文字截断 = 0（{"clipped":0,"horizontal":0,"truncated":0,"combos":25,"pageOverflow":0,"switchBad":0,"switchSeen":135,"samples":[]}） |
| ✅ 通过 | 各视图方向/顺序正确（并排左右、上下先后、紧凑整宽）（{"1440-files-left":true,"1440-rules-left":true,"1440-files-top":true,"1440-rules-top":true,"1440-compact":true,"1650-files-left":true,"1650-rules-left":true,"1650-files-top":true,"1650-rules-top":true,"1650-compact":true,"1280-files-left":true,"1280-rules-left":true,"1280-files-top":true,"1280-rules-top":true,"1280-compact":true,"1200-files-left":true,"1200-rules-left":true,"1200-files-top":true,"1200-rules-top":true,"1200-compact":true,"1100-files-left":true,"1100-rules-left":true,"1100-files-top":true,"1100-rules-top":true,"1100-compact":true}） |
| ✅ 通过 | 1100 窄窗下并排视图不翻转（仍是左右分区，视图设置不变）（{"narrow":"true","nav":"rail","view":"rules-left","dir":"row"}） |
| ✅ 通过 | 1100 窄窗侧栏折叠为常驻图标列（宽 56、当前栏目可见、无浮动汉堡）（{"display":"flex","left":0,"width":56,"labelShown":false,"activeShown":true,"fab":false,"toggle":true,"notice":false}） |
| ✅ 通过 | 窄窗点展开 → 图标列原位展开为完整侧栏（宽 200、分组标题可见）（{"nav":"expanded","width":200,"labelShown":true}） |
| ✅ 通过 | 窄窗展开后再点同一个按钮 → 收回到图标列（双向可逆）（{"nav":"rail","width":56}） |
| ✅ 通过 | 窄窗点侧栏入口 → 打开对应抽屉并自动收回图标列（{"nav":"rail","drawer":true}） |
| ✅ 通过 | 恢复宽窗后回落到用户视图 rules-left（并排）（{"narrow":"false","view":"rules-left","dir":"row"}） |
| ✅ 通过 | 布局菜单文字全部本地化（无 layout. 原始 key）（{"trigger":"Stacked · rules on top","items":["Side by side · files left","Side by side · rules left","Stacked · files on top","Stacked · rules on top","Compact single column"]}） |
| ✅ 通过 | 高级模式拖动分隔条改变规则栏尺寸并写入该视图独立尺寸（{"h1":320,"h2":380,"sizes":{"files-left":400,"rules-left":400,"files-top":320,"rules-top":380}}） |
| ✅ 通过 | 重启后保留视图 rules-top 与拖动尺寸（{"before":380,"after":380,"stateAfterReload":{"view":"rules-top","advanced":"true","h":380}}） |
| ✅ 通过 | 设置面板含布局分区：5 个 preset 缩略示意图 + 尺寸输入 + 重置，且无 layout. 原始 key（{"picks":5,"thumbs":5,"rawKeys":false,"sizeInput":true,"reset":true}） |
| ✅ 通过 | 设置 › 运行环境显示数据目录来源（默认 = 每用户默认位置）（Per-user default） |
| ✅ 通过 | 非便携模式不显示便携说明，也不显示回落原因（false） |
| ✅ 通过 | 设置面板切换 preset → 视图立即切换到 compact（compact） |
| ✅ 通过 | advanced 关闭 → 不再渲染不可拖的分隔条（0） |
| ✅ 通过 | advanced 开启 → 分隔条恢复渲染（1） |
| ✅ 通过 | compact 默认收起：只渲染紧凑条，不渲染规则区（{"view":"compact","rules":false,"toggle":true,"expanded":"false"}） |
| ✅ 通过 | compact 展开 → 规则区是底部面板（不再固定 260px），高度按窗口比例伸缩（{"expanded":"true","ruleH":378,"panesH":731,"flexBasis":"auto","rulesBelowMain":true}） |
| ✅ 通过 | 重启后保留 compact 展开状态（规则区仍展开）（{"view":"compact","rules":true,"expanded":"true"}） |
| ✅ 通过 | 冲突命中：同路径包含+排除、前缀/子目录重叠（2 条独立冲突）（{"count":2,"items":["include-exclude","path-overlap"]}） |
| ✅ 通过 | 冲突命中：动作矛盾与正则等价合并为一条（同一对规则只出现一次）（{"count":1,"items":["regex-overlap,action-contradiction"],"badges":2,"rules":2,"modal":false}） |
| ✅ 通过 | 冲突不阻断保存：两条规则仍在、无阻断弹窗、两条规则就地标出（{"count":1,"items":["regex-overlap,action-contradiction"],"badges":2,"rules":2,"modal":false}） |
| ✅ 通过 | 点击冲突汇总可跳转到对应规则（展开并聚焦）（{"firstRuleId":"rmwxyz3tr1","jumpState":{"openId":"rmwxyz3tr1","detail":1,"focused":"rmwxyz3tr1"}}） |
| ✅ 通过 | 冲突命中：后一条被遮蔽不可达（{"items":2,"hasShadow":true}） |
| ✅ 通过 | 冲突不命中：模式不重叠且替换互不相干时不提示（{"panel":false,"items":0,"badges":0,"rules":2}） |
| ✅ 通过 | 筛选组：没填条件时不显示执行按钮（{"btn":0,"rows":4}） |
| ✅ 通过 | 筛选组：填了条件后按钮出现在条件旁边，并带说明（{"btn":1,"label":"Keep matches","hint":"Remove rows that do not match the include/exclude globs above — list only, nothing on disk is touched"}） |
| ✅ 通过 | 执行筛选：一条都不匹配时列表不动并给出提示（{"rows":4,"toast":"Nothing matches the current filter (of 4); the list is unchanged"}） |
| ✅ 通过 | 执行筛选：通配符匹配全部时行数不变并给出保留数（{"rows":4,"toast":"Kept 4 of 4 items after filtering"}） |
| ✅ 通过 | 执行筛选：输入框里按 Enter 与点按钮等效（Nothing matches the current filter (of 4） |
| ✅ 通过 | 执行筛选：Esc 清空条件并收起按钮（{"value":"","btn":0}） |
| ✅ 通过 | 更多菜单：不再有「筛选」项（入口已内联）（{"filterItem":0,"items":3}） |
| ✅ 通过 | 对照表：规则菜单可新增 map 规则，编辑器有表格框、大小写开关与提示（{"card":1,"table":1,"cases":1,"hint":1}） |
| ✅ 通过 | 对照表：整段旧名映射成新词，扩展名保持不变（{"mapBefore":{"oldName":"旧照片 001.jpg","stem":"旧照片 001","ext":".jpg","newName":"旧照片 001.jpg"},"mapAfter":{"oldName":"旧照片 001.jpg","stem":"旧照片 001","ext":".jpg","newName":"MAPED.jpg"}}） |
| ✅ 通过 | 对照表：条目计数按实际可解析的条数显示（2） |
| ✅ 通过 | 对照表：坏行就地报错（带行号），且该规则不参与改名（{"mapBad":{"errors":2,"text":"Line 1 has no separator (= or tab): MAP_NO_SEP_LINE0 entries recognised","newName":"旧照片 001.jpg"},"old":"旧照片 001.jpg"}） |
| ✅ 通过 | 正则开启时替换串旁给出 \1 分组引用提示（含等价写法 $1）（With regex on, \1…\9 in the replacement are group references (same as $1…$9) and \0 is the） |
| ✅ 通过 | 正则替换：替换串写 \1 时按第 1 个捕获组展开（不是字面反斜杠）（{"expanded":["旧照片 第001组.jpg","旧照片 第002组.jpg","旧照片 第003组.jpg"],"sample":["旧照片 第001组.jpg","logo.png","旧照片 第002组.jpg","旧照片 第003组.jpg"]}） |
| ✅ 通过 | 引用分组超出正则实际分组数 → 规则卡就地报错（不静默生成错名）（Replacement references \3 but the pattern has only 1 capture group(s)） |
| ✅ 通过 | \\1 表示字面反斜杠：不参与分组校验、预览里保留 \1 文本（{"err":"","sample":["旧照片 \\1.jpg","logo.png","旧照片 \\1.jpg"]}） |
| ✅ 通过 | 正则替换：替换串写 \0 时展开为整段匹配（Delphi 方言）（["旧照片 [001].jpg","logo.png","旧照片 [002].jpg","旧照片 [003].jpg"]） |
| ✅ 通过 | 只替换第 2 个匹配：替换串 \1 仍按捕获组展开（不写进字面）（[{"oldName":"旧照片 001.jpg","newName":"旧照片 0[0]1.jpg","expected":"旧照片 0[0]1.jpg"},{"oldName":"旧照片 002.jpg","newName":"旧照片 0[0]2.jpg","expected":"旧照片 0[0]2.jpg"},{"oldName":"旧照片 003.jpg","newName":"旧照片 0[0]3.jpg","expected":"旧照片 0[0]3.jpg"}]） |
| ✅ 通过 | 大小写规则提供例外词输入框，并提示 * / ? 通配与保留原大小写（{"box":true,"hint":"Comma or newline separated; * and ? wildcards allowed. Match"}） |
| ✅ 通过 | 例外词命中：upper 后 logo.png 保留原写法（其余行照旧大写）（{"protectedLogo":{"name":"logo.png","unchanged":true},"sample":["旧照片 001.jpg","logo.png","旧照片 002.jpg"]}） |
| ✅ 通过 | 清空例外词后同一行按 upper 变成 LOGO.png（说明保护只作用于命中的片段）（{"name":"LOGO.png","unchanged":false}） |
| ✅ 通过 | 元数据字段下拉含 17 个字段、按拍摄参数 / 图像尺寸 / 音频标签三组展示（{"count":17,"groups":["Shooting settings","Image size","Audio tags"],"values":["taken","camera","iso","aperture","shutter","focal","lens","width","height","resolution","title","artist","album","track","year","genre","composer"]}） |
| ✅ 通过 | 按 ISO 取值前缀取名：400「空格」旧照片 001.jpg（{"name":"400 旧照片 001.jpg","unchanged":false}） |
| ✅ 通过 | 规则摘要写明来源（EXIF + ISO），不是裸字段名（Prefix with EXIF ISO (separator “ ”)） |
| ✅ 通过 | 按镜头取值取名：RF35mm F1.8 旧照片 001.jpg（{"name":"RF35mm F1.8 旧照片 001.jpg","unchanged":false}） |
| ✅ 通过 | 按像素尺寸取值取名：5472x3648 旧照片 001.jpg（{"name":"5472x3648 旧照片 001.jpg","unchanged":false}） |
| ✅ 通过 | 切换字段前所有照片行都真的改了名（不是只改首行）（[{"name":"旧照片 001.jpg","next":"5472x3648 旧照片 001.jpg"},{"name":"logo.png","next":"5472x3648 logo.png"},{"name":"旧照片 002.jpg","next":"5472x3648 旧照片 002.jpg"}]） |
| ✅ 通过 | 缺失字段（照片选音频作曲）时该行保持原名且标记 unchanged（{"name":"旧照片 001.jpg","unchanged":true}） |
| ✅ 通过 | 扩展名模式分段新增「Analyze」，共 6 项（{"count":6,"labels":["Case","Replace","Add","Number","Remove","Analyze"]}） |
| ✅ 通过 | 点「Analyze」后分段选中该项并给出文件头说明（{"on":5,"hint":"Reads the file header to find the real type and only fixes a wrong extension; when detection fails the name stays as is."}） |
| ✅ 通过 | 规则摘要写明按文件头纠正扩展名（Fix extension from file header） |
| ✅ 通过 | 错标 002.jpg（实为 PNG）被纠正为 .png（{"name":"旧照片 002.jpg","next":"旧照片 002.png","unchanged":false}） |
| ✅ 通过 | 扩展名本来就对（001.jpg）不动名且标记 unchanged（{"name":"旧照片 001.jpg","next":"旧照片 001.jpg","unchanged":true}） |
| ✅ 通过 | 魔数识别不出（003.jpg）保持原名，绝不猜（{"name":"旧照片 003.jpg","next":"旧照片 003.jpg","unchanged":true}） |
| ✅ 通过 | 错标 logo.png（实为 JPEG）被纠正为 .jpeg（{"name":"logo.png","next":"logo.jpeg","unchanged":false}） |
| ✅ 通过 | 切回「Case」后 Analyze 说明消失且不再纠正扩展名（{"on":0,"hint":false,"names":["旧照片 001.jpg","logo.png","旧照片 002.jpg","旧照片 003.jpg"]}） |
| ✅ 通过 | 移动规则提供定位方式（默认第一项=按位置）与插入到（默认第一项=目标之前）两处分段（{"byOptions":["Position","Markers"],"byActive":"Position","insertOptions":["Before target","After target"],"insertActive":"Before target","from":true,"markers":false}） |
| ✅ 通过 | 按位置移动：照片搬到最前 → 照片旧 001.jpg（{"name":"照片旧 001.jpg","unchanged":false}） |
| ✅ 通过 | 摘要写明起点、长度与落点（Move 2 chars … before character 1）（Move 2 chars from position 2 before character 1） |
| ✅ 通过 | 插到第 3 个字符之前 → 旧 照片001.jpg（{"name":"旧 照片001.jpg","unchanged":false}） |
| ✅ 通过 | 改成「目标之后」后同一 to=3 落点右移一位 → 旧 0照片01.jpg（{"afterSeg":["Before target","After target"],"afterActiveIndex":1,"afterAt3":{"name":"旧 0照片01.jpg","unchanged":false}}） |
| ✅ 通过 | 切到「按标记」后换成左右标记输入、按位置的起止输入隐藏（{"byMarkerSeg":["Position","Markers"],"byMarkerActive":1,"markerFields":{"left":true,"right":true,"index":false}}） |
| ✅ 通过 | 按标记移动：不包含起始标记时，旧照之后的内容 片 001 搬到开头（{"includeStartLabel":"Include start marker","includeStartOff":"false","markerMoved":{"name":"片 001旧照.jpg","unchanged":false}}） |
| ✅ 通过 | 摘要改用标记描述（「旧照」与结尾 Tail 之间的内容）（Move what sits between 旧照 and end before character 1） |
| ✅ 通过 | 标记在名字里找不到时该行保持原名并标记 unchanged（{"name":"旧照片 001.jpg","unchanged":true}） |
| ✅ 通过 | 两个标记都留空时规则卡就地报错（不静默整串搬运）（Marker mode needs at least one marker） |
| ✅ 通过 | 删除规则有四处分段且默认落在「修剪」：同时出现修剪字符输入与说明，按位置的输入不出现（{"options":["By position","Between markers","Character set","Trim ends"],"active":"Trim ends","trimChars":true,"trimHint":"Trims the ends only and leaves the middle alone: with no characters listed it trims whitespace (full-width spaces and tabs included), otherwise it strips the listed characters.","rangeFrom":false}） |
| ✅ 通过 | 默认修剪不动无首尾空白的名字，摘要写明剪首尾空白（{"trimOnly":{"name":"旧照片 001.jpg","unchanged":true},"trimOnlySum":"Trim leading/trailing whitespace"}） |
| ✅ 通过 | 按位置删除：第 1 个字符起删 2 个 → 片 001.jpg，且「从尾部数」说明默认不显示（{"rangeActive":0,"rangeFields":{"from":true,"count":true,"fromEnd":true,"hint":false},"rangeRow":{"name":"片 001.jpg","unchanged":false}}） |
| ✅ 通过 | 摘要写明按位置删除的起点与个数（Delete 2 chars from position 1）（Delete 2 chars from position 1） |
| ✅ 通过 | 开启「从尾部数」后出现用法说明，且倒数第 3 个起删 2 个 → lo.png（起点朝词尾延伸）（{"fromEndOn":"true","fromEndHint":"Counting from the end, the start is measured backwards from the last character: position 4 with 4 chars removes the last 4 characters.","tailRow":{"name":"lo.png","unchanged":false}}） |
| ✅ 通过 | 从尾部数不会退回旧行为（旧窗口朝词首会给 og.png）（lo.png） |
| ✅ 通过 | 摘要写明「从尾部数」并点明朝结尾方向（Delete 2 chars from position 3 counted from the end (towards the end)） |
| ✅ 通过 | 倒数第 1 个起删 1 个 → log.png（只动末尾）（{"name":"log.png","unchanged":false}） |
| ✅ 通过 | 首尾之间默认两标记都含，关掉后只删中间 → 旧片 001.jpg（{"betweenFields":{"left":true,"right":true,"includeLeft":"true","includeRight":"true","count":false},"betweenInner":{"name":"旧片 001.jpg","unchanged":false}}） |
| ✅ 通过 | 重新勾上起始标记后连标记一起删 → 片 001.jpg（{"includeLeft":"true","row":{"name":"片 001.jpg","unchanged":false}}） |
| ✅ 通过 | 两个标记都留空时规则卡就地报错，且不会把名字整串删空（{"delMarkerErr":"Between mode needs at least one of the two markers","delMarkerRow":{"name":"旧照片 001.jpg","unchanged":true}}） |
| ✅ 通过 | 字符集模式有字符输入与「只保留」开关，删数字后 → 旧照片 .jpg（{"charsetReachable":true,"charsetDrop":{"name":"旧照片 .jpg","unchanged":false}}） |
| ✅ 通过 | 打开「只保留」后 → 001.jpg（{"name":"001.jpg","unchanged":false}） |
| ✅ 通过 | 自定义修剪字符 1：末位的 1 被剪掉 → 旧照片 00.jpg，摘要写明剪掉的字符（{"trimCharsRow":{"name":"旧照片 00.jpg","unchanged":false},"trimCharsSum":"Trim leading/trailing “1”"}） |
| ✅ 通过 | 修剪说明改写为可自定义字符（不再是「只有空白」）（Trims the ends only and leaves the middle alone: with no characters listed it trims whitespace (full-width spaces and tabs included), otherwise it strips the listed characters.） |
| ✅ 通过 | 清空修剪字符后回到只剪空白 → 名字不变（{"name":"旧照片 001.jpg","unchanged":true}） |
| ✅ 通过 | 编号分组下拉同步新增字段（field:iso / field:resolution / field:composer）（{"groups":["Shooting settings","Image size","Audio tags"],"values":["none","parent","field:taken","field:camera","field:iso","field:aperture","field:shutter","field:focal","field:lens","field:width","field:height","field:resolution","field:title","field:artist","field:album","field:track","field:year","field:genre","field:composer"]}） |
| ✅ 通过 | 命令列表首次打开为空态（提示先排规则链再保存）（empty=1） |
| ✅ 通过 | 保存命令：列表出现该命令，带规则数、冲突策略与运行次数（{"name":"logo 大写归档","runs":"0","policy":"skip","meta":"1 rules · Skip conflicting rows · run 0 times · Never run"}） |
| ✅ 通过 | 命令重载后仍在（写入本地存储，不是会话内存）（items=1） |
| ✅ 通过 | 运行命令 → 关闭命令列表并进入预览确认（不动文件）（{"dialog":false,"preview":true,"rows":1,"summary":"4 items · 0 conflicts · 0 invalid · every rename uses a temp file + atomic replace; the batch journal is persisted and undoable.","sub":"","selectedForRun":4}） |
| ✅ 通过 | 运行命令后预览列出该命令产生变化的行（{"rows":1,"selectedForRun":4,"summary":"4 items · 0 conflicts · 0 invalid · every rename uses a temp"}） |
| ✅ 通过 | 运行后该命令记一次运行（次数 1、带上次运行时间）（{"runs":"1","meta":"1 rules · Skip conflicting rows · run 1 times · 11/27, 03:53 AM"}） |
| ✅ 通过 | 删除命令 → 列表回到空态且本地存储同步清空（{"items":0,"empty":1,"stored":"[]"}） |
| ✅ 通过 | 列表「下移」立即改变顺序并出现手动顺序标记（{"namesBefore":["旧照片 001.jpg","logo.png","旧照片 002.jpg","旧照片 003.jpg"],"namesAfterDown":["logo.png","旧照片 001.jpg","旧照片 002.jpg","旧照片 003.jpg"],"manualChip":1}） |
| ✅ 通过 | 手动顺序在重载后仍然保留（localStorage 会话）（{"namesAfterDown":["logo.png","旧照片 001.jpg","旧照片 002.jpg","旧照片 003.jpg"],"namesReloaded":["logo.png","旧照片 001.jpg","旧照片 002.jpg","旧照片 003.jpg"]}） |
| ✅ 通过 | 拖拽手柄把第 1 行插入到第 3 行位置（非假排序）（{"namesReloaded":["logo.png","旧照片 001.jpg","旧照片 002.jpg","旧照片 003.jpg"],"namesDragged":["旧照片 001.jpg","旧照片 002.jpg","logo.png","旧照片 003.jpg"]}） |
| ✅ 通过 | 同一绝对路径重复添加被忽略（不产生第二条）（{"beforeDupCount":4,"afterDupCount":4,"samePathRows":1}） |
| ✅ 通过 | 文件已被外部修改（size 变化）时就地更新该条而非新增（{"sizeBeforeText":"2.3 MB","sizeAfterText":"3.3 MB","updatedCount":4}） |
| ✅ 通过 | 同名不同路径保留两条并在界面标出重名（{"sameNameCount":2,"dupBadges":2}） |
| ✅ 通过 | 内容相同的不同路径进入「疑似重复」分组，未静默删除（{"dupPanelBefore":1,"dupGroups":1}） |
| ✅ 通过 | 一键去重只移除列表中的一条，磁盘文件数不变（{"countBeforeDedupe":7,"countAfterDedupe":6,"filesOnDisk":7,"filesAfterDedupe":7}） |
| ✅ 通过 | JPEG 属性编辑：显示 IPTC-IIM 双写说明（{"shown":true,"text":"On JPEG these four IPTC Core fields go into both XMP and IPTC-IIM (APP13 8BIM): modern apps read XMP, older ones read IIM, and both stay in sync."}） |
| ✅ 通过 | 属性编辑：选中字段写入并回读校验通过（{"text":"旧照片 002.jpgJPEGOKRead-back verifiedmeta.restore写入：titleBackup：D:\\e2e\\旅行\\旧照片 002.jpg.1795722819430.bak","ok":true,"verified":true}） |
| ✅ 通过 | 属性编辑：重新打开可见写入后的值（{"rereadTitle":"E2E 新标题"}） |
| ✅ 通过 | 不支持的格式不显示 IPTC-IIM 说明（避免误导）（{"heicIptcNote":0}） |
| ✅ 通过 | 不支持格式（HEIC）明确拒绝并附文件与原因（{"unsupportedShown":1,"heicResult":{"bad":true,"text":"sample.heicHEICFailedHEIC 不支持写入：HEIC/HEIF 解码能力缺失，本版本不支持Backup：No backup"}}） |
| ✅ 通过 | 未检查：只显示「检查更新」「打开主页」（{"phase":"idle","check":1,"action":0,"save":0,"home":1,"retry":0,"latest":0,"install":0,"size":0,"error":0}） |
| ✅ 通过 | 检查失败：只给错误说明与重试（{"phase":"error","check":0,"action":0,"save":0,"home":0,"retry":1,"latest":0,"install":0,"size":0,"error":1}） |
| ✅ 通过 | 已是最新：显示「当前已是最新版本」且无更新/仅下载（{"phase":"latest","check":1,"action":0,"save":0,"home":1,"retry":0,"latest":1,"install":0,"size":0,"error":0}） |
| ✅ 通过 | 发现新版本：出现「更新」「仅下载」并展示大小（{"phase":"available","check":1,"action":1,"save":1,"home":1,"retry":0,"latest":0,"install":0,"size":1,"error":0}） |
| ✅ 通过 | 仅下载后出现「安装」（校验通过的包）（{"phase":"available","check":1,"action":1,"save":1,"home":1,"retry":0,"latest":0,"install":1,"size":1,"error":0}） |
| ✅ 通过 | 之后显示已最新时仍保留「安装」按钮（{"phase":"latest","check":1,"action":0,"save":0,"home":1,"retry":0,"latest":1,"install":1,"size":0,"error":0}） |
| ✅ 通过 | 设置页有「设置文件」分区，导出/导入两个按钮都在（{"export":true,"import":true,"exportDisabled":false,"importDisabled":false,"exportLabel":"Export .ini","importLabel":"Choose .ini","stacked":true,"rawKeys":false,"note":"Lines starting with ; or # are comments. A failed import leaves your current settings untouched."}） |
| ✅ 通过 | 设置文件：两项分行排布且标签非空（{"export":true,"import":true,"exportDisabled":false,"importDisabled":false,"exportLabel":"Export .ini","importLabel":"Choose .ini","stacked":true,"rawKeys":false,"note":"Lines starting with ; or # are comments. A failed import leaves your current settings untouched."}） |
| ✅ 通过 | 设置文件：文案已本地化（无原始 i18n key）且附说明（{"export":true,"import":true,"exportDisabled":false,"importDisabled":false,"exportLabel":"Export .ini","importLabel":"Choose .ini","stacked":true,"rawKeys":false,"note":"Lines starting with ; or # are comments. A failed import leaves your current settings untouched."}） |
| ✅ 通过 | 导出入口给出失败提示而非假成功（命令链未接通时不许声称已导出）（{"kind":"toast warn","text":"Export failed: mock 未实现命令：settings_to_ini"}） |
| ✅ 通过 | 导出失败后按钮恢复可用（不卡在忙状态）（true） |
| ✅ 通过 | 导入按钮可点击（文件选择由系统对话框承担）（true） |
| ✅ 通过 | 设置页有「数据自检与修复」分区，检查/修复两个按钮都在（{"check":true,"fix":true,"checkLabel":"Run check","fixLabel":"Run repair","stacked":true,"rawKeys":false,"notes":0,"results":0,"noteText":""}） |
| ✅ 通过 | 自检分区：两项分行排布且标签非空（{"check":true,"fix":true,"checkLabel":"Run check","fixLabel":"Run repair","stacked":true,"rawKeys":false,"notes":0,"results":0,"noteText":""}） |
| ✅ 通过 | 自检分区：文案已本地化（无原始 i18n key）（{"check":true,"fix":true,"checkLabel":"Run check","fixLabel":"Run repair","stacked":true,"rawKeys":false,"notes":0,"results":0,"noteText":""}） |
| ✅ 通过 | 自检分区：未点击时不平白显示结果块（{"check":true,"fix":true,"checkLabel":"Run check","fixLabel":"Run repair","stacked":true,"rawKeys":false,"notes":0,"results":0,"noteText":""}） |
| ✅ 通过 | 点「开始检查」要么给出真实报告，要么明确失败；不许两者都没有（{"toast":"toast warn \| Check failed: mock 未实现命令：data_dir_check","report":null,"rawKeys":false}） |
| ✅ 通过 | 自检结果里不出现原始 i18n key（{"toast":"toast warn \| Check failed: mock 未实现命令：data_dir_check","report":null,"rawKeys":false}） |
| ✅ 通过 | 自检结束后两个按钮都恢复可用（不卡在忙状态）（true） |
| ✅ 通过 | 快照：入口真实可用且哈希复选框默认关闭（false） |
| ✅ 通过 | 快照（仅映射）→ 记录 3 条原名/新名与大小/时间，不含哈希（{"entryCount":3,"hashed":0}） |
| ✅ 通过 | 快照列表显示「仅映射」（2026/11/27 03:53:463 条 · 仅映射预览还原删除） |
| ✅ 通过 | 快照：勾选后开启 SHA-256（true） |
| ✅ 通过 | 快照（含哈希）→ 3 条 SHA-256 且逐条上报进度（{"id":"mock-snap-2","hashed":3}） |
| ✅ 通过 | 快照生成 → 进度事件可取消/可观测（hash/done）（hash,done） |
| ✅ 通过 | 还原预览（未改名）→ 3 条均已在原名，不误报（将还原 0 条，跳过 3 条只改回原名；目标名已存在、文件已变化或路径非法都会跳过，绝不覆盖D:\e2e\旅行\照片_001.jpg→D:\e2e\旅行\旧照片 001.jpg文件已在原名D:\e2e\旅行\照片_002.jpg→D:\e2） |
| ✅ 通过 | 还原预览 → 3 条将还原 + 执行时校验哈希（将还原 3 条，跳过 0 条只改回原名；目标名已存在、文件已变化或路径非法都会跳过，绝不覆盖D:\e2e\旅行\照片_001.jpg→D:\e2e\旅行\旧照片 001.jpg将还原（执行时校验 SHA-256）D:\e2e\旅行\照片_0） |
| ✅ 通过 | 还原预览 → 原位置被占用时标记跳过（2 条将还原）（将还原 2 条，跳过 1 条只改回原名；目标名已存在、文件已变化或路径非法都会跳过，绝不覆盖D:\e2e\旅行\照片_001.jpg→D:\e2e\旅行\旧照片 001.jpg原位置已被占用D:\e2e\旅行\照片_002.jpg→D:\e2e\旅行\旧照片 002.jpg将还原） |
| ✅ 通过 | 还原执行 → 2 条还原、1 条跳过，批次 kind=restore 且 policy=skip（{"total":3,"done":2,"skipped":1,"failed":0}） |
| ✅ 通过 | 还原绝不覆盖：诱饵文件保持原样，冲突条目的新名文件仍在（{"decoyIntact":12345,"afterRestoreFiles":["照片_001.jpg","旧照片 002.jpg","旧照片 003.jpg","logo.png","旧照片 001.jpg"]}） |
| ✅ 通过 | 还原结果逐条说明跳过原因（还原结果：成功 2 条，跳过/失败 1 条批次 mock-batch-2还原已写入操作记录，可在「操作记录」里整批撤销D:\e2e\旅行\照片_002.jpg→D:\e2e\旅行\旧照片 002.jpg已还原D:\e2e\旅行\照片_003.jpg→D:\e2e\旅行\旧照片 003.jpg已还原D:\e2e\旅行\照） |
| ✅ 通过 | 操作记录把还原标为「快照还原」且可撤销（2026-11-27 03:53 · 快照还原D:\e2e\旅行 · 2/3 成功 · 1 跳过 · 0 失败部分完成 · 策略 skip · 撤销-batch-2撤销） |
| ✅ 通过 | 撤销还原 → 2 条回到新名（冲突条目不受影响）（["照片_001.jpg","照片_002.jpg","照片_003.jpg","logo.png","旧照片 001.jpg"]） |
| ✅ 通过 | 删除快照 → 列表与后端同步只剩 1 条（1） |
| ✅ 通过 | 勾选一张图片后 EXIF 入口在检查器里可用（作用于勾选文件）（1 / 作用于 1 个文件） |
| ✅ 通过 | EXIF 预览按文件列出实际存在项，并明确标注 Orientation / ICC / XMP 的处理方式（{"groups":["exif-group-0-gps","exif-group-0-camera","exif-group-0-time","exif-group-0-thumbnail"],"orientation":"Orientation=6 · 保留","icc":"ICC 保留","xmp":"XMP 保留","protect":"保护项：Orientation 方向标记保留（照片不会躺倒）；ICC 色彩配置保留（不偏色）。"}） |
| ✅ 通过 | 改变清除范围后预览失效，执行按钮回到禁用（必须先重新预览）（true） |
| ✅ 通过 | 勾选 GPS → 预览按文件列出将移除的具体项（GPSLatitude / GPSLongitude）（本次移除：GPS 定位（GPSLatitude=31.230400N、GPSLongitude=121.473700E）） |
| ✅ 通过 | EXIF 清除后回读：GPS 组消失，Orientation 与 ICC 保留，结果含像素比对与还原按钮（{"ok":true,"meta":"Orientation 6 → 6 · ICC 保留 · 像素 未改动","restore":true,"gpsGone":true,"groupsAfter":["camera","time","thumbnail"],"orientationAfter":6,"iccAfter":true}） |
| ✅ 通过 | EXIF 清除结果提供还原按钮，并走已有备份还原通路（meta_restore_backup）（true） |
| ✅ 通过 | 检查器「编码」在没有文本目标时显示空态并说明原因（{"empty":true,"scope":"作用于 1 个文件","clarified":true}） |
| ✅ 通过 | 勾选一个文本文件后编码检查器按勾选文件真实探测（1） |
| ✅ 通过 | 非 UTF-8/未确认编码 → 显式提示「需手动指定源编码」且源编码下拉给出 5 种可选（{"confirmed":"未确认","warning":"编码未识别，需手动指定源编码","sourceOptions":["自动检测","UTF-8","UTF-8 with BOM","GB18030","UTF-16 LE","UTF-16 BE"]}） |
| ✅ 通过 | 源编码未确认且保持「自动」时执行被阻止并提示手动指定（不静默按 UTF-8 写）（{"hasResult":false,"toast":"源编码未确认：请在下拉框手动指定源编码"}） |
| ✅ 通过 | 文本编码结果提供「还原」按钮并走已有备份还原通路（{"restoreCallsBeforeText":1,"restoreCallsAfterText":2}） |
| ✅ 通过 | 重启保持：明暗与配色分别持久化，重载后仍为 moss + dark 且首帧底色取自该色板（{"before":{"palette":"moss","theme":"dark"},"after":{"attr":"moss","theme":"dark","bg":"#0e140f"}}） |
| ✅ 通过 | 列头排序只改显示顺序：按名称升序显示，真实编号（entry 下标）不重编号（{"key":"name","dir":"1","sortedOk":true,"upsBeforeSort":["row-up-0","row-up-1","row-up-2","row-up-3"],"upsAfterSort":["row-up-1","row-up-2","row-up-3","row-up-0"]}） |
| ✅ 通过 | 「恢复手动顺序」退回真实列表顺序且不残留排序状态（{"afterReset":["logo.png","旧照片 001.jpg","旧照片 002.jpg","旧照片 003.jpg"],"namesBeforeSort":["logo.png","旧照片 001.jpg","旧照片 002.jpg","旧照片 003.jpg"],"resetSortKey":"none"}） |
| ✅ 通过 | Ctrl 点击单项切换、Shift 点击按锚点范围选择，状态栏给出「已选 N 项」（{"selOne":1,"selRange":3,"selCtrl":2,"statusText":"已选 2 项"}） |
| ✅ 通过 | 点击列表空白清除选择（0） |
| ✅ 通过 | 空白处按下拖动为框选：实时出现选框并命中拖过的行（{"marqueeShown":true,"selMarquee":2}） |
| ✅ 通过 | 右键点在已选中行上保留多选，菜单项只给列表语义（复制/剪切/粘贴/移出列表）（{"selBeforeMenu":2,"menuInfo":{"open":true,"ids":["open","reveal","rename","revert-name","copy","cut","paste","remove","details"],"selected":2}}） |
| ✅ 通过 | 右键菜单可键盘导航（↑↓ 高亮）并用 Esc 关闭（{"menuActive":true,"menuClosed":true}） |
| ✅ 通过 | 空白右键菜单给排序/显示方式；「紧凑」把行高从 44 降到 32（设计系统 row-h 阶梯）（{"blankMenu":{"open":true,"ids":["select-all","deselect","paste","sort","density","refresh"]},"compact":{"density":"compact","h":32}}） |
| ✅ 通过 | F2 就地重命名：Enter 提交后新名进入预览列并标出「已自定义」，真实文件名不变（{"badge":1,"newName":"交互重命名.txt","originalName":"logo.png"}） |
| ✅ 通过 | 菜单「恢复按规则命名」清掉自定义名（false） |
| ✅ 通过 | 排序状态下可拖动：拖拽中出现插入线与拖影、光标 grabbing，落下后自动清排序并提示（{"duringDrag":{"line":true,"ghost":true,"grabbing":true,"cursor":"grabbing"},"afterDrag":{"sort":"none","line":false,"toast":"已按落点插入，并恢复手动顺序","chip":false}}） |
| ✅ 通过 | Esc 取消拖动：不改变顺序且清掉插入线与拖拽态（{"beforeCancel":["旧照片 001.jpg","logo.png","旧照片 002.jpg","旧照片 003.jpg"],"afterCancel":["旧照片 001.jpg","logo.png","旧照片 002.jpg","旧照片 003.jpg"],"cancelClean":true}） |
| ✅ 通过 | 超过 200 行进入虚拟滚动后，End/Home 仍把焦点行滚进视口（不是停在已渲染窗口里）（{"bulk":{"total":304,"virtual":"1","rows":23},"afterEnd":{"total":304,"scrollTop":12745,"lastVisible":true,"focusedIdx":"303"},"afterHome":{"scrollTop":0,"firstVisible":true}}） |

## 真实文件层断言（临时文件 → 改名 → 校验 → 撤销）

> 由 `e2e/vars.mjs`、`e2e/rules-fs.mjs` 与 `e2e/policy.mjs` 在真实临时目录执行，使用真实的 TypeScript 规则引擎与 `fs` 真改真撤销；元数据取值来自真实 MP3 的 ID3 标签；策略用例同时对照 `src/runtime.ts` 的默认值。

| 结果 | 断言 |
| --- | --- |
| ✅ 通过 | 元变量真实文件验证（RESULT 93/93 passed, 0 failed） |
| ✅ 通过 | 八规则真实文件端到端（建文件→改名→校验→撤销）（RESULT 41/41 passed, 0 failed） |
| ✅ 通过 | 编号分组/排除/按路径取号 + 元变量表达式真实验证（RESULT 93/93 passed, 0 failed） |
| ✅ 通过 | 智能更名策略（默认值对照 + 真实文件截断/跳过）（RESULT policy passed=41 failed=0） |

## 配置层断言（capabilities / 静态配置）

| 结果 | 断言 |
| --- | --- |
| ✅ 通过 | capability 声明包含窗口关闭/最小化/最大化/拖拽权限（core:default, dialog:default, core:window:allow-close, core:window:allow-minimize, core:window:allow-toggle-maximize, core:window:allow-start-dragging） |

## UI 触发的 mock 后端断言

> 这些断言验证“点击路径确实调用了 Tauri 命令”，磁盘行为由内存 mock 模拟，**不是真实文件系统**。

| 结果 | 断言 |
| --- | --- |
| ✅ 通过 | 执行顺序 = 扫描顺序（列头排序不影响提交顺序）（D:\e2e\旅行\旧照片 001.jpg \| D:\e2e\旅行\旧照片 002.jpg \| D:\e2e\旅行\旧照片 003.jpg） |
| ✅ 通过 | 模拟外部移动目标文件 |
| ✅ 通过 | 外部移动目标文件 → 历史条目不可撤销并给出原因（{"undoable":"0","reason":"目标文件已不存在：D:\\e2e\\旅行\\旅行_001.jpg（可能被外部移动或删除）","chip":"不可撤销","hasUndoBtn":false}） |
| ✅ 通过 | 时间写入 → apply_time 实际平移 2 天（[172800000,172800000,172800000,172800000]） |
| ✅ 通过 | 时间修改可撤销 → mtime 回到原值（[1735689600000,1735776000000,1735862400000,1735952400000]） |
| ✅ 通过 | 属性写入 → 勾选文件全部只读（已只读项跳过） |
| ✅ 通过 | 属性撤销 → 仅原本只读的文件保持只读（readonly=1） |
| ✅ 通过 | 取反写入 → 3 个可写变只读、1 个只读变可写（readonly=3） |
| ✅ 通过 | 取反撤销 → 还原原只读属性（readonly=1） |
| ✅ 通过 | 移动 → 目标目录不存在时自动创建并记录 createdDirs（d:\e2e\归类结果\001 \| d:\e2e\归类结果\002 \| d:\e2e\归类结果\003） |
| ✅ 通过 | 移动后 → 3 个文件的路径更新到归类目录（d:\e2e\归类结果\001\旧照片 001.jpg \| d:\e2e\归类结果\002\旧照片 002.jpg \| d:\e2e\归类结果\003\旧照片 003.jpg \| D:\e2e\设计\logo.png） |
| ✅ 通过 | 归类移动可撤销 → 路径全部回到原位置（D:\e2e\旅行\旧照片 001.jpg \| D:\e2e\旅行\旧照片 002.jpg \| D:\e2e\旅行\旧照片 003.jpg \| D:\e2e\设计\logo.png） |
| ✅ 通过 | 三类批次均写入日志并可撤销（time / attrs / move）（move,attrs,attrs,time,,,,,） |
| ✅ 通过 | 模板移动后 → 4 个文件落入两级目录（d:\e2e\归类结果\jpg\2025\旧照片 001.jpg \| d:\e2e\归类结果\jpg\2025\旧照片 002.jpg \| d:\e2e\归类结果\jpg\2025\旧照片 003.jpg \| d:\e2e\归类结果\png\2025\logo.png） |
| ✅ 通过 | 模板归类可撤销 → 路径全部回到原位置（D:\e2e\旅行\旧照片 001.jpg \| D:\e2e\旅行\旧照片 002.jpg \| D:\e2e\旅行\旧照片 003.jpg \| D:\e2e\设计\logo.png） |
| ✅ 通过 | 拖放 drop → 调用扫描/添加路径命令，计数正确（+2）（paths=D:\e2e\新拖入\拖入 A.txt,D:\e2e\新拖入\拖入 B.txt, rows=11） |
| ✅ 通过 | 交互确实经过 Tauri 命令层（env/scan/apply/undo/时间/属性/移动/元数据/事件/写文件）（startup_report,load_rule_history,plugin:event\|listen,env_info,privilege_info,migration_info,plugin:event\|unlisten,append_log,plugin:dialog\|open,scan_paths,find_duplicates,paths_exist,apply_plan,list_batches,undo_batch,read_metadata,plugin:dialog\|save,write_text_atomic,read_text_file,write_bytes_atomic,read_attrs,read_times,apply_time,meta_read,meta_capabilities,list_snapshots,apply_attrs,apply_move） |
| ✅ 通过 | 右上角窗口按钮 → 实际调用 window API（minimize / toggle_maximize / close）（minimize,toggle_maximize,close） |
| ✅ 通过 | 手动导入经 Tauri 命令层并回报导入/跳过数量（已导入 2 个文件，跳过 1 个已存在的文件（导入前已备份）。） |
| ✅ 通过 | 启用 Analyze 后真的按需调用了 sniff_extensions（1） |
| ✅ 通过 | 文本编码原地覆盖：请求携带手动源编码 GB18030、目标 UTF-8 BOM，结果含回读校验与备份还原入口（{"ok":true,"verified":true,"stats":"128 → 128 字节 · D:\\e2e\\旅行\\编码样本.txt","restore":true,"call":{"path":"D:\\e2e\\旅行\\编码样本.txt","targetEncoding":"utf8bom","sourceEncoding":"gb18030","saveAs":null,"backup":true}}） |

## 层级别说明

- **UI 层已验证**：无头浏览器渲染真实构建产物，交互事件、DOM 状态、主题、列设置、九类列表页签、拖放高亮/计数、弹窗与截图均来自真实前端代码。
- **mock 后端**：`scan_paths / apply_plan / undo_batch / read_metadata / read_metadata_batch / read_times / read_attrs / apply_time / apply_attrs / apply_move / meta_read / meta_edit / meta_restore_backup / exif_inventory / exif_clear / text_detect / text_save / write_text_atomic / plugin:event|listen` 为内存实现，用于跑通交互路径；EXIF 与文本样本由测试显式注入（`window.__E2E__.exif` / `text`），mock 不凭空编造；真实磁盘行为另见 `src-tauri/renomio-core/tests/` 的 Rust 测试（含 `ops_fs.rs`）。
- **真机已验证（用户手工确认）**：真实窗口的右上角关闭、最小化、最大化在 Windows 真机上由用户在 2026-11-04 手工确认正常；这是人工确认，**不是本脚本的自动断言**。脚本仍只验证「点击后确实调用了 `plugin:window|*`」。
- **未验证（本脚本不覆盖）**：真实 Explorer 拖放（需用户从资源管理器实际拖入一次）、Tauri IPC 序列化、系统文件对话框、NSIS 安装器界面、macOS/Linux 平台差异。需要启动 GUI 或有头环境，按项目约定不在此处自动执行。

## 截图

- 00-empty-light.png
- 00-vars-panel.png
- 01-files-added.png
- 02-preview-conflict.png
- 03-preview-dialog.png
- 04-policy-suffix.png
- 04b-apply-progress.png
- 05-applied.png
- 06-undone.png
- 06b-history-panel.png
- 06c-history-after-undo.png
- 06d-history-multi-undo.png
- 06e-history-blocked.png
- 07-dark-theme.png
- 08-metadata-readonly.png
- 09-plan-export.png
- 10-plan-import.png
- 11-plan-incompatible.png
- 12-column-menu.png
- 13-columns-resized.png
- 14-min-1100x640-150dpi.png
- 14-ops-time-preview.png
- 15-min-tabs-1100x640-150dpi.png
- 15-ops-time-result.png
- 15b-inspector.png
- 15c-inspector-light.png
- 16-clear-list-empty.png
- 16-ops-move-preview.png
- 17-ops-move-result.png
- 17-permission-failures.png
- 18-uipi-notice.png
- 19-lang-en-US.png
- 19-lang-es-ES.png
- 19-lang-ja-JP.png
- 19-migration-notice-dismissed.png
- 20-legacy-import.png
- 21-regex-backslash-ref.png
- 21b-regex-nth-whole.png
- 22-commands-dialog.png
- 23-case-protect.png
- 24-toast-drawer.png
- 25-meta-fields.png
- 26-move-position.png
- 27-move-markers.png
- 27-snapshot-created.png
- 28-delete-modes.png
- 28-ext-analyze.png
- 28-snapshot-preview-before.png
- 29-snapshot-preview.png
- 29b-snapshot-restored.png
- 30-snapshot-undo.png

截图文件仅保存在本机 `app/e2e/screenshots/`（已忽略），仓库内不提供可点击链接；需要留存时请取 CI artifact 或本地文件。
