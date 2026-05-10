import { cn, STATUS_COLORS } from '@/lib/utils';

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium',
        STATUS_COLORS[status] ?? 'bg-gray-100 text-gray-800'
      )}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}
