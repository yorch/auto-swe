'use client';

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { STATUS_CHART_COLORS } from './colors';

interface Props {
  data: { status: string; count: number }[];
}

export function WorkflowStatusChart({ data }: Props) {
  if (data.length === 0) {
    return <p className="text-sm text-[var(--muted-foreground)] text-center py-8">No workflow data</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={280}>
      <PieChart>
        <Pie
          data={data}
          dataKey="count"
          nameKey="status"
          cx="50%"
          cy="50%"
          innerRadius={60}
          outerRadius={100}
          paddingAngle={2}
          label={({ status, count }) => `${count}`}
        >
          {data.map((entry) => (
            <Cell
              key={entry.status}
              fill={STATUS_CHART_COLORS[entry.status] ?? '#9ca3af'}
            />
          ))}
        </Pie>
        <Tooltip
          formatter={(value: number, name: string) => [value, name.replace(/_/g, ' ')]}
        />
        <Legend
          formatter={(value: string) => value.replace(/_/g, ' ')}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
