import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the DB singleton (systemConfigService takes prisma as an argument, but
// the route module imports prisma at the module level for workout-defaults writes
// and the canary-version existence check).
vi.mock('@auto-swe/shared/db', () => ({
  prisma: { agent: { findFirst: vi.fn(async () => null) } },
}));

// Mock systemConfig resolvers used inside routes and service helpers.
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveCanaryConfig: vi.fn(async () => ({
    agentKey: null,
    candidateVersion: null,
    enabled: false,
    percent: 0,
  })),
  resolveConsolidationConfig: vi.fn(async () => ({
    consolidationCron: '0 3 * * 0',
    consolidationEnabled: false,
    minClusterSize: 3,
    similarityThreshold: 0.85,
  })),
  resolveEvalScheduleConfig: vi.fn(async () => ({
    baselineRef: 'last-release',
    candidateRef: 'main',
    cronExpression: '0 7 * * *',
    datasetSlug: 'swe-implementer-golden',
    enabled: false,
  })),
  resolveRevalidationConfig: vi.fn(async () => ({
    cronExpression: '0 6 * * 1',
    datasetSlug: null,
    enabled: false,
  })),
  resolveWorkflowDefaults: vi.fn(async () => ({
    branchPrefix: 'auto',
    defaultTeamSlug: 'default',
    prBodyTemplate: '',
    prTitleTemplate: '[auto-swe] {{ticketId}}',
  })),
}));

// Mock the service module so individual functions can be controlled per test.
vi.mock('../lib/systemConfigService.js', () => ({
  detectJiraFields: vi.fn(async () => ({
    fields: [{ id: 'customfield_10016', name: 'Story Points' }],
    storyPointsFieldId: 'customfield_10016',
  })),
  getGitHubConfig: vi.fn(async () => ({ data: {}, sources: {} })),
  getGoogleOAuthConfig: vi.fn(async () => ({ data: {}, sources: {} })),
  getIssueTrackerConfig: vi.fn(async () => ({ data: {}, sources: {} })),
  getKnowledgeBaseConfig: vi.fn(async () => ({ data: {}, sources: {} })),
  getSlackConfig: vi.fn(async () => ({ data: {}, sources: {} })),
  getStorageConfig: vi.fn(async () => ({ data: {}, sources: {} })),
  listConfigAuditEntries: vi.fn(async () => []),
  SYSTEM_CONFIG_IDS: {
    github: '00000000-0000-0000-0001-000000000001',
    googleOAuth: '00000000-0000-0000-0001-000000000005',
    knowledgeBase: '00000000-0000-0000-0001-000000000007',
    slack: '00000000-0000-0000-0001-000000000002',
    storage: '00000000-0000-0000-0001-000000000003',
    tracker: '00000000-0000-0000-0001-000000000006',
    workflowDefaults: '00000000-0000-0000-0001-000000000004',
  },
  testDecryptSecrets: vi.fn(async () => ({})),
  testGitHubConnection: vi.fn(async () => ({ detail: 'not configured', ok: false })),
  testIssueTrackerConnection: vi.fn(async () => ({ detail: 'not configured', ok: false })),
  testKnowledgeBaseConnection: vi.fn(async () => ({ detail: 'not configured', ok: false })),
  testSlackConnection: vi.fn(async () => ({ detail: 'not configured', ok: false })),
  testStorageConnection: vi.fn(async () => ({ detail: 'not configured', ok: false })),
  updateCanaryConfig: vi.fn(async () => {}),
  updateConsolidationConfig: vi.fn(async () => {}),
  updateEvalScheduleConfig: vi.fn(async () => {}),
  updateGitHubConfig: vi.fn(async () => ({ changedFields: [], data: {}, existed: true })),
  updateGoogleOAuthConfig: vi.fn(async () => ({ changedFields: [], data: {}, existed: true })),
  updateIssueTrackerConfig: vi.fn(async () => ({ changedFields: [], data: {}, existed: true })),
  updateKnowledgeBaseConfig: vi.fn(async () => ({ changedFields: [], data: {}, existed: true })),
  updateRevalidationScheduleConfig: vi.fn(async () => {}),
  updateSlackConfig: vi.fn(async () => ({ changedFields: [], data: {}, existed: true })),
  updateStorageConfig: vi.fn(async () => ({ changedFields: [], data: {}, existed: true })),
  writeSystemConfigAudit: vi.fn(async () => {}),
}));

import { prisma } from '@auto-swe/shared/db';
import { resolveCanaryConfig } from '@auto-swe/shared/lib/systemConfig';
import { detectJiraFields, updateCanaryConfig } from '../lib/systemConfigService.js';
import { systemConfigRoutes } from './systemConfig.js';

const detectJiraFieldsMock = vi.mocked(detectJiraFields);
const findAgentMock = vi.mocked(prisma.agent.findFirst);
const resolveCanaryConfigMock = vi.mocked(resolveCanaryConfig);
const updateCanaryConfigMock = vi.mocked(updateCanaryConfig);

