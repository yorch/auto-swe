'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { LaunchCardHeader, ReviewList } from '@/components/requests/LaunchSteps';
import { RunsUnderNote } from '@/components/requests/RunsUnderNote';
import { useStartScope } from '@/components/requests/StartScope';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Combobox } from '@/components/ui/Combobox';
import { Icon } from '@/components/ui/Icon';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { useCan } from '@/hooks/useCan';
import { useMcpConnections } from '@/hooks/useMcpConnections';
import {
  useLaunchOrchestration,
  useOrchestrationAgents,
  useOrchestrationConnections,
  useOrchestrationDefaults,
} from '@/hooks/useOrchestrations';
import { useRepositories } from '@/hooks/useRepositories';
import { useTeams } from '@/hooks/useTeams';
import { useIsViewOnly } from '@/hooks/useViewOnlyRepos';
import { type IdempotencyState, idempotencyFor } from '@/lib/agentRun';
import { connectionLabel } from '@/lib/connectionDisplay';
import {
  BUDGET_TIER_OPTIONS,
  buildOrchestrateBody,
  DELIVERY_DEFAULT_OPTIONS,
  describeOrchestrationError,
  ORCHESTRATE_MAX_TASK_CHARS,
  type OrchestrateBudgetTier,
  type OrchestrateDelivery,
  type OrchestrateFormValues,
  validateOrchestrateForm,
} from '@/lib/orchestration';
import { groupedRepoOptions } from '@/lib/repoGroups';
import { VIEW_ONLY_REASON } from '@/lib/repoLaunch';

const NO_REPO = 'none';

/** A connection the launcher may choose; `usedBy` is known only from the ADMIN platform list. */
interface ConnectionOption {
  id: string;
  name: string | null;
  usedBy?: { key: string; name: string }[];
}

const EMPTY: OrchestrateFormValues = {
  allowlist: [],
  budgetTier: 'STANDARD',
  connectionIds: [],
  deliveryDefault: 'none',
  repoId: '',
  task: '',
  teamId: '',
};

