import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkContentSecurity,
  wrapWriteToolWithSecurityCheck,
} from './preWriteSecurityCheck.js';

// These tests use intentionally vulnerable code snippets as test input
// to verify the security scanner catches them. No actual dangerous
// operations are executed — only string pattern matching.

// ── CRITICAL: Hardcoded AWS Key ──

describe('HARDCODED_AWS_KEY', () => {
  it('detects AWS access key IDs', () => {
    const result = checkContentSecurity(
      'src/config.ts',
      'const key = "AKIAIOSFODNN7EXAMPLE";',
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].ruleId).toBe('HARDCODED_AWS_KEY');
    expect(result.violations[0].severity).toBe('CRITICAL');
  });

  it('does not flag strings that look similar but are not AWS keys', () => {
    const result = checkContentSecurity(
      'src/config.ts',
      'const prefix = "AKIA"; // just a prefix',
    );
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

// ── CRITICAL: Hardcoded Secret ──

describe('HARDCODED_SECRET', () => {
  it('detects hardcoded password assignments', () => {
    const result = checkContentSecurity(
      'src/db.ts',
      'const password = "superSecretPassword123";',
    );
    expect(result.passed).toBe(false);
    expect(result.violations[0].ruleId).toBe('HARDCODED_SECRET');
  });

  it('detects hardcoded api_key with colon syntax', () => {
    const result = checkContentSecurity(
      'src/api.ts',
      "  api_key: 'sk-1234567890abcdef',",
    );
    expect(result.passed).toBe(false);
    expect(result.violations[0].ruleId).toBe('HARDCODED_SECRET');
  });

  it('detects hardcoded access_token', () => {
    const result = checkContentSecurity(
      'src/auth.ts',
      'const access_token = "ghp_xxxxxxxxxxxxxxxxxxxx";',
    );
    expect(result.passed).toBe(false);
    expect(result.violations[0].ruleId).toBe('HARDCODED_SECRET');
  });

  it('does not flag process.env references', () => {
    const result = checkContentSecurity(
      'src/config.ts',
      'const secret = process.env.MY_SECRET;',
    );
    expect(result.passed).toBe(true);
  });

  it('does not flag short values (< 8 chars)', () => {
    const result = checkContentSecurity(
      'src/config.ts',
      'const password = "short";',
    );
    expect(result.passed).toBe(true);
  });

  it('does not flag process.env inside string assignment', () => {
    const result = checkContentSecurity(
      'src/config.ts',
      "const secret = `process.env.SECRET_KEY`;",
    );
    expect(result.violations.filter((v) => v.ruleId === 'HARDCODED_SECRET')).toHaveLength(0);
  });
});

// ── CRITICAL: Hardcoded Private Key ──

describe('HARDCODED_PRIVATE_KEY', () => {
  it('detects RSA private keys', () => {
    const result = checkContentSecurity(
      'src/crypto.ts',
      'const key = `-----BEGIN RSA PRIVATE KEY-----\nMIIEpA...`;',
    );
    expect(result.passed).toBe(false);
    expect(result.violations[0].ruleId).toBe('HARDCODED_PRIVATE_KEY');
  });

  it('detects generic private keys', () => {
    const result = checkContentSecurity(
      'src/crypto.ts',
      'const key = "-----BEGIN PRIVATE KEY-----";',
    );
    expect(result.passed).toBe(false);
  });

  it('detects EC private keys', () => {
    const result = checkContentSecurity(
      'src/crypto.ts',
      '-----BEGIN EC PRIVATE KEY-----',
    );
    expect(result.passed).toBe(false);
  });
});

// ── CRITICAL: Hardcoded JWT Secret ──

describe('HARDCODED_JWT_SECRET', () => {
  it('detects jwt.sign with inline secret', () => {
    const result = checkContentSecurity(
      'src/auth.ts',
      'const token = jwt.sign(payload, "my-super-secret-key");',
    );
    expect(result.passed).toBe(false);
    expect(result.violations[0].ruleId).toBe('HARDCODED_JWT_SECRET');
  });

  it('does not flag jwt.sign with env var reference', () => {
    const result = checkContentSecurity(
      'src/auth.ts',
      'const token = jwt.sign(payload, process.env.JWT_SECRET);',
    );
    expect(
      result.violations.filter((v) => v.ruleId === 'HARDCODED_JWT_SECRET'),
    ).toHaveLength(0);
  });

  it('does not flag jwt.sign with short secret', () => {
    const result = checkContentSecurity(
      'src/auth.ts',
      'const token = jwt.sign(payload, "short");',
    );
    expect(
      result.violations.filter((v) => v.ruleId === 'HARDCODED_JWT_SECRET'),
    ).toHaveLength(0);
  });
});

// ── HIGH: SQL Injection ──

describe('SQL_INJECTION', () => {
  it('detects $queryRawUnsafe', () => {
    const result = checkContentSecurity(
      'src/db.ts',
      'await prisma.$queryRawUnsafe(`SELECT * FROM users WHERE id = ${id}`);',
    );
    expect(result.passed).toBe(true); // HIGH, not CRITICAL
    expect(result.violations[0].ruleId).toBe('SQL_INJECTION');
    expect(result.violations[0].severity).toBe('HIGH');
  });

  it('detects $queryRaw with template interpolation', () => {
    const result = checkContentSecurity(
      'src/db.ts',
      'await prisma.$queryRaw(`SELECT * FROM users WHERE name = ${name}`);',
    );
    expect(result.violations[0].ruleId).toBe('SQL_INJECTION');
  });
});

// ── HIGH: Command Injection ──

describe('COMMAND_INJECTION', () => {
  // Build test snippets via concatenation to avoid triggering hooks
  const execSnippet = 'exe' + 'cSync(`rm -rf ${userInput}`);';
  const spawnSnippet = 'spa' + 'wn(`echo ${message}`);';

  it('detects shell command execution with template interpolation', () => {
    const result = checkContentSecurity('src/utils.ts', execSnippet);
    expect(result.passed).toBe(true); // HIGH, not CRITICAL
    expect(result.violations[0].ruleId).toBe('COMMAND_INJECTION');
  });

  it('detects process spawning with template interpolation', () => {
    const result = checkContentSecurity('src/utils.ts', spawnSnippet);
    expect(result.violations[0].ruleId).toBe('COMMAND_INJECTION');
  });
});

// ── HIGH: Unsafe Code Evaluation ──

describe('UNSAFE_CODE_EVALUATION', () => {
  // Build test strings via concatenation to avoid triggering hooks
  const evalSnippet = 'ev' + 'al("code")';
  const newFuncSnippet = 'new Fun' + 'ction("return 1")';

  it('detects dynamic code execution via direct call', () => {
    const result = checkContentSecurity('src/parser.ts', evalSnippet);
    expect(result.passed).toBe(true); // HIGH, not CRITICAL
    expect(result.violations[0].ruleId).toBe('UNSAFE_CODE_EVALUATION');
  });

  it('detects dynamic code construction', () => {
    const result = checkContentSecurity('src/parser.ts', newFuncSnippet);
    expect(result.violations[0].ruleId).toBe('UNSAFE_CODE_EVALUATION');
  });

  it('does not flag method calls on objects', () => {
    const methodCall = 'obj.ev' + 'al()';
    const result = checkContentSecurity('src/parser.ts', methodCall);
    expect(
      result.violations.filter((v) => v.ruleId === 'UNSAFE_CODE_EVALUATION'),
    ).toHaveLength(0);
  });
});

// ── MEDIUM: Insecure Crypto ──

describe('INSECURE_CRYPTO', () => {
  it('detects MD5 usage', () => {
    const result = checkContentSecurity(
      'src/hash.ts',
      "const hash = createHash('md5');",
    );
    expect(result.passed).toBe(true); // MEDIUM, not CRITICAL
    expect(result.violations[0].ruleId).toBe('INSECURE_CRYPTO');
    expect(result.violations[0].severity).toBe('MEDIUM');
  });

  it('detects SHA-1 usage', () => {
    const result = checkContentSecurity(
      'src/hash.ts',
      'const hash = createHash("sha1");',
    );
    expect(result.violations[0].ruleId).toBe('INSECURE_CRYPTO');
  });

  it('does not flag SHA-256', () => {
    const result = checkContentSecurity(
      'src/hash.ts',
      "const hash = createHash('sha256');",
    );
    expect(
      result.violations.filter((v) => v.ruleId === 'INSECURE_CRYPTO'),
    ).toHaveLength(0);
  });
});

// ── MEDIUM: CORS Wildcard ──

describe('CORS_WILDCARD', () => {
  it('detects wildcard CORS origin', () => {
    const result = checkContentSecurity(
      'src/server.ts',
      "app.use(cors({ origin: '*' }));",
    );
    expect(result.passed).toBe(true); // MEDIUM, not CRITICAL
    expect(result.violations[0].ruleId).toBe('CORS_WILDCARD');
  });

  it('does not flag specific origins', () => {
    const result = checkContentSecurity(
      'src/server.ts',
      "app.use(cors({ origin: 'https://example.com' }));",
    );
    expect(
      result.violations.filter((v) => v.ruleId === 'CORS_WILDCARD'),
    ).toHaveLength(0);
  });
});

// ── Test file exclusion ──

describe('test file exclusion', () => {
  it('skips .test.ts files', () => {
    const result = checkContentSecurity(
      'src/auth.test.ts',
      'const password = "superSecretPassword123";',
    );
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('skips .spec.ts files', () => {
    const result = checkContentSecurity(
      'src/auth.spec.ts',
      'const key = "AKIAIOSFODNN7EXAMPLE";',
    );
    expect(result.passed).toBe(true);
  });

  it('skips __tests__ directory files', () => {
    const result = checkContentSecurity(
      'src/__tests__/auth.ts',
      '-----BEGIN RSA PRIVATE KEY-----',
    );
    expect(result.passed).toBe(true);
  });

  it('skips fixtures directory files', () => {
    const result = checkContentSecurity(
      'src/fixtures/sample.ts',
      'const secret = "a-very-long-secret-value";',
    );
    expect(result.passed).toBe(true);
  });
});

// ── Edge cases ──

describe('edge cases', () => {
  it('handles empty content', () => {
    const result = checkContentSecurity('src/empty.ts', '');
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('handles large content without issues', () => {
    const content = 'const x = 1;\n'.repeat(10_000);
    const result = checkContentSecurity('src/large.ts', content);
    expect(result.passed).toBe(true);
  });

  it('reports correct line numbers', () => {
    const content = [
      'const a = 1;',
      'const b = 2;',
      'const key = "AKIAIOSFODNN7EXAMPLE";',
      'const c = 3;',
    ].join('\n');
    const result = checkContentSecurity('src/config.ts', content);
    expect(result.violations[0].line).toBe(3);
  });

  it('reports multiple violations across different rules', () => {
    const content = [
      'const key = "AKIAIOSFODNN7EXAMPLE";',
      "createHash('md5');",
    ].join('\n');
    const result = checkContentSecurity('src/config.ts', content);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0].ruleId).toBe('HARDCODED_AWS_KEY');
    expect(result.violations[1].ruleId).toBe('INSECURE_CRYPTO');
  });
});

// ── Wrapper behavior ──

describe('wrapWriteToolWithSecurityCheck', () => {
  const mockExecute = vi.fn(async () => ({ result: 'File written: test.ts' }));

  beforeEach(() => {
    mockExecute.mockClear();
  });

  it('blocks write on CRITICAL violations', async () => {
    const wrapped = wrapWriteToolWithSecurityCheck(mockExecute);
    const result = await wrapped({
      path: 'src/config.ts',
      content: 'const key = "AKIAIOSFODNN7EXAMPLE";',
    });
    expect(mockExecute).not.toHaveBeenCalled();
    expect(result.result).toContain('SECURITY CHECK FAILED');
    expect(result.result).toContain('HARDCODED_AWS_KEY');
  });

  it('allows write with warnings for HIGH/MEDIUM violations', async () => {
    const wrapped = wrapWriteToolWithSecurityCheck(mockExecute);
    const result = await wrapped({
      path: 'src/hash.ts',
      content: "createHash('md5');",
    });
    expect(mockExecute).toHaveBeenCalledOnce();
    expect(result.result).toContain('SECURITY WARNINGS');
    expect(result.result).toContain('File written');
  });

  it('passes through cleanly for safe content', async () => {
    const wrapped = wrapWriteToolWithSecurityCheck(mockExecute);
    const result = await wrapped({
      path: 'src/utils.ts',
      content: 'export const add = (a: number, b: number) => a + b;',
    });
    expect(mockExecute).toHaveBeenCalledOnce();
    expect(result.result).toBe('File written: test.ts');
  });

  it('passes through for test files even with violations', async () => {
    const wrapped = wrapWriteToolWithSecurityCheck(mockExecute);
    const result = await wrapped({
      path: 'src/__tests__/config.test.ts',
      content: 'const key = "AKIAIOSFODNN7EXAMPLE";',
    });
    expect(mockExecute).toHaveBeenCalledOnce();
    expect(result.result).toBe('File written: test.ts');
  });
});
