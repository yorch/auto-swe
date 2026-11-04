'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { AuthHeading, AuthLayout } from '@/components/layout/AuthLayout';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { OAuthProviderError, providerFetch, useOAuthClientName } from '@/hooks/useOAuthConsent';
import { type SessionProbeStatus, useAuthStore } from '@/stores/authStore';

const verification = z.object({
  client_id: z.string(),
  resource: z.string(),
  scope: z.string(),
  status: z.enum(['pending', 'approved', 'denied']),
});

/** Codes are case-insensitive and the gateway strips separators; trimming and upper-casing keep the lookup predictable. */
function normaliseCode(value: string) {
  return value.trim().toUpperCase();
}

/** The host of the resource the app will reach, shown on its own line as the address to check. */
function hostOf(resource: string) {
  try {
    return new URL(resource).host;
  } catch {
    return resource;
  }
}

export function DeviceScreen({ search }: { search: string }) {
  const initialCode = normaliseCode(new URLSearchParams(search).get('user_code') ?? '');
  const hydrate = useAuthStore((s) => s.hydrateFromSession);
  const [session, setSession] = useState<SessionProbeStatus | 'checking'>('checking');
  const [input, setInput] = useState(initialCode);
  const [code, setCode] = useState(initialCode);
  const [finished, setFinished] = useState<'approved' | 'denied' | null>(null);
  useEffect(() => {
    void hydrate().then(setSession);
  }, [hydrate]);
  const review = useQuery({
    enabled: session === 'authenticated' && Boolean(code),
    queryFn: async () =>
      verification.parse(
        await providerFetch(
          `/api/auth/device?user_code=${encodeURIComponent(code)}`,
          {},
          'Invalid user code, or this request belongs to another user.'
        )
      ),
    queryKey: ['device-authorization', code],
    refetchOnWindowFocus: false,
    retry: false,
  });
  const client = useOAuthClientName(review.data?.client_id);
  const decide = useMutation({
    mutationFn: async (accept: boolean) => {
      await providerFetch(
        `/api/auth/device/${accept ? 'approve' : 'deny'}`,
        {
          body: JSON.stringify({ userCode: code }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        },
        'The decision could not be saved'
      );
      setFinished(accept ? 'approved' : 'denied');
    },
  });
  const error = decide.error ?? review.error;
  // One parse of the space-separated scope string, so every check below means the same thing.
  const scopes = review.data?.scope.split(' ').filter(Boolean) ?? [];
  const terminal = finished ?? (review.data?.status !== 'pending' ? review.data?.status : null);
  const reviewed = review.data && !review.isFetching && !review.isError;

  return (
    <AuthLayout>
      {terminal ? (
        <AuthHeading
          icon={terminal === 'approved' ? 'checkCircle' : 'close'}
          title={terminal === 'approved' ? 'Device approved' : 'Device denied'}
          tone={terminal === 'approved' ? 'success' : 'neutral'}
        >
          You can close this page and return to your app.
        </AuthHeading>
      ) : (
        <AuthHeading icon="plug" title="Authorize a device">
          Connect a local app to auto-swe.
        </AuthHeading>
      )}
      {session === 'checking' ? (
        <p className="text-sm text-paper-500" role="status">
          Checking your session…
        </p>
      ) : session !== 'authenticated' ? (
        <div className="space-y-4">
          <p className="text-sm text-paper-400">Sign in to review this device request.</p>
          {session === 'unknown' ? (
            <Button
              className="w-full"
              onClick={() => {
                void hydrate().then(setSession);
              }}
              size="lg"
            >
              Try again
            </Button>
          ) : (
            <ButtonLink
              className="w-full"
              href={`/login?redirect=${encodeURIComponent(`/device${search ? `?${search}` : ''}`)}`}
              size="lg"
              variant="primary"
            >
              Sign in
            </ButtonLink>
          )}
        </div>
      ) : terminal ? (
        <p className="text-sm text-paper-400">
          {terminal === 'approved'
            ? 'The app can now connect with the access you approved.'
            : 'The app was not given access.'}
        </p>
      ) : (
        <div className="space-y-5">
          <Alert title="Only approve a code you started yourself" variant="warning">
            Never approve a code sent by someone else, even if they claim to be support. An attacker
            can use it to act as you.
          </Alert>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const next = normaliseCode(input);
              decide.reset();
              setInput(next);
              if (next === code) {
                void review.refetch();
              } else {
                setCode(next);
              }
            }}
          >
            <Input
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              autoFocus={!initialCode}
              className="font-mono text-base tracking-widest"
              hint="Shown by the app or CLI that asked for access."
              label="Device code"
              maxLength={191}
              name="user_code"
              onChange={(event) => setInput(event.target.value)}
              required
              spellCheck={false}
              value={input}
            />
            <Button disabled={!input.trim() || decide.isPending} size="lg" type="submit">
              {review.isFetching ? 'Checking…' : 'Review code'}
            </Button>
          </form>
          {review.isFetching && (
            <p className="text-sm text-paper-500" role="status">
              Loading request…
            </p>
          )}
          {error && (
            <Alert
              title={
                error instanceof OAuthProviderError && error.code === 'expired_token'
                  ? 'Code expired'
                  : 'Invalid or unavailable request'
              }
              variant="error"
            >
              Start again from your app. No access is granted by a failed request.
            </Alert>
          )}
          {reviewed && (
            <>
              <div className="divide-y divide-ink-600 rounded-xl border border-ink-400/60 bg-ink-900/60">
                <div className="p-4">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="label-mono">App</span>
                    <Badge dot tone="warning" variant="outline">
                      Unverified
                    </Badge>
                  </div>
                  <div className="text-sm font-medium text-paper-100">
                    {client.data ?? 'Unnamed app'}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-paper-500">
                    The app chose this name itself; auto-swe has not checked it.
                  </p>
                  <div className="label-mono mt-3">Client ID</div>
                  <code className="break-all font-mono text-xs text-paper-300">
                    {review.data.client_id}
                  </code>
                </div>

                <div className="p-4">
                  <div className="label-mono mb-1.5">It will connect to</div>
                  <div className="flex items-center gap-2">
                    <Icon className="text-paper-500" name="external" size={14} />
                    <span className="break-all font-mono text-lg text-paper-50">
                      {hostOf(review.data.resource)}
                    </span>
                  </div>
                  <code className="mt-1 block break-all font-mono text-xs text-paper-500">
                    {review.data.resource}
                  </code>
                </div>

                <div className="p-4">
                  <div className="label-mono mb-2.5">It will be able to</div>
                  <ul className="space-y-3 text-sm leading-relaxed text-paper-300">
                    {(scopes.includes('mcp:read') || scopes.includes('mcp:write')) && (
                      <li className="flex gap-2.5">
                        <Icon className="mt-0.5 text-success-400" name="check" size={15} />
                        <span>
                          <span className="font-semibold text-paper-100">Read</span>: see
                          repositories, runs and pending human steps.
                        </span>
                      </li>
                    )}
                    {scopes.includes('mcp:write') && (
                      <li className="flex gap-2.5">
                        <Icon className="mt-0.5 text-warning-400" name="alert" size={15} />
                        <span>
                          <span className="font-semibold text-paper-100">Write</span>: launch and
                          cancel work as you.
                        </span>
                      </li>
                    )}
                    {scopes.includes('offline_access') && (
                      <li className="flex gap-2.5">
                        <Icon className="mt-0.5 text-paper-500" name="clock" size={15} />
                        <span>
                          Stay connected between uses, with rotating refresh tokens. You can
                          disconnect it any time in Settings.
                        </span>
                      </li>
                    )}
                  </ul>
                  <p className="mt-3 text-xs text-paper-500">
                    Requested scopes: <code className="font-mono">{review.data.scope}</code>
                  </p>
                </div>
              </div>

              {scopes.includes('mcp:write') && (
                <Alert title="Write access requested" variant="warning">
                  This app can launch and cancel work as you, using your identity and credentials.
                  Templates may push branches or open pull requests.
                </Alert>
              )}
              <p className="text-sm leading-relaxed text-paper-500">
                Approval grants all requested scopes. To allow read only, deny and ask your app to
                request read-only access.
              </p>
              {client.isLoading && (
                <p className="text-sm text-paper-500" role="status">
                  Loading app details…
                </p>
              )}
              {client.isError && (
                <Alert title="App name unavailable" variant="warning">
                  Could not look up this app's name, so the client ID above is all that identifies
                  it. Check that before you approve.
                </Alert>
              )}
              <div className="flex flex-col-reverse gap-3 sm:flex-row">
                <Button
                  className="sm:flex-1"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate(false)}
                  size="lg"
                  variant="secondary"
                >
                  Deny
                </Button>
                <Button
                  className="sm:flex-1"
                  disabled={decide.isPending || client.isLoading}
                  onClick={() => decide.mutate(true)}
                  size="lg"
                  variant="primary"
                >
                  {decide.isPending ? 'Working…' : 'Approve'}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </AuthLayout>
  );
}
