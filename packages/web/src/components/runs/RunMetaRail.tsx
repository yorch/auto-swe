'use client';

import type { WorkflowRunDetail } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useId, useState } from 'react';
import { useTemporalWorkflowUrl } from '@/hooks/useTemporalUi';
import { runMetaSummary } from '@/lib/runMeta';
import { cn, formatCost, formatCount, formatDate, formatDuration, formatTokens } from '@/lib/utils';
import { AutonomyDecisionsPanel } from './AutonomyDecisionsPanel';
import { EvalSignalsPanel } from './EvalSignalsPanel';
import { RailRow, RailSection } from './Rail';

interface RunMetaRailProps {
  run: WorkflowRunDetail;
  /**
   * Below the desktop breakpoint the rail is a full-width section between the graph and the
   * console that starts closed behind a toggle, instead of a 270px column beside them.
   */
  collapsible?: boolean;
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

export function RunMetaRail({ run, collapsible = false }: RunMetaRailProps) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const temporalUrl = useTemporalWorkflowUrl(run.workflowId);
  const shortWorkflowId =
    run.workflowId.length > 22 ? `${run.workflowId.slice(0, 22)}…` : run.workflowId;
  const durationMs =
    run.startedAt && run.endedAt
      ? new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()
      : null;

  const isAgentRun = run.isAgentRun === true;
  const totalTraces = run.traces?.length ?? 0;
  const cost = run.costUsdAccrued;
  const totalTokens = run.tokensInputTotal + run.tokensOutputTotal;

  const summary = runMetaSummary(run);

  const body = (
    <>
      {/* Run details */}
      {/* Collapsed, the toggle above already says "Run details"; repeating it inside would be
          announced twice. */}
      <RailSection className="pt-5" divider={false} title={collapsible ? undefined : 'Run details'}>
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

      {/* Eval signals */}
      <EvalSignalsPanel runId={run.id} />

      {/* Autonomy decisions */}
      <AutonomyDecisionsPanel runId={run.id} />
    </>
  );

  if (collapsible) {
    return (
      <aside className="shrink-0 border-b border-ink-600/40 bg-ink-900" data-testid="run-meta-rail">
        <button
          aria-controls={panelId}
          aria-expanded={open}
          className="flex min-h-[44px] w-full items-center gap-3 px-4 py-2 text-left"
          onClick={() => setOpen((v) => !v)}
          type="button"
        >
          <span aria-hidden="true" className="w-3 font-mono text-[10px] text-paper-500">
            {open ? '▼' : '▶'}
          </span>
          <span className="kicker">Run details</span>
          {summary.length > 0 && (
            <span className="min-w-0 truncate font-mono text-[11px] text-paper-500">
              {summary.join(' · ')}
            </span>
          )}
        </button>
        <div hidden={!open} id={panelId}>
          {body}
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex w-[270px] shrink-0 flex-col overflow-y-auto border-l border-ink-600/60 bg-ink-900">
      {body}
    </aside>
  );
}
