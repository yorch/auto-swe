'use client';

import type {
  AgentTraceRecord,
  RunDetailLayout,
  WorkflowRunStatus,
} from '@auto-swe/shared/types/api';
import {
  isTerminalWorkflowRunStatus,
  WORKFLOW_RUN_FAILURE_STATUSES,
} from '@auto-swe/shared/types/api';
import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import { parseWorkflowSpec } from '@auto-swe/shared/workflow';
import Link from 'next/link';
import { use, useCallback, useMemo, useRef, useState } from 'react';
import { LayoutToggle } from '@/components/LayoutToggle';
import { FlightRecorder } from '@/components/runs/layouts/FlightRecorder';
import { SplitConsole } from '@/components/runs/layouts/SplitConsole';
import { Transcript } from '@/components/runs/layouts/Transcript';
import type { RunLayoutProps } from '@/components/runs/layouts/types';
import { RunSummaryBand } from '@/components/runs/RunSummaryBand';
import { classifyTraceAsSecurityEvent } from '@/components/security/SecurityEventList';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Skeleton } from '@/components/ui/LoadingState';
import { StatusBadge } from '@/components/ui/StatusBadge';
import type { SecurityEvent } from '@/hooks/useAdmin';
import { useApprovals } from '@/hooks/useApprovals';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useRunReRun } from '@/hooks/useRunReRun';
import { useCancelWorkflowRun, useRetriedRun, useRunDetail } from '@/hooks/useRuns';
import { useUserPreferences } from '@/hooks/useUserPreferences';
import { buildDagOverlay } from '@/lib/dagOverlay';
import { errMsg } from '@/lib/errors';
import { IMPLEMENTER_RUNTIME_LABELS } from '@/lib/evalRuntime';
import { requestHref } from '@/lib/requestDisplay';
import { validateRouteParam } from '@/lib/routeParams';
import { findFailedStep } from '@/lib/runFailure';
import { buildTraceLinker } from '@/lib/traceLinkage';
import { cn, FOCUS_RING, formatDate, formatRelativeTime } from '@/lib/utils';

const LAYOUTS: Record<RunDetailLayout, (props: RunLayoutProps) => React.ReactNode> = {
  A: SplitConsole,
  B: Transcript,
  C: FlightRecorder,
};

/**
 * The header's runtime badge. The runtimes the run pinned for agents that have
 * their own (`agentRuntimes`) win, since an agent's own runtime overrides the
 * run-wide default; with none, the default the run pinned at start. Both are
 * what the run is set to drive its agents with, not a record of which ran.
 */
