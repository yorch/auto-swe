'use client';

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import {
  AXIS_COMMON_PROPS,
  CHART_HEIGHT,
  ChartTooltip,
  EmptyChart,
  formatDateLabel,
  GRID_STROKE,
} from './chartChrome';
import { CHART_PALETTE } from './colors';

interface Props {
  data: { date: string; count: number }[];
}

export function LessonsOverTimeChart({ data }: Props) {
  if (data.every((d) => d.count === 0)) {
    return <EmptyChart label="no lesson data" />;
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
        <Area
          dataKey="count"
          fill={CHART_PALETTE[2]}
          fillOpacity={0.35}
          stroke={CHART_PALETTE[2]}
          strokeWidth={1.5}
          type="monotone"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
