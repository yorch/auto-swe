/**
 * Where a trace group's header sticks, so it clears the "Filtered to …" bar above it.
 *
 * At desktop width the bar is one fixed row, 33px tall. Below the breakpoint its "Show all"
 * button grows to a touch target and the node chip can wrap, so the bar's real height is
 * measured and published as a CSS variable; the header reads the variable and falls back to
 * the desktop height until it has been measured.
 *
 * The class strings are written out in full (Tailwind finds classes by scanning source text,
 * so they cannot be assembled from the constants); `traceSticky.test.ts` keeps the two in step.
 */
export const FILTER_BAR_DESKTOP_PX = 33;
export const FILTER_BAR_HEIGHT_VAR = '--trace-filter-bar-h';

const WITH_FILTER_BAR = 'top-[var(--trace-filter-bar-h,33px)] lg:top-[33px]';

/** The header's `top` classes: below the bar when one is showing, else the scroller's top. */
export function groupHeaderTop(filterBarShowing: boolean): string {
  return filterBarShowing ? WITH_FILTER_BAR : 'top-0';
}
