'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { useAnsweredGate } from '@/hooks/useAnsweredGate';
import { useHasRole } from '@/hooks/useHasRole';
import { useRepositories } from '@/hooks/useRepositories';
import { useRequests } from '@/hooks/useRequests';
import { usePullRequests } from '@/hooks/useWorkViews';
import { focusMainContent, useDismissed } from '@/lib/dismissed';
import { cn, FOCUS_RING } from '@/lib/utils';

export const FIRST_RUN_DISMISS_KEY = 'first-run-checklist';

interface Step {
  id: string;
  title: string;
  /** What the step is and where to do it; shown while the step is open. */
  body: ReactNode;
  done: boolean;
  href: string;
  action: string;
}

/**
 * Home checklist for someone who is not an admin: the path from "I can sign in" to "I merged my
 * first agent-written change". Every tick comes from data the person can already read, never from
 * a click. Admins do not see it: they have the setup card and the governance guide, and
 * their first run depends on that setup being finished.
 */
export function FirstRunChecklist() {
  const isAdmin = useHasRole('ADMIN');
  if (isAdmin) {
    return null;
  }
  return <FirstRunChecklistBody />;
}

function FirstRunChecklistBody() {
  const isLead = useHasRole('LEAD');
  const { ready, dismissed, dismiss } = useDismissed(FIRST_RUN_DISMISS_KEY);
  // Personal progress, so the shell's selected-team filter does not apply to the two lists.
  // Connections of every type come back, so the repository step looks for a git repository.
  const repos = useRepositories({ limit: 500 });
  const requests = useRequests({ limit: 1, scope: 'MINE', state: 'all' }, { ignoreTeam: true });
  const merged = usePullRequests(
    { draft: 'any', limit: 1, offset: 0, scope: 'MINE', state: 'MERGED' },
    { ignoreTeam: true }
  );
  // Gates are not filtered by the selected team, so this needs no opt-out.
  const answered = useAnsweredGate();

  const queries = [repos, requests, answered, merged];
  const settled = queries.every((q) => !q.isLoading);
  // A query that failed cannot say a step is open, so show nothing rather than a false prompt.
  if (!ready || dismissed || !settled || queries.some((q) => q.isError)) {
    return null;
  }

  const hasRepo = (repos.data ?? []).some((r) => r.type === 'git_repo');
  const steps: Step[] = [
    {
      action: hasRepo ? 'View repositories' : isLead ? 'Connect a repository' : 'Open connections',
      body: 'No repository is visible to you yet. If you lead a team, connect one; otherwise ask a lead or an admin to connect one or share one with your team.',
      done: hasRepo,
      href: '/connections',
      id: 'repository',
      title: 'See a repository you can work on',
    },
    {
      action: 'Start work',
      body: 'Describe the work and pick a repository. You review it before it launches.',
      done: (requests.data?.meta.total ?? 0) > 0,
      href: '/start',
      id: 'task',
      title: 'Start your first task',
    },
    {
      action: 'Open approvals',
      body: 'When a run reaches a gate, it waits for a person. Answer it in Approvals. A workflow with no gates never needs this step, so the card stays until you dismiss it.',
      done: (answered.data?.meta.total ?? 0) > 0,
      href: '/approvals',
      id: 'gate',
      title: 'Answer a gate when a run reaches one',
    },
    {
      action: 'Open pull requests',
      body: 'The run opens a pull request on the repository. Review it and merge it yourself: nothing merges it for you. This step ticks when the platform records the merge, which needs the GitHub webhook to be set up.',
      done: (merged.meta?.total ?? 0) > 0,
      href: '/pull-requests',
      id: 'merge',
      title: 'A pull request from your request is merged',
    },
  ];
  // Hide only when every step is verified done; an unreadable query never counts as done.
  if (steps.every((step) => step.done)) {
    return null;
  }
  const nextId = steps.find((step) => !step.done)?.id;
  const doneCount = steps.filter((step) => step.done).length;

  return (
    <Card data-testid="first-run-checklist">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight text-paper-50">Your first run</h2>
          <p className="mt-1 text-sm text-paper-400">
            Steps tick themselves off from what the platform records for you.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="tabular text-sm text-paper-300">
            {doneCount} of {steps.length} done
          </span>
          <Button
            aria-label="Dismiss the first-run checklist"
            onClick={() => {
              dismiss();
              focusMainContent();
            }}
            size="sm"
            variant="ghost"
          >
            Dismiss
          </Button>
        </div>
      </div>
      <ol className="mt-5 divide-y divide-ink-600 overflow-hidden rounded-lg border border-ink-500/60">
        {steps.map((step, index) => (
          <li
            className={cn(
              'flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3',
              !step.done && 'bg-ink-800/40'
            )}
            key={step.id}
          >
            <span
              aria-hidden="true"
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs tabular',
                step.done
                  ? 'border-success-400/40 bg-success-400/15 text-success-400'
                  : 'border-ink-400 text-paper-400'
              )}
            >
              {step.done ? <Icon name="check" size={13} strokeWidth={2.4} /> : index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div
                className={cn(
                  'text-sm font-medium',
                  step.done ? 'text-paper-400' : 'text-paper-100'
                )}
              >
                {step.title}
                <span className="sr-only">{step.done ? ' (done)' : ' (to do)'}</span>
              </div>
              {!step.done && <div className="mt-0.5 text-xs text-paper-400">{step.body}</div>}
            </div>
            {!step.done && (
              <Link
                className={cn(
                  'inline-flex shrink-0 items-center gap-1 rounded-sm text-sm hover:underline',
                  step.id === nextId ? 'font-medium text-accent-400' : 'text-paper-300',
                  FOCUS_RING
                )}
                href={step.href}
              >
                {step.action}
                <Icon name="arrowRight" size={13} />
              </Link>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
