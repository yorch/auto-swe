'use client';

import { useEffect, useState } from 'react';
import { AuthHeading, AuthLayout } from '@/components/layout/AuthLayout';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { LoadingState } from '@/components/ui/LoadingState';
import { useMcpGrants } from '@/hooks/useMcpGrants';
import { useConsentDecision, useOAuthClientName } from '@/hooks/useOAuthConsent';
import { errMsg } from '@/lib/errors';
import {
  describeRedirect,
  grantedScopes,
  MCP_CONNECTION_DAYS,
  MCP_SCOPE_OFFLINE,
  MCP_SCOPE_READ,
  MCP_SCOPE_WRITE,
  parseConsentRequest,
} from '@/lib/mcpConsent';
import { type SessionProbeStatus, useAuthStore } from '@/stores/authStore';

/**
 * The page an MCP client sends the user to once they are signed in: who is asking, where the
 * result goes, and what they would be allowed to do. The user decides; the answer is sent to
 * the authorization server, which then returns the browser to the app.
 *
 * Every app is unverified: it registered itself, and its name is whatever it said it was.
 * The redirect host is what the user can actually check, so it is shown prominently.
 */
export function ConsentScreen({ search }: { search: string }) {
  const hydrate = useAuthStore((s) => s.hydrateFromSession);
  const [session, setSession] = useState<SessionProbeStatus | 'checking'>('checking');
  const [attempt, setAttempt] = useState(0);

  // The browser can arrive here straight from the authorization server, for instance after a
  // social sign-in, without ever passing the login page that sets this app's session marker.
  // The page therefore establishes the session itself, and shows nothing that depends on one
  // until it has.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the retry trigger.
  useEffect(() => {
    let cancelled = false;
    setSession('checking');
    hydrate().then((status) => {
      if (!cancelled) {
        setSession(status);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [hydrate, attempt]);

  if (session === 'checking') {
    return (
      <AuthLayout>
        <LoadingState message="Checking your session…" />
      </AuthLayout>
    );
  }
  if (session !== 'authenticated') {
    return (
      <AuthLayout>
        <AuthHeading title="Sign in to continue">
          <p className="mb-6 text-sm leading-relaxed text-paper-400">
            {session === 'unknown'
              ? 'The gateway did not answer, so your session could not be checked.'
              : 'An app is waiting for you to approve it, but you are not signed in here.'}
          </p>
        </AuthHeading>
        {session === 'unknown' ? (
          <Button onClick={() => setAttempt((n) => n + 1)} variant="secondary">
            Try again
          </Button>
        ) : (
          // The consent address carries the signed request, which the login page resumes.
          <ButtonLink href={`/login?${search}`} size="lg" variant="primary">
            Sign in
          </ButtonLink>
        )}
      </AuthLayout>
    );
  }
  return <ConsentDecision search={search} />;
}

function ConsentDecision({ search }: { search: string }) {
  const request = parseConsentRequest(search);
  const grants = useMcpGrants();
  const client = useOAuthClientName(request?.clientId);
  const decide = useConsentDecision();
  const [allowWrite, setAllowWrite] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!request) {
    return (
      <AuthLayout>
        <AuthHeading title="Nothing to approve">
          <p className="mb-6 text-sm leading-relaxed text-paper-400">
            This page opens from an app that wants to connect to auto-swe. The link you followed
            does not carry a request, or it has expired. Start the connection again from the app.
          </p>
        </AuthHeading>
      </AuthLayout>
    );
  }

  const redirect = describeRedirect(request.redirectUri);
  const wantsRead =
    request.scopes.includes(MCP_SCOPE_READ) || request.scopes.includes(MCP_SCOPE_WRITE);
  // Offered only while the operator allows writes: the server refuses the scope otherwise.
  const writeOffered =
    request.scopes.includes(MCP_SCOPE_WRITE) && grants.data?.mcp.writeToolsEnabled === true;
  const offline = request.scopes.includes(MCP_SCOPE_OFFLINE);
  const scope = grantedScopes(
    request.scopes.filter((s) => s !== MCP_SCOPE_WRITE || writeOffered),
    allowWrite
  );
  const grantsAnything = scope.some((s) => s === MCP_SCOPE_READ || s === MCP_SCOPE_WRITE);
  const disabled = grants.data?.mcp.enabled === false;
  // What the app may do depends on the operator's settings; approving before they load
  // could grant a different set than the one shown.
  const grantsReady = grants.isSuccess;
  const name = client.data ?? null;

  async function submit(accept: boolean) {
    setError(null);
    try {
      const url = await decide.mutateAsync({
        accept,
        oauthQuery: request?.oauthQuery ?? '',
        scope: scope.join(' '),
      });
      window.location.assign(url);
    } catch (err) {
      setError(errMsg(err, 'Something went wrong'));
    }
  }

  return (
    <AuthLayout>
      <AuthHeading title="Connect an app">
        <p className="mb-6 text-sm leading-relaxed text-paper-400">
          <span className="font-semibold text-paper-100">{name ?? 'An app'}</span> wants to act on
          your behalf in auto-swe.
        </p>
      </AuthHeading>

      <Card className="space-y-5" variant="inset">
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="label-mono">App</span>
            <Badge tone="amber" uppercase variant="outline">
              unverified
            </Badge>
          </div>
          <div className="text-sm text-paper-100">{name ?? 'Unnamed app'}</div>
          <p className="mt-1 text-xs text-paper-500">
            The app chose this name itself; auto-swe has not checked it.
          </p>
        </div>

        <div>
          <div className="label-mono mb-1.5">After you decide, you are sent to</div>
          <div className="break-all font-mono text-base text-paper-50">{redirect.host}</div>
        </div>

        {redirect.local && (
          <Alert title="This app runs on your own computer" variant="warning">
            It is sent back to an address on this machine, which any program running here could also
            be listening on. Continue only if you just started this connection yourself.
          </Alert>
        )}

        <div>
          <div className="label-mono mb-2">It will be able to</div>
          <ul className="space-y-2 text-sm text-paper-300">
            {wantsRead && (
              <li>
                <span className="font-semibold text-paper-100">Read</span>: see repositories, work
                requests, runs and pending approvals.
              </li>
            )}
            {writeOffered && (
              <li>
                <Checkbox
                  checked={allowWrite}
                  hint="Runs started this way use your own GitHub identity and appear as you."
                  label={
                    <>
                      <span className="font-semibold text-paper-100">Write</span>: start work
                      requests and cancel runs for you.
                    </>
                  }
                  onChange={(e) => setAllowWrite(e.target.checked)}
                />
              </li>
            )}
            {offline && (
              <li>
                Stay connected for up to {MCP_CONNECTION_DAYS} days between uses. You can disconnect
                it any time in Settings.
              </li>
            )}
          </ul>
        </div>
      </Card>

      {disabled && (
        <Alert className="mt-4" variant="warning">
          Connecting apps is turned off on this deployment.
        </Alert>
      )}
      {client.isError && (
        <Alert className="mt-4" variant="warning">
          Could not look up this app, so its name is not shown. Check the address above before you
          continue.
        </Alert>
      )}
      {grants.isError && (
        <Alert className="mt-4">
          Could not load what this app may be allowed to do, so it cannot be approved yet. Reload
          the page to try again.
        </Alert>
      )}
      {grants.isLoading && <LoadingState compact message="Loading permissions…" />}
      {error && <Alert className="mt-4">{error}</Alert>}

      <div className="mt-6 flex gap-3">
        <Button
          className="flex-1"
          disabled={decide.isPending || disabled || !grantsReady || !grantsAnything}
          onClick={() => submit(true)}
          size="lg"
          variant="primary"
        >
          {decide.isPending ? 'Working…' : 'Approve'}
        </Button>
        <Button
          className="flex-1"
          disabled={decide.isPending}
          onClick={() => submit(false)}
          size="lg"
          variant="secondary"
        >
          Deny
        </Button>
      </div>
    </AuthLayout>
  );
}
