'use client';

import { useState } from 'react';
import { LaunchCardHeader, ReviewList } from '@/components/requests/LaunchSteps';
import { epicAllowsTeam, useStartScope } from '@/components/requests/StartScope';
import { Alert } from '@/components/ui/Alert';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { SearchInput } from '@/components/ui/Toolbar';
import { useHasRole } from '@/hooks/useHasRole';
import { type CreatePrdRunResponse, useCreatePrdRun } from '@/hooks/usePrdRuns';
import { useRepositories } from '@/hooks/useRepositories';
import { useRunsForWorkRequest } from '@/hooks/useRuns';
import { useIsViewOnly } from '@/hooks/useViewOnlyRepos';
import { ApiError } from '@/lib/api';
import { errMsg } from '@/lib/errors';
import { groupReposByTeam } from '@/lib/repoGroups';
import { launchBudgetHint, launchBudgetReason } from '@/lib/repoLaunch';
import { requestHref } from '@/lib/requestDisplay';

/** The gateway's reason for a repository whose owning team the caller does not lead. */
const TEAM_LEAD_REQUIRED = 'team-lead-required';

/** Where a started PRD run can be followed: its run once the workflow has recorded one. */
function StartedPrdRun({ started }: { started: CreatePrdRunResponse }) {
  const runs = useRunsForWorkRequest(started.workRequestId, 1);
  const runId = runs.data?.[0]?.id;
  return (
    <Card className="space-y-4">
      <Alert variant="success">
        PRD run started. The agent is analysing the PRD; you will be asked to review the analysis
        and then the breakdown before any tickets or work requests are created.
      </Alert>
      <div className="flex flex-wrap gap-3">
        {runId ? (
          <ButtonLink href={`/runs/${encodeURIComponent(runId)}`} variant="primary">
            Open the run
            <Icon name="arrowRight" size={14} />
          </ButtonLink>
        ) : (
          <ButtonLink href={requestHref(started.workRequestId)} variant="primary">
            Open the request
            <Icon name="arrowRight" size={14} />
          </ButtonLink>
        )}
      </div>
      {!runId && (
        <p className="text-xs text-paper-500">
          The run page link appears here as soon as the workflow has registered its run.
        </p>
      )}
    </Card>
  );
}

/**
 * Starts a PRD run: the PRD text, a title, an optional tracker project key and the repositories
 * it spans. POST /prd-runs needs a platform LEAD and, on top of that, team LEAD on the team that
 * owns every named repository, so the choices are limited to repositories of teams the caller
 * leads and a 403 from the gateway names the repositories it refused.
 */
