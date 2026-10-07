'use client';

import type { WorkflowRunDetail } from '@auto-swe/shared/types/api';
import { parseWorkflowSpec } from '@auto-swe/shared/workflow';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UNSAFE_PortalProvider } from 'react-aria';
import { createPortal } from 'react-dom';
import { RunSummary } from '@/components/runs/RunSummary';
import { Alert } from '@/components/ui/Alert';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Textarea } from '@/components/ui/Textarea';
import { WorkflowDag } from '@/components/workflow/WorkflowDag';
import { useRerunAgentRun } from '@/hooks/useAgentRuns';
import { useApprovals } from '@/hooks/useApprovals';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useRequestAttempts, useRequests } from '@/hooks/useRequests';
import { useRetriedRun, useRetryWorkRequest, useWorkflowRun } from '@/hooks/useRuns';
import { agentRunDeliver, describeLaunchError, rerunConsequence } from '@/lib/agentRun';
import { buildDagOverlay } from '@/lib/dagOverlay';
import { findFailedStep } from '@/lib/runFailure';
import { cn, FOCUS_RING, formatDate, formatRelativeTime } from '@/lib/utils';

const SUMMARY =
  'flex cursor-pointer list-none items-center gap-2 rounded-sm text-sm font-medium text-paper-200 [&::-webkit-details-marker]:hidden';

export function RequestPanel({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (mounted && !dialog.current?.open) {
      dialog.current?.showModal();
    }
  }, [mounted]);
  if (!mounted) {
    return null;
  }
  return createPortal(
    <dialog
      aria-label="Request details"
      className="fixed inset-y-0 right-0 left-auto m-0 ml-auto h-dvh max-h-none w-full max-w-none border-l border-ink-400 bg-ink-900 p-0 text-paper-100 shadow-2xl backdrop:bg-black/25 sm:w-[min(640px,85vw)]"
      onClose={onClose}
      ref={dialog}
    >
      <div className="flex h-full flex-col">
        <header className="flex shrink-0 items-center justify-between border-b border-ink-500 px-6 py-3.5">
          <h2 className="text-[15px] font-semibold text-paper-100">Request details</h2>
          <Button
            aria-label="Close request details"
            className="h-8 w-8 px-0"
            onClick={() => dialog.current?.close()}
            variant="ghost"
          >
            <Icon name="close" size={18} />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <UNSAFE_PortalProvider getContainer={() => dialog.current}>
            <RequestDetail requestId={requestId} />
          </UNSAFE_PortalProvider>
        </div>
      </div>
    </dialog>,
    document.body
  );
}

