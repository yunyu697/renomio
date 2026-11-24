/**
 * 扩展名「智能分析」自测：用文件头嗅探出的真实扩展名纠正错标，
 * 识别不出 / 上下文缺失 / 目录 / 大小写保持原名，另查校验、摘要、五语种文案与「界面-引擎-管线」接线。
 * 纯逻辑（esbuild 就地打包 src/lib/rules.ts），不依赖窗口；Rust 嗅探覆盖由同一脚本静态核对。
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const outfile = path.join(appRoot, 'node_modules', '.cache', 'ext-test.mjs');
buildSync({
  entryPoints: [path.join(appRoot, 'src', 'lib', 'rules.ts')],
  bundle: true,
  format: 'esm',
  outfile,
  logLevel: 'silent',
});

const { applyRules, normalizeRule, ruleError, ruleSummary } = await import(pathToFileURL(outfile).href);

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

const ctxBase = (sniff) => ({
  nextNumber: () => 1,
  peekNumber: () => 1,
  sniff,
  vars: { name: 'x', ext: '', dir: '', parent: '', date: '', size: '', hash: '', user0: '', users: [] },
});

/** 用一条 ext 规则求值，返回 `stem.ext`。 */
const runExt = (ext, mode, sniff, { isDir = false, value = '' } = {}) => {
  const rule = normalizeRule({ id: 'ex', type: 'ext', enabled: true, mode, value, position: 'suffix', caseMode: 'lower' });
  const out = applyRules({ stem: 'photo', ext }, isDir, [rule], '', ctxBase(sniff), true);
  return `${out.stem}.${out.ext}`;
};

// 1. 核心语义：错标纠正、正确不动、识别不出不动
check('jpg 实为 png → photo.png', runExt('jpg', 'analyze', 'png') === 'photo.png', runExt('jpg', 'analyze', 'png'));
check('jpg 实为 jpg → 原名不变', runExt('jpg', 'analyze', 'jpg') === 'photo.jpg', runExt('jpg', 'analyze', 'jpg'));
check('png 实为 jpeg → photo.jpeg', runExt('png', 'analyze', 'jpeg') === 'photo.jpeg', runExt('png', 'analyze', 'jpeg'));
check('魔数识别不出（空串）→ 原名不变', runExt('jpg', 'analyze', '') === 'photo.jpg', runExt('jpg', 'analyze', ''));
check('没有嗅探上下文（演示/旧存档）→ 原名不变', runExt('jpg', 'analyze', undefined) === 'photo.jpg', runExt('jpg', 'analyze', undefined));
check('无扩展名 + 识别出 pdf → 补成 .pdf', runExt('', 'analyze', 'pdf') === 'photo.pdf', runExt('', 'analyze', 'pdf'));

// 2. 大小写：真实值与当前值只差大小写时保留用户原有写法
check('当前 JPG / 真实 jpg → 保留 JPG', runExt('JPG', 'analyze', 'jpg') === 'photo.JPG', runExt('JPG', 'analyze', 'jpg'));
check('嗅探值带大写也会被小写化后比较（PNG vs png）', runExt('jpg', 'analyze', 'PNG') === 'photo.png', runExt('jpg', 'analyze', 'PNG'));
check('嗅探值带前导点也被吃掉', runExt('jpg', 'analyze', '.png') === 'photo.png', runExt('jpg', 'analyze', '.png'));

// 3. 目录不参与、其余模式不受影响
check('目录不纠正扩展名', runExt('jpg', 'analyze', 'png', { isDir: true }) === 'photo.jpg', runExt('jpg', 'analyze', 'png', { isDir: true }));
check('analyze 不读 value（填了也不参与取名）', runExt('jpg', 'analyze', 'png', { value: 'zzz' }) === 'photo.png', runExt('jpg', 'analyze', 'png', { value: 'zzz' }));
check('replace 模式仍按值替换（未被 analyze 影响）', runExt('jpg', 'replace', 'png', { value: 'webp' }) === 'photo.webp', runExt('jpg', 'replace', 'png', { value: 'webp' }));
check('remove 模式仍清空扩展名', runExt('jpg', 'remove', 'png') === 'photo.', runExt('jpg', 'remove', 'png'));

// 4. 与其它扩展名规则串起来：先固定再纠正
const chain = (ext, sniff) => {
  const rules = [
    normalizeRule({ id: 'a', type: 'ext', enabled: true, mode: 'fixed', value: 'jpg', position: 'suffix' }),
    normalizeRule({ id: 'b', type: 'ext', enabled: true, mode: 'analyze', value: '', position: 'suffix' }),
  ];
  const out = applyRules({ stem: 'photo', ext }, false, rules, '', ctxBase(sniff), true);
  return `${out.stem}.${out.ext}`;
};
check('固定成 jpg 后再纠正为 png', chain('png', 'png') === 'photo.png', chain('png', 'png'));
check('固定成 jpg 后识别不出则停在 jpg', chain('png', '') === 'photo.jpg', chain('png', ''));

