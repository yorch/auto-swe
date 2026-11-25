import {
  CAMPAIGN_TOKEN_TTL_SECONDS,
  type CampaignTokenCall,
  mintCampaignToken,
} from '@auto-swe/shared/lib/campaignTokenKey';
import { resolveGatewayInternalUrl } from '@auto-swe/shared/lib/systemConfig';
import { gatewayUrl } from './assistantGateway.js';

/**
 * How the reconciler's `startCampaignAttempt` activity reaches the gateway: one POST to
 * `/api/v1/campaigns/:id/targets/:targetId/attempts`. The worker mints a fresh campaign token
 * (`@auto-swe/shared/lib/campaignTokenKey`, {@link CAMPAIGN_TOKEN_TTL_SECONDS} seconds, scoped to
 * that one campaign, target and call) for EVERY request, from its own `CONFIG_ENCRYPTION_KEY`. A
 * token is never stored, returned from an activity or written to workflow history. The gateway is
 * the authority on every start; the worker only carries the request to it.
 *
 * Same shape as the orchestration client (`orchestrationGateway.ts`): the base URL is the
 * operator's `API_INTERNAL_URL`; the path is checked to stay under `/api/v1/`; redirects are
 * refused so the token goes to that origin only. The internal address is typically private, so the
 * SSRF-guarded fetch (which refuses private addresses) does not apply.
 */

export interface CampaignGatewayResponse {
  status: number;
  /** The parsed JSON body; the raw text when it was not JSON; undefined when there was none. */
  body: unknown;
}

export interface CampaignGateway {
  /** One POST to an `/api/v1` route, with a token scoped to `scope`. */
  post(
    path: string,
    body: unknown,
    scope: { campaignId: string; targetId: string; call: CampaignTokenCall },
    headers?: Record<string, string>
  ): Promise<CampaignGatewayResponse>;
}

const REQUEST_TIMEOUT_MS = 30_000;
/** Most bytes read back; a refusal or a started attempt is tiny. The rest is never buffered. */
export const MAX_RESPONSE_BYTES = 50_000;

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
export function redactCampaignTokens(text: string): string {
  return text.replace(/camp_[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, '***');
}

export function createCampaignGateway(
  options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}
): CampaignGateway {
  const baseUrl = options.baseUrl ?? resolveGatewayInternalUrl();
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async post(path, body, scope, headers = {}) {
      const url = gatewayUrl(baseUrl, path);
      const token = mintCampaignToken(scope, CAMPAIGN_TOKEN_TTL_SECONDS);
      let res: Response;
      try {
        res = await fetchImpl(url, {
          body: JSON.stringify(body),
          headers: {
            ...headers,
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
        throw new Error(redactCampaignTokens(message).replace(token, '***'));
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
