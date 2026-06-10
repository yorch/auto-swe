import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    scannerPattern: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from '@auto-swe/shared/db';
import {
  formatCodeSecurityFindings,
  invalidateCodeSecurityPatternCache,
  scanDiffForCodeIssues,
} from './codeSecurityScanner.js';

const findMany = vi.mocked(prisma.scannerPattern.findMany);

// Test snippets are built via concatenation so this file's own content does not
// trigger content-security tooling (same convention as preWriteSecurityCheck.test.ts).
const EVAL_CALL = `ev${'al'}(userInput)`;
const NEW_FUNCTION_CALL = `new Fun${'ction'}("return 1")`;

// Verbatim copy of the built-in CODE_SECURITY patterns from
// packages/shared/src/scannerPatterns/index.ts (BUILTIN_SCANNER_PATTERNS is not
// reachable through the shared package's export map from the worker package, so
// the shipped definitions are mirrored here to verify the real patterns).
const BUILTIN_CODE_SECURITY_PATTERNS = [
  { flags: 'i', label: 'code-dangerouslysetinnerhtml', pattern: 'dangerouslySetInnerHTML' },
  {
    flags: 'i',
    label: 'code-innerhtml-assignment',
    pattern: '\\.innerHTML\\s*=(?!\\s*["\']\\s*["\'])',
  },
  {
    flags: 'i',
    label: 'code-subprocess-shell-true',
    pattern: 'subprocess\\.(?:call|run|Popen)\\s*\\([^)]*shell\\s*=\\s*True',
  },
  {
    flags: 'i',
    label: 'code-tls-skip-verify',
    pattern:
      'InsecureSkipVerify\\s*:\\s*true|verify\\s*=\\s*False|InsecureRequestWarning|rejectUnauthorized\\s*:\\s*false',
  },
  {
    flags: 'i',
    label: 'code-eval-exec',
    pattern: '(?:^|[^.\\w])eval\\s*\\(|new\\s+Function\\s*\\(',
  },
  {
    flags: 'i',
    label: 'code-weak-crypto',
    pattern: 'createHash\\s*\\(\\s*[\'"](?:md5|sha1)[\'"]',
  },
  { flags: 'i', label: 'code-cors-wildcard', pattern: 'origin\\s*:\\s*[\'"`]\\*[\'"`]' },
  {
    flags: 'i',
    label: 'code-open-redirect',
    pattern: '\\.redirect\\s*\\([^)]*req\\.(?:query|body|params)\\.',
  },
  {
    flags: 'i',
    label: 'code-hardcoded-credential',
    pattern:
      '(?:secret|password|passwd|api_key|apikey|access_token|auth_token)\\s*[:=]\\s*[\'"`](?!process\\.env)[^\'"`\\n]{8,}[\'"`]',
  },
  {
    flags: 'i',
    label: 'code-jwt-hardcoded-secret',
    pattern: 'jwt\\.sign\\s*\\([^)]*,\\s*[\'"][^\'"]{8,}[\'"]',
  },
];

function mockPatternRows(rows: Array<{ flags: string; label: string; pattern: string }>): void {
  findMany.mockResolvedValue(
    rows.map((r, i) => ({
      flags: r.flags,
      id: `p-${i}`,
      isActive: true,
      label: r.label,
      pattern: r.pattern,
      type: 'CODE_SECURITY',
    })) as never
  );
}

/** Builds a minimal unified diff for a single file. */
function diffFor(file: string, hunkHeader: string, lines: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    hunkHeader,
    ...lines,
  ].join('\n');
}

beforeEach(() => {
  invalidateCodeSecurityPatternCache();
  findMany.mockReset();
  mockPatternRows(BUILTIN_CODE_SECURITY_PATTERNS);
});

