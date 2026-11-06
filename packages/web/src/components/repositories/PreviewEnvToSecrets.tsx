'use client';

import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { useMovePreviewEnvToSecrets } from '@/hooks/useRepositories';
import { errMsg } from '@/lib/errors';

/**
 * Offers to move a saved app preview recipe's `env` values, stored as plain text, into the
 * repository's encrypted setup secrets; the recipe then names them under `secrets`.
 */
export function PreviewEnvToSecrets({
  repositoryId,
  envNames,
  disabled,
  onMoved,
}: {
  repositoryId: string;
  envNames: string[];
  disabled?: boolean;
  onMoved: (previewConfig: unknown) => void;
}) {
  const move = useMovePreviewEnvToSecrets(repositoryId);
  if (envNames.length === 0) {
    return null;
  }
  return (
    <div className="space-y-2 rounded-lg border border-ink-600 p-3">
      <p className="text-xs leading-relaxed text-paper-400">
        The saved recipe's env ({envNames.join(', ')}) is stored as plain text and shown to anyone
        who opens this form. Move the values into setup secrets, where they are encrypted and
        write-only; the recipe then names them under <code>secrets</code>.
      </p>
      <Button
        disabled={disabled || move.isPending}
        onClick={() => move.mutate(undefined, { onSuccess: (r) => onMoved(r.previewConfig) })}
        size="sm"
      >
        {move.isPending ? 'Moving…' : 'Move env values to setup secrets'}
      </Button>
      {move.isError && <Alert variant="error">{errMsg(move.error)}</Alert>}
      {move.isSuccess && (
        <p className="text-xs text-paper-400">Moved {move.data.moved.join(', ')}.</p>
      )}
    </div>
  );
}
