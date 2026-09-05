'use client';

import type { BudgetTier } from '@auto-swe/shared/types/api';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { useRepositories } from '@/hooks/useRepositories';
import { useCreateWorkRequest } from '@/hooks/useRuns';
import { errMsg } from '@/lib/errors';

const BUDGET_TIERS: { value: BudgetTier; label: string; hint: string }[] = [
  { hint: '2M / 500K tokens', label: 'Standard', value: 'STANDARD' },
  { hint: '8M / 2M tokens', label: 'Large', value: 'LARGE' },
  { hint: '20M / 5M tokens', label: 'Epic', value: 'EPIC' },
];

export function SubmitWorkRequestModal({
  open,
  onClose,
  defaultRepoId,
}: {
  open: boolean;
  onClose: () => void;
  defaultRepoId?: string;
}) {
  const router = useRouter();
  const { data: allRepos = [] } = useRepositories();
  const repos = useMemo(() => allRepos.filter((r) => !r.type || r.type === 'git_repo'), [allRepos]);
  const mutation = useCreateWorkRequest();

  const [externalTicketId, setExternalTicketId] = useState('');
  const [description, setDescription] = useState('');
  const [repoId, setRepoId] = useState('');
  const [budgetTier, setBudgetTier] = useState<BudgetTier>('STANDARD');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    // Seed only when nothing is selected — never clobber a user's choice.
    setRepoId((cur) => cur || defaultRepoId || repos[0]?.id || '');
  }, [open, defaultRepoId, repos]);

  function reset() {
    setExternalTicketId('');
    setDescription('');
    setRepoId('');
    setBudgetTier('STANDARD');
    setError(null);
    mutation.reset();
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!repoId) {
      setError('Pick a repository');
      return;
    }
    try {
      const res = await mutation.mutateAsync({
        budgetTier,
        description: description.trim(),
        externalTicketId: externalTicketId.trim(),
        repoIds: [repoId],
      });
      const newId = res.data.workflowIds[0];
      reset();
      onClose();
      if (newId) {
        router.push(`/workflows/${newId}`);
      }
    } catch (err) {
      setError(errMsg(err, 'Failed to submit work request'));
    }
  }

  return (
    <Modal
      eyebrow="§ New work request"
      onClose={handleClose}
      open={open}
      subtitle="The Implementer agent will clone the repo, write code + tests in a Docker workspace, run the review network, and open a pull request for human merge."
      title="Send the agent a ticket."
    >
      <form className="space-y-6" onSubmit={handleSubmit}>
        <Input
          autoFocus
          label="External ticket ID"
          name="ticket-id"
          onChange={(e) => setExternalTicketId(e.target.value)}
          placeholder="JIRA-1234 / LIN-42 / GH-99"
          required
          value={externalTicketId}
        />

        <div className="space-y-1.5">
          <label
            className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500"
            htmlFor="description"
          >
            Description
          </label>
          <textarea
            className="min-h-[100px] w-full rounded-sm border border-ink-500 bg-ink-900/60 px-3 py-2 text-sm text-paper-100 outline-none transition-colors placeholder:text-paper-600 focus:border-ember-400 focus:bg-ink-900/80"
            id="description"
            name="description"
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add a GET /health endpoint that returns { status: 'ok' } with no auth required."
            required
            value={description}
          />
          <p className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
            Be specific — the agent treats this as the brief.
          </p>
        </div>

        <div className="space-y-1.5">
          <label
            className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500"
            htmlFor="repo"
          >
            Repository
          </label>
          {repos.length === 0 ? (
            <p className="text-xs text-brick-400">
              No repositories connected. Ask an admin or lead to add one before submitting work.
            </p>
          ) : (
            <Select
              id="repo"
              name="repo"
              onChange={(e) => setRepoId(e.target.value)}
              required
              value={repoId}
            >
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.organizationName}/{r.repoName} · {r.defaultBranch}
                </option>
              ))}
            </Select>
          )}
        </div>

        <fieldset className="space-y-2">
          <legend className="font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
            Budget tier
          </legend>
          <div className="grid grid-cols-3 gap-2">
            {BUDGET_TIERS.map((tier) => {
              const selected = budgetTier === tier.value;
              return (
                <label
                  className={`cursor-pointer rounded-sm border px-3 py-2 transition-colors ${
                    selected
                      ? 'border-ember-400 bg-ember-400/10'
                      : 'border-ink-500 hover:border-ink-400'
                  }`}
                  key={tier.value}
                >
                  <input
                    checked={selected}
                    className="sr-only"
                    name="budget-tier"
                    onChange={() => setBudgetTier(tier.value)}
                    type="radio"
                    value={tier.value}
                  />
                  <div
                    className={`font-mono text-[10px] uppercase tracking-[0.18em] ${
                      selected ? 'text-ember-400' : 'text-paper-500'
                    }`}
                  >
                    {tier.label}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-paper-500">{tier.hint}</div>
                </label>
              );
            })}
          </div>
        </fieldset>

        {error && (
          <p className="font-mono text-[10px] uppercase tracking-wider text-brick-400">{error}</p>
        )}

        <div className="flex items-center justify-end gap-3 border-t border-ink-600 pt-4">
          <Button onClick={handleClose} type="button" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={mutation.isPending || repos.length === 0}
            type="submit"
            variant="primary"
          >
            {mutation.isPending ? 'Submitting…' : 'Submit'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
