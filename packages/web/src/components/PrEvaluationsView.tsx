'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { Toolbar } from '@/components/ui/Toolbar';
import {
  briefMarkdown,
  type PrEvaluationMode,
  type PrEvaluationRow,
  type PrRiskClass,
  usePrEvaluationBrief,
  usePrEvaluations,
  usePullRequestIds,
  useRepoPrEvaluationPolicy,
  useSaveRepoPrEvaluation,
} from '@/hooks/usePrEvaluations';
import { useRepositories } from '@/hooks/useRepositories';
import { parseOffset, useUrlFilters } from '@/hooks/useUrlFilters';
import { ApiError } from '@/lib/api';
import { errMsg } from '@/lib/errors';

const PAGE_SIZE = 30;
const REPOSITORY_PAGE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLASSES: PrRiskClass[] = ['LOW', 'STANDARD', 'HIGH'];
const CLASS_TONE: Record<PrRiskClass, BadgeTone> = {
  HIGH: 'danger',
  LOW: 'success',
  STANDARD: 'warning',
};
const STATUS_TONE: Record<string, BadgeTone> = {
  failure: 'danger',
  pending: 'warning',
  success: 'success',
};
const MODE_OPTIONS = [
  { label: 'Inherit the default', value: 'inherit' },
  { label: 'Off', value: 'off' },
  { label: 'Advisory', value: 'advisory' },
  { label: 'Enforce', value: 'enforce' },
  { label: 'Auto', value: 'auto' },
];

/** The refusal reasons the gateway attaches to `AUTO_NOT_READY` / `BOT_APPROVAL_NOT_READY`. */
function refusalReasons(err: unknown): string[] {
  if (!(err instanceof ApiError) || !err.details || typeof err.details !== 'object') {
    return [];
  }
  const reasons = (err.details as { reasons?: unknown }).reasons;
  return Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === 'string') : [];
}

function RepoPolicy({ repoId }: { repoId: string }) {
  const policy = useRepoPrEvaluationPolicy(repoId);
  const save = useSaveRepoPrEvaluation(repoId);
  const data = policy.data;
  const reasons = refusalReasons(save.error);
  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-sm font-semibold text-paper-100">Repository policy</h2>
      <QueryBoundary
        error={policy.error}
        isError={policy.isError}
        isFetching={policy.isFetching}
        isLoading={policy.isLoading}
        label="repository policy"
        onRetry={() => void policy.refetch()}
      >
        {data && (
          <div className="space-y-3">
            <p className="text-sm text-paper-400">
              Mode <strong className="text-paper-100">{data.mode}</strong> (
              {data.modeSource === 'repository'
                ? 'set on this repository'
                : 'the deployment default'}
              ). Status context <code>{data.requiredStatusContext}</code>.
              {!data.enabled &&
                ' Evaluation is switched off for this repository (prEvaluation.enabled).'}
              {!data.autoMergeAllowed && ' Auto-merge is not allowed on this deployment.'}
            </p>
            <div className="flex flex-wrap items-end gap-4">
              <Select
                disabled={save.isPending}
                label="Mode"
                onChange={(value) =>
                  save.mutate({ mode: value === 'inherit' ? null : (value as PrEvaluationMode) })
                }
                options={MODE_OPTIONS}
                value={data.modeSource === 'repository' ? data.mode : 'inherit'}
              />
              <ToggleSwitch
                checked={data.botApproval.enabled}
                disabled={save.isPending}
                label="Bot approval"
                onChange={() => save.mutate({ botApproval: !data.botApproval.enabled })}
                title={
                  data.botApproval.globalAllowed
                    ? undefined
                    : 'Bot approval is not allowed on this deployment (prEvaluation.botApprovalAllowed)'
                }
              />
            </div>
            <p className="text-xs text-paper-500">
              Auto mode and bot approval are GitHub-only and need the preconditions in the
              evaluation doc; a refusal lists each unmet one. Bot approval is{' '}
              {data.botApproval.globalAllowed ? 'allowed' : 'not allowed'} on this deployment and
              the approver App is {data.botApproval.approverAppConfigured ? '' : 'not '}configured.
            </p>
            {save.isError && (
              <Alert variant="error">
                {errMsg(save.error)}
                {reasons.length > 0 && (
                  <ul className="mt-1 list-disc pl-5">
                    {reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                )}
              </Alert>
            )}
          </div>
        )}
      </QueryBoundary>
    </Card>
  );
}

function Brief({ id }: { id: string }) {
  const { data, isLoading } = usePrEvaluationBrief(id);
  const markdown = data ? briefMarkdown(data.brief) : null;
  if (isLoading) {
    return <p className="text-sm text-paper-500">Loading the brief…</p>;
  }
  // Model and ticket text: shown as plain text, never rendered as markup.
  return markdown ? (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-ink-800 p-3 text-xs text-paper-300">
      {markdown}
    </pre>
  ) : (
    <p className="text-sm text-paper-500">No brief was stored for this evaluation.</p>
  );
}

