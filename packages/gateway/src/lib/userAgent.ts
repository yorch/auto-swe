/**
 * Coarse browser and OS families from a User-Agent, for the sign-in analytics. Only the family is
 * kept: the raw header is never stored, because the full string is close to a fingerprint.
 */
export const BROWSERS = ['Chrome', 'Firefox', 'Safari', 'Edge', 'Other'] as const;
export const OPERATING_SYSTEMS = ['Windows', 'macOS', 'Linux', 'iOS', 'Android', 'Other'] as const;
export type BrowserFamily = (typeof BROWSERS)[number];
export type OsFamily = (typeof OPERATING_SYSTEMS)[number];

export function parseUserAgent(ua: string | null | undefined): {
  browser: BrowserFamily;
  os: OsFamily;
} {
  const s = (ua ?? '').slice(0, 512);
  let browser: BrowserFamily = 'Other';
  // Order matters: Edge and Chrome both say Safari, and Edge says Chrome too. Opera says
  // Chrome as well and has no family of its own here.
  if (/OPR\/|Opera/.test(s)) {
    browser = 'Other';
  } else if (/Edg(e|A|iOS)?\//.test(s)) {
    browser = 'Edge';
  } else if (/Firefox\/|FxiOS\//.test(s)) {
    browser = 'Firefox';
  } else if (/Chrome\/|Chromium\/|CriOS\//.test(s)) {
    browser = 'Chrome';
  } else if (/Safari\//.test(s)) {
    browser = 'Safari';
  }
  let os: OsFamily = 'Other';
  if (/iPhone|iPad|iPod/.test(s)) {
    os = 'iOS';
  } else if (/Android/.test(s)) {
    os = 'Android';
  } else if (/Windows/.test(s)) {
    os = 'Windows';
  } else if (/Macintosh|Mac OS X/.test(s)) {
    os = 'macOS';
  } else if (/Linux|X11/.test(s)) {
    os = 'Linux';
  }
  return { browser, os };
}
