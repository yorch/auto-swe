/**
 * Chart colours, drawn from the one checked copy of the design tokens.
 *
 * Recharts hands several of these to SVG presentation attributes, which do not
 * resolve `var()` — see `lib/palette.ts`.
 */
import { TOKEN } from '@/lib/palette';

export const STATUS_CHART_COLORS: Record<string, string> = {
  AWAITING_CI: TOKEN.amber400,
  AWAITING_HUMAN_MERGE: TOKEN.ember400,
  COMPLETED: TOKEN.moss400,
  FAILED: TOKEN.brick400,
  IMPLEMENTING: TOKEN.ember400,
  IN_REVIEW: TOKEN.violet400,
  RUNNING: TOKEN.dust400,
  TIMED_OUT: TOKEN.paper500,
  VALIDATING_CONTEXT: TOKEN.ember300,
};

/** Generic palette for charts that aren't status-based. */
export const CHART_PALETTE = [
  TOKEN.ember400,
  TOKEN.dust400,
  TOKEN.moss400,
  TOKEN.amber400,
  TOKEN.violet400,
  TOKEN.ember300,
  TOKEN.brick400,
  TOKEN.dust600,
  TOKEN.paper300,
  TOKEN.paper500,
];

/** Colors used for the stacked area / workflow-over-time chart. */
export const TREND_COLORS = {
  active: TOKEN.ember400,
  completed: TOKEN.moss400,
  failed: TOKEN.brick400,
} as const;
