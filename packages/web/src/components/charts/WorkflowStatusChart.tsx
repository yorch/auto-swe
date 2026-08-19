'use client';

import { Cell, Legend, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { TOKEN } from '@/lib/palette';
import { CHART_HEIGHT, ChartTooltip, EmptyChart, LEGEND_STYLE } from './chartChrome';
import { STATUS_CHART_COLORS } from './colors';

interface Props {
  data: { status: string; count: number }[];
}

export function WorkflowStatusChart({ data }: Props) {
  if (data.length === 0) {
    return <EmptyChart label="no workflow data" />;
  }

  return (
    <ResponsiveContainer height={CHART_HEIGHT} width="100%">
      <PieChart>
        <Pie
          cx="50%"
          cy="50%"
          data={data}
          dataKey="count"
          innerRadius={64}
          label={({ value }) => `${value}`}
          nameKey="status"
          outerRadius={102}
          paddingAngle={2}
          stroke={TOKEN.ink900}
          strokeWidth={2}
        >
          {data.map((entry) => (
            <Cell fill={STATUS_CHART_COLORS[entry.status] ?? TOKEN.paper500} key={entry.status} />
          ))}
        </Pie>
        <ChartTooltip
          formatter={(value, name) => [value, String(name).replace(/_/g, ' ').toLowerCase()]}
        />
        <Legend
          formatter={(value) => String(value).replace(/_/g, ' ').toLowerCase()}
          wrapperStyle={LEGEND_STYLE}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
