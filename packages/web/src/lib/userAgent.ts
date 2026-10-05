/**
 * A short "Chrome · macOS" reading of a User-Agent header. Order matters:
 * Edge and Opera also say "Chrome", and Chrome also says "Safari"; Android and
 * iOS also say "Linux" / "Mac OS X".
 */
const BROWSERS: [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
  [/curl\//, 'curl'],
];

const SYSTEMS: [RegExp, string][] = [
  [/Android/, 'Android'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

export function describeUserAgent(userAgent: string): string {
  const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(userAgent))?.[1];
  const parts = [browser, system].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(' · ') : 'Unknown device';
}
