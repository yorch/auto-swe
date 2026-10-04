'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import {
  type MyCredential,
  useDeleteMyCredential,
  useMyCredentials,
  useRepositories,
} from '@/hooks/useRepositories';
import { connectionLabel } from '@/lib/connectionDisplay';
import { formatDate } from '@/lib/utils';

function CredentialRow({ credential, name }: { credential: MyCredential; name: string }) {
  const remove = useDeleteMyCredential(credential.connectionId);
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <div className="truncate text-sm text-paper-100">{name}</div>
        <div className="font-mono text-[11px] text-paper-500">
          Token ending in …{credential.lastFour || '????'} · updated{' '}
          {formatDate(credential.updatedAt)}
        </div>
      </div>
      <Button onClick={() => setConfirming(true)} size="sm" variant="danger">
        Revoke
      </Button>
      <ConfirmModal
        confirmLabel="Revoke"
        dangerous
        message="Your runs against this repository go back to using the platform's GitHub access. The token itself is not revoked on GitHub; do that there if it should stop working everywhere."
        onClose={() => setConfirming(false)}
        onConfirm={async () => {
          await remove.mutateAsync();
        }}
        open={confirming}
        pendingLabel="Revoking…"
        title={`Revoke your token for ${name}?`}
      />
    </li>
  );
}

/**
 * The GitHub tokens the user saved for individual repositories, with a way to remove each.
 * Saving one stays on the Connections page, beside the repository it is for. Hidden while the
 * feature is off and nothing is saved, since there is then nothing to show or do.
 */
export function GitHubCredentialsSection({ number }: { number?: string }) {
  const mine = useMyCredentials();
  const repos = useRepositories({ includeInactive: true, limit: 500 });
  const credentials = mine.data?.credentials ?? [];
  if (mine.data && !mine.data.enabled && credentials.length === 0) {
    return null;
  }
  const nameOf = (id: string) => {
    const repo = repos.data?.find((r) => r.id === id);
    return repo ? connectionLabel(repo) : 'A repository you can no longer see';
  };
  return (
    <>
      <SectionHeader
        hint="your own token for specific repositories"
        number={number}
        title="GitHub credentials"
      />
      <Card variant="inset">
        <QueryBoundary
          compact
          error={mine.error}
          isError={mine.isError}
          isLoading={mine.isLoading}
          label="your GitHub credentials"
        >
          {credentials.length === 0 ? (
            <EmptyState
              hint="Add one from a repository on the Connections page, using My token."
              title="No saved tokens"
            />
          ) : (
            <ul className="divide-y divide-ink-600">
              {credentials.map((c) => (
                <CredentialRow credential={c} key={c.connectionId} name={nameOf(c.connectionId)} />
              ))}
            </ul>
          )}
        </QueryBoundary>
      </Card>
    </>
  );
}
