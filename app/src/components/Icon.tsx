import type { CSSProperties } from 'react';

export type IconName =
  | 'mark' | 'file-plus' | 'folder-plus' | 'folder' | 'image' | 'pdf' | 'text' | 'music'
  | 'doc' | 'video' | 'file' | 'search' | 'filter' | 'undo' | 'play' | 'check' | 'alert'
  | 'info' | 'clock' | 'shield' | 'eye' | 'trash' | 'refresh' | 'minus' | 'maximize' | 'x'
  | 'chevron-down' | 'chevron-right' | 'chevron-up' | 'history' | 'settings' | 'layers'
  | 'tag' | 'bolt' | 'grid' | 'save' | 'import' | 'help' | 'sort' | 'lock' | 'ban' | 'plus'
  | 'arrow-up' | 'arrow-down' | 'drag' | 'menu' | 'rules';

const PATHS: Record<IconName, string> = {
  mark: 'M4 7a3 3 0 0 1 3-3h7l4 4v9a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z M14 4v4h4 M8 15h6m0 0-2.2-2.2m2.2 2.2-2.2 2.2',
  'file-plus': 'M5 6a2 2 0 0 1 2-2h6l4 4v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z M13 4v4h4M12 12v5m-2.5-2.5h5',
  'folder-plus': 'M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2.2 2.5H18a2.5 2.5 0 0 1 2.5 2.5v6A2.5 2.5 0 0 1 18 18.5H6A2.5 2.5 0 0 1 3.5 16z M11.5 10.5v5m-2.5-2.5h5',
  folder: 'M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2.2 2.5H18a2.5 2.5 0 0 1 2.5 2.5v6A2.5 2.5 0 0 1 18 18.5H6A2.5 2.5 0 0 1 3.5 16z',
  image: 'M4 5h16v14H4z M9 10.5a1.6 1.6 0 1 0 0-3.2a1.6 1.6 0 0 0 0 3.2 M6 17l4.2-4 3 2.6 3-3 5 4.4',
  pdf: 'M6 3.5h7l5 5v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 20.5v-15A1.5 1.5 0 0 1 6 3.5z M13 3.5v5h5M8 14h8M8 17h5',
  text: 'M6 3.5h7l5 5v12A1.5 1.5 0 0 1 16.5 22H6A1.5 1.5 0 0 1 4.5 20.5v-15A1.5 1.5 0 0 1 6 3.5z M13 3.5v5h5M8 12h8M8 15.5h8M8 19h5',
  music: 'M9 17.5V6l9-1.5v11 M4.5 17.5a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 0 0-4.6 0 M13.5 15.5a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 0 0-4.6 0',
  doc: 'M6 3.5h7l5 5v12A1.5 1.5 0 0 1 16.5 22H6A1.5 1.5 0 0 1 4.5 20.5v-15A1.5 1.5 0 0 1 6 3.5z M13 3.5v5h5M8 13.5h8M8 17h6',
  video: 'M4 6.5h11v11H4z M15 10l5-2.5v9L15 14',
  file: 'M6 3.5h7l5 5v12A1.5 1.5 0 0 1 16.5 22H6A1.5 1.5 0 0 1 4.5 20.5v-15A1.5 1.5 0 0 1 6 3.5z M13 3.5v5h5',
  search: 'M10.5 5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 0 0 0-11 M15.2 15.2l4 4',
  filter: 'M4 6h16l-6.2 7.2v6.3l-3.6-1.8v-4.5z',
  undo: 'M4.5 9H14a5.5 5.5 0 0 1 0 11H8 M8 4.5l-4 4.5 4 4.5',
  play: 'M8 5.8v12.4L18.5 12z',
  check: 'M5 12.5l4.5 4.5L19 6.5',
  alert: 'M12 4.5L21 20H3z M12 9.5v5 M12 16.4a.9.9 0 1 0 0 1.8a.9.9 0 0 0 0-1.8',
  info: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17 M12 11.2v5 M12 7.3a.9.9 0 1 0 0 1.8a.9.9 0 0 0 0-1.8',
  clock: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17 M12 7.5v5l3.2 2',
  shield: 'M12 3.5L19 6v6c0 4.2-3 6.9-7 8.4-4-1.5-7-4.2-7-8.4V6z M9 12l2.2 2.2 4-4.2',
  eye: 'M3.5 12S6.7 6.5 12 6.5 20.5 12 20.5 12 17.3 17.5 12 17.5 3.5 12 3.5 12z M12 9.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 0 0 0-4.4',
  trash: 'M5 7h14M9 7V5.2A1.2 1.2 0 0 1 10.2 4h3.6A1.2 1.2 0 0 1 15 5.2V7M6.5 7l.8 12.1A1.9 1.9 0 0 0 9.2 21h5.6a1.9 1.9 0 0 0 1.9-1.9L17.5 7',
  refresh: 'M19 12a7 7 0 1 1-2.2-5.1 M19 4.5v4.2h-4.2',
  minus: 'M6 12h12',
  maximize: 'M5.5 5.5h13v13h-13z',
  x: 'M7 7l10 10M17 7L7 17',
  'chevron-down': 'M6.5 9.5l5.5 5.5 5.5-5.5',
  'chevron-right': 'M9.5 6.5L15 12l-5.5 5.5',
  'chevron-up': 'M6.5 14.5L12 9l5.5 5.5',
  history: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3 M4.5 5v4.5H9 M12 8v4.5l3 1.8',
  settings: 'M12 8.8a3.2 3.2 0 1 0 0 6.4a3.2 3.2 0 0 0 0-6.4 M19 12a7 7 0 0 0-.1-1.2l1.9-1.4-2-3.4-2.2.9a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.3a7 7 0 0 0-2 1.2l-2.2-.9-2 3.4L5.5 10.8a7 7 0 0 0 0 2.4L3.6 14.6l2 3.4 2.2-.9a7 7 0 0 0 2 1.2L10.2 21h4l.4-2.3a7 7 0 0 0 2-1.2l2.2.9 2-3.4-1.9-1.4c.1-.4.1-.8.1-1.2',
  layers: 'M4 8l8-4 8 4-8 4z M4 12l8 4 8-4 M4 16l8 4 8-4',
  tag: 'M4 4h7l9 9-7 7-9-9z M8 8h.01',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
  grid: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  save: 'M5 4h11l3 3v13H5z M8 4v5h7V4 M8 15h8',
  import: 'M12 4v10 M8 10l4 4 4-4 M5 19h14',
  help: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17 M9.5 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.7-.9 1.3 M12 16.4a.9.9 0 1 0 0 1.8a.9.9 0 0 0 0-1.8',
  sort: 'M7 4v16 M4 17l3 3 3-3 M14 8h6 M14 12h4 M14 16h2',
  lock: 'M5 10.5h14v9.5H5z M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5 M12 14.3a1.1 1.1 0 1 0 0 2.2a1.1 1.1 0 0 0 0-2.2',
  ban: 'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17 M6.2 6.2l11.6 11.6',
  plus: 'M12 6v12M6 12h12',
  'arrow-up': 'M12 19V5 M6 11l6-6 6 6',
  'arrow-down': 'M12 5v14 M6 13l6 6 6-6',
  drag: 'M9 6h1 M14 6h1 M9 12h1 M14 12h1 M9 18h1 M14 18h1',
  menu: 'M4 7h16 M4 12h16 M4 17h16',
  rules: 'M4 6h16 M4 11h16 M4 16h10 M7 4v4 M7 9v4 M7 14v4',
};

export function Icon({
  name, size = 16, className, style, strokeWidth = 1.7,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      style={style}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
