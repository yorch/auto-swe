'use client';

import { useEffect, useRef, useState } from 'react';
import { LaunchCardHeader } from '@/components/requests/LaunchSteps';
import { RunsUnderNote } from '@/components/requests/RunsUnderNote';
import { useStartScope } from '@/components/requests/StartScope';
import { MyPlans } from '@/components/runPlans/MyPlans';
import { RunPlanPreview } from '@/components/runPlans/RunPlanPreview';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { Icon } from '@/components/ui/Icon';
import { Textarea } from '@/components/ui/Textarea';
import { useAgentRunAgents } from '@/hooks/useAgentRuns';
import { useRepositories } from '@/hooks/useRepositories';
import { usePlanJob, useRoutePlan, useStartPlanJob } from '@/hooks/useRunPlans';
import { useIsViewOnly } from '@/hooks/useViewOnlyRepos';
import { type IdempotencyState, idempotencyFor } from '@/lib/agentRun';
import { connectionLabel } from '@/lib/connectionDisplay';
import { groupedRepoOptions } from '@/lib/repoGroups';
import { VIEW_ONLY_REASON } from '@/lib/repoLaunch';
import {
  buildCreateBody,
  describeJobFailure,
  describePlanError,
  intentCounter,
  intentError,
  type PlanErrorView,
  type RouteResult,
  RUN_PLAN_INTENT_MAX_CHARS,
  SLOW_AFTER_MS,
  workflowLaunchHref,
} from '@/lib/runPlan';

type Stage =
  | { kind: 'compose' }
  | { kind: 'matches'; result: RouteResult }
  | { kind: 'generating'; jobId: string }
  | { kind: 'preview'; planId: string };

const NO_AGENT = '';

function Failure({ view }: { view: PlanErrorView }) {
  return (
    <Alert title={view.title}>
      <div>{view.message}</div>
      {view.hint && <div className="mt-1 opacity-80">{view.hint}</div>}
    </Alert>
  );
}

/** Polls one job and reports its end; the polling stops with this component. */
function Generating({
  jobId,
  onBack,
  onDone,
  onFailed,
}: {
  jobId: string;
  onBack: () => void;
  onDone: (planId: string) => void;
  onFailed: () => void;
}) {
  const job = usePlanJob(jobId);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(id);
  }, []);
  const status = job.data;
  useEffect(() => {
    if (status?.status === 'done') {
      onDone(status.planId);
    } else if (status?.status === 'failed') {
      onFailed();
    }
  }, [status, onDone, onFailed]);

  const failure: PlanErrorView | null =
    status?.status === 'failed'
      ? describeJobFailure(status)
      : job.isError
        ? describePlanError(job.error)
        : null;
  return (
    <Card className="space-y-4">
      <LaunchCardHeader
        description="The platform is writing a plan for your goal. This can take a minute or two."
        stage="details"
        title="Generating a plan"
      />
      <div aria-live="polite" role="status">
        {failure ? (
          <span className="sr-only">Generation failed</span>
        ) : (
          <span className="flex items-center gap-2 text-sm text-paper-300">
            <Icon name="clock" size={14} />
            {slow
              ? 'Still working. This is taking longer than usual; you can leave and open it later from My plans.'
              : 'Working on your plan…'}
          </span>
        )}
      </div>
      {failure && <Failure view={failure} />}
      <div className="flex justify-end border-t border-ink-600 pt-4">
        <Button onClick={onBack} variant={failure ? 'primary' : 'ghost'}>
          {failure ? (failure.retryable ? 'Edit and try again' : 'Back') : 'Cancel'}
        </Button>
      </div>
    </Card>
  );
}

