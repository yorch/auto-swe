'use client';

import { Cell, Legend, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { useTokens } from '@/hooks/useTokens';
import {
  CHART_HEIGHT,
  ChartFrame,
  ChartTooltip,
  chartAriaLabel,
  EmptyChart,
  LEGEND_STYLE,
  legendLabel,
  legendText,
} from './chartChrome';
import { statusChartColors } from './colors';

interface Props {
  data: { status: string; count: number }[];
  /** Names the chart for assistive tech. */
  title?: string;
}

const statusName = (status: string) => legendLabel(status.replace(/_/g, ' ').toLowerCase());

export function WorkflowStatusChart({ data, title }: Props) {
  const t = useTokens();
  if (data.length === 0) {
    return <EmptyChart label="No runs in this range." />;
  }

  const summary = `Workflows by status: ${data.map((d) => `${d.count} ${statusName(d.status)}`).join(', ')}.`;

  return (
    <ChartFrame
      ariaLabel={chartAriaLabel(title, 'Workflows by status', summary)}
      table={{
        columns: ['Status', 'Workflows'],
        rows: data.map((d) => [statusName(d.status), d.count]),
      }}
    >
      <ResponsiveContainer height={CHART_HEIGHT} width="100%">
        <PieChart accessibilityLayer={false}>
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
            stroke={t.ink900}
            strokeWidth={2}
          >
            {data.map((entry) => (
              <Cell fill={statusChartColors(t)[entry.status] ?? t.paper500} key={entry.status} />
            ))}
          </Pie>
          <ChartTooltip formatter={(value, name) => [value, statusName(String(name))]} />
          <Legend
            formatter={(value) => legendText(statusName(String(value)))}
            iconSize={10}
            iconType="circle"
            wrapperStyle={LEGEND_STYLE}
          />
        </PieChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
