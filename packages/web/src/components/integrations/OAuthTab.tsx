'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { LoadingState } from '@/components/ui/LoadingState';
import {
  type GoogleOAuthConfigInput,
  type OktaOAuthConfigInput,
  useGoogleOAuthConfig,
  useOktaOAuthConfig,
  useUpdateGoogleOAuthConfig,
  useUpdateOktaOAuthConfig,
} from '@/hooks/useAdminConfig';
import { useIntegrationConfigForm } from '@/hooks/useIntegrationConfigForm';
import { API_BASE } from '@/lib/config';
import { ConfigField } from './ConfigField';
import { RestartWarning } from './RestartWarning';
import { SecretInput } from './SecretInput';

/**
 * Identity-provider credentials. Google and Okta are independent providers
 * saved through separate endpoints, so each renders its own form with its own
 * submit state — saving one never posts the other's fields.
 */
export function OAuthTab() {
  return (
    <div className="space-y-10">
      <GoogleOAuthForm />
      <OktaOAuthForm />
    </div>
  );
}

const INPUT_CLASS =
  'w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none';

/** Read-only display of a provider callback URL, with a copy button. */
function CallbackUrl({ help, url }: { help: React.ReactNode; url: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs uppercase text-paper-500">OAuth callback URL</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded-sm border border-ink-700 bg-ink-900 px-3 py-1.5 font-mono text-xs text-paper-300">
          {url}
        </code>
        <CopyButton value={url} />
      </div>
      <p className="text-[11px] text-paper-600">{help}</p>
    </div>
  );
}

function GoogleOAuthForm() {
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
    return <LoadingState />;
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
              className={INPUT_CLASS}
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

          <CallbackUrl
            help={
              <>
                Add this as an Authorized redirect URI in your Google Cloud OAuth 2.0 Client
                settings. The host must match the gateway&apos;s BETTER_AUTH_URL — better-auth
                builds its redirect_uri from that value.
              </>
            }
            url={googleOauthCallback}
          />
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

function OktaOAuthForm() {
  const { data: resp, isLoading } = useOktaOAuthConfig();
  const data = resp?.data;
  const sources = resp?.sources ?? {};
  const update = useUpdateOktaOAuthConfig();

  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const { saved, error, requiresRestart, submit } = useIntegrationConfigForm();

  // Okta registers through better-auth's generic-OAuth plugin, which exposes
  // its providers on the same `/callback/{providerId}` path as the built-ins.
  const oktaCallback = `${API_BASE}/api/auth/callback/okta`;
  // Shown so an admin can verify the discovery URL the gateway will fetch at
  // startup before saving a typo'd issuer.
  const discoveryUrl = issuer
    ? `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`
    : data?.issuer
      ? `${data.issuer}/.well-known/openid-configuration`
      : null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const body: OktaOAuthConfigInput = {};
    if (issuer) {
      body.issuer = issuer;
    }
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
    return <LoadingState />;
  }

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <Card>
        <CardHeader>
          <CardTitle eyebrow="Okta · enterprise SSO">Sign in with Okta</CardTitle>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          Enables &quot;Continue with Okta&quot; on the login page. All three fields are required —
          the button stays hidden until the issuer, client ID and client secret are all present. A
          gateway restart is required after changing these values, because the OIDC discovery
          document is fetched once at startup.
        </p>
        <div className="space-y-4">
          <div>
            <ConfigField
              current={data?.issuer || undefined}
              id="okta-issuer"
              label="Issuer URL"
              source={sources.issuer}
            >
              <input
                className={INPUT_CLASS}
                id="okta-issuer"
                onChange={(e) => setIssuer(e.target.value)}
                placeholder="https://dev-12345.okta.com/oauth2/default"
                value={issuer}
              />
            </ConfigField>
            <p className="mt-1 text-[11px] text-paper-600">
              The authorization server, not the org URL — copy it from Okta&apos;s{' '}
              <span className="font-mono">Security → API → Authorization Servers</span> table. Must
              be a public HTTPS URL: the gateway fetches its discovery document server-side, so
              private and loopback addresses are rejected.
            </p>
          </div>
          <ConfigField
            current={data?.clientId || undefined}
            id="okta-client-id"
            label="Client ID"
            source={sources.clientId}
          >
            <input
              className={INPUT_CLASS}
              id="okta-client-id"
              onChange={(e) => setClientId(e.target.value)}
              placeholder="0oa1a2b3c4D5e6F7g8h9"
              value={clientId}
            />
          </ConfigField>
          <SecretInput
            current={data?.clientSecret ?? null}
            id="okta-client-secret"
            label="Client secret"
            onChange={setClientSecret}
            source={sources.clientSecret}
            value={clientSecret}
          />

          <CallbackUrl
            help={
              <>
                Add this as a Sign-in redirect URI on the Okta application. The host must match the
                gateway&apos;s BETTER_AUTH_URL — better-auth builds its redirect_uri from that
                value.
              </>
            }
            url={oktaCallback}
          />

          {discoveryUrl && (
            <div className="space-y-1">
              <div className="text-xs uppercase text-paper-500">Discovery URL</div>
              <code className="block rounded-sm border border-ink-700 bg-ink-900 px-3 py-1.5 font-mono text-xs text-paper-300">
                {discoveryUrl}
              </code>
              <p className="text-[11px] text-paper-600">
                Fetched by the gateway at startup. Open it in a browser to confirm it returns JSON
                before restarting.
              </p>
            </div>
          )}
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
