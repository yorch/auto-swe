'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import {
  type IssueTrackerConfigInput,
  type IssueTrackerProvider,
  testIssueTrackerConnection,
  useDetectJiraFields,
  useIssueTrackerConfig,
  useUpdateIssueTrackerConfig,
} from '@/hooks/useAdminConfig';
import { useIntegrationConfigForm } from '@/hooks/useIntegrationConfigForm';
import { usePrefilledField } from '@/hooks/usePrefilledField';
import { clearableField } from '@/lib/configFieldPatch';
import { errMsg } from '@/lib/errors';
import { ConfigField } from './ConfigField';
import { IntegrationFormFooter, TestResultAlert } from './IntegrationFormFooter';
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
  const { data: resp, error: loadError, isError, isLoading } = useIssueTrackerConfig();
  const data = resp?.data;
  const sources = resp?.sources ?? {};
  const update = useUpdateIssueTrackerConfig();

  const [provider, setProvider] = useState<'' | 'disabled' | IssueTrackerProvider>('');
  const [baseUrl, setBaseUrl] = usePrefilledField(data?.baseUrl);
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState<boolean | undefined>(undefined);
  const [email, setEmail] = usePrefilledField(data?.email);
  const [apiToken, setApiToken] = useState('');
  const [storyPointsFieldId, setStoryPointsFieldId] = usePrefilledField(data?.storyPointsFieldId);
  const [epicIssueType, setEpicIssueType] = usePrefilledField(data?.epicIssueType);
  const [storyIssueType, setStoryIssueType] = usePrefilledField(data?.storyIssueType);
  const [defaultProjectKey, setDefaultProjectKey] = usePrefilledField(data?.defaultProjectKey);
  const [webhookSecret, setWebhookSecret] = useState('');
  const [webhookTriggerStatus, setWebhookTriggerStatus] = usePrefilledField(
    data?.webhookTriggerStatus
  );

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
    // Non-secret fields are prefilled: omit when unchanged, send null when cleared.
    body.baseUrl = clearableField(baseUrl, data?.baseUrl);
    if (allowPrivateNetwork !== undefined) {
      body.allowPrivateNetwork = allowPrivateNetwork;
    }
    body.email = clearableField(email, data?.email);
    if (apiToken) {
      body.apiToken = apiToken;
    }
    body.storyPointsFieldId = clearableField(storyPointsFieldId, data?.storyPointsFieldId);
    body.epicIssueType = clearableField(epicIssueType, data?.epicIssueType);
    body.storyIssueType = clearableField(storyIssueType, data?.storyIssueType);
    body.defaultProjectKey = clearableField(defaultProjectKey, data?.defaultProjectKey);
    if (webhookSecret) {
      body.webhookSecret = webhookSecret;
    }
    body.webhookTriggerStatus = clearableField(webhookTriggerStatus, data?.webhookTriggerStatus);

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

  if (isLoading || isError) {
    return (
      <QueryBoundary
        error={loadError}
        isError={isError}
        isLoading={isLoading}
        label="issue tracker config"
      />
    );
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
            <Select
              aria-label="Provider"
              compact
              id="tracker-provider"
              onChange={(v) => {
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
              options={[
                { label: '(keep current)', value: '' },
                { label: 'Disabled', value: 'disabled' },
                { label: 'Jira', value: 'jira' },
                { label: 'Linear', value: 'linear' },
                { label: 'GitHub Issues', value: 'github' },
              ]}
              value={provider}
            />
            {hints && (
              <p className="text-[11px] text-paper-600">Ticket ID format: {hints.ticket}</p>
            )}
          </ConfigField>
          <ConfigField
            current={data?.baseUrl || undefined}
            id="tracker-base-url"
            label="Base URL"
            source={sources.baseUrl}
          >
            <Input
              compact
              id="tracker-base-url"
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={hints?.baseUrl ?? 'https://acme.atlassian.net'}
              value={baseUrl}
            />
          </ConfigField>
          <Checkbox
            checked={allowPrivateNetwork ?? data?.allowPrivateNetwork ?? false}
            hint={
              <>
                Allows a base URL on a private-network address (internal, <code>.local</code>,
                private IP). Loopback, link-local and cloud-metadata addresses are always refused;
                use the host's LAN address or <code>host.docker.internal</code> instead. Only enable
                this for a trusted self-hosted instance you control.
              </>
            }
            id="tracker-allow-private-network"
            label="Allow private/internal network base URL"
            onChange={(e) => setAllowPrivateNetwork(e.target.checked)}
          />
          <ConfigField
            current={data?.email || undefined}
            id="tracker-email"
            label="Email (Jira only)"
            source={sources.email}
          >
            <Input
              compact
              id="tracker-email"
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com (Jira basic-auth user)"
              value={email}
            />
          </ConfigField>
          <SecretInput
            clear={{ field: 'apiToken', integration: 'issue-tracker' }}
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
                <div className="flex-1">
                  <Input
                    compact
                    id="tracker-story-points"
                    onChange={(e) => setStoryPointsFieldId(e.target.value)}
                    placeholder="story_points"
                    value={storyPointsFieldId}
                  />
                </div>
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
              {detectResult && <p className="text-[11px] text-paper-400">{detectResult}</p>}
            </ConfigField>
            <ConfigField
              current={data?.epicIssueType || undefined}
              id="tracker-epic-issue-type"
              label="Epic Issue Type"
              source={sources.epicIssueType}
            >
              <Input
                compact
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
              <Input
                compact
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
              <Input
                compact
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
              clear={{ field: 'webhookSecret', integration: 'issue-tracker' }}
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
              <Input
                compact
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
            <Input
              compact
              id="tracker-test-ticket"
              label="Ticket ID"
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
        <TestResultAlert result={testResult} />
      </Card>

      <IntegrationFormFooter error={error} isPending={update.isPending} saved={saved} />
    </form>
  );
}
