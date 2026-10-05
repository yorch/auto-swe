'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import type { GitHubRepoInfo } from '@/hooks/useRepositories';
import { useGitHubAvailableRepos } from '@/hooks/useRepositories';
import { errMsg } from '@/lib/errors';

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
      eyebrow="§ Import"
      onClose={onClose}
      open={open}
      size="lg"
      subtitle="Select a GitHub repository. Metadata will be pre-filled — you can review before saving."
      title="Import from GitHub"
    >
      <div className="space-y-4">
        <Input
          aria-label="Search GitHub repositories"
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by org, repo name, or description…"
          value={search}
        />

        {isLoading && <LoadingState message="Fetching repositories…" />}

        {error && !isLoading && (
          <Alert>
            {errMsg(error, 'Failed to load repositories.')}{' '}
            <Link className="underline" href="/studio/integrations?tab=github">
              Check GitHub integration.
            </Link>
          </Alert>
        )}

        {!isLoading && !error && (
          <div className="max-h-[360px] overflow-y-auto -mx-1 px-1 space-y-0.5">
            {filtered.length === 0 && (
              <EmptyState
                className="py-10"
                title={search ? 'No matching repositories.' : 'No repositories found.'}
              />
            )}
            {filtered.map((r) => (
              <button
                className="w-full text-left px-3 py-2.5 rounded-md border border-transparent hover:border-ink-400 hover:bg-ink-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={r.alreadyImported}
                key={`${r.org}/${r.name}`}
                onClick={() => onSelect(r)}
                type="button"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-sm text-paper-100 truncate">
                    {r.org}/<span className="font-semibold">{r.name}</span>
                  </span>
                  <div className="flex items-center gap-2 shrink-0">
                    {r.language && (
                      <Badge tone="muted" uppercase>
                        {r.language}
                      </Badge>
                    )}
                    {r.alreadyImported && (
                      <Badge tone="moss" uppercase>
                        Imported
                      </Badge>
                    )}
                  </div>
                </div>
                {r.description && (
                  <p className="text-xs text-paper-400 mt-0.5 truncate">{r.description}</p>
                )}
              </button>
            ))}
          </div>
        )}

        <ModalFooter cancelLabel="Close" onCancel={onClose} />
      </div>
    </Modal>
  );
}
