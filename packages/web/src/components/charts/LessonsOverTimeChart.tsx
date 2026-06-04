'use client';

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AXIS_LINE,
  AXIS_TICK,
  EmptyChart,
  GRID_STROKE,
  TOOLTIP_ITEM_STYLE,
  TOOLTIP_LABEL_STYLE,
  TOOLTIP_STYLE,
} from './chartChrome';
import { CHART_PALETTE } from './colors';

interface Props {
  data: { date: string; count: number }[];
}

function formatDateLabel(label: unknown) {
  const d = new Date(`${String(label)}T00:00:00`);
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}

export function LessonsOverTimeChart({ data }: Props) {
  if (data.every((d) => d.count === 0)) {
    return <EmptyChart label="no lesson data" />;
  }

  return (
    <ResponsiveContainer height={280} width="100%">
      <AreaChart data={data}>
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="2 4" vertical={false} />
        <XAxis
          axisLine={AXIS_LINE}
          dataKey="date"
          interval="preserveStartEnd"
          tick={AXIS_TICK}
          tickFormatter={formatDateLabel}
          tickLine={AXIS_LINE}
        />
        <YAxis allowDecimals={false} axisLine={AXIS_LINE} tick={AXIS_TICK} tickLine={AXIS_LINE} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          itemStyle={TOOLTIP_ITEM_STYLE}
          labelFormatter={formatDateLabel}
          labelStyle={TOOLTIP_LABEL_STYLE}
        />
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
