'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  type SlackConfigInput,
  testSlackConnection,
  useSlackConfig,
  useUpdateSlackConfig,
} from '@/hooks/useAdminConfig';
import { useSlackWorkspaces } from '@/hooks/useSlackChannels';
import { API_BASE } from '@/lib/config';
import { RestartWarning } from './RestartWarning';
import { SecretInput } from './SecretInput';
import { SourceBadge } from './SourceBadge';
import { UrlRow } from './UrlRow';

function errMsg(err: unknown, fallback = 'Request failed'): string {
  return err instanceof Error ? err.message : fallback;
}

export function SlackTab() {
  const { data: resp, isLoading } = useSlackConfig();
  const data = resp?.data;
  const sources = resp?.sources ?? {};
  const update = useUpdateSlackConfig();

  const [botToken, setBotToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [signingSecret, setSigningSecret] = useState('');

  const [saved, setSaved] = useState(false);
  const [requiresRestart, setRequiresRestart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);

  const slackRedirectUri = `${API_BASE}/api/auth/slack/callback`;
  const slackEventUrl = `${API_BASE}/api/v1/webhooks/slack/events`;
  const slackInteractivityUrl = `${API_BASE}/api/v1/webhooks/slack/interactivity`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setRequiresRestart(false);
    setTestResult(null);

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

    try {
      const res = await update.mutateAsync(body);
      setSaved(true);
      setRequiresRestart(!!res.data.requiresRestart);
      setBotToken('');
      setClientSecret('');
      setSigningSecret('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testSlackConnection();
      setTestResult(res);
    } catch (err) {
      setTestResult({ detail: errMsg(err), ok: false });
    } finally {
      setTesting(false);
    }
  };

  if (isLoading) {
    return <p className="text-sm text-paper-400">Loading…</p>;
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
          <div>
            <label
              className="mb-1 flex items-center gap-2 text-xs uppercase text-paper-500"
              htmlFor="slack-client-id"
            >
              Client ID
              <SourceBadge source={sources.clientId} />
              {data?.clientId && (
                <span className="font-mono text-[10px] normal-case tracking-normal text-paper-400">
                  current: {data.clientId}
                </span>
              )}
            </label>
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="slack-client-id"
              onChange={(e) => setClientId(e.target.value)}
              placeholder="1234567890.123456789012"
              value={clientId}
            />
          </div>
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

        {testResult && (
          <p className={`mt-2 text-sm ${testResult.ok ? 'text-emerald-400' : 'text-brick-400'}`}>
            {testResult.ok ? '✓' : '✗'} {testResult.detail}
          </p>
        )}
      </Card>

      <WorkspaceInstallCard />

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

/**
 * Multi-workspace install (Full multi-workspace): "Add to Slack" launches the
 * bot-install OAuth flow, which captures a per-workspace bot token. The list
 * below shows which workspaces have completed install (own token) vs. those
 * still on the singleton fallback. Standalone card (not part of the credentials
 * form) so navigating to the install endpoint doesn't trip the form submit.
 */
function WorkspaceInstallCard() {
  const { data: workspaces, isLoading } = useSlackWorkspaces();
  // Success flag set by the install callback redirect (`?slack_installed=<teamId>`).
  const installedTeamId =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('slack_installed')
      : null;

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
        <p className="mb-4 text-sm text-emerald-400">
          ✓ Installed into workspace <span className="font-mono">{installedTeamId}</span>.
        </p>
      )}

      <div className="mb-4">
        <a
          className="inline-block rounded-sm bg-ember-500 px-4 py-2 text-sm font-medium text-ink-950 hover:bg-ember-400"
          href={`${API_BASE}/api/v1/auth/slack/install`}
        >
          Add to Slack
        </a>
      </div>

      {isLoading ? (
        <p className="text-sm text-paper-400">Loading workspaces…</p>
      ) : !workspaces || workspaces.length === 0 ? (
        <p className="text-sm text-paper-500">No workspaces yet.</p>
      ) : (
        <div className="space-y-2">
          {workspaces.map((w) => (
            <div
              className="flex items-center justify-between rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 text-xs"
              key={w.workspaceId}
            >
              <div className="flex flex-col">
                <span className="font-mono text-paper-300">{w.name ?? w.slackTeamId}</span>
                <span className="font-mono text-[10px] text-paper-500">
                  {w.slackTeamId} · {w.channelCount} channel{w.channelCount === 1 ? '' : 's'}
                </span>
              </div>
              {w.installed ? (
                <span className="text-emerald-400">
                  Installed{w.tokenLastFour ? ` · …${w.tokenLastFour}` : ''}
                </span>
              ) : (
                <span className="text-paper-500">Singleton fallback</span>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
