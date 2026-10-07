/** Shared Recharts styling tokens for the Workshop Telemetry palette. */
import type { ComponentProps, ReactNode } from 'react';
import { Tooltip } from 'recharts';
import { Icon } from '@/components/ui/Icon';
import { TOKEN } from '@/lib/palette';
import { cn, FOCUS_RING } from '@/lib/utils';

// Sans, sentence case, tabular figures: axis text is read, not decorated.
const AXIS_TICK = {
  fill: TOKEN.paper500,
  fontFamily: 'var(--font-sans)',
  fontSize: 11,
  fontVariantNumeric: 'tabular-nums',
};

export const AXIS_LINE = {
  stroke: TOKEN.ink500,
};

/** Gridlines are solid hairlines one step off the surface — never dashed. */
export const GRID_STROKE = TOKEN.ink600;

/** Shared `CartesianGrid` props: solid, recessive, horizontal rules only by default. */
export const GRID_PROPS = {
  stroke: GRID_STROKE,
  strokeWidth: 1,
} as const;

/** The card surface a mark's ring is drawn in, so dots stay legible where lines cross. */
export const SURFACE = TOKEN.ink900;

/** Line marks: 2px, round joins; markers r=4 with a 2px surface ring. */
export const LINE_WIDTH = 2;
export const DOT_PROPS = { r: 3.5, stroke: SURFACE, strokeWidth: 2 } as const;
export const ACTIVE_DOT_PROPS = { r: 5, stroke: SURFACE, strokeWidth: 2 } as const;

/** Bars are capped thin, with a 4px rounded data end and a square baseline. */
export const BAR_MAX_SIZE = 24;

/** Shared axisLine/tick/tickLine props for a value (numeric) axis. */
export const AXIS_COMMON_PROPS = {
  axisLine: AXIS_LINE,
  tick: AXIS_TICK,
  tickLine: false,
};

export const TOOLTIP_CURSOR_FILL = TOKEN.ink700;

export const CHART_HEIGHT = 280;

/**
 * Formats a `YYYY-MM-DD` date label as e.g. "3 Jun" for axis ticks/tooltips.
 * The locale is left to the browser so ticks match the dates rendered
 * elsewhere in the app rather than pinning every reader to US ordering.
 */
const tickDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

export function formatDateLabel(label: unknown) {
  return tickDate.format(new Date(`${String(label)}T00:00:00`));
}

// Tooltips and legends are HTML with inline styles, where `var()` resolves, so they
// follow the theme directly. The SVG chrome below is re-pointed by globals.css.
const TOOLTIP_STYLE: React.CSSProperties = {
  background: 'var(--color-ink-700)',
  border: '1px solid var(--color-ink-400)',
  borderRadius: 8,
  boxShadow: '0 12px 32px -12px rgba(0,0,0,0.6)',
  color: 'var(--color-paper-200)',
  fontFamily: 'var(--font-sans)',
  fontSize: 12,
  fontVariantNumeric: 'tabular-nums',
  padding: '8px 12px',
};

const TOOLTIP_LABEL_STYLE: React.CSSProperties = {
  color: 'var(--color-paper-400)',
  fontSize: 12,
  fontWeight: 500,
  marginBottom: 4,
};

// Values wear text tokens; the swatch Recharts draws beside each row carries identity.
const TOOLTIP_ITEM_STYLE: React.CSSProperties = {
  color: 'var(--color-paper-200)',
  padding: '1px 0',
};

export const LEGEND_STYLE: React.CSSProperties = {
  color: 'var(--color-paper-400)',
  fontFamily: 'var(--font-sans)',
  fontSize: 12,
  paddingTop: 8,
};

