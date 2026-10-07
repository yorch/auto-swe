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
  ACTIVE_DOT_PROPS,
  AXIS_COMMON_PROPS,
  axisLabel,
  CHART_HEIGHT,
  ChartFrame,
  type ChartGranularity,
  ChartTooltip,
  chartAriaLabel,
  DOT_PROPS,
  EmptyChart,
  formatDateLabel,
  GRID_PROPS,
  granularityWords,
  LEGEND_STYLE,
  LINE_WIDTH,
  legendText,
} from './chartChrome';
import { CHART_PALETTE, OTHER_LABEL, seriesColor, seriesDash, topNWithOther } from './colors';

export interface BreakdownSeries {
  label: string;
  /** One row per UTC day, oldest first; `mean` is null on a day with no signal. */
  daily: { date: string; mean: number | null; n: number }[];
}

/**
 * The row column for the series at `index`. Labels are data (a real group can be
 * called "date" or "Other"), so columns are keyed by position under a prefix no
 * label can collide with, and the label travels as the line's `name`.
 */
export const seriesKey = (index: number) => `series:${index}`;

/** One row per day with a column per series, so Recharts can draw them together. */
export function pivotSeries(series: BreakdownSeries[]): Record<string, string | number | null>[] {
  const rows = new Map<string, Record<string, string | number | null>>();
  for (const [index, s] of series.entries()) {
    for (const d of s.daily) {
      const row = rows.get(d.date) ?? { date: d.date };
      row[seriesKey(index)] = d.mean;
      rows.set(d.date, row);
    }
  }
  return [...rows.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/**
 * Folds series beyond the palette into one "Other" series: per day, the mean
 * across the folded series weighted by their signal counts.
 */
export function collapseSeries(
  series: BreakdownSeries[],
  max: number = CHART_PALETTE.length
): BreakdownSeries[] {
  const total = (s: BreakdownSeries) => s.daily.reduce((n, d) => n + d.n, 0);
  return topNWithOther(series, max, total, (rest) => {
    const days = new Map<string, { sum: number; n: number }>();
    for (const s of rest) {
      for (const d of s.daily) {
        const acc = days.get(d.date) ?? { n: 0, sum: 0 };
        if (d.mean !== null) {
          acc.sum += d.mean * d.n;
        }
        acc.n += d.n;
        days.set(d.date, acc);
      }
    }
    return {
      daily: [...days.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, { n, sum }]) => ({ date, mean: n > 0 ? sum / n : null, n })),
      label: OTHER_LABEL,
    };
  });
}

/**
 * One scorer's daily mean score (0..1), one line per breakdown value. More than
 * one series, so there is a legend. A day without signals is a gap, not a zero.
 */
export function ScorerBreakdownChart({
  series: allSeries,
  granularity = 'day',
  title,
}: {
  series: BreakdownSeries[];
  /** One point per `day` (default) or per `week` when the gateway buckets a long window. */
  granularity?: ChartGranularity;
  /** Names the chart for assistive tech, e.g. the scorer's name. */
  title?: string;
}) {
  const words = granularityWords(granularity);
  const series = collapseSeries(allSeries);
  if (series.every((s) => s.daily.every((d) => d.n === 0))) {
    return <EmptyChart label="No signals in this window." />;
  }

  const rows = pivotSeries(series);
  const summary = `${words.adjective} mean score from 0 to 1 over ${rows.length} ${words.plural} for ${series.length} groups: ${series
    .map((s) => s.label)
    .join(', ')}.`;

  return (
    <ChartFrame
      ariaLabel={chartAriaLabel(title, 'Scorer breakdown', summary)}
      table={{
        columns: [words.dateColumn, ...series.map((s) => `${s.label} (mean 0–1)`)],
        rows: rows.map((r) => [
          formatDateLabel(r.date),
          ...series.map((_, i) => {
            const v = r[seriesKey(i)];
            return typeof v === 'number' ? v.toFixed(2) : '—';
          }),
        ]),
      }}
    >
      <ResponsiveContainer height={CHART_HEIGHT} width="100%">
        <LineChart accessibilityLayer={false} data={rows}>
          <CartesianGrid {...GRID_PROPS} vertical={false} />
          <XAxis
            dataKey="date"
            interval="preserveStartEnd"
            tickFormatter={formatDateLabel}
            {...AXIS_COMMON_PROPS}
          />
          <YAxis
            domain={[0, 1]}
            label={axisLabel('Mean score (0–1)', true)}
            tickCount={5}
            width={52}
            {...AXIS_COMMON_PROPS}
          />
          <ChartTooltip
            formatter={(value) => Number(value).toFixed(2)}
            labelFormatter={(label) =>
              `${granularity === 'week' ? 'Week of ' : ''}${formatDateLabel(label)} (UTC)`
            }
          />
          <Legend
            formatter={legendText}
            iconSize={14}
            iconType="plainline"
            wrapperStyle={LEGEND_STYLE}
          />
          {series.map((s, i) => (
            <Line
              activeDot={ACTIVE_DOT_PROPS}
              connectNulls={false}
              dataKey={seriesKey(i)}
              dot={DOT_PROPS}
              isAnimationActive={false}
              key={seriesKey(i)}
              name={s.label}
              stroke={seriesColor(i, s.label)}
              strokeDasharray={seriesDash(i, s.label)}
              strokeWidth={LINE_WIDTH}
              type="monotone"
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
