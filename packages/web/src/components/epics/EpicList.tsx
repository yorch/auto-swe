import type { EpicSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { cn, FOCUS_RING } from '@/lib/utils';

/** The epics list, shared by the Epics page and the Requests "Epics" type filter. */
export function EpicList({ epics }: { epics: EpicSummary[] }) {
  return (
    <Card className="overflow-hidden p-0">
      <Table stacked>
        <caption className="sr-only">Multi-repository epics, newest first</caption>
        <THead>
          <Th variant="plain">Epic</Th>
          <Th variant="plain">Status</Th>
          <Th align="right" variant="plain">
            Repositories
          </Th>
          <Th variant="plain">Requested by</Th>
          <Th variant="plain">Created</Th>
        </THead>
        <tbody>
          {epics.map((epic) => (
            <TRow hover key={epic.workRequestId}>
              <Td className="max-w-xl px-4 py-3" primary>
                <Link
                  className={cn(
                    'rounded-sm font-mono text-[13px] font-medium text-paper-100 hover:text-ember-300 hover:underline',
                    FOCUS_RING
                  )}
                  href={`/epics/${encodeURIComponent(epic.epicWorkflowId)}`}
                >
                  {epic.externalTicketId}
                </Link>
                {epic.description && (
                  <div className="mt-0.5 line-clamp-1 break-words text-xs font-normal text-paper-400">
                    {epic.description}
                  </div>
                )}
              </Td>
              <Td className="px-4 py-3" label="Status">
                <StatusBadge status={epic.status} />
              </Td>
              <Td align="right" className="tabular px-4 py-3 text-paper-200" label="Repositories">
                {epic.repoCount}
              </Td>
              <Td className="px-4 py-3 text-paper-300" label="Requested by">
                {epic.requestedBy ? (
                  (epic.requestedBy.name ?? epic.requestedBy.email)
                ) : (
                  <span className="text-paper-500">—</span>
                )}
              </Td>
              <Td className="whitespace-nowrap px-4 py-3 text-paper-400" label="Created">
                <RelativeTime value={epic.createdAt} />
              </Td>
            </TRow>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
