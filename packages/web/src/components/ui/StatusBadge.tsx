import { cn, STATUS_META } from '@/lib/utils';

export function StatusBadge({ status, showDot = true }: { status: string; showDot?: boolean }) {
  const meta = STATUS_META[status] ?? STATUS_META.UNKNOWN;
  const isLive = meta.live;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]',
        meta.classes
      )}
    >
      {showDot && (
        <span
          aria-hidden
          className={cn(
            'inline-block h-1.5 w-1.5 rounded-full',
            meta.dotClass,
            isLive && 'pulse-dot'
          )}
        />
      )}
      <span>{status.replace(/_/g, ' ').toLowerCase()}</span>
    </span>
  );
}
