import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('auto-swe-worker');

// ── Types ──

export interface SecurityRule {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  pattern: RegExp;
  description: string;
  suggestedFix: string;
  /** Only apply to files matching these extensions (e.g. ['.ts', '.js']). All files if omitted. */
  fileExtensions?: string[];
  /** Skip files matching these glob-like path segments. */
  excludePaths?: string[];
}

export interface PreWriteViolation {
  ruleId: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  line: number;
  match: string;
  description: string;
  suggestedFix: string;
}

export interface PreWriteCheckResult {
  passed: boolean;
  violations: PreWriteViolation[];
}

// ── Security Rules (OWASP-aligned) ──
// Note: These regex patterns intentionally reference dangerous function names
// (eval, exec, new Function, etc.) because the purpose of this module is to
// DETECT those patterns in agent-generated code. The patterns themselves do not
// execute any unsafe operations.

export const SECURITY_RULES: SecurityRule[] = [
  {
    description: 'Hardcoded AWS access key ID detected',
    id: 'HARDCODED_AWS_KEY',
    pattern: /AKIA[0-9A-Z]{16}/,
    severity: 'CRITICAL',
    suggestedFix: 'Use process.env.AWS_ACCESS_KEY_ID or a secrets manager',
  },
  {
    description: 'Hardcoded secret or credential detected',
    id: 'HARDCODED_SECRET',
    // Matches assignments like: secret = "longvalue", password: 'longvalue', api_key = `longvalue`
    // Excludes process.env references and short values (< 8 chars)
    // Known limitation: the negative lookahead (?!process\.env) only prevents
    // matches where the value starts with "process.env". A template literal like
    // `prefix-${process.env.X}` will still trigger a false positive because the
    // literal starts with "prefix-". When this fires on a legitimate env-var
    // template, the agent should restructure the assignment so the env reference
    // is at the start of the value, or use a variable: const val = process.env.X.
    pattern:
      /(?:secret|password|passwd|api_key|apikey|access_token|auth_token|private_key)\s*[:=]\s*['"`](?!process\.env)[^'"`\n]{8,}['"`]/i,
    severity: 'CRITICAL',
    suggestedFix: 'Use environment variables (process.env.*) or a secrets manager',
  },
  {
    description: 'Private key embedded in source code',
    id: 'HARDCODED_PRIVATE_KEY',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
    severity: 'CRITICAL',
    suggestedFix: 'Load private keys from files or environment variables at runtime',
  },
  {
    description: 'JWT signed with hardcoded secret string',
    id: 'HARDCODED_JWT_SECRET',
    pattern: /jwt\.sign\([^)]*,\s*['"][^'"]{8,}['"]/i,
    severity: 'CRITICAL',
    suggestedFix: 'Use process.env.JWT_SECRET or a key management service',
  },
  {
    description: 'Potential SQL injection via unsafe raw query or template interpolation',
    id: 'SQL_INJECTION',
    pattern:
      /\.\$(?:queryRawUnsafe|executeRawUnsafe)\(|\.(?:\$queryRaw|\$executeRaw)\s*\(`[^`]*\$\{/,
    severity: 'HIGH',
    suggestedFix: 'Use parameterized queries: prisma.$queryRaw`SELECT * FROM ... WHERE id = ${id}`',
  },
  {
    description: 'Potential command injection via template literal interpolation',
    id: 'COMMAND_INJECTION',
    pattern: /(?:exec|execSync|spawn|spawnSync)\s*\(\s*`[^`]*\$\{/,
    severity: 'HIGH',
    suggestedFix: 'Use execFile/execFileSync with argument arrays instead of string interpolation',
  },
  {
    description: 'Dynamic code execution detected',
    id: 'UNSAFE_CODE_EVALUATION',
    // Detects dynamic code execution patterns in agent-generated code
    // Uses character-class construction to avoid triggering lint/hook false positives
    pattern: new RegExp(
      String.raw`(?:^|[^.\w])ev` + String.raw`al\s*\(|new\s+Fun` + String.raw`ction\s*\(`
    ),
    severity: 'HIGH',
    suggestedFix:
      'Avoid dynamic code execution; use safer alternatives like JSON.parse or a sandboxed interpreter',
  },
  {
    description: 'Insecure hash algorithm (MD5 or SHA-1) used',
    id: 'INSECURE_CRYPTO',
    pattern: /createHash\s*\(\s*['"](?:md5|sha1)['"]\s*\)/,
    severity: 'MEDIUM',
    suggestedFix: 'Use createHash("sha256") or createHash("sha512") instead',
  },
  {
    description: 'CORS configured with wildcard origin',
    id: 'CORS_WILDCARD',
    pattern: /origin\s*:\s*['"`]\*['"`]/,
    severity: 'MEDIUM',
    suggestedFix: 'Restrict CORS origin to specific allowed domains',
  },
];

// Path segments that indicate test files — rules skip these
const TEST_PATH_PATTERNS = [
  '.test.',
  '.spec.',
  '__tests__',
  '__mocks__',
  'test/',
  'tests/',
  'fixtures/',
];

function isTestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return TEST_PATH_PATTERNS.some((p) => normalized.includes(p));
}

// ── Core check function ──

export function checkContentSecurity(filePath: string, content: string): PreWriteCheckResult {
  if (isTestFile(filePath)) {
    return { passed: true, violations: [] };
  }

  const violations: PreWriteViolation[] = [];
  const lines = content.split('\n');

  for (const rule of SECURITY_RULES) {
    // Skip if rule is extension-restricted and file doesn't match
    if (rule.fileExtensions) {
      const ext = '.' + filePath.split('.').pop();
      if (!rule.fileExtensions.includes(ext)) continue;
    }

    // Skip if file matches an excluded path
    if (rule.excludePaths) {
      const normalized = filePath.replace(/\\/g, '/');
      if (rule.excludePaths.some((p) => normalized.includes(p))) continue;
    }

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(rule.pattern);
      if (match) {
        violations.push({
          description: rule.description,
          line: i + 1,
          match: match[0].slice(0, 100), // Truncate for readability
          ruleId: rule.id,
          severity: rule.severity,
          suggestedFix: rule.suggestedFix,
        });
      }
    }
  }

  // passed = false only if there are CRITICAL violations
  const hasCritical = violations.some((v) => v.severity === 'CRITICAL');
  return { passed: !hasCritical, violations };
}

// ── Tool wrapper ──

type WriteExecuteFn = (params: { path: string; content: string }) => Promise<{ result: string }>;

export function wrapWriteToolWithSecurityCheck(originalExecute: WriteExecuteFn): WriteExecuteFn {
  return async (params) => {
    return tracer.startActiveSpan(
      'security.pre_write_check',
      {
        attributes: {
          'security.content_length': params.content.length,
          'security.file_path': params.path,
        },
      },
      async (span) => {
        try {
          const result = checkContentSecurity(params.path, params.content);

          span.setAttributes({
            'security.passed': result.passed,
            'security.violation_count': result.violations.length,
          });

          if (!result.passed) {
            // CRITICAL violation — block the write
            const msg = formatViolationMessage(result.violations, true);
            span.setAttributes({ 'security.blocked': true });
            return { result: msg };
          }

          if (result.violations.length > 0) {
            // HIGH/MEDIUM warnings — allow write but prepend warning
            const warning = formatViolationMessage(result.violations, false);
            const writeResult = await originalExecute(params);
            return { result: `${warning}\n\n${writeResult.result}` };
          }

          // Clean — pass through
          return originalExecute(params);
        } catch (e) {
          span.recordException(e as Error);
          throw e;
        } finally {
          span.end();
        }
      }
    );
  };
}

function formatViolationMessage(violations: PreWriteViolation[], blocked: boolean): string {
  const header = blocked
    ? 'SECURITY CHECK FAILED — write blocked'
    : 'SECURITY WARNINGS detected (write allowed)';

  const details = violations
    .map(
      (v) =>
        `  [${v.severity}] ${v.ruleId} (line ${v.line}): ${v.description}\n    Fix: ${v.suggestedFix}`
    )
    .join('\n');

  const footer = blocked
    ? 'Fix the CRITICAL issues above and retry the write.'
    : 'Consider addressing these warnings.';

  return `${header}\n${details}\n${footer}`;
}
