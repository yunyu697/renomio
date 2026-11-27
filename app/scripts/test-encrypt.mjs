/**
 * 文件名加解密规则（3.13「高级规则 · 加密解密」）自测：
 * A 段纯函数（确定性、往返、认证失败、长度上限、固定向量）
 * B 段引擎接线（applyRules 真跑、ruleError、ruleSummary、默认值、类型表、旧存档补齐）
 * C 段界面与五语种（密码框、模式、实时示例、15 个键 × 5 语种、依赖）
 * D 段文档同源（FEATURE-GAP 3.13 收口、语义清单、README 与 package.json）。
 */
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..');
const outDir = path.join(appRoot, 'node_modules', '.cache', 'encrypt-test');
buildSync({
  entryPoints: [
    path.join(appRoot, 'src', 'lib', 'encrypt.ts'),
    path.join(appRoot, 'src', 'lib', 'rules.ts'),
    path.join(appRoot, 'src', 'lib', 'ruleDefaults.ts'),
  ],
  bundle: true,
  format: 'esm',
  outdir: outDir,
  logLevel: 'silent',
  alias: {
    buffer: path.join(appRoot, 'node_modules', 'buffer'),
    string_decoder: path.join(appRoot, 'node_modules', 'string_decoder'),
  },
});

const {
  applyFilenameEncrypt, ENCRYPT_MODES, ENCRYPT_PREFIX, ENCRYPT_MAX_BYTES, isEncryptMode,
} = await import(pathToFileURL(path.join(outDir, 'encrypt.js')).href);
const { applyRules, normalizeRule, ruleError, ruleSummary } = await import(pathToFileURL(path.join(outDir, 'rules.js')).href);
const { createRuleDefaults, RULE_TYPES } = await import(pathToFileURL(path.join(outDir, 'ruleDefaults.js')).href);

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

const PASS = 'demo-passphrase';
const SAMPLE = '财务 2024 Q1';
const decrypt = (text, key = PASS) => applyFilenameEncrypt(text, key, 'decrypt');
const encrypt = (text, key = PASS) => applyFilenameEncrypt(text, key, 'encrypt');

// ---------- A. 纯函数 ----------
check('加解密模式固定两种', ENCRYPT_MODES.join(',') === 'encrypt,decrypt', ENCRYPT_MODES.join(','));
check('isEncryptMode 认两种合法值', ENCRYPT_MODES.every((m) => isEncryptMode(m)));
check('isEncryptMode 拒绝非法值', !isEncryptMode('encode') && !isEncryptMode(undefined));
check('密文前缀为 rnc1-', ENCRYPT_PREFIX === 'rnc1-', ENCRYPT_PREFIX);

