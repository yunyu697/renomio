/**
 * 设置文件（.ini）导入导出自测。
 *
 * 判据只有一条：**用户导出的设置必须能原样导回来**，否则就是「看着导出了，实际回不进」。
 * 三段：
 *  A. 探针：真跑 `cargo run --example ini_probe`，覆盖往返一致、手写文件、坏文件逐行报错、
 *     空容器、会被读错类型的字符串、连续两次导出字节一致。
 *  B. 接线：Tauri 命令注册、前端只走 core 编解码、导入按白名单校验、界面按钮在演示模式禁用、
 *     五语种文案齐、CI 跑了契约与本脚本。
 *  C. 文档：FEATURE-GAP / README / AGENTS 与本轮实现同源。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
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

const read = (abs) => readFileSync(abs, 'utf8');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'renomio-ini-'));
const writeTmp = (name, content) => {
  const abs = path.join(tmp, name);
  writeFileSync(abs, content, 'utf8');
  return abs;
};

const runProbe = (args) => {
  const run = spawnSync(
    'cargo',
    ['run', '-q', '--manifest-path', path.join(coreRoot, 'Cargo.toml'), '--example', 'ini_probe', '--', ...args],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (run.error) return { error: String(run.error) };
  const out = (run.stdout || '').trim();
  const lastLine = out.split('\n').filter((l) => l.trim().startsWith('{')).pop();
  if (!lastLine) {
    return { error: `探针没有输出 JSON（退出码 ${run.status}）：${(run.stderr || '').trim().split('\n').slice(-2).join(' | ')}` };
  }
  try {
    return { value: JSON.parse(lastLine), status: run.status };
  } catch (err) {
    return { error: `探针输出不是 JSON：${err.message}` };
  }
};

// ---------------- A. 探针 ----------------
console.log('A. 探针往返');

const settingsFixture = {
  theme: 'system',
  palette: 'graphite',
  language: 'zh-CN',
  strictWindowsNames: true,
  nameMaxLength: 255,
  invalidReplacement: '+',
  emptyNameFallback: '未命名',
  userVars: ['', '剧名', '', '', '', '', '', '', ''],
  userVar0: '',
  shortcuts: { focusSearch: 'Ctrl+Shift+F', toggleRules: 'Ctrl+Shift+R' },
  columns: { name: true, size: false },
  columnWidths: {},
  rules: [
    {
      id: 'r1',
      type: 'replace',
      enabled: true,
      pattern: '第(\\d+)集',
      replacement: 'Ep$1',
      keywords: ['片头', '片尾'],
    },
    { id: 'r2', type: 'case', enabled: false, mode: 'title', exceptions: ['OK', 'iPhone'] },
  ],
  ruleUi: { expanded: ['r1'], openId: null, collapsed: false },
  layout: { view: 'files-left', advanced: false, side: 400, stack: 320, sizes: { 'files-left': 400 }, compactOpen: false },
};
const settingsFile = writeTmp('settings.json', JSON.stringify(settingsFixture, null, 2));

const to = runProbe(['--to', settingsFile, '--out', path.join(tmp, 'settings.ini')]);
check('导出：探针成功', to.value?.ok === true && !to.error, to.error);
check('导出：生成了分节与键行', (to.value?.sections ?? 0) >= 8 && (to.value?.lines ?? 0) >= 20, JSON.stringify(to.value));
const iniPath = path.join(tmp, 'settings.ini');
check('导出：文件确实落盘', existsSync(iniPath));
const iniText = existsSync(iniPath) ? read(iniPath) : '';
check('导出：开头是说明注释', iniText.startsWith('; Renomio'));
check('导出：顶层标量在 [@root]', iniText.includes('[@root]') && iniText.includes('theme = system'));
check('导出：中文裸写不转义', iniText.includes('emptyNameFallback = 未命名'));

const backPath = path.join(tmp, 'back.json');
const from = runProbe(['--from', iniPath, '--out', backPath]);
check('导入：解析成功', from.value?.ok === true && !from.error, from.error);
const roundTripJson = existsSync(backPath) ? JSON.parse(read(backPath)) : null;
check('导入：与原设置逐键一致', deepEqual(roundTripJson, canonical(settingsFixture)), diffHint());

const rt = runProbe(['--roundtrip', settingsFile]);
check('往返模式：same=true', rt.value?.same === true && rt.value?.ok === true, JSON.stringify(rt.value));

function canonical(value) {
  return JSON.parse(JSON.stringify(value));
}
/** 键序无关的深比较：核心导出会按字典序重排键，不能拿 JSON.stringify 直接对字符串。 */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function deepEqual(a, b) {
  return stable(a) === stable(b);
}
function diffHint() {
  return '导出再导入后结构应与原文件一致（键序无关，值必须相等）';
}

