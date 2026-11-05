# @rename/foundation

Renomio（原 Rename Studio）与后续「格式工厂」共用的基础层。目标是把**每个桌面工具都会重复写一遍**的横切能力集中在这里，业务工程只写文件/规则相关的逻辑。

## 对外接口

| 模块 | 导出 | 说明 |
| --- | --- | --- |
| 设计令牌 | `tokens.css`、`color`、`space`、`fontSize`、`radius` | 颜色/字阶/间距/圆角/阴影的唯一来源。CSS 通过 `import '@rename/foundation/tokens.css'` 引入；JS 常量用于图表、导出等运行时场景。 |
| i18n | `createI18n`、`I18n`、`commonZh` | 无框架依赖；`t('key', { count })` 支持 `{name}` 插值；业务用 `resources` 注册自己的词条。 |
| 设置存储 | `createSettings`、`SettingsStore` | 版本化 schema、迁移函数、JSON 损坏自愈（原值备份到 `*.corrupt`）、订阅通知。默认 localStorage，也可注入 StorageLike。 |
| 任务队列 | `TaskQueue` | 串行执行重任务（扫描/改名/撤销），提供进度、取消、历史快照。避免并发文件系统操作互相踩踏。 |
| 日志/崩溃 | `createLogger`、`Logger` | 环形缓冲 + 可选 localStorage 持久化 + sink 落盘/上报；`installCrashHandlers()` 捕获全局错误与 Promise 拒绝。默认**不上传**。 |
| 自动更新 | `createUpdater`、`Updater`、`UpdateBackend` | 只提供状态机与接口；Tauri updater / Electron autoUpdater / 自建 HTTP 由业务注入。未配置时状态为 `unsupported`，UI 不得显示"已是最新"。 |

## 使用示例

```ts
import { createI18n, createSettings, createLogger, TaskQueue } from '@rename/foundation';
import '@rename/foundation/tokens.css';

const i18n = createI18n({ resources: { 'zh-CN': { 'app.title': 'Renomio' } } });
const settings = createSettings({
  key: 'rename-studio.settings',
  version: 2,
  defaults: { theme: 'light', strictWindowsNames: true },
  migrate: (from, data) => (from < 2 ? { ...(data as object), strictWindowsNames: true } : null),
});
const logger = createLogger({ persistKey: 'rename-studio.logs' });
logger.installCrashHandlers();

const queue = new TaskQueue();
await queue.enqueue('扫描文件', async (ctx) => {
  ctx.setProgress(0.5, '读取目录…');
});
```

## 设计约束

1. **零框架依赖**：不 import React / Tauri / Node，保证 CLI、Web、桌面端都能用。
2. **不静默上报**：日志默认只在本地；更新默认关闭。
3. **可测试**：所有模块为纯 TS，无全局副作用（除 `installCrashHandlers` 显式调用）。
4. **单一来源**：设计令牌只在此定义，业务 CSS 不得重复声明同名变量。

## 在其它工程复用（如格式工厂）

1. 把 `packages/foundation` 发布为私有 npm 包，或在 monorepo 中以 workspace 引用。
2. `import '@rename/foundation/tokens.css'` 获得同一套视觉语言。
3. 用 `createSettings` 建自己的设置命名空间；用 `TaskQueue` 包住转换任务；用 `Logger` 统一崩溃采集。
4. 更新后端：实现 `UpdateBackend`（例如 Tauri 的 `@tauri-apps/plugin-updater`），在启动时 `updater.setBackend(...)`。

## 当前边界

- 自动更新仅提供接口与状态机，未内置签名校验与下载实现（见 `docs/签名与打包流程.md`）。
- 日志落盘由宿主注入 sink；桌面端可在 Rust 侧订阅后写入 app data 目录（当前版本仅 localStorage + 内存）。
- i18n 只带中英公共词条，业务词条由使用方注册。
