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
  data: { type: string; count: number }[];
}

export function LessonsByTypeChart({ data }: Props) {
  if (data.length === 0) return <EmptyChart label="no lesson data" />;

  return (
    <ResponsiveContainer height={280} width="100%">
      <BarChart data={data}>
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="2 4" vertical={false} />
        <XAxis
          angle={-30}
          axisLine={AXIS_LINE}
          dataKey="type"
          height={60}
          interval={0}
          textAnchor="end"
          tick={AXIS_TICK}
          tickLine={AXIS_LINE}
        />
        <YAxis allowDecimals={false} axisLine={AXIS_LINE} tick={AXIS_TICK} tickLine={AXIS_LINE} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          cursor={{ fill: '#171c26' }}
          itemStyle={TOOLTIP_ITEM_STYLE}
          labelStyle={TOOLTIP_LABEL_STYLE}
        />
        <Bar dataKey="count" fill={CHART_PALETTE[3]} radius={[1, 1, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
