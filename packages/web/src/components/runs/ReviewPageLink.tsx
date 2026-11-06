import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { cn, FOCUS_RING } from '@/lib/utils';

/**
 * The link from a run's outcome to the platform's review page for the pull request it opened. The
 * address is built from the platform's own id for the pull request and nothing else, so it stays in
 * the dashboard: no new tab, and no text from the host in it.
 */
export function ReviewPageLink({ pullRequestId }: { pullRequestId: string }) {
  return (
    <Link
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-paper-100 underline-offset-2 hover:underline focus-visible:underline',
        FOCUS_RING
      )}
      href={`/pull-requests/${encodeURIComponent(pullRequestId)}`}
    >
      Open review
      <Icon name="arrowRight" size={13} />
    </Link>
  );
}
