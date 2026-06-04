'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import {
  type GitHubConfigInput,
  useGitHubConfig,
  useTestGitHubConnection,
  useUpdateGitHubConfig,
} from '@/hooks/useAdminConfig';
import { API_BASE } from '@/lib/config';
import { RestartWarning } from './RestartWarning';
import { SecretInput } from './SecretInput';
import { SourceBadge } from './SourceBadge';

const WEBHOOK_URL = `${API_BASE}/api/v1/webhooks/git`;
const CI_WEBHOOK_URL = `${API_BASE}/api/v1/webhooks/ci`;
const GITHUB_OAUTH_CALLBACK = `${API_BASE}/api/auth/github/callback`;

export function GitHubTab() {
  const { data: resp, isLoading } = useGitHubConfig();
  const data = resp?.data;
  const sources = resp?.sources ?? {};
  const update = useUpdateGitHubConfig();
  const testConn = useTestGitHubConnection();

  const [token, setToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiUrl, setApiUrl] = useState('');

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

    const body: GitHubConfigInput = {};
    if (token) {
      body.token = token;
    }
    if (webhookSecret) {
      body.webhookSecret = webhookSecret;
    }
    if (oauthClientId) {
      body.oauthClientId = oauthClientId;
    }
    if (oauthClientSecret) {
      body.oauthClientSecret = oauthClientSecret;
    }
    if (baseUrl) {
      body.baseUrl = baseUrl;
    }
    if (apiUrl) {
      body.apiUrl = apiUrl;
    }

    try {
      const res = await update.mutateAsync(body);
      setSaved(true);
      setRequiresRestart(!!res.data.requiresRestart);
      setToken('');
      setWebhookSecret('');
      setOauthClientSecret('');
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
          <CardTitle eyebrow="GitHub">Access token &amp; webhook</CardTitle>
        </CardHeader>
        <div className="space-y-4">
          <SecretInput
            current={data?.token ?? null}
            id="gh-token"
            label="Personal access token"
            onChange={setToken}
            placeholder="ghp_..."
            source={sources.token}
            value={token}
          />
          <SecretInput
            current={data?.webhookSecret ?? null}
            id="gh-webhook-secret"
            label="Webhook secret"
            onChange={setWebhookSecret}
            source={sources.webhookSecret}
            value={webhookSecret}
          />

          <div className="space-y-2 pt-1">
            <div className="text-xs uppercase text-paper-500">Webhook endpoints</div>
            <div className="space-y-1.5">
              <WebhookUrlRow label="PR / merge events" url={WEBHOOK_URL} />
              <WebhookUrlRow label="CI check runs" url={CI_WEBHOOK_URL} />
            </div>
            <p className="text-[11px] text-paper-600">
              Register both URLs in your GitHub repository or organization webhook settings. Use
              Content-Type: application/json.
            </p>
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <Button
            disabled={testConn.isPending || (!data?.token && !token)}
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
          <CardTitle eyebrow="GitHub Enterprise">Custom API &amp; base URLs</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">Leave blank to use github.com defaults.</p>
        <div className="space-y-4">
          <div>
            <label
              className="mb-1 flex items-center gap-2 text-xs uppercase text-paper-500"
              htmlFor="gh-base-url"
            >
              Base URL
              <SourceBadge source={sources.baseUrl} />
              {data?.baseUrl && (
                <span className="font-mono text-[10px] normal-case tracking-normal text-paper-400">
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
            <label
              className="mb-1 flex items-center gap-2 text-xs uppercase text-paper-500"
              htmlFor="gh-api-url"
            >
              API URL
              <SourceBadge source={sources.apiUrl} />
              {data?.apiUrl && (
                <span className="font-mono text-[10px] normal-case tracking-normal text-paper-400">
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
              className="mb-1 flex items-center gap-2 text-xs uppercase text-paper-500"
              htmlFor="gh-oauth-client-id"
            >
              Client ID
              <SourceBadge source={sources.oauthClientId} />
              {data?.oauthClientId && (
                <span className="font-mono text-[10px] normal-case tracking-normal text-paper-400">
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
            source={sources.oauthClientSecret}
            value={oauthClientSecret}
          />

          <div className="space-y-1">
            <div className="text-xs uppercase text-paper-500">OAuth callback URL</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-sm border border-ink-700 bg-ink-900 px-3 py-1.5 font-mono text-xs text-paper-300">
                {GITHUB_OAUTH_CALLBACK}
              </code>
              <CopyButton value={GITHUB_OAUTH_CALLBACK} />
            </div>
            <p className="text-[11px] text-paper-600">
              Add this as the Authorization callback URL in your GitHub OAuth App settings.
            </p>
          </div>
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

function WebhookUrlRow({ label, url }: { label: string; url: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-[11px] text-paper-500">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded-sm border border-ink-700 bg-ink-900 px-2 py-1 font-mono text-[11px] text-paper-300">
        {url}
      </code>
      <CopyButton value={url} />
    </div>
  );
}
