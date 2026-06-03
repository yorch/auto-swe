// Shape must match what layout.tsx injects into window.__APP_CONFIG__.
interface AppConfig {
  apiUrl: string;
  temporalUiUrl: string;
}

// Browser-only: reads window.__APP_CONFIG__ injected by the root Server Component
// layout before the JS bundle evaluates. Returns {} during SSR (window undefined).
function windowConfig(): Partial<AppConfig> {
  if (typeof window === 'undefined') return {};
  return (window as unknown as { __APP_CONFIG__?: Partial<AppConfig> }).__APP_CONFIG__ ?? {};
}

// Cookie names shared between the Next.js Edge middleware (proxy.ts) and the
// client auth layer (authStore.ts, api.ts). Centralised so a rename stays
// consistent across all three without a silent auth break.
export const COOKIE_ACCESS_TOKEN = 'accessToken';
export const COOKIE_SESSION_MARKER = 'web-session-active';

export const API_BASE =
  windowConfig().apiUrl ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0';
export const IS_DEV = process.env.NODE_ENV !== 'production';
// Dev builds default to localhost; prod builds without the env var resolve to ''
// so the Temporal UI link is hidden rather than pointing at a dead localhost URL.
export const TEMPORAL_UI_URL =
  windowConfig().temporalUiUrl ??
  process.env.NEXT_PUBLIC_TEMPORAL_UI_URL ??
  (process.env.NODE_ENV !== 'production' ? 'http://localhost:8233' : '');
