import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    figmaConfig: { findUnique: vi.fn() },
    gitHubConfig: { findUnique: vi.fn() },
    knowledgeBaseConfig: { findUnique: vi.fn() },
    storageConfig: { findUnique: vi.fn() },
    workflowDefaults: { findUnique: vi.fn() },
  },
}));

import { prisma } from '@auto-swe/shared/db';
import { encryptSecret } from './crypto.js';
import {
  resolveGitHubConfig,
  resolveKnowledgeBaseConfig,
  resolveStorageConfig,
  resolveWorkflowDefaults,
} from './systemConfig.js';

const findGitHub = vi.mocked(prisma.gitHubConfig.findUnique);
const findStorage = vi.mocked(prisma.storageConfig.findUnique);
const findWorkflowDefaults = vi.mocked(prisma.workflowDefaults.findUnique);
const findKnowledgeBase = vi.mocked(prisma.knowledgeBaseConfig.findUnique);

/** Encrypt `plaintext` and return the 4 columns a `*AuthTag`/`*Ciphertext`/`*KeyVersion`/`*Nonce`
 * quad decrypts from, keyed with the given column prefix (e.g. `token` -> `tokenCiphertext`). */
function encryptedColumns(prefix: string, plaintext: string): Record<string, unknown> {
  const sealed = encryptSecret(plaintext);
  return {
    [`${prefix}AuthTag`]: Buffer.from(sealed.authTag),
    [`${prefix}Ciphertext`]: Buffer.from(sealed.ciphertext),
    [`${prefix}KeyVersion`]: sealed.keyVersion,
    [`${prefix}Nonce`]: Buffer.from(sealed.nonce),
  };
}

// The sandbox this suite runs in pre-populates some of the very env vars these
// resolvers fall back to (e.g. GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY are set to
// 'proxy-injected' for the outbound HTTPS proxy). Snapshot + clear them so
// "no env configured" assertions aren't polluted by the ambient environment.
const AMBIENT_ENV_KEYS = [
  'GITHUB_TOKEN',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_AUTH_MODE',
  'GITHUB_API_URL',
  'GITHUB_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'ARTIFACT_S3_BUCKET',
  'ARTIFACT_S3_ENDPOINT',
  'ARTIFACT_S3_FORCE_PATH_STYLE',
  'ARTIFACT_S3_PREFIX',
  'ARTIFACT_S3_REGION',
  'BRANCH_PREFIX',
  'DEFAULT_TEAM_SLUG',
  'PR_TITLE_TEMPLATE',
  'PR_BODY_TEMPLATE',
  'CI_POLL_DEADLINE_SEC',
  'CI_POLL_GRACE_SEC',
  'CI_POLL_INTERVAL_SEC',
  'CI_WAIT_MODE',
  'KB_PROVIDER',
  'KB_SPACES',
  'KB_BASE_URL',
  'KB_EMAIL',
  'KB_API_TOKEN',
];

