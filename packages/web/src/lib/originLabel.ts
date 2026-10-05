/** Plain-language provenance for an agent's or skill's `origin` (null means created in the app). */
export function originLabel(origin: string | null): string {
  if (!origin) {
    return 'Custom';
  }
  return origin === 'swe-starter' ? 'Engineering starter' : origin;
}
