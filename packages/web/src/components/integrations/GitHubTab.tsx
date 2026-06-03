'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  type GitHubConfigInput,
  useGitHubConfig,
  useUpdateGitHubConfig,
} from '@/hooks/useAdminConfig';
import { RestartWarning } from './RestartWarning';
import { SecretInput } from './SecretInput';

export function GitHubTab() {
  const { data, isLoading } = useGitHubConfig();
  const update = useUpdateGitHubConfig();

  const [token, setToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiUrl, setApiUrl] = useState('');

  const [saved, setSaved] = useState(false);
  const [requiresRestart, setRequiresRestart] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setRequiresRestart(false);

    const body: GitHubConfigInput = {};
    if (token) body.token = token;
    if (webhookSecret) body.webhookSecret = webhookSecret;
    if (oauthClientId) body.oauthClientId = oauthClientId;
    if (oauthClientSecret) body.oauthClientSecret = oauthClientSecret;
    if (baseUrl) body.baseUrl = baseUrl;
    if (apiUrl) body.apiUrl = apiUrl;

    try {
      const res = await update.mutateAsync(body);
      setSaved(true);
      setRequiresRestart(!!res.data.requiresRestart);
      // Clear typed secrets after save
      setToken('');
      setWebhookSecret('');
      setOauthClientSecret('');
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
          <CardTitle eyebrow="GitHub">Access token &amp; webhook</CardTitle>
        </CardHeader>
        <div className="space-y-4">
          <SecretInput
            current={data?.token ?? null}
            id="gh-token"
            label="Personal access token"
            onChange={setToken}
            placeholder="ghp_..."
            value={token}
          />
          <SecretInput
            current={data?.webhookSecret ?? null}
            id="gh-webhook-secret"
            label="Webhook secret"
            onChange={setWebhookSecret}
            value={webhookSecret}
          />
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle eyebrow="GitHub Enterprise">Custom API &amp; base URLs</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">Leave blank to use github.com defaults.</p>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs uppercase text-paper-500" htmlFor="gh-base-url">
              Base URL
              {data?.baseUrl && (
                <span className="ml-2 font-mono text-[10px] normal-case tracking-normal text-paper-400">
                  current: {data.baseUrl}
                </span>
              )}
            </label>
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="gh-base-url"
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://github.example.com"
              value={baseUrl}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs uppercase text-paper-500" htmlFor="gh-api-url">
              API URL
              {data?.apiUrl && (
                <span className="ml-2 font-mono text-[10px] normal-case tracking-normal text-paper-400">
                  current: {data.apiUrl}
                </span>
              )}
            </label>
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="gh-api-url"
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="https://api.github.example.com"
              value={apiUrl}
            />
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle eyebrow="GitHub OAuth">OAuth application</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          Used for &quot;Sign in with GitHub&quot;. Changes here require a gateway restart to take
          effect.
        </p>
        <div className="space-y-4">
          <div>
            <label
              className="mb-1 block text-xs uppercase text-paper-500"
              htmlFor="gh-oauth-client-id"
            >
              Client ID
              {data?.oauthClientId && (
                <span className="ml-2 font-mono text-[10px] normal-case tracking-normal text-paper-400">
                  current: {data.oauthClientId}
                </span>
              )}
            </label>
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="gh-oauth-client-id"
              onChange={(e) => setOauthClientId(e.target.value)}
              placeholder="Iv1.abc..."
              value={oauthClientId}
            />
          </div>
          <SecretInput
            current={data?.oauthClientSecret ?? null}
            id="gh-oauth-client-secret"
            label="Client secret"
            onChange={setOauthClientSecret}
            value={oauthClientSecret}
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
