'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { SearchInput } from '@/components/ui/Toolbar';
import { useHasRole } from '@/hooks/useHasRole';
import {
  type GitHubImportResult,
  type GitHubRepoInfo,
  useGitHubAvailableRepos,
  useImportGitHubRepos,
} from '@/hooks/useRepositories';
import { useRepositoryTeams } from '@/hooks/useRepositoryTeams';
import { errMsg } from '@/lib/errors';

const repoKey = (r: GitHubRepoInfo) => JSON.stringify([r.githubUrl, r.org, r.name]);

export function ImportFromGitHubModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [teamId, setTeamId] = useState('');
  const [results, setResults] = useState<(GitHubImportResult & { key: string })[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const isAdmin = useHasRole('ADMIN');
  const teams = useRepositoryTeams();
  const targetTeam = teamId || (teams.length === 1 ? teams[0].id : '');
  const { data, isLoading, error } = useGitHubAvailableRepos(open);
  const mutation = useImportGitHubRepos();
  const repos = data?.data ?? [];
  const picked = repos.filter((r) => selected.has(repoKey(r)) && !r.alreadyImported);
  const filtered = repos.filter((r) => {
    const term = search.toLowerCase();
    return [r.org, r.name, r.description, r.installationAccount, r.githubUrl].some((v) =>
      v?.toLowerCase().includes(term)
    );
  });

  async function importSelected() {
    setImportError(null);
    try {
      const response = await mutation.mutateAsync({
        repos: picked.map((r) => ({
          defaultBranch: r.defaultBranch,
          installationId: r.installationId,
          organizationName: r.org,
          repoName: r.name,
        })),
        teamId: targetTeam,
      });
      setResults(response.map((result, index) => ({ ...result, key: repoKey(picked[index]) })));
    } catch (err) {
      setImportError(errMsg(err, 'Import could not be completed.'));
    }
  }

  return (
    <Modal
      dismissible={!mutation.isPending}
      onClose={onClose}
      open={open}
      size="lg"
      subtitle="Select up to 50 repositories to import into one team. Access is checked again when importing."
      title="Import from GitHub"
    >
      <div className="space-y-4">
        {results ? (
          <div aria-live="polite">
            <h3 className="mb-3 font-medium">Import results</h3>
            <ul className="space-y-2">
              {results.map((r) => (
                <li className="text-sm" key={r.key}>
                  <span className="font-medium">
                    {r.organizationName}/{r.repoName}
                  </span>{' '}
                  <Badge tone={r.status === 'created' ? 'success' : 'danger'}>
                    {r.status === 'created' ? 'Created' : 'Failed'}
                  </Badge>
                  {r.message && <p className="text-paper-400">{r.message}</p>}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            <Select
              disabled={mutation.isPending}
              label="Import into team"
              onChange={setTeamId}
              options={teams.map((t) => ({ label: t.name, value: t.id }))}
              placeholder="Select a team"
              value={targetTeam}
            />
            <SearchInput
              className="sm:w-full"
              label="Search GitHub repositories"
              onChange={setSearch}
              placeholder="Search by org, repo name, or description…"
              value={search}
            />
            <p className="text-xs text-paper-500">
              {filtered.length} repositories · {picked.length} selected (maximum 50)
            </p>
            {data?.sources
              .filter((s) => s.error)
              .map((s) => (
                <p className="text-xs text-paper-400" key={s.installationId ?? 'default'}>
                  {s.installationAccount ?? 'Default source'} ({s.githubUrl}): {s.error}
                </p>
              ))}
            {isLoading && <SkeletonRows label="repositories" rows={5} />}
            {error && !isLoading && (
              <Alert
                action={
                  isAdmin ? (
                    <ButtonLink href="/admin/integrations?tab=github" size="sm">
                      Check GitHub
                    </ButtonLink>
                  ) : undefined
                }
                title="Could not load repositories"
              >
                {errMsg(error, 'Failed to load repositories.')}
              </Alert>
            )}
            {!isLoading && !error && (
              <div className="max-h-[360px] overflow-y-auto rounded-lg border border-ink-500/70">
                {filtered.length === 0 && (
                  <EmptyState
                    className="py-10"
                    hint="Try another search or ask an administrator to check the GitHub sources."
                    icon="github"
                    title="No repositories found"
                  />
                )}
                <ul className="divide-y divide-ink-600">
                  {filtered.map((r) => {
                    const key = repoKey(r);
                    return (
                      <li key={key}>
                        <label className="flex items-center gap-3 px-3.5 py-2.5 text-sm">
                          <input
                            aria-label={`Select ${r.org}/${r.name}`}
                            checked={selected.has(key)}
                            disabled={
                              r.alreadyImported ||
                              mutation.isPending ||
                              (!selected.has(key) && picked.length >= 50)
                            }
                            onChange={(e) =>
                              setSelected((previous) => {
                                const next = new Set(previous);
                                if (e.target.checked) {
                                  next.add(key);
                                } else {
                                  next.delete(key);
                                }
                                return next;
                              })
                            }
                            type="checkbox"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block font-medium">
                              {r.org}/{r.name}
                            </span>
                            <span className="block text-xs text-paper-500">
                              {r.installationAccount ?? 'Default credential'}
                              {r.githubUrl && ` · ${r.githubUrl}`}
                            </span>
                            {r.description && (
                              <span className="block truncate text-xs text-paper-400">
                                {r.description}
                              </span>
                            )}
                          </span>
                          {r.alreadyImported ? (
                            <Badge tone="neutral">Imported</Badge>
                          ) : r.access === 'unchecked' ? (
                            <Badge tone="warning">Access unchecked</Badge>
                          ) : null}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {importError && <Alert title="Import failed">{importError}</Alert>}
          </>
        )}
      </div>
      <ModalFooter
        cancelLabel={results ? 'Done' : 'Cancel'}
        disabled={!targetTeam || picked.length === 0}
        isPending={mutation.isPending}
        onCancel={onClose}
        onSubmit={importSelected}
        pendingLabel="Importing…"
        submitLabel={results ? undefined : `Import ${picked.length || ''} repositories`}
      />
    </Modal>
  );
}
