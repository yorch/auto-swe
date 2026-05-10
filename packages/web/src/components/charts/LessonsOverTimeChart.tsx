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
    return (
      <p className="text-sm text-[var(--muted-foreground)] text-center py-8">No lesson data</p>
    );
  }

  return (
    <ResponsiveContainer height={280} width="100%">
      <AreaChart data={data}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis
          dataKey="date"
          interval="preserveStartEnd"
          tick={{ fontSize: 12 }}
          tickFormatter={formatDateLabel}
        />
        <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
        <Tooltip labelFormatter={formatDateLabel} />
        <Area
          dataKey="count"
          fill={CHART_PALETTE[2]}
          fillOpacity={0.4}
          stroke={CHART_PALETTE[2]}
          type="monotone"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
