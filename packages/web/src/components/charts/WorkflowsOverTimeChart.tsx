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
  CHART_HEIGHT,
  ChartTooltip,
  EmptyChart,
  formatDateLabel,
  GRID_STROKE,
  LEGEND_STYLE,
} from './chartChrome';
import { TREND_COLORS } from './colors';

interface Props {
  data: { date: string; completed: number; failed: number; active: number }[];
}

export function WorkflowsOverTimeChart({ data }: Props) {
  if (data.every((d) => d.completed === 0 && d.failed === 0 && d.active === 0)) {
    return <EmptyChart label="no workflow data" />;
  }

  return (
    <ResponsiveContainer height={CHART_HEIGHT} width="100%">
      <AreaChart data={data}>
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="2 4" vertical={false} />
        <XAxis
          dataKey="date"
          interval="preserveStartEnd"
          tickFormatter={formatDateLabel}
          {...AXIS_COMMON_PROPS}
        />
        <YAxis allowDecimals={false} {...AXIS_COMMON_PROPS} />
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
  );
}