function RequestDetail({ requestId }: { requestId: string }) {
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const attempts = useRequestAttempts(requestId, offset);
  const latest = useRequestAttempts(requestId);
  const summary = useRequests({ limit: 1, requestId, scope: 'TEAM' });
  const onStarted = useCallback((id: string) => {
    setSelected(id);
    setOffset(0);
  }, []);
  const latestId = latest.data?.data[0]?.id;
  const runId = selected ?? summary.data?.data[0]?.id ?? latestId ?? '';
  const isCrossRepo = summary.data?.data[0]?.isCrossRepo === true;
  const query = useWorkflowRun(runId, false);
  const run = query.data;
  const requestTitle =
    run?.workRequest?.title ||
    run?.workRequest?.description.split('\n')[0].slice(0, 80) ||
    run?.workRequest?.externalTicketId ||
    run?.templateName;
  useDocumentTitle(requestTitle ? `Request · ${requestTitle}` : null);
  const total = attempts.data?.meta.total ?? 0;
  return (
    <div className="space-y-6">
      <QueryBoundary
        error={latest.error}
        isError={latest.isError}
        isFetching={latest.isFetching}
        isLoading={latest.isLoading}
        label="request attempts"
        onRetry={() => void latest.refetch()}
      >
        {!latestId && (
          <Alert variant="info">
            No visible attempts yet. A newly launched request will appear here when execution
            starts. This panel refreshes automatically.
          </Alert>
        )}
        {latestId && (
          <QueryBoundary
            error={query.error}
            isError={query.isError}
            isFetching={query.isFetching}
            isLoading={query.isLoading}
            label="request details"
            onRetry={() => void query.refetch()}
          >
            {run && (
              <>
                <div className="space-y-3">
                  <h3 className="break-words text-xl font-semibold leading-snug tracking-tight text-paper-50">
                    {run.workRequest?.title ||
                      run.workRequest?.description.split('\n')[0].slice(0, 200) ||
                      run.workRequest?.externalTicketId ||
                      run.templateName}
                  </h3>
                  <div className="flex flex-wrap items-center gap-3">
                    <StatusBadge status={run.status} />
                    <span className="text-[13px] text-paper-400">
                      {isCrossRepo
                        ? 'Repository execution'
                        : runId === latestId
                          ? 'Latest attempt'
                          : 'Previous attempt'}{' '}
                      · {formatRelativeTime(run.startedAt)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {run.id === (summary.data?.data[0]?.id ?? latestId) &&
                      run.result == null &&
                      summary.data?.data[0]?.reviewUrl && (
                        <ButtonLink
                          href={summary.data.data[0].reviewUrl}
                          rel="noopener noreferrer"
                          target="_blank"
                          variant="primary"
                        >
                          <Icon name="pullRequest" size={14} />
                          Review pull request
                          <Icon name="external" size={13} />
                        </ButtonLink>
                      )}
                    <ButtonLink href={`/runs/${run.id}`}>
                      Open full diagnostics
                      <Icon name="arrowRight" size={14} />
                    </ButtonLink>
                  </div>
                </div>
                <AttemptContent
                  isLatest={!isCrossRepo && run.id === latestId}
                  key={run.id}
                  onStarted={onStarted}
                  run={run}
                />
              </>
            )}
          </QueryBoundary>
        )}
      </QueryBoundary>
      {latestId && (
        <section className="space-y-3 border-t border-ink-600 pt-6">
          <h3 className="flex items-center gap-2 text-[15px] font-semibold text-paper-100">
            {isCrossRepo ? 'Repository executions' : 'Attempts'}
            {total > 0 && (
              <span className="tabular rounded-full bg-ink-600 px-2 text-xs font-medium text-paper-300">
                {total}
              </span>
            )}
          </h3>
          {isCrossRepo && (
            <p className="text-sm text-paper-400">
              This request spans repositories. Its status summarizes the latest execution for each
              repository you can see.
              {!!summary.data?.data[0]?.failedExecutionCount &&
                ` ${summary.data.data[0].failedExecutionCount} repository executions failed or timed out. Select an execution below to review its blocker.`}
            </p>
          )}
          <QueryBoundary
            error={attempts.error}
            isError={attempts.isError}
            isFetching={attempts.isFetching}
            isLoading={attempts.isLoading}
            label="attempt history"
            onRetry={() => void attempts.refetch()}
          >
            <ul className="space-y-2">
              {attempts.data?.data.map((attempt) => (
                <li key={attempt.id}>
                  <button
                    aria-pressed={runId === attempt.id}
                    className={cn(
                      'flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border px-3.5 py-2.5 text-left transition-colors',
                      FOCUS_RING,
                      runId === attempt.id
                        ? 'border-ember-400/70 bg-ember-400/[0.06]'
                        : 'border-ink-500 hover:border-ink-300 hover:bg-ink-700/60'
                    )}
                    onClick={() => setSelected(attempt.id)}
                    type="button"
                  >
                    <span className="text-sm text-paper-200">
                      <span className="font-medium text-paper-100">
                        {attempt.id === latestId ? 'Latest' : 'Previous'}
                      </span>
                      <span className="text-paper-500"> · </span>
                      <span title={formatDate(attempt.startedAt)}>
                        {formatRelativeTime(attempt.startedAt)}
                      </span>
                    </span>
                    <StatusBadge status={attempt.status} />
                  </button>
                </li>
              ))}
            </ul>
            <Pagination
              hasNext={offset + 20 < total}
              hasPrev={offset > 0}
              onNext={() => setOffset(offset + 20)}
              onPrev={() => setOffset(Math.max(0, offset - 20))}
              rangeEnd={Math.min(offset + 20, total)}
              rangeStart={total ? offset + 1 : 0}
              total={total}
            />
          </QueryBoundary>
        </section>
      )}
    </div>
  );
}

function AttemptContent({
  run,
  isLatest,
  onStarted,
}: {
  run: WorkflowRunDetail;
  isLatest: boolean;
  onStarted: (id: string) => void;
}) {
  const genericRetry = useRetryWorkRequest();
  const agentRetry = useRerunAgentRun();
  const [retryOpen, setRetryOpen] = useState(false);
  const retryLock = useRef(false);
  const [instructions, setInstructions] = useState('');
  const retry = run.isAgentRun ? agentRetry : genericRetry;
  const started = useRetriedRun(
    run.workRequest?.id ?? null,
    retry.data?.temporalWorkflowId ?? null
  );
  useEffect(() => {
    if (started.runId) {
      onStarted(started.runId);
    }
  }, [started.runId, onStarted]);
  const failedStep = findFailedStep(run.status, run.steps);
  const approvalQuery = useApprovals('ALL', 'requestedAt:desc', false, run.id);
  const pending = (approvalQuery.data ?? []).filter((step) => step.status === 'PENDING');
  // Answered steps stay visible so the requester sees who decided and what they said.
  const answered = (approvalQuery.data ?? []).filter(
    (step) => step.status !== 'PENDING' && (step.responses?.length ?? 0) > 0
  );
  const consequence = run.isAgentRun
    ? rerunConsequence(agentRunDeliver(run))
    : 'This starts another attempt and may update the branch or pull request. Platform checks and approvals still apply.';
  const canRetry =
    isLatest &&
    !!run.workRequest &&
    (run.status === 'FAILED' ||
      run.status === 'TIMED_OUT' ||
      (run.isAgentRun && run.status !== 'RUNNING'));
  const currentSteps = [
    ...new Map(
      [...run.steps].sort((a, b) => a.attempt - b.attempt).map((step) => [step.nodeId, step])
    ).values(),
  ];
  const activeSteps = currentSteps.filter((step) => step.status === 'RUNNING');
  async function launchRetry() {
    if (!run.workRequest || retryLock.current || retry.isPending || retry.isSuccess) {
      return;
    }
    retryLock.current = true;
    const input = {
      instructions: instructions.trim() || undefined,
      workRequestId: run.workRequest.id,
    };
    if (run.isAgentRun) {
      await agentRetry.mutateAsync(input).catch(() => {
        retryLock.current = false;
      });
    } else {
      await genericRetry.mutateAsync(input).catch(() => {
        retryLock.current = false;
      });
    }
  }
  const failure = retry.isError ? describeLaunchError(retry.error) : null;
  return (
    <div className="space-y-5">
      <QueryBoundary
        error={approvalQuery.error}
        isError={approvalQuery.isError}
        isFetching={approvalQuery.isFetching}
        isLoading={approvalQuery.isLoading}
        label="pending responses"
        onRetry={() => void approvalQuery.refetch()}
      />
      <RunSummary
        answeredSteps={answered}
        failedStep={failedStep}
        pendingSteps={pending}
        run={run}
        variant="compact"
      />
      {canRetry && !retryOpen && (
        <Button onClick={() => setRetryOpen(true)}>
          <Icon name="refresh" size={14} />
          Retry with instructions
        </Button>
      )}
      {retryOpen && (
        <Card className="space-y-4 p-5">
          <h3 className="text-[15px] font-semibold text-paper-100">Start another attempt</h3>
          <p className="text-sm text-paper-400">
            {consequence ??
              'This starts another agent attempt without publishing a branch or pull request.'}
          </p>
          <Textarea
            hint="Optional. Applies to this attempt; the original request stays unchanged."
            label="Additional instructions"
            maxLength={4000}
            onChange={(event) => setInstructions(event.target.value)}
            value={instructions}
          />
          {failure && <Alert title={failure.title}>{failure.message}</Alert>}
          {retry.isSuccess ? (
            <Alert variant="success">
              Another attempt has started.{' '}
              {started.timedOut
                ? 'It is taking longer to appear; the attempts list continues to refresh.'
                : 'Waiting for execution to begin…'}
            </Alert>
          ) : (
            <div className="flex flex-wrap justify-end gap-3">
              <Button
                disabled={retry.isPending}
                onClick={() => setRetryOpen(false)}
                variant="ghost"
              >
                Back
              </Button>
              <Button disabled={retry.isPending} onClick={launchRetry} variant="primary">
                {retry.isPending ? 'Starting…' : 'Start attempt'}
              </Button>
            </div>
          )}
        </Card>
      )}
      <section className="space-y-2">
        <h3 className="text-[15px] font-semibold text-paper-100">Progress</h3>
        {run.status === 'RUNNING' && (
          <p className="text-sm text-paper-300">
            {pending.length
              ? 'Waiting for the response above.'
              : activeSteps.length
                ? `Working on ${activeSteps.map((step) => step.nodeId).join(', ')}.`
                : 'Execution is running. Waiting for the next step update.'}
          </p>
        )}
        <div className="flex items-center gap-3">
          <div aria-hidden="true" className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-600">
            <div
              className="h-full rounded-full bg-moss-400"
              style={{
                width: `${currentSteps.length ? (currentSteps.filter((step) => step.status === 'PASSED').length / currentSteps.length) * 100 : 0}%`,
              }}
            />
          </div>
          <p className="tabular shrink-0 text-[13px] text-paper-400">
            {currentSteps.filter((step) => step.status === 'PASSED').length} of{' '}
            {currentSteps.length} recorded steps passed.
          </p>
        </div>
      </section>
      {run.workRequest?.description && (
        <details className="group rounded-lg border border-ink-500 bg-ink-800/40 px-4 py-3">
          <summary className={cn(SUMMARY, FOCUS_RING)}>
            <Icon
              className="text-paper-500 transition-transform group-open:rotate-90"
              name="chevronRight"
              size={14}
            />
            Original task
          </summary>
          <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-paper-300">
            {run.workRequest.description}
          </p>
        </details>
      )}
      <TechnicalDetails run={run} />
    </div>
  );
}

function TechnicalDetails({ run }: { run: WorkflowRunDetail }) {
  const [open, setOpen] = useState(false);
  const traces = useWorkflowRun(open ? run.id : '', true);
  const spec = useMemo(() => {
    try {
      return parseWorkflowSpec(run.specSnapshot);
    } catch {
      return null;
    }
  }, [run.specSnapshot]);
  return (
    <details
      className="group rounded-lg border border-ink-500 bg-ink-800/40 px-4 py-3"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className={cn(SUMMARY, FOCUS_RING)}>
        <Icon
          className="text-paper-500 transition-transform group-open:rotate-90"
          name="chevronRight"
          size={14}
        />
        Technical details
      </summary>
      {open && (
        <div className="mt-4 space-y-4">
          {spec ? (
            <WorkflowDag height={320} outline spec={spec} statuses={buildDagOverlay(run.steps)} />
          ) : (
            <p className="text-sm text-paper-400">No readable workflow diagram is available.</p>
          )}
          <h4 className="text-sm font-semibold text-paper-200">Step log</h4>
          <ul className="divide-y divide-ink-600 rounded-md border border-ink-600">
            {run.steps.map((step) => (
              <li className="px-3 py-2 text-[13px]" key={step.id}>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-mono text-paper-100">{step.nodeId}</span>
                  <span className="text-paper-500">attempt {step.attempt}</span>
                  <StatusBadge showDot={false} status={step.status} />
                </span>
                {step.error && (
                  <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-brick-400">
                    {step.error}
                  </pre>
                )}
              </li>
            ))}
          </ul>
          <h4 className="text-sm font-semibold text-paper-200">Traces</h4>
          <QueryBoundary
            error={traces.error}
            isError={traces.isError}
            isFetching={traces.isFetching}
            isLoading={traces.isLoading}
            label="traces"
            onRetry={() => void traces.refetch()}
          >
            <p className="text-sm text-paper-400">
              {traces.data?.traces.length ?? 0} events. Open the full page for complete trace
              inspection.
            </p>
            {traces.data?.traces.slice(-20).map((trace) => (
              <div className="border-t border-ink-600 pt-2 text-xs text-paper-400" key={trace.id}>
                <span className="font-mono text-paper-300">{trace.agentKey}</span> ·{' '}
                <span className="font-mono">{trace.toolName ?? trace.type}</span>
                {trace.error && <p className="break-words text-brick-400">{trace.error}</p>}
              </div>
            ))}
          </QueryBoundary>
        </div>
      )}
    </details>
  );
}