export function PrdRunLaunchForm({ reviewBeforeLaunch = false }: { reviewBeforeLaunch?: boolean }) {
  const canCreate = useHasRole('LEAD');
  const { data: allRepos = [] } = useRepositories();
  // The same limit as an epic: only repositories whose owning team the caller leads.
  const scope = useStartScope();
  const isViewOnly = useIsViewOnly();
  const allowed = (r: (typeof allRepos)[number]) => !r.team || epicAllowsTeam(scope, r.team.id);
  const repos = allRepos.filter((r) => allowed(r) && !isViewOnly(r));
  const viewOnlyCount = allRepos.filter((r) => allowed(r) && isViewOnly(r)).length;
  const hiddenRepoCount = allRepos.length - repos.length - viewOnlyCount;
  const create = useCreatePrdRun();
  const [prdTitle, setPrdTitle] = useState('');
  const [prdContent, setPrdContent] = useState('');
  const [projectKey, setProjectKey] = useState('');
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const overBudgetIds = new Set(allRepos.filter((r) => launchBudgetReason(r)).map((r) => r.id));
  const repoIds = pickedIds.filter((id) => !overBudgetIds.has(id));
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<string[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [repoFilter, setRepoFilter] = useState('');
  const [started, setStarted] = useState<CreatePrdRunResponse | null>(null);

  if (!canCreate) {
    return <Alert variant="info">Starting a PRD run needs a team lead or administrator.</Alert>;
  }
  if (started) {
    return <StartedPrdRun started={started} />;
  }

  function toggleRepo(id: string) {
    setPickedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function launch() {
    setError(null);
    setRefused([]);
    try {
      const key = projectKey.trim();
      const res = await create.mutateAsync({
        prdContent: prdContent.trim(),
        prdTitle: prdTitle.trim(),
        ...(key ? { projectKey: key } : {}),
        repoIds,
      });
      setReviewing(false);
      setStarted(res);
    } catch (err) {
      setReviewing(false);
      if (err instanceof ApiError && err.status === 403) {
        setRefused(err.reasons.filter((r) => r.reason === TEAM_LEAD_REQUIRED).map((r) => r.repo));
      }
      setError(errMsg(err, 'Failed to start the PRD run'));
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setRefused([]);
    if (!prdTitle.trim() || !prdContent.trim()) {
      setError('A PRD run needs a title and the PRD text.');
      return;
    }
    if (repoIds.length < 1) {
      setError('Pick at least one repository.');
      return;
    }
    if (reviewBeforeLaunch && !reviewing) {
      setReviewing(true);
      return;
    }
    void launch();
  }

  if (reviewBeforeLaunch && reviewing) {
    const chosen = repos.filter((repo) => repoIds.includes(repo.id));
    return (
      <Card className="space-y-5">
        <LaunchCardHeader
          description="Check the PRD and the repositories, then start the run."
          stage="review"
          title="Review and start"
        />
        <ReviewList
          items={[
            { label: 'Title', value: prdTitle.trim() },
            ...(projectKey.trim()
              ? [{ label: 'Tracker project', mono: true, value: projectKey.trim() }]
              : []),
            { label: 'PRD', multiline: true, value: prdContent.trim() },
            {
              label: `Repositories (${chosen.length})`,
              value: (
                <ul className="space-y-0.5">
                  {chosen.map((repo) => (
                    <li key={repo.id}>
                      {repo.organizationName}/{repo.repoName}
                    </li>
                  ))}
                </ul>
              ),
            },
          ]}
        />
        <Alert variant="info">
          The agent analyses the PRD, then you review the analysis and the epic and story breakdown
          before tickets or work requests are created. No built-in step or template merges a pull
          request.
        </Alert>
        <div className="flex flex-wrap justify-end gap-3 border-t border-ink-600 pt-4">
          <Button disabled={create.isPending} onClick={() => setReviewing(false)} variant="ghost">
            Back to details
          </Button>
          <Button disabled={create.isPending} onClick={() => void launch()} variant="primary">
            {create.isPending ? 'Starting…' : 'Start PRD run'}
          </Button>
        </div>
      </Card>
    );
  }

  const term = repoFilter.trim().toLowerCase();
  const shownRepos = term
    ? repos.filter((r) => `${r.organizationName}/${r.repoName}`.toLowerCase().includes(term))
    : repos;

  return (
    <Card>
      <form className="space-y-5" onSubmit={handleSubmit}>
        {reviewBeforeLaunch && (
          <LaunchCardHeader
            description="Paste the PRD, name it, and pick the repositories its stories land in."
            stage="details"
            title="PRD details"
          />
        )}
        <Input
          hint="A short name for the PRD; it also labels the run."
          label="PRD title"
          onChange={(e) => setPrdTitle(e.target.value)}
          placeholder="Self-serve team invitations"
          required
          value={prdTitle}
        />
        <Textarea
          hint="The full text of the document, copied from Confluence, Google Docs or similar."
          id="prd-content"
          label="PRD text"
          onChange={(e) => setPrdContent(e.target.value)}
          placeholder="Paste the product requirements document here."
          required
          rows={10}
          value={prdContent}
        />
        <Input
          hint="Optional. The Jira project key, Linear team id or GitHub owner/repo where tickets are created. Leave blank if no tracker is configured."
          label="Tracker project"
          onChange={(e) => setProjectKey(e.target.value)}
          placeholder="PAY / acme/backlog"
          value={projectKey}
        />
        <fieldset>
          <legend className="float-left mb-2 flex w-full flex-wrap items-end justify-between gap-2">
            <span className="label-mono">Repositories</span>
            <span className="text-xs text-paper-500">
              <span className="tabular text-paper-300">{repoIds.length}</span> selected · pick 1 or
              more
            </span>
          </legend>
          <div className="clear-both space-y-2">
            {repos.length > 8 && (
              <SearchInput
                className="sm:w-full"
                label="Filter repositories"
                onChange={setRepoFilter}
                placeholder="Filter repositories…"
                value={repoFilter}
              />
            )}
            <div className="max-h-72 overflow-y-auto rounded-lg border border-ink-500/70 bg-ink-900/40">
              {groupReposByTeam(shownRepos, scope?.team ?? null).map((group) => (
                <div key={group.key}>
                  {group.label && (
                    <div className="border-b border-ink-600 bg-ink-800/60 px-3 py-1.5 text-xs font-medium text-paper-400">
                      {group.label}
                    </div>
                  )}
                  {group.repos.map((r) => {
                    const budgetReason = launchBudgetReason(r);
                    const budgetHint = budgetReason ? null : launchBudgetHint(r);
                    const checked = repoIds.includes(r.id);
                    return (
                      <Checkbox
                        checked={checked}
                        className={`border-b border-ink-600 px-3 py-2.5 last:border-b-0 ${
                          checked ? 'bg-accent-400/[0.06]' : 'hover:bg-ink-700/40'
                        }`}
                        disabled={Boolean(budgetReason)}
                        hint={
                          budgetReason ? (
                            <span data-testid="prd-budget-reason">{budgetReason}</span>
                          ) : budgetHint ? (
                            <span
                              className={budgetHint.warn ? 'text-warning-400' : undefined}
                              data-testid="prd-budget-hint"
                            >
                              {budgetHint.text}
                            </span>
                          ) : undefined
                        }
                        key={r.id}
                        label={
                          <>
                            <span className="text-paper-100">
                              {r.organizationName}/{r.repoName}
                            </span>
                            <span className="ml-2 font-mono text-xs text-paper-500">
                              {r.defaultBranch}
                            </span>
                          </>
                        }
                        onChange={() => toggleRepo(r.id)}
                      />
                    );
                  })}
                </div>
              ))}
              {shownRepos.length === 0 && (
                <p className="px-3 py-4 text-center text-sm text-paper-500">
                  {repos.length ? 'No repositories match this filter' : 'No repositories available'}
                </p>
              )}
            </div>
          </div>
        </fieldset>
        {error && (
          <Alert>
            {error}
            {refused.length > 0 && (
              <ul className="mt-2 list-disc pl-5" data-testid="prd-refused-repos">
                {refused.map((repo) => (
                  <li key={repo}>{repo}: you are not a lead of the team that owns it</li>
                ))}
              </ul>
            )}
          </Alert>
        )}
        <p className="text-xs text-paper-500">
          Each repository's work runs under the team that owns it.
        </p>
        {hiddenRepoCount > 0 && (
          <p className="text-xs text-paper-500" data-testid="prd-hidden-repos">
            {hiddenRepoCount} {hiddenRepoCount === 1 ? 'repository is' : 'repositories are'} not
            listed: a PRD run may name only repositories owned by a team you lead.
          </p>
        )}
        {viewOnlyCount > 0 && (
          <p className="text-xs text-paper-500" data-testid="prd-view-only-repos">
            {viewOnlyCount} {viewOnlyCount === 1 ? 'repository is' : 'repositories are'} not listed:
            the owner team set {viewOnlyCount === 1 ? 'it' : 'them'} to view only for your team.
          </p>
        )}
        {repos.length < 1 && (
          <Alert variant="info">No repository is available for a PRD run to your team.</Alert>
        )}
        <div className="flex justify-end border-t border-ink-600 pt-4">
          <Button disabled={create.isPending || repos.length < 1} type="submit" variant="primary">
            {create.isPending
              ? 'Starting…'
              : reviewBeforeLaunch
                ? 'Review PRD run'
                : 'Start PRD run'}
            {!create.isPending && <Icon name="arrowRight" size={14} />}
          </Button>
        </div>
      </form>
    </Card>
  );
}
