/**
 * Shared class strings for the run layouts' panel chrome, so every pane — graph,
 * console, steps, timing, feed — titles itself the same way. Written out in full
 * because Tailwind finds classes by scanning source text.
 */

/** A pane's title bar: a title on the left, meta and controls after it. */
export const PANEL_BAR =
  'flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-ink-600/40 px-4 py-2.5 lg:px-5';

/** A pane's title. */
export const PANEL_TITLE = 'text-[13px] font-semibold text-paper-100';

/** Counts and hints beside a pane's title. */
export const PANEL_META = 'tabular text-xs text-paper-500';
