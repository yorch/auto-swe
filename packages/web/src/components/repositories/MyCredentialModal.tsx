'use client';

import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import {
  type MyCredential,
  useDeleteMyCredential,
  useSaveMyCredential,
} from '@/hooks/useRepositories';
import { connectionLabel } from '@/lib/connectionDisplay';
import { errMsg } from '@/lib/errors';

/**
 * Save, replace or remove the signed-in user's own GitHub token for one
 * repository. The token is write-only from here: once saved, only its last four
 * characters ever come back.
 */
export function MyCredentialModal({
  repo,
  credential,
  enabled,
  hosts,
  onClose,
}: {
  repo: RepositorySummary;
  credential: MyCredential | undefined;
  enabled: boolean;
  hosts: string[];
  onClose: () => void;
}) {
  const [token, setToken] = useState('');
  const save = useSaveMyCredential(repo.id);
  const remove = useDeleteMyCredential(repo.id);
  const busy = save.isPending || remove.isPending;
  const error = save.error ?? remove.error;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await save.mutateAsync(token.trim());
    setToken('');
    onClose();
  }

  async function handleRemove() {
    await remove.mutateAsync();
    onClose();
  }

  return (
    <Modal
      eyebrow="§ My GitHub credential"
      onClose={onClose}
      open
      subtitle="Runs you start against this repository clone, push and open pull requests as this token instead of the platform's. Nobody else's runs ever use it."
      title={connectionLabel(repo)}
    >
      <form className="space-y-5" onSubmit={(e) => void handleSave(e).catch(() => {})}>
        {credential && (
          <p className="text-sm text-paper-300">
            Saved token ending in{' '}
            <code className="font-mono text-paper-100">…{credential.lastFour || '????'}</code>, last
            updated {new Date(credential.updatedAt).toLocaleString()}.
          </p>
        )}
        {enabled ? (
          <Input
            autoComplete="off"
            disabled={busy}
            hint={`A fine-grained token scoped to this repository, with Contents and Pull requests write access, is the narrowest that works. Allowed hosts: ${hosts.join(', ') || 'none'}.`}
            id="my-credential-token"
            label={credential ? 'Replace token' : 'Personal access token'}
            onChange={(e) => setToken(e.target.value)}
            type="password"
            value={token}
          />
        ) : (
          <p className="text-sm text-paper-400">
            Personal GitHub credentials are turned off on this platform, so a saved token is not
            used. You can still remove it.
          </p>
        )}

        {error && (
          <p className="font-mono text-[10px] uppercase tracking-wider text-brick-400">
            {errMsg(error, 'Could not update the credential.')}
          </p>
        )}
        <div className="flex items-center justify-between gap-3 border-t border-ink-600 pt-4">
          <div>
            {credential && (
              <Button
                disabled={busy}
                onClick={() => void handleRemove().catch(() => {})}
                type="button"
                variant="ghost"
              >
                {remove.isPending ? 'Removing…' : 'Remove token'}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={onClose} type="button" variant="ghost">
              Cancel
            </Button>
            {enabled && (
              <Button disabled={busy || token.trim().length === 0} type="submit" variant="primary">
                {save.isPending ? 'Verifying…' : 'Save token'}
              </Button>
            )}
          </div>
        </div>
      </form>
    </Modal>
  );
}