const enc = encrypt(SAMPLE);
check('加密成功', enc.ok === true, JSON.stringify(enc));
check('密文带 rnc1- 前缀', enc.ok && enc.value.startsWith(ENCRYPT_PREFIX), enc.ok ? enc.value : '');
check('密文不含 Windows 非法字符',
  enc.ok && !/[<>:"/\\|?*]/.test(enc.value.slice(ENCRYPT_PREFIX.length)), enc.ok ? enc.value : '');
check('密文不含空白与控制字符', enc.ok && !/[\s\x00-\x1f]/.test(enc.value), enc.ok ? enc.value : '');
check('同一名字同一口令得到同一密文（预览稳定）', enc.ok && encrypt(SAMPLE).value === enc.value);
check('同一名字换口令得到不同密文', enc.ok && encrypt(SAMPLE, 'other-pass').value !== enc.value);
check('不同名字得到不同密文', enc.ok && encrypt('财务 2024 Q2').value !== enc.value);
check('解密回到原串', enc.ok && decrypt(enc.value).ok && decrypt(enc.value).value === SAMPLE,
  enc.ok ? JSON.stringify(decrypt(enc.value)) : '');
check('Emoji 与中文往返不变', (() => {
  const r = encrypt('照片😀 最终版');
  return r.ok && decrypt(r.value).value === '照片😀 最终版';
})());
check('空格、括号、点号往返不变', (() => {
  const r = encrypt('Q1 (final).v2');
  return r.ok && decrypt(r.value).value === 'Q1 (final).v2';
})());
check('同口令重复解密结果稳定', enc.ok && decrypt(enc.value).value === decrypt(enc.value).value);

check('错误口令返回 badPassphrase', enc.ok && decrypt(enc.value, 'wrong-pass').code === 'badPassphrase',
  enc.ok ? JSON.stringify(decrypt(enc.value, 'wrong-pass')) : '');
check('未加密文本返回 notEncrypted', decrypt('普通名字').code === 'notEncrypted');
check('只带前缀没有内容返回 badPayload', decrypt(`${ENCRYPT_PREFIX}abc`).code === 'badPayload');
check('前缀后含非法 base64url 字符返回 badPayload', decrypt(`${ENCRYPT_PREFIX}ab+/cd`).code === 'badPayload');
check('密文被篡改一个字符 → 认证失败，不吐明文', (() => {
  if (!enc.ok) return false;
  const body = enc.value.slice(ENCRYPT_PREFIX.length);
  const flipped = body.slice(0, -1) + (body.endsWith('A') ? 'B' : 'A');
  const r = decrypt(`${ENCRYPT_PREFIX}${flipped}`);
  return !r.ok && (r.code === 'badPassphrase' || r.code === 'badPayload');
})());
check('空口令拒绝执行', encrypt('abc', '').code === 'noPassphrase');
check('解密也要求口令', decrypt(enc.ok ? enc.value : 'x', '').code === 'noPassphrase');
check('空文件名拒绝加密', encrypt('').code === 'empty');
check(`明文上限 ${ENCRYPT_MAX_BYTES} 字节`, ENCRYPT_MAX_BYTES === 140, String(ENCRYPT_MAX_BYTES));
check('恰好 140 字节可加密', encrypt('a'.repeat(140)).ok === true);
check('141 字节拒绝（tooLong）', encrypt('a'.repeat(141)).code === 'tooLong');
check('中文按 UTF-8 字节计数（140 字节内可加密）', (() => {
  const text = '中'.repeat(46) + 'ab'; // 46*3+2 = 140
  return encrypt(text).ok === true;
})());
check('中文超 140 字节拒绝', encrypt('中'.repeat(47)).code === 'tooLong');
check('最长密文不超过 255 字节', (() => {
  const r = encrypt('a'.repeat(140));
  return r.ok && Buffer.byteLength(r.value, 'utf8') <= 255;
})(), (() => {
  const r = encrypt('a'.repeat(140));
  return r.ok ? String(Buffer.byteLength(r.value, 'utf8')) : '';
})());

// 固定向量：跨版本、跨平台必须解得回来；算法参数一变就会红
check('固定向量：财务 2024 Q1 / demo-passphrase',
  enc.ok && enc.value === 'rnc1-2i7ifMBY9K_qjsvwB_TadZTuzZzbfftiGJaF_w7Itm6Ebh_s0P5UV5veljNFElj8',
  enc.ok ? enc.value : '');
check('固定向量可解密', decrypt('rnc1-2i7ifMBY9K_qjsvwB_TadZTuzZzbfftiGJaF_w7Itm6Ebh_s0P5UV5veljNFElj8').value === SAMPLE);

// ---------- B. 引擎接线 ----------
const ctx = () => ({
  nextNumber: () => 1,
  peekNumber: () => 1,
  vars: {
    stem: 'x', ext: 'txt', dirName: 'Trip', modified: 1, size: 1, hashes: {}, users: [], user0: '',
  },
});
const runRules = (stem, rules, { ext = 'txt', isDir = false } = {}) =>
  applyRules({ stem, ext }, isDir, rules, 'Trip', ctx(), true);
const er = (mode = 'encrypt', passphrase = PASS, enabled = true) => ({
  id: 'e', type: 'encrypt', enabled, mode, passphrase,
});

check('RULE_TYPES 追加 encrypt（共 13 种）', RULE_TYPES.includes('encrypt') && RULE_TYPES.length === 13, `${RULE_TYPES.join(',')} / ${RULE_TYPES.length}`);
check('createRuleDefaults(encrypt) 默认加密 + 空口令',
  createRuleDefaults('encrypt', 'e1').mode === 'encrypt' && createRuleDefaults('encrypt', 'e1').passphrase === '',
  JSON.stringify(createRuleDefaults('encrypt', 'e1')));
check('applyRules 加密主干，扩展名不动', (() => {
  const r = runRules(SAMPLE, [er()], { ext: 'txt' });
  return r.stem.startsWith(ENCRYPT_PREFIX) && r.ext === 'txt';
})());
check('applyRules 加密 → 解密回到原主干', (() => {
  const r = runRules(SAMPLE, [er('encrypt'), er('decrypt')]);
  return r.stem === SAMPLE;
})());
check('停用的加密规则不参与求值', runRules(SAMPLE, [er('encrypt', PASS, false)]).stem === SAMPLE);
check('非法 mode 的规则整条跳过（不崩）', runRules(SAMPLE, [er('bogus')]).stem === SAMPLE);
check('空口令规则被 ruleError 拦住，求值保留原名', (() => {
  const rule = normalizeRule(er('encrypt', ''));
  return ruleError(rule) !== null && runRules(SAMPLE, [rule]).stem === SAMPLE;
})());
check('错误口令解密保留原名，不写半截密文', (() => {
  const encrypted = encrypt(SAMPLE);
  if (!encrypted.ok) return false;
  return runRules(encrypted.value, [er('decrypt', 'wrong-pass')]).stem === encrypted.value;
})());
check('ruleError 对合法加密规则返回 null', ruleError(normalizeRule(er())) === null);
check('ruleError 对非法 mode 报错', ruleError(er('bogus')) !== null);
check('ruleSummary 加密文案不含口令明文', (() => {
  const s = ruleSummary(normalizeRule(er('encrypt', 'super-secret')));
  return !s.includes('super-secret') && (s.includes('加密') || s.toLowerCase().includes('encrypt'));
})(), ruleSummary(normalizeRule(er('encrypt', 'super-secret'))));
check('ruleSummary 解密文案随模式变化', (() => {
  const s = ruleSummary(normalizeRule(er('decrypt', 'super-secret')));
  return !s.includes('super-secret') && (s.includes('解密') || s.toLowerCase().includes('decrypt'));
})(), ruleSummary(normalizeRule(er('decrypt', 'super-secret'))));
check('normalizeRule 缺失 mode 回落 encrypt', normalizeRule({ id: 'e', type: 'encrypt', enabled: true }).mode === 'encrypt');
check('normalizeRule 非法 mode 回落 encrypt', normalizeRule({ id: 'e', type: 'encrypt', enabled: true, mode: 'bogus' }).mode === 'encrypt');
check('normalizeRule 缺失口令回落空串', normalizeRule({ id: 'e', type: 'encrypt', enabled: true }).passphrase === '');

// ---------- C. 界面与五语种 ----------
const read = (rel) => readFileSync(path.join(appRoot, rel), 'utf8');
const editor = read('src/components/RuleEditor.tsx');
check('编辑器有加解密模式控件', editor.includes('testId="encrypt-mode"'));
check('编辑器有口令输入框且为 password 类型',
  editor.includes('data-testid="encrypt-passphrase"') && editor.includes('type="password"'));
check('编辑器有加解密说明与示例', editor.includes('data-testid="encrypt-hint"') && editor.includes('data-testid="encrypt-sample"'));
check('编辑器示例实时调用 applyFilenameEncrypt', editor.includes('applyFilenameEncrypt('));
check('编辑器接进 RuleEditor 分发', editor.includes("rule.type === 'encrypt' && <EncryptEditor"));

let locales = 0;
const localeKeys = [
  "'ruleType.encrypt':", "'ruleDesc.encrypt':", "'f.encryptMode':", "'f.encrypt.encrypt':",
  "'f.encrypt.decrypt':", "'f.passphrase':", "'ph.passphrase':", "'f.encryptHint':",
  "'f.encryptNeedPass':", "'f.encryptSample':", "'f.encryptSampleFail':",
  "'ruleErr.encryptNoPassphrase':", "'ruleErr.badEncryptMode':", "'ruleSum.encrypt':", "'ruleSum.decrypt':",
];
for (const file of readdirSync(path.join(appRoot, 'src/locales'))) {
  if (!file.endsWith('.ts')) continue;
  const body = readFileSync(path.join(appRoot, 'src/locales', file), 'utf8');
  if (localeKeys.every((k) => body.includes(k))) locales += 1;
}
check('五语种都补齐加解密规则 15 个键', locales === 5, `${locales} 个语种齐全`);

const pkg = JSON.parse(read('package.json'));
check('package.json 有 test:encrypt 脚本', typeof pkg.scripts['test:encrypt'] === 'string', pkg.scripts['test:encrypt']);
check('package.json 记录 crypto-js 运行时依赖', Boolean(pkg.dependencies['crypto-js']), JSON.stringify(pkg.dependencies['crypto-js']));
check('package.json 记录 @types/crypto-js 开发依赖', Boolean(pkg.devDependencies['@types/crypto-js']), JSON.stringify(pkg.devDependencies['@types/crypto-js']));

// ---------- D. 文档同源 ----------
const docsRoot = path.join(appRoot, '..', 'docs');
const gap = readFileSync(path.join(docsRoot, 'FEATURE-GAP.md'), 'utf8');
const row313 = gap.split(/\r?\n/).find((l) => l.startsWith('| 3.13 ')) ?? '';
check('FEATURE-GAP 3.13 行标记加解密落地', row313.includes('加密') && !row313.includes('加密未做'), row313.slice(0, 200));
check('FEATURE-GAP 3.13 行记录 test:encrypt 证据', row313.includes('test:encrypt'), row313.slice(0, 240));
check('FEATURE-GAP 统计行写明 3.13 全做', /3\.13[^\n]*全/.test(gap) || /D 部分[^\n]*0 项/.test(gap), '');

const semantics = readFileSync(path.join(docsRoot, '规则语义确认清单.md'), 'utf8');
check('语义清单新增「文件名加解密」一节', semantics.includes('文件名加解密') || semantics.includes('加密解密'));
check('语义清单写清只改文件名、不动文件内容', semantics.includes('文件内容') && semantics.includes('不动'));

const readme = read('../app/README.md');
check('README 记录文件名加解密规则', readme.includes('文件名加密') || readme.includes('加解密'));

console.log(`\n文件名加解密规则自测：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
