/**
 * Decode and sanity-check a Next.js dynamic route parameter before it is used
 * in API calls or passed into hooks. Returns null for missing, non-string, or
 * empty values so callers can render a safe "not found" state.
 */
export function validateRouteParam(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return null;
  }
  return decodeURIComponent(raw);
}
