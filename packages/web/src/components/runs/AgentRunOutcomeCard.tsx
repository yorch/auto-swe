'use client';

import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import {
  type AgentRunFailureView,
  type AgentRunOutcome,
  parseAgentRunOutcome,
} from '@/lib/agentRun';

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
    <Card className="space-y-3 p-3" variant="inset">
      <div className="label-mono">Agent run outcome</div>

      <div className="flex flex-wrap gap-1.5">
        {o.gate && (
          <Badge tone={o.gate === 'passed' ? 'moss' : 'neutral'}>{GATE_LABEL[o.gate]}</Badge>
        )}
        <Badge tone={o.diffVerified ? 'moss' : 'amber'}>
          {o.diffVerified ? 'diff verified' : 'diff unverified'}
        </Badge>
        {o.stoppedReason && <Badge tone="amber">{STOP_LABEL[o.stoppedReason]}</Badge>}
      </div>

      {o.text ? (
        <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-paper-300">
          {o.text}
        </p>
      ) : (
        <p className="text-[12px] text-paper-500">The agent returned no text.</p>
      )}

      {published && (
        <dl className="space-y-1 text-[12px]">
          {o.branch && (
            <div className="flex justify-between gap-2">
              <dt className="kicker shrink-0">Branch</dt>
              <dd className="min-w-0 break-all text-right font-mono text-paper-300">{o.branch}</dd>
            </div>
          )}
          {o.prUrl && isHttpsUrl(o.prUrl) && (
            <div className="flex justify-between gap-2">
              <dt className="kicker shrink-0">Draft PR</dt>
              <dd className="min-w-0 text-right">
                <a
                  className="text-ember-400 hover:text-ember-600"
                  href={o.prUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {o.prNumber ? `#${o.prNumber}` : 'open'} ↗
                </a>
              </dd>
            </div>
          )}
        </dl>
      )}

      {o.filesChanged.length > 0 && (
        <div>
          <div className="kicker mb-1">
            {o.filesChanged.length} file{o.filesChanged.length === 1 ? '' : 's'} changed
          </div>
          <ul className="space-y-0.5 font-mono text-[11px]">
            {o.filesChanged.map((f) => (
              <li className="flex gap-1.5" key={f.path}>
                <span className="text-paper-500">{OPERATION_MARK[f.operation] ?? '~'}</span>
                <span className="min-w-0 break-all text-paper-300">{f.path}</span>
                <span className="ml-auto shrink-0 text-moss-400">+{f.linesAdded}</span>
                <span className="shrink-0 text-brick-400">−{f.linesRemoved}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {o.diff && (
        <details>
          <summary className="cursor-pointer text-[12px] text-ember-400 hover:text-ember-600">
            Show diff{o.diffTruncated ? ' (truncated)' : ''}
          </summary>
          {!o.diffVerified && (
            <p className="mt-1 text-[11px] text-amber-400">
              This is the agent’s own view of its container. It is for reading, not for trust.
            </p>
          )}
          <pre className="mt-1 max-h-80 overflow-auto rounded border border-ink-400/40 bg-ink-950/60 p-2 font-mono text-[10.5px] leading-snug text-paper-300">
            {o.diff}
          </pre>
          {o.diffTruncated && (
            <p className="mt-1 text-[11px] text-paper-500">
              The diff is cut at 100,000 characters.
            </p>
          )}
        </details>
      )}
    </Card>
  );
}

/** Why a failed agent run failed, named by the PR 1 error code, above the generic failure card. */
export function AgentRunFailureNote({ failure }: { failure: AgentRunFailureView }) {
  return (
    <div className="rounded border border-amber-400/40 bg-amber-400/10 p-3 text-[12px]" role="note">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-medium text-amber-400">{failure.title}</span>
        {failure.code && (
          <span className="font-mono text-[10px] text-paper-500">{failure.code}</span>
        )}
      </div>
      <p className="leading-relaxed text-paper-300">{failure.explanation}</p>
    </div>
  );
}
