'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
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
        <h2 className="text-lg font-semibold">Review and launch</h2>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-paper-400">Ticket</dt>
            <dd className="break-words">{externalTicketId}</dd>
          </div>
          <div>
            <dt className="text-paper-400">Description</dt>
            <dd className="whitespace-pre-wrap break-words">{description}</dd>
          </div>
          <div>
            <dt className="text-paper-400">Repositories ({chosen.length})</dt>
            <dd>
              <ul className="list-disc pl-5">
                {chosen.map((repo) => (
                  <li key={repo.id}>
                    {repo.organizationName}/{repo.repoName}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        </dl>
        <Alert variant="info">
          A planner will split this into per-repository requests and run them in dependency order.
          Nothing is merged automatically.
        </Alert>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-3">
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

  return (
    <form className="space-y-5" onSubmit={handleSubmit}>
      <Input
        label="External ticket ID"
        onChange={(e) => setExternalTicketId(e.target.value)}
        placeholder="EPIC-100 / RFC-7"
        required
        value={externalTicketId}
      />
      <Textarea
        id="epic-description"
        label="Description"
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Migrate all services from the legacy /v1 auth endpoint to /v2 and deprecate the legacy gateway plugin."
        required
        value={description}
      />
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <span className="label-mono block">Repositories ({repoIds.length} selected)</span>
          <span className="label-mono">pick 2 or more</span>
        </div>
        <div className="max-h-64 overflow-y-auto rounded-md border border-ink-500">
          {repos.map((r) => {
            const checked = repoIds.includes(r.id);
            return (
              <Checkbox
                checked={checked}
                className={`border-b border-ink-600 px-3 py-2 last:border-b-0 ${
                  checked ? 'bg-ember-400/5' : 'hover:bg-ink-700/30'
                }`}
                key={r.id}
                label={
                  <>
                    <span className="text-paper-100">
                      {r.organizationName}/{r.repoName}
                    </span>
                    <span className="ml-2 font-mono text-[10px] text-paper-500">
                      {r.defaultBranch}
                    </span>
                  </>
                }
                onChange={() => toggleRepo(r.id)}
              />
            );
          })}
        </div>
      </div>
      {error && <Alert>{error}</Alert>}
      {repos.length < 2 && (
        <Alert variant="info">
          An epic spans at least two repositories, and fewer than two are available to your team.
        </Alert>
      )}
      <Button disabled={create.isPending || repos.length < 2} type="submit" variant="primary">
        {create.isPending ? 'Launching…' : reviewBeforeLaunch ? 'Review epic' : 'Launch epic'}
      </Button>
    </form>
  );
}
