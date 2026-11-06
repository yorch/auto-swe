'use client';

import { RepoSetupSecretNameSchema } from '@auto-swe/shared/lib/repoSetup';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { useDeleteSetupSecret, useSaveSetupSecret, useSetupSecrets } from '@/hooks/useRepositories';
import { errMsg } from '@/lib/errors';

/**
 * The repository's setup secrets: write-only values that setup steps receive as environment
 * variables when the definition names them under `secrets`. Only the name and last four
 * characters come back after saving.
 */
export function RepoSetupSecrets({
  disabled,
  repositoryId,
}: {
  disabled: boolean;
  repositoryId: string;
}) {
  const secrets = useSetupSecrets(repositoryId);
  const save = useSaveSetupSecret(repositoryId);
  const remove = useDeleteSetupSecret(repositoryId);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const nameCheck = RepoSetupSecretNameSchema.safeParse(name.trim());

  return (
    <div className="space-y-2 rounded-lg border border-ink-600 p-3">
      <h4 className="text-sm text-paper-200">Setup secrets</h4>
      <p className="text-xs text-paper-500">
        Stored encrypted. Setup steps get the ones the definition lists under Secret names, as
        environment variables; the agent never does. A saved value cannot be read back.
      </p>
      {secrets.data?.length ? (
        <ul className="space-y-1">
          {secrets.data.map((s) => (
            <li className="flex items-center justify-between gap-2 text-sm" key={s.name}>
              <span className="font-mono text-paper-200">{s.name}</span>
              <span className="flex items-center gap-2 text-xs text-paper-500">
                {s.lastFour ? `••••${s.lastFour}` : '••••'}
                <Button
                  aria-label={`Delete secret ${s.name}`}
                  className="px-2 hover:text-danger-400"
                  disabled={disabled || remove.isPending}
                  onClick={() => {
                    setError(null);
                    remove.mutate(s.name, {
                      onError: (err) => setError(errMsg(err, 'The secret could not be deleted')),
                    });
                  }}
                  size="sm"
                  title="Delete secret"
                  variant="ghost"
                >
                  <Icon name="trash" size={14} />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        !secrets.isLoading && <p className="text-xs text-paper-500">No setup secrets.</p>
      )}
      <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
        <Input
          compact
          disabled={disabled}
          label="Secret name"
          onChange={(e) => setName(e.target.value)}
          placeholder="NPM_TOKEN"
          value={name}
        />
        <Input
          autoComplete="off"
          compact
          disabled={disabled}
          label="Value"
          onChange={(e) => setValue(e.target.value)}
          type="password"
          value={value}
        />
        <Button
          disabled={disabled || !nameCheck.success || !value || save.isPending}
          onClick={() => {
            setError(null);
            save.mutate(
              { name: name.trim(), value },
              {
                onError: (err) => setError(errMsg(err, 'The secret could not be saved')),
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
      {name.trim() && !nameCheck.success && (
        <p className="text-xs text-danger-400">Use an environment variable name (A-Z, 0-9, _).</p>
      )}
      {secrets.isError && (
        <Alert variant="error">
          {errMsg(secrets.error, 'The setup secrets could not be read')}
        </Alert>
      )}
      {error && <Alert variant="error">{error}</Alert>}
    </div>
  );
}
