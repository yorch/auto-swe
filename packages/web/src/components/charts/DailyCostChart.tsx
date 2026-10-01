'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { TOKEN } from '@/lib/palette';
import { formatCost } from '@/lib/utils';
import {
  AXIS_COMMON_PROPS,
  CHART_HEIGHT,
  ChartTooltip,
  EmptyChart,
  formatDateLabel,
  GRID_STROKE,
  TOOLTIP_CURSOR_FILL,
} from './chartChrome';

const usdTick = new Intl.NumberFormat(undefined, {
  currency: 'USD',
  maximumSignificantDigits: 2,
  notation: 'compact',
  style: 'currency',
});

/** `$0.0025` and `$1234.5` as `$0.0025` and `$1.2K` — short enough for an axis. */
function formatUsdTick(v: number): string {
  return usdTick.format(v);
}

interface Props {
  /** One row per UTC day, oldest first; `date` is `YYYY-MM-DD`. */
  data: { date: string; costUsd: number; calls: number }[];
}

/** LLM spend per day. One series, so the card title names it and there is no legend. */
export function DailyCostChart({ data }: Props) {
  if (data.every((d) => d.calls === 0)) {
    return <EmptyChart label="no llm calls in this window" />;
  }

  return (
    <ResponsiveContainer height={CHART_HEIGHT} width="100%">
      <BarChart data={data}>
        <CartesianGrid stroke={GRID_STROKE} strokeDasharray="2 4" vertical={false} />
        <XAxis
          dataKey="date"
          interval="preserveStartEnd"
          tickFormatter={formatDateLabel}
          {...AXIS_COMMON_PROPS}
        />
        <YAxis tickFormatter={formatUsdTick} {...AXIS_COMMON_PROPS} />
        <ChartTooltip
          cursor={{ fill: TOOLTIP_CURSOR_FILL }}
          formatter={(value, _name, item) => [
            `${formatCost(Number(value))} · ${item.payload.calls} calls`,
            'Cost',
          ]}
          labelFormatter={(label) => `${formatDateLabel(label)} (UTC)`}
        />
        <Bar dataKey="costUsd" fill={TOKEN.ember400} maxBarSize={28} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
