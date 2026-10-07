'use client';

import { useEffect, useState } from 'react';
import { type DateRange, isIsoDay, MAX_SPAN_DAYS, utcDay } from '@/lib/dateRange';
import { cn } from '@/lib/utils';
import { Button } from './Button';
import { SegmentedControl } from './SegmentedControl';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The time range of a govern data page: day presets plus (where the data
 * source can serve it) a custom span. Days are UTC and the control says so
 * where the dates are read, rather than only in a tooltip.
 */
export function DateRangeControl({
  allowAll = false,
  allowCustom = true,
  className,
  maxSpanDays = MAX_SPAN_DAYS,
  onChange,
  presets = [7, 30, 90],
  rangeIgnored = false,
  value,
}: {
  /** Offers "All time"; the value is then `null` for no date filter. */
  allowAll?: boolean;
  allowCustom?: boolean;
  className?: string;
  /** The longest custom span the data source serves. */
  maxSpanDays?: number;
  onChange: (range: DateRange | null) => void;
  presets?: readonly number[];
  /** The link asked for a custom range this page cannot serve, so a default is shown. */
  rangeIgnored?: boolean;
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
  const tooLong =
    isIsoDay(from) &&
    isIsoDay(to) &&
    from <= to &&
    Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1 > maxSpanDays;
  const invalid = !isIsoDay(from) || !isIsoDay(to) || from > to || to > today || tooLong;
  const selected =
    customOpen || value?.kind === 'custom' ? 'custom' : value ? String(value.days) : 'all';
  const inputClass =
    'h-8 rounded-md border border-ink-400 bg-ink-900/60 px-2.5 text-[13px] text-paper-100 outline-none transition-colors hover:border-ink-300 focus:border-ember-400 focus:ring-2 focus:ring-ember-400/20';

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
          <Button
            disabled={invalid}
            onClick={() => onChange({ from, kind: 'custom', to })}
            size="sm"
          >
            Apply
          </Button>
          <span className="text-xs text-paper-500">Dates are UTC</span>
          {isIsoDay(from) && isIsoDay(to) && (from > to || to > today || tooLong) && (
            <span className="w-full text-xs text-brick-400" role="alert">
              {from > to
                ? 'The start date must be on or before the end date.'
                : to > today
                  ? 'The end date cannot be in the future.'
                  : `The range can span at most ${maxSpanDays} days.`}
            </span>
          )}
        </div>
      )}
      {rangeIgnored && (
        <span className="w-full text-xs text-paper-400" role="status">
          The date range in that link isn't available here, so the default range is shown.
        </span>
      )}
    </div>
  );
}
