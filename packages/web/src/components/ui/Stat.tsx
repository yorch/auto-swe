import { cn } from '@/lib/utils';

type StatTone = 'default' | 'ember' | 'moss' | 'amber' | 'brick' | 'dust';

const TONE: Record<StatTone, string> = {
  amber: 'text-amber-400',
  brick: 'text-brick-400',
  default: 'text-paper-100',
  dust: 'text-dust-400',
  ember: 'text-ember-400',
  moss: 'text-moss-400',
};

export function Stat({
  label,
  value,
  unit,
  tone = 'default',
  delta,
  className,
}: {
  label: string;
  value: string | number;
  unit?: string;
  tone?: StatTone;
  delta?: { value: string; positive?: boolean } | null;
  className?: string;
}) {
  return (
    <div className={cn('border-l border-ink-400 pl-5 py-1', className)}>
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-paper-500">{label}</div>
      <div className="mt-3 flex items-baseline gap-1.5">
        <span
          className={cn('tabular text-[40px] leading-none font-bold tracking-tight', TONE[tone])}
        >
          {value}
        </span>
        {unit && (
          <span className="font-mono text-[11px] uppercase tracking-wider text-paper-500">
            {unit}
          </span>
        )}
      </div>
      {delta && (
        <div
          className={cn(
            'mt-2 font-mono text-[10px] uppercase tracking-wider',
            delta.positive ? 'text-moss-400' : 'text-brick-400'
          )}
        >
          {delta.positive ? '▲' : '▼'} {delta.value}
        </div>
      )}
    </div>
  );
}
