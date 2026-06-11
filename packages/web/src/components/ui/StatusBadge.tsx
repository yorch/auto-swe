import { cn, STATUS_META } from '@/lib/utils';

export function StatusBadge({ status, showDot = true }: { status: string; showDot?: boolean }) {
  const meta = STATUS_META[status] ?? STATUS_META.UNKNOWN;
  const isLive = meta.live;

  return (
    <span
      className={cn('inline-flex items-center gap-1.5 border px-1.5 py-0.5', meta.classes)}
      style={{
        borderRadius: '2px',
        fontFamily: 'var(--font-mono)',
        fontSize: '9.5px',
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
      }}
    >
      {showDot && (
        <span
          aria-hidden
          className={cn(
            'inline-block h-[5px] w-[5px] rounded-full shrink-0',
            meta.dotClass,
            isLive && 'pulse-dot'
          )}
        />
      )}
      <span>{status.replace(/_/g, ' ').toLowerCase()}</span>
    </span>
  );
}
