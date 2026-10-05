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
  auditConfigWrite: vi.fn(async () => {}),
  BaseUrlRefusedError: class BaseUrlRefusedError extends Error {
    constructor(readonly reason: string) {
      super(reason);
    }
  },
  CLEARABLE_SECRETS: {
    figma: ['apiToken'],
    github: ['token', 'webhookSecret', 'appClientSecret', 'appPrivateKey'],
    'issue-tracker': ['apiToken', 'webhookSecret'],
    'knowledge-base': ['apiToken'],
    slack: ['botToken', 'clientSecret', 'signingSecret'],
  },
  clearStoredSecret: vi.fn(async () => true),
  detectJiraFields: vi.fn(async () => ({
    fields: [{ id: 'customfield_10016', name: 'Story Points' }],
    storyPointsFieldId: 'customfield_10016',
  })),
  getGitHubConfig: vi.fn(async () => ({ data: {}, sources: {} })),
  getIntegrationConfig: vi.fn(async () => ({ data: { token: null }, sources: { token: null } })),
  getIssueTrackerConfig: vi.fn(async () => ({ data: {}, sources: {} })),
  getKnowledgeBaseConfig: vi.fn(async () => ({ data: {}, sources: {} })),
  getSlackConfig: vi.fn(async () => ({ data: {}, sources: {} })),
  issueTrackerBaseUrlRefusal: vi.fn(async () => null),
  knowledgeBaseBaseUrlRefusal: vi.fn(async () => null),
  listConfigAuditEntries: vi.fn(async () => []),
  SYSTEM_CONFIG_IDS: {
    canary: '00000000-0000-0000-0001-000000000012',
    consolidation: '00000000-0000-0000-0001-000000000009',
    evalSchedule: '00000000-0000-0000-0001-000000000010',
    github: '00000000-0000-0000-0001-000000000001',
    knowledgeBase: '00000000-0000-0000-0001-000000000007',
    revalidation: '00000000-0000-0000-0001-000000000011',
    slack: '00000000-0000-0000-0001-000000000002',
    tracker: '00000000-0000-0000-0001-000000000006',
    workflowDefaults: '00000000-0000-0000-0001-000000000004',
  },
  testDecryptSecrets: vi.fn(async () => ({})),
  testFigmaConnection: vi.fn(async () => ({ detail: 'not configured', ok: false })),
  testGitHubConnection: vi.fn(async () => ({ detail: 'not configured', ok: false })),
  testIssueTrackerConnection: vi.fn(async () => ({ detail: 'not configured', ok: false })),
  testKnowledgeBaseConnection: vi.fn(async () => ({ detail: 'not configured', ok: false })),
  testSlackConnection: vi.fn(async () => ({ detail: 'not configured', ok: false })),
  updateCanaryConfig: vi.fn(async () => ({
    auditAfterJson: { changedFields: ['enabled'] },
    auditBeforeJson: { enabled: false },
    auditTarget: {
      entityId: '00000000-0000-0000-0001-000000000012',
      entityType: 'CanaryConfig',
    },
    changedFields: ['enabled'],
    existed: true,
  })),
  updateConsolidationConfig: vi.fn(async () => ({
    auditAfterJson: { changedFields: ['enabled'] },
    auditBeforeJson: { enabled: false },
    auditTarget: {
      entityId: '00000000-0000-0000-0001-000000000009',
      entityType: 'ConsolidationConfig',
    },
    changedFields: ['enabled'],
    existed: true,
  })),
  updateEvalScheduleConfig: vi.fn(async () => ({
    auditAfterJson: { changedFields: ['enabled'] },
    auditBeforeJson: { enabled: false },
    auditTarget: { entityId: 'e', entityType: 'X' },
    changedFields: ['enabled'],
    existed: true,
  })),
  updateGitHubConfig: vi.fn(async () => ({
    auditBeforeJson: null,
    auditTarget: { entityId: 'e', entityType: 'X' },
    changedFields: [],
    data: {},
    existed: true,
  })),
  updateIssueTrackerConfig: vi.fn(async () => ({
    auditBeforeJson: null,
    auditTarget: { entityId: 'e', entityType: 'X' },
    changedFields: [],
    data: {},
    existed: true,
  })),
  updateKnowledgeBaseConfig: vi.fn(async () => ({
    auditBeforeJson: null,
    auditTarget: { entityId: 'e', entityType: 'X' },
    changedFields: [],
    data: {},
    existed: true,
  })),
  updateRevalidationScheduleConfig: vi.fn(async () => ({
    auditAfterJson: { changedFields: ['enabled'] },
    auditBeforeJson: { enabled: false },
    auditTarget: { entityId: 'e', entityType: 'X' },
    changedFields: ['enabled'],
    existed: true,
  })),
  updateSlackConfig: vi.fn(async () => ({
    auditBeforeJson: null,
    auditTarget: { entityId: 'e', entityType: 'X' },
    changedFields: [],
    data: {},
    existed: true,
  })),
  updateWorkflowDefaults: vi.fn(async () => ({
    auditAfterJson: { changedFields: ['maxTddIterations'] },
    auditBeforeJson: { maxTddIterations: 5 },
    auditTarget: { entityId: 'e', entityType: 'X' },
    changedFields: ['maxTddIterations'],
    data: { branchPrefix: 'auto', maxTddIterations: 7 },
    existed: true,
  })),
}));