function runtimeBadge(run: {
  agentRuntimes?: Record<string, string>;
  implementerRuntime?: string | null;
}): { label: string; title: string } | null {
  const label = (r: string) => IMPLEMENTER_RUNTIME_LABELS[r] ?? r;
  const perAgent = Object.entries(run.agentRuntimes ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (perAgent.length > 0) {
    return {
      label: [...new Set(perAgent.map(([, r]) => r))].sort().map(label).join(' + '),
      title: `Runtime pinned for each agent with its own: ${perAgent.map(([k, r]) => `${k} — ${label(r)}`).join(', ')}`,
    };
  }
  return run.implementerRuntime
    ? {
        label: label(run.implementerRuntime),
        title: 'Implementer runtime pinned at run start (workspace.implementerRuntime)',
      }
    : null;
}

/** `sm` buttons are 28px tall: on a phone the header actions get a 40px target instead. */
const TOUCH_SM = 'h-[40px] lg:h-7';

const CRUMB = cn(
  'rounded-sm transition-colors hover:text-paper-200 max-lg:inline-flex max-lg:min-h-[40px] max-lg:items-center',
  FOCUS_RING
);

/** The page's shape while the run loads: a header band, then the layout area. */
function RunDetailSkeleton() {
  return (
    <div aria-live="polite" className="flex h-full flex-col bg-ink-800" role="status">
      <span className="sr-only">Loading run…</span>
      <div className="shrink-0 space-y-3 border-b border-ink-600/40 bg-ink-900 px-4 py-4 md:px-6">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-6 w-80 max-w-full" />
        <Skeleton className="h-3 w-48" />
      </div>
      <div className="flex flex-1 gap-px max-lg:flex-col">
        <div className="flex-1 space-y-4 p-5">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
        <div className="hidden w-[270px] space-y-3 border-l border-ink-600/60 bg-ink-900 p-5 lg:block">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      </div>
    </div>
  );
}

interface PageProps {
  params: Promise<{ id: string }>;
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function RunDetailPage({ params }: PageProps) {
  const { id: rawId } = use(params);
  const id = validateRouteParam(rawId);
  const {
    data: run,
    isError,
    isLoading,
    isPlaceholderData,
    error,
    fullTraces,
    fullTracesFailed,
    toggleFullTraces,
  } = useRunDetail(id ?? '');
  const runTitle =
    run?.workRequest?.title ||
    run?.workRequest?.description ||
    run?.workRequest?.externalTicketId ||
    run?.templateName ||
    'Run';
  useDocumentTitle(run ? `Run · ${runTitle}` : null);
  const badge = run ? runtimeBadge(run) : null;
  const cancelRun = useCancelWorkflowRun(id ?? '');
  // An agent run is re-run through its own endpoint, after a confirmation when it
  // delivers; see `useRunReRun`.
  const retryRun = useRunReRun(run);
  const isAgentRun = retryRun.isAgentRun;
  const retried = useRetriedRun(
    retryRun.data?.workRequestId ?? null,
    retryRun.data?.temporalWorkflowId ?? null
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const { layout, setLayout } = useUserPreferences();
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  // Both open and answered steps for this run: the open ones need a person, the answered ones
  // show who decided and what they said.
  const { data: approvalSteps } = useApprovals('ALL', 'requestedAt:desc', false, id ?? undefined);

  const pendingSteps = useMemo(
    () => (approvalSteps ?? []).filter((s) => s.status === 'PENDING'),
    [approvalSteps]
  );
  const answeredSteps = useMemo(
    () =>
      (approvalSteps ?? []).filter((s) => s.status !== 'PENDING' && (s.responses?.length ?? 0) > 0),
    [approvalSteps]
  );

  const dagOverlay = useMemo(
    () => (run?.steps ? buildDagOverlay(run.steps) : undefined),
    [run?.steps]
  );

  const spec = useMemo<WorkflowSpec | null>(() => {
    if (!run?.specSnapshot) {
      return null;
    }
    try {
      return parseWorkflowSpec(run.specSnapshot);
    } catch {
      return null;
    }
  }, [run?.specSnapshot]);

  const linker = useMemo(() => buildTraceLinker(spec), [spec]);

  const securityEvents = useMemo<SecurityEvent[]>(
    () =>
      (run?.traces ?? []).flatMap((t: AgentTraceRecord) => {
        const eventType = classifyTraceAsSecurityEvent(t);
        if (!eventType) {
          return [];
        }
        return [
          {
            createdAt: t.createdAt,
            error: t.error,
            eventType,
            externalTicketId: run?.workRequest?.externalTicketId ?? null,
            id: t.id,
            inputJson: t.inputJson,
            nodeId: t.nodeId,
            outputJson: t.outputJson,
            runId: run?.id ?? '',
            startedAt: run?.startedAt ?? '',
            toolName: t.toolName,
            workflowId: run?.workflowId ?? '',
            workRequestId: run?.workRequest?.id ?? null,
          },
        ];
      }),
    [run?.traces, run?.id, run?.workflowId, run?.workRequest, run?.startedAt]
  );

  const traceAnchorRef = useRef<HTMLDivElement>(null);
  // Selecting the failed step is what the layouts react to (filter, scroll, playhead);
  // scrolling the anchor alone did nothing inside the overflow-hidden main.
  const failedNodeId = run ? findFailedStep(run.status, run.steps)?.nodeId : undefined;
  const [jumpNonce, setJumpNonce] = useState(0);
  const handleJumpToFailure = useCallback(() => {
    if (failedNodeId) {
      setSelectedNodeId(failedNodeId);
      setJumpNonce((n) => n + 1);
    }
    traceAnchorRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [failedNodeId]);
  const reRunLocked = retryRun.locked;
  const handleReRun = retryRun.request;

  const notFound = (
    <div className="p-4 md:p-6">
      <EmptyState
        action={<ButtonLink href="/runs">Back to runs</ButtonLink>}
        bordered
        hint="It may have been removed, or the link is incomplete."
        icon="runs"
        title="Run not found"
      />
    </div>
  );

  if (!id) {
    return notFound;
  }

  if (isLoading) {
    return <RunDetailSkeleton />;
  }
  // A failed load, a missing run, or a run without a spec snapshot: render a
  // real state instead of spinning forever.
  if (isError) {
    return (
      <div className="p-4 md:p-6">
        <Alert
          action={
            <ButtonLink href="/runs" size="sm">
              Back to runs
            </ButtonLink>
          }
          title="Could not load this run"
        >
          {errMsg(error, 'Could not load run')}
        </Alert>
      </div>
    );
  }
  if (!run) {
    return notFound;
  }
  if (!spec) {
    return (
      <div className="p-4 md:p-6">
        <Alert
          action={
            <ButtonLink href="/runs" size="sm">
              Back to runs
            </ButtonLink>
          }
          title="This run cannot be drawn"
        >
          This run has no readable workflow spec snapshot.
        </Alert>
      </div>
    );
  }

  const traces = run.traces ?? [];
  const Layout = LAYOUTS[layout];
  const failedStep = findFailedStep(run.status, run.steps);
  const tracesTrimmed = traces.some((t) => t.trimmed);
  // Hidden from the failure card once a re-run is in flight or started; the
  // header shows its progress.
  const failureCardReRun = reRunLocked ? undefined : handleReRun;
  const canReRun =
    (WORKFLOW_RUN_FAILURE_STATUSES.has(run.status as WorkflowRunStatus) ||
      (isAgentRun && isTerminalWorkflowRunStatus(run.status))) &&
    Boolean(run.workRequest);

  return (
    <div className="flex h-full flex-col bg-ink-800 max-lg:min-w-0 max-lg:overflow-y-auto max-lg:overflow-x-hidden">
      {/* ── Page header band ──────────────────────────────────────────────── */}
      <header className="shrink-0 border-b border-ink-600/40 bg-ink-900 px-4 pt-3 pb-4 md:px-6">
        <nav
          aria-label="Breadcrumb"
          className="mb-1.5 flex flex-wrap items-center gap-x-1.5 text-[13px] text-paper-500"
        >
          <Link className={CRUMB} href="/runs">
            All runs
          </Link>
          {run.workRequest && (
            <>
              <Icon className="text-paper-600" name="chevronRight" size={12} />
              <Link className={CRUMB} href={requestHref(run.workRequest.id)}>
                Request
              </Link>
            </>
          )}
        </nav>

        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          {/* Title: the request this run belongs to, not the template's name */}
          <div className="min-w-0 flex-1 basis-[20rem]">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <h1 className="min-w-0 break-words text-xl font-semibold leading-tight tracking-[-0.01em] text-paper-50">
                {runTitle}
              </h1>
              <StatusBadge status={run.status} />
              {badge && (
                <Badge title={badge.title} tone="muted" variant="outline">
                  {badge.label}
                </Badge>
              )}
              {securityEvents.length > 0 && (
                <Badge dot tone="amber" variant="outline">
                  {securityEvents.length} security event{securityEvents.length !== 1 ? 's' : ''}
                </Badge>
              )}
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[13px] text-paper-500">
              {/* The Agent Run template is hidden: its detail route answers 404 for everyone. */}
              {run.templateName &&
                (isAgentRun ? (
                  <span className="text-paper-400">{run.templateName}</span>
                ) : (
                  <Link
                    className="rounded-sm text-paper-300 transition-colors hover:text-ember-400"
                    href={`/workflows/library/${run.templateId}`}
                    title="Open the workflow template"
                  >
                    {run.templateName}
                  </Link>
                ))}
              <span className="tabular">v{run.templateVersion}</span>
              <span aria-hidden="true">·</span>
              <span title={formatDate(run.startedAt)}>
                Started {formatRelativeTime(run.startedAt)}
              </span>
            </p>
          </div>

          {/* Right side: actions + layout switcher */}
          <div className="flex flex-wrap items-center gap-2 max-lg:w-full max-lg:min-w-0 lg:justify-end">
            {(tracesTrimmed || fullTraces) && (
              <Button
                className={TOUCH_SM}
                disabled={isPlaceholderData}
                onClick={toggleFullTraces}
                size="sm"
                title={
                  fullTraces
                    ? 'Full payloads are fetched once and not refreshed; trim them to resume live updates'
                    : 'Trace payloads are trimmed to 4,000 characters per field while the page polls'
                }
                variant="ghost"
              >
                {isPlaceholderData
                  ? 'Loading…'
                  : fullTraces
                    ? 'Trim payloads'
                    : 'Load full payloads'}
              </Button>
            )}
            {!isTerminalWorkflowRunStatus(run.status) && (
              <Button
                className={TOUCH_SM}
                disabled={cancelRun.isPending}
                onClick={() => setShowCancelConfirm(true)}
                size="sm"
                variant="danger"
              >
                {cancelRun.isPending ? 'Cancelling…' : 'Cancel run'}
              </Button>
            )}
            {canReRun && (
              <Button
                className={TOUCH_SM}
                disabled={reRunLocked}
                onClick={handleReRun}
                size="sm"
                variant="secondary"
              >
                <Icon name="refresh" size={13} />
                {retryRun.isPending ? 'Re-running…' : 'Re-run'}
              </Button>
            )}
            <LayoutToggle onChange={setLayout} value={layout} />
          </div>
        </div>

        {(fullTracesFailed || retryRun.isSuccess || retryRun.errorView) && (
          <div className="mt-3 space-y-2">
            {fullTracesFailed && (
              <Alert variant="warning">
                Full payloads failed to load. The trimmed payloads are still shown.
              </Alert>
            )}
            {retryRun.isSuccess && (
              <Alert variant="success">
                New run started —{' '}
                {retried.runId ? (
                  <Link className="underline hover:text-moss-600" href={`/runs/${retried.runId}`}>
                    view run
                  </Link>
                ) : retried.timedOut ? (
                  <Link className="underline hover:text-moss-600" href="/runs">
                    view runs
                  </Link>
                ) : (
                  'locating it…'
                )}
              </Alert>
            )}
            {retryRun.errorView && (
              <Alert title={`Re-run failed: ${retryRun.errorView.title}`}>
                {retryRun.errorView.message}
                {retryRun.errorView.hint ? ` ${retryRun.errorView.hint}` : ''}
              </Alert>
            )}
          </div>
        )}
      </header>

      {/* ── Pending approvals + result or failure, whichever layout is chosen ── */}
      <RunSummaryBand
        answeredSteps={answeredSteps}
        failedStep={failedStep}
        onJumpToFailure={handleJumpToFailure}
        onReRun={failureCardReRun}
        pendingSteps={pendingSteps}
        run={run}
      />

      {/* ── Layout body ───────────────────────────────────────────────────── */}
      <div className="flex flex-1 max-lg:min-w-0 lg:overflow-hidden" ref={traceAnchorRef}>
        <Layout
          dagOverlay={dagOverlay}
          jumpNonce={jumpNonce}
          linker={linker}
          run={run}
          selectedNodeId={selectedNodeId}
          setSelectedNodeId={setSelectedNodeId}
          spec={spec}
          traces={traces}
        />
      </div>

      <ConfirmModal
        confirmLabel="Re-run"
        message={retryRun.confirmMessage ?? ''}
        onClose={retryRun.cancel}
        onConfirm={retryRun.confirm}
        open={retryRun.confirming}
        title="Re-run this agent run?"
      />

      <ConfirmModal
        closeOnConfirm={false}
        confirmLabel="Cancel run"
        dangerous
        error={cancelRun.error ? errMsg(cancelRun.error) : undefined}
        message="Cancel this run? In-flight steps will be aborted."
        onClose={() => {
          cancelRun.reset();
          setShowCancelConfirm(false);
        }}
        onConfirm={() =>
          cancelRun.mutate(undefined, {
            onSuccess: () => setShowCancelConfirm(false),
          })
        }
        open={showCancelConfirm}
        title="Cancel run"
      />
    </div>
  );
}
