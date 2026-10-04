import { scanSkillContent } from '@auto-swe/shared/lib/skillScanner';

export const SCAN_INCOMPLETE = 'scan-incomplete: some patterns could not be evaluated';

/**
 * Advisory scan of a skill's model-visible text (description, then prompt text)
 * over every character. Never throws and never reports a partial scan as clean:
 * a scanner failure, an overrun or a quarantined pattern adds `scan-incomplete`,
 * so an empty list means every rule ran over everything.
 */
export async function scanSkillAdvisory(
  description: string | null | undefined,
  promptText: string
): Promise<string[]> {
  try {
    const scan = await scanSkillContent(`${description ?? ''}\n${promptText}`, { full: true });
    return scan.incomplete ? [...scan.warnings, SCAN_INCOMPLETE] : scan.warnings;
  } catch {
    return [SCAN_INCOMPLETE];
  }
}