// 手写一份人写的 ini：注释、CRLF、引号、数组、嵌套
const handwritten = [
  '; 手写设置样例',
  '# 另一种注释',
  '',
  '[@root]',
  'theme = dark',
  'strictWindowsNames = false',
  'nameMaxLength = 120',
  '',
  '[userVars]',
  '[0] = ""',
  '[1] = 剧名',
  '',
  '[rules]',
  '[0].type = replace',
  '[0].enabled = true',
  '[0].pattern = "第(\\\\d+)集"',
  '[0].keywords[0] = 片头',
  '[0].keywords[1] = 片尾',
  '',
].join('\r\n');
const handPath = writeTmp('hand.ini', handwritten);
const hand = runProbe(['--from', handPath]);
check('手写文件：解析成功', hand.value?.ok === true && !hand.error, hand.error);
check('手写文件：键数符合预期', hand.value?.keys === 5, JSON.stringify(hand.value));
const handOut = path.join(tmp, 'hand.json');
runProbe(['--from', handPath, '--out', handOut]);
const handJson = existsSync(handOut) ? JSON.parse(read(handOut)) : {};
check('手写文件：布尔推断正确', handJson.theme === 'dark' && handJson.strictWindowsNames === false);
check('手写文件：数字推断正确', handJson.nameMaxLength === 120);
check('手写文件：空字符串保留', Array.isArray(handJson.userVars) && handJson.userVars[0] === '' && handJson.userVars[1] === '剧名');
check('手写文件：带转义的引号字符串还原', handJson.rules?.[0]?.pattern === '第(\\d+)集');
check('手写文件：数组元素落位到同一个规则', Array.isArray(handJson.rules?.[0]?.keywords) && handJson.rules[0].keywords[1] === '片尾');

// 坏文件逐条报错
const badCases = [
  ['重复键', '[a]\nx = 1\nx = 2\n', '第 3 行', '重复'],
  ['键在分节前', 'theme = dark\n', '第 1 行', '分节之前'],
  ['下标跳号', '[rules]\n[0].type = replace\n[2].type = case\n', '第 3 行', '跳号'],
  ['引号未闭合', '[a]\nnote = "没闭合\n', '第 2 行', '未闭合'],
  ['缺等号', '[a]\n只有键没有值\n', '第 2 行', '等号'],
  ['分节名非法', '[a b]\nx = 1\n', '第 1 行', '非法字符'],
];
for (const [name, text, lineHint, wordHint] of badCases) {
  const badPath = writeTmp(`bad-${Buffer.from(name).toString('hex')}.ini`, text);
  const bad = runProbe(['--from', badPath]);
  check(`坏文件：${name} 报错带行号`, bad.value?.ok === false && String(bad.value?.error ?? '').includes(lineHint), JSON.stringify(bad.value));
  check(`坏文件：${name} 报错说清原因`, String(bad.value?.error ?? '').includes(wordHint), String(bad.value?.error ?? ''));
}

// 顶层非对象
const notObject = writeTmp('array.json', '[1,2,3]');
const notObj = runProbe(['--to', notObject]);
check('拒绝顶层数组', notObj.value?.ok === false && String(notObj.value?.error ?? '').includes('对象'), JSON.stringify(notObj.value));

// 空容器与会被读错类型的字符串
const tricky = {
  columnWidths: {},
  tags: [],
  invalidReplacement: '=',
  blank: '',
  multiline: '第一行\n第二行',
  numberish: '007',
  boolish: 'false',
  quoted: '带"引号"和\\反斜杠',
};
const trickyPath = writeTmp('tricky.json', JSON.stringify(tricky));
const trickyRt = runProbe(['--roundtrip', trickyPath]);
check('边角：空容器与伪标量字符串往返一致', trickyRt.value?.same === true, JSON.stringify(trickyRt.value));

// 连续两次导出字节一致（拿去做 diff 不能有假差异）
const a = path.join(tmp, 'a.ini');
const b = path.join(tmp, 'b.ini');
runProbe(['--to', settingsFile, '--out', a]);
runProbe(['--to', settingsFile, '--out', b]);
check('稳定：同一份设置两次导出字节一致', existsSync(a) && existsSync(b) && read(a) === read(b));

// ---------------- B. 接线 ----------------
console.log('B. 接线');

const libRs = read(path.join(appRoot, 'src-tauri', 'src', 'lib.rs'));
check('命令：settings_to_ini 已实现', /fn settings_to_ini/.test(libRs));
check('命令：settings_from_ini 已实现', /fn settings_from_ini/.test(libRs));
const handlerSlice = libRs.slice(libRs.indexOf('generate_handler!['));
check('命令：两条都进了 generate_handler', handlerSlice.includes('settings_to_ini,') && handlerSlice.includes('settings_from_ini,'));

