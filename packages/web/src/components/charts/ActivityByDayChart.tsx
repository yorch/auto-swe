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

export interface ActivityDay {
  day: string;
  denied: number;
  read: number;
  export: number;
  ui: number;
  /** Absent from a gateway that predates sign-in recording. */
  sign_in?: number;
  sign_in_failed?: number;
  sign_out?: number;
}

const SERIES = [
  { key: 'denied', label: 'Denied' },
  { key: 'read', label: 'Sensitive read' },
  { key: 'export', label: 'Export' },
  { key: 'ui', label: 'Page view' },
  { key: 'sign_in', label: 'Sign-in' },
  { key: 'sign_in_failed', label: 'Failed sign-in' },
  { key: 'sign_out', label: 'Sign-out' },
] as const;

/** Activity events per day, stacked by kind. A spike in refusals shows at a glance. */
export function ActivityByDayChart({ data, title }: { data: ActivityDay[]; title?: string }) {
  const tokens = useTokens();
  const theme = useThemeStore((s) => s.resolved);
  const palette = theme === 'light' ? CHART_PALETTE_LIGHT : CHART_PALETTE;
  // Denied is the one that matters, so it takes the warm categorical colour; page views recede.
  const colors = {
    denied: palette[1],
    export: palette[2],
    read: palette[0],
    sign_in: palette[5],
    sign_in_failed: palette[6],
    sign_out: palette[3],
    ui: tokens.paper500,
  };
  const count = (d: ActivityDay, k: (typeof SERIES)[number]['key']) => d[k] ?? 0;

  if (data.every((d) => SERIES.every((s) => count(d, s.key) === 0))) {
    return <EmptyChart label="No events in this window." />;
  }
  const total = (k: (typeof SERIES)[number]['key']) => data.reduce((n, d) => n + count(d, k), 0);
  const summary = `Activity events per day over ${data.length} days: ${SERIES.map(
    (s) => `${total(s.key)} ${s.label.toLowerCase()}`
  ).join(', ')}.`;

  return (
    <ChartFrame
      ariaLabel={chartAriaLabel(title, 'Activity by day', summary)}
      table={{
        columns: ['Date (UTC)', ...SERIES.map((s) => s.label)],
        rows: data.map((d) => [formatDateLabel(d.day), ...SERIES.map((s) => count(d, s.key))]),
      }}
    >
      <ResponsiveContainer height={220} width="100%">
        <BarChart accessibilityLayer={false} barCategoryGap={2} data={data}>
          <CartesianGrid {...GRID_PROPS} vertical={false} />
          <XAxis
            dataKey="day"
            interval="preserveStartEnd"
            tickFormatter={formatDateLabel}
            {...AXIS_COMMON_PROPS}
          />
          <YAxis
            allowDecimals={false}
            label={axisLabel('Events', true)}
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
          {SERIES.map((s) => (
            <Bar
              dataKey={s.key}
              fill={colors[s.key]}
              key={s.key}
              maxBarSize={BAR_MAX_SIZE}
              name={s.label}
              stackId="events"
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
