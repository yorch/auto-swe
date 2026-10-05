'use client';

import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { TOKEN } from '@/lib/palette';
import {
  AXIS_COMMON_PROPS,
  axisLabel,
  CHART_HEIGHT,
  ChartFrame,
  type ChartGranularity,
  ChartTooltip,
  chartAriaLabel,
  EmptyChart,
  formatDateLabel,
  GRID_STROKE,
  granularityWords,
} from './chartChrome';

interface Props {
  /** One row per UTC day (or week, see `granularity`), oldest first; `mean` is null on a day with no signal. */
  data: { date: string; mean: number | null; n: number }[];
  /** Names the chart for assistive tech, e.g. the scorer's name. */
  title?: string;
  /** One point per `day` (default) or per `week` when the gateway buckets a long window. */
  granularity?: ChartGranularity;
}

/**
 * One scorer's daily mean score (0..1). One series, so the card names the
 * scorer and there is no legend. A day without signals is a gap, not a zero.
 */
export function ScorerTrendChart({ data, granularity = 'day', title }: Props) {
  const words = granularityWords(granularity);
  if (data.every((d) => d.n === 0)) {
    return <EmptyChart label="No signals in this window." />;
  }

  const scored = data.filter((d) => d.mean !== null);
  const latest = scored[scored.length - 1];
  const summary = `${words.adjective} mean score from 0 to 1 over ${data.length} ${words.plural}; ${scored.length} ${words.plural} have signals${
    latest ? `, the latest ${latest.mean?.toFixed(2)} on ${formatDateLabel(latest.date)}` : ''
  }.`;

  return (
    <ChartFrame
      ariaLabel={chartAriaLabel(title, 'Scorer trend', summary)}
      table={{
        columns: [words.dateColumn, 'Mean score (0–1)', 'Signals'],
        rows: data.map((d) => [
          formatDateLabel(d.date),
          d.mean === null ? '—' : d.mean.toFixed(2),
          d.n,
        ]),
      }}
    >
      <ResponsiveContainer height={CHART_HEIGHT} width="100%">
        <LineChart accessibilityLayer={false} data={data}>
          <CartesianGrid stroke={GRID_STROKE} strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="date"
            interval="preserveStartEnd"
            tickFormatter={formatDateLabel}
            {...AXIS_COMMON_PROPS}
          />
          <YAxis
            domain={[0, 1]}
            label={axisLabel('Mean score (0–1)', true)}
            tickCount={5}
            width={52}
            {...AXIS_COMMON_PROPS}
          />
          <ChartTooltip
            formatter={(value, _name, item) => [
              `${Number(value).toFixed(2)} · n=${item.payload.n}`,
              'Mean score',
            ]}
            labelFormatter={(label) =>
              `${granularity === 'week' ? 'Week of ' : ''}${formatDateLabel(label)} (UTC)`
            }
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
    </ChartFrame>
  );
}