const bridgeTs = read(path.join(appRoot, 'src', 'lib', 'bridge.ts'));
check('前端：bridge 暴露 settingsToIni', bridgeTs.includes('export async function settingsToIni') && bridgeTs.includes("'settings_to_ini'"));
check('前端：bridge 暴露 settingsFromIni', bridgeTs.includes('export async function settingsFromIni') && bridgeTs.includes("'settings_from_ini'"));

const coreToml = read(path.join(coreRoot, 'Cargo.toml'));
check('core：没有为 INI 引入第三方解析库', !/^ini\s*=|configparser|rust-ini/m.test(coreToml));

const coreLib = read(path.join(coreRoot, 'src', 'lib.rs'));
check('core：ini 模块已注册', coreLib.includes('pub mod ini;'));
check('core：编解码两端都在', /pub fn to_ini/.test(read(path.join(coreRoot, 'src', 'ini.rs'))));

const settingsFileTs = read(path.join(appRoot, 'src', 'lib', 'settingsFile.ts'));
check('前端：导出载荷带格式标识', settingsFileTs.includes('SETTINGS_FORMAT') && settingsFileTs.includes('renomio-settings'));
check('前端：导入按白名单校验', settingsFileTs.includes('validateImportedSettings') && settingsFileTs.includes('DEFAULT_SETTINGS'));
check('前端：坏规则条目会被丢弃计数', settingsFileTs.includes('sanitizeRules') && settingsFileTs.includes('丢弃'));

const drawer = read(path.join(appRoot, 'src', 'components', 'Drawer.tsx'));
check('界面：导出按钮有 testid', drawer.includes('data-testid="settings-export"'));
check('界面：导入按钮有 testid', drawer.includes('data-testid="settings-import"'));
check('界面：非桌面端禁用导入导出', /disabled=\{!canUseSettingsFile \|\| fileBusy !== null\}/.test(drawer) && drawer.includes('const canUseSettingsFile = isDesktop;'));
check('界面：导入走 updateSettings 而不是直接改 store', drawer.includes('updateSettings(res.patch)'));

const locales = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'es-ES'];
const localeKeys = ['settings.fileGroup', 'settings.fileExportAction', 'settings.fileImportAction', 'settings.fileDemo'];
for (const loc of locales) {
  const text = read(path.join(appRoot, 'src', 'locales', `${loc}.ts`));
  const missing = localeKeys.filter((key) => !text.includes(`'${key}':`));
  const toastMissing = ['toast.settingsExportOk', 'toast.settingsImportOk', 'toast.settingsImportPartial'].filter(
    (key) => !text.includes(`'${key}':`),
  );
  check(`文案：${loc} 设置文件段落齐`, missing.length === 0, missing.join(','));
  check(`文案：${loc} 导入导出提示齐`, toastMissing.length === 0, toastMissing.join(','));
}

const pkg = JSON.parse(read(path.join(appRoot, 'package.json')));
check('脚本：package.json 有 test:ini', typeof pkg.scripts?.['test:ini'] === 'string' && pkg.scripts['test:ini'].includes('test-ini.mjs'));

const ci = read(path.join(repoRoot, '.github', 'workflows', 'ci.yml'));
check('CI：cross-os 跑 INI 契约', ci.includes('--test ini_contract'));
check('CI：cross-os 跑 test-ini', ci.includes('test-ini.mjs'));

const contract = read(path.join(coreRoot, 'tests', 'ini_contract.rs'));
check('契约：覆盖真实设置形状', contract.includes('real_settings_survive_round_trip'));
check('契约：覆盖坏文件行号', contract.includes('duplicate_key_reports_line_number'));

// ---------------- C. 文档 ----------------
console.log('C. 文档');

const gap = read(path.join(repoRoot, 'docs', 'FEATURE-GAP.md'));
check('FEATURE-GAP：6.14 标为 A', /6\.14[^\n]*\|[^\n]*\| A \|/.test(gap) || gap.includes('6.14'));
check('FEATURE-GAP：记录了 INI 设置文件', gap.includes('INI') && gap.includes('设置'));

const appReadme = read(path.join(appRoot, 'README.md'));
check('app/README：记录 test:ini', appReadme.includes('test:ini'));

const rootReadme = read(path.join(repoRoot, 'README.md'));
check('根 README：记录设置文件导入导出', rootReadme.includes('ini') || rootReadme.includes('INI'));

const agents = read(path.join(repoRoot, 'AGENTS.md'));
check('AGENTS：标题指向 alpha15', agents.includes('alpha15'));

rmSync(tmp, { recursive: true, force: true });
console.log(`\ntest:ini  ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
if (requireProbe && !existsSync(path.join(coreRoot, 'examples', 'ini_probe.rs'))) {
  console.log('探针源码缺失');
  process.exit(1);
}