export function RunPlanLauncher({
  initialJobId = null,
  initialPlanId = null,
  onLaunched,
}: {
  /** Resume polling a generation job (a link from Slack). */
  initialJobId?: string | null;
  /** Open an existing plan's preview (a link from Slack or My plans). */
  initialPlanId?: string | null;
  onLaunched: (requestId: string) => void;
}) {
  const [stage, setStage] = useState<Stage>(
    initialPlanId
      ? { kind: 'preview', planId: initialPlanId }
      : initialJobId
        ? { jobId: initialJobId, kind: 'generating' }
        : { kind: 'compose' }
  );
  const [intent, setIntent] = useState('');
  const [repoId, setRepoId] = useState('');
  const [agent, setAgent] = useState(NO_AGENT);
  const [attempted, setAttempted] = useState(false);
  const [failure, setFailure] = useState<PlanErrorView | null>(null);
  const idempotency = useRef<IdempotencyState | null>(null);
  const submitting = useRef(false);

  const repos = useRepositories({ limit: 500 });
  const isViewOnly = useIsViewOnly();
  const scope = useStartScope();
  const gitRepos = (repos.data ?? []).filter((r) => r.type === 'git_repo');
  const agents = useAgentRunAgents(repoId || null);
  const agentList = agents.data ?? [];
  const effectiveAgent = agentList.some((a) => a.key === agent) ? agent : NO_AGENT;
  const route = useRoutePlan();
  const start = useStartPlanJob();

  const problem = intentError(intent);
  const errors = {
    intent: problem ?? undefined,
    repoId: repoId ? undefined : 'Choose a repository',
  };
  const valid = !errors.intent && !errors.repoId;

  const generate = (input: { intent: string; repoId: string; agent: string }, fresh: boolean) => {
    if (submitting.current) {
      return;
    }
    submitting.current = true;
    const body = buildCreateBody(input);
    // The same input after a dropped connection reuses its key; a regeneration or retry is a
    // new attempt by intent and gets a fresh one.
    idempotency.current = idempotencyFor(fresh ? null : idempotency.current, body);
    setFailure(null);
    start.mutate(
      { body, idempotencyKey: idempotency.current.key },
      {
        onError: (err) => setFailure(describePlanError(err)),
        onSettled: () => {
          submitting.current = false;
        },
        onSuccess: (jobId) => setStage({ jobId, kind: 'generating' }),
      }
    );
  };

  const findMatches = () => {
    setAttempted(true);
    if (!valid || route.isPending) {
      return;
    }
    setFailure(null);
    route.mutate(
      { intent: intent.trim(), repoId },
      {
        onError: (err) => setFailure(describePlanError(err)),
        onSuccess: (result) => setStage({ kind: 'matches', result }),
      }
    );
  };

  const backToCompose = () => {
    idempotency.current = null;
    setFailure(null);
    setStage({ kind: 'compose' });
  };

  if (stage.kind === 'generating') {
    return (
      <div className="space-y-6">
        <Generating
          jobId={stage.jobId}
          onBack={backToCompose}
          onDone={(planId) => {
            idempotency.current = null;
            setStage({ kind: 'preview', planId });
          }}
          onFailed={() => {
            // The next attempt is a new one, never a replay of the failed job.
            idempotency.current = null;
          }}
        />
      </div>
    );
  }

  if (stage.kind === 'preview') {
    return (
      <div className="space-y-6">
        {failure && <Failure view={failure} />}
        <RunPlanPreview
          onApproved={onLaunched}
          onBack={backToCompose}
          onRegenerate={(plan) => {
            setIntent(plan.intent);
            setRepoId(plan.connectionId);
            setAgent(plan.agentKey ?? NO_AGENT);
            generate(
              { agent: plan.agentKey ?? NO_AGENT, intent: plan.intent, repoId: plan.connectionId },
              true
            );
          }}
          planId={stage.planId}
        />
      </div>
    );
  }

  if (stage.kind === 'matches') {
    const { matches, noneFit } = stage.result;
    return (
      <Card className="space-y-5">
        <LaunchCardHeader
          description="An existing workflow may already do this. Use one, or have a new plan generated."
          stage="details"
          title="Matching workflows"
        />
        {failure && <Failure view={failure} />}
        {noneFit || matches.length === 0 ? (
          <Alert variant="info">No existing workflow fits this goal well.</Alert>
        ) : (
          <ul aria-label="Matching workflows" className="space-y-3">
            {matches.map((m) => (
              <li
                className="flex flex-wrap items-start gap-3 rounded-lg border border-ink-500/60 bg-ink-900/40 p-3"
                data-testid="route-match"
                key={m.templateId}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-paper-100">{m.name}</span>
                    <Badge tone="neutral" variant="outline">
                      Score {Math.round(m.score * 100)}%
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-paper-400">{m.reason}</p>
                </div>
                <ButtonLink href={workflowLaunchHref(m.templateId, repoId)} variant="secondary">
                  Use this workflow
                </ButtonLink>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap justify-end gap-3 border-t border-ink-600 pt-4">
          <Button onClick={backToCompose} variant="ghost">
            Edit goal
          </Button>
          <Button
            disabled={start.isPending}
            onClick={() => generate({ agent: effectiveAgent, intent, repoId }, false)}
            variant="primary"
          >
            {start.isPending ? 'Starting…' : 'Generate a new plan'}
            {!start.isPending && <Icon name="arrowRight" size={14} />}
          </Button>
        </div>
      </Card>
    );
  }

  const overLength = intent.length > RUN_PLAN_INTENT_MAX_CHARS;
  return (
    <div className="space-y-6">
      <Card className="space-y-5">
        <LaunchCardHeader
          description="Say what you want done. You review a plan before anything runs."
          stage="details"
          title="Describe the goal"
        />
        {failure && <Failure view={failure} />}
        <Combobox
          emptyMessage="No repositories match"
          error={attempted ? errors.repoId : undefined}
          hint={repos.isError ? 'Could not load repositories' : 'Repositories your teams can reach'}
          label="Repository"
          onChange={(v) => {
            setRepoId(v);
            setAgent(NO_AGENT);
          }}
          options={groupedRepoOptions(gitRepos, scope?.team ?? null, connectionLabel, (r) =>
            isViewOnly(r) ? VIEW_ONLY_REASON : null
          )}
          placeholder={repos.isLoading ? 'Loading…' : 'Choose a repository…'}
          required
          value={repoId}
        />
        <RunsUnderNote
          owner={gitRepos.find((r) => r.id === repoId)?.team}
          scope={scope?.team ?? null}
        />
        <Textarea
          error={
            overLength
              ? `${intentCounter(intent)}. ${errors.intent}`
              : attempted
                ? errors.intent
                : undefined
          }
          hint={intentCounter(intent)}
          label="Goal"
          mono={false}
          onChange={(e) => setIntent(e.target.value)}
          placeholder="What should be done, and what does done look like?"
          required
          rows={8}
          value={intent}
        />
        <Combobox
          disabled={!repoId}
          emptyMessage="No launchable agents"
          hint={
            agents.isError
              ? 'Could not load agents'
              : effectiveAgent
                ? 'The plan is built on this agent and is output only.'
                : 'Optional. Leave empty for a plan that can open a pull request.'
          }
          label="Run with a library agent (optional)"
          onChange={setAgent}
          options={[
            { label: 'No agent (plan may deliver a pull request)', value: NO_AGENT },
            ...agentList.map((a) => ({ label: a.name, value: a.key })),
          ]}
          placeholder={agents.isLoading && repoId ? 'Loading…' : 'No agent'}
          value={effectiveAgent}
        />
        {effectiveAgent && (
          <Alert variant="info">
            A plan built on a library agent is output only. It produces reviewed text or artifacts
            and opens no pull request.
          </Alert>
        )}
        <div className="flex flex-wrap justify-end gap-3 border-t border-ink-600 pt-4">
          <Button
            disabled={start.isPending || overLength}
            onClick={() => {
              setAttempted(true);
              if (valid) {
                generate({ agent: effectiveAgent, intent, repoId }, false);
              }
            }}
            variant="ghost"
          >
            Skip matching and generate
          </Button>
          <Button disabled={route.isPending || overLength} onClick={findMatches} variant="primary">
            {route.isPending ? 'Finding…' : 'Find matches'}
            {!route.isPending && <Icon name="arrowRight" size={14} />}
          </Button>
        </div>
      </Card>
      <MyPlans onOpen={(planId) => setStage({ kind: 'preview', planId })} />
    </div>
  );
}
