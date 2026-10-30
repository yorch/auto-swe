/**
 * Whether an inbound request must stay out of tracing because its path carries a registry-proxy
 * workspace token (`/go/<token>/…`, `/pypi/<token>/…`). No imports: telemetry loads this before
 * anything else.
 *
 * The proxy routes on `new URL(raw, 'http://proxy').pathname`, which resolves `.` segments, `%2e`
 * and absolute-form targets, so the decision here is taken on the same normalised path. The raw
 * target is also checked, and a target that does not parse is not traced either: every doubt
 * resolves toward not recording the path.
 */
export function isProxyTokenPath(rawUrl: string | undefined): boolean {
  const raw = rawUrl ?? '/';
  if (raw.startsWith('/go/') || raw.startsWith('/pypi/')) {
    return true;
  }
  try {
    const { pathname } = new URL(raw, 'http://proxy');
    return pathname.startsWith('/go/') || pathname.startsWith('/pypi/');
  } catch {
    return true;
  }
}
