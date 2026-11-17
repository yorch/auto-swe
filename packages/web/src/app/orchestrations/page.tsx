'use client';

import type { OrchestrationSummaryDto } from '@auto-swe/shared/lib/orchestrationApi';
import { useMemo, useState } from 'react';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ORCHESTRATIONS_PAGE_SIZE, useOrchestrations } from '@/hooks/useOrchestrations';
import { useTeams } from '@/hooks/useTeams';
import { formatTotalCost } from '@/lib/utils';

const START_HREF = '/start?mode=orchestrate';

export default function OrchestrationsPage() {
  const [offset, setOffset] = useState(0);
  const orchestrations = useOrchestrations(offset);
  const teams = useTeams();
  const teamNames = useMemo(
    () => new Map((teams.data ?? []).map((t) => [t.id, t.name] as const)),
    [teams.data]
  );
  const rows = orchestrations.data?.rows ?? [];
  const total = orchestrations.data?.total ?? rows.length;

  const columns: DataTableColumn<OrchestrationSummaryDto>[] = [
    {
      cell: (o) => <span className="break-words">{o.title}</span>,
      header: 'Orchestration',
      id: 'title',
      primary: true,
    },
    { cell: (o) => <StatusBadge status={o.status} />, header: 'Status', id: 'status' },
    {
      cell: (o) => (
        <span className="text-paper-300">{o.teamName ?? teamNames.get(o.teamId) ?? 'Team'}</span>
      ),
      header: 'Team',
      id: 'team',
    },
    {
      cell: (o) =>
        o.repoName ? (
          <span className="break-all font-mono text-xs text-paper-300">{o.repoName}</span>
        ) : (
          <span className="text-paper-500">No repository</span>
        ),
      header: 'Repository',
      id: 'repo',
    },
    {
      cell: (o) => (
        <span className="tabular text-paper-200">
          {o.childCount} agent{o.childCount === 1 ? '' : 's'}
          <span className="block text-xs text-paper-500">{o.runningChildCount} running</span>
        </span>
      ),
      header: 'Agents',
      id: 'agents',
    },
    {
      cell: (o) => <span className="tabular text-paper-300">{formatTotalCost(o.costUsd)}</span>,
      header: 'Spend',
      id: 'spend',
    },
    {
      cell: (o) => (
        <span className="whitespace-nowrap text-paper-400">
          <RelativeTime value={o.updatedAt} />
        </span>
      ),
      header: 'Updated',
      id: 'updated',
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          rows.length > 0 && (
            <ButtonLink href={START_HREF} variant="primary">
              <Icon name="plus" size={14} />
              Orchestrate
            </ButtonLink>
          )
        }
        help={
          <p>
            An orchestration is a conversation with an orchestrator that starts and steers other
            agents for you. Only the person who launched one can send messages, attach a repository
            or approve calls; teammates can watch.
          </p>
        }
        subtitle="Conversations that start and steer several agents, with a repository attached only if you say so."
        title="Orchestrations"
      />
      <QueryBoundary
        error={orchestrations.error}
        isError={orchestrations.isError}
        isFetching={orchestrations.isFetching}
        isLoading={orchestrations.isLoading}
        label="orchestrations"
        onRetry={() => void orchestrations.refetch()}
      >
        {rows.length === 0 && offset === 0 ? (
          <EmptyState
            action={
              <ButtonLink href={START_HREF} variant="primary">
                Orchestrate
              </ButtonLink>
            }
            bordered
            hint="Describe a task and the orchestrator splits it across agents you allow."
            icon="agents"
            title="No orchestrations yet"
          />
        ) : (
          <div className="space-y-3">
            <Card className="overflow-hidden p-0">
              <DataTable
                caption="Orchestrations, most recently updated first"
                columns={columns}
                getRowId={(o) => o.id}
                rowHref={(o) => `/orchestrations/${encodeURIComponent(o.id)}`}
                rows={rows}
              />
            </Card>
            <Pagination
              hasNext={offset + ORCHESTRATIONS_PAGE_SIZE < total}
              hasPrev={offset > 0}
              onNext={() => setOffset(offset + ORCHESTRATIONS_PAGE_SIZE)}
              onPrev={() => setOffset(Math.max(0, offset - ORCHESTRATIONS_PAGE_SIZE))}
              rangeEnd={Math.min(offset + rows.length, total)}
              rangeStart={rows.length === 0 ? 0 : offset + 1}
              total={total}
            />
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}
