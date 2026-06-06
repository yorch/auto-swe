/**
 * Scans skill promptText for prompt-injection patterns and common exfiltration
 * techniques. Called when creating or updating custom skills via the gateway.
 *
 * Built-in (isBuiltIn: true) skills are pre-audited and skip this check.
 * For user-defined skills, warnings are non-blocking — admins may still save
 * the skill but are informed of the detected patterns.
 */

const INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { label: 'ignore-previous-instructions', pattern: /ignore\s+(all\s+)?previous\s+instructions/i },
  { label: 'forget-instructions', pattern: /forget\s+(everything|all\s+instructions)/i },
  { label: 'you-are-now', pattern: /you\s+are\s+now\s+(a|an)\s+\w/i },
  { label: 'act-as-override', pattern: /act\s+as\s+(a|an)\s+\w/i },
  {
    label: 'disregard-guidelines',
    pattern: /disregard\s+(your\s+)?(guidelines|instructions|rules)/i,
  },
  { label: 'new-instructions', pattern: /---\s*new\s+instructions\s*---/i },
  { label: 'system-prompt-override', pattern: /\[SYSTEM\]|\bSYSTEM\s*PROMPT\b/i },
];

const EXFILTRATION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { label: 'http-url-in-instruction', pattern: /https?:\/\/[^\s]+/i },
  { label: 'base64-block', pattern: /(?:^|[\s"'`])[A-Za-z0-9+/]{60,}={0,2}(?:$|[\s"'`])/m },
  { label: 'curl-wget', pattern: /\b(curl|wget)\s+/i },
  {
    label: 'send-to-external',
    pattern: /\b(exfiltrat|send\s+to\s+(http|ftp)|transmit\s+(to|via))\b/i,
  },
];

export interface SkillScanResult {
  safe: boolean;
  warnings: string[];
}

/**
 * Returns `{ safe: true, warnings: [] }` when no suspicious patterns are found.
 * Otherwise `safe` is false and `warnings` lists the detected pattern labels.
 */
export function scanSkillContent(promptText: string): SkillScanResult {
  const warnings: string[] = [];

  const check = (patterns: Array<{ pattern: RegExp; label: string }>, prefix: string) => {
    for (const { pattern, label } of patterns) {
      if (pattern.test(promptText)) {
        warnings.push(`${prefix}:${label}`);
      }
    }
  };
  check(INJECTION_PATTERNS, 'injection');
  check(EXFILTRATION_PATTERNS, 'exfiltration');

  return { safe: warnings.length === 0, warnings };
}
