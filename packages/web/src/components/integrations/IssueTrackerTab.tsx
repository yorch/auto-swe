'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { LoadingState } from '@/components/ui/LoadingState';
import {
  type IssueTrackerConfigInput,
  type IssueTrackerProvider,
  testIssueTrackerConnection,
  useDetectJiraFields,
  useIssueTrackerConfig,
  useUpdateIssueTrackerConfig,
} from '@/hooks/useAdminConfig';
import { useIntegrationConfigForm } from '@/hooks/useIntegrationConfigForm';
import { errMsg } from '@/lib/errors';
import { ConfigField } from './ConfigField';
import { SecretInput } from './SecretInput';

const PROVIDER_HINTS: Record<
  IssueTrackerProvider,
  { baseUrl: string; ticket: string; token: string }
> = {
  github: {
    baseUrl: 'API base — leave empty for https://api.github.com (set for GHE)',
    ticket: 'owner/repo#123 (or a bare issue number — resolves to the target repo)',
    token: 'GitHub token with repo read access',
  },
  jira: {
    baseUrl: 'Jira site URL, e.g. https://acme.atlassian.net',
    ticket: 'Issue key, e.g. PROJ-123',
    token: 'Jira API token (used with the email below as basic auth)',
  },
  linear: {
    baseUrl: 'Not used — Linear endpoint is fixed (api.linear.app)',
    ticket: 'Issue identifier, e.g. ENG-123',
    token: 'Linear API key',
  },
};