import { prisma } from '@auto-swe/shared/db';
import { resolveCanaryConfig } from '@auto-swe/shared/lib/systemConfig';
import {
  auditConfigWrite,
  clearStoredSecret,
  detectJiraFields,
  issueTrackerBaseUrlRefusal,
  knowledgeBaseBaseUrlRefusal,
  testFigmaConnection,
  testGitHubConnection,
  testIssueTrackerConnection,
  testKnowledgeBaseConnection,
  testSlackConnection,
  updateCanaryConfig,
  updateConsolidationConfig,
  updateIssueTrackerConfig,
  updateKnowledgeBaseConfig,
  updateWorkflowDefaults,
} from '../lib/systemConfigService.js';
import { systemConfigRoutes } from './systemConfig.js';

const detectJiraFieldsMock = vi.mocked(detectJiraFields);
const findAgentMock = vi.mocked(prisma.agent.findFirst);
const resolveCanaryConfigMock = vi.mocked(resolveCanaryConfig);
const updateCanaryConfigMock = vi.mocked(updateCanaryConfig);
const updateWorkflowDefaultsMock = vi.mocked(updateWorkflowDefaults);
const updateConsolidationConfigMock = vi.mocked(updateConsolidationConfig);
const auditConfigWriteMock = vi.mocked(auditConfigWrite);

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
  app.decorate('prisma', prisma as unknown as never);

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

  await app.register(systemConfigRoutes, { prefix: '/api/v1/platform' });
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
      url: '/api/v1/platform/config/issue-tracker/detect-fields',
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
      url: '/api/v1/platform/config/issue-tracker/detect-fields',
    });
    expect(res.statusCode).toBe(500);
    await app.close();
  });
});

