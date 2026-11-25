/**
 * 列宽自适应（FEATURE-GAP 1.5：「自动列宽」缺口）。
 *
 * 这里只放**纯函数**：文本测量由调用方注入（浏览器用 canvas，测试用假测量器），
 * 因此同一份算法能在真实界面与 Node 自测里跑出一致结果，不依赖 DOM。
 */

export interface FitSpec {
  /** 下界：与该列的最小可读宽度一致，避免自适应后被挤成不可读 */
  min: number;
  /** 上界：单行超长文件名不应该把整张表挤爆 */
  max: number;
  /** 文本两侧的非文本占位（勾选框、类型图标、状态点、内边距） */
  pad: number;
}

/** 夹到 [min, max] 并取整；非法输入（NaN/Infinity）退回下界，不让界面算出 px: NaN。 */
export function clampWidth(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return Math.round(min);
  return Math.min(Math.round(max), Math.max(Math.round(min), Math.round(value)));
}

/**
 * 给定一列的候选文本，算出「装得下最宽一行」的列宽。
 * 空列表 / 全空文本时返回下界（= 当前最小可读宽度，等价于不做任何放大）。
 */
export function fitColumnWidth(
  texts: readonly string[],
  measure: (text: string) => number,
  spec: FitSpec,
): number {
  let widest = 0;
  for (const raw of texts) {
    const text = raw == null ? '' : String(raw);
    if (!text) continue;
    const width = measure(text);
    if (Number.isFinite(width) && width > widest) widest = width;
  }
  return clampWidth(widest + spec.pad, spec.min, spec.max);
}

/**
 * 一次算好若干列。没有样本（列表为空或该列被隐藏）的列不出现在返回值里，
 * 表示「保持当前宽度不动」，避免把隐藏列写成 min。
 */
export function fitWidths(
  samples: Readonly<Partial<Record<string, readonly string[]>>>,
  measure: (text: string) => number,
  specs: Readonly<Record<string, FitSpec>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(specs)) {
    const texts = samples[key];
    if (!texts || texts.length === 0) continue;
    out[key] = fitColumnWidth(texts, measure, specs[key]);
  }
  return out;
}
