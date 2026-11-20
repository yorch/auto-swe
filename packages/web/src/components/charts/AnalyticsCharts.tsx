'use client';

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { useTokens } from '@/hooks/useTokens';
import { useThemeStore } from '@/stores/themeStore';
import {
  AXIS_COMMON_PROPS,
  axisLabel,
  BAR_MAX_SIZE,
  ChartFrame,
  ChartTooltip,
  chartAriaLabel,
  EmptyChart,
  formatDateLabel,
  GRID_PROPS,
  LEGEND_STYLE,
  legendText,
  TOOLTIP_CURSOR_FILL,
} from './chartChrome';
import { CHART_PALETTE, CHART_PALETTE_LIGHT } from './colors';

export interface DailySeries<K extends string> {
  key: K;
  label: string;
  /** `danger` is the one status colour: used for failures, never for a category. */
  tone?: 'danger';
}

/**
 * Per-day counts as grouped bars, one bar per series. Zero-filled days are drawn as gaps, so a
 * quiet day reads as quiet rather than missing. Failures take the danger colour.
 */
export function DailyCountsChart<K extends string>({
  data,
  series,
  title,
  yLabel,
}: {
  data: Array<{ day: string } & Record<K, number>>;
  series: DailySeries<K>[];
  title: string;
  yLabel: string;
}) {
  const tokens = useTokens();
  const theme = useThemeStore((s) => s.resolved);
  const palette = theme === 'light' ? CHART_PALETTE_LIGHT : CHART_PALETTE;
  let next = 0;
  const colorOf = (s: DailySeries<K>) => {
    if (s.tone === 'danger') {
      return tokens.danger400;
    }
    const c = palette[next % palette.length];
    next += 1;
    return c;
  };
  const colors = series.map(colorOf);

  if (data.every((d) => series.every((s) => d[s.key] === 0))) {
    return <EmptyChart label="Nothing recorded in this window." />;
  }
  const total = (k: K) => data.reduce((n, d) => n + d[k], 0);
  const summary = `${title} over ${data.length} days: ${series
    .map((s) => `${total(s.key)} ${s.label.toLowerCase()}`)
    .join(', ')}.`;

  return (
    <ChartFrame
      ariaLabel={chartAriaLabel(title, title, summary)}
      table={{
        columns: ['Date (UTC)', ...series.map((s) => s.label)],
        rows: data.map((d) => [formatDateLabel(d.day), ...series.map((s) => d[s.key])]),
      }}
    >
      <ResponsiveContainer height={240} width="100%">
        <BarChart accessibilityLayer={false} barCategoryGap={4} data={data}>
          <CartesianGrid {...GRID_PROPS} vertical={false} />
          <XAxis
            dataKey="day"
            interval="preserveStartEnd"
            tickFormatter={formatDateLabel}
            {...AXIS_COMMON_PROPS}
          />
          <YAxis
            allowDecimals={false}
            label={axisLabel(yLabel, true)}
            width={48}
            {...AXIS_COMMON_PROPS}
          />
          <ChartTooltip
            cursor={{ fill: TOOLTIP_CURSOR_FILL }}
            labelFormatter={(label) => `${formatDateLabel(label)} (UTC)`}
          />
          <Legend
            formatter={legendText}
            iconSize={10}
            iconType="circle"
            wrapperStyle={LEGEND_STYLE}
          />
          {series.map((s, i) => (
            <Bar
              dataKey={s.key}
              fill={colors[i]}
              key={s.key}
              maxBarSize={BAR_MAX_SIZE}
              name={s.label}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/** Sign-ins plus actions by UTC hour of day: 24 bars, one colour. */
export function PeakHoursChart({ hours, title }: { hours: number[]; title: string }) {
  const theme = useThemeStore((s) => s.resolved);
  const palette = theme === 'light' ? CHART_PALETTE_LIGHT : CHART_PALETTE;
  const data = Array.from({ length: 24 }, (_, h) => ({
    count: hours[h] ?? 0,
    hour: `${String(h).padStart(2, '0')}:00`,
  }));
  if (data.every((d) => d.count === 0)) {
    return <EmptyChart label="Nothing recorded in this window." />;
  }
  const busiest = data.reduce((a, b) => (b.count > a.count ? b : a));
  const summary = `Busiest hour is ${busiest.hour} UTC with ${busiest.count} events.`;
  return (
    <ChartFrame
      ariaLabel={chartAriaLabel(title, 'Activity by hour', summary)}
      table={{
        columns: ['Hour (UTC)', 'Events'],
        rows: data.map((d) => [d.hour, d.count]),
      }}
    >
      <ResponsiveContainer height={200} width="100%">
        <BarChart accessibilityLayer={false} barCategoryGap={2} data={data}>
          <CartesianGrid {...GRID_PROPS} vertical={false} />
          <XAxis dataKey="hour" interval={3} {...AXIS_COMMON_PROPS} />
          <YAxis allowDecimals={false} width={48} {...AXIS_COMMON_PROPS} />
          <ChartTooltip
            cursor={{ fill: TOOLTIP_CURSOR_FILL }}
            labelFormatter={(label) => `${String(label)} UTC`}
          />
          <Bar dataKey="count" fill={palette[0]} maxBarSize={BAR_MAX_SIZE} name="Events" />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/**
 * A ranked list of labelled counts with a proportional bar behind each. The number is always
 * printed, so the bar is a hint and never the only carrier of the value.
 */
export function BarList({
  empty = 'Nothing recorded in this window.',
  items,
  label,
}: {
  items: Array<{ name: string; count: number }>;
  /** Names the list for assistive tech. */
  label: string;
  empty?: string;
}) {
  const max = Math.max(1, ...items.map((i) => i.count));
  if (items.length === 0) {
    return <p className="py-6 text-center text-sm text-paper-500">{empty}</p>;
  }
  return (
    <ul aria-label={label} className="space-y-2">
      {items.map((i) => (
        <li className="text-sm" key={i.name}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 break-all text-paper-200">{i.name}</span>
            <span className="tabular-nums text-paper-100">{i.count}</span>
          </div>
          <div aria-hidden="true" className="mt-1 h-1.5 rounded-full bg-ink-700">
            <div
              className="h-1.5 rounded-full bg-accent-400"
              style={{ width: `${Math.max(2, (i.count / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
