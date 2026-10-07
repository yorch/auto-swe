'use client';

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import { useTokens } from '@/hooks/useTokens';
import {
  AXIS_COMMON_PROPS,
  axisLabel,
  CHART_HEIGHT,
  ChartFrame,
  ChartTooltip,
  chartAriaLabel,
  EmptyChart,
  formatDateLabel,
  GRID_PROPS,
  LEGEND_STYLE,
  LINE_WIDTH,
  legendText,
} from './chartChrome';
import { trendColors } from './colors';

interface Props {
  data: { date: string; completed: number; failed: number; active: number }[];
  /** Names the chart for assistive tech. */
  title?: string;
}

export function WorkflowsOverTimeChart({ data, title }: Props) {
  const trend = trendColors(useTokens());
  if (data.every((d) => d.completed === 0 && d.failed === 0 && d.active === 0)) {
    return (
      <EmptyChart hint="Try a wider date range, or start work." label="No runs in this range." />
    );
  }

  const sum = (k: 'completed' | 'failed' | 'active') => data.reduce((n, d) => n + d[k], 0);
  const summary = `Workflows per day over ${data.length} days: ${sum('completed')} completed, ${sum(
    'failed'
  )} failed, ${sum('active')} active.`;

  return (
    <ChartFrame
      ariaLabel={chartAriaLabel(title, 'Workflows over time', summary)}
      table={{
        columns: ['Date', 'Completed', 'Failed', 'Active'],
        rows: data.map((d) => [formatDateLabel(d.date), d.completed, d.failed, d.active]),
      }}
    >
      <ResponsiveContainer height={CHART_HEIGHT} width="100%">
        <AreaChart accessibilityLayer={false} data={data}>
          <CartesianGrid {...GRID_PROPS} vertical={false} />
          <XAxis
            dataKey="date"
            interval="preserveStartEnd"
            tickFormatter={formatDateLabel}
            {...AXIS_COMMON_PROPS}
          />
          <YAxis
            allowDecimals={false}
            label={axisLabel('Workflows', true)}
            width={52}
            {...AXIS_COMMON_PROPS}
          />
          <ChartTooltip labelFormatter={(label) => `${formatDateLabel(label)} (UTC)`} />
          <Legend
            formatter={legendText}
            iconSize={10}
            iconType="circle"
            wrapperStyle={LEGEND_STYLE}
          />
          <Area
            dataKey="completed"
            fill={trend.completed}
            fillOpacity={0.15}
            name="Completed"
            stackId="1"
            stroke={trend.completed}
            strokeWidth={LINE_WIDTH}
            type="monotone"
          />
          <Area
            dataKey="failed"
            fill={trend.failed}
            fillOpacity={0.15}
            name="Failed"
            stackId="1"
            stroke={trend.failed}
            strokeWidth={LINE_WIDTH}
            type="monotone"
          />
          <Area
            dataKey="active"
            fill={trend.active}
            fillOpacity={0.18}
            name="Active"
            stackId="1"
            stroke={trend.active}
            strokeWidth={LINE_WIDTH}
            type="monotone"
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
