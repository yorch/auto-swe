'use client';

import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { STATUS_CHART_COLORS } from './colors';

interface Props {
  data: { status: string; count: number }[];
}

export function WorkflowStatusChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <p className="text-sm text-[var(--muted-foreground)] text-center py-8">No workflow data</p>
    );
  }

  return (
    <ResponsiveContainer height={280} width="100%">
      <PieChart>
        <Pie
          cx="50%"
          cy="50%"
          data={data}
          dataKey="count"
          innerRadius={60}
          label={({ value }) => `${value}`}
          nameKey="status"
          outerRadius={100}
          paddingAngle={2}
        >
          {data.map((entry) => (
            <Cell fill={STATUS_CHART_COLORS[entry.status] ?? '#9ca3af'} key={entry.status} />
          ))}
        </Pie>
        <Tooltip formatter={(value, name) => [value, String(name).replace(/_/g, ' ')]} />
        <Legend formatter={(value) => String(value).replace(/_/g, ' ')} />
      </PieChart>
    </ResponsiveContainer>
  );
}
