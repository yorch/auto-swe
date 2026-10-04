'use client';

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AXIS_COMMON_PROPS,
  CHART_HEIGHT,
  ChartTooltip,
  EmptyChart,
  formatDateLabel,
  GRID_STROKE,
  LEGEND_STYLE,
} from './chartChrome';
import { CHART_PALETTE } from './colors';

export interface BreakdownSeries {
  label: string;
  /** One row per UTC day, oldest first; `mean` is null on a day with no signal. */
  daily: { date: string; mean: number | null; n: number }[];
}

/** One row per day with a column per series label, so Recharts can draw them together. */
export function pivotSeries(series: BreakdownSeries[]): Record<string, string | number | null>[] {
  const rows = new Map<string, Record<string, string | number | null>>();
  for (const s of series) {
    for (const d of s.daily) {
      const row = rows.get(d.date) ?? { date: d.date };
      row[s.label] = d.mean;
      rows.set(d.date, row);
    }
  }
  return [...rows.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/**
 * One scorer's daily mean score (0..1), one line per breakdown value. More than
 * one series, so there is a legend. A day without signals is a gap, not a zero.
 */
export function ScorerBreakdownChart({ series }: { series: BreakdownSeries[] }) {
  if (series.every((s) => s.daily.every((d) => d.n === 0))) {
    return <EmptyChart label="no signals in this window" />;
  }

  return (
    <ResponsiveContainer height={CHART_HEIGHT} width="100%">
      <LineChart data={pivotSeries(series)}>
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="2 4" vertical={false} />
        <XAxis
          dataKey="date"
          interval="preserveStartEnd"
          tickFormatter={formatDateLabel}
          {...AXIS_COMMON_PROPS}
        />
        <YAxis domain={[0, 1]} tickCount={5} {...AXIS_COMMON_PROPS} />
        <ChartTooltip
          formatter={(value) => Number(value).toFixed(2)}
          labelFormatter={(label) => `${formatDateLabel(label)} (UTC)`}
        />
        <Legend wrapperStyle={LEGEND_STYLE} />
        {series.map((s, i) => (
          <Line
            connectNulls={false}
            dataKey={s.label}
            dot={{ r: 2.5 }}
            isAnimationActive={false}
            key={s.label}
            stroke={CHART_PALETTE[i % CHART_PALETTE.length]}
            strokeWidth={1.5}
            type="monotone"
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
