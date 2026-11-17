import { scanSkillContent } from '@auto-swe/shared/lib/skillScanner';

export interface LaunchDescriptionScan {
  suspicious: boolean;
  /** Stable pattern identifiers (`injection:<label>`) only; never matched text or the description. */
  matches: string[];
  /** True when the scan could not run every rule (budget, quarantine, load failure, or error). */
  incomplete: boolean;
}

export interface LaunchWarning {
  code: 'DESCRIPTION_INJECTION_SUSPECTED';
  message: string;
}

const LAUNCH_WARNING_MESSAGE =
  'The description contains text that resembles prompt-injection patterns. The run proceeds, and this is recorded in the audit log.';

/**
 * Advisory prompt-injection scan of a user-typed launch description. Never blocks a launch and
 * never throws.
 *
 * Only INJECTION patterns apply, deliberately narrower than `scanSkillContent`'s default of
 * INJECTION + EXFILTRATION. The EXFILTRATION set is written for prose, but it matches things an
 * ordinary description contains (any `http(s)://` URL, "host ", "dig ", "curl ", `/etc/hosts`),
 * so it would flag most tickets and train users to ignore the warning. Injection phrasing
 * ("ignore previous instructions") is the signal for a description.
 *
 * Input is capped by `scanSkillContent` (`capScanText`) because the scan is advisory.
 */
export async function scanLaunchDescription(text: string): Promise<LaunchDescriptionScan> {
  try {
    const result = await scanSkillContent(text, { types: ['INJECTION'] });
    return {
      incomplete: result.incomplete,
      matches: [...result.warnings],
      suspicious: result.warnings.length > 0,
    };
  } catch {
    return { incomplete: true, matches: [], suspicious: false };
  }
}

/** User-facing warnings for a scan; a fixed message that does not echo matches. */
export function launchWarningsFor(scan: LaunchDescriptionScan): LaunchWarning[] {
  return scan.suspicious
    ? [{ code: 'DESCRIPTION_INJECTION_SUSPECTED', message: LAUNCH_WARNING_MESSAGE }]
    : [];
}
