'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import {
  type IssueTrackerConfigInput,
  type IssueTrackerProvider,
  type IssueTrackerTestDraft,
  testIssueTrackerConnection,
  useDetectJiraFields,
  useIssueTrackerConfig,
  useUpdateIssueTrackerConfig,
} from '@/hooks/useAdminConfig';
import { useIntegrationConfigForm } from '@/hooks/useIntegrationConfigForm';
import { usePrefilledField } from '@/hooks/usePrefilledField';
import { API_BASE } from '@/lib/config';
import { clearableField, countChanges } from '@/lib/configFieldPatch';
import { errMsg } from '@/lib/errors';
import { ConfigField } from './ConfigField';
import { ConfigStatusBadge, fieldState, groupState } from './ConfigStatusBadge';
import { FieldGrid, IntegrationCard } from './IntegrationCard';
import { IntegrationFormFooter, TestResultAlert } from './IntegrationFormFooter';
import { SecretInput } from './SecretInput';
import { UrlRow } from './UrlRow';

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
  const {
    data: resp,
    error: loadError,
    isError,
    isFetching,
    refetch,
    isLoading,
  } = useIssueTrackerConfig();
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

  // What Save would send: omitted keys are unchanged, so their count is the unsaved edits.
  // Non-secret fields are prefilled: omit when unchanged, send null when cleared.
  const body: IssueTrackerConfigInput = {
    allowPrivateNetwork:
      allowPrivateNetwork === data?.allowPrivateNetwork ? undefined : allowPrivateNetwork,
    apiToken: apiToken || undefined,
    baseUrl: clearableField(baseUrl, data?.baseUrl),
    defaultProjectKey: clearableField(defaultProjectKey, data?.defaultProjectKey),
    email: clearableField(email, data?.email),
    epicIssueType: clearableField(epicIssueType, data?.epicIssueType),
    storyIssueType: clearableField(storyIssueType, data?.storyIssueType),
    storyPointsFieldId: clearableField(storyPointsFieldId, data?.storyPointsFieldId),
    webhookSecret: webhookSecret || undefined,
    webhookTriggerStatus: clearableField(webhookTriggerStatus, data?.webhookTriggerStatus),
  };
  if (provider && provider !== (data?.provider ?? 'disabled')) {
    body.provider = provider === 'disabled' ? null : provider;
  }
  const dirtyCount = countChanges(body);

  const { saved, error, testing, testResult, submit, runTest } =
    useIntegrationConfigForm(dirtyCount);
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

    submit(
      () => update.mutateAsync(body),
      () => {
        setApiToken('');
        setWebhookSecret('');
        setProvider('');
        setAllowPrivateNetwork(undefined);
      }
    );
  };

  const handleTest = () => {
    // Send what is on screen so the result describes what Save would store. A blank token means
    // the stored one; unchanged fields are left out.
    const draft: IssueTrackerTestDraft = {};
    if (provider) {
      draft.provider = provider === 'disabled' ? null : provider;
    }
    const baseUrlDraft = clearableField(baseUrl, data?.baseUrl);
    if (baseUrlDraft !== undefined) {
      draft.baseUrl = baseUrlDraft;
    }
    const emailDraft = clearableField(email, data?.email);
    if (emailDraft !== undefined) {
      draft.email = emailDraft;
    }
    if (apiToken) {
      draft.apiToken = apiToken;
    }
    if (allowPrivateNetwork !== undefined) {
      draft.allowPrivateNetwork = allowPrivateNetwork;
    }
    const unsaved = Object.keys(draft).length > 0;
    runTest(async () => ({
      ...(await testIssueTrackerConnection(testTicketId.trim(), draft)),
      unsaved,
    }));
  };

  if (isLoading || isError) {
    return (
      <QueryBoundary
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="issue tracker config"
        onRetry={() => void refetch()}
      />
    );
  }

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <IntegrationCard
        description="A read-only connector that fetches the external ticket at submit time and attaches its title, description, status and labels to the work request's context snapshot, so agents see the real ticket instead of only the pasted description. Fetch failures never block a submission."
        eyebrow="Issue tracker"
        status={
          data?.provider ? (
            <ConfigStatusBadge
              state={groupState([
                fieldState(data.provider, sources.provider),
                fieldState(data.apiToken, sources.apiToken),
              ])}
            />
          ) : (
            <Badge dot tone="muted" variant="outline">
              Off
            </Badge>
          )
        }
        title="Ticket connector"
      >
        <FieldGrid>
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
            {hints && <p className="text-xs text-paper-500">Ticket ID format: {hints.ticket}</p>}
          </ConfigField>
          <ConfigField
            current={data?.baseUrl || undefined}
            id="tracker-base-url"
            label="Base URL"
            source={sources.baseUrl}
          >
            <Input
              className="font-mono"
              compact
              id="tracker-base-url"
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={hints?.baseUrl ?? 'https://acme.atlassian.net'}
              value={baseUrl}
            />
          </ConfigField>
          <Checkbox
            checked={allowPrivateNetwork ?? data?.allowPrivateNetwork ?? false}
            className="sm:col-span-2"
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
        </FieldGrid>
      </IntegrationCard>

      {effectiveProvider === 'jira' && (
        <IntegrationCard
          description="Customize field names for your Jira configuration. The defaults work for most cloud instances."
          eyebrow="Jira"
          title="Field mapping"
        >
          <FieldGrid>
            <ConfigField
              current={data?.storyPointsFieldId || undefined}
              id="tracker-story-points"
              label="Story points field ID"
              source={sources.storyPointsFieldId}
            >
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <Input
                    className="font-mono"
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
              {detectResult && <p className="text-xs text-paper-400">{detectResult}</p>}
            </ConfigField>
            <ConfigField
              current={data?.epicIssueType || undefined}
              id="tracker-epic-issue-type"
              label="Epic issue type"
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
              label="Story issue type"
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
              label="Default project key"
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
          </FieldGrid>
        </IntegrationCard>
      )}

      {effectiveProvider === 'jira' && (
        <IntegrationCard
          description="Configure a webhook in Jira pointing at the endpoint below, then enter the shared secret here and set the same value as the webhook secret in Jira."
          eyebrow="Jira"
          status={
            <ConfigStatusBadge state={fieldState(data?.webhookSecret, sources.webhookSecret)} />
          }
          title="Inbound webhooks"
        >
          <div className="mb-4">
            <UrlRow label="Jira webhook" url={`${API_BASE}/api/v1/webhooks/jira`} />
          </div>
          <FieldGrid>
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
          </FieldGrid>
        </IntegrationCard>
      )}

      <IntegrationCard
        description="Fetches a real ticket through the configuration on screen, including values you have not saved yet, and shows its title and status."
        eyebrow="Issue tracker"
        title="Test connection"
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 sm:max-w-sm">
            <Input
              className="font-mono"
              compact
              id="tracker-test-ticket"
              label="Ticket ID"
              onChange={(e) => setTestTicketId(e.target.value)}
              placeholder={hints?.ticket ?? 'PROJ-123'}
              value={testTicketId}
            />
          </div>
          <Button
            disabled={
              testing ||
              !testTicketId.trim() ||
              !effectiveProvider ||
              effectiveProvider === 'disabled'
            }
            onClick={handleTest}
            type="button"
            variant="secondary"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
        </div>
        <TestResultAlert result={testResult} />
      </IntegrationCard>

      <IntegrationFormFooter
        dirtyCount={dirtyCount}
        error={error}
        isPending={update.isPending}
        saved={saved}
      />
    </form>
  );
}
