'use client';

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { TREND_COLORS } from './colors';

interface Props {
  data: { date: string; completed: number; failed: number; active: number }[];
}

function formatDateLabel(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function WorkflowsOverTimeChart({ data }: Props) {
  if (data.every((d) => d.completed === 0 && d.failed === 0 && d.active === 0)) {
    return <p className="text-sm text-[var(--muted-foreground)] text-center py-8">No workflow data</p>;
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
        <Legend />
        <Area
          type="monotone"
          dataKey="completed"
          stackId="1"
          stroke={TREND_COLORS.completed}
          fill={TREND_COLORS.completed}
          fillOpacity={0.6}
        />
        <Area
          type="monotone"
          dataKey="failed"
          stackId="1"
          stroke={TREND_COLORS.failed}
          fill={TREND_COLORS.failed}
          fillOpacity={0.6}
        />
        <Area
          type="monotone"
          dataKey="active"
          stackId="1"
          stroke={TREND_COLORS.active}
          fill={TREND_COLORS.active}
          fillOpacity={0.6}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
