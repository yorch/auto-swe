'use client';

import type { WorkflowRunDetail, WorkflowStepRecord } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { formatCost, formatDate, formatDuration, formatTokens } from '@/lib/utils';
import { AutonomyDecisionsPanel } from './AutonomyDecisionsPanel';
import { EvalSignalsPanel } from './EvalSignalsPanel';
import { FailureCard } from './FailureCard';
import { RunOutcomeCard } from './RunOutcomeCard';

interface RunMetaRailProps {
  run: WorkflowRunDetail;
  failedStep: WorkflowStepRecord | null;
  onJumpToFailure?: () => void;
  onReRun?: () => void;
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-ink-600/40 last:border-0">
      <dt className="kicker shrink-0 pt-0.5">{label}</dt>
      <dd className="text-right min-w-0">{children}</dd>
    </div>
  );
}

function MonoValue({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <span
      className={accent ? 'text-ember-400' : 'text-paper-300'}
      style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}
    >
      {children}
    </span>
  );
}

export function RunMetaRail({ run, failedStep, onJumpToFailure, onReRun }: RunMetaRailProps) {
  const durationMs =
    run.startedAt && run.endedAt
      ? new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()
      : null;

  const totalTraces = run.traces?.length ?? 0;
  const cost = run.costUsdAccrued;
  const totalTokens = run.tokensInputTotal + run.tokensOutputTotal;

  return (
    <aside
      className="flex flex-col overflow-y-auto border-l border-ink-600/60 shrink-0"
      style={{ background: 'var(--color-ink-900)', width: '270px' }}
    >
      {/* Run details */}
      <div className="px-5 pt-5 pb-4">
        <div className="kicker mb-3">Run details</div>
        <dl>
          <MetaRow label="Started">
            <MonoValue>{formatDate(run.startedAt)}</MonoValue>
          </MetaRow>
          {run.endedAt && (
            <MetaRow label="Ended">
              <MonoValue>{formatDate(run.endedAt)}</MonoValue>
            </MetaRow>
          )}
          {durationMs !== null && (
            <MetaRow label="Duration">
              <MonoValue>{formatDuration(durationMs)}</MonoValue>
            </MetaRow>
          )}
          <MetaRow label="Workflow">
            <MonoValue>
              <span className="truncate block max-w-[140px] text-right" title={run.workflowId}>
                {run.workflowId.slice(0, 22)}…
              </span>
            </MonoValue>
          </MetaRow>
          {totalTraces > 0 && (
            <MetaRow label="Trace events">
              <MonoValue>{totalTraces}</MonoValue>
            </MetaRow>
          )}
          {cost > 0 && (
            <MetaRow label="Cost">
              <MonoValue>{formatCost(cost)}</MonoValue>
            </MetaRow>
          )}
          {totalTokens > 0 && (
            <MetaRow label="Tokens">
              <span
                className="text-paper-300"
                title={`${run.tokensInputTotal.toLocaleString()} in / ${run.tokensOutputTotal.toLocaleString()} out`}
              >
                <MonoValue>{formatTokens(totalTokens)} total</MonoValue>
              </span>
            </MetaRow>
          )}
          <MetaRow label="Template">
            <MonoValue>
              <Link
                className="text-ember-400 hover:text-ember-300 transition-colors"
                href={`/workflows/library/${run.templateId}`}
              >
                {run.templateName}
              </Link>
            </MonoValue>
          </MetaRow>
        </dl>
      </div>

      {/* Request block */}
      {run.workRequest && (
        <>
          <div className="h-px mx-5 bg-ink-500/40" />
          <div className="px-5 py-4">
            <div className="kicker mb-2" style={{ color: 'var(--color-paper-600)' }}>
              Request
            </div>
            <div
              className="text-ember-400 mb-1"
              style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', letterSpacing: '0.06em' }}
            >
              {run.workRequest.externalTicketId}
            </div>
            <p className="text-paper-400 text-[12px] leading-relaxed">
              {run.workRequest.description}
            </p>
          </div>
        </>
      )}

      {/* Eval signals (P0) */}
      <EvalSignalsPanel runId={run.id} />

      {/* Autonomy decisions (P3) */}
      <AutonomyDecisionsPanel runId={run.id} />

      {/* Non-SWE outcome card */}
      {(() => {
        const hasResult =
          run.result != null &&
          typeof run.result === 'object' &&
          Object.keys(run.result as Record<string, unknown>).length > 0;
        if (!hasResult) {
          return null;
        }
        return (
          <>
            <div className="h-px mx-5 bg-ink-500/40" />
            <div className="px-5 py-4">
              <RunOutcomeCard result={run.result} templateName={run.templateName} />
            </div>
          </>
        );
      })()}

      {/* Failure card */}
      {failedStep && (
        <>
          <div className="h-px mx-5 bg-ink-500/40" />
          <div className="px-5 py-4">
            <FailureCard
              onJumpToFailure={onJumpToFailure}
              onReRun={onReRun}
              size="full"
              step={failedStep}
            />
          </div>
        </>
      )}
    </aside>
  );
}
