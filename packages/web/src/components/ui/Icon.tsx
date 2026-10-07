import { cn } from '@/lib/utils';

/**
 * The app's stroke icon set: every navigation, action and status glyph, drawn on a
 * 24×24 grid with `currentColor`, so an icon picks up the colour of the text it
 * sits in. There is no icon library — add a path here rather than pasting a raw
 * `<svg>` into a page.
 */
export const ICON_PATHS = {
  admin: 'M12 9a3 3 0 100 6 3 3 0 000-6zM5 12l-2 1 2 3 2-1M19 12l2 1-2 3-2-1M12 5V3M12 21v-2',
  agents:
    'M12 3a3.5 3.5 0 013.5 3.5V8a3.5 3.5 0 01-7 0V6.5A3.5 3.5 0 0112 3zM5 21v-1a7 7 0 0114 0v1',
  alert:
    'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  analytics: 'M4 20V10M10 20V4M16 20v-7M22 20H2',

  // ── Action and status glyphs ──
  arrowDown: 'M12 5v14M19 12l-7 7-7-7',
  arrowLeft: 'M19 12H5M12 19l-7-7 7-7',
  arrowRight: 'M5 12h14M12 5l7 7-7 7',
  arrowUp: 'M12 19V5M5 12l7-7 7 7',
  branch: 'M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9',
  building:
    'M4 21V4a1 1 0 011-1h9a1 1 0 011 1v17M15 9h4a1 1 0 011 1v11M3 21h18M8 7h3M8 11h3M8 15h3',
  canvas: 'M4 7h7M4 12h16M13 17h7',
  chat: 'M21 12a8 8 0 01-11.7 7.1L4 20l1-4.6A8 8 0 1121 12z',
  check: 'M20 6L9 17l-5-5',
  checkCircle: 'M22 11.1V12a10 10 0 11-5.9-9.1M22 4L12 14l-3-3',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 18l6-6-6-6',
  clock: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  close: 'M18 6L6 18M6 6l12 12',
  coin: 'M12 3a9 9 0 100 18 9 9 0 000-18zM14.8 9.2c-.5-.8-1.5-1.2-2.8-1.2-1.5 0-2.6.7-2.6 1.8 0 2.5 5.4 1.2 5.4 3.9 0 1.2-1.2 2-2.8 2-1.3 0-2.4-.5-3-1.4M12 6.5V8M12 16v1.5',
  command: 'M18 3a3 3 0 00-3 3v12a3 3 0 103-3H6a3 3 0 103 3V6a3 3 0 10-3 3h12a3 3 0 000-6z',
  connections: 'M9 15l6-6M10 6l1-1a4 4 0 016 6l-1 1M14 18l-1 1a4 4 0 01-6-6l1-1',
  copy: 'M9 9h11a1 1 0 011 1v11a1 1 0 01-1 1H9a1 1 0 01-1-1V10a1 1 0 011-1zM5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1',
  dashboard: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  docs: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2',
  download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z',
  empty: 'M3 13l2-7h14l2 7M3 13v6h18v-6M3 13h5l1 2h6l1-2h5',
  epics:
    'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M12 12v4M12 12l-2-2M12 12l2-2',
  error: 'M12 2a10 10 0 100 20 10 10 0 000-20zM15 9l-6 6M9 9l6 6',
  external: 'M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3',
  filter: 'M22 3H2l8 9.5V19l4 2v-8.5L22 3z',
  flask: 'M9 3h6M10 3v6L4.5 19a1.5 1.5 0 001.3 2.2h12.4a1.5 1.5 0 001.3-2.2L14 9V3M7.5 15h9',
  gavel: 'M14 13l-8.5 8.5a2.1 2.1 0 01-3-3L11 10M16 16l6-6M8 8l6-6M9 7l8 8M21 11l-8-8',
  github:
    'M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 00-1.3-3.2 4.2 4.2 0 00-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 00-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 00-.1 3.2A4.6 4.6 0 004 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  inbox: 'M3 13l2-7h14l2 7M3 13v6h18v-6M3 13h5l1 2h6l1-2h5',
  info: 'M12 2a10 10 0 100 20 10 10 0 000-20zM12 16v-4M12 8h.01',
  key: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  layers: 'M12 2l10 5-10 5L2 7l10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  lock: 'M6 11h12a1 1 0 011 1v8a1 1 0 01-1 1H6a1 1 0 01-1-1v-8a1 1 0 011-1zM8 11V7a4 4 0 118 0v4',
  maximize: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  memory:
    'M12 3c4 0 8 1.3 8 3v12c0 1.7-4 3-8 3s-8-1.3-8-3V6c0-1.7 4-3 8-3zM4 6c0 1.7 4 3 8 3s8-1.3 8-3M4 12c0 1.7 4 3 8 3s8-1.3 8-3',
  monitor: 'M3 5h18a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V6a1 1 0 011-1zM8 21h8M12 17v4',
  more: 'M12 12h.01M19 12h.01M5 12h.01',
  package: 'M21 8l-9-5-9 5v8l9 5 9-5V8zM3.3 7.5L12 12.5l8.7-5M12 22V12.5',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  play: 'M6 4l14 8-14 8V4z',
  plug: 'M9 2v6M15 2v6M6 8h12v4a6 6 0 01-12 0V8zM12 18v4',
  plus: 'M12 5v14M5 12h14',
  pullRequest:
    'M6 3a2 2 0 100 4 2 2 0 000-4zM6 17a2 2 0 100 4 2 2 0 000-4zM18 17a2 2 0 100 4 2 2 0 000-4zM6 7v10M18 17V9a2 2 0 00-2-2h-3m0 0l2-2m-2 2l2 2',
  puzzle:
    'M19.4 7.9c0 .3.1.6.3.9l1.6 1.6a2.4 2.4 0 010 3.4l-1.6 1.6a1 1 0 01-.8.3c-.5-.1-.8-.5-1-.9a2.5 2.5 0 10-3.2 3.2c.4.2.9.5.9 1a1 1 0 01-.3.8l-1.6 1.6a2.4 2.4 0 01-3.4 0l-1.6-1.6a1 1 0 00-.9-.3c-.5.1-.8.5-1 1a2.5 2.5 0 11-3.2-3.3c.5-.2.9-.5 1-1a1 1 0 00-.3-.9l-1.6-1.6a2.4 2.4 0 010-3.4l1.5-1.5c.3-.3.6-.4.9-.3.5.1.9.5 1.1 1a2.5 2.5 0 103.3-3.3c-.5-.2-.9-.6-1-1.1 0-.3.1-.7.3-.9l1.5-1.5a2.4 2.4 0 013.4 0l1.6 1.6c.2.2.6.3.9.3.5-.1.8-.5 1-1a2.5 2.5 0 113.2 3.2c-.5.2-.9.5-1 1z',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15',
  repositories: 'M9 15l6-6M10 6l1-1a4 4 0 016 6l-1 1M14 18l-1 1a4 4 0 01-6-6l1-1',
  repository:
    'M4 19.5A2.5 2.5 0 016.5 17H20V2H6.5A2.5 2.5 0 004 4.5v15zM4 19.5A2.5 2.5 0 006.5 22H20v-5M9 6h7',
  runs: 'M3 12h4l3 8 4-16 3 8h4',
  scan: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5M8 11h6M11 8v6',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-4.35-4.35',
  security: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z',
  settings:
    'M12 9a3 3 0 100 6 3 3 0 000-6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z',
  skills: 'M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.3L12 15.3 7.2 17.8l.9-5.3L4.2 8.7l5.4-.8z',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  swap: 'M7 16V4M3 8l4-4 4 4M17 8v12M21 16l-4 4-4-4',
  target:
    'M12 3a9 9 0 100 18 9 9 0 000-18zM12 8a4 4 0 100 8 4 4 0 000-8zM12 11.5a.5.5 0 100 1 .5.5 0 000-1z',
  teams:
    'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
  templates: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5',
  ticket:
    'M3 9V7a2 2 0 012-2h14a2 2 0 012 2v2a2 2 0 000 4v2a2 2 0 01-2 2H5a2 2 0 01-2-2v-2a2 2 0 000-4zM14 5v14',
  trash:
    'M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6',
  users: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z',
  warning:
    'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  workflows: 'M4 7h7M4 12h16M13 17h7',
} as const satisfies Record<string, string>;

export type IconName = keyof typeof ICON_PATHS;

export function isIconName(name: string): name is IconName {
  return Object.hasOwn(ICON_PATHS, name);
}

/** A stroke icon. Decorative (`aria-hidden`): name the control it sits in, not the icon. */
export function Icon({
  className,
  name,
  size = 16,
  strokeWidth = 1.8,
}: {
  className?: string;
  name: IconName;
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      aria-hidden="true"
      className={cn('shrink-0', className)}
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      viewBox="0 0 24 24"
      width={size}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
