'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART_PALETTE } from './colors';

interface Props {
  data: { repo: string; count: number }[];
}

export function WorkflowsByRepoChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <p className="text-sm text-[var(--muted-foreground)] text-center py-8">No repository data</p>
    );
  }

  return (
    <ResponsiveContainer height={Math.max(200, data.length * 40)} width="100%">
      <BarChart data={data} layout="vertical" margin={{ left: 20 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis allowDecimals={false} tick={{ fontSize: 12 }} type="number" />
        <YAxis dataKey="repo" tick={{ fontSize: 12 }} type="category" width={140} />
        <Tooltip />
        <Bar dataKey="count" fill={CHART_PALETTE[0]} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