describe('systemConfig resolvers', () => {
  const previousKey = process.env.CONFIG_ENCRYPTION_KEY;
  const previousAmbient = new Map(AMBIENT_ENV_KEYS.map((k) => [k, process.env[k]]));

  beforeEach(() => {
    process.env.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    for (const key of AMBIENT_ENV_KEYS) {
      delete process.env[key];
    }
    findGitHub.mockReset();
    findStorage.mockReset();
    findWorkflowDefaults.mockReset();
    findKnowledgeBase.mockReset();
  });

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env.CONFIG_ENCRYPTION_KEY;
    } else {
      process.env.CONFIG_ENCRYPTION_KEY = previousKey;
    }
    for (const [key, value] of previousAmbient) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.unstubAllEnvs();
  });

  describe('resolveGitHubConfig', () => {
    it('decrypts DB values when a row is present', async () => {
      findGitHub.mockResolvedValue({
        apiUrl: 'https://ghe.example.com/api/v3',
        appClientId: 'app-client-id',
        appId: 'app-id',
        appInstallationId: 'install-1',
        authMode: 'app',
        baseUrl: 'https://ghe.example.com',
        oauthClientId: 'oauth-client-id',
        ...encryptedColumns('token', 'db-pat-token'),
        ...encryptedColumns('webhookSecret', 'db-webhook-secret'),
        ...encryptedColumns('oauthClientSecret', 'db-oauth-secret'),
        ...encryptedColumns('appClientSecret', 'db-app-secret'),
        ...encryptedColumns('appPrivateKey', 'db-private-key'),
      } as never);

      const config = await resolveGitHubConfig();

      expect(config.token).toBe('db-pat-token');
      expect(config.webhookSecret).toBe('db-webhook-secret');
      expect(config.oauthClientSecret).toBe('db-oauth-secret');
      expect(config.appClientSecret).toBe('db-app-secret');
      expect(config.appPrivateKey).toBe('db-private-key');
      expect(config.apiUrl).toBe('https://ghe.example.com/api/v3');
      expect(config.baseUrl).toBe('https://ghe.example.com');
      expect(config.appId).toBe('app-id');
      expect(config.appClientId).toBe('app-client-id');
      expect(config.appInstallationId).toBe('install-1');
      expect(config.authMode).toBe('app');
      expect(config.oauthClientId).toBe('oauth-client-id');
    });

    it('falls back to env vars when no DB row exists', async () => {
      findGitHub.mockResolvedValue(null);
      vi.stubEnv('GITHUB_TOKEN', 'env-pat-token');
      vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'env-webhook-secret');
      vi.stubEnv('GITHUB_URL', 'https://github.example.org');

      const config = await resolveGitHubConfig();

      expect(config.token).toBe('env-pat-token');
      expect(config.webhookSecret).toBe('env-webhook-secret');
      expect(config.baseUrl).toBe('https://github.example.org');
      // No env var set for apiUrl -> baked-in default.
      expect(config.apiUrl).toBe('https://api.github.com');
      expect(config.appId).toBeNull();
      expect(config.authMode).toBeNull();
    });

    it('returns the documented defaults when neither DB nor env is set', async () => {
      findGitHub.mockResolvedValue(null);

      const config = await resolveGitHubConfig();

      expect(config.token).toBeNull();
      expect(config.webhookSecret).toBeNull();
      expect(config.baseUrl).toBe('https://github.com');
      expect(config.apiUrl).toBe('https://api.github.com');
      expect(config.authMode).toBeNull();
    });

    it('prefers the DB value over env when both are present', async () => {
      findGitHub.mockResolvedValue({
        apiUrl: null,
        appClientId: null,
        appId: null,
        appInstallationId: null,
        authMode: null,
        baseUrl: 'https://db-wins.example.com',
        oauthClientId: null,
        ...encryptedColumns('token', 'db-pat-token'),
        ...encryptedColumns('webhookSecret', 'db-webhook-secret'),
        appClientSecretAuthTag: null,
        appClientSecretCiphertext: null,
        appClientSecretKeyVersion: null,
        appClientSecretNonce: null,
        appPrivateKeyAuthTag: null,
        appPrivateKeyCiphertext: null,
        appPrivateKeyKeyVersion: null,
        appPrivateKeyNonce: null,
        oauthClientSecretAuthTag: null,
        oauthClientSecretCiphertext: null,
        oauthClientSecretKeyVersion: null,
        oauthClientSecretNonce: null,
      } as never);
      vi.stubEnv('GITHUB_TOKEN', 'env-pat-token');
      vi.stubEnv('GITHUB_URL', 'https://env-loses.example.com');

      const config = await resolveGitHubConfig();

      expect(config.token).toBe('db-pat-token');
      expect(config.baseUrl).toBe('https://db-wins.example.com');
    });
  });

  describe('resolveWorkflowDefaults', () => {
    it('returns DB values when a row is present', async () => {
      findWorkflowDefaults.mockResolvedValue({
        branchPrefix: 'db-branch',
        defaultTeamSlug: 'db-team',
        prBodyTemplate: 'db body',
        prTitleTemplate: 'db title',
      } as never);

      const config = await resolveWorkflowDefaults();

      expect(config.branchPrefix).toBe('db-branch');
      expect(config.defaultTeamSlug).toBe('db-team');
      expect(config.prBodyTemplate).toBe('db body');
      expect(config.prTitleTemplate).toBe('db title');
    });

    it('falls back to env vars when no DB row exists', async () => {
      findWorkflowDefaults.mockResolvedValue(null);
      vi.stubEnv('BRANCH_PREFIX', 'env-branch');
      vi.stubEnv('DEFAULT_TEAM_SLUG', 'env-team');

      const config = await resolveWorkflowDefaults();

      expect(config.branchPrefix).toBe('env-branch');
      expect(config.defaultTeamSlug).toBe('env-team');
    });

    it('returns the documented defaults when neither DB nor env is set', async () => {
      findWorkflowDefaults.mockResolvedValue(null);

      const config = await resolveWorkflowDefaults();

      expect(config.branchPrefix).toBe('auto');
      expect(config.defaultTeamSlug).toBe('default');
      expect(config.prTitleTemplate).toBe('[auto-swe] {{ticketId}}');
      expect(config.prBodyTemplate).toBe('');
    });

    it('prefers the DB value over env when both are present', async () => {
      findWorkflowDefaults.mockResolvedValue({
        branchPrefix: 'db-branch',
        defaultTeamSlug: null,
        prBodyTemplate: null,
        prTitleTemplate: null,
      } as never);
      vi.stubEnv('BRANCH_PREFIX', 'env-branch');

      const config = await resolveWorkflowDefaults();

      expect(config.branchPrefix).toBe('db-branch');
    });

    it('parses positive-int CI env vars, ignoring invalid values', async () => {
      findWorkflowDefaults.mockResolvedValue(null);
      vi.stubEnv('CI_POLL_INTERVAL_SEC', '42');
      vi.stubEnv('CI_POLL_GRACE_SEC', 'not-a-number');
      vi.stubEnv('CI_POLL_DEADLINE_SEC', '-5');
      vi.stubEnv('CI_WAIT_MODE', 'poll');

      const config = await resolveWorkflowDefaults();

      expect(config.ciPollIntervalSec).toBe(42);
      // Invalid -> falls back to the baked-in default.
      expect(config.ciPollGraceSec).toBe(60);
      // Negative -> falls back to the baked-in default.
      expect(config.ciPollDeadlineSec).toBe(14_400);
      expect(config.ciWaitMode).toBe('poll');
    });

    it('defaults ciWaitMode to signal for any value other than "poll"', async () => {
      findWorkflowDefaults.mockResolvedValue(null);
      vi.stubEnv('CI_WAIT_MODE', 'bogus');

      const config = await resolveWorkflowDefaults();

      expect(config.ciWaitMode).toBe('signal');
    });

    it('prefers the DB row over the CI env vars', async () => {
      findWorkflowDefaults.mockResolvedValue({
        ciPollDeadlineSec: 900,
        ciPollGraceSec: 30,
        ciPollIntervalSec: 5,
        ciWaitMode: 'poll',
      } as never);
      // Env says the opposite of every DB value, so a passing assertion can
      // only come from the DB path.
      vi.stubEnv('CI_WAIT_MODE', 'signal');
      vi.stubEnv('CI_POLL_INTERVAL_SEC', '99');
      vi.stubEnv('CI_POLL_GRACE_SEC', '99');
      vi.stubEnv('CI_POLL_DEADLINE_SEC', '99');

      const config = await resolveWorkflowDefaults();

      expect(config.ciWaitMode).toBe('poll');
      expect(config.ciPollIntervalSec).toBe(5);
      expect(config.ciPollGraceSec).toBe(30);
      expect(config.ciPollDeadlineSec).toBe(900);
    });

    it('falls back to the env var per-column when the DB column is null', async () => {
      // Nullable columns are the migration's compatibility contract: a
      // deployment driving these from the environment keeps working until an
      // admin saves the form, and a partially-filled row mixes both sources.
      findWorkflowDefaults.mockResolvedValue({
        ciPollDeadlineSec: null,
        ciPollGraceSec: null,
        ciPollIntervalSec: 7,
        ciWaitMode: null,
      } as never);
      vi.stubEnv('CI_WAIT_MODE', 'poll');
      vi.stubEnv('CI_POLL_GRACE_SEC', '45');

      const config = await resolveWorkflowDefaults();

      expect(config.ciPollIntervalSec).toBe(7); // from the DB
      expect(config.ciWaitMode).toBe('poll'); // from the env
      expect(config.ciPollGraceSec).toBe(45); // from the env
      expect(config.ciPollDeadlineSec).toBe(14_400); // baked-in default
    });
  });

  describe('resolveStorageConfig', () => {
    it('decrypts DB values and honors an explicit inline backend', async () => {
      findStorage.mockResolvedValue({
        awsAccessKeyId: 'db-access-key',
        backend: 'inline',
        s3Bucket: 'db-bucket',
        s3Endpoint: 'https://s3.example.com',
        s3ForcePathStyle: true,
        s3Prefix: 'db-prefix',
        s3Region: 'us-east-1',
        ...encryptedColumns('awsSecretAccessKey', 'db-secret-key'),
      } as never);

      const config = await resolveStorageConfig();

      expect(config.backend).toBe('inline');
      expect(config.awsAccessKeyId).toBe('db-access-key');
      expect(config.awsSecretAccessKey).toBe('db-secret-key');
      expect(config.s3Bucket).toBe('db-bucket');
      expect(config.s3ForcePathStyle).toBe(true);
    });

    it('falls back to inline backend when no row and no S3 bucket env var', async () => {
      findStorage.mockResolvedValue(null);

      const config = await resolveStorageConfig();

      expect(config.backend).toBe('inline');
      expect(config.s3Bucket).toBeNull();
      expect(config.awsSecretAccessKey).toBeNull();
    });

    it('infers an s3 backend from ARTIFACT_S3_BUCKET when no DB row exists', async () => {
      findStorage.mockResolvedValue(null);
      vi.stubEnv('ARTIFACT_S3_BUCKET', 'env-bucket');
      vi.stubEnv('ARTIFACT_S3_FORCE_PATH_STYLE', 'true');

      const config = await resolveStorageConfig();

      expect(config.backend).toBe('s3');
      expect(config.s3Bucket).toBe('env-bucket');
      expect(config.s3ForcePathStyle).toBe(true);
    });

    it('keeps an explicit DB backend of inline even when the bucket env var is set', async () => {
      // A partial row that only set `backend` explicitly (no bucket) still wins
      // over the env-derived 's3' backend, since a DB row exists at all.
      findStorage.mockResolvedValue({
        awsAccessKeyId: null,
        awsSecretAccessKeyAuthTag: null,
        awsSecretAccessKeyCiphertext: null,
        awsSecretAccessKeyKeyVersion: null,
        awsSecretAccessKeyNonce: null,
        backend: 'inline',
        s3Bucket: null,
        s3Endpoint: null,
        s3ForcePathStyle: false,
        s3Prefix: null,
        s3Region: null,
      } as never);
      vi.stubEnv('ARTIFACT_S3_BUCKET', 'env-bucket');

      const config = await resolveStorageConfig();

      expect(config.backend).toBe('inline');
      // s3Bucket itself still falls back to env per-field since the DB field is null.
      expect(config.s3Bucket).toBe('env-bucket');
    });
  });

  describe('resolveKnowledgeBaseConfig', () => {
    it('maps a DB "notion" provider and DB spaces array', async () => {
      findKnowledgeBase.mockResolvedValue({
        apiTokenAuthTag: null,
        apiTokenCiphertext: null,
        apiTokenKeyVersion: null,
        apiTokenNonce: null,
        baseUrl: 'https://api.notion.com',
        email: null,
        enabled: true,
        maxPages: 25,
        provider: 'notion',
        spaces: ['db-space-1', 'db-space-2'],
      } as never);

      const config = await resolveKnowledgeBaseConfig();

      expect(config.provider).toBe('notion');
      expect(config.enabled).toBe(true);
      expect(config.maxPages).toBe(25);
      expect(config.spaces).toEqual(['db-space-1', 'db-space-2']);
    });

    it('maps a DB "confluence" provider distinctly from "notion"', async () => {
      findKnowledgeBase.mockResolvedValue({
        apiTokenAuthTag: null,
        apiTokenCiphertext: null,
        apiTokenKeyVersion: null,
        apiTokenNonce: null,
        baseUrl: null,
        email: null,
        enabled: false,
        maxPages: null,
        provider: 'confluence',
        spaces: [],
      } as never);

      const config = await resolveKnowledgeBaseConfig();

      expect(config.provider).toBe('confluence');
    });

    it('falls back to KB_SPACES env parsing (trimmed, empty entries dropped) when DB spaces is empty', async () => {
      findKnowledgeBase.mockResolvedValue(null);
      vi.stubEnv('KB_PROVIDER', 'notion');
      vi.stubEnv('KB_SPACES', ' env-space-1 , env-space-2 ,, ');

      const config = await resolveKnowledgeBaseConfig();

      expect(config.provider).toBe('notion');
      expect(config.spaces).toEqual(['env-space-1', 'env-space-2']);
    });

    it('returns a null provider for an unrecognized value', async () => {
      findKnowledgeBase.mockResolvedValue(null);
      vi.stubEnv('KB_PROVIDER', 'something-else');

      const config = await resolveKnowledgeBaseConfig();

      expect(config.provider).toBeNull();
      expect(config.enabled).toBe(false);
      expect(config.spaces).toEqual([]);
    });
  });
});
