import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './Icon';

type StatTone = 'default' | 'muted' | 'ember' | 'moss' | 'amber' | 'brick' | 'dust';

const TONE: Record<StatTone, string> = {
  amber: 'text-amber-400',
  brick: 'text-brick-400',
  default: 'text-paper-100',
  dust: 'text-dust-400',
  ember: 'text-ember-400',
  moss: 'text-moss-400',
  muted: 'text-paper-500',
};

export function Stat({
  label,
  value,
  unit,
  tone = 'default',
  delta,
  hint,
  className,
}: {
  label: string;
  value: string | number;
  unit?: string;
  tone?: StatTone;
  delta?: { value: string; positive?: boolean } | null;
  /** A quiet secondary line under the value (next run, a usage breakdown). */
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0 break-words border-l-2 border-ink-500 py-1 pl-4', className)}>
      <div className="text-[13px] font-medium text-paper-400">{label}</div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span
          className={cn('text-[30px] leading-none font-semibold tracking-[-0.02em]', TONE[tone])}
        >
          {value}
        </span>
        {unit && <span className="text-[13px] text-paper-500">{unit}</span>}
      </div>
      {delta && (
        <div
          className={cn(
            'mt-2 inline-flex items-center gap-1 text-xs font-medium',
            delta.positive ? 'text-moss-400' : 'text-brick-400'
          )}
        >
          <Icon name={delta.positive ? 'arrowUp' : 'arrowDown'} size={12} strokeWidth={2.2} />
          <span className="sr-only">{delta.positive ? 'Up' : 'Down'}</span>
          {delta.value}
        </div>
      )}
      {hint && <div className="mt-2 text-xs leading-relaxed text-paper-500">{hint}</div>}
    </div>
  );
}
