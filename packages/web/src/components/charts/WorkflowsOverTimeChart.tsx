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
import {
  AXIS_COMMON_PROPS,
  axisLabel,
  CHART_HEIGHT,
  ChartFrame,
  ChartTooltip,
  chartAriaLabel,
  EmptyChart,
  formatDateLabel,
  GRID_STROKE,
  LEGEND_STYLE,
} from './chartChrome';
import { TREND_COLORS } from './colors';

interface Props {
  data: { date: string; completed: number; failed: number; active: number }[];
  /** Names the chart for assistive tech. */
  title?: string;
}

export function WorkflowsOverTimeChart({ data, title }: Props) {
  if (data.every((d) => d.completed === 0 && d.failed === 0 && d.active === 0)) {
    return <EmptyChart hint="Start work to see trends." label="No runs yet." />;
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
          <CartesianGrid stroke={GRID_STROKE} strokeDasharray="2 4" vertical={false} />
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
          <ChartTooltip labelFormatter={formatDateLabel} />
          <Legend wrapperStyle={LEGEND_STYLE} />
          <Area
            dataKey="completed"
            fill={TREND_COLORS.completed}
            fillOpacity={0.35}
            stackId="1"
            stroke={TREND_COLORS.completed}
            strokeWidth={1.5}
            type="monotone"
          />
          <Area
            dataKey="failed"
            fill={TREND_COLORS.failed}
            fillOpacity={0.35}
            stackId="1"
            stroke={TREND_COLORS.failed}
            strokeWidth={1.5}
            type="monotone"
          />
          <Area
            dataKey="active"
            fill={TREND_COLORS.active}
            fillOpacity={0.4}
            stackId="1"
            stroke={TREND_COLORS.active}
            strokeWidth={1.5}
            type="monotone"
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
