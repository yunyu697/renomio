/**
 * 拖拽的几何计算：全部是纯函数，便于单独验证。
 * 输入统一用「列表内容坐标」（已减去滚动容器顶部、加上 scrollTop）。
 */

/** 指针 Y → 插入槽位 0..count（槽位 n 表示追加到末尾）。 */
export function slotForPoint(count: number, y: number, rowH: number): number {
  if (count <= 0) return 0;
  if (y <= 0) return 0;
  const slot = Math.round(y / rowH);
  return Math.max(0, Math.min(count, slot));
}

/**
 * 落点落在被拖块内部时收敛到块的起始或结束位置：
 * 块内插入是空操作，必须让指示线停在块两侧。
 */
export function clampSlotOutsideBlock(slot: number, start: number, end: number): number {
  if (slot > start && slot < end) {
    return slot * 2 <= start + end ? start : end;
  }
  return slot;
}

/** 边缘自动滚动速度（px/帧）：距离边缘越近越快，离开感应区为 0。 */
export function edgeScrollSpeed(distance: number, zone: number, max: number): number {
  if (distance >= zone) return 0;
  const clamped = Math.max(0, distance);
  return Math.max(1, Math.ceil(((zone - clamped) / zone) * max));
}
