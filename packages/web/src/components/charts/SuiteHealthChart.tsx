'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import { TOKEN } from '@/lib/palette';
import {
  AXIS_COMMON_PROPS,
  ChartTooltip,
  EmptyChart,
  GRID_STROKE,
  TOOLTIP_CURSOR_FILL,
} from './chartChrome';

interface Props {
  /** One bar per dataset: the share of its cases quarantined as stale, in [0,1]. */
  datasets: { slug: string; staleRate: number; cases: number; quarantined: number }[];
  /** The gate's stale-rate ceiling, drawn as a line. */
  maxStaleRate: number;
}

const ROW_HEIGHT = 34;

const percent = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Stale-case rate per dataset against the gate threshold. One series, so the
 * card title names it and there is no legend; the dashed line is the ceiling,
 * and a bar past it is drawn in the failure colour as well as sitting past it.
 */
export function SuiteHealthChart({ datasets, maxStaleRate }: Props) {
  if (datasets.length === 0) {
    return <EmptyChart label="no datasets" />;
  }
  const max = Math.max(maxStaleRate, ...datasets.map((d) => d.staleRate), 0.1);

  return (
    <ResponsiveContainer height={datasets.length * ROW_HEIGHT + 40} width="100%">
      <BarChart data={datasets} layout="vertical" margin={{ left: 16, right: 24 }}>
        <CartesianGrid horizontal={false} stroke={GRID_STROKE} strokeDasharray="2 4" />
        <XAxis
          domain={[0, Math.min(1, max * 1.2)]}
          tickFormatter={percent}
          type="number"
          {...AXIS_COMMON_PROPS}
        />
        <YAxis dataKey="slug" type="category" width={140} {...AXIS_COMMON_PROPS} />
        <ChartTooltip
          cursor={{ fill: TOOLTIP_CURSOR_FILL }}
          formatter={(value, _name, item) => [
            `${percent(Number(value))} · ${item.payload.quarantined} of ${item.payload.cases} cases`,
            'Quarantined',
          ]}
        />
        <ReferenceLine
          label={{
            fill: TOKEN.paper400,
            fontSize: 10,
            position: 'top',
            value: `max ${percent(maxStaleRate)}`,
          }}
          stroke={TOKEN.amber400}
          strokeDasharray="4 3"
          x={maxStaleRate}
        />
        <Bar dataKey="staleRate" isAnimationActive={false} radius={[0, 2, 2, 0]}>
          {datasets.map((d) => (
            <Cell
              fill={d.staleRate > maxStaleRate ? TOKEN.brick400 : TOKEN.ember400}
              key={d.slug}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
