/** Hex colors for Recharts, aligned with the Conductor Platform palette in globals.css. */
export const STATUS_CHART_COLORS: Record<string, string> = {
  AWAITING_CI: '#f6b545', // amber-400 (unchanged)
  AWAITING_HUMAN_MERGE: '#7c6cff', // ember-400 = violet
  COMPLETED: '#46d28a', // moss-400 = green
  FAILED: '#ff7a7a', // brick-400 = bright red
  IMPLEMENTING: '#7c6cff', // ember-400 = violet
  IN_REVIEW: '#34d8c0', // violet-400 = teal
  RUNNING: '#4d8dff', // dust-400 = bright blue
  TIMED_OUT: '#6f7990', // paper-500
  VALIDATING_CONTEXT: '#9b8fff', // ember-300 = violet-soft
};

/** Generic palette for charts that aren't status-based. */
export const CHART_PALETTE = [
  '#7c6cff', // ember-400 = violet
  '#4d8dff', // dust-400 = blue
  '#46d28a', // moss-400 = green
  '#f6b545', // amber-400
  '#34d8c0', // violet-400 = teal
  '#9b8fff', // ember-300 = violet-soft
  '#ff7a7a', // brick-400 = red
  '#2d6acc', // dust-600
  '#aeb6c9', // paper-300
  '#6f7990', // paper-500
];

/** Colors used for the stacked area / workflow-over-time chart. */
export const TREND_COLORS = {
  active: '#7c6cff', // violet
  completed: '#46d28a', // green
  failed: '#ff7a7a', // red
} as const;
