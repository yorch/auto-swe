/** Shared Recharts styling tokens for the Workshop Telemetry palette. */

export const AXIS_TICK = {
  fill: '#a8a395', // paper-400
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
};

export const AXIS_LINE = {
  stroke: '#2a323f', // ink-500
};

export const GRID_STROKE = '#1f2530'; // ink-600

export const TOOLTIP_STYLE: React.CSSProperties = {
  background: '#0b0e13', // ink-900
  border: '1px solid #2a323f', // ink-500
  borderRadius: 2,
  color: '#f2ede2', // paper-200
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.04em',
  padding: '8px 10px',
};

export const TOOLTIP_LABEL_STYLE: React.CSSProperties = {
  color: '#a8a395', // paper-400
  fontSize: 10,
  letterSpacing: '0.14em',
  marginBottom: 4,
  textTransform: 'uppercase',
};

export const TOOLTIP_ITEM_STYLE: React.CSSProperties = {
  color: '#f2ede2', // paper-200
};

export const LEGEND_STYLE: React.CSSProperties = {
  color: '#a8a395', // paper-400
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
};

export function EmptyChart({ label = 'no data' }: { label?: string }) {
  return (
    <div className="flex h-[200px] items-center justify-center font-mono text-[11px] uppercase tracking-[0.18em] text-paper-500">
      <span>— {label} —</span>
    </div>
  );
}
