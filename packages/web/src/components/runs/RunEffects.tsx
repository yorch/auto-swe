'use client';

import type { RunEffectDto } from '@auto-swe/shared/types/api';
import { Badge } from '@/components/ui/Badge';
import { useRunEffects } from '@/hooks/useRunEffects';
import { formatDate } from '@/lib/utils';

const KIND_LABELS: Record<string, string> = {
  GIT_PUSH: 'Git push',
  KNOWLEDGE_BASE: 'Knowledge base',
  MCP_TOOL: 'MCP tool',
  PULL_REQUEST: 'Pull request',
  TRACKER: 'Tracker',
};

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function EffectLine({ effect }: { effect: RunEffectDto }) {
  const failed = effect.status === 'FAILED';
  const skipped = effect.status === 'SKIPPED';
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone="muted" variant="outline">
          {KIND_LABELS[effect.kind] ?? effect.kind}
        </Badge>
        <span className="font-medium text-paper-100">{effect.action}</span>
        <Badge tone={failed ? 'danger' : skipped ? 'muted' : 'success'} variant="outline">
          {failed ? 'Failed' : skipped ? 'Skipped' : 'Done'}
        </Badge>
        <span className="text-xs text-paper-500">{formatDate(effect.createdAt)}</span>
      </div>
      {effect.target && (
        <p className="mt-1 break-all font-mono text-xs text-paper-300">
          {isHttpUrl(effect.target) ? (
            <a
              className="underline underline-offset-2"
              href={effect.target}
              rel="noreferrer noopener"
              target="_blank"
            >
              {effect.target}
            </a>
          ) : (
            effect.target
          )}
        </p>
      )}
      {effect.error && <p className="mt-1 text-xs text-danger-400">{effect.error}</p>}
      {effect.detail != null && (
        <pre className="mt-1 overflow-x-auto font-mono text-xs text-paper-500">
          {JSON.stringify(effect.detail)}
        </pre>
      )}
    </li>
  );
}

/**
 * What this run changed outside the sandbox: MCP writes, pull requests, pushes, tracker and
 * knowledge-base writes (docs/audit-log.md §5). Renders nothing for a run that changed nothing.
 */
export function RunEffects({ runId, live }: { runId: string; live: boolean }) {
  const { data } = useRunEffects(runId, live);
  if (!data || data.data.length === 0) {
    return null;
  }
  const failed = data.data.filter((e) => e.status === 'FAILED').length;
  return (
    <details className="rounded border border-ink-700 px-4 py-3 text-sm">
      <summary className="cursor-pointer text-paper-300">
        External effects
        <span className="ml-2 text-xs text-paper-500">
          {data.data.length}
          {data.truncated && '+'} recorded
          {failed > 0 && `, ${failed} failed`}
        </span>
      </summary>
      <ul className="mt-3 divide-y divide-ink-700">
        {data.data.map((effect) => (
          <EffectLine effect={effect} key={effect.id} />
        ))}
      </ul>
    </details>
  );
}
