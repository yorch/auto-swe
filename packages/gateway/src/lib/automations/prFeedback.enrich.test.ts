import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  automationFindMany: vi.fn(async () => [] as unknown[]),
  connectionFindMany: vi.fn(async () => [] as unknown[]),
  fetch: vi.fn(),
  platformCredential: vi.fn(async () => ({ config: {}, scope: 'instance' })),
  pullRequestFindFirst: vi.fn(async () => null as unknown),
  runFindFirst: vi.fn(async () => null as unknown),
  settings: { 'github.prFeedbackAutomationsEnabled': true } as Record<string, unknown>,
  token: vi.fn(async () => 'tok'),
  webhookSecretFindMany: vi.fn(async () => [] as unknown[]),
}));

vi.mock('@auto-swe/shared/config', () => ({
  resolveSetting: vi.fn(async (key: string) => m.settings[key] ?? false),
}));
vi.mock('@auto-swe/shared/lib/githubHostCredential', () => ({
  resolvePlatformCredential: m.platformCredential,
}));
vi.mock('@auto-swe/shared/lib/githubHostScope', () => ({
  installationTargetFor: vi.fn(() => ({ apiUrl: 'https://api.github.com' })),
}));
vi.mock('@auto-swe/shared/lib/githubInstallation', () => ({
  resolveGitHubToken: m.token,
}));
vi.mock('@auto-swe/shared/lib/connectionCredential', () => ({
  repositoryHostsAllowed: vi.fn(() => ({ ok: true, url: 'https://github.com/acme/api' })),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveGitHubConfig: vi.fn(async () => ({})),
}));
vi.mock('@auto-swe/shared/lib/tenantGuard', () => ({
  runUnscoped: async (_r: string, _m: string[], fn: () => unknown) => fn(),
}));

const prisma = {
  automation: { findMany: m.automationFindMany },
  connection: { findMany: m.connectionFindMany },
  gitHubHostWebhookSecret: { findMany: m.webhookSecretFindMany },
  pullRequest: { findFirst: m.pullRequestFindFirst },
  workflowRun: { findFirst: m.runFindFirst },
} as never;

vi.stubGlobal('fetch', m.fetch);

import { enrichPrFeedbackFacts } from './prFeedback.js';

const CONN = {
  githubApiUrl: null,
  githubUrl: null,
  id: 'conn-1',
  installation: { host: null, installationId: 'i1' },
  team: { orgId: 'org-1' },
  teamId: 'team-1',
};

const event = () => ({
  facts: {
    eventId: '700',
    eventKind: 'issue_comment' as const,
    htmlUrl: 'https://github.com/acme/api/pull/9#issuecomment-700',
    notes: 'fix it',
    origin: 'other' as const,
    prNumber: 9,
    senderId: '42',
    senderLogin: 'reviewer',
    submittedAt: '2026-10-20T00:00:00Z',
    trigger: 'command' as const,
  },
  org: 'acme',
  repoFullName: 'acme/api',
  repoHtmlUrl: 'https://github.com/acme/api',
  repoName: 'api',
  repositoryId: 500,
});

beforeEach(() => {
  for (const f of Object.values(m)) {
    if (typeof f === 'function' && 'mockReset' in f) {
      f.mockReset();
    }
  }
  m.settings['github.prFeedbackAutomationsEnabled'] = true;
  m.connectionFindMany.mockResolvedValue([CONN]);
  m.automationFindMany.mockResolvedValue([]);
  m.pullRequestFindFirst.mockResolvedValue(null);
  m.token.mockResolvedValue('tok');
  m.platformCredential.mockResolvedValue({ config: {}, scope: 'instance' });
  m.webhookSecretFindMany.mockResolvedValue([]);
});

describe('enrichPrFeedbackFacts — the host read for `other` origins is gated', () => {
  it('does not read the host when no enabled automation allows others+command', async () => {
    const r = await enrichPrFeedbackFacts(prisma, event() as never, 'github.com');
    expect(r).toMatchObject({ type: 'ok' });
    if (r.type === 'ok') {
      expect(r.facts.headRef).toBeUndefined();
      expect(r.facts.origin).toBe('other');
    }
    expect(m.fetch).not.toHaveBeenCalled();
  });
  it('does not read the host when the kill switch is off', async () => {
    m.settings['github.prFeedbackAutomationsEnabled'] = false;
    m.automationFindMany.mockResolvedValue([
      { filters: { pullRequests: ['others'], triggers: ['command'] } },
    ]);
    const r = await enrichPrFeedbackFacts(prisma, event() as never, 'github.com');
    expect(r.type).toBe('ok');
    expect(m.fetch).not.toHaveBeenCalled();
  });
  it('reads the host when an eligible automation exists; 404 → ignored, 500 → failed', async () => {
    m.automationFindMany.mockResolvedValue([
      { filters: { pullRequests: ['others'], triggers: ['command'] } },
    ]);
    m.fetch.mockResolvedValue({ ok: false, status: 404 });
    let r = await enrichPrFeedbackFacts(prisma, event() as never, 'github.com');
    expect(r.type).toBe('ignored');
    m.fetch.mockResolvedValue({ ok: false, status: 500 });
    r = await enrichPrFeedbackFacts(prisma, event() as never, 'github.com');
    expect(r.type).toBe('failed');
    m.fetch.mockResolvedValue({
      json: async () => ({
        head: { ref: 'feature/x', repo: { id: 500 } },
        state: 'open',
      }),
      ok: true,
      status: 200,
    });
    r = await enrichPrFeedbackFacts(prisma, event() as never, 'github.com');
    expect(r).toMatchObject({ facts: { headRef: 'feature/x' }, type: 'ok' });
  });
});
