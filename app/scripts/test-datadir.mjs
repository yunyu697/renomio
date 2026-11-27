/**
 * 数据目录契约守卫（FEATURE-GAP 6.12「便携模式」）。
 *
 * 三段：
 *  A. 探针：真跑 `cargo run --example datadir_probe`，用真实临时目录跑 5 个场景（无标记 / 有标记 /
 *     标记但 data 被同名文件占住 / --cli / --env），把 JSON 读回来逐字段比对。
 *  B. 接线：core 的 DataRoot 字段、tauri 启动处真的用了 resolve() 与 parse_cli_args()、
 *     便携时跳过自动迁移、界面读到来源字段、五语种文案齐全、e2e 有断言。
 *  C. 文档：FEATURE-GAP 6.12 标 A、6.13 已由 alpha36 补齐标 A，README 有便携模式章节，脚本进了 package.json。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// ---------------- A. 探针 ----------------
const work = mkdtempSync(path.join(tmpdir(), 'renomio-datadir-probe-'));
const exeDir = path.join(work, 'app');
const osDefault = path.join(work, 'os-default');
mkdirSync(exeDir, { recursive: true });

const runProbe = (args) => {
  const run = spawnSync(
    'cargo',
    ['run', '-q', '--manifest-path', path.join(coreRoot, 'Cargo.toml'), '--example', 'datadir_probe', '--', ...args],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const text = (run.stdout ?? '').trim();
  try {
    return JSON.parse(text.slice(text.indexOf('{')));
  } catch {
    return { error: (run.stderr ?? '').slice(0, 300) || text.slice(0, 300) };
  }
};

const cargoOk = spawnSync('cargo', ['--version'], { encoding: 'utf8' }).status === 0;
if (!cargoOk) {
  check('探针需要 cargo（缺依赖时不能算通过）', !requireProbe);
} else {
  // 场景 1：无标记 → 每用户目录
  let payload = runProbe(['--exe', exeDir, '--os-default', osDefault]);
  let root = payload?.root ?? {};
  check('无便携标记 → 来源 os-default', root.source === 'os-default', JSON.stringify(root));
  check('无便携标记 → 路径就是每用户目录', root.path === osDefault, String(root.path));
  check('无便携标记 → portable=false 且没有回落原因', root.portable === false && root.note === null, JSON.stringify(root));
  check('说明文案写明「每用户默认位置」', String(payload?.description ?? '').includes('每用户默认位置'), String(payload?.description));

  // 场景 2：有标记 → 便携模式
  writeFileSync(path.join(exeDir, 'renomio.portable'), 'portable');
  payload = runProbe(['--exe', exeDir, '--os-default', osDefault]);
  root = payload?.root ?? {};
  check('有便携标记 → 来源 portable-marker', root.source === 'portable-marker', JSON.stringify(root));
  check('有便携标记 → 数据落在 <程序目录>/data', root.path === path.join(exeDir, 'data'), String(root.path));
  check('有便携标记 → portable=true 且无原因', root.portable === true && root.note === null, JSON.stringify(root));
  check('数据目录真的被创建出来', existsSync(path.join(exeDir, 'data')), String(root.path));
  check('说明文案写明「便携模式」', String(payload?.description ?? '').includes('便携模式'), String(payload?.description));

  // 场景 3：命令行走 --cli → 最高优先级
  payload = runProbe(['--exe', exeDir, '--os-default', osDefault, '--cli', path.join(work, 'cli-data')]);
  root = payload?.root ?? {};
  check('--cli 压过便携标记 → 来源 cli-arg', root.source === 'cli-arg', JSON.stringify(root));
  check('--cli 的路径原样采用', root.path === path.join(work, 'cli-data'), String(root.path));

  // 场景 4：--env 压过标记：把标记先验证在 --env 之下
  payload = runProbe(['--exe', exeDir, '--os-default', osDefault, '--env', path.join(work, 'env-data')]);
  root = payload?.root ?? {};
  check('环境变量压过便携标记 → 来源 env-var', root.source === 'env-var', JSON.stringify(root));
  check('环境变量路径原样采用', root.path === path.join(work, 'env-data'), String(root.path));

  // 场景 5：标记存在但 data 被同名文件占住 → 回落 + 原因
  const brokenDir = path.join(work, 'broken');
  mkdirSync(brokenDir, { recursive: true });
  writeFileSync(path.join(brokenDir, 'renomio.portable'), 'portable');
  writeFileSync(path.join(brokenDir, 'data'), 'not a folder');
  payload = runProbe(['--exe', brokenDir, '--os-default', osDefault]);
  root = payload?.root ?? {};
  check('便携目录不可用 → 回落到 os-default', root.source === 'os-default', JSON.stringify(root));
  check('回落时 portable=false', root.portable === false, JSON.stringify(root));
  check('回落原因点名 renomio.portable', String(root.note ?? '').includes('renomio.portable'), String(root.note));
  check('回落原因写「已回落到每用户目录」', String(root.note ?? '').includes('已回落到每用户目录'), String(root.note));

  // 场景 6：命令行解析（空格 / 等号 / 空值 / 缺值）
  let parsed = runProbe(['--parse', '--data-dir', 'D:\\usb']).parsed;
  check('命令行 --data-dir <值> 解析成功', parsed === 'D:\\usb', String(parsed));
  parsed = runProbe(['--parse', '--data-dir=E:/usb']).parsed;
  check('命令行 --data-dir=<值> 解析成功', parsed === 'E:/usb', String(parsed));
  parsed = runProbe(['--parse', '--data-dir=']).parsed;
  check('空值不算覆盖', parsed === null, String(parsed));
  parsed = runProbe(['--parse', '--data-dir']).parsed;
  check('缺值不算覆盖', parsed === null, String(parsed));
}

rmSync(work, { recursive: true, force: true });

// ---------------- B. 接线 ----------------
const coreSrc = readFileSync(path.join(coreRoot, 'src', 'datadir.rs'), 'utf8');
const coreLib = readFileSync(path.join(coreRoot, 'src', 'lib.rs'), 'utf8');
const tauriLib = readFileSync(path.join(appRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
const migrateSrc = readFileSync(path.join(appRoot, 'src-tauri', 'src', 'migrate.rs'), 'utf8');
const types = readFileSync(path.join(appRoot, 'src', 'lib', 'types.ts'), 'utf8');
const drawer = readFileSync(path.join(appRoot, 'src', 'components', 'Drawer.tsx'), 'utf8');
const e2e = readFileSync(path.join(appRoot, 'e2e', 'run.mjs'), 'utf8');

check('core 里有 datadir 模块并解析四级优先级', coreSrc.includes('pub fn resolve(') && coreSrc.includes('RootSource::CliArg') && coreSrc.includes('RootSource::PortableMarker'));
check('便携标记与子目录名集中定义', coreSrc.includes('pub const PORTABLE_MARKER: &str = "renomio.portable"') && coreSrc.includes('pub const PORTABLE_SUBDIR: &str = "data"'));
check('core 的 EnvInfo 暴露来源/便携/原因三个字段', coreLib.includes('data_root_source') && coreLib.includes('pub portable: bool') && coreLib.includes('data_root_note'));
check('Tauri 启动时真的解析数据目录（parse_cli_args + resolve）', tauriLib.includes('datadir::parse_cli_args') && tauriLib.includes('datadir::resolve('), '启动路径未接线');
check('数据目录被改写时跳过自动迁移并给出 skipped-override', tauriLib.includes('info_skipped') && migrateSrc.includes('"skipped-override"'));
check('Core 用解析结果构造（Core::new_at）', tauriLib.includes('Core::new_at(root.clone())'));
check('启动日志记录 data_root 来源，便于事后排查', tauriLib.includes('"data_root"'));
check('前端 EnvInfo 有 dataRootSource / portable / dataRootNote',
  types.includes('dataRootSource:') && types.includes('portable: boolean') && types.includes('dataRootNote: string | null'));
check('设置页展示「数据目录来源」并标注便携模式', drawer.includes("t('settings.dataRootSource')") && drawer.includes('data-testid="portable-note"'));
check('浏览器演示环境的 EnvInfo 补齐了新字段', readFileSync(path.join(appRoot, 'src', 'lib', 'bridge.ts'), 'utf8').includes('dataRootSource: \'os-default\''));

for (const lang of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'es-ES']) {
  const locale = readFileSync(path.join(appRoot, 'src', 'locales', `${lang}.ts`), 'utf8');
  const keys = ['settings.dataRootSource', 'settings.sourcePortable', 'settings.sourceCli', 'settings.sourceEnv', 'settings.sourceDefault', 'settings.portableNote'];
  check(`${lang} 的 6 条数据目录文案齐全`, keys.every((k) => locale.includes(`'${k}'`)));
}

check('e2e 断言数据目录来源与便携说明', e2e.includes('data-root-source') && e2e.includes('portable-note'));

const pkg = JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
check('package.json 有 test:datadir 脚本', !!pkg.scripts['test:datadir'], '');

const workflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
check('CI 里跑本脚本（--require-probe）', /test-datadir\.mjs --require-probe/.test(workflow));

// ---------------- C. 文档同源 ----------------
const gapDoc = readFileSync(path.join(repoRoot, 'docs', 'FEATURE-GAP.md'), 'utf8');
const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const row612 = gapDoc.split('\n').find((line) => line.startsWith('| 6.12 ')) ?? '';
const row613 = gapDoc.split('\n').find((line) => line.startsWith('| 6.13 ')) ?? '';
check('FEATURE-GAP 6.12（便携模式）已标 A', /\| A \|/.test(row612), row612.slice(0, 120));
check('6.12 的证据写清四级优先级与回落原因', row612.includes('renomio.portable') && row612.includes('回落到每用户目录'), row612.slice(0, 160));
check('6.13（右键菜单 / 快捷方式）已标 A 且证据写清三条键位', row613.includes('| A |') && row613.includes('右键菜单') && row613.includes('shell\\Renomio'), row613.slice(0, 120));
check('README 有便携模式章节（标记文件 + 优先级 + 回落说明）',
  readme.includes('renomio.portable') && readme.includes('RENOMIO_DATA_DIR') && readme.includes('--data-dir'), '');
check('探针 examples/datadir_probe.rs 在仓库里', existsSync(path.join(coreRoot, 'examples', 'datadir_probe.rs')));

console.log(`\n数据目录契约：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