// 5. 校验与摘要
const analyzeRule = normalizeRule({ id: 'e1', type: 'ext', enabled: true, mode: 'analyze', value: '', position: 'suffix' });
check('analyze 模式不需要填值，不报错', ruleError(analyzeRule) === null, String(ruleError(analyzeRule)));
const emptyFixed = normalizeRule({ id: 'e2', type: 'ext', enabled: true, mode: 'fixed', value: '', position: 'suffix' });
check('fixed 模式空值仍报错（未被放松）', ruleError(emptyFixed) !== null, String(ruleError(emptyFixed)));
const sum = ruleSummary(analyzeRule);
check('摘要：说明按文件头纠正且不是裸键', sum.length > 0 && !sum.includes('ruleSum.'), sum);

// 6. 五语种文案齐全（缺键会渲染成裸键）
const keys = ['o.analyze', 'ruleSum.extAnalyze', 'f.extAnalyzeHint'];
for (const lang of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'es-ES']) {
  const src = readFileSync(path.join(appRoot, 'src', 'locales', `${lang}.ts`), 'utf8');
  const missing = keys.filter((key) => !src.includes(`'${key}':`));
  check(`${lang} 的智能分析文案齐全（${keys.length} 条）`, missing.length === 0, missing.join(','));
}

// 7. 界面：编辑器有入口与提示
const editorSrc = readFileSync(path.join(appRoot, 'src', 'components', 'RuleEditor.tsx'), 'utf8');
const extBlock = editorSrc.slice(editorSrc.indexOf('function ExtEditor'), editorSrc.indexOf('function MetaEditor'));
check('编辑器扩展名模式有 analyze 选项', extBlock.includes("['analyze', t('o.analyze')]"), extBlock.slice(0, 260));
check('编辑器模式分段带 testid', extBlock.includes('testId="ext-mode"'));
check('编辑器在 analyze 模式给出提示', extBlock.includes("t('f.extAnalyzeHint')") && extBlock.includes('data-testid="ext-analyze-hint"'));

// 8. 接线：bridge / store / preview 真的把嗅探值传到引擎
const bridgeSrc = readFileSync(path.join(appRoot, 'src', 'lib', 'bridge.ts'), 'utf8');
check('bridge 调 sniff_extensions', bridgeSrc.includes("invoke<SniffExtResult[]>('sniff_extensions'"), 'bridge');
const storeSrc = readFileSync(path.join(appRoot, 'src', 'store.ts'), 'utf8');
check('store 有 sniffTypes 状态', storeSrc.includes('sniffTypes: Record<string, string>'));
check('store 有 loadSniffTypes 动作', storeSrc.includes('loadSniffTypes: async (paths)'));
const sniffOpts = (storeSrc.match(/sniff: (get\(\)\.sniffTypes|s\.sniffTypes)/g) || []).length;
check('store 两处 computePreview 都传了 sniff（应为 2）', sniffOpts === 2, String(sniffOpts));
const previewSrc = readFileSync(path.join(appRoot, 'src', 'lib', 'preview.ts'), 'utf8');
check('preview 把每条文件的嗅探值放进 ApplyContext', previewSrc.includes('sniff: opts.sniff?.[entry.path]'));
// 真正的预览管线在 usePreview 缓存里：漏接这里会让「界面显示不纠正」而与后端对齐假象共存
const hookSrc = readFileSync(path.join(appRoot, 'src', 'hooks', 'usePreview.ts'), 'utf8');
check(
  'usePreview 读取 sniffTypes 并传入 opts / 参与缓存键与依赖',
  hookSrc.includes('s.sniffTypes')
    && hookSrc.includes('cache.sniff === sniff')
    && hookSrc.includes('      sniff,')
    && hookSrc.includes('}, [entries, rules, env, strict, readonly, disk, meta, sniff, facts'),
  'usePreview',
);
const appSrc = readFileSync(path.join(appRoot, 'src', 'App.tsx'), 'utf8');
check('App 在 analyze 规则启用时才按需加载', appSrc.includes("r.type === 'ext' && r.mode === 'analyze'") && appSrc.includes('loadSniffTypes'));

// 9. Rust 侧：魔数覆盖与命令注册（防「前端做完了、后端没接」）
const sniffSrc = readFileSync(path.join(appRoot, 'src-tauri', 'renomio-core', 'src', 'sniff.rs'), 'utf8');
for (const ext of ['jpg', 'png', 'gif', 'bmp', 'tif', 'webp', 'wav', 'avi', 'mp4', 'm4a', 'mov', 'heic', 'pdf', 'zip', 'gz', '7z', 'rar', 'flac', 'ogg', 'mp3']) {
  check(`sniff.rs 覆盖 ${ext}`, sniffSrc.includes(`"${ext}"`), ext);
}
check('sniff.rs 只读文件头（HEAD_LEN=64）', sniffSrc.includes('HEAD_LEN') && sniffSrc.includes('64'));
const tauriSrc = readFileSync(path.join(appRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
check('tauri 命令 sniff_extensions 存在且已注册', tauriSrc.includes('fn sniff_extensions(') && tauriSrc.includes('sniff_extensions,'));
const coreLib = readFileSync(path.join(appRoot, 'src-tauri', 'renomio-core', 'src', 'lib.rs'), 'utf8');
check('core lib 声明了 sniff 模块', coreLib.includes('pub mod sniff;'));

console.log(`\n扩展名智能分析自测：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
