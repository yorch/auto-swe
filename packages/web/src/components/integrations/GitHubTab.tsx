'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import {
  type GitHubConfigInput,
  testGitHubConnection,
  useGitHubConfig,
  useUpdateGitHubConfig,
} from '@/hooks/useAdminConfig';
import { useIntegrationConfigForm } from '@/hooks/useIntegrationConfigForm';
import { usePrefilledField } from '@/hooks/usePrefilledField';
import { API_BASE } from '@/lib/config';
import { clearableField } from '@/lib/configFieldPatch';
import { ConfigField } from './ConfigField';
import { GitHubHostSecretsCard } from './GitHubHostSecretsCard';
import { IntegrationFormFooter, TestResultAlert } from './IntegrationFormFooter';
import { SecretInput } from './SecretInput';
import { UrlRow } from './UrlRow';

export function GitHubTab() {
  const { data: resp, error: loadError, isError, isLoading } = useGitHubConfig();
  const data = resp?.data;
  const sources = resp?.sources ?? {};
  const update = useUpdateGitHubConfig();

  const [token, setToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [oauthClientId, setOauthClientId] = usePrefilledField(data?.oauthClientId);
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [baseUrl, setBaseUrl] = usePrefilledField(data?.baseUrl);
  const [apiUrl, setApiUrl] = usePrefilledField(data?.apiUrl);
  const [appId, setAppId] = usePrefilledField(data?.appId);
  const [appClientId, setAppClientId] = usePrefilledField(data?.appClientId);
  const [appClientSecret, setAppClientSecret] = useState('');
  const [appPrivateKey, setAppPrivateKey] = useState('');
  const [appInstallationId, setAppInstallationId] = usePrefilledField(data?.appInstallationId);
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
    // Non-secret fields are prefilled: omit when unchanged, send null when cleared.
    body.oauthClientId = clearableField(oauthClientId, data?.oauthClientId);
    if (oauthClientSecret) {
      body.oauthClientSecret = oauthClientSecret;
    }
    body.baseUrl = clearableField(baseUrl, data?.baseUrl);
    body.apiUrl = clearableField(apiUrl, data?.apiUrl);
    body.appId = clearableField(appId, data?.appId);
    body.appClientId = clearableField(appClientId, data?.appClientId);
    if (appClientSecret) {
      body.appClientSecret = appClientSecret;
    }
    if (appPrivateKey) {
      body.appPrivateKey = appPrivateKey;
    }
    body.appInstallationId = clearableField(appInstallationId, data?.appInstallationId);
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

  if (isLoading || isError) {
    return (
      <QueryBoundary
        error={loadError}
        isError={isError}
        isLoading={isLoading}
        label="GitHub config"
      />
    );
  }

  return (
    <div className="space-y-6">
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
              <div className="label-mono">Webhook endpoints</div>
              <UrlRow label="PR / merge events" url={webhookUrl} />
              <UrlRow
                help="Register both URLs in your GitHub repository or organization webhook settings. Use Content-Type: application/json."
                label="CI check runs"
                url={ciWebhookUrl}
              />
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

          <TestResultAlert result={testResult} />
        </Card>

        <Card>
          <CardHeader>
            <CardTitle eyebrow="GitHub App">App authentication (optional)</CardTitle>
          </CardHeader>
          <p className="mb-4 text-xs text-paper-500">
            GitHub App installation tokens are short-lived and scoped. Configure all four fields to
            enable App auth. See <code className="font-mono">docs/github-app-setup.md</code> for
            setup instructions.
          </p>
          <div className="space-y-4">
            <ConfigField
              current={data?.appId || undefined}
              id="gh-app-id"
              label="App ID"
              source={sources.appId}
            >
              <Input
                compact
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
              <Input
                compact
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
              <Textarea
                className="resize-none"
                compact
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
              <Input
                compact
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
              <Select
                compact
                id="gh-auth-mode"
                onChange={(e) => setAuthMode(e.target.value)}
                value={authMode ?? 'auto'}
              >
                <option value="auto">auto (app if configured, else PAT)</option>
                <option value="pat">pat (always use PAT)</option>
                <option value="app">app (always use App)</option>
              </Select>
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
              <Input
                compact
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
              <Input
                compact
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
              <Input
                compact
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

            <UrlRow
              help={
                <>
                  Add this as the Authorization callback URL in your GitHub OAuth App settings. The
                  host must match the gateway&apos;s BETTER_AUTH_URL — better-auth builds its
                  redirect_uri from that value.
                </>
              }
              label="OAuth callback URL"
              url={githubOauthCallback}
            />
          </div>
        </Card>

        <IntegrationFormFooter
          error={error}
          isPending={update.isPending}
          requiresRestart={requiresRestart}
          saved={saved}
        />
      </form>
      <GitHubHostSecretsCard />
    </div>
  );
}
