export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0';
export const IS_DEV = process.env.NODE_ENV !== 'production';
// Dev builds default to localhost; prod builds without the env var resolve to ''
// so the Temporal UI link is hidden rather than pointing at a dead localhost URL.
export const TEMPORAL_UI_URL =
  process.env.NEXT_PUBLIC_TEMPORAL_UI_URL ??
  (process.env.NODE_ENV !== 'production' ? 'http://localhost:8233' : '');
