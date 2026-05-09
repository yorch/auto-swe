'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART_PALETTE } from './colors';

interface Props {
  data: { type: string; count: number }[];
}

export function LessonsByTypeChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <p className="text-sm text-[var(--muted-foreground)] text-center py-8">No lesson data</p>
    );
  }

  return (
    <ResponsiveContainer height={280} width="100%">
      <BarChart data={data}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis
          angle={-30}
          dataKey="type"
          height={60}
          interval={0}
          textAnchor="end"
          tick={{ fontSize: 12 }}
        />
        <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
        <Tooltip />
        <Bar dataKey="count" fill={CHART_PALETTE[3]} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
