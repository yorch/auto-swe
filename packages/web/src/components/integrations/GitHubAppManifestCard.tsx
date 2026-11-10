'use client';

import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { DocLink } from '@/components/ui/DocLink';
import { Input } from '@/components/ui/Input';
import { useUpdateGitHubConfig } from '@/hooks/useAdminConfig';
import { api } from '@/lib/api';
import { HELP_LINKS } from '@/lib/helpLinks';
import { ConfigField } from './ConfigField';
import { FieldGrid, IntegrationCard } from './IntegrationCard';

/** What the gateway answers: the GitHub URL to post to, and the manifest to post. */
interface ManifestStart {
  data: { action: string; manifest: Record<string, unknown> };
}

/** The fixed codes the callback lands on this page with, in words. */
const CALLBACK_ERRORS: Record<string, string> = {
  APP_ALREADY_CONFIGURED: 'A GitHub App was configured while the flow was open; nothing changed.',
  CODE_REJECTED: 'GitHub refused the code: it expired or was already used. Start again.',
  FORBIDDEN: 'Only an active platform admin can finish creating the App.',
  GITHUB_MALFORMED: 'GitHub answered without a usable App; nothing was stored.',
  GITHUB_UNREACHABLE: 'GitHub could not be reached to finish creating the App. Start again.',
  HOST_CHANGED: 'The GitHub host changed while the flow was open; nothing was stored.',
  INVALID_CALLBACK: 'GitHub returned without a code. The App was not created.',
  INVALID_STATE: 'The flow expired or was not started here. Start again.',
  STATE_MISMATCH: 'The flow was started in another browser. Start it again here.',
};

const NUMERIC = /^[0-9]{1,20}$/;

/**
 * Create the instance's GitHub App from a manifest. GitHub only accepts a manifest as a browser
 * form post, so the gateway builds it (with a signed state) and this card submits the form.
 */
export function GitHubAppManifestCard({
  appConfigured,
  installationId,
}: {
  appConfigured: boolean;
  installationId: string | null;
}) {
  const params = useSearchParams();
  const update = useUpdateGitHubConfig();
  const [org, setOrg] = useState('');
  const [name, setName] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const callbackError = params.get('github_app_error');
  const warning = params.get('github_app_warning');
  // GitHub appends these to the App's setup URL after an install.
  const installedId = params.get('installation_id');
  const offerInstallation =
    installedId !== null && NUMERIC.test(installedId) && installedId !== installationId;

  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const { data } = await api.post<ManifestStart>('/api/v1/integrations/github-app-manifest', {
        ...(org.trim() ? { org: org.trim() } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      const form = document.createElement('form');
      form.method = 'post';
      form.action = data.action;
      const field = document.createElement('input');
      field.type = 'hidden';
      field.name = 'manifest';
      field.value = JSON.stringify(data.manifest);
      form.appendChild(field);
      document.body.appendChild(form);
      form.submit();
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Could not start the flow');
      setStarting(false);
    }
  };

  const notices = (
    <>
      {callbackError && (
        <Alert className="mb-4" title="The GitHub App was not created">
          {CALLBACK_ERRORS[callbackError] ?? 'The flow did not finish. Start again.'}
        </Alert>
      )}
      {warning === 'WEBHOOK_SECRET_UNALIGNED' && (
        <Alert className="mb-4" title="App created; webhook secret not set" variant="warning">
          The App is stored, but GitHub did not accept the instance webhook secret for it, so its
          deliveries will not verify. Set the App&apos;s webhook secret on GitHub to the one saved
          here, then install the App from its settings page.
        </Alert>
      )}
      {offerInstallation && (
        <Alert
          action={
            <Button
              disabled={update.isPending}
              onClick={() => update.mutate({ appInstallationId: installedId })}
              size="sm"
              type="button"
              variant="secondary"
            >
              {update.isSuccess ? 'Saved' : 'Save installation ID'}
            </Button>
          }
          className="mb-4"
          title="GitHub App installed"
          variant="success"
        >
          GitHub reports installation <span className="font-mono">{installedId}</span>. Save it as
          the App&apos;s installation ID to use the App for repository access.
        </Alert>
      )}
    </>
  );

  if (appConfigured) {
    return callbackError || warning || offerInstallation ? notices : null;
  }

  return (
    <IntegrationCard
      description={
        <>
          Register a new GitHub App on the configured GitHub host with the permissions, events and
          webhook the platform needs. Its credentials are stored here; you then install it on
          GitHub. See the <DocLink label="GitHub App setup guide" {...HELP_LINKS.githubAppSetup} />.
        </>
      }
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-paper-500">
            You confirm the App on GitHub, then return here through its installation page.
          </p>
          <Button disabled={starting} onClick={() => void start()} type="button">
            {starting ? 'Opening GitHub…' : 'Create GitHub App'}
          </Button>
        </div>
      }
      title="Create a GitHub App"
    >
      {notices}
      {startError && (
        <Alert className="mb-4" title="Could not start">
          {startError}
        </Alert>
      )}
      <FieldGrid>
        <ConfigField
          hint="Leave blank to create the App on your personal account."
          id="gh-manifest-org"
          label="Organization (optional)"
        >
          <Input
            className="font-mono"
            compact
            id="gh-manifest-org"
            onChange={(e) => setOrg(e.target.value)}
            placeholder="acme"
            value={org}
          />
        </ConfigField>
        <ConfigField
          hint="Must be unique on the GitHub host; at most 34 characters."
          id="gh-manifest-name"
          label="App name"
        >
          <Input
            compact
            id="gh-manifest-name"
            onChange={(e) => setName(e.target.value)}
            placeholder="auto-swe"
            value={name}
          />
        </ConfigField>
      </FieldGrid>
    </IntegrationCard>
  );
}
