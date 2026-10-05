/**
 * Chart colours, drawn from the one checked copy of the design tokens.
 *
 * `STATUS_CHART_COLORS` mirrors the text colour of each status in
 * `STATUS_META` (lib/utils.ts), so a slice matches the StatusBadge beside it.
 *
 * Recharts hands several of these to SVG presentation attributes, which do not
 * resolve `var()` — see `lib/palette.ts`.
 */
import { TOKEN } from '@/lib/palette';

export const STATUS_CHART_COLORS: Record<string, string> = {
  AWAITING_CI: TOKEN.amber400,
  AWAITING_HUMAN_MERGE: TOKEN.amber400,
  COMPLETED: TOKEN.moss400,
  FAILED: TOKEN.brick400,
  IMPLEMENTING: TOKEN.ember400,
  IN_REVIEW: TOKEN.violet400,
  RUNNING: TOKEN.dust400,
  TIMED_OUT: TOKEN.paper500,
  VALIDATING_CONTEXT: TOKEN.ember400,
};

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
export function seriesColor(index: number, label?: string): string {
  if (label === OTHER_LABEL) {
    return CHART_OTHER_COLOR;
  }
  return CHART_PALETTE[index % CHART_PALETTE.length];
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
export const TREND_COLORS = {
  active: TOKEN.ember400,
  completed: TOKEN.moss400,
  failed: TOKEN.brick400,
} as const;
