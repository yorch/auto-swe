'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import {
  type GitHubConfigInput,
  type GitHubTestDraft,
  testGitHubConnection,
  useGitHubConfig,
  useUpdateGitHubConfig,
} from '@/hooks/useAdminConfig';
import { useIntegrationConfigForm } from '@/hooks/useIntegrationConfigForm';
import { usePrefilledField } from '@/hooks/usePrefilledField';
import { API_BASE } from '@/lib/config';
import { clearableField, countChanges } from '@/lib/configFieldPatch';
import { ConfigField } from './ConfigField';
import { ConfigStatusBadge, fieldState, groupState } from './ConfigStatusBadge';
import { GitHubHostCredentialsCard } from './GitHubHostCredentialsCard';
import { GitHubHostSecretsCard } from './GitHubHostSecretsCard';
import { FieldGrid, IntegrationCard } from './IntegrationCard';
import { IntegrationFormFooter, TestResultAlert } from './IntegrationFormFooter';
import { SecretInput, SecretStatus } from './SecretInput';
import { UrlRow } from './UrlRow';

export function GitHubTab() {
  const {
    data: resp,
    error: loadError,
    isError,
    isFetching,
    refetch,
    isLoading,
  } = useGitHubConfig();
  const data = resp?.data;
  const sources = resp?.sources ?? {};
  const update = useUpdateGitHubConfig();

  const [token, setToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [baseUrl, setBaseUrl] = usePrefilledField(data?.baseUrl);
  const [apiUrl, setApiUrl] = usePrefilledField(data?.apiUrl);
  const [appId, setAppId] = usePrefilledField(data?.appId);
  const [appClientId, setAppClientId] = usePrefilledField(data?.appClientId);
  const [appClientSecret, setAppClientSecret] = useState('');
  const [appPrivateKey, setAppPrivateKey] = useState('');
  const [appInstallationId, setAppInstallationId] = usePrefilledField(data?.appInstallationId);
  // Seeded from the saved value so the select shows what is stored; an unset
  // mode reads as `auto`, which is what the worker treats it as.
  const [authMode, setAuthMode] = usePrefilledField(data?.authMode ?? 'auto');

  // What Save would send: omitted keys are unchanged, so their count is the unsaved edits.
  // Non-secret fields are prefilled: omit when unchanged, send null when cleared.
  const body: GitHubConfigInput = {
    apiUrl: clearableField(apiUrl, data?.apiUrl),
    appClientId: clearableField(appClientId, data?.appClientId),
    appClientSecret: appClientSecret || undefined,
    appId: clearableField(appId, data?.appId),
    appInstallationId: clearableField(appInstallationId, data?.appInstallationId),
    appPrivateKey: appPrivateKey || undefined,
    authMode: authMode === (data?.authMode ?? 'auto') ? undefined : authMode,
    baseUrl: clearableField(baseUrl, data?.baseUrl),
    token: token || undefined,
    webhookSecret: webhookSecret || undefined,
  };
  const dirtyCount = countChanges(body);

  const { saved, error, testing, testResult, submit, runTest } =
    useIntegrationConfigForm(dirtyCount);

  const webhookUrl = `${API_BASE}/api/v1/webhooks/git`;
  const ciWebhookUrl = `${API_BASE}/api/v1/webhooks/ci`;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    submit(
      () => update.mutateAsync(body),
      () => {
        setToken('');
        setWebhookSecret('');
        setAppPrivateKey('');
        setAppClientSecret('');
      }
    );
  };

  const handleTest = () => {
    // Send what is on screen so the result describes what Save would store. A
    // blank secret means the stored one; unchanged fields are left out.
    const draft: GitHubTestDraft = {};
    if (token) {
      draft.token = token;
    }
    if (appPrivateKey) {
      draft.appPrivateKey = appPrivateKey;
    }
    const apiUrlDraft = clearableField(apiUrl, data?.apiUrl);
    if (apiUrlDraft !== undefined) {
      draft.apiUrl = apiUrlDraft;
    }
    const appIdDraft = clearableField(appId, data?.appId);
    if (appIdDraft !== undefined) {
      draft.appId = appIdDraft;
    }
    const installationDraft = clearableField(appInstallationId, data?.appInstallationId);
    if (installationDraft !== undefined) {
      draft.appInstallationId = installationDraft;
    }
    if (authMode !== (data?.authMode ?? 'auto')) {
      draft.authMode = authMode;
    }
    const unsaved = Object.keys(draft).length > 0;
    runTest(async () => ({ ...(await testGitHubConnection(draft)), unsaved }));
  };

  if (isLoading || isError) {
    return (
      <QueryBoundary
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="GitHub config"
        onRetry={() => void refetch()}
      />
    );
  }

  const tokenState = fieldState(data?.token, sources.token);
  const appState = groupState([
    fieldState(data?.appId, sources.appId),
    fieldState(data?.appPrivateKey, sources.appPrivateKey),
    fieldState(data?.appInstallationId, sources.appInstallationId),
  ]);
  const enterpriseState = groupState([
    fieldState(data?.baseUrl, sources.baseUrl),
    fieldState(data?.apiUrl, sources.apiUrl),
  ]);

  return (
    <div className="space-y-6">
      <form className="space-y-6" onSubmit={handleSubmit}>
        <IntegrationCard
          description="The token the platform uses to clone, push and open pull requests, and the secret that signs the webhooks GitHub sends back."
          eyebrow="GitHub"
          footer={
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-paper-500">
                  Checks the token on screen, or the saved one if the field is blank.
                </p>
                <Button
                  disabled={testing || (!data?.token && !token)}
                  onClick={handleTest}
                  type="button"
                  variant="secondary"
                >
                  {testing ? 'Testing…' : 'Test connection'}
                </Button>
              </div>
              <TestResultAlert result={testResult} />
            </>
          }
          status={<ConfigStatusBadge state={tokenState} />}
          title="Access token and webhook"
        >
          <div className="space-y-5">
            <FieldGrid>
              <SecretInput
                clear={{ field: 'token', integration: 'github' }}
                current={data?.token ?? null}
                id="gh-token"
                label="Personal access token"
                onChange={setToken}
                placeholder="ghp_..."
                source={sources.token}
                value={token}
              />
              <SecretInput
                clear={{ field: 'webhookSecret', integration: 'github' }}
                current={data?.webhookSecret ?? null}
                id="gh-webhook-secret"
                label="Webhook secret"
                onChange={setWebhookSecret}
                source={sources.webhookSecret}
                value={webhookSecret}
              />
            </FieldGrid>

            <div className="space-y-2.5 rounded-lg border border-ink-500/60 bg-ink-900/30 p-4">
              <div className="text-[13px] font-medium text-paper-200">Webhook endpoints</div>
              <UrlRow label="PR and merge events" url={webhookUrl} />
              <UrlRow
                help="Register both URLs in your GitHub repository or organization webhook settings, with Content-Type: application/json."
                label="CI check runs"
                url={ciWebhookUrl}
              />
            </div>
          </div>
        </IntegrationCard>

        <IntegrationCard
          description={
            <>
              GitHub App installation tokens are short-lived and scoped. Fill in the App ID, private
              key and installation ID to enable App auth. See the{' '}
              <Link className="text-ember-400 hover:underline" href="/docs/github-app-setup">
                GitHub App setup guide
              </Link>
              .
            </>
          }
          eyebrow="GitHub App"
          status={<ConfigStatusBadge state={appState} />}
          title="App authentication (optional)"
        >
          <FieldGrid>
            <ConfigField
              current={data?.appId || undefined}
              id="gh-app-id"
              label="App ID"
              source={sources.appId}
            >
              <Input
                className="font-mono"
                compact
                id="gh-app-id"
                onChange={(e) => setAppId(e.target.value)}
                placeholder="12345678"
                value={appId}
              />
            </ConfigField>
            <ConfigField
              current={data?.appInstallationId || undefined}
              id="gh-app-installation-id"
              label="Installation ID"
              source={sources.appInstallationId}
            >
              <Input
                className="font-mono"
                compact
                id="gh-app-installation-id"
                onChange={(e) => setAppInstallationId(e.target.value)}
                placeholder="12345678"
                value={appInstallationId}
              />
            </ConfigField>
            <ConfigField
              current={data?.appClientId || undefined}
              id="gh-app-client-id"
              label="Client ID"
              source={sources.appClientId}
            >
              <Input
                className="font-mono"
                compact
                id="gh-app-client-id"
                onChange={(e) => setAppClientId(e.target.value)}
                placeholder="Iv1.abc..."
                value={appClientId}
              />
            </ConfigField>
            <SecretInput
              clear={{ field: 'appClientSecret', integration: 'github' }}
              current={data?.appClientSecret ?? null}
              id="gh-app-client-secret"
              label="Client secret"
              onChange={setAppClientSecret}
              source={sources.appClientSecret}
              value={appClientSecret}
            />
            <div className="sm:col-span-2">
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
                <SecretStatus
                  clear={{ field: 'appPrivateKey', integration: 'github' }}
                  current={data?.appPrivateKey}
                  label="Private key"
                  source={sources.appPrivateKey}
                />
              </ConfigField>
            </div>
            <div className="sm:col-span-2">
              <ConfigField
                current={data?.authMode || undefined}
                hint="Which credential the worker uses when both a token and an App are configured."
                id="gh-auth-mode"
                label="Auth mode"
                source={sources.authMode}
              >
                <Select
                  aria-label="Auth mode"
                  compact
                  id="gh-auth-mode"
                  onChange={(v) => setAuthMode(v)}
                  options={[
                    { label: 'Automatic: GitHub App if configured, else token', value: 'auto' },
                    { label: 'Token: always use the personal access token', value: 'pat' },
                    { label: 'App: always use the GitHub App', value: 'app' },
                  ]}
                  value={authMode}
                />
              </ConfigField>
            </div>
          </FieldGrid>
        </IntegrationCard>

        <IntegrationCard
          description="Only for GitHub Enterprise Server. Leave both blank to use github.com."
          eyebrow="GitHub Enterprise"
          status={
            enterpriseState === 'unset' ? (
              <Badge tone="muted" variant="outline">
                Using github.com
              </Badge>
            ) : (
              <ConfigStatusBadge state={enterpriseState} />
            )
          }
          title="Custom API and base URLs"
        >
          <FieldGrid>
            <ConfigField
              current={data?.baseUrl || undefined}
              id="gh-base-url"
              label="Base URL"
              source={sources.baseUrl}
            >
              <Input
                className="font-mono"
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
                className="font-mono"
                compact
                id="gh-api-url"
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder="https://api.github.example.com"
                value={apiUrl}
              />
            </ConfigField>
          </FieldGrid>
        </IntegrationCard>

        <IntegrationFormFooter
          dirtyCount={dirtyCount}
          error={error}
          isPending={update.isPending}
          saved={saved}
        />
      </form>
      <GitHubHostCredentialsCard />
      <GitHubHostSecretsCard />
    </div>
  );
}
