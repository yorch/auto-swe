'use client';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { CHART_PALETTE } from './colors';

interface Props {
  data: { type: string; count: number }[];
}

export function LessonsByTypeChart({ data }: Props) {
  if (data.length === 0) {
    return <p className="text-sm text-[var(--muted-foreground)] text-center py-8">No lesson data</p>;
  }

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="type"
          tick={{ fontSize: 12 }}
          interval={0}
          angle={-30}
          textAnchor="end"
          height={60}
        />
        <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
        <Tooltip />
        <Bar dataKey="count" fill={CHART_PALETTE[3]} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
