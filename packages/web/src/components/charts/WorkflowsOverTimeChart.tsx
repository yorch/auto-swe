'use client';

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
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
  LEGEND_STYLE,
  TOOLTIP_ITEM_STYLE,
  TOOLTIP_LABEL_STYLE,
  TOOLTIP_STYLE,
} from './chartChrome';
import { TREND_COLORS } from './colors';

interface Props {
  data: { date: string; completed: number; failed: number; active: number }[];
}

function formatDateLabel(label: unknown) {
  const d = new Date(`${String(label)}T00:00:00`);
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}

export function WorkflowsOverTimeChart({ data }: Props) {
  if (data.every((d) => d.completed === 0 && d.failed === 0 && d.active === 0)) {
    return <EmptyChart label="no workflow data" />;
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
