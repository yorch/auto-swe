import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@auto-swe/shared';
import { _resetKeyCacheForTests, decryptSecret, encryptSecret } from '@auto-swe/shared/lib/crypto';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoisted mock fns referenced inside the vi.mock factories below ───────────
const { mockAtlassianGet, mockCreateKnowledgeBaseProvider, mockFetchTicket, mockSlackAuthTest } =
  vi.hoisted(() => ({
    mockAtlassianGet: vi.fn(),
    mockCreateKnowledgeBaseProvider: vi.fn(),
    mockFetchTicket: vi.fn(),
    mockSlackAuthTest: vi.fn(),
  }));

// testIssueTrackerConnection() lazily `import()`s this relative module — mock
// it so the connection test doesn't reach real provider network code.
vi.mock('./issueTrackerClient.js', () => ({
  fetchTicket: mockFetchTicket,
}));

vi.mock('@auto-swe/shared/lib/integrations/registry', () => ({
  createKnowledgeBaseProvider: mockCreateKnowledgeBaseProvider,
}));

// mockImplementation must be a real function (not an arrow fn) so it can be
// invoked with `new` — an explicit object return from a constructor call
// replaces `this`, which is how these fakes stand in for the real classes.
vi.mock('@auto-swe/shared/lib/integrations/atlassianClient', () => ({
  AtlassianClient: vi.fn().mockImplementation(function AtlassianClientMock() {
    return { get: mockAtlassianGet };
  }),
}));

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(function WebClientMock() {
    return { auth: { test: mockSlackAuthTest } };
  }),
}));

vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveFigmaConfig: vi.fn(),
  resolveGitHubConfig: vi.fn(),
  resolveIssueTrackerConfig: vi.fn(),
  resolveKnowledgeBaseConfig: vi.fn(),
  resolveSlackConfig: vi.fn(),
  resolveStorageConfig: vi.fn(),
}));

import {
  resolveFigmaConfig,
  resolveGitHubConfig,
  resolveIssueTrackerConfig,
  resolveKnowledgeBaseConfig,
  resolveSlackConfig,
  resolveStorageConfig,
} from '@auto-swe/shared/lib/systemConfig';
import {
  detectJiraFields,
  getFigmaConfig,
  getGitHubConfig,
  getGoogleOAuthConfig,
  getIssueTrackerConfig,
  getKnowledgeBaseConfig,
  getSlackConfig,
  getStorageConfig,
  listConfigAuditEntries,
  testDecryptSecrets,
  testFigmaConnection,
  testGitHubConnection,
  testIssueTrackerConnection,
  testKnowledgeBaseConnection,
  testSlackConnection,
  testStorageConnection,
  updateCanaryConfig,
  updateConsolidationConfig,
  updateEvalScheduleConfig,
  updateFigmaConfig,
  updateGitHubConfig,
  updateGoogleOAuthConfig,
  updateIssueTrackerConfig,
  updateKnowledgeBaseConfig,
  updateRevalidationScheduleConfig,
  updateSlackConfig,
  updateStorageConfig,
  writeSystemConfigAudit,
} from './systemConfigService.js';

const resolveGitHubConfigMock = vi.mocked(resolveGitHubConfig);
const resolveSlackConfigMock = vi.mocked(resolveSlackConfig);
const resolveStorageConfigMock = vi.mocked(resolveStorageConfig);
const resolveFigmaConfigMock = vi.mocked(resolveFigmaConfig);
const resolveKnowledgeBaseConfigMock = vi.mocked(resolveKnowledgeBaseConfig);
const resolveIssueTrackerConfigMock = vi.mocked(resolveIssueTrackerConfig);

// ─── test helpers ───────────────────────────────────────────────────────────

/** Builds an `{create, update, where}`-echoing upsert mock: returns the `create`
 * payload (which is `{id: 'default', ...data}`) as the "persisted row", so
 * assertions against the function's return value see the real encrypted bytes
 * that were actually passed to Prisma. */
function echoUpsert() {
  return vi.fn(
    async (args: {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
      where?: unknown;
    }) => args.create
  );
}

function fakeLogger(): FastifyBaseLogger {
  return { warn: vi.fn() } as unknown as FastifyBaseLogger;
}

/** Encrypts `plaintext` with the real crypto module and returns the five
 * envelope columns keyed by `prefix`, ready to splice into a fake DB row. */
function sealedColumns(prefix: string, plaintext: string) {
  const sealed = encryptSecret(plaintext);
  return {
    [`${prefix}AuthTag`]: Buffer.from(sealed.authTag),
    [`${prefix}Ciphertext`]: Buffer.from(sealed.ciphertext),
    [`${prefix}KeyVersion`]: sealed.keyVersion,
    [`${prefix}LastFour`]: sealed.lastFour,
    [`${prefix}Nonce`]: Buffer.from(sealed.nonce),
  };
}

function makeMockPrisma() {
  return {
    configAuditLog: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    figmaConfig: {
      findUnique: vi.fn(),
      upsert: echoUpsert(),
    },
    gitHubConfig: {
      findUnique: vi.fn(),
      upsert: echoUpsert(),
    },
    googleOAuthConfig: {
      findUnique: vi.fn(),
      upsert: echoUpsert(),
    },
    issueTrackerConfig: {
      findUnique: vi.fn(),
      upsert: echoUpsert(),
    },
    knowledgeBaseConfig: {
      findUnique: vi.fn(),
      upsert: echoUpsert(),
    },
    slackConfig: {
      findUnique: vi.fn(),
      upsert: echoUpsert(),
    },
    storageConfig: {
      findUnique: vi.fn(),
      upsert: echoUpsert(),
    },
    user: {
      findMany: vi.fn(),
    },
    workflowDefaults: {
      upsert: vi.fn(),
    },
  };
}

type MockPrisma = ReturnType<typeof makeMockPrisma>;

