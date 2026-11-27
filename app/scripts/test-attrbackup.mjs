/**
 * 属性备份库（6.3 收口）自测。
 *
 * 判据：**每次成功写属性都要另存一份「改之前」的四属性，而且批次日志被删掉后仍能整体还原**。
 * 四段：
 *  A. core：独立目录、原子写、坏文件跳过、按时间倒序、保留策略、还原的缺失/失败分流。
 *  B. 接线：`apply_attrs` 落备份、`attr_flags`/`write_attr_flags`、两条命令注册。
 *  C. 界面：桥接两个函数、类型、面板三个 testid、五语种 8 键、样式类。
 *  D. 活体：`--require-probe` 真跑 `cargo test --test attrbackup_contract` 与 `--lib attrbackup`。
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

const coreSrc = read(path.join(coreRoot, 'src', 'attrbackup.rs'));
const coreLib = read(path.join(coreRoot, 'src', 'lib.rs'));
const opsSrc = read(path.join(coreRoot, 'src', 'ops.rs'));
const contract = read(path.join(coreRoot, 'tests', 'attrbackup_contract.rs'));
const tauriLib = read(path.join(appRoot, 'src-tauri', 'src', 'lib.rs'));
const bridge = read(path.join(appRoot, 'src', 'lib', 'bridge.ts'));
const types = read(path.join(appRoot, 'src', 'lib', 'types.ts'));
const bodies = read(path.join(appRoot, 'src', 'components', 'OpsBodies.tsx'));
const css = read(path.join(appRoot, 'src', 'styles', 'app.css'));

console.log('A. core 属性备份库');
check('attrbackup 模块已导出', /pub mod attrbackup;/.test(coreLib));
check('独立目录 attr-backups', coreSrc.includes('join("attr-backups")'));
check('原子写：先 .tmp 再 rename', coreSrc.includes('with_extension("json.tmp")') && coreSrc.includes('fs::rename'));
check('坏文件跳过', coreSrc.includes('let Ok(backup) = serde_json::from_str::<AttrBackup>(&raw) else')
  && coreSrc.includes('continue;'));
check('列表按创建时间倒序', coreSrc.includes('b.created_at.cmp(&a.created_at)'));
check('默认保留 50 份', /DEFAULT_KEEP: usize = 50/.test(coreSrc));
check('裁剪只留最新 keep 份', coreSrc.includes('skip(keep)'));
check('还原区分 缺失/未变/已还原/失败', ['missing', 'unchanged', 'restored', 'failed'].every((f) => coreSrc.includes(f)));
check('路径 id 清洗（防目录穿越）', coreSrc.includes('fn safe_id'));
check('四路属性都进快照', ['readonly', 'hidden', 'system', 'archive'].every((f) => coreSrc.includes(`pub ${f}: bool`)));
check('单元测试覆盖 存/列/裁/坏文件', ['save_list_and_load_round_trip', 'prune_keeps_newest_only', 'corrupt_file_is_skipped'].every((n) => coreSrc.includes(n)));

console.log('\nB. 落盘与命令');
check('apply_attrs 写完调 record_attr_backup', /record_attr_backup\(store, &batch\);/.test(opsSrc));
check('备份只取 state == done 的条目', opsSrc.includes('filter(|op| op.state == "done")'));
check('备份里存的是 before（改之前）', opsSrc.includes('AttrValues::from_json(&op.before)'));
check('备份写失败不拖垮已完成的写入', opsSrc.includes('if backup_store.save(&backup).is_ok()'));
check('ops 暴露 attr_flags / write_attr_flags', /pub fn attr_flags\(/.test(opsSrc) && /pub fn write_attr_flags\(/.test(opsSrc));
for (const cmd of ['attr_backups', 'attr_restore_backup']) {
  const defined = new RegExp(`fn ${cmd}\\(`).test(tauriLib);
  const registered = new RegExp(`\\b${cmd},`).test(tauriLib);
  check(`命令 ${cmd} 定义并注册`, defined && registered);
}
check('找不到备份时给人话错误', tauriLib.includes('找不到这条属性备份'));
check('契约测试存在且含批次日志删除场景', contract.includes('restore_survives_batch_log_removal'));
check('契约覆盖缺失文件不阻断', contract.includes('restore_reports_missing_and_keeps_going'));
check('契约覆盖 Windows 四路整体还原', contract.includes('windows_flags_round_trip_through_backup'));

console.log('\nC. 界面接线');
for (const fn of ['listAttrBackups', 'restoreAttrBackup']) {
  check(`bridge 暴露 ${fn}`, new RegExp(`export async function ${fn}\\(`).test(bridge));
}
check('类型 AttrBackupSummaryDto', /export interface AttrBackupSummaryDto \{/.test(types));
check('类型 AttrRestoreReportDto', /export interface AttrRestoreReportDto \{/.test(types));
for (const id of ['attr-backup-section', 'attr-backup-empty', 'attr-backup-restore']) {
  check(`属性面板有 ${id}`, bodies.includes(`data-testid="${id}"`));
}
check('演示模式不请求备份库', /if \(!isDesktop\) return;/.test(bodies));
check('还原后重新读属性与备份列表', /await load\(\);\s*\n\s*await loadBackups\(\);/.test(bodies));
const locales = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'es-ES'];
const keys = [
  'ops.attrBackupTitle', 'ops.attrBackupHint', 'ops.attrBackupEmpty', 'ops.attrBackupEntries',
  'ops.attrBackupRestore', 'ops.attrBackupDone', 'ops.attrBackupFail', 'ops.attrBackupUnavailable',
];
for (const loc of locales) {
  const text = read(path.join(appRoot, 'src', 'locales', `${loc}.ts`));
  const missing = keys.filter((k) => !text.includes(`'${k}'`));
  check(`${loc} 文案齐全（${keys.length} 键）`, missing.length === 0, missing.join(', '));
}
check('样式有 .attr-backup', css.includes('.attr-backup {'));

console.log('\nD. 文档');
const gap = read(path.join(repoRoot, 'docs', 'FEATURE-GAP.md'));
check('FEATURE-GAP 6.3 提到属性备份库', /6\.3/.test(gap) && gap.includes('属性备份库'));
const gap63 = gap.split('\n').find((line) => line.startsWith('| 6.3 ')) || '';
check('6.3 行不再写「系统/归档属性未做」', gap63.length > 0 && !gap63.includes('系统/归档属性未做'));
check('FEATURE-GAP 提到 attrbackup_contract', gap.includes('attrbackup_contract'));
check('package.json 有 test:attrbackup', read(path.join(appRoot, 'package.json')).includes('"test:attrbackup"'));

if (requireProbe) {
  console.log('\nE. 活体：cargo test');
  for (const args of [['test', '--test', 'attrbackup_contract'], ['test', '--lib', 'attrbackup']]) {
    const cwd = coreRoot;
    const r = spawnSync('cargo', args, { cwd, encoding: 'utf8', shell: true });
    const out = `${r.stdout}\n${r.stderr}`;
    const ok = r.status === 0 && /test result: ok/.test(out);
    const passed = (out.match(/test result: ok\. (\d+) passed/) || [])[1];
    check(`cargo ${args.join(' ')} 通过（${passed ?? '?'} 条）`, ok, out.split('\n').slice(-4).join(' | '));
  }
}

console.log(`\n${pass} 项通过，${fail} 项失败`);
if (fail > 0) process.exit(1);
