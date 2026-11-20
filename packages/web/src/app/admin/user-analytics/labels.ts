import type { BadgeTone } from '@/components/ui/Badge';

export const WINDOW_DAYS = [7, 14, 30] as const;
export type WindowDays = (typeof WINDOW_DAYS)[number];
export const DEFAULT_DAYS: WindowDays = 14;

/** The window from a raw URL parameter; anything outside the allowed set is the default. */
export function parseDays(raw: string | null): WindowDays {
  const n = Number(raw);
  return (WINDOW_DAYS as readonly number[]).includes(n) ? (n as WindowDays) : DEFAULT_DAYS;
}

const METHOD_LABEL: Record<string, string> = {
  github: 'GitHub',
  google: 'Google',
  'magic-link': 'Magic link',
  oauth: 'OAuth',
  okta: 'Okta',
  password: 'Password',
  unknown: 'Unknown',
};

export function methodLabel(method: string | null): string {
  return method ? (METHOD_LABEL[method] ?? method) : '—';
}

const REASON_LABEL: Record<string, string> = {
  invalid_credentials: 'Invalid credentials',
  locked: 'Locked',
  other: 'Other',
  unverified: 'Unverified',
};

export function reasonLabel(reason: string | null): string {
  return reason ? (REASON_LABEL[reason] ?? reason) : '—';
}

export const KIND_LABEL: Record<'sign_in' | 'sign_in_failed' | 'sign_out', string> = {
  sign_in: 'Signed in',
  sign_in_failed: 'Failed',
  sign_out: 'Signed out',
};

export const KIND_TONE: Record<'sign_in' | 'sign_in_failed' | 'sign_out', BadgeTone> = {
  sign_in: 'success',
  sign_in_failed: 'danger',
  sign_out: 'muted',
};

export function personLabel(u: { email: string; name: string | null }): string {
  return u.name ? `${u.name} (${u.email})` : u.email;
}
