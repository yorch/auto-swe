'use client';

import type { WorkflowRunDetail } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useId, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { useTemporalWorkflowUrl } from '@/hooks/useTemporalUi';
import { runMetaSummary } from '@/lib/runMeta';
import {
  cn,
  FOCUS_RING,
  formatCost,
  formatCount,
  formatDate,
  formatDuration,
  formatTokens,
} from '@/lib/utils';
import { AutonomyDecisionsPanel } from './AutonomyDecisionsPanel';
import { EvalSignalsPanel } from './EvalSignalsPanel';
import { RAIL_CODE, RAIL_KEY, RAIL_VALUE, RailRow, RailSection } from './Rail';

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
    <RailRow className="items-baseline">
      <dt className={RAIL_KEY}>{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </RailRow>
  );
}

function Value({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span className={RAIL_VALUE} title={title}>
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
            <Value>{formatDate(run.startedAt)}</Value>
          </MetaRow>
          {run.endedAt && (
            <MetaRow label="Ended">
              <Value>{formatDate(run.endedAt)}</Value>
            </MetaRow>
          )}
          {durationMs !== null && (
            <MetaRow label="Duration">
              <Value>{formatDuration(durationMs)}</Value>
            </MetaRow>
          )}
          {cost > 0 && (
            <MetaRow label="Cost">
              <Value>{formatCost(cost)}</Value>
            </MetaRow>
          )}
          {totalTokens > 0 && (
            <MetaRow label="Tokens">
              <Value
                title={`${formatCount(run.tokensInputTotal)} in / ${formatCount(run.tokensOutputTotal)} out`}
              >
                {formatTokens(totalTokens)} total
              </Value>
            </MetaRow>
          )}
          {totalTraces > 0 && (
            <MetaRow label="Trace events">
              <Value>{formatCount(totalTraces)}</Value>
            </MetaRow>
          )}
          <MetaRow label="Template">
            {/* The Agent Run template is hidden; its route answers 404. */}
            {isAgentRun ? (
              <span className="text-[13px] text-paper-200">{run.templateName}</span>
            ) : (
              <Link
                className={cn(
                  'rounded-sm text-[13px] text-ember-400 transition-colors hover:text-ember-300',
                  FOCUS_RING
                )}
                href={`/workflows/library/${run.templateId}`}
              >
                {run.templateName}
              </Link>
            )}
          </MetaRow>
          <MetaRow label="Workflow ID">
            {temporalUrl ? (
              <a
                className={cn(
                  RAIL_CODE,
                  'block max-w-[150px] truncate rounded-sm text-right text-ember-400 hover:underline',
                  FOCUS_RING
                )}
                href={temporalUrl}
                rel="noreferrer"
                target="_blank"
                title={`${run.workflowId} — open in Temporal`}
              >
                {shortWorkflowId}
              </a>
            ) : (
              <span
                className={cn(RAIL_CODE, 'block max-w-[150px] truncate text-right')}
                title={run.workflowId}
              >
                {shortWorkflowId}
              </span>
            )}
          </MetaRow>
        </dl>
      </RailSection>

      {/* Request block */}
      {run.workRequest && (
        <RailSection title="Request">
          {run.workRequest.externalTicketId && (
            <div className="mb-1.5 font-mono text-xs text-paper-300">
              {run.workRequest.externalTicketId}
            </div>
          )}
          <p className="line-clamp-[12] whitespace-pre-wrap break-words text-[13px] leading-relaxed text-paper-400">
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
          className={cn(
            'flex min-h-[44px] w-full items-center gap-2.5 px-4 py-2 text-left transition-colors hover:bg-ink-700/50',
            FOCUS_RING
          )}
          onClick={() => setOpen((v) => !v)}
          type="button"
        >
          <Icon
            className={cn('text-paper-500 transition-transform', open && 'rotate-90')}
            name="chevronRight"
            size={14}
          />
          <span className="shrink-0 text-[13px] font-semibold text-paper-100">Run details</span>
          {summary.length > 0 && (
            <span className="tabular min-w-0 truncate text-xs text-paper-500">
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