describe('connection tests with unsaved form values', () => {
  it('passes the GitHub draft through to the test and rejects an invalid mode', async () => {
    const app = await buildApp();
    const res = await app.inject({
      headers: AUTH_HEADER,
      method: 'POST',
      payload: { authMode: 'pat', token: 'ghp_typed' },
      url: '/api/v1/platform/config/github/test',
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(testGitHubConnection)).toHaveBeenCalledWith({
      authMode: 'pat',
      token: 'ghp_typed',
    });
    const bad = await app.inject({
      headers: AUTH_HEADER,
      method: 'POST',
      payload: { authMode: 'nope' },
      url: '/api/v1/platform/config/github/test',
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('still tests the stored GitHub config when the draft is empty', async () => {
    const app = await buildApp();
    const res = await app.inject({
      headers: AUTH_HEADER,
      method: 'POST',
      payload: {},
      url: '/api/v1/platform/config/github/test',
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(testGitHubConnection)).toHaveBeenCalledWith({});
    await app.close();
  });

  it('passes the Slack draft token through to the test', async () => {
    const app = await buildApp();
    const res = await app.inject({
      headers: AUTH_HEADER,
      method: 'POST',
      payload: { botToken: 'xoxb-typed' },
      url: '/api/v1/platform/config/slack/test',
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(testSlackConnection)).toHaveBeenCalledWith({ botToken: 'xoxb-typed' });
    await app.close();
  });
});

describe('tracker, knowledge-base and Figma tests with unsaved form values', () => {
  const postDraft = async (url: string, payload: Record<string, unknown>) => {
    const app = await buildApp();
    const res = await app.inject({ headers: AUTH_HEADER, method: 'POST', payload, url });
    await app.close();
    return res;
  };

  it('splits the ticket ID from the tracker draft', async () => {
    const res = await postDraft('/api/v1/platform/config/issue-tracker/test', {
      apiToken: 'typed',
      baseUrl: 'https://jira.example.com',
      ticketId: 'PROJ-1',
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(testIssueTrackerConnection)).toHaveBeenCalledWith('PROJ-1', {
      apiToken: 'typed',
      baseUrl: 'https://jira.example.com',
    });
  });

  it('rejects a tracker draft with a malformed base URL', async () => {
    const res = await postDraft('/api/v1/platform/config/issue-tracker/test', {
      baseUrl: 'not a url',
      ticketId: 'PROJ-1',
    });
    expect(res.statusCode).toBe(400);
  });

  it('passes the knowledge-base draft through, and an empty body means stored', async () => {
    await postDraft('/api/v1/platform/config/knowledge-base/test', {
      apiToken: 'typed',
      enabled: true,
    });
    expect(vi.mocked(testKnowledgeBaseConnection)).toHaveBeenLastCalledWith({
      apiToken: 'typed',
      enabled: true,
    });
    await postDraft('/api/v1/platform/config/knowledge-base/test', {});
    expect(vi.mocked(testKnowledgeBaseConnection)).toHaveBeenLastCalledWith({});
  });

  it('passes the Figma draft through', async () => {
    const res = await postDraft('/api/v1/platform/config/figma/test', { apiToken: 'figd_typed' });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(testFigmaConnection)).toHaveBeenCalledWith({ apiToken: 'figd_typed' });
  });
});

describe('POST /config/issue-tracker/detect-fields base URL refusal', () => {
  it('answers 400 BASE_URL_REFUSED when the configured URL fails the guard', async () => {
    const { BaseUrlRefusedError } = await import('../lib/systemConfigService.js');
    detectJiraFieldsMock.mockRejectedValue(new BaseUrlRefusedError("host '127.0.0.1' is internal"));
    const app = await buildApp();
    const res = await app.inject({
      headers: AUTH_HEADER,
      method: 'POST',
      url: '/api/v1/platform/config/issue-tracker/detect-fields',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('BASE_URL_REFUSED');
    await app.close();
  });
});

describe('connector base URL refusal on save', () => {
  it.each([
    ['issue-tracker', issueTrackerBaseUrlRefusal, updateIssueTrackerConfig],
    ['knowledge-base', knowledgeBaseBaseUrlRefusal, updateKnowledgeBaseConfig],
  ] as const)('PUT /config/%s answers 400 and writes nothing', async (name, refusal, update) => {
    vi.mocked(refusal).mockResolvedValueOnce("host '127.0.0.1' is internal");
    vi.mocked(update).mockClear();
    const app = await buildApp();
    const res = await app.inject({
      headers: AUTH_HEADER,
      method: 'PUT',
      payload: { allowPrivateNetwork: true, baseUrl: 'http://127.0.0.1:8080' },
      url: `/api/v1/platform/config/${name}`,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error.code).toBe('BASE_URL_REFUSED');
    expect(update).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('eval-schedule config', () => {
  it('GET returns the resolved config plus the Temporal schedule status', async () => {
    const app = await buildApp();
    const res = await app.inject({
      headers: AUTH_HEADER,
      method: 'GET',
      url: '/api/v1/platform/config/eval-schedule',
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
      url: '/api/v1/platform/config/eval-schedule',
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
      url: '/api/v1/platform/config/eval-schedule',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('POST /trigger fires the schedule immediately', async () => {
    const app = await buildApp();
    const res = await app.inject({
      headers: AUTH_HEADER,
      method: 'POST',
      url: '/api/v1/platform/config/eval-schedule/trigger',
    });
    expect(res.statusCode).toBe(200);
    expect(app.temporal.triggerEvalNow).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe('PUT /config/workflow-defaults', () => {
  it('accepts the Tier-2 knobs and delegates to updateWorkflowDefaults', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: {
        budgetStandardInputTokens: 3_000_000,
        evalJudgeThreshold: 0.6,
        maxTddIterations: 7,
      },
      headers: AUTH_HEADER,
      method: 'PUT',
      url: '/api/v1/platform/config/workflow-defaults',
    });
    expect(res.statusCode).toBe(200);
    expect(updateWorkflowDefaultsMock).toHaveBeenCalledTimes(1);
    expect(updateWorkflowDefaultsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ budgetStandardInputTokens: 3_000_000, maxTddIterations: 7 })
    );
    expect(JSON.parse(res.payload).data).toMatchObject({ maxTddIterations: 7 });
    await app.close();
  });

  it('rejects an out-of-range threshold (evalJudgeThreshold > 1)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: { evalJudgeThreshold: 1.5 },
      headers: AUTH_HEADER,
      method: 'PUT',
      url: '/api/v1/platform/config/workflow-defaults',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('no longer carries workspace sizing: those are environment-only now', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: { maxTddIterations: 7, workspaceImage: 'my image:latest', workspaceMemory: '8g' },
      headers: AUTH_HEADER,
      method: 'PUT',
      url: '/api/v1/platform/config/workflow-defaults',
    });
    expect(res.statusCode).toBe(200);
    const sent = updateWorkflowDefaultsMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(sent).toEqual({ maxTddIterations: 7 });
    await app.close();
  });
});

describe('PUT /config/workflow-defaults CI poll bounds', () => {
  it('saves when the form re-sends a stored over-max poll interval and deadline, clamped', async () => {
    // The settings form sends every field on every save. A row stored before
    // the bounds existed must not turn an unrelated edit into a 400.
    const app = await buildApp();
    const res = await app.inject({
      body: { branchPrefix: 'auto', ciPollDeadlineSec: 86_400, ciPollIntervalSec: 300 },
      headers: AUTH_HEADER,
      method: 'PUT',
      url: '/api/v1/platform/config/workflow-defaults',
    });
    expect(res.statusCode).toBe(200);
    expect(updateWorkflowDefaultsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        branchPrefix: 'auto',
        ciPollDeadlineSec: 6 * 3600 - 15 * 60,
        ciPollIntervalSec: 60,
      })
    );
    await app.close();
  });

  it('keeps in-range values and null (env fallback) as sent', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: { ciPollDeadlineSec: null, ciPollIntervalSec: 30 },
      headers: AUTH_HEADER,
      method: 'PUT',
      url: '/api/v1/platform/config/workflow-defaults',
    });
    expect(res.statusCode).toBe(200);
    expect(updateWorkflowDefaultsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ciPollDeadlineSec: null, ciPollIntervalSec: 30 })
    );
    await app.close();
  });

  it('still rejects a zero or negative interval', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: { ciPollIntervalSec: 0 },
      headers: AUTH_HEADER,
      method: 'PUT',
      url: '/api/v1/platform/config/workflow-defaults',
    });
    expect(res.statusCode).toBe(400);
    expect(updateWorkflowDefaultsMock).not.toHaveBeenCalled();
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
      url: '/api/v1/platform/config/canary',
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
      url: '/api/v1/platform/config/canary',
    });
    expect(res.statusCode).toBe(200);
    expect(updateCanaryConfigMock).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe('config audit coverage', () => {
  it('audits a consolidation-schedule change, which previously wrote no entry', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: { enabled: true },
      headers: AUTH_HEADER,
      method: 'PUT',
      url: '/api/v1/platform/config/consolidation',
    });
    expect(res.statusCode).toBe(200);
    expect(updateConsolidationConfigMock).toHaveBeenCalledTimes(1);
    expect(auditConfigWriteMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'admin-1',
      expect.objectContaining({
        auditTarget: {
          entityId: '00000000-0000-0000-0001-000000000009',
          entityType: 'ConsolidationConfig',
        },
      })
    );
    await app.close();
  });

  it('audits a canary change — the route that silently redirected production traffic', async () => {
    resolveCanaryConfigMock.mockResolvedValue({
      agentKey: 'implementer',
      candidateVersion: 2,
      enabled: true,
      percent: 10,
    });
    findAgentMock.mockResolvedValue({ id: 'agent-1' } as never);
    const app = await buildApp();
    const res = await app.inject({
      body: { agentKey: 'implementer', candidateVersion: 2, enabled: true, percent: 0.1 },
      headers: AUTH_HEADER,
      method: 'PUT',
      url: '/api/v1/platform/config/canary',
    });
    expect(res.statusCode).toBe(200);
    expect(auditConfigWriteMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'admin-1',
      expect.objectContaining({
        auditTarget: expect.objectContaining({ entityType: 'CanaryConfig' }),
      })
    );
    await app.close();
  });

  it('records the before-state so an audit entry shows what a value changed from', async () => {
    const app = await buildApp();
    const res = await app.inject({
      body: { maxTddIterations: 7 },
      headers: AUTH_HEADER,
      method: 'PUT',
      url: '/api/v1/platform/config/workflow-defaults',
    });
    expect(res.statusCode).toBe(200);
    expect(auditConfigWriteMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'admin-1',
      expect.objectContaining({ auditBeforeJson: { maxTddIterations: 5 } })
    );
    await app.close();
  });
});

describe('DELETE /config/:integration/secrets/:field', () => {
  it('clears a stored secret and returns the refreshed masked config', async () => {
    const app = await buildApp();
    const res = await app.inject({
      headers: AUTH_HEADER,
      method: 'DELETE',
      url: '/api/v1/platform/config/github/secrets/token',
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(clearStoredSecret)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'admin-1',
      'github',
      'token'
    );
    expect(JSON.parse(res.payload).data).toEqual({ token: null });
    await app.close();
  });

  it('rejects a field that is not a secret of that integration', async () => {
    const app = await buildApp();
    const res = await app.inject({
      headers: AUTH_HEADER,
      method: 'DELETE',
      url: '/api/v1/platform/config/github/secrets/baseUrl',
    });
    expect(res.statusCode).toBe(400);
    expect(vi.mocked(clearStoredSecret)).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'github',
      'baseUrl'
    );
    await app.close();
  });

  it('answers 404 when nothing is stored', async () => {
    vi.mocked(clearStoredSecret).mockResolvedValueOnce(false);
    const app = await buildApp();
    const res = await app.inject({
      headers: AUTH_HEADER,
      method: 'DELETE',
      url: '/api/v1/platform/config/slack/secrets/botToken',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
