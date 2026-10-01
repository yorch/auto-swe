'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import {
  type SlackConfigInput,
  testSlackConnection,
  useSlackConfig,
  useUpdateSlackConfig,
} from '@/hooks/useAdminConfig';
import { useIntegrationConfigForm } from '@/hooks/useIntegrationConfigForm';
import { useSlackWorkspaces } from '@/hooks/useSlackChannels';
import { API_BASE } from '@/lib/config';
import { ConfigField } from './ConfigField';
import { IntegrationFormFooter, TestResultAlert } from './IntegrationFormFooter';
import { SecretInput } from './SecretInput';
import { UrlRow } from './UrlRow';

interface SlackTabProps {
  /** Workspace id from the install callback's `?slack_installed=` redirect, if any. */
  installedTeamId: string | null;
}

export function SlackTab({ installedTeamId }: SlackTabProps) {
  const { data: resp, error: loadError, isError, isLoading } = useSlackConfig();
  const data = resp?.data;
  const sources = resp?.sources ?? {};
  const update = useUpdateSlackConfig();

  const [botToken, setBotToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [signingSecret, setSigningSecret] = useState('');

  const { saved, requiresRestart, error, testing, testResult, submit, runTest } =
    useIntegrationConfigForm();

  const slackRedirectUri = `${API_BASE}/api/auth/slack/callback`;
  const slackEventUrl = `${API_BASE}/api/v1/webhooks/slack/events`;
  const slackInteractivityUrl = `${API_BASE}/api/v1/webhooks/slack/interactivity`;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

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
    runTest(() => testSlackConnection());
  };

  if (isLoading || isError) {
    return (
      <QueryBoundary
        error={loadError}
        isError={isError}
        isLoading={isLoading}
        label="Slack config"
      />
    );
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
          <ConfigField
            current={data?.clientId || undefined}
            id="slack-client-id"
            label="Client ID"
            source={sources.clientId}
          >
            <Input
              compact
              id="slack-client-id"
              onChange={(e) => setClientId(e.target.value)}
              placeholder="1234567890.123456789012"
              value={clientId}
            />
          </ConfigField>
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
            disabled={testing || (!data?.botToken && !botToken)}
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

      <WorkspaceInstallCard installedTeamId={installedTeamId} />

      <Card>
        <CardHeader>
          <CardTitle eyebrow="Slack App">URLs to register</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          Add these in your Slack App settings under OAuth &amp; Permissions / Event Subscriptions.
        </p>
        <div className="space-y-3">
          <UrlRow label="OAuth redirect URI" url={slackRedirectUri} />
          <UrlRow label="Event subscriptions" url={slackEventUrl} />
          <UrlRow label="Interactivity" url={slackInteractivityUrl} />
        </div>
      </Card>

      <IntegrationFormFooter
        error={error}
        isPending={update.isPending}
        requiresRestart={requiresRestart}
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
    isLoading,
  } = useSlackWorkspaces();

  return (
    <Card>
      <CardHeader>
        <CardTitle eyebrow="Slack App">Workspaces</CardTitle>
      </CardHeader>
      <p className="mb-4 text-xs text-paper-500">
        Install the app into each Slack workspace to give it its own bot token. Workspaces without
        their own token fall back to the singleton bot token above.
      </p>

      {installedTeamId && (
        <Alert className="mb-4" variant="success">
          Installed into workspace <span className="font-mono">{installedTeamId}</span>.
        </Alert>
      )}

      <div className="mb-4">
        <ButtonLink href={`${API_BASE}/api/v1/auth/slack/install`} variant="primary">
          Add to Slack
        </ButtonLink>
      </div>

      {isLoading ? (
        <LoadingState compact message="loading workspaces…" />
      ) : workspacesIsError ? (
        <QueryBoundary error={workspacesError} isError isLoading={false} label="workspaces" />
      ) : !workspaces || workspaces.length === 0 ? (
        <EmptyState className="py-0 text-left text-paper-500" title="No workspaces yet." />
      ) : (
        <div className="space-y-2">
          {workspaces.map((w) => (
            <Card
              className="flex items-center justify-between px-3 py-2 text-xs"
              key={w.workspaceId}
              variant="inset"
            >
              <div className="flex flex-col">
                <span className="font-mono text-paper-300">{w.name ?? w.slackTeamId}</span>
                <span className="font-mono text-[10px] text-paper-500">
                  {w.slackTeamId} · {w.channelCount} channel{w.channelCount === 1 ? '' : 's'}
                </span>
              </div>
              {w.installed ? (
                <Badge tone="moss">
                  Installed{w.tokenLastFour ? ` · …${w.tokenLastFour}` : ''}
                </Badge>
              ) : (
                <Badge tone="muted">Singleton fallback</Badge>
              )}
            </Card>
          ))}
        </div>
      )}
    </Card>
  );
}
