'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import {
  type GitHubConfigInput,
  testGitHubConnection,
  useGitHubConfig,
  useUpdateGitHubConfig,
} from '@/hooks/useAdminConfig';
import { useIntegrationConfigForm } from '@/hooks/useIntegrationConfigForm';
import { API_BASE } from '@/lib/config';
import { ConfigField } from './ConfigField';
import { RestartWarning } from './RestartWarning';
import { SecretInput } from './SecretInput';
import { UrlRow } from './UrlRow';

export function GitHubTab() {
  const { data: resp, isLoading } = useGitHubConfig();
  const data = resp?.data;
  const sources = resp?.sources ?? {};
  const update = useUpdateGitHubConfig();

  const [token, setToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [appId, setAppId] = useState('');
  const [appClientId, setAppClientId] = useState('');
  const [appClientSecret, setAppClientSecret] = useState('');
  const [appPrivateKey, setAppPrivateKey] = useState('');
  const [appInstallationId, setAppInstallationId] = useState('');
  const [authMode, setAuthMode] = useState<string | null>(null);

  const { saved, error, requiresRestart, testing, testResult, submit, runTest } =
    useIntegrationConfigForm();

  const webhookUrl = `${API_BASE}/api/v1/webhooks/git`;
  const ciWebhookUrl = `${API_BASE}/api/v1/webhooks/ci`;
  // better-auth's social-provider callback convention: {basePath}/callback/{providerId}
  const githubOauthCallback = `${API_BASE}/api/auth/callback/github`;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

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
    if (appId) {
      body.appId = appId;
    }
    if (appClientId) {
      body.appClientId = appClientId;
    }
    if (appClientSecret) {
      body.appClientSecret = appClientSecret;
    }
    if (appPrivateKey) {
      body.appPrivateKey = appPrivateKey;
    }
    if (appInstallationId) {
      body.appInstallationId = appInstallationId;
    }
    if (authMode !== null) {
      body.authMode = authMode;
    }

    submit(
      () => update.mutateAsync(body),
      () => {
        setToken('');
        setWebhookSecret('');
        setOauthClientSecret('');
        setAppPrivateKey('');
        setAppClientSecret('');
      }
    );
  };

  const handleTest = () => {
    runTest(() => testGitHubConnection());
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
              <UrlRow label="PR / merge events" url={webhookUrl} />
              <UrlRow label="CI check runs" url={ciWebhookUrl} />
            </div>
            <p className="text-[11px] text-paper-600">
              Register both URLs in your GitHub repository or organization webhook settings. Use
              Content-Type: application/json.
            </p>
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <Button
            disabled={testing || (!data?.token && !token)}
            onClick={handleTest}
            size="sm"
            type="button"
            variant="secondary"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
        </div>

        {testResult && (
          <p className={`mt-2 text-sm ${testResult.ok ? 'text-moss-400' : 'text-brick-400'}`}>
            {testResult.ok ? '✓' : '✗'} {testResult.detail}
          </p>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle eyebrow="GitHub App">App authentication (optional)</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          GitHub App installation tokens are short-lived and scoped. Configure all four fields to
          enable App auth. See <code className="font-mono">docs/github-app-setup.md</code> for setup
          instructions.
        </p>
        <div className="space-y-4">
          <ConfigField
            current={data?.appId || undefined}
            id="gh-app-id"
            label="App ID"
            source={sources.appId}
          >
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="gh-app-id"
              onChange={(e) => setAppId(e.target.value)}
              placeholder="12345678"
              value={appId}
            />
          </ConfigField>
          <ConfigField
            current={data?.appClientId || undefined}
            id="gh-app-client-id"
            label="Client ID"
            source={sources.appClientId}
          >
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="gh-app-client-id"
              onChange={(e) => setAppClientId(e.target.value)}
              placeholder="Iv1.abc..."
              value={appClientId}
            />
          </ConfigField>
          <SecretInput
            current={data?.appClientSecret ?? null}
            id="gh-app-client-secret"
            label="Client secret"
            onChange={setAppClientSecret}
            source={sources.appClientSecret}
            value={appClientSecret}
          />
          <ConfigField
            current={data?.appPrivateKey ? `****${data.appPrivateKey.lastFour}` : undefined}
            id="gh-app-private-key"
            label="Private key (PEM)"
            source={sources.appPrivateKey}
          >
            <textarea
              className="w-full resize-none rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="gh-app-private-key"
              onChange={(e) => setAppPrivateKey(e.target.value)}
              placeholder={'-----BEGIN RSA PRIVATE KEY-----\n...'}
              rows={4}
              value={appPrivateKey}
            />
          </ConfigField>
          <ConfigField
            current={data?.appInstallationId || undefined}
            id="gh-app-installation-id"
            label="Installation ID"
            source={sources.appInstallationId}
          >
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="gh-app-installation-id"
              onChange={(e) => setAppInstallationId(e.target.value)}
              placeholder="12345678"
              value={appInstallationId}
            />
          </ConfigField>
          <ConfigField
            current={data?.authMode || undefined}
            id="gh-auth-mode"
            label="Auth mode"
            source={sources.authMode}
          >
            <select
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs text-paper-200 focus:border-ember-400 focus:outline-none"
              id="gh-auth-mode"
              onChange={(e) => setAuthMode(e.target.value)}
              value={authMode ?? 'auto'}
            >
              <option value="auto">auto (app if configured, else PAT)</option>
              <option value="pat">pat (always use PAT)</option>
              <option value="app">app (always use App)</option>
            </select>
          </ConfigField>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle eyebrow="GitHub Enterprise">Custom API &amp; base URLs</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">Leave blank to use github.com defaults.</p>
        <div className="space-y-4">
          <ConfigField
            current={data?.baseUrl || undefined}
            id="gh-base-url"
            label="Base URL"
            source={sources.baseUrl}
          >
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="gh-base-url"
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://github.example.com"
              value={baseUrl}
            />
          </ConfigField>
          <ConfigField
            current={data?.apiUrl || undefined}
            id="gh-api-url"
            label="API URL"
            source={sources.apiUrl}
          >
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="gh-api-url"
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="https://api.github.example.com"
              value={apiUrl}
            />
          </ConfigField>
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
          <ConfigField
            current={data?.oauthClientId || undefined}
            id="gh-oauth-client-id"
            label="Client ID"
            source={sources.oauthClientId}
          >
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="gh-oauth-client-id"
              onChange={(e) => setOauthClientId(e.target.value)}
              placeholder="Iv1.abc..."
              value={oauthClientId}
            />
          </ConfigField>
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
                {githubOauthCallback}
              </code>
              <CopyButton value={githubOauthCallback} />
            </div>
            <p className="text-[11px] text-paper-600">
              Add this as the Authorization callback URL in your GitHub OAuth App settings. The host
              must match the gateway&apos;s BETTER_AUTH_URL — better-auth builds its redirect_uri
              from that value.
            </p>
          </div>
        </div>
      </Card>

      {requiresRestart && <RestartWarning />}
      {saved && !requiresRestart && <p className="text-sm text-moss-400">Settings saved.</p>}
      {error && <p className="text-sm text-brick-400">{error}</p>}

      <div className="flex justify-end">
        <Button disabled={update.isPending} type="submit" variant="primary">
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
