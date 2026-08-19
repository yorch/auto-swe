'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal } from '@/components/ui/Modal';
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
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by org, repo name, or description…"
          value={search}
        />

        {isLoading && <LoadingState message="Fetching repositories…" />}

        {error && !isLoading && (
          <p className="text-sm text-brick-400">
            {errMsg(error, 'Failed to load repositories.')}{' '}
            <a className="underline" href="/admin/integrations">
              Check GitHub integration.
            </a>
          </p>
        )}

        {!isLoading && !error && (
          <div className="max-h-[360px] overflow-y-auto -mx-1 px-1 space-y-0.5">
            {filtered.length === 0 && (
              <p className="text-sm text-paper-400 py-10 text-center">
                {search ? 'No matching repositories.' : 'No repositories found.'}
              </p>
            )}
            {filtered.map((r) => (
              <button
                className="w-full text-left px-3 py-2.5 rounded-[9px] border border-transparent hover:border-ink-400 hover:bg-ink-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
                      <span className="text-[10px] font-mono uppercase tracking-wider text-paper-500 bg-ink-700 px-1.5 py-0.5 rounded">
                        {r.language}
                      </span>
                    )}
                    {r.alreadyImported && (
                      <span className="text-[10px] font-mono uppercase tracking-wider text-moss-400 bg-moss-900/30 px-1.5 py-0.5 rounded">
                        Imported
                      </span>
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

        <div className="flex justify-end border-t border-ink-600 pt-4">
          <Button onClick={onClose} type="button" variant="ghost">
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
