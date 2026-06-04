'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import {
  type SlackConfigInput,
  useSlackConfig,
  useTestSlackConnection,
  useUpdateSlackConfig,
} from '@/hooks/useAdminConfig';
import { API_BASE } from '@/lib/config';
import { RestartWarning } from './RestartWarning';
import { SecretInput } from './SecretInput';
import { SourceBadge } from './SourceBadge';

const SLACK_REDIRECT_URI = `${API_BASE}/api/auth/slack/callback`;
const SLACK_EVENT_URL = `${API_BASE}/api/v1/webhooks/slack/events`;
const SLACK_INTERACTIVITY_URL = `${API_BASE}/api/v1/webhooks/slack/interactivity`;

export function SlackTab() {
  const { data: resp, isLoading } = useSlackConfig();
  const data = resp?.data;
  const sources = resp?.sources ?? {};
  const update = useUpdateSlackConfig();
  const testConn = useTestSlackConnection();

  const [botToken, setBotToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [signingSecret, setSigningSecret] = useState('');

  const [saved, setSaved] = useState(false);
  const [requiresRestart, setRequiresRestart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setRequiresRestart(false);
    setTestResult(null);

    const body: SlackConfigInput = {};
    if (botToken) {
      body.botToken = botToken;
    }
    if (clientId) {
      body.clientId = clientId;
    }
    if (clientSecret) {
      body.clientSecret = clientSecret;
    }
    if (signingSecret) {
      body.signingSecret = signingSecret;
    }

    try {
      const res = await update.mutateAsync(body);
      setSaved(true);
      setRequiresRestart(!!res.data.requiresRestart);
      setBotToken('');
      setClientSecret('');
      setSigningSecret('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const handleTest = async () => {
    setTestResult(null);
    try {
      const res = await testConn.mutateAsync();
      setTestResult(res);
    } catch (err) {
      setTestResult({ detail: err instanceof Error ? err.message : 'Request failed', ok: false });
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
              className="mb-1 flex items-center gap-2 text-xs uppercase text-paper-500"
              htmlFor="slack-client-id"
            >
              Client ID
              <SourceBadge source={sources.clientId} />
              {data?.clientId && (
                <span className="font-mono text-[10px] normal-case tracking-normal text-paper-400">
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
            source={sources.clientSecret}
            value={clientSecret}
          />
          <SecretInput
            current={data?.signingSecret ?? null}
            id="slack-signing-secret"
            label="Signing secret"
            onChange={setSigningSecret}
            source={sources.signingSecret}
            value={signingSecret}
          />
          <SecretInput
            current={data?.botToken ?? null}
            id="slack-bot-token"
            label="Bot token"
            onChange={setBotToken}
            placeholder="xoxb-..."
            source={sources.botToken}
            value={botToken}
          />
        </div>

        <div className="mt-4 flex justify-end">
          <Button
            disabled={testConn.isPending || (!data?.botToken && !botToken)}
            onClick={handleTest}
            size="sm"
            type="button"
            variant="secondary"
          >
            {testConn.isPending ? 'Testing…' : 'Test connection'}
          </Button>
        </div>

        {testResult && (
          <p className={`mt-2 text-sm ${testResult.ok ? 'text-emerald-400' : 'text-brick-400'}`}>
            {testResult.ok ? '✓' : '✗'} {testResult.detail}
          </p>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle eyebrow="Slack App">URLs to register</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          Add these in your Slack App settings under OAuth &amp; Permissions / Event Subscriptions.
        </p>
        <div className="space-y-3">
          <SlackUrlRow label="OAuth redirect URI" url={SLACK_REDIRECT_URI} />
          <SlackUrlRow label="Event subscriptions" url={SLACK_EVENT_URL} />
          <SlackUrlRow label="Interactivity" url={SLACK_INTERACTIVITY_URL} />
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

function SlackUrlRow({ label, url }: { label: string; url: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-36 shrink-0 text-[11px] text-paper-500">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded-sm border border-ink-700 bg-ink-900 px-2 py-1 font-mono text-[11px] text-paper-300">
        {url}
      </code>
      <CopyButton value={url} />
    </div>
  );
}
