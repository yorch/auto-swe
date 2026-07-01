'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import {
  AXIS_COMMON_PROPS,
  ChartTooltip,
  EmptyChart,
  GRID_STROKE,
  TOOLTIP_CURSOR_FILL,
} from './chartChrome';
import { CHART_PALETTE } from './colors';

interface Props {
  data: { repo: string; count: number }[];
}

export function WorkflowsByRepoChart({ data }: Props) {
  if (data.length === 0) {
    return <EmptyChart label="no repository data" />;
  }

  return (
    <ResponsiveContainer height={Math.max(200, data.length * 40)} width="100%">
      <BarChart data={data} layout="vertical" margin={{ left: 20 }}>
        <CartesianGrid horizontal={false} stroke={GRID_STROKE} strokeDasharray="2 4" />
        <XAxis allowDecimals={false} type="number" {...AXIS_COMMON_PROPS} />
        <YAxis dataKey="repo" type="category" width={140} {...AXIS_COMMON_PROPS} />
        <ChartTooltip cursor={{ fill: TOOLTIP_CURSOR_FILL }} />
        <Bar dataKey="count" fill={CHART_PALETTE[0]} radius={[0, 1, 1, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
