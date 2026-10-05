import type { EpicSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { formatRelativeTime } from '@/lib/utils';

/** The epics list, shared by the Epics page and the Requests "Epics" type filter. */
export function EpicList({ epics }: { epics: EpicSummary[] }) {
  return (
    <Card className="overflow-hidden p-0">
      <ul className="divide-y divide-ink-600">
        {epics.map((epic) => (
          <li key={epic.workRequestId}>
            <Link
              className="block px-5 py-4 transition-colors hover:bg-ink-700 focus-visible:outline-2 focus-visible:outline-ember-400 focus-visible:-outline-offset-2"
              href={`/epics/${encodeURIComponent(epic.epicWorkflowId)}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-ember-400">
                    {epic.externalTicketId}
                  </div>
                  <div className="mt-1 line-clamp-2 break-words text-sm text-paper-400">
                    {epic.description}
                  </div>
                </div>
                <StatusBadge status={epic.status} />
              </div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-paper-400">
                <span>
                  {epic.repoCount} {epic.repoCount === 1 ? 'repository' : 'repositories'}
                </span>
                <span>Created {formatRelativeTime(epic.createdAt)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