/** Legend entries in sentence case ("completed" → "Completed"). */
export function legendLabel(value: unknown): string {
  const text = String(value);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Legend `formatter`: the entry's text in a text token, sentence case. Recharts
 * paints legend text in the series colour by default; the swatch beside it
 * already carries identity, and a light series hue is hard to read as text.
 * The label is shown as given: series names can be data (a model spec).
 */
export function legendText(value: unknown) {
  return <span style={{ color: 'var(--color-paper-300)' }}>{String(value)}</span>;
}

/** Tooltip with the shared Workshop Telemetry content/item/label styling baked in. */
export function ChartTooltip(
  props: Omit<ComponentProps<typeof Tooltip>, 'contentStyle' | 'itemStyle' | 'labelStyle'>
) {
  return (
    <Tooltip
      contentStyle={TOOLTIP_STYLE}
      itemStyle={TOOLTIP_ITEM_STYLE}
      labelStyle={TOOLTIP_LABEL_STYLE}
      {...props}
    />
  );
}

/** Axis title props (units) for a Recharts axis; `vertical` rotates it for a Y axis. */
export function axisLabel(value: string, vertical = false) {
  return {
    fill: TOKEN.paper500,
    fontFamily: 'var(--font-sans)',
    fontSize: 11,
    value,
    ...(vertical
      ? { angle: -90, position: 'insideLeft' as const, style: { textAnchor: 'middle' as const } }
      : { offset: -2, position: 'insideBottom' as const }),
  };
}

export interface ChartTableData {
  columns: string[];
  rows: ReactNode[][];
}

/**
 * Wraps a chart so it has a name and a text equivalent: the drawing is one
 * `role="img"` with `ariaLabel` (the title plus a generated summary), and a
 * "View as table" disclosure beside it carries the same numbers as a real
 * table, outside the image so assistive tech can read it cell by cell.
 */
export function ChartFrame({
  ariaLabel,
  children,
  table,
}: {
  ariaLabel: string;
  children: ReactNode;
  table: ChartTableData;
}) {
  return (
    <figure className="m-0">
      <div aria-label={ariaLabel} role="img">
        {children}
      </div>
      <details className="group mt-3 border-t border-ink-600 pt-2 text-xs text-paper-400">
        <summary
          className={cn(
            'inline-flex cursor-pointer select-none items-center gap-1 rounded-sm py-0.5 hover:text-paper-200 [&::-webkit-details-marker]:hidden',
            FOCUS_RING
          )}
        >
          <Icon
            className="transition-transform group-open:rotate-90"
            name="chevronRight"
            size={12}
          />
          View as table
        </summary>
        <div className="mt-2 max-h-64 overflow-auto rounded-md border border-ink-600">
          <table className="w-full text-left text-xs tabular-nums">
            <caption className="sr-only">{ariaLabel}</caption>
            <thead className="sticky top-0 bg-ink-800">
              <tr className="border-b border-ink-600 text-paper-500">
                {table.columns.map((c) => (
                  <th className="px-3 py-1.5 font-medium" key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static rows derived from the chart data
                <tr className="border-b border-ink-700 last:border-0" key={i}>
                  {row.map((cell, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static cells
                    <td className="px-3 py-1.5 text-paper-300" key={j}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

/** How wide one point on a time-series chart is: the gateway buckets long windows by week. */
export type ChartGranularity = 'day' | 'week';

/** The words a chart's summary, table and tooltip use for one point, per granularity. */
export function granularityWords(granularity: ChartGranularity) {
  return granularity === 'week'
    ? { adjective: 'Weekly', dateColumn: 'Week starting (UTC)', plural: 'weeks', singular: 'week' }
    : { adjective: 'Daily', dateColumn: 'Date (UTC)', plural: 'days', singular: 'day' };
}

/** Joins the optional title with a generated summary into an `aria-label`. */
export function chartAriaLabel(title: string | undefined, fallback: string, summary: string) {
  return `${title ?? fallback}. ${summary}`;
}

/** A settled empty result: a compact sentence, not a chart-sized void. */
export function EmptyChart({ label = 'No data yet.', hint }: { label?: string; hint?: string }) {
  return (
    <div className="flex min-h-[160px] flex-col items-center justify-center rounded-lg border border-dashed border-ink-500 bg-ink-900/30 px-4 text-center">
      <span className="mb-2 flex h-8 w-8 items-center justify-center rounded-full border border-ink-400 bg-ink-700 text-paper-500">
        <Icon name="analytics" size={15} />
      </span>
      <p className="text-sm font-medium text-paper-200">{label}</p>
      {hint && <p className="mt-1 text-xs text-paper-500">{hint}</p>}
    </div>
  );
}
