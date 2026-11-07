/** 可自定义的全局快捷键：录制、规范化、匹配与冲突检测。
 *
 * 绑定统一存成 `Ctrl+Shift+K` 形式（修饰键顺序固定，字母大写）；
 * 匹配时不区分大小写，macOS 的 ⌘ 与 Ctrl 等价。
 * 为避免打字时误触，录制必须至少包含 Ctrl 或 Alt。
 */

export type ShortcutId = 'search' | 'addFiles' | 'addFolder' | 'preview' | 'undo';

export const SHORTCUT_IDS: ShortcutId[] = ['search', 'addFiles', 'addFolder', 'preview', 'undo'];

export const DEFAULT_SHORTCUTS: Record<ShortcutId, string> = {
  search: 'Ctrl+K',
  addFiles: 'Ctrl+O',
  addFolder: 'Ctrl+Shift+O',
  preview: 'Ctrl+Enter',
  undo: 'Ctrl+Z',
};

interface Binding {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

const MODIFIERS = new Set(['ctrl', 'control', 'cmd', 'command', 'meta', 'win', 'alt', 'option', 'shift']);

const KEY_NAMES: Record<string, string> = {
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  esc: 'Escape',
  ' ': 'Space',
};

/** 把按键名规整成统一的写法（letter 大写、方向键 Up/Down/…）。 */
function keyOf(raw: string): string {
  const lower = raw.toLowerCase();
  if (KEY_NAMES[lower]) return KEY_NAMES[lower];
  if (lower.length === 1) return lower.toUpperCase();
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** 解析绑定串；非法（没有主键）返回 null。 */
export function parseBinding(text: string): Binding | null {
  const parts = text.split('+').map((p) => p.trim()).filter(Boolean);
  let ctrl = false;
  let alt = false;
  let shift = false;
  let key = '';
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (MODIFIERS.has(lower)) {
      if (lower === 'ctrl' || lower === 'control' || lower === 'cmd' || lower === 'command' || lower === 'meta' || lower === 'win') ctrl = true;
      else if (lower === 'alt' || lower === 'option') alt = true;
      else shift = true;
      continue;
    }
    key = keyOf(part);
  }
  if (!key) return null;
  return { ctrl, alt, shift, key };
}

/** 规范成持久化/展示用的写法；无法解析时返回空串。 */
export function normalizeBinding(text: string): string {
  const binding = parseBinding(text);
  if (!binding) return '';
  const parts: string[] = [];
  if (binding.ctrl) parts.push('Ctrl');
  if (binding.alt) parts.push('Alt');
  if (binding.shift) parts.push('Shift');
  parts.push(binding.key);
  return parts.join('+');
}

/** 从键盘事件录制绑定；只按修饰键或单独按键时返回 null。 */
export function bindingFromEvent(e: KeyboardEvent): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(keyOf(e.key));
  return parts.join('+');
}

/** 事件是否命中某条绑定（修饰键必须完全一致，⌘ 视同 Ctrl）。 */
export function matchesShortcut(e: KeyboardEvent, binding: string): boolean {
  const parsed = parseBinding(binding);
  if (!parsed) return false;
  // Shift 会把主键字母改变大小写，比较时统一小写
  if (parsed.key.toLowerCase() !== keyOf(e.key).toLowerCase()) return false;
  return (
    (e.ctrlKey || e.metaKey) === parsed.ctrl &&
    e.altKey === parsed.alt &&
    e.shiftKey === parsed.shift
  );
}

/** 返回占用同一组合键的其他命令；无冲突返回 null。 */
export function conflictOf(
  id: ShortcutId,
  binding: string,
  all: Record<ShortcutId, string>,
): ShortcutId | null {
  const target = normalizeBinding(binding);
  if (!target) return null;
  for (const other of SHORTCUT_IDS) {
    if (other !== id && normalizeBinding(all[other] ?? '') === target) return other;
  }
  return null;
}

/** 展示用：在末尾主键外再用「+」分隔，保持与默认值一致。 */
export function displayBinding(binding: string): string {
  return normalizeBinding(binding) || binding;
}
