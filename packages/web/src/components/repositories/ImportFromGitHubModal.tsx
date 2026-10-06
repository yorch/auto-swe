'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { SearchInput } from '@/components/ui/Toolbar';
import type { GitHubRepoInfo } from '@/hooks/useRepositories';
import { useGitHubAvailableRepos } from '@/hooks/useRepositories';
import { errMsg } from '@/lib/errors';
import { cn, FOCUS_RING } from '@/lib/utils';

export function ImportFromGitHubModal({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (repo: GitHubRepoInfo) => void;
}) {
  const [search, setSearch] = useState('');
  const { data: repos, isLoading, error } = useGitHubAvailableRepos(open);

  const filtered = (repos ?? []).filter((r) => {
    const term = search.toLowerCase();
    return (
      r.org.toLowerCase().includes(term) ||
      r.name.toLowerCase().includes(term) ||
      (r.description?.toLowerCase().includes(term) ?? false)
    );
  });

  return (
    <Modal
      eyebrow="Connections"
      onClose={onClose}
      open={open}
      size="lg"
      subtitle="Pick a repository. Its details are filled in for you to review before saving."
      title="Import from GitHub"
    >
      <div className="space-y-4">
        <SearchInput
          className="sm:w-full"
          label="Search GitHub repositories"
          onChange={setSearch}
          placeholder="Search by org, repo name, or description…"
          value={search}
        />

        {isLoading && <SkeletonRows rows={5} />}

        {error && !isLoading && (
          <Alert
            action={
              <ButtonLink href="/studio/integrations?tab=github" size="sm">
                Check GitHub
              </ButtonLink>
            }
            title="Could not load repositories"
          >
            {errMsg(error, 'Failed to load repositories.')}
          </Alert>
        )}

        {!isLoading && !error && (
          <div className="max-h-[360px] overflow-y-auto rounded-lg border border-ink-500/70 bg-ink-900/40">
            {filtered.length === 0 && (
              <EmptyState
                className="py-10"
                hint={
                  search
                    ? 'Try another name or organization.'
                    : 'The GitHub credential cannot see any repositories yet.'
                }
                icon={search ? 'search' : 'github'}
                title={search ? 'No matching repositories' : 'No repositories found'}
              />
            )}
            <ul className="divide-y divide-ink-600">
              {filtered.map((r) => (
                <li key={`${r.org}/${r.name}`}>
                  <button
                    className={cn(
                      'group flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-ink-700/60 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
                      FOCUS_RING
                    )}
                    disabled={r.alreadyImported}
                    onClick={() => onSelect(r)}
                    type="button"
                  >
                    <Icon className="text-paper-500" name="github" size={16} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-paper-300">
                        {r.org}/<span className="font-medium text-paper-100">{r.name}</span>
                      </span>
                      {r.description && (
                        <span className="mt-0.5 block truncate text-xs text-paper-500">
                          {r.description}
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {r.language && <Badge tone="muted">{r.language}</Badge>}
                      {r.alreadyImported ? (
                        <Badge dot tone="moss">
                          Imported
                        </Badge>
                      ) : (
                        <Icon
                          className="text-paper-600 transition-colors group-hover:text-paper-300"
                          name="chevronRight"
                          size={16}
                        />
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <ModalFooter cancelLabel="Close" onCancel={onClose} />
      </div>
    </Modal>
  );
}
