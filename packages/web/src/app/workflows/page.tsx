'use client';

import type { WorkflowTemplateSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { NewRequestModal } from '@/components/workflow/NewRequestModal';
import { RunTemplateModal } from '@/components/workflow/RunTemplateModal';
import { useAllWorkflowRuns } from '@/hooks/useRuns';

type Scope = 'ALL' | 'MINE' | 'TEAM';

const SCOPE_OPTIONS: { value: Scope; label: string }[] = [
  { label: 'All', value: 'ALL' },
  { label: 'Mine', value: 'MINE' },
  { label: 'Team', value: 'TEAM' },
];

const PAGE_SIZE = 50;

function OutcomeCell({
  outcomeDomain,
  outcomeType,
  status,
}: {
  outcomeDomain: string | null;
  outcomeType: string | null;
  status: string;
}) {
  if (outcomeDomain) {
    return (
      <span className="text-paper-400">
        {outcomeDomain}
        {outcomeType ? <span className="text-paper-500"> · {outcomeType}</span> : null}
      </span>
    );
  }
  if (status === 'SUCCESS') {
    return <span className="text-paper-400">completed</span>;
  }
  return <span className="text-paper-600">—</span>;
}

export default function WorkflowsPage() {
  const [scope, setScope] = useState<Scope>('MINE');
  const [offset, setOffset] = useState(0);
  const { data, error, isError, isLoading } = useAllWorkflowRuns({
    limit: PAGE_SIZE,
    offset,
    scope,
  });
  const [newOpen, setNewOpen] = useState(false);
  const [runTarget, setRunTarget] = useState<WorkflowTemplateSummary | null>(null);
  const runs = data?.data ?? [];
  const total = data?.meta.total ?? 0;

  return (
    <div className="space-y-8">
      <PageHeader
        actions={
          <Button onClick={() => setNewOpen(true)} variant="primary">
            New request
          </Button>
        }
        chapter="§ Requests"
        subtitle="Work requests and the workflow runs they started."
        title="Request queue"
      />
      <NewRequestModal
        onClose={() => setNewOpen(false)}
        onSelect={(t) => {
          setRunTarget(t);
          setNewOpen(false);
        }}
        open={newOpen}
      />
      {runTarget && (
        <RunTemplateModal onClose={() => setRunTarget(null)} open template={runTarget} />
      )}

      <SegmentedControl
        ariaLabel="Request scope"
        onChange={(s) => {
          setScope(s);
          setOffset(0);
        }}
        options={SCOPE_OPTIONS}
        value={scope}
      />

      <QueryBoundary error={error} isError={isError} isLoading={isLoading} label="requests">
        <Card className="overflow-hidden p-0">
          <Table>
            <THead className="bg-ink-800">
              <Th variant="plain">Label</Th>
              <Th variant="plain">Workflow</Th>
              <Th variant="plain">Domain</Th>
              <Th variant="plain">Status</Th>
              <Th variant="plain">Outcome</Th>
            </THead>
            <tbody>
              {runs.length === 0 && (
                <TableStatusRow colSpan={5}>
                  <EmptyState title="No requests in this scope." />
                </TableStatusRow>
              )}
              {runs.map((r) => (
                <TRow hover key={r.id}>
                  <Td className="px-4 py-3">
                    <Link
                      className="font-medium text-ember-400 hover:underline"
                      href={`/runs/${r.id}`}
                    >
                      {r.workRequest?.description || r.workRequest?.externalTicketId || '—'}
                    </Link>
                  </Td>
                  <Td className="px-4 py-3 text-paper-400">{r.templateName ?? '—'}</Td>
                  <Td className="px-4 py-3 text-paper-400">{r.domain ?? '—'}</Td>
                  <Td className="px-4 py-3">
                    <StatusBadge status={r.status} />
                  </Td>
                  <Td className="px-4 py-3">
                    <OutcomeCell
                      outcomeDomain={r.outcomeDomain}
                      outcomeType={r.outcomeType}
                      status={r.status}
                    />
                  </Td>
                </TRow>
              ))}
            </tbody>
          </Table>
        </Card>
        <Pagination
          hasNext={offset + PAGE_SIZE < total}
          hasPrev={offset > 0}
          onNext={() => setOffset((o) => o + PAGE_SIZE)}
          onPrev={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
          rangeEnd={Math.min(offset + PAGE_SIZE, total)}
          rangeStart={total === 0 ? 0 : offset + 1}
          total={total}
        />
      </QueryBoundary>
    </div>
  );
}
