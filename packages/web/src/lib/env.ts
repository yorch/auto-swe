/**
 * Centralized reads for build-time / public environment variables used by the
 * web dashboard. This keeps `process.env` access in one place and makes it easy
 * to distinguish required from optional values.
 */

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
  return process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';
}
