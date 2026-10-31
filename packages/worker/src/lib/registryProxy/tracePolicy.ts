/**
 * Whether an inbound request must stay out of tracing: `/go/<token>/…` carries a registry-proxy
 * workspace token in its path, and `/pypi/<id>/…` and `/maven/<id>/…` carry none (their token is a
 * Basic password) but are kept out beside it, so the proxy routes are traced alike (not at all)
 * and the trace stays small. This does not protect a secret on those two routes.
 *
 * The proxy routes on `new URL(raw, 'http://proxy').pathname`, which resolves `.` segments, `%2e`
 * and absolute-form targets, so the decision here is taken on the same normalised path. The raw
 * target is also checked, and a target that does not parse is not traced either: every doubt
 * resolves toward not recording the path.
 */
const PROXY_PREFIXES = ['/go/', '/pypi/', '/maven/'];
const isProxyPath = (path: string): boolean => PROXY_PREFIXES.some((p) => path.startsWith(p));

export function isProxyTokenPath(rawUrl: string | undefined): boolean {
  const raw = rawUrl ?? '/';
  if (isProxyPath(raw)) {
    return true;
  }
  try {
    const { pathname } = new URL(raw, 'http://proxy');
    return isProxyPath(pathname);
  } catch {
    return true;
  }
}