const AUTH_HEADER = { authorization: 'Bearer fake-admin-token' };

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Minimal auth plugin: accept any non-empty bearer token as ADMIN.
  app.decorate('auth', {
    verifyAccessToken: (_token: string) => ({
      exp: 9_999_999_999,
      iat: 0,
      role: 'ADMIN',
      sub: 'admin-1',
    }),
  } as unknown as never);

  // Minimal prisma on the app instance (used by some route handlers directly).
  app.decorate('prisma', {
    workflowDefaults: {
      upsert: vi.fn(async () => ({})),
    },
  } as unknown as never);

  // Minimal temporal (used by consolidation routes, not under test here).
  app.decorate('temporal', {
    getConsolidationScheduleStatus: vi.fn(async () => ({
      exists: false,
      nextRunAt: null,
      paused: false,
    })),
    getEvalScheduleStatus: vi.fn(async () => ({
      exists: false,
      lastRunAt: null,
      nextRunAt: null,
      paused: false,
    })),
    syncConsolidationSchedule: vi.fn(async () => {}),
    syncEvalSchedule: vi.fn(async () => {}),
    triggerConsolidationNow: vi.fn(async () => {}),
    triggerEvalNow: vi.fn(async () => {}),
  } as unknown as never);

  await app.register(systemConfigRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default happy-path stub so tests that don't override still work.
  detectJiraFieldsMock.mockResolvedValue({
    fields: [{ id: 'customfield_10016', name: 'Story Points' }],
    storyPointsFieldId: 'customfield_10016',
  });
});

describe('POST /config/issue-tracker/detect-fields', () => {
  it('returns detected fields when Jira responds successfully', async () => {
    const app = await buildApp();
    const res = await app.inject({
      headers: AUTH_HEADER,
      method: 'POST',
      url: '/api/v1/admin/config/issue-tracker/detect-fields',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({
      fields: [{ id: 'customfield_10016', name: 'Story Points' }],
      storyPointsFieldId: 'customfield_10016',
    });
    await app.close();
  });

  it('propagates errors as 500 when detectJiraFields throws', async () => {
    detectJiraFieldsMock.mockRejectedValue(new Error('Jira not configured'));
    const app = await buildApp();
    const res = await app.inject({
      headers: AUTH_HEADER,
      method: 'POST',
      url: '/api/v1/admin/config/issue-tracker/detect-fields',
    });
    expect(res.statusCode).toBe(500);
    await app.close();
  });
});

describe('eval-schedule config', () => {
  it('GET returns the resolved config plus the Temporal schedule status', async () => {
    const app = await buildApp();
    const res = await app.inject({
      headers: AUTH_HEADER,
      method: 'GET',
      url: '/api/v1/admin/config/eval-schedule',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data).toMatchObject({
      cronExpression: '0 7 * * *',
      datasetSlug: 'swe-implementer-golden',
      enabled: false,
      schedule: { exists: false },
    });
    await app.close();
  });

  it('PUT persists the config and syncs the Temporal schedule', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: { cronExpression: '0 6 * * 1', enabled: true },
      headers: AUTH_HEADER,
      method: 'PUT',
      url: '/api/v1/admin/config/eval-schedule',
    });
    expect(res.statusCode).toBe(200);
    expect(app.temporal.syncEvalSchedule).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('PUT rejects a malformed cron expression', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: { cronExpression: 'not-a-cron' },
      headers: AUTH_HEADER,
      method: 'PUT',
      url: '/api/v1/admin/config/eval-schedule',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('POST /trigger fires the schedule immediately', async () => {
    const app = await buildApp();
    const res = await app.inject({
      headers: AUTH_HEADER,
      method: 'POST',
      url: '/api/v1/admin/config/eval-schedule/trigger',
    });
    expect(res.statusCode).toBe(200);
    expect(app.temporal.triggerEvalNow).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe('PUT /config/canary', () => {
  it('rejects a candidateVersion that has no active agent', async () => {
    resolveCanaryConfigMock.mockResolvedValue({
      agentKey: null,
      candidateVersion: null,
      enabled: false,
      percent: 0,
    });
    findAgentMock.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      body: { agentKey: 'implementer', candidateVersion: 9, enabled: true },
      headers: AUTH_HEADER,
      method: 'PUT',
      url: '/api/v1/admin/config/canary',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CANARY_VERSION_NOT_FOUND');
    // The bad config must not be persisted.
    expect(updateCanaryConfigMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('accepts a candidateVersion backed by an active agent', async () => {
    resolveCanaryConfigMock.mockResolvedValue({
      agentKey: null,
      candidateVersion: null,
      enabled: false,
      percent: 0,
    });
    findAgentMock.mockResolvedValue({ id: 'agent-1' } as never);
    const app = await buildApp();
    const res = await app.inject({
      body: { agentKey: 'implementer', candidateVersion: 2, enabled: true },
      headers: AUTH_HEADER,
      method: 'PUT',
      url: '/api/v1/admin/config/canary',
    });
    expect(res.statusCode).toBe(200);
    expect(updateCanaryConfigMock).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
