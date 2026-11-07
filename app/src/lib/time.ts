/** 时间随机化的确定性哈希；必须与 Rust `renomio-core/src/ops.rs` 的 fnv1a 保持一致。 */
export function fnv1a(raw: string): number {
  const bytes = new TextEncoder().encode(raw);
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 按「路径 + 种子」在 [min, max] 内取确定值，预览与执行一致。 */
export function randomMsOf(path: string, min: number, max: number, seed = ''): number {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  const span = high - low + 1;
  if (!Number.isFinite(span) || span <= 0) return low;
  return low + (fnv1a(`${path}\u0001${seed}`) % span);
}
