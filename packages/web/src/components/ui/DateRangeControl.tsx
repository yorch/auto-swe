'use client';

import { useEffect, useState } from 'react';
import { type DateRange, isIsoDay, utcDay } from '@/lib/dateRange';
import { cn, FOCUS_RING } from '@/lib/utils';
import { SegmentedControl } from './SegmentedControl';

/**
 * The time range of a govern data page: day presets plus (where the data
 * source can serve it) a custom span. Days are UTC and the control says so
 * where the dates are read, rather than only in a tooltip.
 */
export function DateRangeControl({
  allowAll = false,
  allowCustom = true,
  className,
  onChange,
  presets = [7, 30, 90],
  value,
}: {
  /** Offers "All time"; the value is then `null` for no date filter. */
  allowAll?: boolean;
  allowCustom?: boolean;
  className?: string;
  onChange: (range: DateRange | null) => void;
  presets?: readonly number[];
  value: DateRange | null;
}) {
  const options = [
    ...(allowAll ? [{ label: 'All', title: 'All time', value: 'all' }] : []),
    ...presets.map((d) => ({ label: `${d}d`, title: `Last ${d} days`, value: String(d) })),
    ...(allowCustom ? [{ label: 'Custom', title: 'Pick a date range', value: 'custom' }] : []),
  ];
  const [customOpen, setCustomOpen] = useState(value?.kind === 'custom');
  const [from, setFrom] = useState(value?.kind === 'custom' ? value.from : '');
  const [to, setTo] = useState(value?.kind === 'custom' ? value.to : '');
  // Keyed on what the range IS: the parent re-parses the URL every render, so the object
  // changes identity constantly and must not decide when the editor opens or closes.
  const valueKey = !value
    ? 'all'
    : value.kind === 'custom'
      ? `custom:${value.from}:${value.to}`
      : `preset:${value.days}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `valueKey` stands for `value`
  useEffect(() => {
    if (value?.kind === 'custom') {
      setCustomOpen(true);
      setFrom(value.from);
      setTo(value.to);
    } else {
      // A preset (or all time) became the value: the custom editor has done its job.
      setCustomOpen(false);
    }
  }, [valueKey]);

  const today = utcDay(new Date());
  const invalid = !isIsoDay(from) || !isIsoDay(to) || from > to || to > today;
  const selected =
    customOpen || value?.kind === 'custom' ? 'custom' : value ? String(value.days) : 'all';
  const inputClass =
    'h-8 rounded-md border border-ink-400 bg-ink-900/60 px-2 font-mono text-xs text-paper-100 outline-none focus:border-ember-400';

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
          onChange(v === 'all' ? null : { days: Number(v), kind: 'preset' });
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
            className={cn(
              'h-8 rounded-md border border-ink-400 px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-paper-200 hover:bg-ink-600/50 disabled:opacity-40',
              FOCUS_RING
            )}
            disabled={invalid}
            onClick={() => onChange({ from, kind: 'custom', to })}
            type="button"
          >
            Apply
          </button>
          <span className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
            Dates are UTC
          </span>
          {isIsoDay(from) && isIsoDay(to) && (from > to || to > today) && (
            <span className="w-full text-xs text-brick-400" role="alert">
              {from > to
                ? 'The start date must be on or before the end date.'
                : 'The end date cannot be in the future.'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
