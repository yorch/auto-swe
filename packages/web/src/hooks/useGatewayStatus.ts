import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { API_BASE } from '@/lib/config';
import { isNetworkError } from '@/lib/networkErrors';

/** Unauthenticated liveness route served by the gateway (`app.get('/health')`). */
const HEALTH_PATH = '/health';
const POLL_MS = 30_000;

/**
 * `unknown` means the probe itself threw for a non-network reason (a malformed
 * API URL, say): a configuration bug, not a verdict about the gateway.
 */
export type GatewayStatus = 'pending' | 'online' | 'offline' | 'unknown';

/**
 * The one definition of "gateway reachable", shared by the login page and the
 * signed-in top bar: the request must not fail at the network layer (down, DNS,
 * CORS) and the response must satisfy `accept`. Callers state what a healthy
 * answer is for their route, because anything looser lets a foreign server on
 * the gateway's port read as reachable.
 *
 * Resolves to the response when reachable and `null` when not. A non-network
 * throw is a bug, not a verdict, and propagates.
 */
export async function probeGateway(
  path: string,
  accept: (res: Response) => boolean,
  timeoutMs?: number
): Promise<Response | null> {
  let res: Response;
  try {
    res = await fetch(
      `${API_BASE}${path}`,
      timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : undefined
    );
  } catch (err) {
    // A probe that outlives its deadline is a gateway that is not answering.
    if (isNetworkError(err) || (err instanceof DOMException && err.name === 'TimeoutError')) {
      return null;
    }
    throw err;
  }
  return accept(res) ? res : null;
}

/** 2xx only — a route that must answer successfully or something else owns the port. */
export const isOkResponse = (res: Response): boolean => res.ok;

/** The gateway's /health is unauthenticated and answers 200, or 429 from the rate limiter. */
const isHealthResponse = (res: Response): boolean => res.ok || res.status === 429;

/**
 * Live gateway reachability for the signed-in app. `pending` until the first
 * probe answers — nothing is claimed before then. Network failures and
 * unhealthy statuses (including 404, a foreign server) are `offline`; a
 * non-network throw is `unknown` and logged once per failure streak.
 */
export function useGatewayStatus(): GatewayStatus {
  const { data, error, isError } = useQuery({
    queryFn: async () => (await probeGateway(HEALTH_PATH, isHealthResponse)) !== null,
    queryKey: ['gateway-status'],
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    retry: false,
  });
  useEffect(() => {
    if (isError) {
      console.error('Gateway status probe failed for a non-network reason', error);
    }
  }, [isError, error]);
  if (isError) {
    return 'unknown';
  }
  if (data === undefined) {
    return 'pending';
  }
  return data ? 'online' : 'offline';
}