describe('scanDiffForCodeIssues — flags risky added lines', () => {
  it.each([
    [`const result = ${EVAL_CALL};`, 'code-eval-exec'],
    [`const fn = ${NEW_FUNCTION_CALL};`, 'code-eval-exec'],
    ['document.body.innerHTML = userHtml;', 'code-innerhtml-assignment'],
    ['<div dangerouslySetInnerHTML={{ __html: html }} />', 'code-dangerouslysetinnerhtml'],
    ['subprocess.run(cmd, shell=True)', 'code-subprocess-shell-true'],
    ['requests.get(url, verify=False)', 'code-tls-skip-verify'],
    ['const agent = { rejectUnauthorized: false };', 'code-tls-skip-verify'],
    ["const hash = createHash('md5');", 'code-weak-crypto'],
    ["app.use(cors({ origin: '*' }));", 'code-cors-wildcard'],
    ['res.redirect(req.query.next);', 'code-open-redirect'],
    ['const password = "hunter2hunter2";', 'code-hardcoded-credential'],
    ['const token = jwt.sign(payload, "abcdef-secret-123");', 'code-jwt-hardcoded-secret'],
  ])('finds %j as [%s]', async (line, label) => {
    const diff = diffFor('src/app.ts', '@@ -1,1 +1,2 @@', [' const keep = 1;', `+${line}`]);
    const findings = await scanDiffForCodeIssues(diff);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: 'src/app.ts', label, line: 2 });
  });

  it('ignores removed and context lines even when they contain risky code', async () => {
    const diff = diffFor('src/app.ts', '@@ -1,3 +1,2 @@', [
      ` const a = ${EVAL_CALL};`,
      `-const b = ${EVAL_CALL};`,
      '+const c = 3;',
    ]);
    await expect(scanDiffForCodeIssues(diff)).resolves.toEqual([]);
  });

  it('does not flag benign added lines', async () => {
    const diff = diffFor('src/app.ts', '@@ -1,1 +1,4 @@', [
      ' const keep = 1;',
      "+const hash = createHash('sha256');",
      "+el.innerHTML = '';", // clearing innerHTML is excluded by the lookahead
      '+const secret = process.env.MY_SECRET;',
    ]);
    await expect(scanDiffForCodeIssues(diff)).resolves.toEqual([]);
  });

  it('reports correct line numbers across multiple hunks', async () => {
    const diff = [
      'diff --git a/src/db.py b/src/db.py',
      '--- a/src/db.py',
      '+++ b/src/db.py',
      '@@ -1,2 +1,3 @@',
      ' import subprocess',
      '+subprocess.run(cmd, shell=True)',
      ' import requests',
      '@@ -10,2 +20,3 @@',
      ' def fetch():',
      '+    return requests.get(url, verify=False)',
      ' # end',
    ].join('\n');
    const findings = await scanDiffForCodeIssues(diff);
    expect(findings).toEqual([
      expect.objectContaining({ file: 'src/db.py', label: 'code-subprocess-shell-true', line: 2 }),
      expect.objectContaining({ file: 'src/db.py', label: 'code-tls-skip-verify', line: 21 }),
    ]);
  });

  it('attributes findings to the right file in a multi-file diff', async () => {
    const diff = [
      diffFor('src/a.ts', '@@ -0,0 +1,1 @@', [`+const x = ${EVAL_CALL};`]),
      diffFor('src/b.ts', '@@ -0,0 +1,2 @@', [
        '+const ok = 1;',
        "+app.use(cors({ origin: '*' }));",
      ]),
    ].join('\n');
    const findings = await scanDiffForCodeIssues(diff);
    expect(findings).toEqual([
      expect.objectContaining({ file: 'src/a.ts', label: 'code-eval-exec', line: 1 }),
      expect.objectContaining({ file: 'src/b.ts', label: 'code-cors-wildcard', line: 2 }),
    ]);
  });

  it('emits one finding per matching pattern when a line trips several', async () => {
    const diff = diffFor('src/x.ts', '@@ -0,0 +1,1 @@', [`+el.innerHTML = ${EVAL_CALL};`]);
    const findings = await scanDiffForCodeIssues(diff);
    expect(findings.map((f) => f.label).sort()).toEqual([
      'code-eval-exec',
      'code-innerhtml-assignment',
    ]);
  });

  it('truncates the matched text to 120 characters', async () => {
    const longValue = 'a'.repeat(200);
    const diff = diffFor('src/x.ts', '@@ -0,0 +1,1 @@', [`+const password = "${longValue}";`]);
    const findings = await scanDiffForCodeIssues(diff);
    expect(findings).toHaveLength(1);
    expect(findings[0].match).toHaveLength(120);
  });

  it('returns [] for an empty diff', async () => {
    await expect(scanDiffForCodeIssues('')).resolves.toEqual([]);
  });

  it('returns [] without scanning when no patterns are active', async () => {
    findMany.mockReset();
    mockPatternRows([]);
    const diff = diffFor('src/x.ts', '@@ -0,0 +1,1 @@', [`+const x = ${EVAL_CALL};`]);
    await expect(scanDiffForCodeIssues(diff)).resolves.toEqual([]);
  });

  it('propagates DB errors (the post-commit activity call site handles them)', async () => {
    findMany.mockReset();
    findMany.mockRejectedValue(new Error('db down'));
    await expect(scanDiffForCodeIssues('+x')).rejects.toThrow('db down');
  });
});

describe('formatCodeSecurityFindings', () => {
  it('returns undefined when there are no findings', () => {
    expect(formatCodeSecurityFindings([])).toBeUndefined();
  });

  it('formats findings as a prompt fragment for the security reviewer', () => {
    const text = formatCodeSecurityFindings([
      { file: 'src/a.ts', label: 'code-eval-exec', line: 7, match: ' ev' },
      { file: 'src/b.ts', label: 'code-cors-wildcard', line: 2, match: "origin: '*'" },
    ]);
    expect(text).toContain('STATIC CODE SECURITY SCAN FINDINGS');
    expect(text).toContain('[code-eval-exec] src/a.ts:7');
    expect(text).toContain("[code-cors-wildcard] src/b.ts:2 — matched: `origin: '*'`");
    expect(text).toContain('Verify each finding.');
  });
});
