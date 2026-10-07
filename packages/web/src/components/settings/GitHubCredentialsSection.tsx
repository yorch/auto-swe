'use client';

import { useState } from 'react';
import { Button, ButtonLink } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import {
  type MyCredential,
  useDeleteMyCredential,
  useMyCredentials,
  useRepositories,
} from '@/hooks/useRepositories';
import { connectionLabel } from '@/lib/connectionDisplay';
import { formatDate, formatRelativeTime } from '@/lib/utils';
import { SettingsListRow, SettingsSection } from './SettingsSection';

function CredentialRow({ credential, name }: { credential: MyCredential; name: string }) {
  const remove = useDeleteMyCredential(credential.connectionId);
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <SettingsListRow
        action={
          <Button onClick={() => setConfirming(true)} size="sm" variant="danger">
            Revoke
          </Button>
        }
        detail={
          <>
            Token ending in …{credential.lastFour || '????'} · updated{' '}
            <span title={formatDate(credential.updatedAt)}>
              {formatRelativeTime(credential.updatedAt)}
            </span>
          </>
        }
        leading={<Icon name="github" size={16} />}
        title={<span className="break-all">{name}</span>}
      />
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
    </>
  );
}

/**
 * The GitHub tokens the user saved for individual repositories, with a way to remove each.
 * Saving one stays on the Connections page, beside the repository it is for. Hidden while the
 * feature is off and nothing is saved, since there is then nothing to show or do.
 */
export function GitHubCredentialsSection() {
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
    <SettingsSection
      actions={
        <ButtonLink href="/connections" size="sm">
          Open Connections
        </ButtonLink>
      }
      description="Your own GitHub token for specific repositories. Runs you launch there act as you."
      icon="github"
      id="github-credentials"
      title="GitHub credentials"
    >
      <QueryBoundary
        compact
        error={mine.error}
        isError={mine.isError}
        isFetching={mine.isFetching}
        isLoading={mine.isLoading}
        label="your GitHub credentials"
        loading={<SkeletonRows rows={2} />}
        onRetry={() => void mine.refetch()}
      >
        {credentials.length === 0 ? (
          <EmptyState
            action={
              <ButtonLink href="/connections" size="sm">
                Go to Connections
              </ButtonLink>
            }
            hint="Add one from a repository on the Connections page, using My token."
            icon="github"
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
    </SettingsSection>
  );
}
