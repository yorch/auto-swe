'use client';

import { useEffect, useState } from 'react';
import { AuthHeading, AuthLayout } from '@/components/layout/AuthLayout';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Icon } from '@/components/ui/Icon';
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
      <AuthLayout embedded>
        <LoadingState message="Checking your session…" />
      </AuthLayout>
    );
  }
  if (session !== 'authenticated') {
    return (
      <AuthLayout embedded>
        <AuthHeading
          icon={session === 'unknown' ? 'warning' : 'lock'}
          kickerTone={session === 'unknown' ? 'amber' : 'ember'}
          title="Sign in to continue"
        >
          {session === 'unknown'
            ? 'The gateway did not answer, so your session could not be checked.'
            : 'An app is waiting for you to approve it, but you are not signed in here.'}
        </AuthHeading>
        {session === 'unknown' ? (
          <Button className="w-full" onClick={() => setAttempt((n) => n + 1)} size="lg">
            <Icon name="refresh" size={15} />
            Try again
          </Button>
        ) : (
          // The consent address carries the signed request, which the login page resumes.
          <ButtonLink className="w-full" href={`/login?${search}`} size="lg" variant="primary">
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
      <AuthLayout embedded>
        <AuthHeading icon="plug" title="Nothing to approve">
          This page opens from an app that wants to connect to auto-swe. The link you followed does
          not carry a request, or it has expired. Start the connection again from the app.
        </AuthHeading>
        <ButtonLink className="w-full" href="/" size="lg">
          Go to the dashboard
        </ButtonLink>
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
    <AuthLayout embedded>
      <AuthHeading icon="plug" kicker="Authorize access" title="Connect an app">
        <span className="font-semibold text-paper-100">{name ?? 'An app'}</span> wants to act on
        your behalf in auto-swe.
      </AuthHeading>

      <div className="divide-y divide-ink-600 rounded-xl border border-ink-400/60 bg-ink-900/60">
        <div className="p-4">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="label-mono">App</span>
            <Badge dot tone="amber" variant="outline">
              Unverified
            </Badge>
          </div>
          <div className="text-sm font-medium text-paper-100">{name ?? 'Unnamed app'}</div>
          <p className="mt-1 text-xs leading-relaxed text-paper-500">
            The app chose this name itself; auto-swe has not checked it.
          </p>
        </div>

        <div className="p-4">
          <div className="label-mono mb-1.5">After you decide, you are sent to</div>
          <div className="flex items-center gap-2">
            <Icon className="text-paper-500" name="external" size={14} />
            <span className="break-all font-mono text-[15px] text-paper-50">{redirect.host}</span>
          </div>
          {redirect.local && (
            <Alert className="mt-3" title="This app runs on your own computer" variant="warning">
              It is sent back to an address on this machine, which any program running here could
              also be listening on. Continue only if you just started this connection yourself.
            </Alert>
          )}
        </div>

        <div className="p-4">
          <div className="label-mono mb-2.5">It will be able to</div>
          <ul className="space-y-3 text-[13px] leading-relaxed text-paper-300">
            {wantsRead && (
              <li className="flex gap-2.5">
                <Icon className="mt-0.5 text-moss-400" name="check" size={15} />
                <span>
                  <span className="font-semibold text-paper-100">Read</span>: see repositories, work
                  requests, runs and pending approvals.
                </span>
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
              <li className="flex gap-2.5">
                <Icon className="mt-0.5 text-paper-500" name="clock" size={15} />
                <span>
                  Stay connected for up to {MCP_CONNECTION_DAYS} days between uses. You can
                  disconnect it any time in Settings.
                </span>
              </li>
            )}
          </ul>
        </div>
      </div>

      <div className="mt-4 space-y-3 empty:hidden">
        {disabled && (
          <Alert variant="warning">Connecting apps is turned off on this deployment.</Alert>
        )}
        {client.isError && (
          <Alert variant="warning">
            Could not look up this app, so its name is not shown. Check the address above before you
            continue.
          </Alert>
        )}
        {grants.isError && (
          <Alert>
            Could not load what this app may be allowed to do, so it cannot be approved yet. Reload
            the page to try again.
          </Alert>
        )}
        {grants.isLoading && <LoadingState compact message="Loading permissions…" />}
        {error && <Alert>{error}</Alert>}
      </div>

      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row">
        <Button
          className="sm:flex-1"
          disabled={decide.isPending}
          onClick={() => submit(false)}
          size="lg"
          variant="secondary"
        >
          Deny
        </Button>
        <Button
          className="sm:flex-1"
          disabled={decide.isPending || disabled || !grantsReady || !grantsAnything}
          onClick={() => submit(true)}
          size="lg"
          variant="primary"
        >
          {decide.isPending ? 'Working…' : 'Approve'}
        </Button>
      </div>
    </AuthLayout>
  );
}
