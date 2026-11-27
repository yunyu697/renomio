/**
 * 文件名加解密（3.13「加密解密」高级规则）。
 *
 * 只处理文件名主干，不碰文件内容、不生成容器，也不做 Windows EFS。
 * 密文格式：`rnc1-` + base64url(IV 16B + AES-256-CBC 密文 + HMAC-SHA256 截断 16B)。
 * 口令经 PBKDF2-SHA256 派生三把子密钥（加密 / 认证 / IV 派生），派生结果按口令缓存，
 * 批量改名时同一口令只算一次。IV 由「认证密钥 + 明文」确定，因此同名同口令得到同一密文，
 * 预览不会每次刷新都跳；代价是相同明文可被看出相等，这一点在文档里写明。
 *
 * 兼容性：新增算法或改参数时必须换前缀（rnc2-），旧密文继续按 rnc1- 解。
 */
import CryptoJS from 'crypto-js';

export type EncryptMode = 'encrypt' | 'decrypt';

export const ENCRYPT_MODES: EncryptMode[] = ['encrypt', 'decrypt'];

/** 密文前缀：既是格式版本，也是「这段文本是不是密文」的判据。 */
export const ENCRYPT_PREFIX = 'rnc1-';

/** 明文按 UTF-8 计的最大字节数；密文 = 前缀 5 + base64(16B IV + 密文 + 16B 认证)，140 字节内稳在 255 字节文件名上限内。 */
export const ENCRYPT_MAX_BYTES = 140;

const SALT = 'Renomio filename crypt v1';
const ITERATIONS = 10000;
const KEY_CACHE_LIMIT = 8;

export type EncryptErrorCode =
  | 'noPassphrase'
  | 'tooLong'
  | 'empty'
  | 'notEncrypted'
  | 'badPayload'
  | 'badPassphrase';

export type EncryptResult =
  | { ok: true; value: string }
  | { ok: false; code: EncryptErrorCode };

interface Keys {
  enc: CryptoJS.lib.WordArray;
  mac: CryptoJS.lib.WordArray;
  iv: CryptoJS.lib.WordArray;
}

const keyCache = new Map<string, Keys>();

function deriveKeys(passphrase: string): Keys {
  const cached = keyCache.get(passphrase);
  if (cached) return cached;
  const words = CryptoJS.PBKDF2(passphrase, CryptoJS.enc.Utf8.parse(SALT), {
    keySize: 24, // 24 words = 768 bit：32B 加密 + 32B 认证 + 32B IV 派生
    iterations: ITERATIONS,
    hasher: CryptoJS.algo.SHA256,
  });
  const keys: Keys = {
    enc: CryptoJS.lib.WordArray.create(words.words.slice(0, 8), 32),
    mac: CryptoJS.lib.WordArray.create(words.words.slice(8, 16), 32),
    iv: CryptoJS.lib.WordArray.create(words.words.slice(16, 24), 32),
  };
  if (keyCache.size >= KEY_CACHE_LIMIT) {
    const oldest = keyCache.keys().next().value;
    if (oldest !== undefined) keyCache.delete(oldest);
  }
  keyCache.set(passphrase, keys);
  return keys;
}

function toBase64Url(words: CryptoJS.lib.WordArray): string {
  return CryptoJS.enc.Base64.stringify(words)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(text: string): CryptoJS.lib.WordArray | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    return CryptoJS.enc.Base64.parse(padded);
  } catch {
    return null;
  }
}

function bytesOf(words: CryptoJS.lib.WordArray): number {
  return words.sigBytes;
}

/** 确定 IV：HMAC(ivKey, 明文) 取前 16 字节。同名同口令 → 同密文，预览稳定。 */
function deterministicIv(keys: Keys, plain: CryptoJS.lib.WordArray): CryptoJS.lib.WordArray {
  const digest = CryptoJS.HmacSHA256(plain, keys.iv).toString(CryptoJS.enc.Hex).slice(0, 32);
  return CryptoJS.enc.Hex.parse(digest);
}

function authTag(keys: Keys, iv: CryptoJS.lib.WordArray, cipher: CryptoJS.lib.WordArray): CryptoJS.lib.WordArray {
  const digest = CryptoJS.HmacSHA256(iv.clone().concat(cipher), keys.mac)
    .toString(CryptoJS.enc.Hex).slice(0, 32);
  return CryptoJS.enc.Hex.parse(digest);
}

function constantTimeEqual(a: CryptoJS.lib.WordArray, b: CryptoJS.lib.WordArray): boolean {
  if (a.sigBytes !== b.sigBytes) return false;
  let diff = 0;
  for (let i = 0; i < a.sigBytes; i++) {
    const av = (a.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
    const bv = (b.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
    diff |= av ^ bv;
  }
  return diff === 0;
}

function encryptOne(text: string, passphrase: string): EncryptResult {
  if (text.length === 0) return { ok: false, code: 'empty' };
  const plain = CryptoJS.enc.Utf8.parse(text);
  if (bytesOf(plain) > ENCRYPT_MAX_BYTES) return { ok: false, code: 'tooLong' };
  const keys = deriveKeys(passphrase);
  const iv = deterministicIv(keys, plain);
  const encrypted = CryptoJS.AES.encrypt(plain, keys.enc, {
    iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });
  const payload = iv.clone().concat(encrypted.ciphertext).concat(authTag(keys, iv, encrypted.ciphertext));
  return { ok: true, value: `${ENCRYPT_PREFIX}${toBase64Url(payload)}` };
}

function decryptOne(text: string, passphrase: string): EncryptResult {
  if (!text.startsWith(ENCRYPT_PREFIX)) return { ok: false, code: 'notEncrypted' };
  const body = text.slice(ENCRYPT_PREFIX.length);
  const payload = fromBase64Url(body);
  if (!payload) return { ok: false, code: 'badPayload' };
  const total = bytesOf(payload);
  if (total < 48 || (total - 32) % 16 !== 0) return { ok: false, code: 'badPayload' };

  const iv = CryptoJS.lib.WordArray.create(payload.words.slice(0, 4), 16);
  const cipher = CryptoJS.lib.WordArray.create(payload.words.slice(4, 4 + (total - 32) / 4), total - 32);
  const tag = CryptoJS.lib.WordArray.create(payload.words.slice(4 + (total - 32) / 4), 16);
  const keys = deriveKeys(passphrase);
  if (!constantTimeEqual(tag, authTag(keys, iv, cipher))) return { ok: false, code: 'badPassphrase' };

  try {
    const decrypted = CryptoJS.AES.decrypt(
      CryptoJS.lib.CipherParams.create({ ciphertext: cipher }),
      keys.enc,
      { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 },
    );
    const plain = decrypted.toString(CryptoJS.enc.Utf8);
    if (plain.length === 0) return { ok: false, code: 'badPayload' };
    return { ok: true, value: plain };
  } catch {
    return { ok: false, code: 'badPayload' };
  }
}

/** 规则求值入口：失败返回错误码，由上层保留原名。 */
export function applyFilenameEncrypt(text: string, passphrase: string, mode: EncryptMode): EncryptResult {
  if (!passphrase) return { ok: false, code: 'noPassphrase' };
  return mode === 'encrypt' ? encryptOne(text, passphrase) : decryptOne(text, passphrase);
}

export function isEncryptMode(value: unknown): value is EncryptMode {
  return value === 'encrypt' || value === 'decrypt';
}
