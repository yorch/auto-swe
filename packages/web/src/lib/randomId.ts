/**
 * A fresh random id. `crypto.randomUUID` exists only in secure contexts (https or
 * localhost), and the dashboard may be served over plain http, so fall back to
 * `getRandomValues`, which is available everywhere. Call this rather than
 * `crypto.randomUUID` anywhere in the dashboard.
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
