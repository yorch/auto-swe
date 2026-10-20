'use client';

import { KNOWN_RISK_CLASSES } from '@auto-swe/shared/lib/autonomyPolicy';
import Link from 'next/link';
import { BackLink } from '@/components/ui/BackLink';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Select } from '@/components/ui/Select';
import { useAutonomyDecisions, useAutonomyPolicies } from '@/hooks/useAutonomyPolicies';
import { parseOffset, useUrlFilters } from '@/hooks/useUrlFilters';
import { useUsers } from '@/hooks/useUsers';
import { eventLabel, KNOWN_AUTONOMY_EVENTS, riskClassLabel } from '@/lib/autonomyEvents';
import { HELP_LINKS } from '@/lib/helpLinks';
import { cn, FOCUS_RING } from '@/lib/utils';

const LIMIT = 50;

/** Approvals read as go, rejections as stop; anything else stays neutral. */
const EVENT_TONE: Record<string, BadgeTone> = {
  approve: 'success',
  approve_partial: 'warning',
  publish: 'info',
  reject: 'danger',
  request_changes: 'warning',
};

type Filters = {
  actorId: string;
  event: string;
  policyName: string;
  riskClass: string;
  runId: string;
};

const EMPTY: Filters = { actorId: '', event: '', policyName: '', riskClass: '', runId: '' };

const FILTER_KEYS = ['policyName', 'riskClass', 'event', 'actorId', 'runId'] as const;

