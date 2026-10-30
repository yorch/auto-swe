'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { AuthHeading, AuthLayout } from '@/components/layout/AuthLayout';
import { Alert } from '@/components/ui/Alert';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { OAuthProviderError, providerFetch, useOAuthClientName } from '@/hooks/useOAuthConsent';
import { type SessionProbeStatus, useAuthStore } from '@/stores/authStore';

const verification = z.object({
  client_id: z.string(),
  resource: z.string(),
  scope: z.string(),
  status: z.enum(['pending', 'approved', 'denied']),
});

export function DeviceScreen({ search }: { search: string }) {
  const initialCode = new URLSearchParams(search).get('user_code') ?? '';
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
  const scopes = review.data?.scope.split(' ') ?? [];
  const terminal = finished ?? (review.data?.status !== 'pending' ? review.data?.status : null);

  return (
    <AuthLayout>
      <AuthHeading icon="plug" title="Authorize a device">
        Connect a local app to auto-swe.
      </AuthHeading>
      {session === 'checking' ? (
        <p role="status">Checking your session…</p>
      ) : session !== 'authenticated' ? (
        <>
          <p>Sign in to review this device request.</p>
          {session === 'unknown' ? (
            <Button
              onClick={() => {
                void hydrate().then(setSession);
              }}
            >
              Try again
            </Button>
          ) : (
            <ButtonLink
              href={`/login?redirect=${encodeURIComponent(`/device${search ? `?${search}` : ''}`)}`}
            >
              Sign in
            </ButtonLink>
          )}
        </>
      ) : terminal ? (
        <Alert
          title={terminal === 'approved' ? 'Device approved' : 'Device denied'}
          variant={terminal === 'approved' ? 'success' : 'info'}
        >
          You can close this page and return to your app.
        </Alert>
      ) : (
        <div className="space-y-4">
          <Alert title="Only approve a code you started yourself" variant="warning">
            Never approve a code sent by someone else, even if they claim to be support. An attacker
            can use it to act as you.
          </Alert>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              decide.reset();
              setCode(input.trim());
              if (input.trim() === code) {
                void review.refetch();
              }
            }}
          >
            <Input
              label="User code"
              maxLength={191}
              onChange={(event) => setInput(event.target.value)}
              required
              value={input}
            />
            <Button disabled={!input.trim() || decide.isPending} type="submit">
              Review code
            </Button>
          </form>
          {review.isFetching && <p role="status">Loading request…</p>}
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
          {review.data && !review.isFetching && !review.isError && (
            <>
              <p className="font-semibold">
                {client.data ?? review.data.client_id}{' '}
                <span className="text-paper-500">(Unverified app)</span>
              </p>
              <p>
                Code: <strong>{code}</strong>
              </p>
              <p>
                Resource: <code className="break-all">{review.data.resource}</code>
              </p>
              <p>
                Requested scopes: <code>{review.data.scope}</code>
              </p>
              {(scopes.includes('mcp:read') || scopes.includes('mcp:write')) && (
                <p>Read: see repositories, runs and pending human steps.</p>
              )}
              {scopes.includes('mcp:write') && (
                <Alert title="Write access requested" variant="warning">
                  This app can launch and cancel work as you, using your identity and credentials.
                  Templates may push branches or open pull requests.
                </Alert>
              )}
              {scopes.includes('offline_access') && (
                <p>Stay connected for up to 14 days using rotating refresh tokens.</p>
              )}
              <p>
                Approval grants all requested scopes. To allow read only, deny and ask your app to
                request read-only access.
              </p>
              {client.isLoading && <p className="text-paper-500">Loading app details…</p>}
              {client.isError && (
                <Alert title="App name unavailable" variant="warning">
                  Could not look up this app's name, so the address above is all that identifies it.
                  Check that before you approve.
                </Alert>
              )}
              <div className="flex gap-3">
                <Button
                  disabled={decide.isPending || client.isLoading}
                  onClick={() => decide.mutate(true)}
                >
                  {decide.isPending ? 'Working…' : 'Approve'}
                </Button>
                <Button
                  disabled={decide.isPending}
                  onClick={() => decide.mutate(false)}
                  variant="secondary"
                >
                  Deny
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </AuthLayout>
  );
}
