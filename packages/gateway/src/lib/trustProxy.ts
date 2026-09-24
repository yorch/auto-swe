/**
 * Parse `TRUST_PROXY` into Fastify's `trustProxy` option.
 *
 * Behind a reverse proxy or load balancer, `request.ip` is the proxy's address
 * unless Fastify is told to trust `X-Forwarded-For` — and the rate limiter keys
 * anonymous traffic on `request.ip`, so every client would share one bucket.
 * Trusting the header when nothing sits in front lets any client choose its own
 * IP, so it is off unless configured.
 *
 * - unset, empty, `false` → do not trust forwarding headers (the default)
 * - `true`                → trust every hop (only when the gateway is reachable
 *                           solely through the proxy)
 * - anything else         → a comma-separated list of proxy IPs / CIDRs, the
 *                           preferred form: only those peers may set the header
 *
 * A bare hop count is refused. Fastify deliberately treats one as "trust
 * nothing", because counting hops cannot tell the proxy from a direct client
 * that pads the header — so accepting it here would either silently do nothing
 * or reintroduce the spoofing Fastify closed.
 */
export function parseTrustProxy(raw: string | undefined): boolean | string[] {
  const value = raw?.trim() ?? '';
  if (value === '' || value.toLowerCase() === 'false') {
    return false;
  }
  if (value.toLowerCase() === 'true') {
    return true;
  }
  if (/^\d+$/.test(value)) {
    throw new Error(
      `TRUST_PROXY=${value}: a hop count is not supported — list the proxy IPs/CIDRs instead, or set it to true`
    );
  }
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}
