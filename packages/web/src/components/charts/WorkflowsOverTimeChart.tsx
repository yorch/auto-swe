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
import { TREND_COLORS } from './colors';

interface Props {
  data: { date: string; completed: number; failed: number; active: number }[];
}

function formatDateLabel(label: unknown) {
  const d = new Date(String(label) + 'T00:00:00');
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}

export function WorkflowsOverTimeChart({ data }: Props) {
  if (data.every((d) => d.completed === 0 && d.failed === 0 && d.active === 0)) {
    return (
      <p className="text-sm text-[var(--muted-foreground)] text-center py-8">No workflow data</p>
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
        <Legend />
        <Area
          dataKey="completed"
          fill={TREND_COLORS.completed}
          fillOpacity={0.6}
          stackId="1"
          stroke={TREND_COLORS.completed}
          type="monotone"
        />
        <Area
          dataKey="failed"
          fill={TREND_COLORS.failed}
          fillOpacity={0.6}
          stackId="1"
          stroke={TREND_COLORS.failed}
          type="monotone"
        />
        <Area
          dataKey="active"
          fill={TREND_COLORS.active}
          fillOpacity={0.6}
          stackId="1"
          stroke={TREND_COLORS.active}
          type="monotone"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
