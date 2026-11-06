/**
 * 拖放提示状态机。
 *
 * 只有「真正携带文件」的拖拽才会点亮遮罩：`enter` 必须带路径，`over` 只有在已点亮的
 * 拖拽里才维持状态（Windows WebView2 会把页面内部的拖拽也送进原生 drop target，
 * 这类事件没有文件路径，不能点亮）。
 * `leave` 不立即收起，而是进入 160ms 宽限期，跨子元素边界的抖动会被随后的 `enter`/`over` 抵消。
 */

export type DropSignal =
  | { kind: 'enter'; files: number }
  | { kind: 'over' }
  | { kind: 'leave' }
  | { kind: 'drop'; files: number }
  | { kind: 'cancel' };

export type DropState =
  | { status: 'idle' }
  | { status: 'active' }
  | { status: 'leaving'; since: number };

/** WebView2 子元素边界抖动宽限期（毫秒）。 */
export const LEAVE_GRACE_MS = 160;

export function dropReduce(state: DropState, signal: DropSignal, now: number): DropState {
  switch (signal.kind) {
    case 'enter':
      // 非文件拖拽（选中文字、拖拽页面元素）没有路径：不点亮，也不打断进行中的状态
      if (signal.files <= 0) return state;
      return { status: 'active' };
    case 'over':
      // 没有真实 enter 的 over 一律忽略——这正是「只是移动鼠标就弹提示」的根因
      if (state.status === 'idle') return state;
      if (state.status === 'leaving') {
        return now - state.since < LEAVE_GRACE_MS ? { status: 'active' } : { status: 'idle' };
      }
      return state;
    case 'leave':
      if (state.status === 'active') return { status: 'leaving', since: now };
      return state;
    case 'drop':
    case 'cancel':
      return { status: 'idle' };
    default:
      return state;
  }
}

export function dropVisible(state: DropState, now: number): boolean {
  if (state.status === 'active') return true;
  if (state.status === 'leaving') return now - state.since < LEAVE_GRACE_MS;
  return false;
}

/** DOM 拖拽的进入/离开计数，保证子元素边界上的 dragleave 不会把计数减成负数。 */
export function domDepthAfter(current: number, delta: 1 | -1): number {
  const next = current + delta;
  return next < 0 ? 0 : next;
}
