/**
 * 资源管理器集成（6.13）自测。
 *
 * 判据三条：**右键菜单只写 HKCU 的三条键、快捷方式必须由系统 COM 写出而不是手搓字节、
 * 非 Windows 平台要明确说不支持而不是假装成功**。
 * 四段：
 *  A. core：菜单计划（三条作用域 / 键位 / 命令占位符 / 坏路径拒绝）与注册表读写的真实现。
 *  B. 桌面端：`IShellLinkW` + `IPersistFile.Save` 的快捷方式实现、绝对路径前置校验、四条命令注册。
 *  C. 界面：桥接四个函数、类型、设置页五个 testid、五语种文案。
 *  D. 活体：`--require-probe` 时真跑 `cargo test --test integration_contract` 与 `cargo test --lib shortcut`。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const repoRoot = path.join(appRoot, '..');
const coreRoot = path.join(appRoot, 'src-tauri', 'renomio-core');
const requireProbe = process.argv.includes('--require-probe');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const read = (abs) => (existsSync(abs) ? readFileSync(abs, 'utf8') : '');

const coreSrc = read(path.join(coreRoot, 'src', 'integration.rs'));
const coreLib = read(path.join(coreRoot, 'src', 'lib.rs'));
const coreToml = read(path.join(coreRoot, 'Cargo.toml'));
const contract = read(path.join(coreRoot, 'tests', 'integration_contract.rs'));
const shortcut = read(path.join(appRoot, 'src-tauri', 'src', 'shortcut.rs'));
const tauriLib = read(path.join(appRoot, 'src-tauri', 'src', 'lib.rs'));
const bridge = read(path.join(appRoot, 'src', 'lib', 'bridge.ts'));
const types = read(path.join(appRoot, 'src', 'lib', 'types.ts'));
const drawer = read(path.join(appRoot, 'src', 'components', 'Drawer.tsx'));

console.log('A. core 菜单计划与注册表');
check('integration 模块已导出', /pub mod integration;/.test(coreLib));
check('三条作用域齐备', ['File', 'Directory', 'Background'].every((s) => coreSrc.includes(`MenuScope::${s}`)));
check(
  '三条键位都在 Software\\Classes 下',
  ['Software\\\\Classes\\\\*\\\\shell\\\\Renomio', 'Software\\\\Classes\\\\Directory\\\\shell\\\\Renomio',
    'Software\\\\Classes\\\\Directory\\\\Background\\\\shell\\\\Renomio'].every((k) => coreSrc.includes(k)),
);
check('文件/文件夹用 %1、背景用 %V', coreSrc.includes('"%1"') && coreSrc.includes('"%V"'));
check('命令一律给 exe 加引号', /format!\("\\"\{\}" /.test(coreSrc) || coreSrc.includes('\\"{}\\"'));
check('坏路径校验：绝对路径 + 无引号换行', /is_windows_absolute\(/ .test(coreSrc) && coreSrc.includes("'\\n'"));
check('Windows 侧走 winreg', coreSrc.includes('winreg') && coreToml.includes('winreg'));
check('非 Windows 明确返回不支持', coreSrc.includes('cfg!(windows)') && coreSrc.includes('仅 Windows'));
check('写注册表带 MUIVerb 与 Icon', coreSrc.includes('MUIVerb') && coreSrc.includes('Icon'));
check('卸载按整棵子树删除且 NotFound 视为成功', coreSrc.includes('delete_subkey_all') && coreSrc.includes('NotFound'));

console.log('\nB. 桌面端快捷方式与命令');
check('快捷方式用 COM IShellLinkW', shortcut.includes('IShellLinkW') && shortcut.includes('ShellLink'));
check('保存走 IPersistFile.Save', shortcut.includes('IPersistFile') && shortcut.includes('.Save('));
check('目标必须是绝对路径（拦掉 COM 的坏 lnk）', shortcut.includes('is_absolute()') && shortcut.includes('不能包含 NUL'));
check('非 Windows 返回不支持', shortcut.includes('当前平台不支持创建 Windows 快捷方式'));
check('Cargo 打开 Win32_System_Com', read(path.join(appRoot, 'src-tauri', 'Cargo.toml')).includes('Win32_System_Com'));
check('模块已挂', /mod shortcut;/.test(tauriLib));
for (const cmd of ['explorer_menu_state', 'explorer_menu_install', 'explorer_menu_uninstall', 'create_desktop_shortcut']) {
  const defined = new RegExp(`fn ${cmd}\\(`).test(tauriLib);
  const registered = new RegExp(`${cmd},`).test(tauriLib);
  check(`命令 ${cmd} 定义并注册`, defined && registered);
}
check('桌面目录取 app.path().desktop_dir()', tauriLib.includes('desktop_dir()'));

console.log('\nC. 界面接线');
for (const fn of ['getExplorerMenu', 'installExplorerMenu', 'uninstallExplorerMenu', 'createDesktopShortcut']) {
  check(`bridge 暴露 ${fn}`, new RegExp(`export async function ${fn}\\(`).test(bridge));
}
check('类型 ExplorerMenuStateDto', /export interface ExplorerMenuStateDto \{/.test(types));
check('类型字段 supported/installed/partial/entries', ['supported', 'installed', 'partial', 'entries'].every((f) => types.includes(`${f}:`)));
for (const id of ['integration-section', 'explorer-menu-status', 'explorer-menu-toggle', 'desktop-shortcut', 'integration-note']) {
  check(`设置页有 ${id}`, drawer.includes(`data-testid="${id}"`));
}
check('演示模式禁用（!isDesktop）', /disabled=\{!isDesktop \|\| menuBusy/.test(drawer));
const locales = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'es-ES'];
const needSettings = [
  'settings.integrationGroup', 'settings.explorerMenu', 'settings.explorerMenuHint',
  'settings.explorerUnknown', 'settings.explorerUnsupported', 'settings.explorerInstalled',
  'settings.explorerPartial', 'settings.explorerNotInstalled', 'settings.explorerInstall',
  'settings.explorerRemove', 'settings.explorerRefresh', 'settings.desktopShortcut',
  'settings.desktopShortcutHint', 'settings.desktopShortcutAction', 'settings.integrationNote',
  'settings.integrationDemo',
];
const needToast = ['toast.menuInstallOk', 'toast.menuRemoveOk', 'toast.menuFail', 'toast.shortcutOk', 'toast.shortcutFail'];
for (const loc of locales) {
  const text = read(path.join(appRoot, 'src', 'locales', `${loc}.ts`));
  const missing = [...needSettings, ...needToast].filter((k) => !text.includes(`'${k}'`));
  check(`${loc} 文案齐全（${needSettings.length + needToast.length} 键）`, missing.length === 0, missing.join(', '));
}

console.log('\nD. 契约测试与文档');
check('契约测试文件存在', contract.length > 0);
check('契约测试 7 条（3 作用域 + 键位 + 命令 + 坏路径 + 状态 + 非 Windows + 注册表回环）',
  (contract.match(/^#\[(cfg\(windows\)\)\s*)?#?\[?test\]/gm) || []).length + (contract.match(/^#\[test\]/gm) || []).length >= 7);
check('契约覆盖真写注册表回环', contract.includes('windows_registry_install_and_remove_round_trip'));
check('快捷方式三条测试（回读 / 相对路径拒绝 / 平台不支持）',
  shortcut.includes('shortcut_round_trips_through_com') && shortcut.includes('shortcut_rejects_relative_target')
  && shortcut.includes('unsupported_platform_is_explicit'));
check('package.json 有 test:integration', read(path.join(appRoot, 'package.json')).includes('"test:integration"'));
const gap = read(path.join(repoRoot, 'docs', 'FEATURE-GAP.md'));
check('FEATURE-GAP 6.13 行已更新', /6\.13/.test(gap) && gap.includes('资源管理器'));
check('FEATURE-GAP 提到 integration_contract', gap.includes('integration_contract'));

if (requireProbe) {
  console.log('\nE. 活体：cargo test');
  for (const args of [['test', '--test', 'integration_contract'], ['test', '--lib', 'shortcut']]) {
    const cwd = args.includes('--test') ? coreRoot : path.join(appRoot, 'src-tauri');
    const r = spawnSync('cargo', args, { cwd, encoding: 'utf8', shell: true });
    const out = `${r.stdout}\n${r.stderr}`;
    const ok = r.status === 0 && /test result: ok/.test(out);
    const passed = (out.match(/test result: ok\. (\d+) passed/) || [])[1];
    check(`cargo ${args.join(' ')} 通过（${passed ?? '?'} 条）`, ok, out.split('\n').slice(-4).join(' | '));
  }
}

console.log(`\n${pass} 项通过，${fail} 项失败`);
if (fail > 0) process.exit(1);
