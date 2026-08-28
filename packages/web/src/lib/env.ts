/**
 * Centralized reads for build-time / public environment variables used by the
 * web dashboard. This keeps `process.env` access in one place and makes it easy
 * to distinguish required from optional values.
 */

export function grafanaUrl(): string {
  return process.env.NEXT_PUBLIC_GRAFANA_URL ?? '';
}
