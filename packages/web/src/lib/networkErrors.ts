/**
 * `fetch()` throws a synchronous-looking `TypeError: Failed to fetch` (Chrome /
 * Edge) or `TypeError: NetworkError when attempting to fetch resource` (Firefox)
 * when the request can't be made at all — DNS failure, server down, CORS
 * preflight rejected, etc. Distinguishing this from a regular HTTP-level error
 * (4xx/5xx) is important because the remediation is completely different:
 * "your credentials are wrong" vs. "the gateway is unreachable".
 *
 * Both major browsers report the failure as a `TypeError` (NOT a custom
 * `NetworkError` subclass), so the only reliable signal is the type + message
 * string. We keep the regex permissive on purpose — better to occasionally
 * mis-classify a real bug as a network failure than to miss the common case.
 */
export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  return /failed to fetch|networkerror|load failed/i.test(err.message);
}

/**
 * Friendlier copy for network-level fetch failures that mentions the actual
 * API base URL so the user (often a contributor running locally) can see
 * exactly what isn't reachable. Returns null when the error is a normal HTTP
 * error so callers can fall through to whatever message the server sent.
 */
export function gatewayUnreachableMessage(err: unknown, apiBase: string): string | null {
  if (!isNetworkError(err)) return null;
  return `Can't reach the auto-swe gateway at ${apiBase}. Check that it's running and that CORS_ORIGIN includes this page's origin.`;
}

/**
 * Wrap any fetch-issuing function so a network-level failure throws with a
 * useful message instead of the raw `TypeError: Failed to fetch`. HTTP errors
 * (4xx/5xx) pass through unchanged — the server's own message is more
 * informative for those.
 */
export async function withGatewayDiagnostics<T>(apiBase: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const friendly = gatewayUnreachableMessage(err, apiBase);
    if (friendly) throw new Error(friendly);
    throw err;
  }
}
