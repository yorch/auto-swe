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
  axisLabel,
  ChartFrame,
  ChartTooltip,
  chartAriaLabel,
  EmptyChart,
  GRID_STROKE,
  TOOLTIP_CURSOR_FILL,
} from './chartChrome';

interface Props {
  /** One bar per dataset: the share of its cases quarantined as stale, in [0,1]. */
  datasets: { slug: string; staleRate: number; cases: number; quarantined: number }[];
  /** The gate's stale-rate ceiling, drawn as a line. */
  maxStaleRate: number;
  /** Names the chart for assistive tech. */
  title?: string;
}

const ROW_HEIGHT = 34;

const percent = (v: number) => `${Math.round(v * 100)}%`;

/** Labels past this many characters are cut for the axis; the tooltip has the full name. */
const MAX_LABEL_CHARS = 18;

function truncateLabel(label: unknown): string {
  const text = String(label);
  return text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS - 1)}…` : text;
}

/**
 * Stale-case rate per dataset against the gate threshold. One series, so the
 * card title names it and there is no legend; the dashed line is the ceiling,
 * and a bar past it is drawn in the failure colour as well as sitting past it.
 */
export function SuiteHealthChart({ datasets, maxStaleRate, title }: Props) {
  if (datasets.length === 0) {
    return <EmptyChart label="no datasets" />;
  }
  const max = Math.max(maxStaleRate, ...datasets.map((d) => d.staleRate), 0.1);

  const over = datasets.filter((d) => d.staleRate > maxStaleRate).length;
  const summary = `Share of cases quarantined as stale for ${datasets.length} datasets against a ${percent(
    maxStaleRate
  )} limit; ${over} over the limit.`;

  return (
    <ChartFrame
      ariaLabel={chartAriaLabel(title, 'Dataset health', summary)}
      table={{
        columns: ['Dataset', 'Stale cases (%)', 'Quarantined', 'Cases', 'Over limit'],
        rows: datasets.map((d) => [
          d.slug,
          percent(d.staleRate),
          d.quarantined,
          d.cases,
          d.staleRate > maxStaleRate ? 'Yes' : 'No',
        ]),
      }}
    >
      <ResponsiveContainer height={datasets.length * ROW_HEIGHT + 56} width="100%">
        <BarChart
          accessibilityLayer={false}
          data={datasets}
          layout="vertical"
          margin={{ bottom: 16, left: 8, right: 24 }}
        >
          <CartesianGrid horizontal={false} stroke={GRID_STROKE} strokeDasharray="2 4" />
          <XAxis
            domain={[0, Math.min(1, max * 1.2)]}
            label={axisLabel('Stale cases (% of dataset)')}
            tickFormatter={percent}
            type="number"
            {...AXIS_COMMON_PROPS}
          />
          <YAxis
            dataKey="slug"
            tickFormatter={truncateLabel}
            type="category"
            width={110}
            {...AXIS_COMMON_PROPS}
          />
          <ChartTooltip
            cursor={{ fill: TOOLTIP_CURSOR_FILL }}
            formatter={(value, _name, item) => [
              `${percent(Number(value))} · ${item.payload.quarantined} of ${item.payload.cases} cases`,
              'Quarantined',
            ]}
            labelFormatter={(label) => String(label)}
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
    </ChartFrame>
  );
}
