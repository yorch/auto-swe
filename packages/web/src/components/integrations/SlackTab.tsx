'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  type SlackConfigInput,
  useSlackConfig,
  useUpdateSlackConfig,
} from '@/hooks/useAdminConfig';
import { RestartWarning } from './RestartWarning';
import { SecretInput } from './SecretInput';

export function SlackTab() {
  const { data, isLoading } = useSlackConfig();
  const update = useUpdateSlackConfig();

  const [botToken, setBotToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [signingSecret, setSigningSecret] = useState('');

  const [saved, setSaved] = useState(false);
  const [requiresRestart, setRequiresRestart] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setRequiresRestart(false);

    const body: SlackConfigInput = {};
    if (botToken) body.botToken = botToken;
    if (clientId) body.clientId = clientId;
    if (clientSecret) body.clientSecret = clientSecret;
    if (signingSecret) body.signingSecret = signingSecret;

    try {
      const res = await update.mutateAsync(body);
      setSaved(true);
      setRequiresRestart(!!res.data.requiresRestart);
      // Clear typed secrets after save
      setBotToken('');
      setClientSecret('');
      setSigningSecret('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  if (isLoading) {
    return <p className="text-sm text-paper-400">Loading…</p>;
  }

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <Card>
        <CardHeader>
          <CardTitle eyebrow="Slack">App credentials</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          Client ID and Client Secret changes require a gateway restart. Bot token and signing
          secret apply immediately.
        </p>
        <div className="space-y-4">
          <div>
            <label
              className="mb-1 block text-xs uppercase text-paper-500"
              htmlFor="slack-client-id"
            >
              Client ID
              {data?.clientId && (
                <span className="ml-2 font-mono text-[10px] normal-case tracking-normal text-paper-400">
                  current: {data.clientId}
                </span>
              )}
            </label>
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="slack-client-id"
              onChange={(e) => setClientId(e.target.value)}
              placeholder="1234567890.123456789012"
              value={clientId}
            />
          </div>
          <SecretInput
            current={data?.clientSecret ?? null}
            id="slack-client-secret"
            label="Client secret"
            onChange={setClientSecret}
            value={clientSecret}
          />
          <SecretInput
            current={data?.signingSecret ?? null}
            id="slack-signing-secret"
            label="Signing secret"
            onChange={setSigningSecret}
            value={signingSecret}
          />
          <SecretInput
            current={data?.botToken ?? null}
            id="slack-bot-token"
            label="Bot token"
            onChange={setBotToken}
            placeholder="xoxb-..."
            value={botToken}
          />
        </div>
      </Card>

      {requiresRestart && <RestartWarning />}
      {saved && !requiresRestart && <p className="text-sm text-emerald-400">Settings saved.</p>}
      {error && <p className="text-sm text-brick-400">{error}</p>}

      <div className="flex justify-end">
        <Button disabled={update.isPending} type="submit" variant="primary">
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
