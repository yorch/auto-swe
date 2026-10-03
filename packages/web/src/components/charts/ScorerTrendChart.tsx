'use client';

import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { TOKEN } from '@/lib/palette';
import {
  AXIS_COMMON_PROPS,
  CHART_HEIGHT,
  ChartTooltip,
  EmptyChart,
  formatDateLabel,
  GRID_STROKE,
} from './chartChrome';

interface Props {
  /** One row per UTC day, oldest first; `mean` is null on a day with no signal. */
  data: { date: string; mean: number | null; n: number }[];
}

/**
 * One scorer's daily mean score (0..1). One series, so the card names the
 * scorer and there is no legend. A day without signals is a gap, not a zero.
 */
export function ScorerTrendChart({ data }: Props) {
  if (data.every((d) => d.n === 0)) {
    return <EmptyChart label="no signals in this window" />;
  }

  return (
    <ResponsiveContainer height={CHART_HEIGHT} width="100%">
      <LineChart data={data}>
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="2 4" vertical={false} />
        <XAxis
          dataKey="date"
          interval="preserveStartEnd"
          tickFormatter={formatDateLabel}
          {...AXIS_COMMON_PROPS}
        />
        <YAxis domain={[0, 1]} tickCount={5} {...AXIS_COMMON_PROPS} />
        <ChartTooltip
          formatter={(value, _name, item) => [
            `${Number(value).toFixed(2)} · n=${item.payload.n}`,
            'Mean score',
          ]}
          labelFormatter={(label) => `${formatDateLabel(label)} (UTC)`}
        />
        <Line
          connectNulls={false}
          dataKey="mean"
          dot={{ r: 2.5 }}
          isAnimationActive={false}
          stroke={TOKEN.ember400}
          strokeWidth={1.5}
          type="monotone"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