function PrEvaluations() {
  const { params, update } = useUrlFilters();
  const rawRepo = params.get('repo') ?? '';
  const repoId = UUID.test(rawRepo) ? rawRepo : '';
  const riskClass = CLASSES.find((c) => c === params.get('class'));
  const merged = params.get('state') === 'merged';
  const offset = parseOffset(params.get('offset'));
  const [openBrief, setOpenBrief] = useState<string | null>(null);

  const { data: repositories = [] } = useRepositories({ limit: REPOSITORY_PAGE });
  const { data, error, isError, isFetching, isLoading, meta, refetch } = usePrEvaluations({
    limit: PAGE_SIZE,
    merged,
    offset,
    repoId: repoId || undefined,
    riskClass,
  });
  const rows = data ?? [];
  const total = meta?.total ?? 0;
  const pullRequestIds = usePullRequestIds(rows.map((row) => row.connectionId));
  const filtered = !!repoId || !!riskClass || merged;
  const repoName = (row: PrEvaluationRow) =>
    `${row.connection.organizationName ?? ''}/${row.connection.repoName ?? ''}`;

  return (
    <div className="space-y-6">
      <PageHeader
        help={
          <p>
            Each row is one evaluation of a pull request the platform opened: its risk class, mode,
            commit status and whether auto-merge is armed. Open the pull request for the full
            reviewer brief beside the diff.
          </p>
        }
        subtitle="How the platform judged the pull requests it opened, across repositories."
        title="Pull-request evaluations"
      />
      <Toolbar>
        <Combobox
          aria-label="Repository"
          className="w-full sm:w-56"
          compact
          onChange={(value) => update({ offset: null, repo: value })}
          options={[
            { label: 'All repositories', value: '' },
            ...repositories
              .filter((repo) => repo.type === 'git_repo')
              .map((repo) => ({
                label: `${repo.organizationName}/${repo.repoName}`,
                value: repo.id,
              })),
          ]}
          placeholder="All repositories"
          value={repoId}
        />
        <Select
          appearance="pill"
          aria-label="Risk class"
          onChange={(value) => update({ class: value || null, offset: null })}
          options={[
            { label: 'Any class', value: '' },
            ...CLASSES.map((c) => ({ label: c, value: c })),
          ]}
          prefix="Class:"
          value={riskClass ?? ''}
        />
        <Select
          appearance="pill"
          aria-label="Pull request state"
          onChange={(value) => update({ offset: null, state: value || null })}
          options={[
            { label: 'Any', value: '' },
            { label: 'Merged', value: 'merged' },
          ]}
          prefix="State:"
          value={merged ? 'merged' : ''}
        />
        {filtered && (
          <Button
            onClick={() => update({ class: null, offset: null, repo: null, state: null })}
            size="sm"
            variant="ghost"
          >
            Clear filters
          </Button>
        )}
      </Toolbar>
      {repoId && <RepoPolicy repoId={repoId} />}
      <Card className="overflow-hidden p-0">
        <QueryBoundary
          error={error}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="evaluations"
          onRetry={() => void refetch()}
        >
          {rows.length === 0 ? (
            <EmptyState
              hint="Evaluations appear once a repository has evaluation on and the platform opens a pull request."
              icon="search"
              title={filtered ? 'No evaluations match these filters' : 'No evaluations yet'}
            />
          ) : (
            <DataTable
              caption="Pull-request evaluations"
              columns={[
                {
                  cell: (row) => {
                    const prId = pullRequestIds.get(`${row.connectionId}#${row.prNumber}`);
                    const label = `${repoName(row)} #${row.prNumber}`;
                    return prId ? (
                      <Link
                        className="font-medium text-paper-100 underline-offset-2 hover:underline"
                        href={`/pull-requests/${prId}`}
                      >
                        {label}
                      </Link>
                    ) : (
                      label
                    );
                  },
                  header: 'Pull request',
                  id: 'pr',
                  primary: true,
                  secondary: (row) => <RelativeTime value={row.createdAt} />,
                },
                {
                  cell: (row) => <Badge tone={CLASS_TONE[row.riskClass]}>{row.riskClass}</Badge>,
                  header: 'Class',
                  id: 'class',
                },
                { cell: (row) => row.mode, header: 'Mode', id: 'mode' },
                {
                  cell: (row) => (
                    <Badge tone={STATUS_TONE[row.statusState] ?? 'neutral'}>
                      {row.statusState}
                    </Badge>
                  ),
                  header: 'Status',
                  id: 'status',
                },
                {
                  cell: (row) => (
                    <span className="flex flex-wrap gap-1">
                      {row.autoMergeEnabled && <Badge tone="info">auto-merge armed</Badge>}
                      {row.mergedAt && <Badge tone="neutral">merged</Badge>}
                      {row.badMerge && (
                        <Badge title={row.badMergeReason ?? undefined} tone="danger">
                          bad merge
                        </Badge>
                      )}
                    </span>
                  ),
                  header: 'Auto-merge',
                  id: 'auto',
                },
                {
                  cell: (row) => row.requiredApprovers,
                  header: 'Approvers',
                  id: 'approvers',
                },
                {
                  cell: (row) =>
                    row.briefAvailable ? (
                      <Button
                        onClick={() => setOpenBrief(openBrief === row.id ? null : row.id)}
                        size="sm"
                        variant="ghost"
                      >
                        {openBrief === row.id ? 'Hide brief' : 'Brief'}
                      </Button>
                    ) : (
                      <span className="text-paper-500">none</span>
                    ),
                  header: 'Brief',
                  id: 'brief',
                },
              ]}
              getRowId={(row) => row.id}
              rows={rows}
            />
          )}
        </QueryBoundary>
      </Card>
      {openBrief && (
        <Card className="p-4">
          <h2 className="mb-2 text-sm font-semibold text-paper-100">Reviewer brief</h2>
          <Brief id={openBrief} />
        </Card>
      )}
      <Pagination
        hasNext={offset + PAGE_SIZE < total}
        hasPrev={offset > 0}
        onNext={() => update({ offset: String(offset + PAGE_SIZE) })}
        onPrev={() =>
          update({ offset: offset - PAGE_SIZE > 0 ? String(offset - PAGE_SIZE) : null })
        }
        rangeEnd={Math.min(offset + PAGE_SIZE, total)}
        rangeStart={total === 0 ? 0 : offset + 1}
        total={total}
      />
    </div>
  );
}

export default function PrEvaluationsView() {
  return (
    <Suspense>
      <PrEvaluations />
    </Suspense>
  );
}