function asPrisma(mock: MockPrisma): PrismaClient {
  return mock as unknown as PrismaClient;
}

describe('systemConfigService', () => {
  const previousKey = process.env.CONFIG_ENCRYPTION_KEY;
  let mockPrisma: MockPrisma;
  let prisma: PrismaClient;

  beforeAll(() => {
    // A real 32-byte key so encryptSecret/decryptSecret actually run instead
    // of throwing — mirrors packages/shared/src/lib/crypto.test.ts.
    process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    _resetKeyCacheForTests();
  });

  afterAll(() => {
    if (previousKey === undefined) {
      delete process.env.CONFIG_ENCRYPTION_KEY;
    } else {
      process.env.CONFIG_ENCRYPTION_KEY = previousKey;
    }
    _resetKeyCacheForTests();
  });

  beforeEach(() => {
    mockPrisma = makeMockPrisma();
    prisma = asPrisma(mockPrisma);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // ─── GitHub config ──────────────────────────────────────────────────────

  describe('GitHub config', () => {
    it('encrypts secrets on write: ciphertext (not plaintext) is sent to Prisma, and round-trips', async () => {
      mockPrisma.gitHubConfig.findUnique.mockResolvedValueOnce(null);

      const result = await updateGitHubConfig(prisma, {
        token: 'ghp_supersecrettoken1234',
        webhookSecret: 'whsec_abc123',
      });

      const call = mockPrisma.gitHubConfig.upsert.mock.calls[0][0];
      const sentData = call.update as Record<string, unknown>;

      // Never plaintext on the wire to Prisma.
      expect(sentData.tokenCiphertext).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(sentData.tokenCiphertext as Uint8Array).toString('utf8')).not.toContain(
        'ghp_supersecrettoken1234'
      );
      expect(sentData.tokenLastFour).toBe('1234');

      // Round-trips back to the original plaintext via the real decrypt path.
      const decrypted = decryptSecret({
        authTag: sentData.tokenAuthTag as Buffer,
        ciphertext: sentData.tokenCiphertext as Buffer,
        keyVersion: sentData.tokenKeyVersion as number,
        nonce: sentData.tokenNonce as Buffer,
      });
      expect(decrypted).toBe('ghp_supersecrettoken1234');

      // Redacted on the response side: only lastFour, never plaintext.
      expect(result.data.token).toEqual({ lastFour: '1234' });
      expect(result.data.webhookSecret).toEqual({ lastFour: 'c123' });
      expect(JSON.stringify(result)).not.toContain('ghp_supersecrettoken1234');
    });

    it('redacts secrets on read: getGitHubConfig never returns plaintext, non-secret fields pass through', async () => {
      mockPrisma.gitHubConfig.findUnique.mockResolvedValueOnce({
        apiUrl: 'https://api.github.example.com',
        authMode: 'pat',
        baseUrl: null,
        ...sealedColumns('token', 'ghp_readsecret5678'),
      });

      const result = await getGitHubConfig(prisma);

      expect(result.data.token).toEqual({ lastFour: '5678' });
      expect(JSON.stringify(result.data)).not.toContain('ghp_readsecret5678');
      // Non-secret fields pass through untouched.
      expect(result.data.apiUrl).toBe('https://api.github.example.com');
      expect(result.data.authMode).toBe('pat');
      expect(result.data.baseUrl).toBeNull();
      expect(result.sources.token).toBe('db');
    });

    it('falls back to the env var when no DB row exists, and DB takes precedence when both are present', async () => {
      vi.stubEnv('GITHUB_TOKEN', 'env-token-value');

      mockPrisma.gitHubConfig.findUnique.mockResolvedValueOnce(null);
      const envOnly = await getGitHubConfig(prisma);
      expect(envOnly.sources.token).toBe('env');
      // GITHUB_API_URL was never stubbed, so that field has no source at all.
      expect(envOnly.sources.apiUrl).toBeNull();

      mockPrisma.gitHubConfig.findUnique.mockResolvedValueOnce(sealedColumns('token', 'db-token'));
      const dbAndEnv = await getGitHubConfig(prisma);
      expect(dbAndEnv.sources.token).toBe('db');
    });

    it('a field with no DB row and no env var reports a null source', async () => {
      // The sandbox's ambient GITHUB_TOKEN (proxy-injected) would otherwise
      // leak into this "unset" assertion — force it empty for this test only.
      vi.stubEnv('GITHUB_TOKEN', '');
      mockPrisma.gitHubConfig.findUnique.mockResolvedValueOnce(null);
      const result = await getGitHubConfig(prisma);
      expect(result.sources.apiUrl).toBeNull();
      expect(result.sources.token).toBeNull();
    });

    it('partial update preserves the existing ciphertext instead of overwriting it', async () => {
      // First write: seals a token.
      mockPrisma.gitHubConfig.findUnique.mockResolvedValueOnce(null);
      await updateGitHubConfig(prisma, { token: 'ghp_original111' });
      const firstCallData = mockPrisma.gitHubConfig.upsert.mock.calls[0][0].update as Record<
        string,
        unknown
      >;
      expect(firstCallData.tokenCiphertext).toBeDefined();

      // Second write: only changes baseUrl, doesn't send `token` at all.
      mockPrisma.gitHubConfig.findUnique.mockResolvedValueOnce({
        baseUrl: null,
        ...sealedColumns('token', 'ghp_original111'),
      });
      await updateGitHubConfig(prisma, { baseUrl: 'https://ghe.internal' });
      const secondCallData = mockPrisma.gitHubConfig.upsert.mock.calls[1][0].update as Record<
        string,
        unknown
      >;

      // The second call's `data` object must NOT carry any token* key at all —
      // that is what lets Prisma's partial update leave the existing ciphertext
      // columns untouched instead of nulling them out.
      expect(secondCallData).not.toHaveProperty('tokenCiphertext');
      expect(secondCallData).not.toHaveProperty('tokenNonce');
      expect(secondCallData).not.toHaveProperty('tokenAuthTag');
      expect(secondCallData).not.toHaveProperty('tokenLastFour');
      expect(secondCallData.baseUrl).toBe('https://ghe.internal');
    });

    it('an empty-string secret is treated as "not provided" (no-op, not cleared)', async () => {
      mockPrisma.gitHubConfig.findUnique.mockResolvedValueOnce(null);
      const result = await updateGitHubConfig(prisma, { token: '' });
      const sentData = mockPrisma.gitHubConfig.upsert.mock.calls[0][0].update as Record<
        string,
        unknown
      >;
      expect(sentData).not.toHaveProperty('tokenCiphertext');
      expect(result.changedFields).not.toContain('token');
    });

    it('requiresRestart is true only when the OAuth client id/secret changes', async () => {
      mockPrisma.gitHubConfig.findUnique.mockResolvedValueOnce(null);
      const noOauthChange = await updateGitHubConfig(prisma, { baseUrl: 'https://x' });
      expect(noOauthChange.data.requiresRestart).toBe(false);

      mockPrisma.gitHubConfig.findUnique.mockResolvedValueOnce(null);
      const oauthChange = await updateGitHubConfig(prisma, { oauthClientId: 'client-123' });
      expect(oauthChange.data.requiresRestart).toBe(true);
    });

    it('reports existed:false on first create and existed:true on subsequent update', async () => {
      mockPrisma.gitHubConfig.findUnique.mockResolvedValueOnce(null);
      const created = await updateGitHubConfig(prisma, { baseUrl: 'https://x' });
      expect(created.existed).toBe(false);

      mockPrisma.gitHubConfig.findUnique.mockResolvedValueOnce({ id: 'default' });
      const updated = await updateGitHubConfig(prisma, { baseUrl: 'https://y' });
      expect(updated.existed).toBe(true);
    });

    it('changedFields only lists fields that were actually provided', async () => {
      mockPrisma.gitHubConfig.findUnique.mockResolvedValueOnce(null);
      const result = await updateGitHubConfig(prisma, {
        appId: undefined,
        baseUrl: 'https://x',
        token: 'ghp_abc',
      });
      expect(result.changedFields.sort()).toEqual(['baseUrl', 'token'].sort());
      expect(result.auditAfterJson.changedFields).toEqual(result.changedFields);
    });
  });

  // ─── Slack config ───────────────────────────────────────────────────────

  describe('Slack config', () => {
    it('encrypts on write and redacts on the response', async () => {
      mockPrisma.slackConfig.findUnique.mockResolvedValueOnce(null);
      const result = await updateSlackConfig(prisma, {
        botToken: 'xoxb-secret-bot-token',
        clientId: 'client-abc',
      });

      const sentData = mockPrisma.slackConfig.upsert.mock.calls[0][0].update as Record<
        string,
        unknown
      >;
      expect(sentData.botTokenCiphertext).toBeInstanceOf(Uint8Array);
      expect(sentData.clientId).toBe('client-abc');
      expect(result.data.botToken).toEqual({ lastFour: 'oken' });
      expect(result.data.clientId).toBe('client-abc');
      expect(JSON.stringify(result)).not.toContain('xoxb-secret-bot-token');
    });

    it('redacts on read via getSlackConfig', async () => {
      mockPrisma.slackConfig.findUnique.mockResolvedValueOnce({
        clientId: 'client-xyz',
        ...sealedColumns('botToken', 'xoxb-readonly'),
      });
      const result = await getSlackConfig(prisma);
      expect(result.data.botToken).toEqual({ lastFour: 'only' });
      expect(result.data.clientId).toBe('client-xyz');
    });

    it('falls back to env when unset, DB wins when both present', async () => {
      vi.stubEnv('SLACK_CLIENT_ID', 'env-client-id');
      mockPrisma.slackConfig.findUnique.mockResolvedValueOnce(null);
      const envOnly = await getSlackConfig(prisma);
      expect(envOnly.sources.clientId).toBe('env');

      mockPrisma.slackConfig.findUnique.mockResolvedValueOnce({ clientId: 'db-client-id' });
      const dbWins = await getSlackConfig(prisma);
      expect(dbWins.sources.clientId).toBe('db');
    });

    it('partial update preserves an existing botToken ciphertext', async () => {
      mockPrisma.slackConfig.findUnique.mockResolvedValueOnce(null);
      await updateSlackConfig(prisma, { botToken: 'xoxb-keep-me' });

      mockPrisma.slackConfig.findUnique.mockResolvedValueOnce({
        ...sealedColumns('botToken', 'xoxb-keep-me'),
      });
      await updateSlackConfig(prisma, { clientId: 'new-client' });
      const secondCallData = mockPrisma.slackConfig.upsert.mock.calls[1][0].update as Record<
        string,
        unknown
      >;
      expect(secondCallData).not.toHaveProperty('botTokenCiphertext');
    });

    it('requiresRestart reflects clientId/clientSecret changes only', async () => {
      mockPrisma.slackConfig.findUnique.mockResolvedValueOnce(null);
      const noChange = await updateSlackConfig(prisma, { botToken: 'xoxb-only' });
      expect(noChange.data.requiresRestart).toBe(false);

      mockPrisma.slackConfig.findUnique.mockResolvedValueOnce(null);
      const withChange = await updateSlackConfig(prisma, { clientSecret: 'secret' });
      expect(withChange.data.requiresRestart).toBe(true);
    });
  });

  // ─── Storage config ─────────────────────────────────────────────────────

  describe('Storage config', () => {
    it('encrypts the AWS secret key on write and redacts on read', async () => {
      mockPrisma.storageConfig.findUnique.mockResolvedValueOnce(null);
      const result = await updateStorageConfig(prisma, {
        awsSecretAccessKey: 'wJalrXUtnFEMI/K7MDENG',
        backend: 's3',
        s3Bucket: 'my-bucket',
      });
      const sentData = mockPrisma.storageConfig.upsert.mock.calls[0][0].update as Record<
        string,
        unknown
      >;
      expect(sentData.awsSecretAccessKeyCiphertext).toBeInstanceOf(Uint8Array);
      expect(result.data.awsSecretAccessKey).toEqual({ lastFour: 'DENG' });
      expect(JSON.stringify(result)).not.toContain('wJalrXUtnFEMI/K7MDENG');
    });

    it('providing s3Bucket without an explicit backend implies backend=s3', async () => {
      mockPrisma.storageConfig.findUnique.mockResolvedValueOnce(null);
      await updateStorageConfig(prisma, { s3Bucket: 'implicit-bucket' });
      const sentData = mockPrisma.storageConfig.upsert.mock.calls[0][0].update as Record<
        string,
        unknown
      >;
      expect(sentData.backend).toBe('s3');
    });

    it('clearing s3Bucket with null does not force backend=s3', async () => {
      mockPrisma.storageConfig.findUnique.mockResolvedValueOnce(null);
      await updateStorageConfig(prisma, { s3Bucket: null });
      const sentData = mockPrisma.storageConfig.upsert.mock.calls[0][0].update as Record<
        string,
        unknown
      >;
      expect(sentData).not.toHaveProperty('backend');
      expect(sentData.s3Bucket).toBeNull();
    });

    it('an explicit backend is never overridden by the s3Bucket-implies-s3 rule', async () => {
      mockPrisma.storageConfig.findUnique.mockResolvedValueOnce(null);
      await updateStorageConfig(prisma, { backend: 'inline', s3Bucket: 'ignored-for-backend' });
      const sentData = mockPrisma.storageConfig.upsert.mock.calls[0][0].update as Record<
        string,
        unknown
      >;
      expect(sentData.backend).toBe('inline');
    });

    it('defaults backend to "inline" when no row and no data exist', async () => {
      mockPrisma.storageConfig.findUnique.mockResolvedValueOnce(null);
      const result = await getStorageConfig(prisma);
      expect(result.data.backend).toBe('inline');
      expect(result.data.s3ForcePathStyle).toBe(false);
    });

    it('s3ForcePathStyle source distinguishes explicit false from unset', async () => {
      mockPrisma.storageConfig.findUnique.mockResolvedValueOnce({ s3ForcePathStyle: false });
      const explicitFalse = await getStorageConfig(prisma);
      expect(explicitFalse.sources.s3ForcePathStyle).toBe('db');

      mockPrisma.storageConfig.findUnique.mockResolvedValueOnce(null);
      const unset = await getStorageConfig(prisma);
      expect(unset.sources.s3ForcePathStyle).toBeNull();
    });
  });

  // ─── Google OAuth config ────────────────────────────────────────────────

  describe('Google OAuth config', () => {
    it('encrypts on write, redacts on read, and always flags requiresRestart', async () => {
      mockPrisma.googleOAuthConfig.findUnique.mockResolvedValueOnce(null);
      const result = await updateGoogleOAuthConfig(prisma, {
        clientId: 'google-client-id',
        clientSecret: 'GOCSPX-supersecret',
      });
      const sentData = mockPrisma.googleOAuthConfig.upsert.mock.calls[0][0].update as Record<
        string,
        unknown
      >;
      expect(sentData.clientSecretCiphertext).toBeInstanceOf(Uint8Array);
      expect(result.data.clientSecret).toEqual({ lastFour: 'cret' });
      expect(result.data.requiresRestart).toBe(true);
    });

    it('getGoogleOAuthConfig redacts the secret and passes through clientId', async () => {
      mockPrisma.googleOAuthConfig.findUnique.mockResolvedValueOnce({
        clientId: 'g-client',
        ...sealedColumns('clientSecret', 'GOCSPX-readable'),
      });
      const result = await getGoogleOAuthConfig(prisma);
      expect(result.data.clientSecret).toEqual({ lastFour: 'able' });
      expect(result.data.clientId).toBe('g-client');
    });
  });

  // ─── Issue tracker config ───────────────────────────────────────────────

  describe('Issue tracker config', () => {
    it('encrypts apiToken on write and redacts on read', async () => {
      mockPrisma.issueTrackerConfig.findUnique.mockResolvedValueOnce(null);
      const result = await updateIssueTrackerConfig(prisma, {
        apiToken: 'jira-api-token-999',
        baseUrl: 'https://acme.atlassian.net',
        provider: 'jira',
      });
      const sentData = mockPrisma.issueTrackerConfig.upsert.mock.calls[0][0].update as Record<
        string,
        unknown
      >;
      expect(sentData.apiTokenCiphertext).toBeInstanceOf(Uint8Array);
      expect(result.data.apiToken).toEqual({ lastFour: '-999' });
      expect(result.data.provider).toBe('jira');
    });

    it('getIssueTrackerConfig redacts apiToken/webhookSecret and passes non-secret fields through', async () => {
      mockPrisma.issueTrackerConfig.findUnique.mockResolvedValueOnce({
        defaultProjectKey: 'ENG',
        provider: 'jira',
        ...sealedColumns('apiToken', 'jira-readonly-tok'),
      });
      const result = await getIssueTrackerConfig(prisma);
      expect(result.data.apiToken).toEqual({ lastFour: '-tok' });
      expect(result.data.provider).toBe('jira');
      expect(result.data.defaultProjectKey).toBe('ENG');
      expect(result.sources.provider).toBe('db');
    });

    it('numeric fields (timeoutMs/maxRetries) pass through the update untouched', async () => {
      mockPrisma.issueTrackerConfig.findUnique.mockResolvedValueOnce(null);
      await updateIssueTrackerConfig(prisma, { maxRetries: 5, timeoutMs: 8000 });
      const sentData = mockPrisma.issueTrackerConfig.upsert.mock.calls[0][0].update as Record<
        string,
        unknown
      >;
      expect(sentData.timeoutMs).toBe(8000);
      expect(sentData.maxRetries).toBe(5);
    });

    it('webhookSecret:null is a no-op (never sealed) and is NOT audited as "changed"', async () => {
      // `webhookSecret` is a secret: `sealInto` no-ops on a null/empty value
      // (secrets are never cleared through this path), so a null must persist
      // nothing AND must not appear in changedFields/the audit log — otherwise
      // the audit trail claims a change that never happened. Normalizing null →
      // undefined for changedKeys keeps the two in sync.
      mockPrisma.issueTrackerConfig.findUnique.mockResolvedValueOnce(null);
      const result = await updateIssueTrackerConfig(prisma, { webhookSecret: null });
      const sentData = mockPrisma.issueTrackerConfig.upsert.mock.calls[0][0].update as Record<
        string,
        unknown
      >;
      expect(sentData).not.toHaveProperty('webhookSecretCiphertext');
      expect(result.changedFields).not.toContain('webhookSecret');
    });
  });

  // ─── Knowledge base config ──────────────────────────────────────────────

  describe('Knowledge base config', () => {
    it('encrypts apiToken on write and redacts on read, spaces array passes through', async () => {
      mockPrisma.knowledgeBaseConfig.findUnique.mockResolvedValueOnce(null);
      const result = await updateKnowledgeBaseConfig(prisma, {
        apiToken: 'kb-token-abcd',
        enabled: true,
        provider: 'confluence',
        spaces: ['ENG', 'PROD'],
      });
      const sentData = mockPrisma.knowledgeBaseConfig.upsert.mock.calls[0][0].update as Record<
        string,
        unknown
      >;
      expect(sentData.apiTokenCiphertext).toBeInstanceOf(Uint8Array);
      expect(sentData.spaces).toEqual(['ENG', 'PROD']);
      expect(result.data.apiToken).toEqual({ lastFour: 'abcd' });
      expect(result.data.spaces).toEqual(['ENG', 'PROD']);
    });

    it('spaces source is null when neither DB nor env has entries', async () => {
      mockPrisma.knowledgeBaseConfig.findUnique.mockResolvedValueOnce(null);
      const result = await getKnowledgeBaseConfig(prisma);
      expect(result.data.spaces).toEqual([]);
      expect(result.sources.spaces).toBeNull();
    });
  });

  // ─── Figma config ───────────────────────────────────────────────────────

  describe('Figma config', () => {
    it('encrypts apiToken on write and redacts on read', async () => {
      mockPrisma.figmaConfig.findUnique.mockResolvedValueOnce(null);
      const result = await updateFigmaConfig(prisma, {
        apiToken: 'figd_secret_token',
        enabled: true,
        maxNodes: 20,
      });
      const sentData = mockPrisma.figmaConfig.upsert.mock.calls[0][0].update as Record<
        string,
        unknown
      >;
      expect(sentData.apiTokenCiphertext).toBeInstanceOf(Uint8Array);
      expect(result.data.apiToken).toEqual({ lastFour: 'oken' });
      expect(result.data.maxNodes).toBe(20);
    });

    it('getFigmaConfig defaults enabled to false and maxNodes to null when unset', async () => {
      mockPrisma.figmaConfig.findUnique.mockResolvedValueOnce(null);
      const result = await getFigmaConfig(prisma);
      expect(result.data.enabled).toBe(false);
      expect(result.data.maxNodes).toBeNull();
    });
  });

  // ─── Schedule config writers (WorkflowDefaults singleton) ──────────────

  describe('schedule config writers on WorkflowDefaults', () => {
    it('updateConsolidationConfig maps fields onto the consolidation* columns', async () => {
      await updateConsolidationConfig(prisma, {
        cronExpression: '0 4 * * 1',
        enabled: true,
        minClusterSize: 5,
        similarityThreshold: 0.9,
      });
      expect(mockPrisma.workflowDefaults.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: {
            consolidationCron: '0 4 * * 1',
            consolidationEnabled: true,
            consolidationMinClusterSize: 5,
            consolidationSimilarityThreshold: 0.9,
          },
        })
      );
    });

    it('updateConsolidationConfig omits untouched fields', async () => {
      await updateConsolidationConfig(prisma, { enabled: false });
      const call = mockPrisma.workflowDefaults.upsert.mock.calls[0][0];
      expect(call.update).toEqual({ consolidationEnabled: false });
    });

    it('updateEvalScheduleConfig maps fields onto the evalSchedule* columns', async () => {
      await updateEvalScheduleConfig(prisma, {
        baselineRef: 'v1',
        candidateRef: 'main',
        cronExpression: '0 7 * * *',
        datasetSlug: 'golden',
        enabled: true,
      });
      const call = mockPrisma.workflowDefaults.upsert.mock.calls[0][0];
      expect(call.update).toEqual({
        evalScheduleBaselineRef: 'v1',
        evalScheduleCandidateRef: 'main',
        evalScheduleCron: '0 7 * * *',
        evalScheduleDatasetSlug: 'golden',
        evalScheduleEnabled: true,
      });
    });

    it('updateRevalidationScheduleConfig maps fields onto the revalidation* columns', async () => {
      await updateRevalidationScheduleConfig(prisma, {
        cronExpression: '0 5 * * 0',
        datasetSlug: null,
        enabled: true,
      });
      const call = mockPrisma.workflowDefaults.upsert.mock.calls[0][0];
      expect(call.update).toEqual({
        revalidationCron: '0 5 * * 0',
        revalidationDatasetSlug: null,
        revalidationEnabled: true,
      });
    });

    it('updateCanaryConfig maps fields onto the canary* columns', async () => {
      await updateCanaryConfig(prisma, {
        agentKey: 'implementer',
        candidateVersion: 3,
        enabled: true,
        percent: 25,
      });
      const call = mockPrisma.workflowDefaults.upsert.mock.calls[0][0];
      expect(call.update).toEqual({
        canaryAgentKey: 'implementer',
        canaryCandidateVersion: 3,
        canaryEnabled: true,
        canaryPercent: 25,
      });
    });
  });

  // ─── Audit log ──────────────────────────────────────────────────────────

  describe('writeSystemConfigAudit', () => {
    it('creates a ConfigAuditLog row with the right action/fields', async () => {
      const log = fakeLogger();
      await writeSystemConfigAudit(prisma, log, {
        action: 'UPDATE',
        actorId: 'user-42',
        afterJson: { baseUrl: 'https://x', changedFields: ['baseUrl'] },
        entityId: '00000000-0000-0000-0001-000000000001',
        entityType: 'GitHubConfig',
      });
      expect(mockPrisma.configAuditLog.create).toHaveBeenCalledWith({
        data: {
          action: 'UPDATE',
          actorId: 'user-42',
          afterJson: { baseUrl: 'https://x', changedFields: ['baseUrl'] },
          entityId: '00000000-0000-0000-0001-000000000001',
          entityType: 'GitHubConfig',
        },
      });
    });

    it('is best-effort: a DB failure is swallowed (logged) and never thrown', async () => {
      const log = fakeLogger();
      mockPrisma.configAuditLog.create.mockRejectedValueOnce(new Error('db down'));
      await expect(
        writeSystemConfigAudit(prisma, log, {
          action: 'CREATE',
          actorId: 'user-1',
          afterJson: {},
          entityId: '00000000-0000-0000-0001-000000000002',
          entityType: 'SlackConfig',
        })
      ).resolves.toBeUndefined();
      expect(log.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('listConfigAuditEntries', () => {
    it('resolves actor emails in a single batch query and stamps ISO timestamps', async () => {
      const createdAt = new Date('2026-05-01T12:00:00Z');
      mockPrisma.configAuditLog.findMany.mockResolvedValueOnce([
        {
          action: 'UPDATE',
          actorId: 'user-1',
          createdAt,
          entityId: 'e1',
          entityType: 'GitHubConfig',
          id: 'log-1',
        },
      ]);
      mockPrisma.user.findMany.mockResolvedValueOnce([
        { email: 'admin@example.com', id: 'user-1' },
      ]);

      const result = await listConfigAuditEntries(prisma, 10);

      expect(result).toEqual([
        expect.objectContaining({
          actorEmail: 'admin@example.com',
          createdAt: createdAt.toISOString(),
          id: 'log-1',
        }),
      ]);
      expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
        select: { email: true, id: true },
        where: { id: { in: ['user-1'] } },
      });
    });

    it('skips the user lookup entirely when no entries have an actorId', async () => {
      mockPrisma.configAuditLog.findMany.mockResolvedValueOnce([
        {
          action: 'UPDATE',
          actorId: null,
          createdAt: new Date('2026-01-01'),
          entityId: 'e1',
          entityType: 'GitHubConfig',
          id: 'log-2',
        },
      ]);
      const result = await listConfigAuditEntries(prisma, 10);
      expect(result[0]?.actorEmail).toBeNull();
      expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    });
  });

  // ─── testDecryptSecrets ─────────────────────────────────────────────────

  describe('testDecryptSecrets', () => {
    it('reports "ok" when the stored GitHub token decrypts successfully', async () => {
      mockPrisma.gitHubConfig.findUnique.mockResolvedValueOnce(sealedColumns('token', 'ghp_x'));
      const result = await testDecryptSecrets(prisma);
      expect(result.githubToken).toBe('ok');
    });

    it('reports "not configured" when no token row exists', async () => {
      mockPrisma.gitHubConfig.findUnique.mockResolvedValueOnce(null);
      const result = await testDecryptSecrets(prisma);
      expect(result.githubToken).toBe('not configured');
    });

    it('reports the error when decryption fails (e.g. corrupted ciphertext)', async () => {
      const cols = sealedColumns('token', 'ghp_x');
      mockPrisma.gitHubConfig.findUnique.mockResolvedValueOnce({
        ...cols,
        tokenKeyVersion: 99, // unknown key version -> decryptSecret throws
      });
      const result = await testDecryptSecrets(prisma);
      expect(result.githubToken).toMatch(/^error:/);
    });
  });

  // ─── detectJiraFields ───────────────────────────────────────────────────

  describe('detectJiraFields', () => {
    it('throws when the tracker is not configured for Jira', async () => {
      resolveIssueTrackerConfigMock.mockResolvedValueOnce({
        apiToken: null,
        baseUrl: null,
        email: null,
        provider: null,
      } as never);
      await expect(detectJiraFields()).rejects.toThrow('Jira is not configured');
    });

    it('returns all fields plus a best-guess storyPointsFieldId match', async () => {
      resolveIssueTrackerConfigMock.mockResolvedValueOnce({
        apiToken: 'tok',
        baseUrl: 'https://acme.atlassian.net',
        email: 'bot@acme.com',
        provider: 'jira',
      } as never);
      mockAtlassianGet.mockResolvedValueOnce([
        { id: 'summary', name: 'Summary' },
        { id: 'customfield_10016', name: 'Story Points' },
      ]);
      const result = await detectJiraFields();
      expect(result.storyPointsFieldId).toBe('customfield_10016');
      expect(result.fields).toHaveLength(2);
    });

    it('falls back to id === "story_points" when no field name matches', async () => {
      resolveIssueTrackerConfigMock.mockResolvedValueOnce({
        apiToken: 'tok',
        baseUrl: 'https://acme.atlassian.net',
        email: 'bot@acme.com',
        provider: 'jira',
      } as never);
      mockAtlassianGet.mockResolvedValueOnce([{ id: 'story_points', name: 'Points' }]);
      const result = await detectJiraFields();
      expect(result.storyPointsFieldId).toBe('story_points');
    });

    it('returns a null storyPointsFieldId when nothing matches', async () => {
      resolveIssueTrackerConfigMock.mockResolvedValueOnce({
        apiToken: 'tok',
        baseUrl: 'https://acme.atlassian.net',
        email: 'bot@acme.com',
        provider: 'jira',
      } as never);
      mockAtlassianGet.mockResolvedValueOnce([{ id: 'summary', name: 'Summary' }]);
      const result = await detectJiraFields();
      expect(result.storyPointsFieldId).toBeNull();
    });
  });

  // ─── Live connection tests ──────────────────────────────────────────────

  describe('testGitHubConnection', () => {
    it('reports App configured when authMode=auto and App fields are fully present', async () => {
      resolveGitHubConfigMock.mockResolvedValueOnce({
        apiUrl: 'https://api.github.com',
        appId: '12345',
        appInstallationId: '999',
        appPrivateKey: '-----BEGIN KEY-----',
        authMode: null,
        token: null,
      } as never);
      const result = await testGitHubConnection();
      expect(result.ok).toBe(true);
      expect(result.detail).toContain('GitHub App configured');
    });

    it('reports no-token when neither PAT nor App is configured', async () => {
      resolveGitHubConfigMock.mockResolvedValueOnce({
        apiUrl: 'https://api.github.com',
        appId: null,
        appInstallationId: null,
        appPrivateKey: null,
        authMode: null,
        token: null,
      } as never);
      const result = await testGitHubConnection();
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('No GitHub token configured.');
    });

    it('authenticates via PAT when the GitHub API responds 200', async () => {
      resolveGitHubConfigMock.mockResolvedValueOnce({
        apiUrl: 'https://api.github.com',
        appId: null,
        appInstallationId: null,
        appPrivateKey: null,
        authMode: null,
        token: 'ghp_live',
      } as never);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({
          json: async () => ({ login: 'octocat' }),
          ok: true,
        })
      );
      const result = await testGitHubConnection();
      expect(result.ok).toBe(true);
      expect(result.detail).toBe('Authenticated as octocat');
    });

    it('reports the API error when the GitHub API responds non-2xx', async () => {
      resolveGitHubConfigMock.mockResolvedValueOnce({
        apiUrl: 'https://api.github.com',
        appId: null,
        appInstallationId: null,
        appPrivateKey: null,
        authMode: null,
        token: 'ghp_bad',
      } as never);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({
          json: async () => ({ message: 'Bad credentials' }),
          ok: false,
          status: 401,
          statusText: 'Unauthorized',
        })
      );
      const result = await testGitHubConnection();
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('GitHub API returned 401: Bad credentials');
    });

    it('reports a connection failure when fetch throws', async () => {
      resolveGitHubConfigMock.mockResolvedValueOnce({
        apiUrl: 'https://api.github.com',
        appId: null,
        appInstallationId: null,
        appPrivateKey: null,
        authMode: null,
        token: 'ghp_x',
      } as never);
      vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')));
      const result = await testGitHubConnection();
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('Connection failed: ECONNREFUSED');
    });
  });

  describe('testSlackConnection', () => {
    it('reports not-configured when there is no bot token', async () => {
      resolveSlackConfigMock.mockResolvedValueOnce({ botToken: null } as never);
      const result = await testSlackConnection();
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('No Slack bot token configured.');
    });

    it('authenticates successfully', async () => {
      resolveSlackConfigMock.mockResolvedValueOnce({ botToken: 'xoxb-x' } as never);
      mockSlackAuthTest.mockResolvedValueOnce({ ok: true, team: 'Acme', user: 'auto-swe-bot' });
      const result = await testSlackConnection();
      expect(result.ok).toBe(true);
      expect(result.detail).toBe('Authenticated as auto-swe-bot in workspace Acme');
    });

    it('reports the Slack API error when auth.test() returns ok:false', async () => {
      resolveSlackConfigMock.mockResolvedValueOnce({ botToken: 'xoxb-x' } as never);
      mockSlackAuthTest.mockResolvedValueOnce({ error: 'invalid_auth', ok: false });
      const result = await testSlackConnection();
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('Slack API error: invalid_auth');
    });

    it('reports a connection failure when the Slack SDK throws', async () => {
      resolveSlackConfigMock.mockResolvedValueOnce({ botToken: 'xoxb-x' } as never);
      mockSlackAuthTest.mockRejectedValueOnce(new Error('network down'));
      const result = await testSlackConnection();
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('Connection failed: network down');
    });
  });

  describe('testStorageConnection', () => {
    it('reports inline storage as always ok', async () => {
      resolveStorageConfigMock.mockResolvedValueOnce({ backend: 'inline' } as never);
      const result = await testStorageConnection();
      expect(result.ok).toBe(true);
      expect(result.detail).toContain('Inline');
    });

    it('reports not-configured when s3 backend has no bucket', async () => {
      resolveStorageConfigMock.mockResolvedValueOnce({ backend: 's3', s3Bucket: null } as never);
      const result = await testStorageConnection();
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('no bucket configured');
    });

    it('reports bucket-not-found on a 404', async () => {
      resolveStorageConfigMock.mockResolvedValueOnce({
        backend: 's3',
        s3Bucket: 'missing-bucket',
        s3Endpoint: null,
        s3Region: 'us-east-1',
      } as never);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ status: 404 }));
      const result = await testStorageConnection();
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("bucket 'missing-bucket' not found");
    });

    it('reports reachable when the endpoint responds with any other status', async () => {
      resolveStorageConfigMock.mockResolvedValueOnce({
        backend: 's3',
        s3Bucket: 'my-bucket',
        s3Endpoint: 'https://minio.internal',
        s3Region: null,
      } as never);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ status: 403 }));
      const result = await testStorageConnection();
      expect(result.ok).toBe(true);
      expect(result.detail).toContain('403');
    });

    it('reports a connection failure when fetch throws', async () => {
      resolveStorageConfigMock.mockResolvedValueOnce({
        backend: 's3',
        s3Bucket: 'my-bucket',
        s3Endpoint: null,
        s3Region: 'us-east-1',
      } as never);
      vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('DNS failure')));
      const result = await testStorageConnection();
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('Cannot reach S3 endpoint: DNS failure');
    });
  });

  describe('testFigmaConnection', () => {
    it('reports disabled', async () => {
      resolveFigmaConfigMock.mockResolvedValueOnce({ apiToken: null, enabled: false } as never);
      const result = await testFigmaConnection();
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('Figma connector is disabled.');
    });

    it('reports missing token when enabled but no apiToken', async () => {
      resolveFigmaConfigMock.mockResolvedValueOnce({ apiToken: null, enabled: true } as never);
      const result = await testFigmaConnection();
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('Figma connector missing API token.');
    });

    it('succeeds when the Figma API responds ok', async () => {
      resolveFigmaConfigMock.mockResolvedValueOnce({ apiToken: 'figd_x', enabled: true } as never);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true }));
      const result = await testFigmaConnection();
      expect(result.ok).toBe(true);
    });

    it('reports the API status on failure', async () => {
      resolveFigmaConfigMock.mockResolvedValueOnce({ apiToken: 'figd_x', enabled: true } as never);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 403 }));
      const result = await testFigmaConnection();
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('Figma API returned 403.');
    });

    it('reports a connection failure when fetch throws', async () => {
      resolveFigmaConfigMock.mockResolvedValueOnce({ apiToken: 'figd_x', enabled: true } as never);
      vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('timeout')));
      const result = await testFigmaConnection();
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('Connection failed: timeout');
    });
  });

  describe('testKnowledgeBaseConnection', () => {
    it('reports not configured/disabled when provider or enabled is falsy', async () => {
      resolveKnowledgeBaseConfigMock.mockResolvedValueOnce({
        apiToken: null,
        baseUrl: null,
        enabled: false,
        provider: null,
      } as never);
      const result = await testKnowledgeBaseConnection();
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('not configured or disabled');
    });

    it('reports missing baseUrl/apiToken when enabled but incomplete', async () => {
      resolveKnowledgeBaseConfigMock.mockResolvedValueOnce({
        apiToken: null,
        baseUrl: null,
        enabled: true,
        provider: 'confluence',
      } as never);
      const result = await testKnowledgeBaseConnection();
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('missing baseUrl or apiToken');
    });

    it('reports unsupported provider when the registry returns null', async () => {
      resolveKnowledgeBaseConfigMock.mockResolvedValueOnce({
        apiToken: 'tok',
        baseUrl: 'https://kb.example.com',
        enabled: true,
        provider: 'confluence',
        spaces: [],
      } as never);
      mockCreateKnowledgeBaseProvider.mockReturnValueOnce(null);
      const result = await testKnowledgeBaseConnection();
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('Provider confluence not supported.');
    });

    it('succeeds when the provider search resolves', async () => {
      resolveKnowledgeBaseConfigMock.mockResolvedValueOnce({
        apiToken: 'tok',
        baseUrl: 'https://kb.example.com',
        enabled: true,
        provider: 'confluence',
        spaces: ['ENG'],
      } as never);
      mockCreateKnowledgeBaseProvider.mockReturnValueOnce({
        searchPages: vi.fn().mockResolvedValueOnce([]),
      } as never);
      const result = await testKnowledgeBaseConnection();
      expect(result.ok).toBe(true);
      expect(result.detail).toBe('confluence connection successful.');
    });

    it('reports a connection failure when the provider search rejects', async () => {
      resolveKnowledgeBaseConfigMock.mockResolvedValueOnce({
        apiToken: 'tok',
        baseUrl: 'https://kb.example.com',
        enabled: true,
        provider: 'confluence',
        spaces: [],
      } as never);
      mockCreateKnowledgeBaseProvider.mockReturnValueOnce({
        searchPages: vi.fn().mockRejectedValueOnce(new Error('403 forbidden')),
      } as never);
      const result = await testKnowledgeBaseConnection();
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('Connection failed: 403 forbidden');
    });
  });

  describe('testIssueTrackerConnection', () => {
    it('reports no provider configured', async () => {
      resolveIssueTrackerConfigMock.mockResolvedValueOnce({ provider: null } as never);
      const result = await testIssueTrackerConnection('PROJ-1');
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('No tracker provider configured.');
    });

    it('reports the fetch failure reason when the ticket cannot be fetched', async () => {
      resolveIssueTrackerConfigMock.mockResolvedValueOnce({ provider: 'jira' } as never);
      mockFetchTicket.mockImplementationOnce(async (_config, _id, opts) => {
        opts.log.warn({}, 'unauthorized');
        return null;
      });
      const result = await testIssueTrackerConnection('PROJ-1');
      expect(result.ok).toBe(false);
      expect(result.detail).toBe('Could not fetch PROJ-1 via jira: unauthorized');
    });

    it('succeeds and reports the fetched ticket title/status', async () => {
      resolveIssueTrackerConfigMock.mockResolvedValueOnce({ provider: 'jira' } as never);
      mockFetchTicket.mockResolvedValueOnce({
        description: '',
        labels: [],
        raw: {},
        status: 'In Progress',
        title: 'Fix the thing',
        url: 'https://acme.atlassian.net/browse/PROJ-1',
      });
      const result = await testIssueTrackerConnection('PROJ-1');
      expect(result.ok).toBe(true);
      expect(result.detail).toBe('Fetched "Fix the thing" (status: In Progress) from jira.');
    });
  });
});
