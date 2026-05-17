'use client';

import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import {
  EmptyChart,
  LEGEND_STYLE,
  TOOLTIP_ITEM_STYLE,
  TOOLTIP_LABEL_STYLE,
  TOOLTIP_STYLE,
} from './chartChrome';
import { STATUS_CHART_COLORS } from './colors';

interface Props {
  data: { status: string; count: number }[];
}

export function WorkflowStatusChart({ data }: Props) {
  if (data.length === 0) return <EmptyChart label="no workflow data" />;

  return (
    <ResponsiveContainer height={280} width="100%">
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
          stroke="#0b0e13"
          strokeWidth={2}
        >
          {data.map((entry) => (
            <Cell fill={STATUS_CHART_COLORS[entry.status] ?? '#7a766c'} key={entry.status} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={(value, name) => [value, String(name).replace(/_/g, ' ').toLowerCase()]}
          itemStyle={TOOLTIP_ITEM_STYLE}
          labelStyle={TOOLTIP_LABEL_STYLE}
        />
        <Legend
          formatter={(value) => String(value).replace(/_/g, ' ').toLowerCase()}
          wrapperStyle={LEGEND_STYLE}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