/** The Start work form for an orchestration, with a review step before it launches. */
export function OrchestrateForm({
  onLaunched,
}: {
  onLaunched?: (orchestrationId: string) => void;
} = {}) {
  const router = useRouter();
  const scope = useStartScope();
  // The platform's connection list (which also says which agents use each) needs
  // `platform.integrations.manage`; anyone else reads their team's connections.
  const isAdmin = useCan('platform.integrations.manage');
  const [values, setValues] = useState<OrchestrateFormValues>(EMPTY);
  const [reviewing, setReviewing] = useState(false);
  const [attempted, setAttempted] = useState(false);
  // Until the person changes the agent choice, it is the platform default for the named team.
  const [allowlistTouched, setAllowlistTouched] = useState(false);
  const idempotency = useRef<IdempotencyState | null>(null);
  const submitting = useRef(false);

  const teams = useTeams({ memberOnly: true });
  const repos = useRepositories({ limit: 500 });
  const isViewOnly = useIsViewOnly();
  const launch = useLaunchOrchestration();
  const gitRepos = (repos.data ?? []).filter((r) => r.type === 'git_repo');
  const repo = gitRepos.find((r) => r.id === values.repoId);
  // Default the team: the Start work scope, else the caller's only team.
  const memberTeams = teams.data ?? [];
  const defaultTeamId = scope?.team?.id ?? (memberTeams.length === 1 ? memberTeams[0].id : '');
  const effective: OrchestrateFormValues = {
    ...values,
    teamId: values.teamId || defaultTeamId,
  };
  const namedTeamId = repo ? repo.team?.id : effective.teamId;
  const agents = useOrchestrationAgents(values.repoId || null);
  // Whoever holds it reads the platform list; anyone else reads the team's connections from the
  // orchestration route, open to its members.
  const adminConnections = useMcpConnections({ enabled: isAdmin });
  const memberConnections = useOrchestrationConnections(isAdmin ? '' : (namedTeamId ?? ''));
  const teamConnections: ConnectionOption[] = isAdmin
    ? (adminConnections.data ?? []).filter((c) => c.teamId === namedTeamId)
    : (memberConnections.data ?? []);
  const connectionsFailed = isAdmin ? adminConnections.isError : memberConnections.isError;
  const defaults = useOrchestrationDefaults(namedTeamId ?? '');
  const agentList = agents.data ?? [];
  const chosenAllowlist = allowlistTouched ? effective.allowlist : (defaults.data?.allowlist ?? []);
  // A repository change can drop an agent the organization overrides differently.
  const allowlist = chosenAllowlist.filter((k) => agentList.some((a) => a.key === k));
  const usingDefault = !allowlistTouched && allowlist.length > 0;
  // Only the platform default is classified (an organization override of a default agent can make
  // it write-capable); other agents are not marked, which is not a claim that they cannot write.
  const writeCapable = new Set(defaults.data?.writeCapable ?? []);
  const checked: OrchestrateFormValues = {
    ...effective,
    allowlist,
    connectionIds: effective.connectionIds.filter((id) => teamConnections.some((c) => c.id === id)),
  };
  const errors = validateOrchestrateForm(checked);
  const show = (key: keyof typeof errors) => (attempted ? errors[key] : undefined);

  const set = <K extends keyof OrchestrateFormValues>(key: K, value: OrchestrateFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    if (launch.isError) {
      launch.reset();
    }
  };
  const toggle = (key: 'allowlist' | 'connectionIds', item: string) => {
    if (key === 'allowlist') {
      setAllowlistTouched(true);
    }
    set(
      key,
      checked[key].includes(item) ? checked[key].filter((x) => x !== item) : [...checked[key], item]
    );
  };

  const goReview = () => {
    setAttempted(true);
    if (Object.keys(errors).length === 0) {
      launch.reset();
      setReviewing(true);
    }
  };

  const submit = () => {
    setAttempted(true);
    if (Object.keys(errors).length > 0 || launch.isPending || submitting.current) {
      return;
    }
    submitting.current = true;
    const body = buildOrchestrateBody(checked);
    idempotency.current = idempotencyFor(idempotency.current, body);
    launch.mutate(
      { body, idempotencyKey: idempotency.current.key },
      {
        onSettled: () => {
          submitting.current = false;
        },
        onSuccess: (result) => {
          idempotency.current = null;
          if (onLaunched) {
            onLaunched(result.orchestrationId);
          } else {
            router.push(`/orchestrations/${encodeURIComponent(result.orchestrationId)}`);
          }
        },
      }
    );
  };

  const launchError = launch.isError ? describeOrchestrationError(launch.error) : null;
  const chosenConnections = teamConnections.filter((c) => checked.connectionIds.includes(c.id));
  // An agent that uses MCP asks before every write, whether or not its connection was chosen.
  const allowedAgentUsesMcp = teamConnections.some((c) =>
    (c.usedBy ?? []).some((u) => allowlist.includes(u.key))
  );
  const writesAsk = chosenConnections.length > 0 || allowedAgentUsesMcp;

  if (reviewing) {
    return (
      <Card className="space-y-5">
        <LaunchCardHeader
          description="Check what the orchestrator may do, then launch it."
          stage="review"
          title="Review and launch"
        />
        <ReviewList
          items={[
            { label: 'Task', multiline: true, value: checked.task },
            {
              label: 'Repository',
              value: repo
                ? connectionLabel(repo)
                : 'None. Agents can read and report, not change code.',
            },
            {
              label: 'Runs under',
              value:
                repo?.team?.name ?? memberTeams.find((t) => t.id === checked.teamId)?.name ?? '',
            },
            {
              label: usingDefault
                ? 'Agents it may start (platform default)'
                : 'Agents it may start',
              value: agentList
                .filter((a) => allowlist.includes(a.key))
                .map((a) => (writeCapable.has(a.key) ? `${a.name} (can change files)` : a.name))
                .join(', '),
            },
            {
              label: 'MCP connections',
              value:
                chosenConnections.length === 0
                  ? 'None chosen. Agents get no MCP tools.'
                  : chosenConnections
                      .map((c) => {
                        if (!c.usedBy) {
                          return c.name ?? c.id;
                        }
                        const reach = c.usedBy
                          .filter((u) => allowlist.includes(u.key))
                          .map((u) => u.name);
                        return `${c.name ?? c.id} (reachable by ${reach.length ? reach.join(', ') : 'no chosen agent'})`;
                      })
                      .join('; '),
            },
            {
              label: 'Budget',
              value: BUDGET_TIER_OPTIONS.find((o) => o.value === checked.budgetTier)?.label,
            },
            {
              label: 'Delivery',
              value: DELIVERY_DEFAULT_OPTIONS.find(
                (o) => o.value === (repo ? checked.deliveryDefault : 'none')
              )?.label,
            },
          ]}
        />
        {writesAsk && (
          <Alert title="Every write asks first" variant="warning">
            Every MCP call that is not marked read-only will wait for your approval before it runs,
            and is denied if you do not answer in time.
          </Alert>
        )}
        <Alert variant="info">
          Only you can message the orchestrator, attach a repository or approve calls. Teammates can
          watch. No pull request is merged for you.
        </Alert>
        {launchError && <Alert title="Could not launch">{launchError}</Alert>}
        <div className="flex flex-wrap justify-end gap-3 border-t border-ink-600 pt-4">
          <Button disabled={launch.isPending} onClick={() => setReviewing(false)} variant="ghost">
            Back to details
          </Button>
          <Button disabled={launch.isPending} onClick={submit} variant="primary">
            {launch.isPending ? 'Starting…' : 'Launch orchestration'}
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="space-y-5">
      <LaunchCardHeader
        description="Say what you want done. The orchestrator plans it and starts the agents you allow."
        stage="details"
        title="Task details"
      />
      {launchError && <Alert title="Could not launch">{launchError}</Alert>}
      <Textarea
        error={show('task')}
        hint={`${values.task.length.toLocaleString('en-US')} / ${ORCHESTRATE_MAX_TASK_CHARS.toLocaleString('en-US')}`}
        label="Task"
        mono={false}
        onChange={(e) => set('task', e.target.value)}
        placeholder="Investigate the failing checkout flow, then fix what you find."
        required
        rows={6}
        value={values.task}
      />
      <Combobox
        emptyMessage="No repositories match"
        hint="Optional. Without one, agents can read and report but not change code. The orchestrator can ask you to attach one later."
        label="Repository"
        onChange={(v) => set('repoId', v === NO_REPO ? '' : v)}
        options={[
          { label: 'No repository (read-only)', value: NO_REPO },
          ...groupedRepoOptions(gitRepos, scope?.team ?? null, connectionLabel, (r) =>
            isViewOnly(r) ? VIEW_ONLY_REASON : null
          ),
        ]}
        placeholder={repos.isLoading ? 'Loading…' : 'No repository (read-only)'}
        value={values.repoId || NO_REPO}
      />
      {repo ? (
        <RunsUnderNote owner={repo.team} scope={scope?.team ?? null} />
      ) : (
        <Select
          error={show('teamId')}
          hint="Required without a repository. The work is billed to this team."
          label="Team"
          onChange={(v) => set('teamId', v)}
          options={[
            { label: teams.isLoading ? 'Loading…' : 'Choose a team…', value: '' },
            ...memberTeams.map((t) => ({ label: t.name, value: t.id })),
          ]}
          required
          value={effective.teamId}
        />
      )}
      <fieldset aria-describedby="orch-allowlist-hint" className="space-y-2">
        <legend className="label-mono mb-1 block">
          Agents it may start <span className="text-danger-400">*</span>
        </legend>
        <p className="text-xs text-paper-500" id="orch-allowlist-hint">
          The orchestrator can start only these. Choose the fewest it needs.
          {usingDefault &&
            ' Pre-selected from your platform default; change it if this task needs less.'}
        </p>
        {agents.isLoading && <p className="text-sm text-paper-500">Loading agents…</p>}
        {agents.isError && <Alert variant="error">Could not load the launchable agents.</Alert>}
        <div className="grid gap-2 sm:grid-cols-2">
          {agentList.map((a) => (
            <Checkbox
              checked={allowlist.includes(a.key)}
              hint={a.description ?? undefined}
              key={a.key}
              label={`${a.scope === 'ORGANIZATION' ? `${a.name} (organization)` : a.name}${
                writeCapable.has(a.key) ? ' (can change files)' : ''
              }`}
              onChange={() => toggle('allowlist', a.key)}
            />
          ))}
        </div>
        {show('allowlist') && (
          <p className="text-xs text-danger-400" role="alert">
            {show('allowlist')}
          </p>
        )}
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="label-mono mb-1 block">MCP connections</legend>
        <p className="text-xs text-paper-500">
          Optional. Only this team’s connections, fixed for the whole orchestration. Every call that
          is not read-only asks for your approval.
        </p>
        {connectionsFailed && (
          <Alert variant="error">Could not load this team’s MCP connections.</Alert>
        )}
        {teamConnections.length === 0 && !connectionsFailed ? (
          <p className="text-sm text-paper-500">This team has no MCP connections.</p>
        ) : (
          teamConnections.map((c) => (
            <Checkbox
              checked={checked.connectionIds.includes(c.id)}
              key={c.id}
              label={c.name ?? c.id}
              onChange={() => toggle('connectionIds', c.id)}
            />
          ))
        )}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          label="Budget"
          onChange={(v) => set('budgetTier', v as OrchestrateBudgetTier)}
          options={BUDGET_TIER_OPTIONS}
          value={values.budgetTier}
        />
        <Select
          disabled={!repo}
          hint={repo ? undefined : 'Delivery needs a repository.'}
          label="Delivery default"
          onChange={(v) => set('deliveryDefault', v as OrchestrateDelivery)}
          options={DELIVERY_DEFAULT_OPTIONS}
          value={repo ? values.deliveryDefault : 'none'}
        />
      </div>
      <div className="flex justify-end border-t border-ink-600 pt-4">
        <Button onClick={goReview} variant="primary">
          Review orchestration
          <Icon name="arrowRight" size={14} />
        </Button>
      </div>
    </Card>
  );
}
