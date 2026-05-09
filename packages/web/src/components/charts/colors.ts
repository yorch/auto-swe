/** Hex colors for Recharts, aligned with the Tailwind STATUS_COLORS palette. */
export const STATUS_CHART_COLORS: Record<string, string> = {
  VALIDATING_CONTEXT: '#818cf8', // indigo-400
  IMPLEMENTING: '#60a5fa', // blue-400
  IN_REVIEW: '#a78bfa', // purple-400
  AWAITING_CI: '#facc15', // yellow-400
  AWAITING_HUMAN_MERGE: '#fb923c', // orange-400
  COMPLETED: '#4ade80', // green-400
  FAILED: '#f87171', // red-400
  TIMED_OUT: '#9ca3af', // gray-400
};

/** Generic palette for charts that aren't status-based. */
export const CHART_PALETTE = [
  '#6366f1', // indigo-500
  '#3b82f6', // blue-500
  '#8b5cf6', // purple-500
  '#ec4899', // pink-500
  '#14b8a6', // teal-500
  '#f97316', // orange-500
  '#eab308', // yellow-500
  '#22c55e', // green-500
  '#ef4444', // red-500
  '#64748b', // slate-500
];

/** Colors used for the stacked area / workflow-over-time chart. */
export const TREND_COLORS = {
  completed: '#4ade80', // green-400
  failed: '#f87171', // red-400
  active: '#60a5fa', // blue-400
} as const;
