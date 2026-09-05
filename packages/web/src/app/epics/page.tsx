'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useCreateEpic, useEpics } from '@/hooks/useEpics';
import { useRepositories } from '@/hooks/useRepositories';
import { errMsg } from '@/lib/errors';
import { formatRelativeTime } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

export default function EpicsPage() {
  const router = useRouter();
  const role = useAuthStore((s) => s.user?.role ?? 'ENGINEER');
  const canCreate = role === 'ADMIN' || role === 'LEAD';
  const { data: repos = [] } = useRepositories();
  const create = useCreateEpic();
  const { data: epicsPage, isLoading: epicsLoading, error: epicsError } = useEpics();
  const epics = epicsPage?.data ?? [];

  const [open, setOpen] = useState(false);
  const [externalTicketId, setExternalTicketId] = useState('');
  const [description, setDescription] = useState('');
  const [repoIds, setRepoIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  function toggleRepo(id: string) {
    setRepoIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (repoIds.length < 2) {
      setError('Pick at least two repositories — single-repo work goes through Work Requests.');
      return;
    }
    try {
      const res = await create.mutateAsync({
        description: description.trim(),
        externalTicketId: externalTicketId.trim(),
        repoIds,
      });
      setOpen(false);
      setExternalTicketId('');
      setDescription('');
      setRepoIds([]);
      router.push(res.data.detailPath ?? `/epics/${encodeURIComponent(res.data.epicWorkflowId)}`);
    } catch (err) {
      setError(errMsg(err, 'Failed to create epic'));
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          canCreate && (
            <Button
              disabled={repos.length < 2}
              onClick={() => setOpen(true)}
              title={repos.length < 2 ? 'Connect at least two repositories first' : undefined}
              variant="primary"
            >
              + New epic
            </Button>
          )
        }
        chapter="§ Epics"
        title="Epics"
      />

      <Card>
        <p className="text-sm text-paper-400">
          Epic orchestration spans multiple repositories with dependency ordering. The Planner agent
          decomposes the brief into per-repo work requests and the Epic Orchestrator runs them as
          child workflows. Single-repo changes belong in the{' '}
          <span className="text-paper-200">Workflows</span> page instead.
        </p>
      </Card>

      <Card className="p-0 overflow-hidden">
        <Table>
          <THead className="bg-ink-800">
            <Th variant="plain">Ticket</Th>
            <Th variant="plain">Description</Th>
            <Th variant="plain">Repos</Th>
            <Th variant="plain">Status</Th>
            <Th variant="plain">Created</Th>
          </THead>
          <tbody>
            {epicsLoading && (
              <TRow>
                <Td className="px-4 py-6 text-center text-xs text-paper-500" colSpan={5}>
                  Loading…
                </Td>
              </TRow>
            )}
            {!epicsLoading && epicsError && (
              <TRow>
                <Td className="px-4 py-6 text-center text-xs text-brick-400" colSpan={5}>
                  {errMsg(epicsError, 'Failed to load epics')}
                </Td>
              </TRow>
            )}
            {!epicsLoading && !epicsError && epics.length === 0 && (
              <TRow>
                <Td className="px-4 py-6 text-center text-xs text-paper-500" colSpan={5}>
                  No epics yet. Launch one to fan work out across repositories.
                </Td>
              </TRow>
            )}
            {epics.map((epic) => (
              <TRow hover key={epic.workRequestId}>
                <Td className="px-4 py-3">
                  <Link
                    className="text-ember-400 hover:underline font-medium"
                    href={`/epics/${encodeURIComponent(epic.epicWorkflowId)}`}
                  >
                    {epic.externalTicketId}
                  </Link>
                </Td>
                <Td className="px-4 py-3 text-paper-400 truncate max-w-md">{epic.description}</Td>
                <Td className="px-4 py-3 font-mono text-xs text-paper-400">{epic.repoCount}</Td>
                <Td className="px-4 py-3">
                  <StatusBadge status={epic.status} />
                </Td>
                <Td className="px-4 py-3 text-paper-400">{formatRelativeTime(epic.createdAt)}</Td>
              </TRow>
            ))}
          </tbody>
        </Table>
      </Card>

      <Modal
        eyebrow="§ New multi-repo epic"
        onClose={() => setOpen(false)}
        open={open}
        size="lg"
        subtitle="Pick the repositories the change touches; the Planner agent will split the work."
        title="Launch an epic"
      >
        <form className="space-y-5" onSubmit={handleSubmit}>
          <Input
            autoFocus
            label="External ticket ID"
            onChange={(e) => setExternalTicketId(e.target.value)}
            placeholder="EPIC-100 / RFC-7"
            required
            value={externalTicketId}
          />
          <div className="space-y-1.5">
            <label
              className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500"
              htmlFor="epic-description"
            >
              Description
            </label>
            <textarea
              className="min-h-[120px] w-full rounded-[9px] border border-ink-500 bg-ink-900/60 px-3 py-2 text-sm text-paper-100 outline-none focus:border-ember-400"
              id="epic-description"
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Migrate all services from the legacy /v1 auth endpoint to /v2 and deprecate the legacy gateway plugin."
              required
              value={description}
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <span className="block font-mono text-[10px] uppercase tracking-[0.18em] text-paper-500">
                Repositories ({repoIds.length} selected)
              </span>
              <span className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
                pick 2 or more
              </span>
            </div>
            <div className="max-h-64 overflow-y-auto rounded-[9px] border border-ink-500">
              {repos.map((r) => {
                const checked = repoIds.includes(r.id);
                return (
                  <label
                    className={`flex cursor-pointer items-center gap-3 border-b border-ink-700/50 px-3 py-2 text-sm last:border-b-0 ${
                      checked ? 'bg-ember-400/5' : 'hover:bg-ink-700/30'
                    }`}
                    key={r.id}
                  >
                    <input checked={checked} onChange={() => toggleRepo(r.id)} type="checkbox" />
                    <span className="text-paper-100">
                      {r.organizationName}/{r.repoName}
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-paper-500">
                      {r.defaultBranch}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
          {error && (
            <p className="font-mono text-[10px] uppercase tracking-wider text-brick-400">{error}</p>
          )}
          <div className="flex items-center justify-end gap-3 border-t border-ink-600 pt-4">
            <Button onClick={() => setOpen(false)} type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={create.isPending} type="submit" variant="primary">
              {create.isPending ? 'Submitting…' : 'Launch epic'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
