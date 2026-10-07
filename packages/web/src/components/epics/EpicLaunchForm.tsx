'use client';

import { useState } from 'react';
import { LaunchCardHeader, ReviewList } from '@/components/requests/LaunchSteps';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { SearchInput } from '@/components/ui/Toolbar';
import { useCreateEpic } from '@/hooks/useEpics';
import { useHasRole } from '@/hooks/useHasRole';
import { useRepositories } from '@/hooks/useRepositories';
import { errMsg } from '@/lib/errors';

/**
 * Launches a multi-repository epic; `onLaunched` receives the epic's page path.
 * With `reviewBeforeLaunch` the form first shows a summary to confirm.
 */
export function EpicLaunchForm({
  onLaunched,
  reviewBeforeLaunch = false,
}: {
  onLaunched: (path: string) => void;
  reviewBeforeLaunch?: boolean;
}) {
  // POST /epics requires LEAD.
  const canCreate = useHasRole('LEAD');
  const { data: repos = [] } = useRepositories();
  const create = useCreateEpic();
  const [externalTicketId, setExternalTicketId] = useState('');
  const [description, setDescription] = useState('');
  const [repoIds, setRepoIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [repoFilter, setRepoFilter] = useState('');

  if (!canCreate) {
    return <Alert variant="info">Launching an epic needs a team lead or administrator.</Alert>;
  }

  function toggleRepo(id: string) {
    setRepoIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function launch() {
    try {
      const res = await create.mutateAsync({
        description: description.trim(),
        externalTicketId: externalTicketId.trim(),
        repoIds,
      });
      setReviewing(false);
      setExternalTicketId('');
      setDescription('');
      setRepoIds([]);
      onLaunched(res.data.detailPath ?? `/epics/${encodeURIComponent(res.data.epicWorkflowId)}`);
    } catch (err) {
      setError(errMsg(err, 'Failed to create epic'));
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (repoIds.length < 2) {
      setError('Pick at least two repositories — single-repository work is a workflow or agent.');
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
          description="Check the brief and the repositories, then launch the epic."
          stage="review"
          title="Review and launch"
        />
        <ReviewList
          items={[
            { label: 'Ticket', mono: true, value: externalTicketId },
            { label: 'Description', multiline: true, value: description },
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
          A planner will split this into per-repository requests and run them in dependency order.
          Nothing is merged automatically.
        </Alert>
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap justify-end gap-3 border-t border-ink-600 pt-4">
          <Button disabled={create.isPending} onClick={() => setReviewing(false)} variant="ghost">
            Back to details
          </Button>
          <Button disabled={create.isPending} onClick={() => void launch()} variant="primary">
            {create.isPending ? 'Launching…' : 'Launch epic'}
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
            description="Name the epic, describe the change, and pick the repositories it spans."
            stage="details"
            title="Epic details"
          />
        )}
        <Input
          hint="The tracker issue or RFC this epic delivers."
          label="External ticket ID"
          onChange={(e) => setExternalTicketId(e.target.value)}
          placeholder="EPIC-100 / RFC-7"
          required
          value={externalTicketId}
        />
        <Textarea
          hint="The planner splits this into per-repository work, so say what should change everywhere."
          id="epic-description"
          label="Description"
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Migrate all services from the legacy /v1 auth endpoint to /v2 and deprecate the legacy gateway plugin."
          required
          rows={5}
          value={description}
        />
        <fieldset>
          <legend className="float-left mb-2 flex w-full flex-wrap items-end justify-between gap-2">
            <span className="label-mono">Repositories</span>
            <span className="text-xs text-paper-500">
              <span className="tabular text-paper-300">{repoIds.length}</span> selected · pick 2 or
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
              {shownRepos.map((r) => {
                const checked = repoIds.includes(r.id);
                return (
                  <Checkbox
                    checked={checked}
                    className={`border-b border-ink-600 px-3 py-2.5 last:border-b-0 ${
                      checked ? 'bg-ember-400/[0.06]' : 'hover:bg-ink-700/40'
                    }`}
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
              {shownRepos.length === 0 && (
                <p className="px-3 py-4 text-center text-[13px] text-paper-500">
                  {repos.length ? 'No repositories match this filter' : 'No repositories available'}
                </p>
              )}
            </div>
          </div>
        </fieldset>
        {error && <Alert>{error}</Alert>}
        {repos.length < 2 && (
          <Alert variant="info">
            An epic spans at least two repositories, and fewer than two are available to your team.
          </Alert>
        )}
        <div className="flex justify-end border-t border-ink-600 pt-4">
          <Button disabled={create.isPending || repos.length < 2} type="submit" variant="primary">
            {create.isPending ? 'Launching…' : reviewBeforeLaunch ? 'Review epic' : 'Launch epic'}
            {!create.isPending && <Icon name="arrowRight" size={14} />}
          </Button>
        </div>
      </form>
    </Card>
  );
}
