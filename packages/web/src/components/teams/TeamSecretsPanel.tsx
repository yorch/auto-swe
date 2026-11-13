'use client';

import { MIN_REPO_SETUP_SECRET_CHARS, TeamSecretNameSchema } from '@auto-swe/shared/lib/repoSetup';
import type { RepoRef, TeamSecretSummary } from '@auto-swe/shared/types/api';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import {
  useDeleteTeamSecret,
  useSaveTeamSecret,
  useSetTeamSecretGrants,
  useTeamSecrets,
} from '@/hooks/useTeamSecrets';
import { errMsg } from '@/lib/errors';

/**
 * A team's secrets and the owned repositories each is granted to. Write-only: a value is sent
 * once and never shown again. The panel is offered only to team ADMINs and platform ADMINs.
 */
export function TeamSecretsPanel({
  repositories,
  teamId,
}: {
  /** The repositories the team owns: the only ones a secret can be granted to. */
  repositories: Pick<RepoRef, 'id' | 'organizationName' | 'repoName'>[];
  teamId: string;
}) {
  const secrets = useTeamSecrets(teamId);
  const save = useSaveTeamSecret(teamId);
  const remove = useDeleteTeamSecret(teamId);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [openGrants, setOpenGrants] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const nameCheck = TeamSecretNameSchema.safeParse(name.trim());
  const list = secrets.data ?? [];

  return (
    <Card>
      <CardHeader className="mb-1">
        <CardTitle>Team secrets</CardTitle>
        <span className="text-xs text-paper-500 tabular-nums">{list.length}</span>
      </CardHeader>
      <p className="mb-4 text-sm text-paper-400">
        Stored encrypted; a saved value cannot be read back. A team secret reaches only repositories
        you grant it to, and only in workspace setup steps and app previews, never to the agent. A
        repository&apos;s own secret of the same name takes precedence.
      </p>

      {error && (
        <div className="mb-3">
          <Alert variant="error">{error}</Alert>
        </div>
      )}
      {secrets.isError && (
        <div className="mb-3">
          <Alert variant="error">
            {errMsg(secrets.error, 'The team secrets could not be read')}
          </Alert>
        </div>
      )}

      {list.length === 0 ? (
        !secrets.isLoading && (
          <EmptyState
            className="py-4"
            hint="Add one below, then grant it to the repositories that need it."
            icon="key"
            title="No team secrets yet"
          />
        )
      ) : (
        <ul className="mb-4 divide-y divide-ink-600">
          {list.map((s) => (
            <SecretRow
              grants={openGrants === s.name}
              key={s.name}
              onDelete={() => setConfirmDelete(s.name)}
              onError={setError}
              onToggleGrants={() => setOpenGrants(openGrants === s.name ? null : s.name)}
              repositories={repositories}
              secret={s}
              teamId={teamId}
            />
          ))}
        </ul>
      )}

      <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <Input
          compact
          label="Secret name"
          onChange={(e) => setName(e.target.value)}
          placeholder="NPM_TOKEN"
          value={name}
        />
        <Input
          autoComplete="off"
          compact
          label="Value"
          onChange={(e) => setValue(e.target.value)}
          type="password"
          value={value}
        />
        <Button
          disabled={
            !nameCheck.success || value.length < MIN_REPO_SETUP_SECRET_CHARS || save.isPending
          }
          onClick={() => {
            setError(null);
            save.mutate(
              { name: name.trim(), value },
              {
                onError: (err) => setError(errMsg(err, 'The team secret could not be saved')),
                onSuccess: () => {
                  setName('');
                  setValue('');
                },
              }
            );
          }}
          size="sm"
        >
          {save.isPending ? 'Saving…' : 'Save secret'}
        </Button>
      </div>
      <p className="mt-2 text-xs text-paper-500">
        Saving a name that already exists replaces its value and keeps its grants.
      </p>
      {value && value.length < MIN_REPO_SETUP_SECRET_CHARS && (
        <p className="text-xs text-danger-400">
          A secret must be at least {MIN_REPO_SETUP_SECRET_CHARS} characters, so the setup scan can
          find it if a step leaves it on disk.
        </p>
      )}
      {name.trim() && !nameCheck.success && (
        <p className="text-xs text-danger-400">Use an environment variable name (A-Z, 0-9, _).</p>
      )}

      <ConfirmModal
        confirmLabel="Delete secret"
        dangerous
        message={`${confirmDelete ?? ''} is deleted and removed from every repository it was granted to. Setup steps and previews that name it will fail until it is saved again.`}
        onClose={() => setConfirmDelete(null)}
        onConfirm={async () => {
          if (confirmDelete) {
            setError(null);
            await remove.mutateAsync(confirmDelete);
          }
        }}
        open={confirmDelete !== null}
        title="Delete team secret?"
      />
    </Card>
  );
}

