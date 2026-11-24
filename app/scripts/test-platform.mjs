/**
 * 跨平台能力契约守卫（FEATURE-GAP 6.11）。
 *
 * 三段：
 *  A. 探针：真跑 `cargo run --example platform_probe`，把平台报告当 JSON 读回来，
 *     逐字段与「本进程所在 OS 的期望表」比对——不是读代码猜，是真的跑当前 OS 的二进制。
 *  B. 矩阵：CI 必须真的在 windows / macos / ubuntu 三个 OS 上跑 core 测试与本脚本，
 *     否则「跨平台已验证」这句话没有证据。
 *  C. 文档：FEATURE-GAP 6.11 标 A、README 的平台差异表仍在，且平台报告是唯一事实来源。
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

// ---------------- A. 探针 ----------------
const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const expect = {
  windows: {
    os: 'windows',
    separator: '\\',
    case_sensitive_default: false,
    long_path_prefix: true,
    path_warn_threshold: 240,
    path_hard_limit: 32767,
    btime: 'readwrite',
    btime_skip_reason: null,
    readonly_attr: 'read-write',
    windows_only_attrs: true,
    windows_only_attrs_reason: null,
  },
  macos: {
    os: 'macos',
    separator: '/',
    case_sensitive_default: false,
    long_path_prefix: false,
    path_warn_threshold: 900,
    path_hard_limit: 1024,
    btime: 'unsupported',
    btime_skip_reason: '创建时间（btime）在 macOS 上尚未实现写回，撤销时已跳过该字段',
    readonly_attr: 'readonly-only',
    windows_only_attrs: false,
    windows_only_attrs_reason: '当前平台不支持隐藏/系统/存档属性（仅 Windows）',
  },
  linux: {
    os: 'linux',
    separator: '/',
    case_sensitive_default: true,
    long_path_prefix: false,
    path_warn_threshold: 3800,
    path_hard_limit: 4096,
    btime: 'readonly',
    btime_skip_reason: '创建时间（btime）在 Linux 上不支持写回，撤销时已跳过该字段',
    readonly_attr: 'readonly-only',
    windows_only_attrs: false,
    windows_only_attrs_reason: '当前平台不支持隐藏/系统/存档属性（仅 Windows）',
  },
}[osName];

const cargoOk = spawnSync('cargo', ['--version'], { encoding: 'utf8' }).status === 0;
if (!cargoOk) {
  check('探针需要 cargo（缺依赖时不能算通过）', !requireProbe);
} else {
  const run = spawnSync(
    'cargo',
    ['run', '-q', '--manifest-path', path.join(coreRoot, 'Cargo.toml'), '--example', 'platform_probe'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  let report = null;
  try {
    const text = (run.stdout ?? '').trim();
    report = JSON.parse(text.slice(text.indexOf('{')));
  } catch {
    report = null;
  }
  check(`探针在 ${osName} 上跑出可解析的 JSON`, !!report, (run.stderr ?? '').slice(0, 200));
  if (report) {
    for (const [key, want] of Object.entries(expect)) {
      const got = report[key];
      check(
        `探针 ${key} = ${JSON.stringify(want)}（实际 ${JSON.stringify(got)}）`,
        JSON.stringify(got) === JSON.stringify(want),
      );
    }
    check('探针 component_limit = 255（三平台统一）', report.component_limit === 255, String(report.component_limit));
    check(
      '警告阈值 < 硬上限（不会出现“先硬拦再警告”的倒挂）',
      report.path_warn_threshold < report.path_hard_limit,
    );
    check('summary 写明本平台的关键差异', typeof report.summary === 'string' && report.summary.includes(osName === 'windows' ? 'Windows' : osName === 'macos' ? 'macOS' : 'Linux'));
  }
}

// ---------------- B. CI 三平台矩阵 ----------------
const workflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
const block = workflow.slice(workflow.indexOf('cross-os:'));
check('CI 里有 cross-os 矩阵 job', workflow.includes('cross-os:'));
check('矩阵覆盖 ubuntu / windows / macos 三个真实 OS',
  ['ubuntu-latest', 'windows-latest', 'macos-latest'].every((os) => block.includes(os)),
  block.slice(0, 200).replace(/\n/g, ' '));
check('矩阵里跑 renomio-core 的 cargo test', /cargo test[^\n]*renomio-core/.test(block));
check('矩阵里跑平台契约测试（platform_contract）', /platform_contract/.test(block) || /cargo test[^\n]*-p renomio-core/.test(block));
check('矩阵里跑本脚本（--require-probe）', /test-platform\.mjs --require-probe/.test(block));

const pkg = JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
check('package.json 有 test:platform 脚本', !!pkg.scripts['test:platform'], JSON.stringify(Object.keys(pkg.scripts)?.[0]));

// ---------------- C. 文档与代码同源 ----------------
const platformSrc = readFileSync(path.join(coreRoot, 'src', 'platform.rs'), 'utf8');
const gapDoc = readFileSync(path.join(repoRoot, 'docs', 'FEATURE-GAP.md'), 'utf8');
const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const gapRow = gapDoc.split('\n').find((line) => line.startsWith('| 6.11 ')) ?? '';
check('FEATURE-GAP 6.11 已标为 A（有实测）', /\| A \|/.test(gapRow), gapRow.slice(0, 80));
check('6.11 的证据里写了三平台实跑', gapRow.includes('windows-latest') || gapRow.includes('三平台'), gapRow.slice(0, 120));
check('platform.rs 里 PlatformReport 是差异的单一事实来源', platformSrc.includes('pub struct PlatformReport'));
check('PlatformReport 覆盖 btime / 属性 / 路径三类差异',
  platformSrc.includes('pub btime: BtimeSupport')
  && platformSrc.includes('pub windows_only_attrs: bool')
  && platformSrc.includes('pub path_hard_limit: usize'));
check('非 Windows 的属性不支持原因在代码里写死（与探针/界面同源）',
  platformSrc.includes('当前平台不支持隐藏/系统/存档属性（仅 Windows）'));
check('README 平台差异表仍在（btime / 属性 / 图标三行）',
  readme.includes('创建时间（btime）写回') && readme.includes('隐藏 / 系统 / 存档属性'), '');

const probeExists = existsSync(path.join(coreRoot, 'examples', 'platform_probe.rs'));
check('探针文件 examples/platform_probe.rs 在仓库里', probeExists);

console.log(`\n跨平台能力契约：${pass} 通过 / ${fail} 失败（宿主 ${osName}）`);
process.exit(fail === 0 ? 0 : 1);
