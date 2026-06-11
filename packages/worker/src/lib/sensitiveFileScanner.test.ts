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
  checkSensitiveFilePath,
  invalidateSensitiveFilePatternCache,
} from './sensitiveFileScanner.js';

const findMany = vi.mocked(prisma.scannerPattern.findMany);

// Verbatim copy of the built-in SENSITIVE_FILE patterns from
// packages/shared/src/scannerPatterns/index.ts (BUILTIN_SCANNER_PATTERNS is not
// reachable through the shared package's export map from the worker package, so
// the shipped definitions are mirrored here to verify the real patterns).
const BUILTIN_SENSITIVE_FILE_PATTERNS = [
  {
    flags: 'i',
    label: 'sensitive-env-file',
    pattern: '^\\.env(rc)?(\\.(?!example$|sample$|template$).+)?$',
  },
  { flags: 'i', label: 'sensitive-pem-cert', pattern: '\\.(pem|crt|cer|p7b|p7c)$' },
  {
    flags: 'i',
    label: 'sensitive-private-key',
    pattern: '\\.(key|pk8|p12|pfx|jks|pkcs12|keystore)$',
  },
  {
    flags: '',
    label: 'sensitive-ssh-private-key',
    pattern: '(^|\\/)id_(rsa|ed25519|ecdsa|dsa)$',
  },
  {
    flags: 'i',
    label: 'sensitive-service-account-json',
    pattern: '(service[_-]?account)\\.json$',
  },
  { flags: 'i', label: 'sensitive-credentials-file', pattern: 'credentials\\.(json|ya?ml)$' },
];

function mockPatternRows(rows: Array<{ flags: string; label: string; pattern: string }>): void {
  findMany.mockResolvedValue(
    rows.map((r, i) => ({
      flags: r.flags,
      id: `p-${i}`,
      isActive: true,
      label: r.label,
      pattern: r.pattern,
      type: 'SENSITIVE_FILE',
    })) as never
  );
}

beforeEach(() => {
  invalidateSensitiveFilePatternCache();
  findMany.mockReset();
  mockPatternRows(BUILTIN_SENSITIVE_FILE_PATTERNS);
});

describe('checkSensitiveFilePath — paths that must be blocked', () => {
  it.each([
    ['.env', 'sensitive-env-file'],
    ['.env.production', 'sensitive-env-file'],
    ['.envrc', 'sensitive-env-file'], // direnv files can export secrets
    ['config/.envrc', 'sensitive-env-file'],
    // The ^-anchored pattern only matches the basename for nested paths.
    ['packages/web/.env.local', 'sensitive-env-file'],
    ['certs/server.pem', 'sensitive-pem-cert'],
    ['tls.crt', 'sensitive-pem-cert'],
    ['ca-bundle.cer', 'sensitive-pem-cert'],
    ['private.key', 'sensitive-private-key'],
    ['app.p12', 'sensitive-private-key'],
    ['release.keystore', 'sensitive-private-key'],
    ['signing.jks', 'sensitive-private-key'],
    ['id_rsa', 'sensitive-ssh-private-key'],
    ['/home/dev/.ssh/id_rsa', 'sensitive-ssh-private-key'],
    ['.ssh/id_ed25519', 'sensitive-ssh-private-key'],
    ['service-account.json', 'sensitive-service-account-json'],
    ['gcp/service_account.json', 'sensitive-service-account-json'],
    ['gcp/serviceaccount.json', 'sensitive-service-account-json'],
    ['credentials.json', 'sensitive-credentials-file'],
    ['config/credentials.yaml', 'sensitive-credentials-file'],
    ['aws/credentials.yml', 'sensitive-credentials-file'],
  ])('blocks %j with [%s]', async (filePath, label) => {
    const result = await checkSensitiveFilePath(filePath);
    expect(result).not.toBeNull();
    expect(result).toContain(`[${label}]`);
    expect(result).toContain('Write blocked');
    expect(result).toContain(filePath);
  });

  it('matches case-insensitively when the pattern carries the i flag', async () => {
    const result = await checkSensitiveFilePath('SERVER.PEM');
    expect(result).toContain('[sensitive-pem-cert]');
  });

  it('normalizes Windows backslash paths before matching', async () => {
    const result = await checkSensitiveFilePath('C:\\Users\\dev\\.ssh\\id_rsa');
    expect(result).toContain('[sensitive-ssh-private-key]');
  });

  it('matches .env case-insensitively (the env pattern carries the i flag)', async () => {
    const result = await checkSensitiveFilePath('.ENV');
    expect(result).toContain('[sensitive-env-file]');
  });
});

describe('checkSensitiveFilePath — benign paths pass', () => {
  it.each([
    'src/index.ts',
    'README.md',
    'environment.ts', // does not start with a literal `.env`
    'env.example', // no leading dot
    'src/keys.ts', // `.key` requires the literal extension
    'id_rsa.pub', // public half of the keypair is fine
    'docs/credentials.md', // only json/yaml credential files are blocked
    'packages/shared/src/prisma/schema.prisma',
    '.env.example', // secrets-free template — legitimate to write
    '.env.sample', // secrets-free template — legitimate to write
    '.env.template', // secrets-free template — legitimate to write
    'packages/web/.env.example',
  ])('allows %j', async (filePath) => {
    await expect(checkSensitiveFilePath(filePath)).resolves.toBeNull();
  });
});

describe('checkSensitiveFilePath — pattern loading behavior', () => {
  it('returns null for everything when no patterns are active', async () => {
    findMany.mockReset();
    mockPatternRows([]);
    await expect(checkSensitiveFilePath('.env')).resolves.toBeNull();
  });

  it('resets lastIndex so a stateful g-flag pattern blocks consistently', async () => {
    findMany.mockReset();
    mockPatternRows([{ flags: 'g', label: 'g-flag-rule', pattern: '\\.pem$' }]);
    expect(await checkSensitiveFilePath('a.pem')).toContain('[g-flag-rule]');
    expect(await checkSensitiveFilePath('a.pem')).toContain('[g-flag-rule]');
  });

  it('propagates DB errors (the writeFile tool call site is responsible for handling)', async () => {
    findMany.mockReset();
    findMany.mockRejectedValue(new Error('db down'));
    await expect(checkSensitiveFilePath('.env')).rejects.toThrow('db down');
  });
});
