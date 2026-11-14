'use client';

import type { RepositorySummary, TokenWriteCapability } from '@auto-swe/shared/types/api';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import {
  type MyCredential,
  useDeleteMyCredential,
  useSaveMyCredential,
} from '@/hooks/useRepositories';
import { connectionLabel } from '@/lib/connectionDisplay';
import { errMsg } from '@/lib/errors';
import { formatDate } from '@/lib/utils';

/**
 * The notice shown after a save when the token may not be able to write. `ok`, or a
 * capability the gateway did not report, needs no notice.
 */
export function writeCapabilityNotice(
  capability: TokenWriteCapability | undefined
): { variant: 'warning' | 'info'; text: string } | null {
  switch (capability) {
    case 'insufficient':
      return {
        text: 'Saved. This token does not have the repo scope, so reviews and comments sent from the pull request page will probably be refused.',
        variant: 'warning',
      };
    case 'unverifiable':
      return {
        text: "Saved. This token's permissions could not be checked here. If sending a review is refused, check that it may write pull requests on this repository.",
        variant: 'info',
      };
    default:
      return null;
  }
}

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
  onSaved,
}: {
  repo: RepositorySummary;
  credential: MyCredential | undefined;
  enabled: boolean;
  /** Present for platform admins only. */
  hosts?: string[];
  onClose: () => void;
  /** Called after a token is saved or removed, with a sentence for a status message. */
  onSaved?: (message: string) => void;
}) {
  const [token, setToken] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [writeNotice, setWriteNotice] = useState<ReturnType<typeof writeCapabilityNotice>>(null);
  const save = useSaveMyCredential(repo.id);
  const remove = useDeleteMyCredential(repo.id);
  const busy = save.isPending || remove.isPending;
  const error = save.error ?? remove.error;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setWriteNotice(null);
    const saved = await save.mutateAsync(token.trim());
    setToken('');
    const notice = writeCapabilityNotice(saved.data.writeCapability);
    // The token is saved either way, so the page hears it. With a notice the modal stays open
    // (the page closes it only through onClose) so the notice stays in view; the user closes it.
    if (notice) {
      setWriteNotice(notice);
      onSaved?.('Token saved. Your runs on this repository now use it.');
      return;
    }
    onSaved?.('Token saved and verified. Your runs on this repository now use it.');
    onClose();
  }

  async function handleRemove() {
    setWriteNotice(null);
    await remove.mutateAsync();
    onSaved?.('Token removed. Your runs go back to the platform credential.');
    onClose();
  }

  return (
    <>
      <Modal
        onClose={onClose}
        open
        subtitle="Runs you start against this repository clone, push and open pull requests as this token instead of the platform's. Nobody else's runs ever use it."
        title={connectionLabel(repo)}
      >
        <form className="space-y-5" onSubmit={(e) => void handleSave(e).catch(() => {})}>
          {credential && (
            <div className="flex items-center gap-3 rounded-lg border border-ink-500/60 bg-ink-800/40 px-4 py-3">
              <Icon className="text-success-400" name="key" size={16} />
              <p className="text-sm text-paper-300">
                Saved token ending in{' '}
                <code className="font-mono text-paper-100">…{credential.lastFour || '????'}</code>
                <span className="block text-xs text-paper-500">
                  Last updated {formatDate(credential.updatedAt)}
                </span>
              </p>
            </div>
          )}
          {enabled ? (
            <Input
              autoComplete="new-password"
              disabled={busy}
              hint={`A fine-grained token scoped to this repository, with Contents and Pull requests write access, is the narrowest that works.${hosts ? ` Allowed hosts: ${hosts.join(', ') || 'none'}.` : ''}`}
              id="my-credential-token"
              label={credential ? 'Replace token' : 'Personal access token'}
              name="github-token"
              onChange={(e) => setToken(e.target.value)}
              spellCheck={false}
              type="password"
              value={token}
            />
          ) : (
            <Alert variant="warning">
              Personal GitHub credentials are turned off on this platform, so a saved token is not
              used. You can still remove it.
            </Alert>
          )}

          {writeNotice && <Alert variant={writeNotice.variant}>{writeNotice.text}</Alert>}

          {error && (
            <Alert>
              {errMsg(error, 'Could not update the credential.')}{' '}
              {save.error &&
                'Check that the token is valid, has not expired, and has Contents and Pull requests write access to this repository.'}
            </Alert>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-600 pt-4">
            <div>
              {credential && (
                <Button
                  disabled={busy}
                  onClick={() => setConfirmRemove(true)}
                  size="sm"
                  type="button"
                  variant="danger"
                >
                  {remove.isPending ? 'Removing…' : 'Remove token'}
                </Button>
              )}
            </div>
            <div className="flex items-center gap-3">
              <Button onClick={onClose} type="button" variant="ghost">
                {writeNotice ? 'Close' : 'Cancel'}
              </Button>
              {enabled && (
                <Button
                  disabled={busy || token.trim().length === 0}
                  type="submit"
                  variant="primary"
                >
                  {save.isPending ? 'Verifying…' : 'Save token'}
                </Button>
              )}
            </div>
          </div>
        </form>
      </Modal>
      {confirmRemove && (
        <ConfirmModal
          confirmLabel="Remove token"
          dangerous
          message="Runs you start on this repository go back to the platform credential. You can save a new token at any time."
          onClose={() => setConfirmRemove(false)}
          onConfirm={() => handleRemove().catch(() => {})}
          open
          title="Remove your token?"
        />
      )}
    </>
  );
}
