'use client';

import type {
  OrchestrationChildDto,
  OrchestrationDetailDto,
} from '@auto-swe/shared/lib/orchestrationApi';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { useNow } from '@/components/orchestrations/useNow';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { CiBadge } from '@/components/work/PullRequestBadges';
import { useLatestToolCall } from '@/hooks/useLatestToolCall';
import { useCancelChild, useMessageChild } from '@/hooks/useOrchestrations';
import { useRunsForWorkRequest } from '@/hooks/useRuns';
import { usePullRequests } from '@/hooks/useWorkViews';
import {
  describeOrchestrationError,
  elapsedMs,
  httpsUrl,
  isChildRunning,
  isOrchestrationLive,
} from '@/lib/orchestration';
import { requestHref } from '@/lib/requestDisplay';
import { formatDuration, formatTotalCost } from '@/lib/utils';

/** The newest tool call of a run; read once for a finished lane, polled for a running one. */
function LatestToolCall({ poll, runId }: { poll: boolean; runId: string }) {
  const latest = useLatestToolCall(runId, poll).data;
  return (
    <p className="min-w-0 break-words text-xs text-paper-400">
      <span className="text-paper-500">Latest tool call: </span>
      {latest ? (
        <span className="break-all font-mono text-paper-300">{latest.summary}</span>
      ) : (
        'none yet'
      )}
    </p>
  );
}

function ChildMessageBox({
  child,
  orchestrationId,
}: {
  child: OrchestrationChildDto;
  orchestrationId: string;
}) {
  const send = useMessageChild(orchestrationId);
  const [text, setText] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (body && !send.isPending) {
      send.mutate({ body, childId: child.id }, { onSuccess: () => setText('') });
    }
  };
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
      <Input
        className="min-w-0 flex-1"
        label={`Message to ${child.label}`}
        maxLength={4000}
        onChange={(e) => setText(e.target.value)}
        value={text}
      />
      <Button disabled={!text.trim() || send.isPending} type="submit">
        Send <span className="sr-only">to {child.label}</span>
      </Button>
      {send.isError && (
        <div className="w-full">
          <Alert variant="error">{describeOrchestrationError(send.error)}</Alert>
        </div>
      )}
    </form>
  );
}

function ChildLane({
  canControl,
  child,
  live,
  orchestrationId,
}: {
  canControl: boolean;
  child: OrchestrationChildDto;
  /** Whether the orchestration itself is still running; a finished one polls nothing. */
  live: boolean;
  orchestrationId: string;
}) {
  const running = isChildRunning(child.status);
  // Only a running lane of a running orchestration is polled; the rest are read once.
  const polling = running && live;
  const now = useNow(polling);
  const cancel = useCancelChild(orchestrationId);
  // The child names its run once it has one; until then the run viewer's way of finding it, by
  // work request, is asked every 10 s for a lane that is still running, and never after.
  const runs = useRunsForWorkRequest(child.workRequestId, 5, {
    enabled: !child.runId,
    poll: polling,
    untilFound: true,
  });
  const runId = child.runId ?? runs.data?.[0]?.id ?? null;
  const href = runId ? `/runs/${runId}` : requestHref(child.workRequestId);

  return (
    <li className="min-w-0 space-y-2 rounded-lg border border-ink-400 bg-ink-800/70 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 break-words font-medium text-paper-100">{child.label}</h3>
        <StatusBadge status={child.status} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-paper-400">
        <span className="break-all font-mono">{child.agentKey}</span>
        <Badge tone={child.role === 'WRITER' ? 'warning' : 'info'} variant="outline">
          {child.role === 'WRITER' ? 'Writer' : 'Reader'}
        </Badge>
        <span>
          <span className="sr-only">Elapsed: </span>
          {formatDuration(elapsedMs(child.createdAt, child.finishedAt, now))}
        </span>
        <span>
          <span className="sr-only">Spend: </span>
          {formatTotalCost(child.costUsd)}
        </span>
      </div>
      {child.role === 'WRITER' && child.pathScopes.length > 0 && (
        <p className="break-words text-xs text-paper-400">
          <span className="text-paper-500">May change: </span>
          <span className="font-mono">{child.pathScopes.join(', ')}</span>
        </p>
      )}
      {runId && <LatestToolCall poll={polling} runId={runId} />}
      {child.undeliveredSteering > 0 && (
        <p className="text-xs text-warning-400">
          {child.undeliveredSteering} message{child.undeliveredSteering === 1 ? '' : 's'} not
          delivered yet. An agent takes messages between steps.
        </p>
      )}
      {canControl && running && <ChildMessageBox child={child} orchestrationId={orchestrationId} />}
      {cancel.isError && <Alert variant="error">{describeOrchestrationError(cancel.error)}</Alert>}
      <div className="flex flex-wrap items-center gap-3">
        <Link className="text-accent-400 underline underline-offset-2" href={href}>
          {runId ? 'Open the run' : 'Open the request'}{' '}
          <span className="sr-only">for {child.label}</span>
        </Link>
        {canControl && running && (
          <Button
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(child.id)}
            size="sm"
            variant="danger"
          >
            Cancel <span className="sr-only">{child.label}</span>
          </Button>
        )}
      </div>
    </li>
  );
}

