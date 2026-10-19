/**
 * Pattern-based PII scrubbing, applied to normalized transcripts at export
 * time (`scrubPii=true`). Strings only; structure is untouched. Not a
 * guarantee — it catches what its patterns catch.
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Explicit phone shapes only: an international `+` prefix or a parenthesized
// area code. Bare digit groups are left alone — a spaced card number or a long
// id must not be eaten as a phone.
const PHONE_RE = /\+\d[\d ().-]{6,}\d|\(\d{2,5}\)[\s.-]?\d[\d .-]{4,}\d/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_RE = /\b(?:[0-9a-fA-F]{1,4}::?){3,}[0-9a-fA-F]{0,4}\b/g;
const CARD_CANDIDATE_RE = /\b\d(?:[\s-]?\d){12,18}\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) {
        d -= 9;
      }
    }
    sum += d;
    double = !double;
  }
  return digits.length >= 13 && digits.length <= 19 && sum % 10 === 0;
}

function scrubString(s: string): string {
  // Cards first: a spaced card number also matches the phone pattern.
  let out = s.replace(CARD_CANDIDATE_RE, (m) =>
    luhnValid(m.replace(/[\s-]/g, '')) ? '[CARD]' : m
  );
  out = out
    .replace(EMAIL_RE, '[EMAIL]')
    .replace(IPV4_RE, '[IP]')
    .replace(IPV6_RE, '[IP]')
    .replace(PHONE_RE, '[PHONE]');
  return out;
}

/** Deep-map every string in a JSON value through the pattern scrubbers. */
export function scrubPii(value: unknown): unknown {
  if (typeof value === 'string') {
    return scrubString(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubPii);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubPii(v)])
    );
  }
  return value;
}
