'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  AXIS_LINE,
  AXIS_TICK,
  EmptyChart,
  GRID_STROKE,
  TOOLTIP_ITEM_STYLE,
  TOOLTIP_LABEL_STYLE,
  TOOLTIP_STYLE,
} from './chartChrome';
import { CHART_PALETTE } from './colors';

interface Props {
  data: { repo: string; count: number }[];
}

export function WorkflowsByRepoChart({ data }: Props) {
  if (data.length === 0) return <EmptyChart label="no repository data" />;

  return (
    <ResponsiveContainer height={Math.max(200, data.length * 40)} width="100%">
      <BarChart data={data} layout="vertical" margin={{ left: 20 }}>
        <CartesianGrid horizontal={false} stroke={GRID_STROKE} strokeDasharray="2 4" />
        <XAxis
          allowDecimals={false}
          axisLine={AXIS_LINE}
          tick={AXIS_TICK}
          tickLine={AXIS_LINE}
          type="number"
        />
        <YAxis
          axisLine={AXIS_LINE}
          dataKey="repo"
          tick={AXIS_TICK}
          tickLine={AXIS_LINE}
          type="category"
          width={140}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          cursor={{ fill: '#171c26' }}
          itemStyle={TOOLTIP_ITEM_STYLE}
          labelStyle={TOOLTIP_LABEL_STYLE}
        />
        <Bar dataKey="count" fill={CHART_PALETTE[0]} radius={[0, 1, 1, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
