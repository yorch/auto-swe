import {
  mintOrchestrationToken,
  ORCHESTRATION_TOKEN_TTL_SECONDS,
} from '@auto-swe/shared/lib/orchestrationTokenKey';
import { resolveGatewayInternalUrl } from '@auto-swe/shared/lib/systemConfig';
import { gatewayUrl } from './assistantGateway.js';

/**
 * How the orchestration's apply activity reaches the gateway: the `/api/v1/orchestrations/...`
 * routes over HTTP. The worker mints a fresh orchestration token
 * (`@auto-swe/shared/lib/orchestrationTokenKey`, {@link ORCHESTRATION_TOKEN_TTL_SECONDS} seconds)
 * for EVERY request, from its own `CONFIG_ENCRYPTION_KEY`; a token is never stored, passed between
 * activities or written to workflow history. The gateway is the authority on every spawn, message
 * and cancel; the worker only carries the validated intent to it.
 *
 * Same shape as the in-app assistant's client (`assistantGateway.ts`): the base URL is the
 * operator's `API_INTERNAL_URL`, never anything a model said; the path is checked to stay under
 * `/api/v1/`; redirects are refused so the token goes to that origin only. The internal address is
 * typically private, so the SSRF-guarded fetch (which refuses private addresses) does not apply.
 */

export interface OrchestrationGatewayResponse {
  status: number;
  /** The parsed JSON body; the raw text when it was not JSON; undefined when there was none. */
  body: unknown;
}

export interface OrchestrationGateway {
  /** One POST to an `/api/v1` route, as the launcher. */
  post(path: string, body: unknown): Promise<OrchestrationGatewayResponse>;
}

const REQUEST_TIMEOUT_MS = 30_000;
/** Most bytes read back; a refusal or a created child is tiny. The rest is never buffered. */
export const MAX_RESPONSE_BYTES = 50_000;

/** The response body as text, reading at most `maxBytes` and cancelling the stream past that. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    return '';
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    bytes += value.byteLength;
    if (bytes >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8');
}

/** A token in free text (an error message, a body the platform echoed), masked. */
export function redactOrchestrationTokens(text: string): string {
  return text.replace(/orch_[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, '***');
}

export function createOrchestrationGateway(
  orchestrationId: string,
  options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}
): OrchestrationGateway {
  const baseUrl = options.baseUrl ?? resolveGatewayInternalUrl();
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async post(path, body) {
      const url = gatewayUrl(baseUrl, path);
      const token = mintOrchestrationToken({ orchestrationId }, ORCHESTRATION_TOKEN_TTL_SECONDS);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          body: JSON.stringify(body),
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        // A transport error must never carry the token it was sent with into a log or a notice.
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(redactOrchestrationTokens(message).replace(token, '***'));
      }
      const text = await readCapped(res, MAX_RESPONSE_BYTES);
      let parsed: unknown;
      if (text !== '') {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      return { body: parsed, status: res.status };
    },
  };
}
