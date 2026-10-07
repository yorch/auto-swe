'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import {
  type SlackConfigInput,
  testSlackConnection,
  useSlackConfig,
  useUpdateSlackConfig,
} from '@/hooks/useAdminConfig';
import { useIntegrationConfigForm } from '@/hooks/useIntegrationConfigForm';
import { usePrefilledField } from '@/hooks/usePrefilledField';
import { useSlackWorkspaces } from '@/hooks/useSlackChannels';
import { API_BASE } from '@/lib/config';
import { clearableField, countChanges } from '@/lib/configFieldPatch';
import { ConfigField } from './ConfigField';
import { ConfigStatusBadge, fieldState, groupState } from './ConfigStatusBadge';
import { FieldGrid, IntegrationCard } from './IntegrationCard';
import { IntegrationFormFooter, TestResultAlert } from './IntegrationFormFooter';
import { SecretInput } from './SecretInput';
import { UrlRow } from './UrlRow';

interface SlackTabProps {
  /** Workspace id from the install callback's `?slack_installed=` redirect, if any. */
  installedTeamId: string | null;
}

export function SlackTab({ installedTeamId }: SlackTabProps) {
  const {
    data: resp,
    error: loadError,
    isError,
    isFetching,
    refetch,
    isLoading,
  } = useSlackConfig();
  const data = resp?.data;
  const sources = resp?.sources ?? {};
  const update = useUpdateSlackConfig();

  const [botToken, setBotToken] = useState('');
  const [clientId, setClientId] = usePrefilledField(data?.clientId);
  const [clientSecret, setClientSecret] = useState('');
  const [signingSecret, setSigningSecret] = useState('');

  // What Save would send: omitted keys are unchanged, so their count is the unsaved edits.
  const body: SlackConfigInput = {
    botToken: botToken || undefined,
    // Prefilled: omit when unchanged, send null when cleared.
    clientId: clearableField(clientId, data?.clientId),
    clientSecret: clientSecret || undefined,
    signingSecret: signingSecret || undefined,
  };
  const dirtyCount = countChanges(body);

  const { saved, error, testing, testResult, submit, runTest } =
    useIntegrationConfigForm(dirtyCount);

  const slackRedirectUri = `${API_BASE}/api/auth/slack/callback`;
  const slackEventUrl = `${API_BASE}/api/v1/webhooks/slack/events`;
  const slackInteractivityUrl = `${API_BASE}/api/v1/webhooks/slack/interactivity`;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    submit(
      () => update.mutateAsync(body),
      () => {
        setBotToken('');
        setClientSecret('');
        setSigningSecret('');
      }
    );
  };

  const handleTest = () => {
    // Only the bot token matters to the probe; a blank field tests the stored one.
    const unsaved = botToken !== '';
    runTest(async () => ({
      ...(await testSlackConnection(unsaved ? { botToken } : {})),
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
        label="Slack config"
        onRetry={() => void refetch()}
      />
    );
  }

  const credentialsState = groupState([
    fieldState(data?.clientId, sources.clientId),
    fieldState(data?.clientSecret, sources.clientSecret),
    fieldState(data?.signingSecret, sources.signingSecret),
    fieldState(data?.botToken, sources.botToken),
  ]);

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <IntegrationCard
        description="Changes apply immediately: these are read on every request, not at startup."
        eyebrow="Slack"
        footer={
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-paper-500">
                Checks the bot token on screen, or the saved one if the field is blank.
              </p>
              <Button
                disabled={testing || (!data?.botToken && !botToken)}
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
        status={<ConfigStatusBadge state={credentialsState} />}
        title="App credentials"
      >
        <FieldGrid>
          <ConfigField
            current={data?.clientId || undefined}
            id="slack-client-id"
            label="Client ID"
            source={sources.clientId}
          >
            <Input
              className="font-mono"
              compact
              id="slack-client-id"
              onChange={(e) => setClientId(e.target.value)}
              placeholder="1234567890.123456789012"
              value={clientId}
            />
          </ConfigField>
          <SecretInput
            clear={{ field: 'clientSecret', integration: 'slack' }}
            current={data?.clientSecret ?? null}
            id="slack-client-secret"
            label="Client secret"
            onChange={setClientSecret}
            source={sources.clientSecret}
            value={clientSecret}
          />
          <SecretInput
            clear={{ field: 'signingSecret', integration: 'slack' }}
            current={data?.signingSecret ?? null}
            id="slack-signing-secret"
            label="Signing secret"
            onChange={setSigningSecret}
            source={sources.signingSecret}
            value={signingSecret}
          />
          <SecretInput
            clear={{ field: 'botToken', integration: 'slack' }}
            current={data?.botToken ?? null}
            id="slack-bot-token"
            label="Bot token"
            onChange={setBotToken}
            placeholder="xoxb-..."
            source={sources.botToken}
            value={botToken}
          />
        </FieldGrid>
      </IntegrationCard>

      <WorkspaceInstallCard installedTeamId={installedTeamId} />

      <IntegrationCard
        description="Add these in your Slack App settings under OAuth & Permissions and Event Subscriptions."
        eyebrow="Slack App"
        title="URLs to register"
      >
        <div className="space-y-3">
          <UrlRow label="OAuth redirect URI" url={slackRedirectUri} />
          <UrlRow label="Event subscriptions" url={slackEventUrl} />
          <UrlRow label="Interactivity" url={slackInteractivityUrl} />
        </div>
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

/**
 * Multi-workspace install (Full multi-workspace): "Add to Slack" launches the
 * bot-install OAuth flow, which captures a per-workspace bot token. The list
 * below shows which workspaces have completed install (own token) vs. those
 * still on the singleton fallback. Standalone card (not part of the credentials
 * form) so navigating to the install endpoint doesn't trip the form submit.
 */
function WorkspaceInstallCard({ installedTeamId }: SlackTabProps) {
  const {
    data: workspaces,
    error: workspacesError,
    isError: workspacesIsError,
    isFetching: workspacesIsFetching,
    isLoading,
    refetch,
  } = useSlackWorkspaces();

  const addButton = (
    <ButtonLink href={`${API_BASE}/api/v1/auth/slack/install`} size="sm" variant="secondary">
      <Icon name="plus" size={14} />
      Add to Slack
    </ButtonLink>
  );

  return (
    <IntegrationCard
      description="Install the app into each Slack workspace to give it its own bot token. Workspaces without their own token fall back to the singleton bot token above."
      eyebrow="Slack App"
      headerAction={addButton}
      title="Workspaces"
    >
      {installedTeamId && (
        <Alert className="mb-4" variant="success">
          Installed into workspace <span className="font-mono">{installedTeamId}</span>.
        </Alert>
      )}

      {isLoading ? (
        <SkeletonRows rows={2} />
      ) : workspacesIsError ? (
        <QueryBoundary
          error={workspacesError}
          isError
          isFetching={workspacesIsFetching}
          isLoading={false}
          label="workspaces"
          onRetry={() => void refetch()}
        />
      ) : !workspaces || workspaces.length === 0 ? (
        <EmptyState
          bordered
          className="py-6"
          hint="Use Add to Slack to install the app into a workspace."
          icon="chat"
          title="No workspaces yet"
        />
      ) : (
        <ul className="divide-y divide-ink-600 rounded-lg border border-ink-500/60">
          {workspaces.map((w) => (
            <li
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
              key={w.workspaceId}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-paper-100">
                  {w.name ?? w.slackTeamId}
                </div>
                <div className="text-xs text-paper-500">
                  <span className="font-mono">{w.slackTeamId}</span> · {w.channelCount} channel
                  {w.channelCount === 1 ? '' : 's'}
                </div>
              </div>
              {w.installed ? (
                <Badge dot tone="moss">
                  Installed{w.tokenLastFour ? ` · …${w.tokenLastFour}` : ''}
                </Badge>
              ) : (
                <Badge tone="muted">Singleton fallback</Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </IntegrationCard>
  );
}
