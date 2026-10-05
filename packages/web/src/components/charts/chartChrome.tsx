/** Shared Recharts styling tokens for the Workshop Telemetry palette. */
import type { ComponentProps, ReactNode } from 'react';
import { Tooltip } from 'recharts';
import { TOKEN } from '@/lib/palette';

const AXIS_TICK = {
  fill: TOKEN.paper400,
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
};

export const AXIS_LINE = {
  stroke: TOKEN.ink500,
};

export const GRID_STROKE = TOKEN.ink600;

/** Shared axisLine/tick/tickLine props for a value (numeric) axis. */
export const AXIS_COMMON_PROPS = {
  axisLine: AXIS_LINE,
  tick: AXIS_TICK,
  tickLine: AXIS_LINE,
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

const TOOLTIP_STYLE: React.CSSProperties = {
  background: TOKEN.ink900,
  border: `1px solid ${TOKEN.ink500}`,
  borderRadius: 2,
  color: TOKEN.paper200,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.04em',
  padding: '8px 10px',
};

const TOOLTIP_LABEL_STYLE: React.CSSProperties = {
  color: TOKEN.paper400,
  fontSize: 10,
  letterSpacing: '0.14em',
  marginBottom: 4,
  textTransform: 'uppercase',
};

const TOOLTIP_ITEM_STYLE: React.CSSProperties = {
  color: TOKEN.paper200,
};

export const LEGEND_STYLE: React.CSSProperties = {
  color: TOKEN.paper400,
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
};

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
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.08em',
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
      <details className="mt-2 text-xs text-paper-400">
        <summary className="cursor-pointer select-none hover:text-paper-200">View as table</summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full text-left font-mono text-[11px]">
            <caption className="sr-only">{ariaLabel}</caption>
            <thead>
              <tr className="border-b border-ink-600 text-paper-500">
                {table.columns.map((c) => (
                  <th className="px-2 py-1 font-medium" key={c} scope="col">
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
                    <td className="px-2 py-1 text-paper-300" key={j}>
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

/** Joins the optional title with a generated summary into an `aria-label`. */
export function chartAriaLabel(title: string | undefined, fallback: string, summary: string) {
  return `${title ?? fallback}. ${summary}`;
}

/** A settled empty result: a compact sentence, not a chart-sized void. */
export function EmptyChart({ label = 'No data yet.', hint }: { label?: string; hint?: string }) {
  return (
    <div className="flex min-h-[120px] flex-col items-center justify-center text-center">
      <p className="text-sm text-paper-300">{label}</p>
      {hint && <p className="mt-1 text-xs text-paper-500">{hint}</p>}
    </div>
  );
}
