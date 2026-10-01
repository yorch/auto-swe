// Type-only: `@auto-swe/shared/bundle` imports node:crypto, which must not
// reach the client bundle. `typeof` on a type-only import still ties this
// module to the shared list at compile time.
import type { SCANNER_PATTERN_TYPES } from '@auto-swe/shared/bundle';

export type ScannerPatternType = (typeof SCANNER_PATTERN_TYPES)[number];

interface PatternTypeInfo {
  /** Short label for the type picker. */
  label: string;
  /** Section heading on the scanner page. */
  title: string;
  /** Where the pattern runs and what a match does. */
  description: string;
}

/**
 * One entry per shared scanner pattern type. A `Record` over the shared union
 * makes a type added in shared a compile error here until it is described,
 * instead of a type the admin page silently cannot show or create.
 */
export const SCANNER_PATTERN_TYPE_INFO: Record<ScannerPatternType, PatternTypeInfo> = {
  CODE_SECURITY: {
    description:
      'Checked against added lines in the final diff. Findings are advisory — passed to the security reviewer agent as structured context.',
    label: 'Code Security (diff review)',
    title: 'Code Security Patterns',
  },
  EXFILTRATION: {
    description:
      'Checked when custom skill content is saved and against LLM output. Detects attempts to exfiltrate data via skill prompts. Advisory.',
    label: 'Exfiltration (skill content)',
    title: 'Exfiltration Patterns',
  },
  INJECTION: {
    description:
      'Checked when custom skill content is saved and against LLM output. Detects attempts to override agent instructions. Advisory.',
    label: 'Injection (skill content)',
    title: 'Injection Patterns',
  },
  PII: {
    description:
      'Used by the pii eval scorer: an eval node fails when its target output matches an active pattern.',
    label: 'PII (eval scorer)',
    title: 'PII Patterns',
  },
  SENSITIVE_FILE: {
    description:
      'Checked against file paths before each writeFile call and against write targets in bash commands. Matches are hard-blocked.',
    label: 'Sensitive File (write block)',
    title: 'Sensitive File Patterns',
  },
  SHELL_COMMAND: {
    description:
      'Checked before each bash tool invocation. Dangerous matches are soft-blocked — the agent receives an error and can self-correct.',
    label: 'Shell Command (bash tool)',
    title: 'Shell Command Patterns',
  },
};

/** Display order on the scanner page and in the type picker. */
export const SCANNER_PATTERN_TYPE_ORDER: readonly ScannerPatternType[] = [
  'INJECTION',
  'EXFILTRATION',
  'SHELL_COMMAND',
  'CODE_SECURITY',
  'SENSITIVE_FILE',
  'PII',
];

export function isScannerPatternType(value: string): value is ScannerPatternType {
  return Object.hasOwn(SCANNER_PATTERN_TYPE_INFO, value);
}
