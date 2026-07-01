/** Shared Recharts styling tokens for the Workshop Telemetry palette. */
import type { ComponentProps } from 'react';
import { Tooltip } from 'recharts';

export const AXIS_TICK = {
  fill: '#a8a395', // paper-400
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
};

export const AXIS_LINE = {
  stroke: '#2a323f', // ink-500
};

export const GRID_STROKE = '#1f2530'; // ink-600

/** Shared axisLine/tick/tickLine props for a value (numeric) axis. */
export const AXIS_COMMON_PROPS = {
  axisLine: AXIS_LINE,
  tick: AXIS_TICK,
  tickLine: AXIS_LINE,
};

export const TOOLTIP_CURSOR_FILL = '#171c26'; // ink-700

export const CHART_HEIGHT = 280;

/** Formats a `YYYY-MM-DD` date label as e.g. "3 Jun" for axis ticks/tooltips. */
export function formatDateLabel(label: unknown) {
  const d = new Date(`${String(label)}T00:00:00`);
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}

export const TOOLTIP_STYLE: React.CSSProperties = {
  background: '#0b0e13', // ink-900
  border: '1px solid #2a323f', // ink-500
  borderRadius: 2,
  color: '#f2ede2', // paper-200
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.04em',
  padding: '8px 10px',
};

export const TOOLTIP_LABEL_STYLE: React.CSSProperties = {
  color: '#a8a395', // paper-400
  fontSize: 10,
  letterSpacing: '0.14em',
  marginBottom: 4,
  textTransform: 'uppercase',
};

export const TOOLTIP_ITEM_STYLE: React.CSSProperties = {
  color: '#f2ede2', // paper-200
};

export const LEGEND_STYLE: React.CSSProperties = {
  color: '#a8a395', // paper-400
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
};

/** Tooltip with the shared Workshop Telemetry content/item/label styling baked in. */
export function ChartTooltip(
  props: Omit<ComponentProps<typeof Tooltip>, 'contentStyle' | 'itemStyle' | 'labelStyle'>
) {
  return (
    <Tooltip
      contentStyle={TOOLTIP_STYLE}
      itemStyle={TOOLTIP_ITEM_STYLE}
      labelStyle={TOOLTIP_LABEL_STYLE}
      {...props}
    />
  );
}

export function EmptyChart({ label = 'no data' }: { label?: string }) {
  return (
    <div className="flex h-[200px] items-center justify-center font-mono text-[11px] uppercase tracking-[0.18em] text-paper-500">
      <span>— {label} —</span>
    </div>
  );
}
