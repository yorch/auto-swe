import type { CodeSecurityFinding } from '@auto-swe/shared/types/workflow';
import { makePatternLoader } from './scannerPatternLoader.js';

export type { CodeSecurityFinding };

const { load: loadCodeSecurityPatterns, invalidate } = makePatternLoader(
  'CODE_SECURITY',
  'codeSecurityScanner'
);

export { invalidate as invalidateCodeSecurityPatternCache };

/**
 * Parses a git unified diff and returns only the added lines with their
 * file name and line number in the new file.
 */
function parseDiffAddedLines(diff: string): Array<{ content: string; file: string; line: number }> {
  const result: Array<{ content: string; file: string; line: number }> = [];
  let currentFile = '';
  let newLineNum = 0;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ b/')) {
      currentFile = raw.slice(6);
      newLineNum = 0;
    } else if (raw.startsWith('@@ ')) {
      const m = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
      if (m) {
        newLineNum = parseInt(m[1], 10) - 1;
      }
    } else if (raw.startsWith('+') && !raw.startsWith('+++')) {
      newLineNum++;
      result.push({ content: raw.slice(1), file: currentFile, line: newLineNum });
    } else if (!raw.startsWith('-')) {
      newLineNum++;
    }
  }

  return result;
}

/**
 * Scans the added lines of a git diff against active CODE_SECURITY patterns.
 * Returns advisory findings — the caller passes them to the security reviewer
 * agent as structured context. This does not block; the review network decides.
 */
export async function scanDiffForCodeIssues(diff: string): Promise<CodeSecurityFinding[]> {
  const patterns = await loadCodeSecurityPatterns();
  if (patterns.length === 0) {
    return [];
  }

  const addedLines = parseDiffAddedLines(diff);
  const findings: CodeSecurityFinding[] = [];

  for (const { content, file, line } of addedLines) {
    for (const { label, re } of patterns) {
      re.lastIndex = 0;
      const m = re.exec(content);
      if (m) {
        findings.push({ file, label, line, match: m[0].slice(0, 120) });
      }
    }
  }

  return findings;
}

/**
 * Formats code security findings as a prompt-injectable string for the
 * security reviewer agent. Returns undefined when there are no findings.
 */
export function formatCodeSecurityFindings(findings: CodeSecurityFinding[]): string | undefined {
  if (findings.length === 0) {
    return undefined;
  }
  const lines = findings.map((f) => `- [${f.label}] ${f.file}:${f.line} — matched: \`${f.match}\``);
  return (
    'STATIC CODE SECURITY SCAN FINDINGS (pre-review pass):\n' +
    lines.join('\n') +
    '\nVerify each finding. Confirmed issues should appear in your verdict findings.'
  );
}
