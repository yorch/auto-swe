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

export interface SupportInfo {
  url?: string;
  email?: string;
  slack?: { text: string; href?: string };
}

const SLACK_MAX_LENGTH = 80;

function httpsHref(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function validEmail(value: string): boolean {
  return value.split('@').length === 2 && !/[\s<>"']/.test(value) && !value.startsWith('@');
}

/**
 * Operator-supplied support contacts, validated on the server. Invalid values
 * are dropped with one warning; returns undefined when nothing valid is set.
 * Must be read on the server and passed to the browser through the layout's
 * app config: a client-side `process.env.NEXT_PUBLIC_*` read is inlined at
 * build time.
 */
export function supportInfo(): SupportInfo | undefined {
  const rawUrl = process.env.NEXT_PUBLIC_SUPPORT_URL?.trim();
  const rawEmail = process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim();
  const rawSlack = process.env.NEXT_PUBLIC_SUPPORT_SLACK?.trim();
  const info: SupportInfo = {};
  const dropped: string[] = [];

  if (rawUrl) {
    const href = httpsHref(rawUrl);
    if (href) {
      info.url = href;
    } else {
      dropped.push('NEXT_PUBLIC_SUPPORT_URL');
    }
  }
  if (rawEmail) {
    if (validEmail(rawEmail)) {
      info.email = rawEmail;
    } else {
      dropped.push('NEXT_PUBLIC_SUPPORT_EMAIL');
    }
  }
  if (rawSlack) {
    if (rawSlack.length <= SLACK_MAX_LENGTH) {
      const href = httpsHref(rawSlack);
      info.slack = href ? { href, text: rawSlack } : { text: rawSlack };
    } else {
      dropped.push('NEXT_PUBLIC_SUPPORT_SLACK');
    }
  }

  if (dropped.length > 0) {
    console.warn(`Ignoring invalid support contact setting(s): ${dropped.join(', ')}`);
  }
  return Object.keys(info).length > 0 ? info : undefined;
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
