import type { EpicSummary } from '@auto-swe/shared/types/api';
import { Card } from '@/components/ui/Card';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { StatusBadge } from '@/components/ui/StatusBadge';

const COLUMNS: DataTableColumn<EpicSummary>[] = [
  {
    cell: (epic) => <span className="font-mono text-sm">{epic.externalTicketId}</span>,
    header: 'Epic',
    id: 'epic',
    primary: true,
    secondary: (epic) =>
      epic.description ? (
        <span className="line-clamp-1 break-words">{epic.description}</span>
      ) : null,
  },
  { cell: (epic) => <StatusBadge status={epic.status} />, header: 'Status', id: 'status' },
  {
    align: 'right',
    cell: (epic) => <span className="tabular text-paper-200">{epic.repoCount}</span>,
    header: 'Repositories',
    id: 'repositories',
  },
  {
    cell: (epic) =>
      epic.requestedBy ? (
        <span className="text-paper-300">{epic.requestedBy.name ?? epic.requestedBy.email}</span>
      ) : (
        <span className="text-paper-500">—</span>
      ),
    header: 'Requested by',
    id: 'requested-by',
  },
  {
    cell: (epic) => (
      <span className="whitespace-nowrap text-paper-400">
        <RelativeTime value={epic.createdAt} />
      </span>
    ),
    header: 'Created',
    id: 'created',
  },
];

/** The epics list, shared by the Epics page and the Requests "Epics" type filter. */
export function EpicList({ epics }: { epics: EpicSummary[] }) {
  return (
    <Card className="overflow-hidden p-0">
      <DataTable
        caption="Multi-repository epics, newest first"
        columns={COLUMNS}
        getRowId={(epic) => epic.workRequestId}
        rowHref={(epic) => `/epics/${encodeURIComponent(epic.epicWorkflowId)}`}
        rows={epics}
      />
    </Card>
  );
}
