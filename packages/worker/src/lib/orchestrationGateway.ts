import { resolveGatewayInternalUrl } from '@auto-swe/shared/lib/systemConfig';
import { gatewayUrl } from './assistantGateway.js';

/**
 * How the orchestration's apply activity reaches the gateway: the `/api/v1/orchestrations/...`
 * routes over HTTP with the orchestration token minted at launch. The gateway is the authority on
 * every spawn, message and cancel; the worker only carries the validated intent to it.
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
/** Longest response read back; a refusal or a created child is tiny. */
const MAX_RESPONSE_CHARS = 50_000;

export function createOrchestrationGateway(
  token: string,
  options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}
): OrchestrationGateway {
  const baseUrl = options.baseUrl ?? resolveGatewayInternalUrl();
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async post(path, body) {
      const url = gatewayUrl(baseUrl, path);
      const res = await fetchImpl(url, {
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
      const text = (await res.text()).slice(0, MAX_RESPONSE_CHARS);
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