function SecretRow({
  grants,
  onDelete,
  onError,
  onToggleGrants,
  repositories,
  secret,
  teamId,
}: {
  grants: boolean;
  onDelete: () => void;
  onError: (message: string | null) => void;
  onToggleGrants: () => void;
  repositories: Pick<RepoRef, 'id' | 'organizationName' | 'repoName'>[];
  secret: TeamSecretSummary;
  teamId: string;
}) {
  return (
    <li className="space-y-3 py-2.5">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-mono text-paper-200">{secret.name}</span>
        <span className="flex items-center gap-2 text-xs text-paper-500">
          {secret.lastFour ? `••••${secret.lastFour}` : '••••'}
          <span className="tabular-nums">
            {secret.grantedConnectionIds.length} repo
            {secret.grantedConnectionIds.length === 1 ? '' : 's'}
          </span>
          <Button aria-expanded={grants} onClick={onToggleGrants} size="sm" variant="ghost">
            {grants ? 'Close' : 'Repositories'}
          </Button>
          <Button
            aria-label={`Delete team secret ${secret.name}`}
            className="px-2 hover:text-danger-400"
            onClick={onDelete}
            size="sm"
            title="Delete secret"
            variant="ghost"
          >
            <Icon name="trash" size={14} />
          </Button>
        </span>
      </div>
      {grants && (
        <GrantsEditor
          key={secret.name}
          onError={onError}
          repositories={repositories}
          secret={secret}
          teamId={teamId}
        />
      )}
    </li>
  );
}

function GrantsEditor({
  onError,
  repositories,
  secret,
  teamId,
}: {
  onError: (message: string | null) => void;
  repositories: Pick<RepoRef, 'id' | 'organizationName' | 'repoName'>[];
  secret: TeamSecretSummary;
  teamId: string;
}) {
  const setGrants = useSetTeamSecretGrants(teamId);
  const [selected, setSelected] = useState<string[]>(secret.grantedConnectionIds);
  const unchanged =
    selected.length === secret.grantedConnectionIds.length &&
    selected.every((id) => secret.grantedConnectionIds.includes(id));

  if (repositories.length === 0) {
    return (
      <p className="text-xs text-paper-500">
        The team owns no repositories to grant this secret to.
      </p>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-ink-600 p-3">
      <p className="text-xs text-paper-500">
        Repositories this secret is granted to. Only repositories this team owns can be chosen.
      </p>
      <ul className="space-y-2">
        {repositories.map((r) => (
          <li key={r.id}>
            <Checkbox
              checked={selected.includes(r.id)}
              label={<span className="font-mono">{`${r.organizationName}/${r.repoName}`}</span>}
              onChange={(e) =>
                setSelected((prev) =>
                  e.target.checked ? [...prev, r.id] : prev.filter((id) => id !== r.id)
                )
              }
            />
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <Button
          disabled={unchanged || setGrants.isPending}
          onClick={() => {
            onError(null);
            setGrants.mutate(
              { connectionIds: selected, name: secret.name },
              {
                onError: (err) => onError(errMsg(err, 'The grants could not be saved')),
              }
            );
          }}
          size="sm"
        >
          {setGrants.isPending ? 'Saving…' : `Save grants for ${secret.name}`}
        </Button>
      </div>
    </div>
  );
}