/** Sibling pull requests of the writers, each with its branch, link and CI status when known. */
function PullRequestGroup({ detail }: { detail: OrchestrationDetailDto }) {
  const writers = detail.children.filter((c) => c.prUrl || c.branch);
  const pulls = usePullRequests(
    {
      draft: 'any',
      limit: 100,
      offset: 0,
      repoId: detail.repoId ?? undefined,
      scope: detail.canControl ? 'MINE' : 'TEAM',
      state: 'all',
    },
    { enabled: writers.some((c) => c.prUrl) && !!detail.repoId }
  );
  if (writers.length === 0) {
    return null;
  }
  const ciByUrl = new Map((pulls.data ?? []).flatMap((p) => (p.url ? [[p.url, p.ciStatus]] : [])));
  return (
    <section
      aria-label="Pull request group"
      className="rounded-lg border border-ink-400 bg-ink-800/70 p-3 text-sm"
    >
      <h3 className="font-medium text-paper-100">Pull request group</h3>
      <p className="mt-1 text-xs text-paper-500">
        One pull request per writer. People review and merge each one.
      </p>
      <ul className="mt-2 space-y-2">
        {writers.map((child) => {
          const url = httpsUrl(child.prUrl);
          const ci = child.prUrl ? ciByUrl.get(child.prUrl) : undefined;
          return (
            <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" key={child.id}>
              <span className="break-words font-medium text-paper-200">{child.label}</span>
              {child.branch && (
                <span className="break-all font-mono text-xs text-paper-400">{child.branch}</span>
              )}
              {url ? (
                <a
                  className="text-accent-400 underline underline-offset-2"
                  href={url}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  Pull request <span className="sr-only">for {child.label}</span>
                </a>
              ) : (
                <span className="text-paper-500">
                  {child.prUrl ? 'Link unavailable' : 'No pull request'}
                </span>
              )}
              {ci && <CiBadge status={ci} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** One lane per child, then the pull request group. */
export function AgentsColumn({ detail }: { detail: OrchestrationDetailDto }) {
  const live = isOrchestrationLive(detail.status);
  return (
    <section aria-label="Agents" className="min-w-0 space-y-3">
      {detail.children.length === 0 ? (
        <Card>
          <EmptyState
            hint={
              live
                ? 'Agents the orchestrator starts appear here as they run.'
                : 'This orchestration never started an agent.'
            }
            icon="agents"
            title="No agents yet"
          />
        </Card>
      ) : (
        <ul className="space-y-3">
          {detail.children.map((child) => (
            <ChildLane
              canControl={detail.canControl}
              child={child}
              key={child.id}
              live={live}
              orchestrationId={detail.id}
            />
          ))}
        </ul>
      )}
      <PullRequestGroup detail={detail} />
    </section>
  );
}
