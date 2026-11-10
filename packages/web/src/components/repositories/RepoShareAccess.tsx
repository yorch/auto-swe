'use client';

import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useSetRepoShareLaunch, useSetRepoShares } from '@/hooks/useRepositories';
import { errMsg } from '@/lib/errors';

type ShareRepo = Pick<RepositorySummary, 'id' | 'shares'>;

/**
 * The teams a repository is shared with, each with a "Can launch work" switch and a Revoke action.
 * For the owning team's leads and platform admins only: the caller mounts it only for them, and
 * the gateway enforces the same rule. A team that cannot launch still sees the repository.
 */
export function RepoShareAccess({
  onRevoked,
  repo,
}: {
  /** Called with the team's id once its access is gone. */
  onRevoked?: (teamId: string) => void;
  repo: ShareRepo;
}) {
  const setLaunch = useSetRepoShareLaunch(repo.id);
  const setShares = useSetRepoShares(repo.id);
  // What the owner has just done, so the list is right before the refetch lands.
  const [launchOverride, setLaunchOverride] = useState<Record<string, boolean>>({});
  const [revoked, setRevoked] = useState<Set<string>>(new Set());
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const shares = (repo.shares ?? []).filter((s) => !revoked.has(s.team.id));
  if (shares.length === 0) {
    return null;
  }
  const revokeTarget = shares.find((s) => s.team.id === revoking);

  async function toggle(teamId: string, next: boolean) {
    setError(null);
    try {
      await setLaunch.mutateAsync({ canLaunch: next, teamId });
      setLaunchOverride((cur) => ({ ...cur, [teamId]: next }));
    } catch (e) {
      setError(errMsg(e, 'Could not update the team’s access.'));
    }
  }

  async function revoke(teamId: string) {
    setError(null);
    await setShares.mutateAsync(shares.filter((s) => s.team.id !== teamId).map((s) => s.team.id));
    setRevoked((cur) => new Set(cur).add(teamId));
    onRevoked?.(teamId);
  }

  return (
    <div data-testid="repo-share-access">
      {error && <Alert className="mb-2">{error}</Alert>}
      <ul className="divide-y divide-ink-600">
        {shares.map((share) => {
          const canLaunch = launchOverride[share.team.id] ?? share.canLaunch !== false;
          return (
            <li
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5"
              key={share.team.id}
            >
              <span className="text-sm text-paper-100">{share.team.name}</span>
              <span className="flex items-center gap-3">
                <ToggleSwitch
                  ariaLabel={`Can launch work: ${share.team.name}`}
                  checked={canLaunch}
                  disabled={setLaunch.isPending}
                  label={<span className="text-xs text-paper-300">Can launch work</span>}
                  onChange={() => void toggle(share.team.id, !canLaunch)}
                  title={canLaunch ? 'Make view only' : 'Allow launching'}
                />
                <Button
                  aria-label={`Revoke access for ${share.team.name}`}
                  onClick={() => setRevoking(share.team.id)}
                  size="sm"
                  variant="ghost"
                >
                  Revoke
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
      {revokeTarget && (
        <ConfirmModal
          confirmLabel="Revoke"
          dangerous
          message={`Members of ${revokeTarget.team.name} can no longer see this repository or start runs on it. Runs already started keep going.`}
          onClose={() => setRevoking(null)}
          onConfirm={() => revoke(revokeTarget.team.id)}
          open
          title={`Revoke access for ${revokeTarget.team.name}?`}
        />
      )}
    </div>
  );
}
