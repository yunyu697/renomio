# Renomio

Proprietary — all rights reserved, not open source

跨平台（Windows / macOS / Linux）批量文件 / 文件夹更名工具，重构自《菲菲更名宝贝》（Rename Studio 的新版本，非原地升级）。当前发布版聚焦「可预览、可撤销、不丢文件」的安全更名流程。

- 前端：React 19 + TypeScript + Vite 7
- 桌面壳：Tauri 2（Rust）
- 核心：`app/src-tauri/ffrn-core`（无 Tauri 依赖，可单独 `cargo test`）
- 基础层：`app/packages/foundation`

## 主要能力

| 能力 | 说明 |
| --- | --- |
| 规则链 + 实时预览 | 添加 / 替换 / 删除 / 自动编号 / 移动字符 / 大小写 / 扩展名，可拖拽排序、逐条启停；原名与新名差异分段显示 |
| 冲突检测与策略 | 批次内重名与磁盘已存在；跳过 / 自动后缀 `name (1).ext` / 覆盖（先备份目标） |
| 两阶段执行 + 撤销 | 先写临时名再落目标，支持交换与环形改名；批次日志持久化，**重启后仍可撤销** |
| 撤销历史面板 | 每批时间、类型、成功/跳过/失败、是否可撤销及原因，支持逐批与「撤销到此」多级回退 |
| P1 扩展 | 只读元数据（图片 EXIF / ID3 / PDF / DOCX）、方案导入导出、CSV 导出、列显隐与列宽 |
| 时间 / 属性 / 归类移动 | 批量平移或固定时间、只读与隐藏属性、按扩展名 / 日期 / 首字母 / 正则捕获组移动到子目录 |
| 五语言界面 | 简体中文、繁体中文、English、日本語、Español |

详细能力表、验证分层与未验证清单见 [app/README.md](app/README.md)。

## 下载与安装

发布包见本仓库的 Releases 页（`v0.1.0`）：

| 包 | 文件 | 大小 | SHA-256 |
| --- | --- | --- | --- |
| NSIS（推荐，可选安装范围） | `Renomio_0.1.0_x64-setup.exe` | 1,469,033 字节 | `648C0A421196894B8E3768847D2AE2C79A055B52C707A7426DC81695A5B6D8CB` |
| MSI（机器级单一包） | `Renomio_0.1.0_x64_en-US.msi` | 2,101,248 字节 | `37545D29D35210262635E56E4101A522733F16B8E04FA503DC35E9D4AB2793CD` |

校验方式（PowerShell）：

```powershell
Get-FileHash .\Renomio_0.1.0_x64-setup.exe -Algorithm SHA256
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
- 真实 Explorer 拖放、提权后的拖放（UIPI 会拦截）、真实物理跨盘移动、EXIF 拍摄时间写入（未实现，时间面板只改文件系统时间）均未完成或未验证。
- 繁中 / 日 / 西三套译文本工具产出，**未经母语审校**。

## 仓库结构

```
app/                  Tauri 2 + React 应用源码
  src/                前端（React + TypeScript）
  src-tauri/          Rust 桌面壳、打包配置、NSIS 安装钩子
  src-tauri/ffrn-core/ 更名核心（可独立测试）
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

## 许可

Proprietary — all rights reserved, not open source。本仓库未附开源许可证，未经授权不得复制、分发、修改或商用。第三方依赖仍遵循其各自的许可证。
