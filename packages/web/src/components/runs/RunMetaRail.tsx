'use client';

import type { WorkflowRunDetail, WorkflowStepRecord } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useTemporalWorkflowUrl } from '@/hooks/useTemporalUi';
import { classifyAgentRunFailure } from '@/lib/agentRun';
import { cn, formatCost, formatCount, formatDate, formatDuration, formatTokens } from '@/lib/utils';
import { AgentRunFailureNote } from './AgentRunOutcomeCard';
import { AutonomyDecisionsPanel } from './AutonomyDecisionsPanel';
import { EvalSignalsPanel } from './EvalSignalsPanel';
import { FailureCard } from './FailureCard';
import { RailRow, RailSection } from './Rail';
import { RunOutcomeCard } from './RunOutcomeCard';

interface RunMetaRailProps {
  run: WorkflowRunDetail;
  failedStep: WorkflowStepRecord | null;
  onJumpToFailure?: () => void;
  onReRun?: () => void;
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <RailRow className="items-start">
      <dt className="kicker shrink-0 pt-0.5">{label}</dt>
      <dd className="text-right min-w-0">{children}</dd>
    </RailRow>
  );
}

function MonoValue({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <span className={cn('font-mono text-[11px]', accent ? 'text-ember-400' : 'text-paper-300')}>
      {children}
    </span>
  );
}

export function RunMetaRail({ run, failedStep, onJumpToFailure, onReRun }: RunMetaRailProps) {
  const temporalUrl = useTemporalWorkflowUrl(run.workflowId);
  const shortWorkflowId =
    run.workflowId.length > 22 ? `${run.workflowId.slice(0, 22)}…` : run.workflowId;
  const durationMs =
    run.startedAt && run.endedAt
      ? new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()
      : null;

  const isAgentRun = run.isAgentRun === true;
  const agentFailure = isAgentRun ? classifyAgentRunFailure(failedStep?.error) : null;
  const totalTraces = run.traces?.length ?? 0;
  const cost = run.costUsdAccrued;
  const totalTokens = run.tokensInputTotal + run.tokensOutputTotal;

  return (
    <aside className="flex w-[270px] shrink-0 flex-col overflow-y-auto border-l border-ink-600/60 bg-ink-900">
      {/* Run details */}
      <RailSection className="pt-5" divider={false} title="Run details">
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
              {temporalUrl ? (
                <a
                  className="truncate block max-w-[140px] text-right text-ember-400 hover:underline"
                  href={temporalUrl}
                  rel="noreferrer"
                  target="_blank"
                  title={`${run.workflowId} — open in Temporal`}
                >
                  {shortWorkflowId}
                </a>
              ) : (
                <span className="truncate block max-w-[140px] text-right" title={run.workflowId}>
                  {shortWorkflowId}
                </span>
              )}
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
                title={`${formatCount(run.tokensInputTotal)} in / ${formatCount(run.tokensOutputTotal)} out`}
              >
                <MonoValue>{formatTokens(totalTokens)} total</MonoValue>
              </span>
            </MetaRow>
          )}
          <MetaRow label="Template">
            <MonoValue>
              {/* The Agent Run template is hidden; its route answers 404. */}
              {isAgentRun ? (
                run.templateName
              ) : (
                <Link
                  className="text-ember-400 transition-colors hover:text-ember-600"
                  href={`/workflows/library/${run.templateId}`}
                >
                  {run.templateName}
                </Link>
              )}
            </MonoValue>
          </MetaRow>
        </dl>
      </RailSection>

      {/* Request block */}
      {run.workRequest && (
        <RailSection title="Request">
          <div className="mb-1 font-mono text-xs tracking-[0.06em] text-ember-400">
            {run.workRequest.externalTicketId}
          </div>
          <p className="text-paper-400 text-[12px] leading-relaxed">
            {run.workRequest.description}
          </p>
        </RailSection>
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
          <RailSection>
            <RunOutcomeCard
              isAgentRun={isAgentRun}
              result={run.result}
              templateName={run.templateName}
            />
          </RailSection>
        );
      })()}

      {/* Failure card */}
      {failedStep && (
        <RailSection>
          {agentFailure && (
            <div className="mb-2">
              <AgentRunFailureNote failure={agentFailure} />
            </div>
          )}
          <FailureCard
            onJumpToFailure={onJumpToFailure}
            onReRun={onReRun}
            size="full"
            step={failedStep}
          />
        </RailSection>
      )}
    </aside>
  );
}
