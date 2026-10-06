'use client';

import { AGENT_RUN_MAX_OUTPUT_DIFF_CHARS } from '@auto-swe/shared/lib/agentRun';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import {
  type AgentRunFailureView,
  type AgentRunOutcome,
  parseAgentRunOutcome,
} from '@/lib/agentRun';
import { cn, FOCUS_RING } from '@/lib/utils';

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

const GATE_LABEL: Record<NonNullable<AgentRunOutcome['gate']>, string> = {
  no_changes: 'No changes, nothing published',
  not_applicable: 'Not published',
  passed: 'Passed the security gate',
};

const STOP_LABEL: Record<NonNullable<AgentRunOutcome['stoppedReason']>, string> = {
  max_steps: 'Stopped at its step limit',
  wall_clock: 'Stopped at its time limit',
};

const OPERATION_MARK: Record<string, string> = { CREATE: '+', DELETE: '−', MODIFY: '~' };
const OPERATION_LABEL: Record<string, string> = {
  CREATE: 'Added',
  DELETE: 'Deleted',
  MODIFY: 'Modified',
};

/** A key/value line of the published block. */
function OutcomeRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-ink-600/60 py-1.5 last:border-0">
      <dt className="shrink-0 text-xs text-paper-500">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

/**
 * The result of an agent run: what the agent said, what it changed, and where it
 * was published. Everything here is text the agent influenced, rendered as text
 * (never HTML); the only link is a pull request URL, and only when it is https.
 */
export function AgentRunOutcomeCard({ result }: { result: unknown }) {
  const o = parseAgentRunOutcome(result);
  if (!o) {
    return null;
  }
  const published = o.deliver !== 'none' && o.gate === 'passed';
  return (
    <Card className="space-y-3 p-4" variant="inset">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-paper-100">
          <Icon className="text-moss-400" name="agents" size={15} />
          Agent run outcome
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {o.gate && (
            <Badge tone={o.gate === 'passed' ? 'moss' : 'neutral'}>{GATE_LABEL[o.gate]}</Badge>
          )}
          <Badge tone={o.diffVerified ? 'moss' : 'amber'}>
            {o.diffVerified ? 'Diff verified' : 'Diff unverified'}
          </Badge>
          {o.stoppedReason && <Badge tone="amber">{STOP_LABEL[o.stoppedReason]}</Badge>}
        </div>
      </div>

      {o.text ? (
        <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-paper-300">
          {o.text}
        </p>
      ) : (
        <p className="text-[13px] text-paper-500">The agent returned no text.</p>
      )}

      {published && (
        <dl className="text-[13px]">
          {o.branch && (
            <OutcomeRow label="Branch">
              <span className="break-all font-mono text-xs text-paper-200">{o.branch}</span>
            </OutcomeRow>
          )}
          {o.prUrl && isHttpsUrl(o.prUrl) && (
            <OutcomeRow label="Draft PR">
              <a
                className={cn(
                  'inline-flex items-center gap-1 rounded-sm font-medium text-ember-400 transition-colors hover:text-ember-300',
                  FOCUS_RING
                )}
                href={o.prUrl}
                rel="noopener noreferrer"
                target="_blank"
              >
                {o.prNumber ? `#${o.prNumber}` : 'Open'}
                <Icon name="external" size={12} />
              </a>
            </OutcomeRow>
          )}
        </dl>
      )}

      {o.filesChanged.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs font-medium text-paper-400">
            {o.filesChanged.length} file{o.filesChanged.length === 1 ? '' : 's'} changed
          </div>
          <ul className="divide-y divide-ink-600/50 rounded-md border border-ink-500/50 bg-ink-950/40 font-mono text-xs">
            {o.filesChanged.map((f, i) => (
              // Index in the key: a path is not guaranteed unique (a missing one reads "(unknown)").
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              <li className="flex items-baseline gap-2 px-2.5 py-1" key={`${i}:${f.path}`}>
                <span
                  className="w-3 shrink-0 text-center text-paper-500"
                  title={OPERATION_LABEL[f.operation] ?? 'Modified'}
                >
                  {OPERATION_MARK[f.operation] ?? '~'}
                </span>
                <span className="min-w-0 break-all text-paper-200">{f.path}</span>
                <span className="tabular ml-auto shrink-0 text-moss-400">+{f.linesAdded}</span>
                <span className="tabular shrink-0 text-brick-400">−{f.linesRemoved}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {o.diff && (
        <details className="group">
          <summary
            className={cn(
              'inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-[13px] text-ember-400 transition-colors hover:text-ember-300 [&::-webkit-details-marker]:hidden',
              FOCUS_RING
            )}
          >
            <Icon
              className="transition-transform group-open:rotate-90"
              name="chevronRight"
              size={13}
            />
            Show diff{o.diffTruncated ? ' (truncated)' : ''}
          </summary>
          {!o.diffVerified && (
            <p className="mt-2 text-xs text-amber-400">
              This is the agent’s own view of its container. It is for reading, not for trust.
            </p>
          )}
          <pre className="mt-2 max-h-80 overflow-auto rounded-md border border-ink-500/50 bg-ink-950/60 p-3 font-mono text-xs leading-relaxed text-paper-300">
            {o.diff}
          </pre>
          {o.diffTruncated && (
            <p className="mt-1.5 text-xs text-paper-500">
              The diff is cut at {AGENT_RUN_MAX_OUTPUT_DIFF_CHARS.toLocaleString('en-US')}{' '}
              characters.
            </p>
          )}
        </details>
      )}
    </Card>
  );
}

/** Why a failed agent run failed, named by its error type, above the generic failure card. */
export function AgentRunFailureNote({ failure }: { failure: AgentRunFailureView }) {
  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-amber-400/35 bg-amber-400/[0.07] px-3.5 py-3 text-[13px]"
      role="note"
    >
      <Icon className="mt-0.5 text-amber-400" name="warning" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="font-semibold text-amber-400">{failure.title}</span>
          {failure.code && (
            <span className="font-mono text-[11px] text-paper-500">{failure.code}</span>
          )}
        </div>
        <p className="leading-relaxed text-paper-300">{failure.explanation}</p>
      </div>
    </div>
  );
}
