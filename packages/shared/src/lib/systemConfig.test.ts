import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    figmaConfig: { findUnique: vi.fn() },
    gitHubConfig: { findUnique: vi.fn() },
    knowledgeBaseConfig: { findUnique: vi.fn() },
    workflowDefaults: { findUnique: vi.fn() },
  },
}));

import { prisma } from '@auto-swe/shared/db';
import { encryptSecret } from './crypto.js';
import {
  assertScheduledSweepsEnv,
  assertWorkspaceInfraEnv,
  resolveGitHubConfig,
  resolveGoogleOAuthConfig,
  resolveKnowledgeBaseConfig,
  resolveOktaOAuthConfig,
  resolveScheduledSweeps,
  resolveStorageConfig,
  resolveWorkflowDefaults,
  resolveWorkspaceInfra,
  validateScheduledSweepsEnv,
  validateWorkspaceInfraEnv,
} from './systemConfig.js';

const findGitHub = vi.mocked(prisma.gitHubConfig.findUnique);
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
        ...encryptedColumns('token', 'db-pat-token'),
        ...encryptedColumns('webhookSecret', 'db-webhook-secret'),
        ...encryptedColumns('appClientSecret', 'db-app-secret'),
        ...encryptedColumns('appPrivateKey', 'db-private-key'),
      } as never);

      const config = await resolveGitHubConfig();

      expect(config.token).toBe('db-pat-token');
      expect(config.webhookSecret).toBe('db-webhook-secret');
      expect(config.appClientSecret).toBe('db-app-secret');
      expect(config.appPrivateKey).toBe('db-private-key');
      expect(config.apiUrl).toBe('https://ghe.example.com/api/v3');
      expect(config.baseUrl).toBe('https://ghe.example.com');
      expect(config.appId).toBe('app-id');
      expect(config.appClientId).toBe('app-client-id');
      expect(config.appInstallationId).toBe('install-1');
      expect(config.authMode).toBe('app');
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
    it('is inline with nothing configured', () => {
      const config = resolveStorageConfig();

      expect(config.backend).toBe('inline');
      expect(config.s3Bucket).toBeNull();
      expect(config.awsSecretAccessKey).toBeNull();
      expect(config.s3ForcePathStyle).toBe(false);
    });

    it('is s3, read entirely from the environment, once a bucket is set', () => {
      vi.stubEnv('ARTIFACT_S3_BUCKET', 'env-bucket');
      vi.stubEnv('ARTIFACT_S3_REGION', 'eu-west-1');
      vi.stubEnv('ARTIFACT_S3_FORCE_PATH_STYLE', 'true');
      vi.stubEnv('AWS_ACCESS_KEY_ID', 'env-access-key');
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'env-secret-key');

      const config = resolveStorageConfig();

      expect(config).toMatchObject({
        awsAccessKeyId: 'env-access-key',
        awsSecretAccessKey: 'env-secret-key',
        backend: 's3',
        s3Bucket: 'env-bucket',
        s3ForcePathStyle: true,
        s3Region: 'eu-west-1',
      });
    });
  });

  describe('resolveGoogleOAuthConfig / resolveOktaOAuthConfig', () => {
    const SIGN_IN_KEYS = [
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'OKTA_ISSUER',
      'OKTA_CLIENT_ID',
      'OKTA_CLIENT_SECRET',
    ];
    beforeEach(() => {
      for (const key of SIGN_IN_KEYS) {
        delete process.env[key];
      }
    });

    it('read the environment and nothing else', () => {
      vi.stubEnv('GOOGLE_CLIENT_ID', 'g-id');
      vi.stubEnv('GOOGLE_CLIENT_SECRET', 'g-secret');
      vi.stubEnv('OKTA_ISSUER', 'https://dev-1.okta.com/oauth2/default///');
      vi.stubEnv('OKTA_CLIENT_ID', 'o-id');
      vi.stubEnv('OKTA_CLIENT_SECRET', 'o-secret');

      expect(resolveGoogleOAuthConfig()).toEqual({ clientId: 'g-id', clientSecret: 'g-secret' });
      expect(resolveOktaOAuthConfig()).toEqual({
        clientId: 'o-id',
        clientSecret: 'o-secret',
        issuer: 'https://dev-1.okta.com/oauth2/default',
      });
    });

    it('are null when unset', () => {
      expect(resolveGoogleOAuthConfig()).toEqual({ clientId: null, clientSecret: null });
      expect(resolveOktaOAuthConfig().issuer).toBeNull();
    });
  });

  describe('resolveWorkspaceInfra', () => {
    const KEYS = [
      'WORKSPACE_MEMORY',
      'WORKSPACE_CPUS',
      'WORKSPACE_PIDS_LIMIT',
      'WORKSPACE_IMAGE',
      'WORKSPACE_METADATA_BLOCK_IMAGE',
      'WORKSPACE_BLOCK_METADATA',
      'WORKER_MAX_CONCURRENT_ACTIVITIES',
      'SCANNER_REGEX_BUDGET_MS',
      'HARNESS_MODEL_PROXY_PORT',
      'HARNESS_MODEL_PROXY_URL',
      'HARNESS_MODEL_PROXY_BIND',
      'WORKSPACE_NETWORK',
      'WORKSPACE_DNS',
    ];
    beforeEach(() => {
      for (const key of KEYS) {
        delete process.env[key];
      }
    });

    it('returns the built-in defaults when nothing is set', () => {
      expect(resolveWorkspaceInfra()).toEqual({
        blockMetadata: true,
        cpus: 2,
        dns: ['1.1.1.1', '8.8.8.8'],
        harnessModelProxy: null,
        image: 'node:24-alpine',
        maxConcurrentActivities: 10,
        memory: '4g',
        metadataBlockImage: 'alpine:3.20',
        network: null,
        pidsLimit: 512,
        regexScanBudgetMs: 250,
      });
    });

    it('turns the harness model proxy on with a port, advertised at the Docker host alias by default', () => {
      vi.stubEnv('HARNESS_MODEL_PROXY_PORT', '8790');
      expect(resolveWorkspaceInfra().harnessModelProxy).toEqual({
        bindHost: '0.0.0.0',
        port: 8790,
        url: 'http://host.docker.internal:8790',
      });
      vi.stubEnv('HARNESS_MODEL_PROXY_URL', 'http://10.0.0.5:8790/');
      vi.stubEnv('HARNESS_MODEL_PROXY_BIND', '10.0.0.5');
      expect(resolveWorkspaceInfra().harnessModelProxy).toEqual({
        bindHost: '10.0.0.5',
        port: 8790,
        url: 'http://10.0.0.5:8790',
      });
    });

    it('advertises this worker by its own hostname, and joins workspaces to a named network', () => {
      vi.stubEnv('HARNESS_MODEL_PROXY_PORT', '8790');
      vi.stubEnv('HARNESS_MODEL_PROXY_URL', 'http://{hostname}:8790');
      vi.stubEnv('WORKSPACE_NETWORK', 'auto-swe-workspaces');
      const infra = resolveWorkspaceInfra();
      expect(infra.harnessModelProxy?.url).toBe(`http://${hostname()}:8790`);
      expect(infra.network).toBe('auto-swe-workspaces');
    });

    it('leaves the proxy off for a port that is not one, and ignores an unusable URL', () => {
      vi.stubEnv('HARNESS_MODEL_PROXY_PORT', '99999');
      expect(resolveWorkspaceInfra().harnessModelProxy).toBeNull();
      vi.stubEnv('HARNESS_MODEL_PROXY_PORT', '8790');
      vi.stubEnv('HARNESS_MODEL_PROXY_URL', 'http://user:pass@proxy:8790');
      expect(resolveWorkspaceInfra().harnessModelProxy?.url).toBe(
        'http://host.docker.internal:8790'
      );
    });

    it('reads each variable', () => {
      vi.stubEnv('WORKSPACE_MEMORY', '8g');
      vi.stubEnv('WORKSPACE_CPUS', '3.5');
      vi.stubEnv('WORKSPACE_PIDS_LIMIT', '1024');
      vi.stubEnv('WORKSPACE_IMAGE', 'node:26-alpine');

      expect(resolveWorkspaceInfra()).toMatchObject({
        cpus: 3.5,
        image: 'node:26-alpine',
        memory: '8g',
        pidsLimit: 1024,
      });
    });

    it('only the literal string "false" disables metadata blocking', () => {
      vi.stubEnv('WORKSPACE_BLOCK_METADATA', 'false');
      expect(resolveWorkspaceInfra().blockMetadata).toBe(false);
      vi.stubEnv('WORKSPACE_BLOCK_METADATA', 'no');
      expect(resolveWorkspaceInfra().blockMetadata).toBe(true);
    });

    describe('WORKSPACE_DNS', () => {
      it('replaces the public resolvers with the listed ones, trimmed', () => {
        vi.stubEnv('WORKSPACE_DNS', '100.64.0.10');
        expect(resolveWorkspaceInfra().dns).toEqual(['100.64.0.10']);
        vi.stubEnv('WORKSPACE_DNS', ' 10.0.0.2 , fd00::53 ');
        expect(resolveWorkspaceInfra().dns).toEqual(['10.0.0.2', 'fd00::53']);
      });

      it('keeps the public resolvers when it is unset or empty', () => {
        vi.stubEnv('WORKSPACE_DNS', '');
        expect(resolveWorkspaceInfra().dns).toEqual(['1.1.1.1', '8.8.8.8']);
      });

      it('falls back to the public resolvers for anything that is not an IP address', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        for (const bad of ['dns.internal', '10.0.0.2,;rm -rf', '10.0.0.2,', '999.1.1.1']) {
          vi.stubEnv('WORKSPACE_DNS', bad);
          expect(resolveWorkspaceInfra().dns).toEqual(['1.1.1.1', '8.8.8.8']);
        }
        error.mockRestore();
      });
    });

    it('clamps an oversized concurrency, and ignores an unparseable one', () => {
      vi.stubEnv('WORKER_MAX_CONCURRENT_ACTIVITIES', '2000');
      expect(resolveWorkspaceInfra().maxConcurrentActivities).toBe(1000);
      vi.stubEnv('WORKER_MAX_CONCURRENT_ACTIVITIES', 'lots');
      expect(resolveWorkspaceInfra().maxConcurrentActivities).toBe(10);
    });

    it('falls back to the default for an image that is not a valid reference', () => {
      vi.stubEnv('WORKSPACE_IMAGE', 'my image:latest');
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(resolveWorkspaceInfra().image).toBe('node:24-alpine');
      error.mockRestore();
    });

    describe('validateWorkspaceInfraEnv — the strict check the worker runs at boot', () => {
      it('is clean when nothing is set, and when everything is valid', () => {
        expect(validateWorkspaceInfraEnv()).toEqual([]);
        vi.stubEnv('WORKSPACE_MEMORY', '512m');
        vi.stubEnv('WORKSPACE_CPUS', '1.5');
        vi.stubEnv('WORKSPACE_PIDS_LIMIT', '256');
        vi.stubEnv('WORKSPACE_IMAGE', 'registry.example.com/team/base:1.2');
        vi.stubEnv('WORKSPACE_BLOCK_METADATA', 'false');
        vi.stubEnv('WORKER_MAX_CONCURRENT_ACTIVITIES', '20');
        vi.stubEnv('SCANNER_REGEX_BUDGET_MS', '500');
        vi.stubEnv('HARNESS_MODEL_PROXY_PORT', '8790');
        vi.stubEnv('HARNESS_MODEL_PROXY_URL', 'http://172.17.0.1:8790');
        expect(validateWorkspaceInfraEnv()).toEqual([]);
      });

      it('fails the boot on a proxy port or URL the resolver would ignore', () => {
        vi.stubEnv('HARNESS_MODEL_PROXY_PORT', '0');
        vi.stubEnv('HARNESS_MODEL_PROXY_URL', 'ftp://proxy');
        vi.stubEnv('WORKSPACE_NETWORK', 'bad network;rm');
        expect(validateWorkspaceInfraEnv()).toEqual([
          'HARNESS_MODEL_PROXY_PORT="0" is not a port number (1-65535)',
          'HARNESS_MODEL_PROXY_URL="ftp://proxy" is not an http(s) URL with no credentials',
          'WORKSPACE_NETWORK="bad network;rm" is not a Docker network name',
        ]);
      });

      it('fails the boot on a WORKSPACE_DNS entry that is not an IP address', () => {
        vi.stubEnv('WORKSPACE_DNS', '10.0.0.2,dns.internal');
        expect(validateWorkspaceInfraEnv()).toEqual([
          'WORKSPACE_DNS="10.0.0.2,dns.internal" is not a comma-separated list of resolver IP addresses',
        ]);
        vi.stubEnv('WORKSPACE_DNS', '100.64.0.10,fd00::53');
        expect(validateWorkspaceInfraEnv()).toEqual([]);
      });

      it('does not treat an oversized number as a problem — the resolver clamps it', () => {
        vi.stubEnv('WORKER_MAX_CONCURRENT_ACTIVITIES', '2000');
        vi.stubEnv('SCANNER_REGEX_BUDGET_MS', '999999');
        expect(validateWorkspaceInfraEnv()).toEqual([]);
      });

      it('reports every unusable value at once, naming the variable and what it should be', () => {
        vi.stubEnv('WORKSPACE_MEMORY', '4g --privileged');
        vi.stubEnv('WORKSPACE_CPUS', 'two');
        vi.stubEnv('WORKSPACE_PIDS_LIMIT', '-1');
        vi.stubEnv('WORKSPACE_IMAGE', 'my image:latest');
        vi.stubEnv('WORKSPACE_METADATA_BLOCK_IMAGE', 'bad image');
        vi.stubEnv('WORKER_MAX_CONCURRENT_ACTIVITIES', 'lots');
        vi.stubEnv('SCANNER_REGEX_BUDGET_MS', '0');
        const problems = validateWorkspaceInfraEnv();
        expect(problems).toHaveLength(7);
        expect(problems[0]).toContain('WORKSPACE_MEMORY="4g --privileged"');
        expect(problems.join('\n')).toContain('WORKER_MAX_CONCURRENT_ACTIVITIES="lots"');
      });

      it('rejects a metadata flag that would read as off but leave blocking on', () => {
        for (const raw of ['0', 'no', 'False', 'off']) {
          vi.stubEnv('WORKSPACE_BLOCK_METADATA', raw);
          expect(validateWorkspaceInfraEnv()).toEqual([
            `WORKSPACE_BLOCK_METADATA=${JSON.stringify(raw)} is not 'true' or 'false'`,
          ]);
        }
      });

      it('assertWorkspaceInfraEnv throws one error listing every problem, and is silent when valid', () => {
        expect(() => assertWorkspaceInfraEnv()).not.toThrow();
        vi.stubEnv('WORKSPACE_CPUS', 'two');
        vi.stubEnv('WORKSPACE_PIDS_LIMIT', '-1');
        expect(() => assertWorkspaceInfraEnv()).toThrow(
          /Invalid workspace configuration[\s\S]*WORKSPACE_CPUS[\s\S]*WORKSPACE_PIDS_LIMIT/
        );
      });
    });
  });

  describe('scheduled sweeps (environment-only)', () => {
    const KEYS = [
      'REPO_ACCESS_SYNC_ENABLED',
      'REPO_ACCESS_SYNC_CRON',
      'REPO_DEPENDENCY_SCAN_ENABLED',
      'REPO_DEPENDENCY_SCAN_CRON',
      'MODEL_DISCOVERY_ENABLED',
      'MODEL_DISCOVERY_CRON',
      'RUN_REAPER_ENABLED',
      'RUN_REAPER_CRON',
      'SKILL_SOURCE_SYNC_ENABLED',
      'SKILL_SOURCE_SYNC_CRON',
      'AUTOMATION_DECISION_PRUNE_ENABLED',
      'AUTOMATION_DECISION_PRUNE_CRON',
    ];
    beforeEach(() => {
      for (const key of KEYS) {
        delete process.env[key];
      }
    });

    it('defaults: the access sync is off, the dependency scan and model discovery are on', () => {
      expect(resolveScheduledSweeps()).toEqual({
        automationDecisionPrune: { cronExpression: '37 4 * * *', enabled: true },
        modelDiscovery: { cronExpression: '17 3 * * *', enabled: true },
        repoAccess: { cronExpression: '23 * * * *', enabled: false },
        repoDependency: { cronExpression: '0 4 * * *', enabled: true },
        runReaper: { cronExpression: '*/15 * * * *', enabled: true },
        skillSourceSync: { cronExpression: '41 5 * * *', enabled: true },
      });
    });

    it('reads each variable', () => {
      vi.stubEnv('REPO_ACCESS_SYNC_ENABLED', 'true');
      vi.stubEnv('REPO_ACCESS_SYNC_CRON', '5 * * * *');
      vi.stubEnv('REPO_DEPENDENCY_SCAN_ENABLED', 'false');
      vi.stubEnv('REPO_DEPENDENCY_SCAN_CRON', '30 2 * * 1');
      vi.stubEnv('MODEL_DISCOVERY_ENABLED', 'false');
      vi.stubEnv('MODEL_DISCOVERY_CRON', '0 5 * * 1');
      vi.stubEnv('RUN_REAPER_ENABLED', 'false');
      vi.stubEnv('RUN_REAPER_CRON', '*/5 * * * *');
      vi.stubEnv('SKILL_SOURCE_SYNC_ENABLED', 'false');
      vi.stubEnv('SKILL_SOURCE_SYNC_CRON', '7 6 * * 2');
      vi.stubEnv('AUTOMATION_DECISION_PRUNE_ENABLED', 'false');
      vi.stubEnv('AUTOMATION_DECISION_PRUNE_CRON', '1 2 * * *');
      expect(resolveScheduledSweeps()).toEqual({
        automationDecisionPrune: { cronExpression: '1 2 * * *', enabled: false },
        modelDiscovery: { cronExpression: '0 5 * * 1', enabled: false },
        repoAccess: { cronExpression: '5 * * * *', enabled: true },
        repoDependency: { cronExpression: '30 2 * * 1', enabled: false },
        runReaper: { cronExpression: '*/5 * * * *', enabled: false },
        skillSourceSync: { cronExpression: '7 6 * * 2', enabled: false },
      });
    });

    it('falls back to the default for a value it cannot use', () => {
      vi.stubEnv('REPO_ACCESS_SYNC_ENABLED', 'yes');
      vi.stubEnv('REPO_DEPENDENCY_SCAN_CRON', 'daily');
      vi.stubEnv('MODEL_DISCOVERY_ENABLED', 'off');
      vi.stubEnv('RUN_REAPER_CRON', 'often');
      vi.stubEnv('SKILL_SOURCE_SYNC_ENABLED', 'off');
      const sweeps = resolveScheduledSweeps();
      expect(sweeps.repoAccess.enabled).toBe(false);
      expect(sweeps.repoDependency.cronExpression).toBe('0 4 * * *');
      expect(sweeps.modelDiscovery.enabled).toBe(true);
      expect(sweeps.runReaper.cronExpression).toBe('*/15 * * * *');
      expect(sweeps.skillSourceSync.enabled).toBe(true);
    });

    describe('validateScheduledSweepsEnv — the strict check the gateway runs at boot', () => {
      it('is clean when nothing is set, and when everything is valid', () => {
        expect(validateScheduledSweepsEnv()).toEqual([]);
        vi.stubEnv('REPO_ACCESS_SYNC_ENABLED', 'true');
        vi.stubEnv('REPO_ACCESS_SYNC_CRON', '*/15 * * * *');
        vi.stubEnv('REPO_DEPENDENCY_SCAN_ENABLED', 'false');
        vi.stubEnv('REPO_DEPENDENCY_SCAN_CRON', '0 4 * * *');
        vi.stubEnv('MODEL_DISCOVERY_ENABLED', 'true');
        vi.stubEnv('MODEL_DISCOVERY_CRON', '17 3 * * *');
        vi.stubEnv('RUN_REAPER_ENABLED', 'true');
        vi.stubEnv('RUN_REAPER_CRON', '*/15 * * * *');
        vi.stubEnv('SKILL_SOURCE_SYNC_ENABLED', 'true');
        vi.stubEnv('SKILL_SOURCE_SYNC_CRON', '41 5 * * *');
        expect(validateScheduledSweepsEnv()).toEqual([]);
      });

      it('rejects a flag that would silently become the opposite default', () => {
        // `REPO_DEPENDENCY_SCAN_ENABLED=0` reads as "off", but the lenient
        // resolver would fall back to the default, which is on.
        for (const raw of ['0', 'no', 'False', 'off']) {
          vi.stubEnv('REPO_DEPENDENCY_SCAN_ENABLED', raw);
          expect(validateScheduledSweepsEnv()).toEqual([
            `REPO_DEPENDENCY_SCAN_ENABLED=${JSON.stringify(raw)} is not 'true' or 'false'`,
          ]);
        }
      });

      it('rejects an unusable skill-source sync flag or cron', () => {
        vi.stubEnv('SKILL_SOURCE_SYNC_ENABLED', 'off');
        vi.stubEnv('SKILL_SOURCE_SYNC_CRON', 'daily');
        const problems = validateScheduledSweepsEnv();
        expect(problems).toHaveLength(2);
        expect(problems.join('\n')).toContain('SKILL_SOURCE_SYNC_ENABLED="off"');
        expect(problems.join('\n')).toContain('SKILL_SOURCE_SYNC_CRON="daily"');
      });

      it('rejects a cron expression that is not five fields, and reports every problem', () => {
        vi.stubEnv('REPO_ACCESS_SYNC_CRON', 'hourly');
        vi.stubEnv('REPO_DEPENDENCY_SCAN_CRON', '0 4 * *');
        vi.stubEnv('REPO_ACCESS_SYNC_ENABLED', 'maybe');
        const problems = validateScheduledSweepsEnv();
        expect(problems).toHaveLength(3);
        expect(problems.join('\n')).toContain('REPO_ACCESS_SYNC_CRON="hourly"');
        expect(problems.join('\n')).toContain('REPO_DEPENDENCY_SCAN_CRON="0 4 * *"');
      });

      it('assertScheduledSweepsEnv throws one error listing every problem, and is silent when valid', () => {
        expect(() => assertScheduledSweepsEnv()).not.toThrow();
        vi.stubEnv('REPO_ACCESS_SYNC_CRON', 'hourly');
        vi.stubEnv('REPO_ACCESS_SYNC_ENABLED', 'maybe');
        expect(() => assertScheduledSweepsEnv()).toThrow(
          /Invalid scheduled-sweep configuration[\s\S]*REPO_ACCESS_SYNC_ENABLED[\s\S]*REPO_ACCESS_SYNC_CRON/
        );
      });
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
