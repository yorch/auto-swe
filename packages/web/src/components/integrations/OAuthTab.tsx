'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import {
  type GoogleOAuthConfigInput,
  useGoogleOAuthConfig,
  useUpdateGoogleOAuthConfig,
} from '@/hooks/useAdminConfig';
import { useIntegrationConfigForm } from '@/hooks/useIntegrationConfigForm';
import { API_BASE } from '@/lib/config';
import { ConfigField } from './ConfigField';
import { RestartWarning } from './RestartWarning';
import { SecretInput } from './SecretInput';

export function OAuthTab() {
  const { data: resp, isLoading } = useGoogleOAuthConfig();
  const data = resp?.data;
  const sources = resp?.sources ?? {};
  const update = useUpdateGoogleOAuthConfig();

  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const { saved, error, requiresRestart, submit } = useIntegrationConfigForm();

  // better-auth's social-provider callback convention: {basePath}/callback/{providerId}
  const googleOauthCallback = `${API_BASE}/api/auth/callback/google`;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const body: GoogleOAuthConfigInput = {};
    if (clientId) {
      body.clientId = clientId;
    }
    if (clientSecret) {
      body.clientSecret = clientSecret;
    }
    submit(
      () => update.mutateAsync(body),
      () => setClientSecret('')
    );
  };

  if (isLoading) {
    return <p className="text-sm text-paper-400">Loading…</p>;
  }

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <Card>
        <CardHeader>
          <CardTitle eyebrow="Google OAuth">Sign in with Google</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          Enables &quot;Sign in with Google&quot; on the login page. A gateway restart is required
          after changing these values.
        </p>
        <div className="space-y-4">
          <ConfigField
            current={data?.clientId || undefined}
            id="google-client-id"
            label="Client ID"
            source={sources.clientId}
          >
            <input
              className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
              id="google-client-id"
              onChange={(e) => setClientId(e.target.value)}
              placeholder="123456789012-abcdefgh.apps.googleusercontent.com"
              value={clientId}
            />
          </ConfigField>
          <SecretInput
            current={data?.clientSecret ?? null}
            id="google-client-secret"
            label="Client secret"
            onChange={setClientSecret}
            source={sources.clientSecret}
            value={clientSecret}
          />

          <div className="space-y-1">
            <div className="text-xs uppercase text-paper-500">OAuth callback URL</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-sm border border-ink-700 bg-ink-900 px-3 py-1.5 font-mono text-xs text-paper-300">
                {googleOauthCallback}
              </code>
              <CopyButton value={googleOauthCallback} />
            </div>
            <p className="text-[11px] text-paper-600">
              Add this as an Authorized redirect URI in your Google Cloud OAuth 2.0 Client settings.
              The host must match the gateway&apos;s BETTER_AUTH_URL — better-auth builds its
              redirect_uri from that value.
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
