/**
 * Centralized reads for build-time / public environment variables used by the
 * web dashboard. This keeps `process.env` access in one place and makes it easy
 * to distinguish required from optional values.
 */

const DEFAULT_API_URL = 'http://localhost:8080';
const DEV_TEMPORAL_UI_URL = 'http://localhost:8233';

/** Gateway base URL as the browser reaches it. */
export function publicApiUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_API_URL;
}

/**
 * Temporal UI base URL. Dev builds default to localhost; production builds
 * without the variable resolve to '' so the link is hidden rather than pointing
 * at a dead localhost URL.
 */
export function temporalUiUrl(): string {
  return (
    process.env.NEXT_PUBLIC_TEMPORAL_UI_URL ??
    (process.env.NODE_ENV !== 'production' ? DEV_TEMPORAL_UI_URL : '')
  );
}

export function grafanaUrl(): string {
  return process.env.NEXT_PUBLIC_GRAFANA_URL ?? '';
}

/**
 * Gateway base URL for fetches made on the server (Server Components, route
 * handlers). `NEXT_PUBLIC_API_URL` is the address the *browser* uses, which
 * inside Docker is typically `http://localhost:8080` — unreachable from the web
 * container. `API_INTERNAL_URL` names the gateway on the compose network and
 * is never exposed to the browser; it falls back to the public URL so a
 * single-host deployment needs no extra configuration.
 */
export function apiInternalUrl(): string {
  return process.env.API_INTERNAL_URL ?? publicApiUrl();
}
