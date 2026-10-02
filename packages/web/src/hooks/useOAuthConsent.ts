'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { API_BASE } from '@/lib/config';
import { resumeUrl } from '@/lib/mcpConsent';
import { gatewayUnreachableMessage } from '@/lib/networkErrors';

/**
 * The OAuth provider's own endpoints, which answer with `{ error, error_description }` or
 * `{ message }` rather than the gateway's `{ error: { code, message } }`. They authenticate
 * with the session cookie, so these use `fetch` directly instead of the bearer-token client.
 */
const ProviderErrorSchema = z.object({
  error_description: z.string().optional(),
  message: z.string().optional(),
});

async function providerFetch(path: string, init: RequestInit, fallback: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, credentials: 'include' });
  } catch (err) {
    throw new Error(gatewayUnreachableMessage(err, API_BASE) ?? fallback);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = ProviderErrorSchema.safeParse(body);
    throw new Error(
      (parsed.success && (parsed.data.error_description ?? parsed.data.message)) || fallback
    );
  }
  return body;
}

const PublicClientSchema = z.object({ client_name: z.string().nullish() });

/** The registered name of the app asking for access. Unverified: the app chose it. */
export function useOAuthClientName(clientId: string | undefined) {
  return useQuery({
    enabled: clientId !== undefined,
    queryFn: async () => {
      const body = await providerFetch(
        `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId ?? '')}`,
        {},
        'Could not look up the app'
      );
      return PublicClientSchema.parse(body).client_name ?? null;
    },
    queryKey: ['oauth-client', clientId],
    retry: false,
  });
}

const DecisionResponseSchema = z.object({ url: z.string().optional() });

export interface ConsentDecision {
  accept: boolean;
  oauthQuery: string;
  /** The narrowed scopes; only meaningful when accepting. */
  scope?: string;
}

/** Sends the decision and returns where the browser goes next (the app's redirect). */
export function useConsentDecision() {
  return useMutation({
    mutationFn: async ({ accept, oauthQuery, scope }: ConsentDecision) => {
      const body = await providerFetch(
        '/api/auth/oauth2/consent',
        {
          body: JSON.stringify({
            accept,
            oauth_query: oauthQuery,
            ...(accept && scope ? { scope } : {}),
          }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        },
        accept ? 'Could not approve the app' : 'Could not send your decision'
      );
      const url = resumeUrl(DecisionResponseSchema.parse(body).url);
      if (!url) {
        throw new Error('The server did not say where to send you next.');
      }
      return url;
    },
  });
}
