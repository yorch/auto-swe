import { publicApiUrl, temporalUiUrl } from './env';

// Shape must match what layout.tsx injects into window.__APP_CONFIG__.
interface AppConfig {
  apiUrl: string;
  temporalUiUrl: string;
}

// Browser-only: reads window.__APP_CONFIG__ injected by the root Server Component
// layout before the JS bundle evaluates. Returns {} during SSR (window undefined).
function windowConfig(): Partial<AppConfig> {
  if (typeof window === 'undefined') {
    return {};
  }
  return (window as unknown as { __APP_CONFIG__?: Partial<AppConfig> }).__APP_CONFIG__ ?? {};
}

// Cookie names shared between the Next.js Edge middleware (proxy.ts) and the
// client auth layer (authStore.ts, api.ts). Centralised so a rename stays
// consistent across all three without a silent auth break.
export const COOKIE_ACCESS_TOKEN = 'accessToken';
export const COOKIE_SESSION_MARKER = 'web-session-active';
// Request headers the proxy sets so Server Components can read the URL, which
// layouts otherwise cannot see: the reauth redirect rebuilds the page's full
// path from both. The proxy always overwrites them, so a client cannot supply its own.
export const PATHNAME_HEADER = 'x-pathname';
export const SEARCH_HEADER = 'x-search';

// The runtime values the root layout injected win; the build-time env defaults
// (one definition, in lib/env.ts) cover SSR and a page without the script.
export const API_BASE = windowConfig().apiUrl ?? publicApiUrl();
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0';
export const IS_DEV = process.env.NODE_ENV !== 'production';
export const TEMPORAL_UI_URL = windowConfig().temporalUiUrl ?? temporalUiUrl();
