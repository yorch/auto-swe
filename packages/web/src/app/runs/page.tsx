'use client';

import { WORKFLOW_RUN_STATUSES } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Combobox } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useAllWorkflowRuns } from '@/hooks/useRuns';
import { useWorkflowTemplates } from '@/hooks/useTemplates';
import { formatCost, formatDuration, formatRelativeTime } from '@/lib/utils';

const PAGE_SIZE = 50;

export default function WorkflowRunsPage() {
  const [status, setStatus] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [includeChannel, setIncludeChannel] = useState(false);
  const [offset, setOffset] = useState(0);
  const { data: templates = [] } = useWorkflowTemplates();
  const { data, error, isError, isLoading } = useAllWorkflowRuns({
    includeChannel,
    limit: PAGE_SIZE,
    offset,
    status: status || undefined,
    templateId: templateId || undefined,
  });

  const runs = data?.data ?? [];
  const total = data?.meta.total ?? 0;
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <div className="space-y-8">
      <PageHeader
        chapter="§ Workflows"
        subtitle={`Every workflow run, filterable by status and template — ${total} total.`}
        title="Workflow runs"
      />

      <Card variant="inset">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Select
            id="status"
            label="Status"
            onChange={(v) => {
              setStatus(v);
              setOffset(0);
            }}
            options={[
              { label: 'All statuses', value: '' },
              ...WORKFLOW_RUN_STATUSES.map((s) => ({
                label: s.replace(/_/g, ' ').toLowerCase(),
                value: s,
              })),
            ]}
            value={status}
          />
          <Combobox
            id="template"
            label="Template"
            onChange={(v) => {
              setTemplateId(v);
              setOffset(0);
            }}
            options={[
              { label: 'All templates', value: '' },
              ...templates.map((t) => ({ label: t.name, value: t.id })),
            ]}
            value={templateId}
          />
        </div>
        <Checkbox
          checked={includeChannel}
          className="mt-3"
          label="Show channel runs"
          onChange={(e) => {
            setIncludeChannel(e.target.checked);
            setOffset(0);
          }}
        />
      </Card>

      {/* The table keeps its own in-row loading state; the boundary only swaps in
          the error alert, so a 403/500 is not shown as "No runs match". */}
      <QueryBoundary error={error} isError={isError} isLoading={false} label="runs">
        <Card className="p-0 overflow-hidden">
          <Table>
            <THead className="bg-ink-800">
              <Th variant="plain">Ticket</Th>
              <Th variant="plain">Description</Th>
              <Th variant="plain">Template</Th>
              <Th variant="plain">Status</Th>
              <Th variant="plain">Started</Th>
              <Th variant="plain">Duration</Th>
              <Th variant="plain">Cost</Th>
            </THead>
            <tbody>
              {isLoading && (
                <TableStatusRow colSpan={7}>
                  <LoadingState />
                </TableStatusRow>
              )}
              {!isLoading && runs.length === 0 && (
                <TableStatusRow colSpan={7}>
                  <EmptyState title="No runs match these filters." />
                </TableStatusRow>
              )}
              {runs.map((r) => (
                <TRow hover key={r.id}>
                  <Td className="px-4 py-3">
                    <Link
                      className="text-ember-400 hover:underline font-medium"
                      href={`/runs/${r.id}`}
                    >
                      {r.workRequest?.externalTicketId ?? '—'}
                    </Link>
                  </Td>
                  <Td className="px-4 py-3 text-paper-400 truncate max-w-md">
                    {r.workRequest?.description ?? '—'}
                  </Td>
                  <Td className="px-4 py-3 font-mono text-xs text-paper-400">
                    {r.templateName ?? '—'} v{r.templateVersion}
                  </Td>
                  <Td className="px-4 py-3">
                    <StatusBadge status={r.status} />
                  </Td>
                  <Td className="px-4 py-3 text-paper-400">{formatRelativeTime(r.startedAt)}</Td>
                  <Td className="px-4 py-3 font-mono text-xs text-paper-400">
                    {r.endedAt
                      ? formatDuration(
                          // Clamped: start and end are stamped by different processes.
                          Math.max(
                            0,
                            new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime()
                          )
                        )
                      : '—'}
                  </Td>
                  {/* Denormalized when the run finalizes; a running run has not been totalled
                      yet. formatCost renders 0 as '—', which here would read the same way. */}
                  <Td className="px-4 py-3 font-mono text-xs text-paper-400">
                    {r.status === 'RUNNING'
                      ? '—'
                      : r.costUsdAccrued === 0
                        ? '$0.00'
                        : formatCost(r.costUsdAccrued)}
                  </Td>
                </TRow>
              ))}
            </tbody>
          </Table>
        </Card>

        <Pagination
          hasNext={hasNext}
          hasPrev={hasPrev}
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
