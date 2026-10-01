'use client';

import Link from 'next/link';
import { use, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  TemplateBackLink,
  TemplateNotFound,
  TemplateSubNav,
} from '@/components/workflow/templateNav';
import { useAllWorkflowRuns } from '@/hooks/useRuns';
import { useWorkflowTemplate } from '@/hooks/useTemplates';
import { validateRouteParam } from '@/lib/routeParams';
import { isRunStatus, runStatusOptions } from '@/lib/runStatusOptions';
import { formatDate, formatDuration, formatRelativeTime } from '@/lib/utils';

interface PageProps {
  params: Promise<{ id: string }>;
}

const PAGE_SIZE = 20;

const RUN_STATUSES = runStatusOptions();

function runDuration(start: string, end: string | null): string {
  if (!end) {
    return 'running';
  }
  return formatDuration(new Date(end).getTime() - new Date(start).getTime());
}

export default function TemplateRunsPage({ params }: PageProps) {
  const { id: rawId } = use(params);
  const id = validateRouteParam(rawId);
  const { data: template } = useWorkflowTemplate(id ?? '');
  const [offset, setOffset] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [versionFilter, setVersionFilter] = useState('');

  // Status is filtered server-side so pagination and the total reflect it;
  // the run list endpoint takes the template as a filter too.
  const { data, error, isError, isLoading } = useAllWorkflowRuns({
    limit: PAGE_SIZE,
    offset,
    status: isRunStatus(statusFilter) ? statusFilter : undefined,
    templateId: id ?? undefined,
  });

  const rows = data?.data ?? [];
  const total = data?.meta.total ?? 0;

  const versions = useMemo(() => {
    const seen = new Set<number>();
    for (const r of rows) {
      seen.add(r.templateVersion);
    }
    return [...seen].sort((a, b) => b - a);
  }, [rows]);

  const filteredRows = useMemo(
    () =>
      // Version stays a filter over the current page: the endpoint has no
      // version parameter.
      rows.filter((r) => !versionFilter || r.templateVersion === Number(versionFilter)),
    [rows, versionFilter]
  );

  const handlePrev = () => setOffset(Math.max(0, offset - PAGE_SIZE));
  const handleNext = () => setOffset(offset + PAGE_SIZE);

  if (!id) {
    return <TemplateNotFound />;
  }

  return (
    <div className="space-y-8">
      <div>
        <TemplateBackLink href={`/workflows/library/${id}`} label={template?.name ?? 'Template'} />
        <PageHeader
          chapter="§ Workflows"
          className="mb-0 mt-4"
          subtitle="Every execution of this template, newest first. Click a row to drill into a specific run."
          title="Run history"
        />
      </div>

      <TemplateSubNav active="runs" templateId={id} />

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <Select
          className="w-auto"
          compact
          id="run-status-filter"
          label="Status"
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setOffset(0);
          }}
          value={statusFilter}
        >
          {RUN_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
        {versions.length > 1 && (
          <Select
            className="w-auto"
            compact
            id="run-version-filter"
            label="Template version"
            onChange={(e) => {
              setVersionFilter(e.target.value);
              setOffset(0);
            }}
            value={versionFilter}
          >
            <option value="">All versions</option>
            {versions.map((v) => (
              <option key={v} value={v}>
                v{v}
              </option>
            ))}
          </Select>
        )}
        {(statusFilter || versionFilter) && (
          <Button
            onClick={() => {
              setStatusFilter('');
              setVersionFilter('');
              setOffset(0);
            }}
            size="sm"
            variant="ghost"
          >
            Clear filters
          </Button>
        )}
        {versionFilter && (
          <span className="font-mono text-[11px] text-paper-500">
            {filteredRows.length} of {rows.length} on this page shown — the version filter applies
            to the current page only
          </span>
        )}
      </div>

      <QueryBoundary
        error={error}
        isError={isError}
        isLoading={isLoading}
        label="runs"
        loadingMessage="loading runs…"
      >
        <Card className="overflow-hidden p-0" variant="inset">
          <Table>
            <THead>
              <Th>Started</Th>
              <Th>Status</Th>
              <Th>Template ver.</Th>
              <Th>Work request</Th>
              <Th align="right">Duration</Th>
            </THead>
            <tbody>
              {filteredRows.map((r) => (
                <TRow className="hover:bg-ink-700/40" hover key={r.id}>
                  <Td className="px-4 py-3">
                    <Link className="text-paper-100 hover:text-ember-400" href={`/runs/${r.id}`}>
                      {formatDate(r.startedAt)}
                    </Link>
                    <div className="font-mono text-[11px] text-paper-500">
                      {formatRelativeTime(r.startedAt)}
                    </div>
                  </Td>
                  <Td className="px-4 py-3">
                    <StatusBadge status={r.status} />
                  </Td>
                  <Td className="px-4 py-3 font-mono text-xs text-paper-300">
                    v{r.templateVersion}
                  </Td>
                  <Td className="px-4 py-3 text-xs">
                    {r.workRequest ? (
                      <>
                        <div className="font-mono text-paper-100">
                          {r.workRequest.externalTicketId}
                        </div>
                        <div className="max-w-md truncate text-paper-500">
                          {r.workRequest.description}
                        </div>
                      </>
                    ) : (
                      <span className="font-mono text-[11px] uppercase tracking-wider text-paper-500">
                        —
                      </span>
                    )}
                  </Td>
                  <Td align="right" className="tabular px-4 py-3 font-mono text-xs">
                    {r.endedAt === null ? (
                      <Badge className="text-xs" dot="pulse" tone="ember" variant="text">
                        running
                      </Badge>
                    ) : (
                      <span className="text-paper-300">{runDuration(r.startedAt, r.endedAt)}</span>
                    )}
                  </Td>
                </TRow>
              ))}
              {filteredRows.length === 0 && (
                <TableStatusRow colSpan={5}>
                  <EmptyState
                    title={
                      rows.length === 0 && !statusFilter
                        ? 'No runs yet — start a new request to trigger one.'
                        : 'No runs on this page match the current filters.'
                    }
                  />
                </TableStatusRow>
              )}
            </tbody>
          </Table>
        </Card>

        {total > PAGE_SIZE && (
          <div>
            <Pagination
              hasNext={offset + PAGE_SIZE < total}
              hasPrev={offset > 0}
              onNext={handleNext}
              onPrev={handlePrev}
              rangeEnd={Math.min(offset + PAGE_SIZE, total)}
              rangeStart={offset + 1}
              total={total}
            />
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}
