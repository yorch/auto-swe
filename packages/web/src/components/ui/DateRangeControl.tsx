'use client';

import { useEffect, useState } from 'react';
import { type DateRange, isIsoDay, utcDay } from '@/lib/dateRange';
import { cn } from '@/lib/utils';
import { SegmentedControl } from './SegmentedControl';

/**
 * The time range of a govern data page: day presets plus (where the data
 * source can serve it) a custom span. Days are UTC and the control says so
 * where the dates are read, rather than only in a tooltip.
 */
export function DateRangeControl({
  allowCustom = true,
  className,
  onChange,
  presets = [7, 30, 90],
  value,
}: {
  allowCustom?: boolean;
  className?: string;
  onChange: (range: DateRange) => void;
  presets?: readonly number[];
  value: DateRange;
}) {
  const options = [
    ...presets.map((d) => ({ label: `${d}d`, title: `Last ${d} days`, value: String(d) })),
    ...(allowCustom ? [{ label: 'Custom', title: 'Pick a date range', value: 'custom' }] : []),
  ];
  const [customOpen, setCustomOpen] = useState(value.kind === 'custom');
  const [from, setFrom] = useState(value.kind === 'custom' ? value.from : '');
  const [to, setTo] = useState(value.kind === 'custom' ? value.to : '');
  useEffect(() => {
    if (value.kind === 'custom') {
      setCustomOpen(true);
      setFrom(value.from);
      setTo(value.to);
    }
  }, [value]);

  const today = utcDay(new Date());
  const invalid = !isIsoDay(from) || !isIsoDay(to) || from > to || to > today;
  const selected = customOpen || value.kind === 'custom' ? 'custom' : String(value.days);
  const inputClass =
    'h-8 rounded-[9px] border border-ink-400 bg-ink-900/60 px-2 font-mono text-xs text-paper-100 outline-none focus:border-ember-400';

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <SegmentedControl
        ariaLabel="Date range"
        onChange={(v) => {
          if (v === 'custom') {
            setCustomOpen(true);
            return;
          }
          setCustomOpen(false);
          onChange({ days: Number(v), kind: 'preset' });
        }}
        options={options}
        value={selected}
      />
      {allowCustom && selected === 'custom' && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="From date (UTC)"
            className={inputClass}
            max={today}
            onChange={(e) => setFrom(e.target.value)}
            type="date"
            value={from}
          />
          <span className="text-xs text-paper-500">to</span>
          <input
            aria-label="To date (UTC)"
            className={inputClass}
            max={today}
            onChange={(e) => setTo(e.target.value)}
            type="date"
            value={to}
          />
          <button
            className="h-8 rounded-[9px] border border-ink-400 px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-paper-200 hover:bg-ink-600/50 disabled:opacity-40"
            disabled={invalid}
            onClick={() => onChange({ from, kind: 'custom', to })}
            type="button"
          >
            Apply
          </button>
          <span className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
            Dates are UTC
          </span>
        </div>
      )}
    </div>
  );
}