export default function AutonomyDecisionsPage() {
  const { params, update } = useUrlFilters();
  // Filters and page live in the URL, so a filtered view can be shared and survives a reload.
  const filters: Filters = {
    actorId: params.get('actorId') ?? '',
    event: params.get('event') ?? '',
    policyName: params.get('policyName') ?? '',
    riskClass: params.get('riskClass') ?? '',
    runId: params.get('runId') ?? '',
  };
  const offset = parseOffset(params.get('offset'));

  const { data, isLoading, isError, isFetching, refetch, error } = useAutonomyDecisions({
    ...filters,
    limit: LIMIT,
    offset,
  });
  const { data: policies } = useAutonomyPolicies();
  const { data: users } = useUsers();
  const emailById = new Map((users ?? []).map((u) => [u.id, u.email]));

  function navigate(next: Partial<Filters> & { offset?: number }) {
    const { offset: nextOffset, ...changed } = next;
    update({ ...changed, offset: nextOffset ? String(nextOffset) : null });
  }

  // A filter change goes back to the first page.
  const setFilter = (key: keyof Filters, value: string) => navigate({ [key]: value, offset: 0 });

  const total = data?.meta.total ?? 0;
  const hasMore = offset + (data?.data.length ?? 0) < total;
  const anyFilter = FILTER_KEYS.some((k) => filters[k]);

  const eventOptions = [
    ...new Set([...KNOWN_AUTONOMY_EVENTS, ...(data?.data ?? []).map((r) => r.event)]),
  ].map((value) => ({ label: eventLabel(value), value }));
  const policyNames = [...new Set((policies ?? []).map((p) => p.name))].sort();

  return (
    <div className="space-y-6">
      <BackLink href="/admin/policies" label="Autonomy policies" />
      <PageHeader
        learnMore={{ ...HELP_LINKS.autonomyPolicyDecisionLog, label: 'About the decision log' }}
        subtitle="Every automatic or approval-required decision the autonomy policies made, newest first."
        title="Autonomy decisions"
      />

      <Card className="p-4 sm:p-6">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Select
            label="Policy"
            onChange={(v) => setFilter('policyName', v)}
            options={[
              { label: 'All policies', value: '' },
              ...policyNames.map((n) => ({ label: n, value: n })),
            ]}
            value={filters.policyName}
          />
          <Select
            label="Risk class"
            onChange={(v) => setFilter('riskClass', v)}
            options={[
              { label: 'All risk classes', value: '' },
              ...KNOWN_RISK_CLASSES.map((c) => ({ label: c.label, value: c.key })),
            ]}
            value={filters.riskClass}
          />
          <Select
            label="Event"
            onChange={(v) => setFilter('event', v)}
            options={[{ label: 'All events', value: '' }, ...eventOptions]}
            value={filters.event}
          />
          <Combobox
            emptyMessage="No user matches"
            label="Decided by"
            onChange={(v) => setFilter('actorId', v)}
            options={(users ?? []).map((u) => ({ label: u.email, value: u.id }))}
            placeholder="Anyone"
            value={filters.actorId}
          />
          <Input
            className="font-mono"
            hint="Paste a run ID to see only that run's decisions."
            label="Run ID"
            onChange={(e) => setFilter('runId', e.target.value.trim())}
            value={filters.runId}
          />
          <div className="flex items-start justify-end sm:pt-6">
            <Button
              disabled={!anyFilter}
              onClick={() => navigate({ ...EMPTY, offset: 0 })}
              variant="ghost"
            >
              Clear filters
            </Button>
          </div>
        </div>

        <div className="mt-6 border-t border-ink-600 pt-2">
          <QueryBoundary
            error={error}
            isError={isError}
            isFetching={isFetching}
            isLoading={isLoading}
            label="autonomy decisions"
            onRetry={() => void refetch()}
            rows={6}
          >
            <div className="-mx-4">
              <DataTable
                className="max-sm:px-4"
                columns={[
                  {
                    cell: (row) => (
                      <Badge dot tone={EVENT_TONE[row.event] ?? 'neutral'} variant="outline">
                        {eventLabel(row.event)}
                      </Badge>
                    ),
                    header: 'Decision',
                    id: 'decision',
                    primary: true,
                  },
                  {
                    cell: (row) =>
                      row.riskClass ? (
                        <span className="text-paper-200">{riskClassLabel(row.riskClass)}</span>
                      ) : (
                        <span className="text-paper-500">—</span>
                      ),
                    header: 'Risk class',
                    id: 'riskClass',
                  },
                  {
                    cell: (row) => (
                      <span className="text-paper-300">
                        {row.policyName ?? <span className="text-paper-500">—</span>}
                      </span>
                    ),
                    header: 'Policy',
                    id: 'policy',
                  },
                  {
                    cell: (row) =>
                      row.actorId ? (
                        <span className="text-paper-300">
                          {emailById.get(row.actorId) ?? 'Unknown user'}
                        </span>
                      ) : (
                        <span className="text-paper-500">System</span>
                      ),
                    header: 'Decided by',
                    id: 'decidedBy',
                  },
                  {
                    cell: (row) => (
                      <Link
                        className={cn(
                          'rounded-sm font-mono text-xs text-paper-100 underline-offset-2 hover:underline focus-visible:underline',
                          FOCUS_RING
                        )}
                        href={`/runs/${row.runId}`}
                        title={row.runId}
                      >
                        {row.runId.slice(0, 8)}
                      </Link>
                    ),
                    header: 'Run',
                    id: 'run',
                  },
                  {
                    cell: (row) => (
                      <span className="text-paper-400">
                        <RelativeTime value={row.createdAt} />
                      </span>
                    ),
                    header: 'When',
                    id: 'when',
                  },
                ]}
                empty={
                  anyFilter ? (
                    <EmptyState
                      action={
                        <Button onClick={() => navigate({ ...EMPTY, offset: 0 })} size="sm">
                          Clear filters
                        </Button>
                      }
                      hint="Try a different policy, risk class or event."
                      icon="search"
                      title="No decisions match these filters"
                    />
                  ) : (
                    <EmptyState
                      hint="Decisions appear here when a run reaches a step an autonomy policy governs."
                      icon="gavel"
                      title="No autonomy decisions yet"
                    />
                  )
                }
                getRowId={(row) => row.id}
                rows={data?.data ?? []}
              />
            </div>
          </QueryBoundary>
          {total > 0 && (
            <div className="mt-4 border-t border-ink-600 pt-4">
              <Pagination
                hasNext={hasMore}
                hasPrev={offset > 0}
                onNext={() => navigate({ offset: offset + LIMIT })}
                onPrev={() => navigate({ offset: Math.max(0, offset - LIMIT) })}
                rangeEnd={Math.min(offset + LIMIT, total)}
                rangeStart={offset + 1}
                total={total}
              />
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
