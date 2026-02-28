'use client';

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { CHART_PALETTE } from './colors';

interface Props {
  data: { date: string; count: number }[];
}

function formatDateLabel(label: unknown) {
  const d = new Date(String(label) + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function LessonsOverTimeChart({ data }: Props) {
  if (data.every((d) => d.count === 0)) {
    return <p className="text-sm text-[var(--muted-foreground)] text-center py-8">No lesson data</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="date"
          tickFormatter={formatDateLabel}
          tick={{ fontSize: 12 }}
          interval="preserveStartEnd"
        />
        <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
        <Tooltip labelFormatter={formatDateLabel} />
        <Area
          type="monotone"
          dataKey="count"
          stroke={CHART_PALETTE[2]}
          fill={CHART_PALETTE[2]}
          fillOpacity={0.4}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
