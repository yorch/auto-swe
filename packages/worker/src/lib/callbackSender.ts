import {
  type AddressVerdict,
  createGuardedFetch,
  type HostResolver,
  SSRF_BLOCKED_CODE,
} from '@auto-swe/shared/lib/guardedDispatcher';
import {
  CALLBACK_DELIVERY_HEADER,
  CALLBACK_EVENT_HEADER,
  type CallbackDeliveryError,
} from '@auto-swe/shared/lib/runCallbacks';
import { signWebhookBody, WEBHOOK_SIGNATURE_HEADER } from '@auto-swe/shared/lib/webhookSigning';

/**
 * One HTTP attempt of a run callback (docs/run-callbacks.md).
 *
 * The URL came from a caller, under an endpoint a team registered, so the
 * request goes through `createGuardedFetch`: the host is resolved, every
 * answer is classified (private addresses only with the endpoint's opt-in;
 * loopback, link-local and metadata never), and the connection is pinned to a
 * checked address. A redirect is refused outright — following one would send
 * a signed body to a URL nobody registered.
 *
 * The outcome is a status code and a fixed error class. The response body is
 * never read, and a transport error's text is never returned: either could
 * carry whatever the receiver (or something impersonating it) chose to put
 * there, and both end up in the database and the logs.
 */

export const CALLBACK_TIMEOUT_MS = 10_000;
const USER_AGENT = 'auto-swe-callbacks/1';

export type CallbackAttempt =
  | { ok: true; statusCode: number }
  | { ok: false; error: CallbackDeliveryError; statusCode: number | null };

export interface SendCallbackInput {
  url: string;
  deliveryId: string;
  event: string;
  /** The exact bytes sent and signed. */
  body: string;
  /** Current secret first; a previous one still in its overlap adds a second `v1`. */
  secrets: readonly string[];
  allowPrivateNetwork: boolean;
  nowSec: number;
}

/** Test seams; production passes none. */
export interface SendCallbackDeps {
  fetchImpl?: typeof fetch;
  resolver?: HostResolver;
  classify?: (address: string, allowPrivate: boolean) => AddressVerdict;
  proxied?: boolean;
  timeoutMs?: number;
}

export async function sendCallback(
  input: SendCallbackInput,
  deps: SendCallbackDeps = {}
): Promise<CallbackAttempt> {
  const guardedFetch = createGuardedFetch({
    allowPrivate: input.allowPrivateNetwork,
    ...(deps.classify ? { classify: deps.classify } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.proxied !== undefined ? { proxied: deps.proxied } : {}),
    ...(deps.resolver ? { resolver: deps.resolver } : {}),
  });
  let response: Response;
  try {
    response = await guardedFetch(input.url, {
      body: input.body,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        [CALLBACK_DELIVERY_HEADER]: input.deliveryId,
        [CALLBACK_EVENT_HEADER]: input.event,
        [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(input.secrets, input.body, input.nowSec),
      },
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(deps.timeoutMs ?? CALLBACK_TIMEOUT_MS),
    });
  } catch (err) {
    return { error: classifyCallbackError(err), ok: false, statusCode: null };
  }
  // Never read: release the connection without looking at what the receiver sent.
  await response.body?.cancel().catch(() => undefined);
  if (response.status >= 200 && response.status < 300) {
    return { ok: true, statusCode: response.status };
  }
  return {
    error: response.status >= 300 && response.status < 400 ? 'REDIRECT' : 'HTTP_STATUS',
    ok: false,
    statusCode: response.status,
  };
}

/** Map a thrown fetch error to its class by type and code, never by showing its text. */
export function classifyCallbackError(err: unknown): CallbackDeliveryError {
  for (let e: unknown = err, depth = 0; e && depth < 6; depth++) {
    const candidate = e as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === SSRF_BLOCKED_CODE) {
      return 'ADDRESS_REFUSED';
    }
    if (candidate.name === 'TimeoutError' || candidate.name === 'AbortError') {
      return 'TIMEOUT';
    }
    // undici's network error for `redirect: 'error'`; compared, not stored.
    if (candidate.message === 'unexpected redirect') {
      return 'REDIRECT';
    }
    e = candidate.cause;
  }
  return 'NETWORK';
}
