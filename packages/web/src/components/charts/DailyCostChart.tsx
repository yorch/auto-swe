'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { useTokens } from '@/hooks/useTokens';
import { formatCost } from '@/lib/utils';
import {
  AXIS_COMMON_PROPS,
  axisLabel,
  BAR_MAX_SIZE,
  CHART_HEIGHT,
  ChartFrame,
  type ChartGranularity,
  ChartTooltip,
  chartAriaLabel,
  EmptyChart,
  formatDateLabel,
  GRID_PROPS,
  granularityWords,
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
  /** Names the chart for assistive tech; the card title usually says the same. */
  title?: string;
  /** One bar per `day` (default) or per `week` when the gateway buckets a long window. */
  granularity?: ChartGranularity;
}

/** LLM spend per day, or per week for a long window. One series, so the card title names it and there is no legend. */
export function DailyCostChart({ data, granularity = 'day', title }: Props) {
  const t = useTokens();
  const words = granularityWords(granularity);
  if (data.every((d) => d.calls === 0)) {
    return <EmptyChart label="No LLM calls in this window." />;
  }

  const total = data.reduce((n, d) => n + d.costUsd, 0);
  const peak = data.reduce((a, d) => (d.costUsd > a.costUsd ? d : a), data[0]);
  const summary = `${words.adjective} LLM cost in US dollars over ${data.length} ${words.plural}, ${formatCost(total)} in total. Highest ${words.singular} ${formatDateLabel(peak.date)} at ${formatCost(peak.costUsd)}.`;

  return (
    <ChartFrame
      ariaLabel={chartAriaLabel(title, `${words.adjective} LLM cost`, summary)}
      table={{
        columns: [words.dateColumn, 'Cost (USD)', 'Calls'],
        rows: data.map((d) => [formatDateLabel(d.date), formatCost(d.costUsd), d.calls]),
      }}
    >
      <ResponsiveContainer height={CHART_HEIGHT} width="100%">
        <BarChart accessibilityLayer={false} barCategoryGap={2} data={data}>
          <CartesianGrid {...GRID_PROPS} vertical={false} />
          <XAxis
            dataKey="date"
            interval="preserveStartEnd"
            tickFormatter={formatDateLabel}
            {...AXIS_COMMON_PROPS}
          />
          <YAxis
            label={axisLabel('Cost (USD)', true)}
            tickFormatter={formatUsdTick}
            width={64}
            {...AXIS_COMMON_PROPS}
          />
          <ChartTooltip
            cursor={{ fill: TOOLTIP_CURSOR_FILL }}
            formatter={(value, _name, item) => [
              `${formatCost(Number(value))} · ${item.payload.calls} calls`,
              'Cost',
            ]}
            labelFormatter={(label) =>
              `${granularity === 'week' ? 'Week of ' : ''}${formatDateLabel(label)} (UTC)`
            }
          />
          <Bar
            dataKey="costUsd"
            fill={t.ember400}
            maxBarSize={BAR_MAX_SIZE}
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
