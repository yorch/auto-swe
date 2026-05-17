/** Hex colors for Recharts, aligned with the Workshop Telemetry palette in globals.css. */
export const STATUS_CHART_COLORS: Record<string, string> = {
  AWAITING_CI: '#d4a547', // amber-400
  AWAITING_HUMAN_MERGE: '#e26b3c', // ember-400
  COMPLETED: '#7ea67a', // moss-400
  FAILED: '#c44a4a', // brick-400
  IMPLEMENTING: '#e26b3c', // ember-400
  IN_REVIEW: '#9b8bc4', // violet-400
  RUNNING: '#85a6c5', // dust-400
  TIMED_OUT: '#7a766c', // paper-500
  VALIDATING_CONTEXT: '#e89968', // ember-300
};

/** Generic palette for charts that aren't status-based. */
export const CHART_PALETTE = [
  '#e26b3c', // ember-400 (primary accent)
  '#85a6c5', // dust-400
  '#7ea67a', // moss-400
  '#d4a547', // amber-400
  '#9b8bc4', // violet-400
  '#e89968', // ember-300
  '#c44a4a', // brick-400
  '#4d6c8a', // dust-600
  '#d9d3c4', // paper-300
  '#7a766c', // paper-500
];

/** Colors used for the stacked area / workflow-over-time chart. */
export const TREND_COLORS = {
  active: '#e26b3c', // ember-400
  completed: '#7ea67a', // moss-400
  failed: '#c44a4a', // brick-400
} as const;
