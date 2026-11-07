'use client';

import { secretLookingEnvKeys } from '@auto-swe/shared/lib/previewConfig';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { useMovePreviewEnvToSecrets } from '@/hooks/useRepositories';
import { errMsg } from '@/lib/errors';

/**
 * Offers to move the secret-looking values of a saved app preview recipe's `env`, stored as plain
 * text, into the repository's encrypted setup secrets; the recipe then names them under
 * `secrets`. Until they are moved, the recipe cannot be saved again and its preview does not start.
 */
export function PreviewEnvToSecrets({
  repositoryId,
  env,
  disabled,
  onMoved,
}: {
  repositoryId: string;
  env: Record<string, string> | undefined;
  disabled?: boolean;
  onMoved: (previewConfig: unknown) => void;
}) {
  const move = useMovePreviewEnvToSecrets(repositoryId);
  // `env` is the saved recipe's, which stays stale until the form is reopened.
  const moved = new Set(move.data?.moved ?? []);
  const names = secretLookingEnvKeys(env).filter((n) => !moved.has(n));
  if (names.length === 0 && !move.isSuccess) {
    return null;
  }
  return (
    <div className="space-y-2 rounded-lg border border-ink-600 p-3">
      {names.length > 0 && (
        <>
          <p className="text-xs leading-relaxed text-paper-400">
            The saved recipe's env has secret-looking values ({names.join(', ')}), stored as plain
            text and shown to anyone who opens this form. The preview does not start, and the recipe
            cannot be saved, until they are moved into setup secrets, where they are encrypted and
            write-only; the recipe then names them under <code>secrets</code>.
          </p>
          <Button
            disabled={disabled || move.isPending}
            onClick={() => move.mutate(names, { onSuccess: (r) => onMoved(r.previewConfig) })}
            size="sm"
          >
            {move.isPending ? 'Moving…' : 'Move env values to setup secrets'}
          </Button>
        </>
      )}
      {move.isError && <Alert variant="error">{errMsg(move.error)}</Alert>}
      {move.isSuccess && (
        <p className="text-xs text-paper-400">Moved {move.data.moved.join(', ')}.</p>
      )}
    </div>
  );
}