export function IssueTrackerTab() {
  const { data: resp, isLoading } = useIssueTrackerConfig();
  const data = resp?.data;
  const sources = resp?.sources ?? {};
  const update = useUpdateIssueTrackerConfig();

  const [provider, setProvider] = useState<'' | 'disabled' | IssueTrackerProvider>('');
  const [baseUrl, setBaseUrl] = useState('');
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState<boolean | undefined>(undefined);
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [storyPointsFieldId, setStoryPointsFieldId] = useState('');
  const [epicIssueType, setEpicIssueType] = useState('');
  const [storyIssueType, setStoryIssueType] = useState('');
  const [defaultProjectKey, setDefaultProjectKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [webhookTriggerStatus, setWebhookTriggerStatus] = useState('');

  const detectFields = useDetectJiraFields();

  const { saved, error, testing, testResult, submit, runTest } = useIntegrationConfigForm();
  const [testTicketId, setTestTicketId] = useState('');
  const [detectResult, setDetectResult] = useState<string | null>(null);

  const effectiveProvider = (provider === '' ? data?.provider : provider) as
    | IssueTrackerProvider
    | 'disabled'
    | null
    | undefined;
  const hints =
    effectiveProvider && effectiveProvider !== 'disabled'
      ? PROVIDER_HINTS[effectiveProvider]
      : null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const body: IssueTrackerConfigInput = {};
    if (provider) {
      body.provider = provider === 'disabled' ? null : provider;
    }
    if (baseUrl) {
      body.baseUrl = baseUrl;
    }
    if (allowPrivateNetwork !== undefined) {
      body.allowPrivateNetwork = allowPrivateNetwork;
    }
    if (email) {
      body.email = email;
    }
    if (apiToken) {
      body.apiToken = apiToken;
    }
    if (storyPointsFieldId) {
      body.storyPointsFieldId = storyPointsFieldId;
    }
    if (epicIssueType) {
      body.epicIssueType = epicIssueType;
    }
    if (storyIssueType) {
      body.storyIssueType = storyIssueType;
    }
    if (defaultProjectKey) {
      body.defaultProjectKey = defaultProjectKey;
    }
    if (webhookSecret) {
      body.webhookSecret = webhookSecret;
    }
    if (webhookTriggerStatus) {
      body.webhookTriggerStatus = webhookTriggerStatus;
    }

    submit(
      () => update.mutateAsync(body),
      () => {
        setApiToken('');
        setWebhookSecret('');
      }
    );
  };

  const handleTest = () => {
    runTest(() => testIssueTrackerConnection(testTicketId.trim()));
  };

  if (isLoading) {
    return <LoadingState />;
  }

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <Card>
        <CardHeader>
          <CardTitle eyebrow="Issue tracker">Ticket connector</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          Read-only connector that fetches the external ticket at submit time and attaches its
          title, description, status, and labels to the work request&apos;s context snapshot — so
          agents see the real ticket instead of only the pasted description. Fetch failures never
          block a submission.
        </p>
        <div className="space-y-4">
          <ConfigField
            current={data?.provider || undefined}
            id="tracker-provider"
            label="Provider"
            source={sources.provider}
          >
            <select
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs focus:border-ember-400 focus:outline-none"
              id="tracker-provider"
              onChange={(e) => {
                const v = e.target.value;
                if (
                  v === '' ||
                  v === 'disabled' ||
                  v === 'jira' ||
                  v === 'linear' ||
                  v === 'github'
                ) {
                  setProvider(v);
                }
              }}
              value={provider}
            >
              <option value="">(keep current)</option>
              <option value="disabled">Disabled</option>
              <option value="jira">Jira</option>
              <option value="linear">Linear</option>
              <option value="github">GitHub Issues</option>
            </select>
            {hints && (
              <p className="mt-1 text-[11px] text-paper-600">Ticket ID format: {hints.ticket}</p>
            )}
          </ConfigField>
          <ConfigField
            current={data?.baseUrl || undefined}
            id="tracker-base-url"
            label="Base URL"
            source={sources.baseUrl}
          >
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="tracker-base-url"
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={hints?.baseUrl ?? 'https://acme.atlassian.net'}
              value={baseUrl}
            />
          </ConfigField>
          <div>
            <div className="flex items-center gap-3">
              <input
                checked={allowPrivateNetwork ?? data?.allowPrivateNetwork ?? false}
                className="h-4 w-4 accent-ember-400"
                id="tracker-allow-private-network"
                onChange={(e) => setAllowPrivateNetwork(e.target.checked)}
                type="checkbox"
              />
              <label className="text-sm text-paper-300" htmlFor="tracker-allow-private-network">
                Allow private/internal network base URL
              </label>
            </div>
            <p className="mt-1 text-[11px] text-paper-600">
              Bypasses the SSRF guard that otherwise rejects internal/<code>.local</code>/private-IP
              base URLs. Only enable this for a trusted self-hosted instance you control — it
              reopens the server to requests against your internal network for this connector.
            </p>
          </div>
          <ConfigField
            current={data?.email || undefined}
            id="tracker-email"
            label="Email (Jira only)"
            source={sources.email}
          >
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="tracker-email"
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com (Jira basic-auth user)"
              value={email}
            />
          </ConfigField>
          <SecretInput
            current={data?.apiToken ?? null}
            id="tracker-api-token"
            label="API token"
            onChange={setApiToken}
            placeholder={hints?.token ?? 'API token'}
            source={sources.apiToken}
            value={apiToken}
          />
        </div>
      </Card>

      {effectiveProvider === 'jira' && (
        <Card>
          <CardHeader>
            <CardTitle eyebrow="Issue tracker">Jira field mapping</CardTitle>
          </CardHeader>
          <p className="mb-4 text-xs text-paper-500">
            Customize field names for your Jira configuration. Defaults work for most cloud
            instances.
          </p>
          <div className="space-y-4">
            <ConfigField
              current={data?.storyPointsFieldId || undefined}
              id="tracker-story-points"
              label="Story Points Field ID"
              source={sources.storyPointsFieldId}
            >
              <div className="flex items-center gap-2">
                <input
                  className="flex-1 rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                  id="tracker-story-points"
                  onChange={(e) => setStoryPointsFieldId(e.target.value)}
                  placeholder="story_points"
                  value={storyPointsFieldId}
                />
                <Button
                  disabled={detectFields.isPending}
                  onClick={async () => {
                    setDetectResult(null);
                    try {
                      const result = await detectFields.mutateAsync();
                      if (result.storyPointsFieldId) {
                        setStoryPointsFieldId(result.storyPointsFieldId);
                        setDetectResult(`Detected: ${result.storyPointsFieldId}`);
                      } else {
                        setDetectResult('No story points field found');
                      }
                    } catch (err) {
                      setDetectResult(errMsg(err, 'Detection failed'));
                    }
                  }}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  {detectFields.isPending ? 'Detecting…' : 'Auto-detect'}
                </Button>
              </div>
              {detectResult && <p className="mt-1 text-[11px] text-paper-400">{detectResult}</p>}
            </ConfigField>
            <ConfigField
              current={data?.epicIssueType || undefined}
              id="tracker-epic-issue-type"
              label="Epic Issue Type"
              source={sources.epicIssueType}
            >
              <input
                className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                id="tracker-epic-issue-type"
                onChange={(e) => setEpicIssueType(e.target.value)}
                placeholder="Epic"
                value={epicIssueType}
              />
            </ConfigField>
            <ConfigField
              current={data?.storyIssueType || undefined}
              id="tracker-story-issue-type"
              label="Story Issue Type"
              source={sources.storyIssueType}
            >
              <input
                className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                id="tracker-story-issue-type"
                onChange={(e) => setStoryIssueType(e.target.value)}
                placeholder="Story"
                value={storyIssueType}
              />
            </ConfigField>
            <ConfigField
              current={data?.defaultProjectKey || undefined}
              id="tracker-default-project-key"
              label="Default Project Key"
              source={sources.defaultProjectKey}
            >
              <input
                className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                id="tracker-default-project-key"
                onChange={(e) => setDefaultProjectKey(e.target.value)}
                placeholder="PROJ"
                value={defaultProjectKey}
              />
            </ConfigField>
          </div>
        </Card>
      )}

      {effectiveProvider === 'jira' && (
        <Card>
          <CardHeader>
            <CardTitle eyebrow="Issue tracker">Inbound webhooks</CardTitle>
          </CardHeader>
          <p className="mb-4 text-xs text-paper-500">
            Configure a webhook in Jira pointing to your gateway&apos;s{' '}
            <span className="font-mono text-paper-300">/api/v1/webhooks/jira</span> endpoint. Enter
            the shared secret below and set it as the webhook secret in Jira.
          </p>
          <div className="space-y-4">
            <SecretInput
              current={data?.webhookSecret ?? null}
              id="tracker-webhook-secret"
              label="Webhook secret"
              onChange={setWebhookSecret}
              placeholder="Shared secret for HMAC verification"
              source={sources.webhookSecret}
              value={webhookSecret}
            />
            <ConfigField
              current={data?.webhookTriggerStatus || undefined}
              id="tracker-webhook-trigger-status"
              label="Trigger status"
              source={sources.webhookTriggerStatus}
            >
              <input
                className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
                id="tracker-webhook-trigger-status"
                onChange={(e) => setWebhookTriggerStatus(e.target.value)}
                placeholder="Ready for Dev"
                value={webhookTriggerStatus}
              />
            </ConfigField>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle eyebrow="Issue tracker">Test connection</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          Fetches a real ticket through the saved configuration and shows its title and status.
        </p>
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label
              className="mb-1 block text-xs uppercase text-paper-500"
              htmlFor="tracker-test-ticket"
            >
              Ticket ID
            </label>
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="tracker-test-ticket"
              onChange={(e) => setTestTicketId(e.target.value)}
              placeholder={hints?.ticket ?? 'PROJ-123'}
              value={testTicketId}
            />
          </div>
          <Button
            disabled={testing || !testTicketId.trim() || !data?.provider}
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

      {saved && <p className="text-sm text-moss-400">Settings saved.</p>}
      {error && <p className="text-sm text-brick-400">{error}</p>}

      <div className="flex justify-end">
        <Button disabled={update.isPending} type="submit" variant="primary">
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
