'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import {
  AXIS_COMMON_PROPS,
  AXIS_LINE,
  CHART_HEIGHT,
  ChartTooltip,
  EmptyChart,
  GRID_STROKE,
  TOOLTIP_CURSOR_FILL,
} from './chartChrome';
import { CHART_PALETTE } from './colors';

interface Props {
  data: { type: string; count: number }[];
}

export function LessonsByTypeChart({ data }: Props) {
  if (data.length === 0) {
    return <EmptyChart label="no lesson data" />;
  }

  return (
    <ResponsiveContainer height={CHART_HEIGHT} width="100%">
      <BarChart data={data}>
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="2 4" vertical={false} />
        <XAxis
          angle={-30}
          axisLine={AXIS_LINE}
          dataKey="type"
          height={60}
          interval={0}
          textAnchor="end"
          tick={AXIS_COMMON_PROPS.tick}
          tickLine={AXIS_LINE}
        />
        <YAxis allowDecimals={false} {...AXIS_COMMON_PROPS} />
        <ChartTooltip cursor={{ fill: TOOLTIP_CURSOR_FILL }} />
        <Bar dataKey="count" fill={CHART_PALETTE[3]} radius={[1, 1, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
