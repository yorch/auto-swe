import { cn, STATUS_META } from '@/lib/utils';

/**
 * A run, step or template status as a coloured dot and its name — no bordered or
 * filled pill. The dot carries the status colour (and pulses while the work is
 * live); the words carry the meaning in body colour, so the state is never colour
 * alone and a table of statuses reads calmly.
 */
export function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.UNKNOWN;

  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-paper-300">
      <span
        aria-hidden
        className={cn(
          'inline-block h-2 w-2 shrink-0 rounded-full',
          meta.dotClass,
          meta.live && 'pulse-dot'
        )}
      />
      {/* Lower-cased text, shown sentence-case: `first-letter` needs a block box. */}
      <span className="inline-block first-letter:uppercase">
        {status.replace(/_/g, ' ').toLowerCase()}
      </span>
    </span>
  );
}
