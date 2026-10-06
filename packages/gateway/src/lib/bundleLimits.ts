/**
 * Bundle size cap, shared by install-from-URL (response body) and the inline preview/install
 * routes (request body), so a bundle that fits one path fits the other. Env-overridable
 * (deploy-time knob).
 */
export function resolveMaxBundleBytes(): number {
  const fromEnv = Number(process.env.BUNDLE_MAX_BYTES);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 5_000_000;
}

/** Headroom for the JSON envelope (`expectedContentHash`, `overwriteProtected`) around a bundle. */
const BODY_ENVELOPE_BYTES = 64 * 1024;

/** Fastify `bodyLimit` for a route that takes a bundle inline. */
export function resolveBundleBodyLimit(): number {
  return resolveMaxBundleBytes() + BODY_ENVELOPE_BYTES;
}
