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
import { LoadingState } from '@/components/ui/LoadingState';
import { StatusBadge } from '@/components/ui/StatusBadge';
import type { SecurityEvent } from '@/hooks/useAdmin';
import { useApprovals } from '@/hooks/useApprovals';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useRunReRun } from '@/hooks/useRunReRun';
import { useCancelWorkflowRun, useRetriedRun, useRunDetail } from '@/hooks/useRuns';
import { useUserPreferences } from '@/hooks/useUserPreferences';
import { buildDagOverlay } from '@/lib/dagOverlay';
import { errMsg } from '@/lib/errors';
import { requestHref } from '@/lib/requestDisplay';
import { validateRouteParam } from '@/lib/routeParams';
import { findFailedStep } from '@/lib/runFailure';
import { buildTraceLinker } from '@/lib/traceLinkage';
import { formatRelativeTime } from '@/lib/utils';

const LAYOUTS: Record<RunDetailLayout, (props: RunLayoutProps) => React.ReactNode> = {
  A: SplitConsole,
  B: Transcript,
  C: FlightRecorder,
};

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
  const { data: approvalSteps } = useApprovals('ALL', 'requestedAt:desc', false, id);

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
    <EmptyState action={<ButtonLink href="/runs">Back to runs</ButtonLink>} title="Run not found" />
  );

  if (!id) {
    return notFound;
  }

  if (isLoading) {
    return <LoadingState />;
  }
  // A failed load, a missing run, or a run without a spec snapshot: render a
  // real state instead of spinning forever.
  if (isError) {
    return <Alert>{errMsg(error, 'Could not load run')}</Alert>;
  }
  if (!run) {
    return notFound;
  }
  if (!spec) {
    return <Alert>This run has no readable workflow spec snapshot.</Alert>;
  }

  const traces = run.traces ?? [];
  const Layout = LAYOUTS[layout];
  const failedStep = findFailedStep(run.status, run.steps);
  const tracesTrimmed = traces.some((t) => t.trimmed);
  // Hidden from the failure card once a re-run is in flight or started; the
  // header shows its progress.
  const failureCardReRun = reRunLocked ? undefined : handleReRun;

  return (
    <div className="flex h-full flex-col bg-ink-800">
      {/* ── Page header band ──────────────────────────────────────────────── */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-ink-600/40 bg-ink-900 px-4 py-4 md:px-6">
        {/* Breadcrumb */}
        <div className="label-mono flex items-center gap-2">
          {run.workRequest && (
            <>
              <Link
                className="transition-colors hover:text-paper-200"
                href={requestHref(run.workRequest.id)}
              >
                ← Request
              </Link>
              <span>/</span>
            </>
          )}
          <Link className="transition-colors hover:text-paper-200" href="/runs">
            All runs
          </Link>
        </div>

        <span className="hidden h-4 w-px bg-ink-500 md:block" />

        {/* Title: the request this run belongs to, not the template's name */}
        <h1 className="min-w-0 break-words font-display text-[22px] font-medium tracking-[-0.01em] text-paper-100">
          {runTitle}
        </h1>

        <StatusBadge status={run.status} />

        <span className="font-mono text-[10.5px] text-paper-600">
          {run.templateName ? `${run.templateName} · ` : ''}v{run.templateVersion} ·{' '}
          {formatRelativeTime(run.startedAt)}
        </span>

        {/* Right side: actions + layout switcher */}
        <div className="flex flex-wrap items-center gap-3 md:ml-auto">
          {securityEvents.length > 0 && (
            <Badge tone="amber" uppercase>
              {securityEvents.length} security event{securityEvents.length !== 1 ? 's' : ''}
            </Badge>
          )}
          {(tracesTrimmed || fullTraces) && (
            <Button
              disabled={isPlaceholderData}
              onClick={toggleFullTraces}
              size="sm"
              title={
                fullTraces
                  ? 'Full payloads are fetched once and not refreshed; trim them to resume live updates'
                  : 'Trace payloads are trimmed to 4,000 characters per field while the page polls'
              }
              variant="secondary"
            >
              {isPlaceholderData ? 'Loading…' : fullTraces ? 'Trim payloads' : 'Load full payloads'}
            </Button>
          )}
          {fullTracesFailed && (
            <Badge tone="brick" variant="text">
              Full payloads failed to load
            </Badge>
          )}
          {!isTerminalWorkflowRunStatus(run.status) && (
            <Button
              disabled={cancelRun.isPending}
              onClick={() => setShowCancelConfirm(true)}
              size="sm"
              variant="danger"
            >
              {cancelRun.isPending ? 'Cancelling…' : 'Cancel run'}
            </Button>
          )}
          {(WORKFLOW_RUN_FAILURE_STATUSES.has(run.status as WorkflowRunStatus) ||
            (isAgentRun && isTerminalWorkflowRunStatus(run.status))) &&
            run.workRequest && (
              <Button disabled={reRunLocked} onClick={handleReRun} size="sm" variant="secondary">
                {retryRun.isPending ? 'Re-running…' : 'Re-run'}
              </Button>
            )}
          {retryRun.isSuccess && (
            <Alert className="px-2 py-1 text-xs" variant="success">
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
            <Alert className="px-2 py-1 text-xs">
              Re-run failed: {retryRun.errorView.title}. {retryRun.errorView.message}
              {retryRun.errorView.hint ? ` ${retryRun.errorView.hint}` : ''}
            </Alert>
          )}
          {/* The Agent Run template is hidden: its detail route answers 404 for everyone. */}
          {!isAgentRun && (
            <Link
              className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-paper-500 transition-colors hover:text-ember-400"
              href={`/workflows/library/${run.templateId}`}
            >
              View template →
            </Link>
          )}
          <LayoutToggle onChange={setLayout} value={layout} />
        </div>
      </div>

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
      <div className="flex-1 flex overflow-hidden" ref={traceAnchorRef}>
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
