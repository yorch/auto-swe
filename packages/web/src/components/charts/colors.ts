/**
 * Chart colours, drawn from the one checked copy of the design tokens.
 *
 * `STATUS_CHART_COLORS` mirrors the text colour of each status in
 * `STATUS_META` (lib/utils.ts), so a slice matches the StatusBadge beside it.
 *
 * Recharts hands several of these to SVG presentation attributes, which do not
 * resolve `var()` — see `lib/palette.ts`.
 */
import { TOKEN, TOKEN_LIGHT, type Tokens } from '@/lib/palette';

export function statusChartColors(t: Tokens): Record<string, string> {
  return {
    AWAITING_CI: t.amber400,
    AWAITING_HUMAN_MERGE: t.amber400,
    COMPLETED: t.moss400,
    FAILED: t.brick400,
    IMPLEMENTING: t.ember400,
    IN_REVIEW: t.violet400,
    RUNNING: t.dust400,
    TIMED_OUT: t.paper500,
    VALIDATING_CONTEXT: t.ember400,
  };
}

/** The dark theme's status colours; `statusChartColors(useTokens())` follows the theme. */
export const STATUS_CHART_COLORS = statusChartColors(TOKEN);

/**
 * Categorical series colours, in the order they are assigned. An Okabe-Ito
 * derived set lightened for the dark chart background: the first two (sky blue,
 * orange) are far apart in lightness and hue for every common form of colour
 * blindness, and no status red/green pair sits in here — status colours are
 * `STATUS_CHART_COLORS`, a separate vocabulary. `colors.test.ts` checks that no
 * two entries are near-duplicates (also under a deuteranopia simulation) and
 * that each reads against the background.
 */
export const CHART_PALETTE = [
  '#56b4e9', // sky blue
  '#e69f00', // orange
  '#3cc79a', // bluish green
  '#cc79a7', // reddish purple
  '#f0e442', // yellow
  '#8f8cff', // periwinkle
  '#ff7f50', // vermillion
] as const;

/**
 * The same seven roles darkened for the light chart background: each keeps its
 * hue family and order, and reads at 4.5:1 or better on white. Checked by
 * `colors.test.ts` exactly like `CHART_PALETTE`.
 */
export const CHART_PALETTE_LIGHT = [
  '#3270ae', // blue
  '#954c04', // orange
  '#037754', // bluish green
  '#9e2e71', // reddish purple
  '#675f1e', // olive (yellow's light-theme stand-in)
  '#0646db', // ultramarine
  '#db3006', // vermillion
] as const;

/** The neutral colour for the merged "Other" series. */
export const CHART_OTHER_COLOR = TOKEN.paper500;

/**
 * Dash patterns paired with `CHART_PALETTE` by index, so a line is still
 * distinguishable when colour is not (print, colour blindness, similar hues).
 */
export const CHART_DASHES: (string | undefined)[] = [
  undefined,
  '6 3',
  '2 3',
  '8 3 2 3',
  '1 4',
  '10 4',
  '4 2 1 2',
];

export const OTHER_LABEL = 'Other';

/** A series colour by position; the merged "Other" series is always neutral. */
export function seriesColor(
  index: number,
  label?: string,
  theme: 'dark' | 'light' = 'dark'
): string {
  if (label === OTHER_LABEL) {
    return theme === 'light' ? TOKEN_LIGHT.paper500 : CHART_OTHER_COLOR;
  }
  const palette = theme === 'light' ? CHART_PALETTE_LIGHT : CHART_PALETTE;
  return palette[index % palette.length];
}

export function seriesDash(index: number, label?: string): string | undefined {
  if (label === OTHER_LABEL) {
    return '3 3';
  }
  return CHART_DASHES[index % CHART_DASHES.length];
}

/**
 * Keeps the `max` largest items (by `weight`, descending) and folds the rest
 * into one "Other" item built by `merge`, so a chart never needs more colours
 * than the palette holds. Returns the input untouched when it already fits.
 */
export function topNWithOther<T>(
  items: T[],
  max: number,
  weight: (item: T) => number,
  merge: (rest: T[]) => T
): T[] {
  if (items.length <= max) {
    return items;
  }
  const sorted = [...items].sort((a, b) => weight(b) - weight(a));
  return [...sorted.slice(0, max - 1), merge(sorted.slice(max - 1))];
}

/** Colors used for the stacked area / workflow-over-time chart. */
export function trendColors(t: Tokens) {
  return { active: t.ember400, completed: t.moss400, failed: t.brick400 } as const;
}

export const TREND_COLORS = trendColors(TOKEN);
